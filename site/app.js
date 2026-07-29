// ordinary.click client-side app.
//
// Tag-based model:
//   - Photos belong to any number of overlapping categories (tags).
//   - Photos may belong to one first-class collection (a curated, titled set).
//   - Content-hash ids give free dedup: re-uploading a photo merges its new
//     categories/collection into the existing record.
//
// Routes (hash-based):
//   #/                      cover / home
//   #/categories            all categories
//   #/c/<category>          one category
//   #/collections           all collections
//   #/collection/<id>       one collection
//   #/map                   geo-tagged photos
//   #/near/<lat>,<lng>,<km>  photos within a radius of a point
//
// Cognito config is fetched at runtime from /api/config (no build step).

const app = document.getElementById("app");
const authNav = document.getElementById("auth-nav");

// ---------------------------------------------------------------------------
// HTML escaping
// ---------------------------------------------------------------------------
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

// ---------------------------------------------------------------------------
// Theme toggle (light default, dark toggle, system fallback)
// ---------------------------------------------------------------------------
const THEME_KEY = "oc.theme";
function currentTheme() {
  const set = document.documentElement.dataset.theme;
  if (set === "light" || set === "dark") return set;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}
function applyThemeButton() {
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  const dark = currentTheme() === "dark";
  btn.textContent = dark ? "☀️" : "🌙";
  btn.title = dark ? "Switch to light" : "Switch to dark";
}
function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem(THEME_KEY, next); } catch { /* ignore */ }
  applyThemeButton();
}

// ---------------------------------------------------------------------------
// Config / tokens
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
  if (!cfg?.domain || !cfg?.clientId) { alert("Login is not configured."); return; }
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
    const params = new URLSearchParams({ client_id: cfg.clientId, logout_uri: cfg.logoutUri });
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
  setTokens(await res.json());
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
  history.replaceState(null, "", url.pathname + returnTo);

  // A missing `expected` means we never started this login — treat an injected
  // ?code= as hostile rather than exchanging it.
  if (!expected || state !== expected) { alert("Login failed: state mismatch."); return true; }
  try { await exchangeCode(code); }
  catch (err) { console.error(err); alert(`Login failed: ${err.message}`); }
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
    headers: { ...(opts.headers || {}), authorization: `Bearer ${t.id_token}` },
  });
}

// Catalog cache (categories + collections + totals) — powers home + selects.
let catalogPromise = null;
function getCatalog(force = false) {
  if (force) catalogPromise = null;
  if (!catalogPromise) {
    catalogPromise = fetchJSON("/api/catalog").catch((err) => { catalogPromise = null; throw err; });
  }
  return catalogPromise;
}
function invalidateCatalog() { catalogPromise = null; }

// ---------------------------------------------------------------------------
// Auth nav
// ---------------------------------------------------------------------------
function renderAuthNav() {
  if (isLoggedIn()) {
    const email = currentUserEmail() || "admin";
    authNav.innerHTML = `<span class="who">${esc(email)}</span><button id="logout-btn" class="ghost">Sign out</button>`;
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
  // Warm the neighbors so arrows/swipes feel instant.
  [lightboxIndex + 1, lightboxIndex - 1].forEach((i) => {
    const n = lightboxItems[(i + lightboxItems.length) % lightboxItems.length];
    if (n?.url) new Image().src = n.url;
  });

  let html = "";
  if (item.description) html += `<div class="lb-desc">${esc(item.description)}</div>`;
  if (item.categories?.length) {
    html += `<div class="lb-row">` + item.categories.map((c) =>
      `<a class="chip" href="#/c/${encodeURIComponent(c)}">${esc(c)}</a>`).join("") + `</div>`;
  }
  if (item.collectionId) {
    html += `<div class="lb-row"><a class="chip" href="#/collection/${encodeURIComponent(item.collectionId)}">◆ collection</a></div>`;
  }
  if (item.latitude != null && item.longitude != null) {
    const lat = Number(item.latitude).toFixed(5);
    const lon = Number(item.longitude).toFixed(5);
    html += `<div class="lb-geo">📍 ${esc(lat)}, ${esc(lon)} — <a href="#/near/${lat},${lon},${NEAR_DEFAULT_KM}">🧭 nearby</a> · <a href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}" target="_blank" rel="noopener">map</a></div>`;
  }
  lightboxMeta.innerHTML = html;
}
lightbox.querySelector(".lightbox-close").addEventListener("click", closeLightbox);
lightbox.querySelector(".lightbox-prev").addEventListener("click", (e) => { e.stopPropagation(); lightboxIndex--; showLightbox(); });
lightbox.querySelector(".lightbox-next").addEventListener("click", (e) => { e.stopPropagation(); lightboxIndex++; showLightbox(); });
lightbox.addEventListener("click", (e) => { if (e.target === lightbox || e.target === lightboxImg) closeLightbox(); });
document.addEventListener("keydown", (e) => {
  if (lightbox.hidden) return;
  if (e.key === "Escape") closeLightbox();
  else if (e.key === "ArrowLeft") { lightboxIndex--; showLightbox(); }
  else if (e.key === "ArrowRight") { lightboxIndex++; showLightbox(); }
});
// Swipe left/right on touch screens; a plain tap (dx below threshold) still
// falls through to the click handler and closes.
let _swipeX = null;
lightbox.addEventListener("touchstart", (e) => { _swipeX = e.touches[0].clientX; }, { passive: true });
lightbox.addEventListener("touchend", (e) => {
  if (_swipeX == null) return;
  const dx = e.changedTouches[0].clientX - _swipeX;
  _swipeX = null;
  if (Math.abs(dx) < 40) return;
  lightboxIndex += dx < 0 ? 1 : -1;
  showLightbox();
});

// ---------------------------------------------------------------------------
// Category chips input
// ---------------------------------------------------------------------------
const _NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,63}$/;

