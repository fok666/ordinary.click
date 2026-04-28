// ordinary.click client-side app.
//
// Features:
//   - Hash-based routing: /  and  /c/<category>
//   - Click image to open lightbox (with prev/next + Esc/arrow keys)
//   - Cognito Hosted UI login (Authorization Code + PKCE)
//   - Admin (logged-in) UI:
//       * Upload images to a category (presigned POST to S3, async resize)
//       * Delete images from a category
//
// All Cognito config is fetched at runtime from /api/config so the static
// site has no build step.

const app = document.getElementById("app");
const authNav = document.getElementById("auth-nav");

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let configPromise = null;
function getConfig() {
  if (!configPromise) {
    configPromise = fetch("/api/config", { headers: { accept: "application/json" } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`config ${r.status}`))))
      .catch((err) => { configPromise = null; throw err; });
  }
  return configPromise;
}

const TOKEN_KEY = "oc.tokens";
function getTokens() {
  try { return JSON.parse(localStorage.getItem(TOKEN_KEY) || "null"); } catch { return null; }
}
function setTokens(t) {
  if (t) localStorage.setItem(TOKEN_KEY, JSON.stringify(t));
  else localStorage.removeItem(TOKEN_KEY);
}
function decodeJwtPayload(token) {
  try {
    const [, payload] = token.split(".");
    return JSON.parse(atob(payload.replace(/-/g, "+").replace(/_/g, "/")));
  } catch { return null; }
}
function isLoggedIn() {
  const t = getTokens();
  if (!t?.id_token) return false;
  const p = decodeJwtPayload(t.id_token);
  if (!p?.exp) return false;
  return p.exp * 1000 > Date.now() + 30_000; // 30s skew
}
function currentUserEmail() {
  const t = getTokens();
  if (!t?.id_token) return null;
  return decodeJwtPayload(t.id_token)?.email || null;
}

// ---------------------------------------------------------------------------
// Cognito Authorization Code + PKCE
// ---------------------------------------------------------------------------
function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
async function pkcePair() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(hash)) };
}

async function startLogin() {
  const cfg = (await getConfig()).cognito;
  if (!cfg?.domain || !cfg?.clientId) {
    alert("Login is not configured.");
    return;
  }
  const { verifier, challenge } = await pkcePair();
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem("oc.pkce", verifier);
  sessionStorage.setItem("oc.state", state);
  sessionStorage.setItem("oc.return", location.hash || "#/");

  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.clientId,
    redirect_uri: cfg.redirectUri,
    scope: "openid email profile",
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  location.assign(`https://${cfg.domain}/oauth2/authorize?${params}`);
}

async function logout() {
  const cfg = (await getConfig()).cognito;
  setTokens(null);
  if (cfg?.domain && cfg?.clientId) {
    const params = new URLSearchParams({
      client_id: cfg.clientId,
      logout_uri: cfg.logoutUri,
    });
    location.assign(`https://${cfg.domain}/logout?${params}`);
  } else {
    renderAuthNav();
    route();
  }
}

