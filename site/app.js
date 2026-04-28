// ordinary.click client-side app.
//
// Features:
//   - Hash-based routing: /  /gallery  /map  /c/<category>
//   - Cover page with hero image and section links
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
// Location picker — Nominatim search, mini-map, recent locations
// ---------------------------------------------------------------------------
const RECENT_LOC_KEY = "oc.recent-locations";
const RECENT_LOC_MAX = 10;
let _nominatimTimer = null;
let activePickers = [];

function getRecentLocations() {
  try { return JSON.parse(localStorage.getItem(RECENT_LOC_KEY) || "[]").slice(0, RECENT_LOC_MAX); }
  catch { return []; }
}

function addRecentLocation(name, lat, lng) {
  const key = `${Number(lat).toFixed(5)},${Number(lng).toFixed(5)}`;
  let list = getRecentLocations().filter(
    (l) => `${Number(l.lat).toFixed(5)},${Number(l.lng).toFixed(5)}` !== key,
  );
  list.unshift({ name, lat: Number(lat), lng: Number(lng) });
  localStorage.setItem(RECENT_LOC_KEY, JSON.stringify(list.slice(0, RECENT_LOC_MAX)));
}

async function searchNominatim(query) {
  const params = new URLSearchParams({ format: "json", q: query, limit: "5", addressdetails: "0" });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, {
    headers: { accept: "application/json" },
  });
  if (!res.ok) return [];
  return res.json();
}