function createChipsInput(container, initial = [], suggestions = []) {
  const chips = [];
  const seen = new Set();
  const listId = `cat-suggest-${Math.random().toString(36).slice(2)}`;

  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "add category…";
  input.setAttribute("list", listId);
  const datalist = document.createElement("datalist");
  datalist.id = listId;
  datalist.innerHTML = suggestions.map((s) => `<option value="${esc(s)}"></option>`).join("");

  // One-click row of known categories not yet on this photo.
  container.parentElement.querySelectorAll(".chip-suggest").forEach((n) => n.remove());
  const suggestRow = document.createElement("div");
  suggestRow.className = "chip-suggest";
  container.after(suggestRow);
  suggestRow.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (btn) add(btn.dataset.name);
  });

  function render() {
    container.querySelectorAll(".chip").forEach((n) => n.remove());
    chips.forEach((name, i) => {
      const el = document.createElement("span");
      el.className = "chip";
      el.innerHTML = `${esc(name)}<button type="button" aria-label="Remove">×</button>`;
      el.querySelector("button").addEventListener("click", () => { chips.splice(i, 1); seen.delete(name.toLowerCase()); render(); });
      container.insertBefore(el, input);
    });
    const free = suggestions.filter((s) => !seen.has(s.toLowerCase()));
    suggestRow.innerHTML = free.length
      ? free.map((s) => `<button type="button" class="chip add" data-name="${esc(s)}">＋ ${esc(s)}</button>`).join("")
      : "";
  }
  function add(raw) {
    const name = (raw || "").trim();
    if (!name || !_NAME_RE.test(name) || seen.has(name.toLowerCase())) return;
    chips.push(name); seen.add(name.toLowerCase()); render();
  }

  container.innerHTML = "";
  container.appendChild(input);
  container.appendChild(datalist);
  initial.forEach(add);
  render();

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(input.value); input.value = ""; }
    else if (e.key === "Backspace" && !input.value && chips.length) { chips.pop(); seen.clear(); const copy = [...chips]; chips.length = 0; copy.forEach(add); render(); }
  });
  input.addEventListener("blur", () => { if (input.value.trim()) { add(input.value); input.value = ""; } });

  return { getCategories: () => [...chips] };
}