async function exchangeCode(code) {
  const cfg = (await getConfig()).cognito;
  const verifier = sessionStorage.getItem("oc.pkce");
  if (!verifier) throw new Error("missing pkce verifier");

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: cfg.clientId,
    code,
    redirect_uri: cfg.redirectUri,
    code_verifier: verifier,
  });
  const res = await fetch(`https://${cfg.domain}/oauth2/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) throw new Error(`token exchange ${res.status}`);
  const tokens = await res.json();
  setTokens(tokens);
  sessionStorage.removeItem("oc.pkce");
}

async function handleAuthRedirect() {
  const url = new URL(location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) return false;

  const expected = sessionStorage.getItem("oc.state");
  const returnTo = sessionStorage.getItem("oc.return") || "#/";
  sessionStorage.removeItem("oc.state");
  sessionStorage.removeItem("oc.return");

  // Clean the URL regardless of outcome.
  history.replaceState(null, "", url.pathname + returnTo);

  if (expected && state !== expected) {
    alert("Login failed: state mismatch.");
    return true;
  }
  try {
    await exchangeCode(code);
  } catch (err) {
    console.error(err);
    alert(`Login failed: ${err.message}`);
  }
  return true;
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------
async function fetchJSON(path, opts = {}) {
  const headers = { accept: "application/json", ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.status === 204 ? null : res.json();
}
async function fetchAuthed(path, opts = {}) {
  const t = getTokens();
  if (!t?.id_token) throw new Error("not signed in");
  return fetchJSON(path, {
    ...opts,
    headers: {
      ...(opts.headers || {}),
      authorization: `Bearer ${t.id_token}`,
    },
  });
}

// ---------------------------------------------------------------------------
// Auth nav
// ---------------------------------------------------------------------------
function renderAuthNav() {
  if (isLoggedIn()) {
    const email = currentUserEmail() || "admin";
    authNav.innerHTML = `
      <span class="who">${esc(email)}</span>
      <button id="logout-btn">Sign out</button>
    `;
    authNav.querySelector("#logout-btn").addEventListener("click", logout);
  } else {
    authNav.innerHTML = `<button id="login-btn" class="primary">Sign in</button>`;
    authNav.querySelector("#login-btn").addEventListener("click", startLogin);
  }
}

// ---------------------------------------------------------------------------
// Lightbox
// ---------------------------------------------------------------------------
const lightbox = document.getElementById("lightbox");
const lightboxImg = lightbox.querySelector("img");
const lightboxMeta = document.getElementById("lightbox-meta");
let lightboxItems = [];
let lightboxIndex = 0;

function openLightbox(items, index) {
  lightboxItems = items;
  lightboxIndex = index;
  showLightbox();
  lightbox.hidden = false;
  document.body.style.overflow = "hidden";
}
function closeLightbox() {
  lightbox.hidden = true;
  lightboxImg.src = "";
  lightboxMeta.innerHTML = "";
  document.body.style.overflow = "";
}
function showLightbox() {
  if (!lightboxItems.length) return;
  lightboxIndex = (lightboxIndex + lightboxItems.length) % lightboxItems.length;
  const item = lightboxItems[lightboxIndex];
  lightboxImg.src = item.url;
  lightboxImg.alt = item.filename || "";

  // Show metadata below the image.
  let metaHtml = "";
  if (item.description) {
    metaHtml += `<div class="meta-desc">${esc(item.description)}</div>`;
  }
  if (item.latitude != null && item.longitude != null) {
    const lat = Number(item.latitude).toFixed(5);
    const lon = Number(item.longitude).toFixed(5);
    metaHtml += `<div class="meta-geo">📍 ${esc(lat)}, ${esc(lon)} — <a href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}" target="_blank" rel="noopener">map</a></div>`;
  }
  lightboxMeta.innerHTML = metaHtml;
}
lightbox.querySelector(".lightbox-close").addEventListener("click", closeLightbox);
lightbox.querySelector(".lightbox-prev").addEventListener("click", (e) => { e.stopPropagation(); lightboxIndex--; showLightbox(); });
lightbox.querySelector(".lightbox-next").addEventListener("click", (e) => { e.stopPropagation(); lightboxIndex++; showLightbox(); });
lightbox.addEventListener("click", (e) => {
  if (e.target === lightbox || e.target === lightboxImg) closeLightbox();
});
document.addEventListener("keydown", (e) => {
  if (lightbox.hidden) return;
  if (e.key === "Escape") closeLightbox();
  else if (e.key === "ArrowLeft") { lightboxIndex--; showLightbox(); }
  else if (e.key === "ArrowRight") { lightboxIndex++; showLightbox(); }
});

// ---------------------------------------------------------------------------
// Metadata edit modal
// ---------------------------------------------------------------------------
const metaModal = document.getElementById("meta-modal");
const metaForm = document.getElementById("meta-form");
const metaDesc = document.getElementById("meta-desc");
const metaLat = document.getElementById("meta-lat");
const metaLng = document.getElementById("meta-lng");
let metaEditCallback = null;