function attachLocationPicker(container, latInput, lngInput) {
  const searchInput = container.querySelector(".location-search");
  const resultsList = container.querySelector(".location-results");
  const mapBtn = container.querySelector(".location-map-btn");
  const mapDiv = container.querySelector(".location-picker-map");
  const recentDiv = container.querySelector(".recent-locations");
  let pickerMap = null;
  let pickerMarker = null;

  // --- Nominatim search with 1s debounce ---
  searchInput.addEventListener("input", () => {
    clearTimeout(_nominatimTimer);
    const q = searchInput.value.trim();
    if (q.length < 2) { resultsList.innerHTML = ""; return; }
    _nominatimTimer = setTimeout(async () => {
      try {
        const results = await searchNominatim(q);
        resultsList.innerHTML = results.map((r) =>
          `<li data-lat="${esc(r.lat)}" data-lng="${esc(r.lon)}">${esc(r.display_name)}</li>`
        ).join("");
      } catch { resultsList.innerHTML = ""; }
    }, 1000);
  });

  resultsList.addEventListener("click", (e) => {
    const li = e.target.closest("li");
    if (!li) return;
    latInput.value = Number(li.dataset.lat).toFixed(6);
    lngInput.value = Number(li.dataset.lng).toFixed(6);
    searchInput.value = li.textContent;
    resultsList.innerHTML = "";
    updateMarker(Number(li.dataset.lat), Number(li.dataset.lng));
  });

  // Close results when clicking outside
  const outsideHandler = (e) => {
    if (!container.contains(e.target)) resultsList.innerHTML = "";
  };
  document.addEventListener("click", outsideHandler);

  // --- Mini-map toggle ---
  mapBtn.addEventListener("click", () => {
    const visible = mapDiv.style.display === "block";
    mapDiv.style.display = visible ? "none" : "block";
    if (!visible) {
      if (!pickerMap) {
        pickerMap = L.map(mapDiv, { zoomControl: true });
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
        }).addTo(pickerMap);
        pickerMap.on("click", (e) => {
          latInput.value = e.latlng.lat.toFixed(6);
          lngInput.value = e.latlng.lng.toFixed(6);
          updateMarker(e.latlng.lat, e.latlng.lng);
        });
      }
      const lat = parseFloat(latInput.value);
      const lng = parseFloat(lngInput.value);
      if (!isNaN(lat) && !isNaN(lng)) {
        pickerMap.setView([lat, lng], 13);
        updateMarker(lat, lng);
      } else {
        pickerMap.setView([20, 0], 2);
      }
      setTimeout(() => pickerMap.invalidateSize(), 100);
    }
  });

  function updateMarker(lat, lng) {
    if (!pickerMap) return;
    if (pickerMarker) pickerMarker.setLatLng([lat, lng]);
    else pickerMarker = L.marker([lat, lng]).addTo(pickerMap);
    pickerMap.panTo([lat, lng]);
  }

  // --- Recent locations ---
  function renderRecent() {
    const recent = getRecentLocations();
    if (!recent.length) { recentDiv.innerHTML = ""; return; }
    recentDiv.innerHTML = `<span class="recent-label">Recent:</span>` +
      recent.map((r) =>
        `<button type="button" class="recent-loc-chip" data-lat="${esc(String(r.lat))}" data-lng="${esc(String(r.lng))}">${esc(r.name)}</button>`
      ).join("");
  }
  renderRecent();

  recentDiv.addEventListener("click", (e) => {
    const chip = e.target.closest(".recent-loc-chip");
    if (!chip) return;
    latInput.value = Number(chip.dataset.lat).toFixed(6);
    lngInput.value = Number(chip.dataset.lng).toFixed(6);
    searchInput.value = chip.textContent;
    if (pickerMap) {
      updateMarker(Number(chip.dataset.lat), Number(chip.dataset.lng));
    }
  });

  const picker = {
    destroy() {
      document.removeEventListener("click", outsideHandler);
      if (pickerMap) { pickerMap.remove(); pickerMap = null; }
    },
    saveRecent() {
      const lat = parseFloat(latInput.value);
      const lng = parseFloat(lngInput.value);
      if (isNaN(lat) || isNaN(lng)) return;
      const name = searchInput.value.trim() || `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
      addRecentLocation(name, lat, lng);
    },
  };
  activePickers.push(picker);
  return picker;
}

// ---------------------------------------------------------------------------
// Metadata edit modal
// ---------------------------------------------------------------------------
const metaModal = document.getElementById("meta-modal");
const metaForm = document.getElementById("meta-form");
const metaDesc = document.getElementById("meta-desc");
const metaLat = document.getElementById("meta-lat");
const metaLng = document.getElementById("meta-lng");
let metaEditCallback = null;
let metaPicker = null;

function openMetaModal(img, category, onSaved) {
  metaDesc.value = img.description || "";
  metaLat.value = img.latitude != null ? img.latitude : "";
  metaLng.value = img.longitude != null ? img.longitude : "";
  metaEditCallback = { img, category, onSaved };
  metaModal.hidden = false;
  if (metaPicker) metaPicker.destroy();
  const pickerEl = document.getElementById("meta-location-picker");
  pickerEl.querySelector(".location-search").value = "";
  pickerEl.querySelector(".location-results").innerHTML = "";
  pickerEl.querySelector(".location-picker-map").style.display = "none";
  metaPicker = attachLocationPicker(pickerEl, metaLat, metaLng);
}
function closeMetaModal() {
  if (metaPicker) { metaPicker.destroy(); metaPicker = null; }
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
    if (metaPicker) metaPicker.saveRecent();
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
  if (mapInstance) { mapInstance.remove(); mapInstance = null; }
  activePickers.forEach((p) => p.destroy());
  activePickers = [];
  app.innerHTML = html;
}

// ---------------------------------------------------------------------------
// Cover page — landing with hero image + section links
// ---------------------------------------------------------------------------
async function renderCover() {
  render(`<section class="cover-loading"><p>Loading…</p></section>`);
  try {
    const { categories } = await fetchJSON("/api/categories");

    // Collect all covers to pick a random hero.
    const covers = categories.filter((c) => c.cover);
    const hero = covers.length ? covers[Math.floor(Math.random() * covers.length)] : null;

    const totalPhotos = categories.reduce((n, c) => n + c.count, 0);

    const heroHtml = hero ? `
      <div class="cover-hero">
        <img src="${esc(hero.coverFallback || hero.cover)}" alt="${esc(hero.name)}" />
        <div class="cover-hero-overlay">
          <span class="cover-hero-label">From <strong>${esc(hero.name)}</strong></span>
        </div>
      </div>` : "";

    render(`
      ${heroHtml}
      <section class="cover-intro">
        <h2>Welcome</h2>
        <p>
          A curated collection of ordinary, everyday moments captured in photographs.
          ${totalPhotos ? `Currently <strong>${totalPhotos}</strong> photo${totalPhotos === 1 ? "" : "s"} across <strong>${categories.length}</strong> categor${categories.length === 1 ? "y" : "ies"}.` : "Start exploring or sign in to upload your first photos."}
        </p>
      </section>
      <section class="cover-sections">
        <a class="cover-card" href="#/gallery">
          <span class="cover-card-icon">🖼️</span>
          <strong>Gallery</strong>
          <span>Browse photos organised by category</span>
        </a>
        <a class="cover-card" href="#/map">
          <span class="cover-card-icon">🗺️</span>
          <strong>Map</strong>
          <span>Explore geo-tagged photos on a world map</span>
        </a>
      </section>
    `);
  } catch (err) {
    render(`<section><p>Couldn't load: ${esc(err.message)}</p></section>`);
  }
}