function collectionOptions(collections, selectedId) {
  return `<option value="">— none —</option>` + collections.map((c) =>
    `<option value="${esc(c.id)}"${c.id === selectedId ? " selected" : ""}>${esc(c.title)}</option>`).join("");
}

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
  let list = getRecentLocations().filter((l) => `${Number(l.lat).toFixed(5)},${Number(l.lng).toFixed(5)}` !== key);
  list.unshift({ name, lat: Number(lat), lng: Number(lng) });
  localStorage.setItem(RECENT_LOC_KEY, JSON.stringify(list.slice(0, RECENT_LOC_MAX)));
}
async function searchNominatim(query) {
  const params = new URLSearchParams({ format: "json", q: query, limit: "5", addressdetails: "0" });
  const res = await fetch(`https://nominatim.openstreetmap.org/search?${params}`, { headers: { accept: "application/json" } });
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

  searchInput.addEventListener("input", () => {
    clearTimeout(_nominatimTimer);
    const q = searchInput.value.trim();
    if (q.length < 2) { resultsList.innerHTML = ""; return; }
    _nominatimTimer = setTimeout(async () => {
      try {
        const results = await searchNominatim(q);
        resultsList.innerHTML = results.map((r) =>
          `<li data-lat="${esc(r.lat)}" data-lng="${esc(r.lon)}">${esc(r.display_name)}</li>`).join("");
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

  const outsideHandler = (e) => { if (!container.contains(e.target)) resultsList.innerHTML = ""; };
  document.addEventListener("click", outsideHandler);

  mapBtn.addEventListener("click", () => {
    const visible = mapDiv.style.display === "block";
    mapDiv.style.display = visible ? "none" : "block";
    if (!visible) {
      if (!pickerMap) {
        pickerMap = L.map(mapDiv, { zoomControl: true });
        L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
          maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
        }).addTo(pickerMap);
        pickerMap.on("click", (e) => {
          latInput.value = e.latlng.lat.toFixed(6);
          lngInput.value = e.latlng.lng.toFixed(6);
          updateMarker(e.latlng.lat, e.latlng.lng);
        });
      }
      const lat = parseFloat(latInput.value);
      const lng = parseFloat(lngInput.value);
      if (!isNaN(lat) && !isNaN(lng)) { pickerMap.setView([lat, lng], 13); updateMarker(lat, lng); }
      else pickerMap.setView([20, 0], 2);
      setTimeout(() => pickerMap.invalidateSize(), 100);
    }
  });

  function updateMarker(lat, lng) {
    if (!pickerMap) return;
    if (pickerMarker) pickerMarker.setLatLng([lat, lng]);
    else pickerMarker = L.marker([lat, lng]).addTo(pickerMap);
    pickerMap.panTo([lat, lng]);
  }

  function renderRecent() {
    const recent = getRecentLocations();
    if (!recent.length) { recentDiv.innerHTML = ""; return; }
    recentDiv.innerHTML = `<span class="recent-label">Recent:</span>` + recent.map((r) =>
      `<button type="button" class="recent-loc-chip" data-lat="${esc(String(r.lat))}" data-lng="${esc(String(r.lng))}">${esc(r.name)}</button>`).join("");
  }
  renderRecent();

  recentDiv.addEventListener("click", (e) => {
    const chip = e.target.closest(".recent-loc-chip");
    if (!chip) return;
    latInput.value = Number(chip.dataset.lat).toFixed(6);
    lngInput.value = Number(chip.dataset.lng).toFixed(6);
    searchInput.value = chip.textContent;
    if (pickerMap) updateMarker(Number(chip.dataset.lat), Number(chip.dataset.lng));
  });

  const picker = {
    destroy() { document.removeEventListener("click", outsideHandler); if (pickerMap) { pickerMap.remove(); pickerMap = null; } },
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
// Photo edit modal
// ---------------------------------------------------------------------------
const metaModal = document.getElementById("meta-modal");
const metaForm = document.getElementById("meta-form");
const metaDesc = document.getElementById("meta-desc");
const metaLat = document.getElementById("meta-lat");
const metaLng = document.getElementById("meta-lng");
const metaCollection = document.getElementById("meta-collection");
let metaEditCallback = null;
let metaPicker = null;
let metaChips = null;

async function openMetaModal(photo, onSaved) {
  metaDesc.value = photo.description || "";
  metaLat.value = photo.latitude != null ? photo.latitude : "";
  metaLng.value = photo.longitude != null ? photo.longitude : "";
  metaEditCallback = { photo, onSaved };

  let collections = [];
  try { collections = (await getCatalog()).collections || []; } catch { /* ignore */ }
  const knownCats = (await safeCategoryNames());
  metaCollection.innerHTML = collectionOptions(collections, photo.collectionId || "");
  metaChips = createChipsInput(document.getElementById("meta-categories"), photo.categories || [], knownCats);

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
  const { photo, onSaved } = metaEditCallback;
  const body = {
    description: metaDesc.value,
    categories: metaChips ? metaChips.getCategories() : (photo.categories || []),
    collectionId: metaCollection.value || null,
  };
  if (metaLat.value !== "" && metaLng.value !== "") {
    body.latitude = parseFloat(metaLat.value);
    body.longitude = parseFloat(metaLng.value);
  } else {
    body.latitude = null; body.longitude = null;
  }
  try {
    await fetchAuthed(`/api/admin/photos/${encodeURIComponent(photo.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (metaPicker) metaPicker.saveRecent();
    invalidateCatalog();
    closeMetaModal();
    if (onSaved) onSaved();
  } catch (err) {
    alert(`Failed to save: ${err.message}`);
  }
});

async function safeCategoryNames() {
  try { return (await getCatalog()).categories.map((c) => c.name); } catch { return []; }
}

// ---------------------------------------------------------------------------
// Collection modal (create / edit)
// ---------------------------------------------------------------------------
const collectionModal = document.getElementById("collection-modal");
const collectionForm = document.getElementById("collection-form");
const collectionTitle = document.getElementById("collection-title");
const collectionDescField = document.getElementById("collection-desc");
const collectionModalTitle = document.getElementById("collection-modal-title");
let collectionEditState = null;

function openCollectionModal(existing, onSaved) {
  collectionEditState = { existing, onSaved };
  collectionModalTitle.textContent = existing ? "Edit collection" : "New collection";
  collectionTitle.value = existing?.title || "";
  collectionDescField.value = existing?.description || "";
  collectionModal.hidden = false;
  setTimeout(() => collectionTitle.focus(), 30);
}
function closeCollectionModal() { collectionModal.hidden = true; collectionEditState = null; }
document.getElementById("collection-cancel").addEventListener("click", closeCollectionModal);
collectionModal.addEventListener("click", (e) => { if (e.target === collectionModal) closeCollectionModal(); });
collectionForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!collectionEditState) return;
  const { existing, onSaved } = collectionEditState;
  const body = { title: collectionTitle.value.trim(), description: collectionDescField.value };
  if (!body.title) return;
  try {
    if (existing) {
      await fetchAuthed(`/api/admin/collections/${encodeURIComponent(existing.id)}`, {
        method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
    } else {
      await fetchAuthed(`/api/admin/collections`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
      });
    }
    invalidateCatalog();
    closeCollectionModal();
    if (onSaved) onSaved();
  } catch (err) {
    alert(`Failed to save collection: ${err.message}`);
  }
});

// ---------------------------------------------------------------------------
// Rendering shell
// ---------------------------------------------------------------------------
let mapInstance = null;
function render(html) {
  if (mapInstance) { mapInstance.remove(); mapInstance = null; }
  activePickers.forEach((p) => p.destroy());
  activePickers = [];
  app.innerHTML = html;
}
function markActiveNav(route) {
  document.querySelectorAll("#site-nav a").forEach((a) => {
    a.classList.toggle("active", a.dataset.route === route);
  });
}

function tileTagsHtml(photo) {
  const cats = photo.categories || [];
  if (!cats.length) return `<span class="tile-tags-empty">untagged</span>`;
  return cats.map((c) =>
    `<span class="tile-tag" data-name="${esc(c)}" title="Select every photo tagged “${esc(c)}”">${esc(c)}<button type="button" class="tile-tag-del" aria-label="Remove ${esc(c)}">×</button></span>`).join("");
}

function photoTile(photo, i, admin) {
  if (!photo.ready) {
    return `<div class="photo-item pending"><div class="pending-badge">processing…</div></div>`;
  }
  const caption = photo.description
    ? esc(photo.description)
    : (photo.latitude != null ? `📍 ${Number(photo.latitude).toFixed(2)}, ${Number(photo.longitude).toFixed(2)}` : "");
  return `
    <div class="photo-item" data-index="${i}" data-id="${esc(photo.id)}">
      <div class="photo-frame">
        <img loading="lazy" decoding="async" src="${esc(photo.thumb || photo.url)}" alt="${esc(photo.filename)}"
             data-url="${esc(photo.url)}"
             onerror="if(this.dataset.fb!=='1'){this.dataset.fb='1';this.src=this.dataset.url;}" />
        ${admin ? `<button class="photo-select" data-index="${i}" title="Select (shift-click for a range)" aria-pressed="false">✓</button>
        <div class="photo-actions">
          <button class="edit-photo" data-index="${i}" title="Edit">✏️</button>
          <button class="delete-photo danger" data-id="${esc(photo.id)}" title="Delete">🗑</button>
        </div>` : ""}
        ${caption ? `<div class="photo-caption">${caption}</div>` : ""}
      </div>
      ${admin ? `<div class="tile-tags">${tileTagsHtml(photo)}</div>` : ""}
    </div>`;
}

// Sticky palette that sits above an admin photo grid; filled in by mountPhotoGrid.
const TAG_BAR_HTML = `<div id="tag-bar" class="tag-bar" hidden></div>`;

// Wire the grid: lightbox for everyone, plus (admin) selection and a tri-state
// tag palette — select photos, click a tag to paint it on or scrub it off.
async function mountPhotoGrid(photos, admin, onChanged) {
  document.querySelectorAll(".photo-item img").forEach((node) => {
    node.addEventListener("click", () => {
      const idx = parseInt(node.closest(".photo-item").dataset.index, 10);
      openLightbox(photos, idx);
    });
  });
  if (!admin) return;

  document.querySelectorAll(".edit-photo").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openMetaModal(photos[parseInt(btn.dataset.index, 10)], onChanged);
    });
  });
  document.querySelectorAll(".delete-photo").forEach((btn) => {
    btn.addEventListener("click", async (e) => {
      e.stopPropagation();
      if (!confirm("Delete this photo?")) return;
      try {
        await fetchAuthed(`/api/admin/photos/${encodeURIComponent(btn.dataset.id)}`, { method: "DELETE" });
        invalidateCatalog();
        onChanged();
      } catch (err) { alert(`Delete failed: ${err.message}`); }
    });
  });

  const grid = document.querySelector(".photo-grid");
  const bar = document.getElementById("tag-bar");
  if (!grid || !bar) return;

  const selected = new Set();
  let anchor = null;
  const ready = photos.filter((p) => p.ready);
  const selectedPhotos = () => ready.filter((p) => selected.has(p.id));

  const names = [...new Set([...(await safeCategoryNames()), ...photos.flatMap((p) => p.categories || [])])]
    .sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
  const chipHtml = (n) => `<button type="button" class="tag-chip off" data-name="${esc(n)}">${esc(n)}</button>`;

  bar.hidden = false;
  bar.innerHTML = `
    <div class="tag-bar-head">
      <span class="tag-bar-count"></span>
      <button type="button" class="ghost" data-act="all">Select all</button>
      <button type="button" class="ghost" data-act="none">Clear</button>
    </div>
    <div class="tag-palette">
      ${names.map(chipHtml).join("")}
      <input type="text" class="tag-new" placeholder="+ new tag" aria-label="New tag" />
    </div>`;
  const tagNew = bar.querySelector(".tag-new");

  function syncBar() {
    const sel = selectedPhotos();
    bar.querySelector(".tag-bar-count").textContent = sel.length
      ? `${sel.length} photo${sel.length === 1 ? "" : "s"} selected`
      : "Select photos, then click a tag to paint it on";
    bar.querySelector(".tag-palette").classList.toggle("idle", !sel.length);
    bar.querySelectorAll(".tag-chip").forEach((chip) => {
      const n = sel.filter((p) => (p.categories || []).includes(chip.dataset.name)).length;
      chip.className = `tag-chip ${!n ? "off" : n === sel.length ? "on" : "partial"}`;
    });
  }
  function paintSelection() {
    grid.querySelectorAll(".photo-item").forEach((el) => {
      const on = selected.has(el.dataset.id);
      el.classList.toggle("selected", on);
      el.querySelector(".photo-select")?.setAttribute("aria-pressed", String(on));
    });
    syncBar();
  }
  function toggleAt(idx, range) {
    const photo = photos[idx];
    if (!photo?.ready) return;
    if (range && anchor != null) {
      const [a, b] = anchor < idx ? [anchor, idx] : [idx, anchor];
      for (let i = a; i <= b; i++) if (photos[i]?.ready) selected.add(photos[i].id);
    } else {
      if (selected.has(photo.id)) selected.delete(photo.id); else selected.add(photo.id);
      anchor = idx;
    }
    paintSelection();
  }

  // ponytail: one PUT per photo — a personal gallery never selects enough
  // photos for a bulk endpoint to be worth the Lambda route.
  async function paint(sel, name, add) {
    bar.classList.add("busy");
    try {
      for (const p of sel) {
        const cats = p.categories || [];
        if (cats.includes(name) === add) continue;
        const next = add ? [...cats, name].sort() : cats.filter((c) => c !== name);
        await fetchAuthed(`/api/admin/photos/${encodeURIComponent(p.id)}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ categories: next }),
        });
        p.categories = next;
        const row = grid.querySelector(`.photo-item[data-id="${p.id}"] .tile-tags`);
        if (row) row.innerHTML = tileTagsHtml(p);
      }
      invalidateCatalog();
    } catch (err) {
      alert(`Tag update failed: ${err.message}`);
    } finally {
      bar.classList.remove("busy");
      syncBar();
    }
  }

  bar.querySelector('[data-act="all"]').addEventListener("click", () => {
    ready.forEach((p) => selected.add(p.id));
    paintSelection();
  });
  bar.querySelector('[data-act="none"]').addEventListener("click", () => {
    selected.clear(); anchor = null; paintSelection();
  });
  bar.querySelector(".tag-palette").addEventListener("click", (e) => {
    const chip = e.target.closest(".tag-chip");
    const sel = selectedPhotos();
    if (chip && sel.length) paint(sel, chip.dataset.name, !chip.classList.contains("on"));
  });
  tagNew.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== ",") return;
    e.preventDefault();
    const name = tagNew.value.trim();
    if (!_NAME_RE.test(name)) return;
    tagNew.value = "";
    if (!names.some((n) => n.toLowerCase() === name.toLowerCase())) {
      names.push(name);
      tagNew.insertAdjacentHTML("beforebegin", chipHtml(name));
    }
    const sel = selectedPhotos();
    if (sel.length) paint(sel, name, true);
  });

  grid.addEventListener("click", (e) => {
    const del = e.target.closest(".tile-tag-del");
    if (del) {
      const tag = del.closest(".tile-tag");
      const photo = ready.find((p) => p.id === tag.closest(".photo-item").dataset.id);
      if (photo) paint([photo], tag.dataset.name, false);
      return;
    }
    const tag = e.target.closest(".tile-tag");
    if (tag) {
      ready.filter((p) => (p.categories || []).includes(tag.dataset.name)).forEach((p) => selected.add(p.id));
      paintSelection();
      return;
    }
    const box = e.target.closest(".photo-select");
    if (box) toggleAt(parseInt(box.dataset.index, 10), e.shiftKey);
  });

  syncBar();
}