function openMetaModal(img, category, onSaved) {
  metaDesc.value = img.description || "";
  metaLat.value = img.latitude != null ? img.latitude : "";
  metaLng.value = img.longitude != null ? img.longitude : "";
  metaEditCallback = { img, category, onSaved };
  metaModal.hidden = false;
}
function closeMetaModal() {
  metaModal.hidden = true;
  metaEditCallback = null;
}
document.getElementById("meta-cancel").addEventListener("click", closeMetaModal);
metaModal.addEventListener("click", (e) => { if (e.target === metaModal) closeMetaModal(); });
metaForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!metaEditCallback) return;
  const { img, category, onSaved } = metaEditCallback;
  const body = { description: metaDesc.value };
  if (metaLat.value !== "" && metaLng.value !== "") {
    body.latitude = parseFloat(metaLat.value);
    body.longitude = parseFloat(metaLng.value);
  }
  try {
    const updated = await fetchAuthed(
      `/api/admin/categories/${encodeURIComponent(category)}/images/${encodeURIComponent(img.filename)}`,
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
    );
    // Merge updated metadata back into the image object.
    if (updated.description !== undefined) img.description = updated.description;
    if (updated.latitude !== undefined) img.latitude = updated.latitude;
    if (updated.longitude !== undefined) img.longitude = updated.longitude;
    closeMetaModal();
    if (onSaved) onSaved();
  } catch (err) {
    alert(`Failed to save metadata: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function render(html) {
  // Clean up map instance when leaving the map page.
  if (mapInstance) { mapInstance.remove(); mapInstance = null; }
  app.innerHTML = html;
}

async function renderHome() {
  render(`<section id="intro"><p>Loading categories…</p></section>`);
  try {
    const { categories } = await fetchJSON("/api/categories");
    const admin = isLoggedIn();

    const intro = categories.length
      ? `<section><p>Pick a category below.</p></section>`
      : `<section><p>No categories yet${admin ? " — upload below to create one." : "."}</p></section>`;

    const cards = categories.map((c) => `
      <a class="category-card" href="#/c/${encodeURIComponent(c.name)}">
        ${c.cover ? `<img loading="lazy" src="${esc(c.cover)}" alt="${esc(c.name)}"
             data-fallback-url="${esc(c.coverFallback || c.cover)}"
             onerror="if(this.dataset.fallback!=='1'){this.dataset.fallback='1';this.src=this.dataset.fallbackUrl;}">` : ""}
        <span class="label"><strong>${esc(c.name)}</strong><span>${c.count}</span></span>
      </a>
    `).join("");

    const adminPanel = admin ? `
      <section class="admin-panel">
        <h3>Upload to a category</h3>
        <form id="home-upload-form">
          <input type="text" id="home-upload-cat" placeholder="category name" required
                 pattern="[a-zA-Z0-9][a-zA-Z0-9 _.\\-]{0,63}" />
          <input type="file" id="home-upload-files" accept="image/*" multiple required />
          <button type="submit" class="primary">Upload</button>
          <div class="upload-meta-fields">
            <textarea id="home-upload-desc" placeholder="Description (optional)" rows="1"></textarea>
            <input type="number" id="home-upload-lat" step="any" min="-90" max="90" placeholder="Latitude" />
            <input type="number" id="home-upload-lng" step="any" min="-180" max="180" placeholder="Longitude" />
          </div>
        </form>
        <ul id="home-upload-progress" class="progress"></ul>
      </section>` : "";

    render(`${intro}${adminPanel}<section class="categories">${cards}</section>`);

    if (admin) {
      const form = document.getElementById("home-upload-form");
      form.addEventListener("submit", async (e) => {
        e.preventDefault();
        const cat = document.getElementById("home-upload-cat").value.trim();
        const files = document.getElementById("home-upload-files").files;
        const log = document.getElementById("home-upload-progress");
        const desc = document.getElementById("home-upload-desc")?.value || "";
        const lat = document.getElementById("home-upload-lat")?.value || "";
        const lng = document.getElementById("home-upload-lng")?.value || "";
        const meta = {};
        if (desc) meta.description = desc;
        if (lat && lng) { meta.latitude = parseFloat(lat); meta.longitude = parseFloat(lng); }
        await uploadFiles(cat, files, log, meta);
        location.hash = `#/c/${encodeURIComponent(cat)}`;
      });
    }
  } catch (err) {
    render(`<section><p>Couldn't load categories: ${esc(err.message)}</p></section>`);
  }
}