// ---------------------------------------------------------------------------
// Gallery — category listing + upload
// ---------------------------------------------------------------------------
async function renderGallery() {
  render(`<section id="intro"><p>Loading categories…</p></section>`);
  try {
    const { categories } = await fetchJSON("/api/categories");
    const admin = isLoggedIn();

    const intro = categories.length
      ? `<section><a class="back" href="#/">← home</a><h2>Gallery</h2><p>Pick a category below.</p></section>`
      : `<section><a class="back" href="#/">← home</a><h2>Gallery</h2><p>No categories yet${admin ? " — upload below to create one." : "."}</p></section>`;

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
            <div class="location-picker" id="home-location-picker">
              <div class="location-search-wrap">
                <input type="text" class="location-search" placeholder="Search city or place…" autocomplete="off" />
                <ul class="location-results"></ul>
              </div>
              <div class="location-coords">
                <input type="number" id="home-upload-lat" step="any" min="-90" max="90" placeholder="Latitude" />
                <input type="number" id="home-upload-lng" step="any" min="-180" max="180" placeholder="Longitude" />
                <button type="button" class="location-map-btn" title="Pick on map">📍</button>
              </div>
              <div class="location-picker-map"></div>
              <div class="recent-locations"></div>
            </div>
          </div>
        </form>
        <ul id="home-upload-progress" class="progress"></ul>
      </section>` : "";

    render(`${intro}${adminPanel}<section class="categories">${cards}</section>`);

    if (admin) {
      const homePicker = attachLocationPicker(
        document.getElementById("home-location-picker"),
        document.getElementById("home-upload-lat"),
        document.getElementById("home-upload-lng"),
      );
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
        homePicker.saveRecent();
        location.hash = `#/c/${encodeURIComponent(cat)}`;
      });
    }
  } catch (err) {
    render(`<section><p>Couldn't load categories: ${esc(err.message)}</p></section>`);
  }
}

async function renderCategory(name) {
  const admin = isLoggedIn();
  render(`<section><a class="back" href="#/gallery">← gallery</a><h2>${esc(name)}</h2><p>Loading…</p></section>`);
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
            <div class="location-picker" id="cat-location-picker">
              <div class="location-search-wrap">
                <input type="text" class="location-search" placeholder="Search city or place…" autocomplete="off" />
                <ul class="location-results"></ul>
              </div>
              <div class="location-coords">
                <input type="number" id="cat-upload-lat" step="any" min="-90" max="90" placeholder="Latitude" />
                <input type="number" id="cat-upload-lng" step="any" min="-180" max="180" placeholder="Longitude" />
                <button type="button" class="location-map-btn" title="Pick on map">📍</button>
              </div>
              <div class="location-picker-map"></div>
              <div class="recent-locations"></div>
            </div>
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
      <section><a class="back" href="#/gallery">← gallery</a><h2>${esc(name)}</h2></section>
      ${adminPanel}
      <section class="gallery">${tiles}</section>
    `);

    // Lightbox wiring
    document.querySelectorAll(".gallery-item img").forEach((node, idx) => {
      node.addEventListener("click", () => openLightbox(items, idx));
    });

    if (admin) {
      const catPicker = attachLocationPicker(
        document.getElementById("cat-location-picker"),
        document.getElementById("cat-upload-lat"),
        document.getElementById("cat-upload-lng"),
      );
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
        catPicker.saveRecent();
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
    render(`<section><a class="back" href="#/gallery">← gallery</a><p>Couldn't load category: ${esc(err.message)}</p></section>`);
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
      <a class="back" href="#/">← home</a>
      <h2>Geo-tagged photos</h2>
    </section>
    <div id="geo-map"></div>
  `);

  try {
    const { images } = await fetchJSON("/api/geo");

    if (!images.length) {
      render(`
        <section>
          <a class="back" href="#/">← home</a>
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
        <a class="back" href="#/">← home</a>
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
  if (hash === "/gallery") return renderGallery();
  if (hash === "/map") return renderMap();
  const m = hash.match(/^\/c\/(.+)$/);
  if (m) return renderCategory(decodeURIComponent(m[1]));
  return renderCover();
}

window.addEventListener("hashchange", route);

(async function main() {
  // Best-effort: if we have ?code= in the URL, we just came back from Cognito.
  await handleAuthRedirect();
  renderAuthNav();
  route();
})();