// Upload panel shared by category & collection pages — button + modal.
function uploadPanelHtml(presetCategories, presetCollectionId, collections) {
  return `
    <div class="page-actions"><button id="upload-open" class="primary">＋ Upload photos</button></div>
    <div id="upload-modal" class="modal" hidden>
      <div class="modal-card">
      <h3>Upload photos</h3>
      <form id="upload-form">
        <div class="upload-drop">
          <input type="file" id="upload-files" accept="image/*" multiple required />
        </div>
        <div class="field">
          <span class="field-label">Categories</span>
          <div class="chips-input" id="upload-categories"></div>
        </div>
        <label class="field">Collection
          <select id="upload-collection">${collectionOptions(collections, presetCollectionId || "")}</select>
        </label>
        <label class="field">Description
          <textarea id="upload-desc" rows="2" placeholder="Optional"></textarea>
        </label>
        <div class="field">
          <span class="field-label">Location (optional)</span>
          <div class="location-picker" id="upload-location-picker">
            <div class="location-search-wrap">
              <input type="text" class="location-search" placeholder="Search city or place…" autocomplete="off" />
              <ul class="location-results"></ul>
            </div>
            <div class="location-coords">
              <label>Lat<br /><input type="number" id="upload-lat" step="any" min="-90" max="90" /></label>
              <label>Lng<br /><input type="number" id="upload-lng" step="any" min="-180" max="180" /></label>
              <button type="button" class="location-map-btn icon-btn" title="Pick on map">📍</button>
            </div>
            <div class="location-picker-map"></div>
            <div class="recent-locations"></div>
          </div>
        </div>
        <div class="modal-actions">
          <button type="button" id="upload-cancel">Cancel</button>
          <button type="submit" class="primary">Upload</button>
        </div>
      </form>
      <ul id="upload-progress" class="progress"></ul>
      </div>
    </div>`;
}