async function renderCategory(name) {
  const admin = isLoggedIn();
  render(`<section><a class="back" href="#/">← all categories</a><h2>${esc(name)}</h2><p>Loading…</p></section>`);
  try {
    const data = await fetchJSON(`/api/categories/${encodeURIComponent(name)}`);
    const items = data.images;

    const adminPanel = admin ? `
      <section class="admin-panel">
        <h3>Upload to “${esc(name)}”</h3>
        <form id="cat-upload-form">
          <input type="file" id="cat-upload-files" accept="image/*" multiple required />
          <button type="submit" class="primary">Upload</button>          <div class="upload-meta-fields">
            <textarea id="cat-upload-desc" placeholder="Description (optional)" rows="1"></textarea>
            <input type="number" id="cat-upload-lat" step="any" min="-90" max="90" placeholder="Latitude" />
            <input type="number" id="cat-upload-lng" step="any" min="-180" max="180" placeholder="Longitude" />
          </div>        </form>
        <ul id="cat-upload-progress" class="progress"></ul>
      </section>` : "";

    const tiles = items.map((img, i) => {
      let metaHint = "";
      if (img.description) metaHint = esc(img.description);
      else if (img.latitude != null) metaHint = `📍 ${Number(img.latitude).toFixed(2)}, ${Number(img.longitude).toFixed(2)}`;

      return `
      <div class="gallery-item" data-index="${i}">
        <img loading="lazy" src="${esc(img.thumb || img.url)}" alt="${esc(img.filename)}"
             data-url="${esc(img.url)}"
             onerror="if(this.dataset.fallback!=='1'){this.dataset.fallback='1';this.src=this.dataset.url;}" />
        ${admin ? `<button class="edit-meta" data-index="${i}" title="Edit metadata">✏️</button>` : ""}
        ${admin ? `<button class="delete danger" data-filename="${esc(img.filename)}" title="Delete">🗑</button>` : ""}
        ${metaHint ? `<div class="img-meta">${metaHint}</div>` : ""}
      </div>
    `;
    }).join("");

    render(`
      <section><a class="back" href="#/">← all categories</a><h2>${esc(name)}</h2></section>
      ${adminPanel}
      <section class="gallery">${tiles}</section>
    `);

    // Lightbox wiring
    document.querySelectorAll(".gallery-item img").forEach((node, idx) => {
      node.addEventListener("click", () => openLightbox(items, idx));
    });

    if (admin) {
      document.getElementById("cat-upload-form").addEventListener("submit", async (e) => {
        e.preventDefault();
        const files = document.getElementById("cat-upload-files").files;
        const log = document.getElementById("cat-upload-progress");
        const desc = document.getElementById("cat-upload-desc")?.value || "";
        const lat = document.getElementById("cat-upload-lat")?.value || "";
        const lng = document.getElementById("cat-upload-lng")?.value || "";
        const meta = {};
        if (desc) meta.description = desc;
        if (lat && lng) { meta.latitude = parseFloat(lat); meta.longitude = parseFloat(lng); }
        await uploadFiles(name, files, log, meta);
        // Re-render so newly-uploaded pending files show up.
        renderCategory(name);
      });
      document.querySelectorAll(".gallery-item .edit-meta").forEach((btn) => {
        btn.addEventListener("click", (e) => {
          e.stopPropagation();
          const idx = parseInt(btn.dataset.index, 10);
          openMetaModal(items[idx], name, () => renderCategory(name));
        });
      });
      document.querySelectorAll(".gallery-item .delete").forEach((btn) => {
        btn.addEventListener("click", async (e) => {
          e.stopPropagation();
          const filename = btn.dataset.filename;
          if (!confirm(`Delete ${filename}?`)) return;
          try {
            await fetchAuthed(
              `/api/admin/categories/${encodeURIComponent(name)}/images/${encodeURIComponent(filename)}`,
              { method: "DELETE" },
            );
            renderCategory(name);
          } catch (err) {
            alert(`Delete failed: ${err.message}`);
          }
        });
      });
    }
  } catch (err) {
    render(`<section><a class="back" href="#/">← all categories</a><p>Couldn't load category: ${esc(err.message)}</p></section>`);
  }
}