async function wireUploadPanel(presetCategories, onDone) {
  const modal = document.getElementById("upload-modal");
  document.getElementById("upload-open").addEventListener("click", () => { modal.hidden = false; });
  document.getElementById("upload-cancel").addEventListener("click", () => { modal.hidden = true; });
  modal.addEventListener("click", (e) => { if (e.target === modal) modal.hidden = true; });
  const knownCats = await safeCategoryNames();
  const chips = createChipsInput(document.getElementById("upload-categories"), presetCategories || [], knownCats);
  const picker = attachLocationPicker(
    document.getElementById("upload-location-picker"),
    document.getElementById("upload-lat"),
    document.getElementById("upload-lng"),
  );
  document.getElementById("upload-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const files = document.getElementById("upload-files").files;
    const log = document.getElementById("upload-progress");
    const meta = {
      categories: chips.getCategories(),
      collectionId: document.getElementById("upload-collection").value || null,
      description: document.getElementById("upload-desc").value || "",
    };
    const lat = document.getElementById("upload-lat").value;
    const lng = document.getElementById("upload-lng").value;
    if (lat && lng) { meta.latitude = parseFloat(lat); meta.longitude = parseFloat(lng); }
    await uploadFiles(files, meta, log);
    picker.saveRecent();
    invalidateCatalog();
    onDone(meta);
  });
}

// ---------------------------------------------------------------------------
// Cover / home
// ---------------------------------------------------------------------------
async function renderCover() {
  markActiveNav("/");
  render(`<section class="loading"><p>Loading…</p></section>`);
  try {
    const cat = await getCatalog();
    const covers = [
      ...cat.categories.filter((c) => c.cover).map((c) => ({ cover: c.cover, fb: c.coverFallback, label: c.name, kind: "category", href: `#/c/${encodeURIComponent(c.name)}` })),
      ...cat.collections.filter((c) => c.cover).map((c) => ({ cover: c.cover, fb: c.coverFallback, label: c.title, kind: "collection", href: `#/collection/${encodeURIComponent(c.id)}` })),
    ];
    const hero = covers.length ? covers[Math.floor(Math.random() * covers.length)] : null;
    const t = cat.totals;

    const heroHtml = hero ? `
      <a class="cover-hero" href="${hero.href}">
        <img src="${esc(hero.fb || hero.cover)}" alt="${esc(hero.label)}" />
        <div class="cover-hero-overlay">
          <span class="kicker">${hero.kind}</span>
          <h2>${esc(hero.label)}</h2>
        </div>
      </a>` : "";

    const featured = cat.collections.slice(0, 4).map(collectionCard).join("");

    render(`
      <section class="cover-intro">
        <h2>Welcome</h2>
        <p>${t.photos
          ? `A quiet archive of <strong>${t.photos}</strong> photo${t.photos === 1 ? "" : "s"}, across <strong>${t.categories}</strong> categor${t.categories === 1 ? "y" : "ies"} and <strong>${t.collections}</strong> collection${t.collections === 1 ? "" : "s"}.`
          : `Nothing here yet. Sign in to upload your first photos.`}</p>
      </section>
      ${heroHtml}
      <!--div class="quick-links">
        <a class="quick-link" href="#/categories"><span class="ql-icon">🏷️</span><strong>Categories</strong><span>Browse by overlapping themes</span></a>
        <a class="quick-link" href="#/collections"><span class="ql-icon">◆</span><strong>Collections</strong><span>Curated sets that belong together</span></a>
        <a class="quick-link" href="#/map"><span class="ql-icon">🗺️</span><strong>Map</strong><span>Explore geo-tagged photos</span></a>
      </div-->
      ${featured ? `<!--div class="section-title"><h3>Collections</h3><a href="#/collections">See all →</a></div><div class="card-grid">${featured}</div-->` : ""}
    `);
  } catch (err) {
    render(`<section class="empty"><p>Couldn't load: ${esc(err.message)}</p></section>`);
  }
}