// ---------------------------------------------------------------------------
// Upload (presigned POST to S3 originals/)
// ---------------------------------------------------------------------------
function sanitizeFilename(name) {
  // Keep extension; strip anything outside [a-zA-Z0-9 _.()-]; collapse repeats.
  const dot = name.lastIndexOf(".");
  const stem = (dot > 0 ? name.slice(0, dot) : name).replace(/[^a-zA-Z0-9 _.()-]+/g, "_").slice(0, 96);
  const ext = (dot > 0 ? name.slice(dot + 1) : "jpg").replace(/[^a-zA-Z0-9]/g, "").slice(0, 8) || "jpg";
  return `${stem || "image"}.${ext.toLowerCase()}`;
}

async function uploadFiles(category, files, logEl, meta = {}) {
  if (!files?.length) return;
  for (const file of files) {
    const filename = sanitizeFilename(file.name);
    const li = document.createElement("li");
    li.textContent = `${filename}: requesting upload URL…`;
    logEl.appendChild(li);
    try {
      const presignBody = { filename, contentType: file.type || "image/jpeg", ...meta };
      const presign = await fetchAuthed(
        `/api/admin/categories/${encodeURIComponent(category)}/uploads`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(presignBody),
        },
      );

      const form = new FormData();
      for (const [k, v] of Object.entries(presign.fields)) form.append(k, v);
      form.append("file", file);

      li.textContent = `${filename}: uploading…`;
      const res = await fetch(presign.url, { method: "POST", body: form });
      if (!res.ok) throw new Error(`S3 upload ${res.status}`);
      li.textContent = `${filename}: uploaded — processing in background`;
      li.className = "ok";
    } catch (err) {
      console.error(err);
      li.textContent = `${filename}: failed (${err.message})`;
      li.className = "error";
    }
  }
}

// ---------------------------------------------------------------------------
// Map page — geo-tagged images on OpenStreetMap via Leaflet
// ---------------------------------------------------------------------------
let mapInstance = null;

async function renderMap() {
  render(`
    <section>
      <a class="back" href="#/">← all categories</a>
      <h2>Geo-tagged photos</h2>
    </section>
    <div id="geo-map"></div>
  `);

  try {
    const { images } = await fetchJSON("/api/geo");

    if (!images.length) {
      render(`
        <section>
          <a class="back" href="#/">← all categories</a>
          <h2>Geo-tagged photos</h2>
          <p>No geo-tagged images yet. Add coordinates to your photos to see them on the map.</p>
        </section>
      `);
      return;
    }

    // Clean up previous map instance if route is revisited.
    if (mapInstance) { mapInstance.remove(); mapInstance = null; }

    mapInstance = L.map("geo-map");

    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(mapInstance);

    const markers = L.markerClusterGroup
      ? L.markerClusterGroup()
      : L.layerGroup();

    const bounds = [];

    for (const img of images) {
      const lat = Number(img.latitude);
      const lng = Number(img.longitude);
      if (Number.isNaN(lat) || Number.isNaN(lng)) continue;

      bounds.push([lat, lng]);

      const popupHtml = `
        <div class="map-popup">
          <a href="#/c/${encodeURIComponent(img.category)}" class="map-popup-thumb">
            <img src="${esc(img.thumb)}" alt="${esc(img.filename)}" loading="lazy" />
          </a>
          <div class="map-popup-info">
            <strong>${esc(img.category)}</strong> / ${esc(img.filename)}
            ${img.description ? `<br><span class="map-popup-desc">${esc(img.description)}</span>` : ""}
          </div>
        </div>
      `;

      const marker = L.marker([lat, lng]).bindPopup(popupHtml, { maxWidth: 280, minWidth: 160 });
      markers.addLayer(marker);
    }

    mapInstance.addLayer(markers);

    if (bounds.length === 1) {
      mapInstance.setView(bounds[0], 14);
    } else if (bounds.length > 1) {
      mapInstance.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    } else {
      mapInstance.setView([20, 0], 2);
    }

  } catch (err) {
    render(`
      <section>
        <a class="back" href="#/">← all categories</a>
        <p>Couldn't load geo-tagged images: ${esc(err.message)}</p>
      </section>
    `);
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  if (hash === "/map") return renderMap();
  const m = hash.match(/^\/c\/(.+)$/);
  if (m) return renderCategory(decodeURIComponent(m[1]));
  return renderHome();
}

window.addEventListener("hashchange", route);

(async function main() {
  // Best-effort: if we have ?code= in the URL, we just came back from Cognito.
  await handleAuthRedirect();
  renderAuthNav();
  route();
})();