// ---------------------------------------------------------------------------
// Categories index
// ---------------------------------------------------------------------------
function categoryCard(c, admin) {
  const cover = c.cover
    ? `<img loading="lazy" decoding="async" src="${esc(c.cover)}" alt="${esc(c.name)}" data-fb="${esc(c.coverFallback || c.cover)}"
         onerror="if(this.dataset.done!=='1'){this.dataset.done='1';this.src=this.dataset.fb;}">`
    : `<div class="placeholder">🏷️</div>`;
  return `
    <a class="cover-card" href="#/c/${encodeURIComponent(c.name)}">
      ${cover}
      ${admin ? `<div class="card-admin">
        <button class="cat-rename" data-name="${esc(c.name)}" title="Rename" onclick="event.preventDefault();">✏️</button>
        <button class="cat-delete danger" data-name="${esc(c.name)}" title="Delete" onclick="event.preventDefault();">🗑</button>
      </div>` : ""}
      <span class="label"><strong>${esc(c.name)}</strong><span class="count">${c.count}</span></span>
    </a>`;
}

async function renderCategories() {
  markActiveNav("/categories");
  render(`<section class="loading"><p>Loading categories…</p></section>`);
  try {
    const cat = await getCatalog(true);
    const admin = isLoggedIn();
    const collections = admin ? cat.collections : [];
    const cards = cat.categories.map((c) => categoryCard(c, admin)).join("");
    render(`
      <div class="page-head"><h2>Categories</h2><p>${cat.categories.length
        ? "Overlapping themes — a photo can appear in several." : "No categories yet."}</p></div>
      ${admin ? uploadPanelHtml([], "", collections) : ""}
      ${cat.categories.length ? `<div class="card-grid">${cards}</div>`
        : `<section class="empty"><p>${admin
            ? "Upload a photo and tag it to create your first category."
            : "No categories yet."}</p></section>`}
    `);
    if (admin) {
      await wireUploadPanel([], () => renderCategories());
      document.querySelectorAll(".cat-rename").forEach((btn) => btn.addEventListener("click", async () => {
        const name = btn.dataset.name;
        const newName = (prompt(`Rename "${name}" — or type an existing category name to merge the two:`, name) || "").trim();
        if (!newName || newName === name) return;
        // Renaming onto an existing name merges: the server DELETEs the old tag
        // and ADDs the new one to a set, so duplicates collapse for free.
        const target = cat.categories.find((c) => c.name.toLowerCase() === newName.toLowerCase());
        if (target && !confirm(`"${target.name}" already exists — merge "${name}" into it?`)) return;
        try {
          await fetchAuthed(`/api/admin/categories/${encodeURIComponent(name)}`, {
            method: "PUT", headers: { "content-type": "application/json" },
            body: JSON.stringify({ newName: target ? target.name : newName }),
          });
          renderCategories();
        } catch (err) { alert(`Rename failed: ${err.message}`); }
      }));
      document.querySelectorAll(".cat-delete").forEach((btn) => btn.addEventListener("click", async () => {
        const name = btn.dataset.name;
        if (!confirm(`Remove category "${name}" from all photos? (Photos are kept.)`)) return;
        try {
          await fetchAuthed(`/api/admin/categories/${encodeURIComponent(name)}`, { method: "DELETE" });
          renderCategories();
        } catch (err) { alert(`Delete failed: ${err.message}`); }
      }));
    }
  } catch (err) {
    render(`<section class="empty"><p>Couldn't load categories: ${esc(err.message)}</p></section>`);
  }
}

// ---------------------------------------------------------------------------
// Single category
// ---------------------------------------------------------------------------
async function renderCategory(name) {
  markActiveNav("/categories");
  const admin = isLoggedIn();
  render(`<div class="page-head"><div class="breadcrumb"><a href="#/categories">Categories</a> / ${esc(name)}</div><h2>${esc(name)}</h2></div><section class="loading"><p>Loading…</p></section>`);
  try {
    const bust = admin ? `?t=${Date.now()}` : "";
    const data = await fetchJSON(`/api/categories/${encodeURIComponent(name)}${bust}`);
    const photos = data.images;
    const collections = admin ? (await getCatalog()).collections : [];
    const tiles = photos.map((p, i) => photoTile(p, i, admin)).join("");
    const siblings = await safeCategoryNames();
    const catNav = siblings.length > 1 ? `<div class="chip-row cat-nav">${siblings.map((c) =>
      `<a class="chip${c === name ? " on" : ""}" href="#/c/${encodeURIComponent(c)}">${esc(c)}</a>`).join("")}</div>` : "";

    render(`
      <div class="page-head">
        <div class="breadcrumb"><a href="#/categories">Categories</a> / ${esc(name)}</div>
        <h2>${esc(name)}</h2>
        <p>${photos.length} photo${photos.length === 1 ? "" : "s"}</p>
        ${catNav}
      </div>
      ${admin ? uploadPanelHtml([name], "", collections) : ""}
      ${admin && photos.length ? TAG_BAR_HTML : ""}
      ${photos.length ? `<div class="photo-grid">${tiles}</div>` : `<section class="empty"><p>No photos in this category yet.</p></section>`}
    `);

    await mountPhotoGrid(photos, admin, () => renderCategory(name));
    if (admin) await wireUploadPanel([name], () => renderCategory(name));
  } catch (err) {
    render(`<section class="empty"><a class="breadcrumb" href="#/categories">← Categories</a><p>Couldn't load category: ${esc(err.message)}</p></section>`);
  }
}

// ---------------------------------------------------------------------------
// Collections index
// ---------------------------------------------------------------------------
function collectionCard(c, admin) {
  const cover = c.cover
    ? `<img loading="lazy" decoding="async" src="${esc(c.cover)}" alt="${esc(c.title)}" data-fb="${esc(c.coverFallback || c.cover)}"
         onerror="if(this.dataset.done!=='1'){this.dataset.done='1';this.src=this.dataset.fb;}">`
    : `<div class="placeholder">◆</div>`;
  return `
    <a class="cover-card" href="#/collection/${encodeURIComponent(c.id)}">
      ${cover}
      ${admin ? `<div class="card-admin">
        <button class="coll-edit" data-id="${esc(c.id)}" title="Edit" onclick="event.preventDefault();">✏️</button>
        <button class="coll-delete danger" data-id="${esc(c.id)}" title="Delete" onclick="event.preventDefault();">🗑</button>
      </div>` : ""}
      <span class="label"><strong>${esc(c.title)}</strong><span class="count">${c.count}</span></span>
    </a>`;
}

async function renderCollections() {
  markActiveNav("/collections");
  render(`<section class="loading"><p>Loading collections…</p></section>`);
  try {
    const cat = await getCatalog(true);
    const admin = isLoggedIn();
    const cards = cat.collections.map((c) => collectionCard(c, admin)).join("");
    render(`
      <div class="page-head">
        <div class="section-title"><h2>Collections</h2>${admin ? `<button id="new-collection" class="primary">＋ New collection</button>` : ""}</div>
        <p>Curated sets of photos that belong together.</p>
      </div>
      ${cat.collections.length ? `<div class="card-grid">${cards}</div>`
        : `<section class="empty"><p>${admin ? "Create a collection, then assign photos to it." : "No collections yet."}</p></section>`}
    `);
    if (admin) {
      document.getElementById("new-collection")?.addEventListener("click", () => openCollectionModal(null, renderCollections));
      document.querySelectorAll(".coll-edit").forEach((btn) => btn.addEventListener("click", () => {
        const c = cat.collections.find((x) => x.id === btn.dataset.id);
        openCollectionModal(c, renderCollections);
      }));
      document.querySelectorAll(".coll-delete").forEach((btn) => btn.addEventListener("click", async () => {
        if (!confirm("Delete this collection? Photos are kept but unlinked.")) return;
        try {
          await fetchAuthed(`/api/admin/collections/${encodeURIComponent(btn.dataset.id)}`, { method: "DELETE" });
          invalidateCatalog();
          renderCollections();
        } catch (err) { alert(`Delete failed: ${err.message}`); }
      }));
    }
  } catch (err) {
    render(`<section class="empty"><p>Couldn't load collections: ${esc(err.message)}</p></section>`);
  }
}

// ---------------------------------------------------------------------------
// Single collection
// ---------------------------------------------------------------------------
async function renderCollection(id) {
  markActiveNav("/collections");
  const admin = isLoggedIn();
  render(`<section class="loading"><p>Loading…</p></section>`);
  try {
    const bust = admin ? `?t=${Date.now()}` : "";
    const data = await fetchJSON(`/api/collections/${encodeURIComponent(id)}${bust}`);
    const photos = data.images;
    const tiles = photos.map((p, i) => photoTile(p, i, admin)).join("");
    render(`
      <div class="page-head">
        <div class="breadcrumb"><a href="#/collections">Collections</a> / ${esc(data.title)}</div>
        <h2>${esc(data.title)}</h2>
        ${data.description ? `<p>${esc(data.description)}</p>` : `<p>${photos.length} photo${photos.length === 1 ? "" : "s"}</p>`}
      </div>
      ${admin ? uploadPanelHtml([], id, [{ id: data.id, title: data.title }]) : ""}
      ${admin && photos.length ? TAG_BAR_HTML : ""}
      ${photos.length ? `<div class="photo-grid">${tiles}</div>` : `<section class="empty"><p>No photos in this collection yet.</p></section>`}
    `);
    await mountPhotoGrid(photos, admin, () => renderCollection(id));
    if (admin) await wireUploadPanel([], () => renderCollection(id));
  } catch (err) {
    render(`<section class="empty"><a class="breadcrumb" href="#/collections">← Collections</a><p>Couldn't load collection: ${esc(err.message)}</p></section>`);
  }
}

// ---------------------------------------------------------------------------
// Upload (client-side SHA-256 -> presigned POST to originals/)
// ---------------------------------------------------------------------------
async function sha256Hex(file) {
  const buf = await file.arrayBuffer();
  const hash = await crypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function uploadFiles(files, meta, logEl) {
  if (!files?.length) return;
  for (const file of files) {
    const li = document.createElement("li");
    li.textContent = `${file.name}: hashing…`;
    logEl.appendChild(li);
    try {
      const id = await sha256Hex(file);
      const presignBody = { hash: id, filename: file.name, contentType: file.type || "image/jpeg", ...meta };
      li.textContent = `${file.name}: requesting upload URL…`;
      const presign = await fetchAuthed(`/api/admin/uploads`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(presignBody),
      });
      const form = new FormData();
      for (const [k, v] of Object.entries(presign.fields)) form.append(k, v);
      form.append("file", file);
      li.textContent = `${file.name}: uploading…`;
      const res = await fetch(presign.url, { method: "POST", body: form });
      if (!res.ok) throw new Error(`S3 upload ${res.status}`);
      li.textContent = `${file.name}: uploaded — processing in background`;
      li.className = "ok";
    } catch (err) {
      console.error(err);
      li.textContent = `${file.name}: failed (${err.message})`;
      li.className = "error";
    }
  }
}

// ---------------------------------------------------------------------------
// Map page
// ---------------------------------------------------------------------------
const NEAR_RADII = [1, 5, 25, 100, 500];
const NEAR_DEFAULT_KM = 25;

async function collectionTitles() {
  try {
    return Object.fromEntries((await getCatalog()).collections.map((c) => [c.id, c.title]));
  } catch { return {}; }
}

// Great-circle distance. ponytail: flat-earth approximation would be shorter but
// wrong near the poles and across the antimeridian, for the same three lines.
function haversineKm(aLat, aLng, bLat, bLng) {
  const R = 6371, rad = Math.PI / 180;
  const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ponytail: filters the /api/geo payload client-side — a personal gallery's
// geo list is a few hundred rows. Add a server-side geohash query if it grows.
async function renderNearby(lat, lng, km) {
  markActiveNav("/map");
  const admin = isLoggedIn();
  render(`<section class="loading"><p>Loading…</p></section>`);
  try {
    const { images } = await fetchJSON("/api/geo");
    const photos = images
      .map((p) => ({ p, d: haversineKm(lat, lng, Number(p.latitude), Number(p.longitude)) }))
      .filter((x) => Number.isFinite(x.d) && x.d <= km)
      .sort((a, b) => a.d - b.d)
      .map((x) => x.p);
    const chips = NEAR_RADII.map((r) =>
      `<a class="chip${r === km ? " on" : ""}" href="#/near/${lat.toFixed(5)},${lng.toFixed(5)},${r}">${r} km</a>`).join("");
    const here = `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    render(`
      <div class="page-head">
        <div class="breadcrumb"><a href="#/map">Map</a> / this place</div>
        <h2>Around ${esc(here)}</h2>
        <p>${photos.length} photo${photos.length === 1 ? "" : "s"} within ${km} km —
          <a href="https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=12/${lat}/${lng}" target="_blank" rel="noopener">see on OSM</a></p>
        <div class="chip-row near-radii">${chips}</div>
      </div>
      ${admin && photos.length ? TAG_BAR_HTML : ""}
      ${photos.length
        ? `<div class="photo-grid">${photos.map((p, i) => photoTile(p, i, admin)).join("")}</div>`
        : `<section class="empty"><p>No photos within ${km} km. Try a wider radius.</p></section>`}
    `);
    await mountPhotoGrid(photos, admin, () => renderNearby(lat, lng, km));
  } catch (err) {
    render(`<section class="empty"><a class="breadcrumb" href="#/map">← Map</a><p>Couldn't load nearby photos: ${esc(err.message)}</p></section>`);
  }
}
// Popup body: description first (filename is a fallback, not a headline),
// then tag/collection links and a radius search around the marker.
function mapPopupHtml(img, collTitles) {
  const lat = Number(img.latitude), lng = Number(img.longitude);
  const link = img.categories?.[0]
    ? `#/c/${encodeURIComponent(img.categories[0])}`
    : (img.collectionId ? `#/collection/${encodeURIComponent(img.collectionId)}` : "#/");
  const links = [
    ...(img.categories || []).map((c) => `<a class="chip" href="#/c/${encodeURIComponent(c)}">${esc(c)}</a>`),
    img.collectionId
      ? `<a class="chip" href="#/collection/${encodeURIComponent(img.collectionId)}">◆ ${esc(collTitles[img.collectionId] || "collection")}</a>`
      : "",
  ].join("");
  return `
    <div class="map-popup">
      <a href="${link}" class="map-popup-thumb"><img src="${esc(img.thumb)}" alt="${esc(img.filename)}" loading="lazy" /></a>
      <div class="map-popup-info">
        <div class="map-popup-desc">${esc(img.description || img.filename)}</div>
        ${links ? `<div class="map-popup-links">${links}</div>` : ""}
        <a class="map-popup-explore" href="#/near/${lat.toFixed(5)},${lng.toFixed(5)},${NEAR_DEFAULT_KM}">🧭 Explore this place</a>
      </div>
    </div>`;
}

async function renderMap() {
  markActiveNav("/map");
  render(`<div class="page-head"><h2>Map</h2><p>Geo-tagged photos</p></div><div id="geo-map"></div>`);
  try {
    const { images } = await fetchJSON("/api/geo");
    const collTitles = await collectionTitles();
    if (!images.length) {
      render(`<div class="page-head"><h2>Map</h2></div><section class="empty"><p>No geo-tagged photos yet. Add coordinates to your photos to see them here.</p></section>`);
      return;
    }
    if (mapInstance) { mapInstance.remove(); mapInstance = null; }
    mapInstance = L.map("geo-map");
    L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(mapInstance);

    const markers = L.markerClusterGroup ? L.markerClusterGroup() : L.layerGroup();
    const bounds = [];
    for (const img of images) {
      const lat = Number(img.latitude), lng = Number(img.longitude);
      if (Number.isNaN(lat) || Number.isNaN(lng)) continue;
      bounds.push([lat, lng]);
      markers.addLayer(L.marker([lat, lng]).bindPopup(mapPopupHtml(img, collTitles), { maxWidth: 300, minWidth: 180 }));
    }
    mapInstance.addLayer(markers);
    if (bounds.length === 1) mapInstance.setView(bounds[0], 14);
    else if (bounds.length > 1) mapInstance.fitBounds(bounds, { padding: [40, 40], maxZoom: 15 });
    else mapInstance.setView([20, 0], 2);
  } catch (err) {
    render(`<div class="page-head"><h2>Map</h2></div><section class="empty"><p>Couldn't load geo-tagged photos: ${esc(err.message)}</p></section>`);
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------
function route() {
  const hash = location.hash.replace(/^#/, "") || "/";
  if (hash === "/categories") return renderCategories();
  if (hash === "/collections") return renderCollections();
  if (hash === "/map") return renderMap();
  let m = hash.match(/^\/near\/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/);
  if (m) return renderNearby(Number(m[1]), Number(m[2]), Number(m[3]));
  m = hash.match(/^\/c\/(.+)$/);
  if (m) return renderCategory(decodeURIComponent(m[1]));
  m = hash.match(/^\/collection\/(.+)$/);
  if (m) return renderCollection(decodeURIComponent(m[1]));
  return renderCover();
}

window.addEventListener("hashchange", () => {
  // In-lightbox links (category chips, nearby) navigate under the overlay —
  // close it and reset scroll so the new page is actually visible.
  if (!lightbox.hidden) closeLightbox();
  scrollTo(0, 0);
  route();
});

(async function main() {
  // Sticky offset for the tag bar — the header height isn't a constant.
  const header = document.querySelector(".site-header");
  const setHeaderVar = () => document.documentElement.style.setProperty("--header-h", `${header.offsetHeight}px`);
  setHeaderVar();
  addEventListener("resize", setHeaderVar);

  document.getElementById("theme-toggle").addEventListener("click", toggleTheme);
  applyThemeButton();
  await handleAuthRedirect();
  renderAuthNav();
  route();
})();
