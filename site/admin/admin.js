// ordinary.click — Segregated Admin Controller (/admin)
//
// Manages authentication (Cognito PKCE / dev mode), photo uploads via presigned S3 URLs,
// metadata editing with Rekognition AI tags, and collection/tag administration.

// ---------------------------------------------------------------------------
// Pure Helpers
// ---------------------------------------------------------------------------
export function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function decodeJwtPayload(jwt) {
  try {
    const [, payload] = jwt.split(".");
    const normalized = payload.replace(/-/g, "+").replace(/_/g, "/");
    const pad = normalized.length % 4 ? "=".repeat(4 - (normalized.length % 4)) : "";
    return JSON.parse(atob(normalized + pad));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Authentication & PKCE
// ---------------------------------------------------------------------------
const TOKENS_KEY = "oc.tokens";

export function getTokens() {
  try {
    const raw = localStorage.getItem(TOKENS_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function setTokens(tokens) {
  if (!tokens) localStorage.removeItem(TOKENS_KEY);
  else localStorage.setItem(TOKENS_KEY, JSON.stringify(tokens));
}

export function isLoggedIn() {
  const t = getTokens();
  if (!t?.id_token) return false;
  const p = decodeJwtPayload(t.id_token);
  return Boolean(p && typeof p.exp === "number" && p.exp * 1000 > Date.now());
}

export function currentUserEmail() {
  const t = getTokens();
  if (!t?.id_token) return null;
  return decodeJwtPayload(t.id_token)?.email || null;
}

export function b64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function pkcePair() {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return { verifier, challenge: b64url(new Uint8Array(hash)) };
}

let configPromise = null;
export function getConfig() {
  if (!configPromise) {
    configPromise = fetchJSON("/api/config").catch((err) => {
      configPromise = null;
      throw err;
    });
  }
  return configPromise;
}

export async function startLogin() {
  const config = await getConfig().catch(() => null);
  if (config?.devMode) {
    try {
      const devTokens = await fetchJSON("/api/dev/auth");
      setTokens(devTokens);
      renderAuthNav();
      loadAdminDashboard();
      return;
    } catch (err) {
      console.warn("Dev auth failed", err);
    }
  }
  const cfg = config?.cognito;
  if (!cfg?.domain || !cfg?.clientId) {
    alert("Login is not configured on this server.");
    return;
  }
  const { verifier, challenge } = await pkcePair();
  const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
  sessionStorage.setItem("oc.pkce", verifier);
  sessionStorage.setItem("oc.state", state);
  sessionStorage.setItem("oc.return", "/admin/");

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

export async function logout() {
  const cfg = (await getConfig().catch(() => null))?.cognito;
  setTokens(null);
  if (cfg?.domain && cfg?.clientId) {
    const params = new URLSearchParams({ client_id: cfg.clientId, logout_uri: cfg.logoutUri });
    location.assign(`https://${cfg.domain}/logout?${params}`);
  } else {
    renderAuthNav();
    loadAdminDashboard();
  }
}

export async function exchangeCode(code) {
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

export async function handleAuthRedirect() {
  const url = new URL(location.href);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code) return false;

  const expected = sessionStorage.getItem("oc.state");
  sessionStorage.removeItem("oc.state");
  sessionStorage.removeItem("oc.return");
  history.replaceState(null, "", url.pathname);

  if (!expected || state !== expected) {
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
// Network Helpers
// ---------------------------------------------------------------------------
export async function fetchJSON(path, opts = {}) {
  const headers = { accept: "application/json", ...(opts.headers || {}) };
  const res = await fetch(path, { ...opts, headers });
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  return res.status === 204 ? null : res.json();
}

export async function fetchAuthed(path, opts = {}) {
  const t = getTokens();
  if (!t?.id_token) throw new Error("not signed in");
  return fetchJSON(path, {
    ...opts,
    headers: { ...(opts.headers || {}), authorization: `Bearer ${t.id_token}` },
  });
}

// ---------------------------------------------------------------------------
// UI State & Elements
// ---------------------------------------------------------------------------
const authNav = document.getElementById("auth-nav");
const dropzone = document.getElementById("admin-dropzone");
const fileInput = document.getElementById("upload-file-input");
const dragOverlay = document.getElementById("drag-drop-overlay");

export function renderAuthNav() {
  if (!authNav) return;
  if (isLoggedIn()) {
    const email = currentUserEmail() || "admin";
    authNav.innerHTML = `<span class="who">${esc(email)}</span><button type="button" id="logout-btn" class="ghost sm">Sign out</button>`;
    authNav.querySelector("#logout-btn")?.addEventListener("click", logout);
  } else {
    authNav.innerHTML = `<button type="button" id="login-btn" class="primary sm">Sign in</button>`;
    authNav.querySelector("#login-btn")?.addEventListener("click", startLogin);
  }
}

// ---------------------------------------------------------------------------
// Admin Dashboard Data
// ---------------------------------------------------------------------------
let catalogCache = null;

export async function loadAdminDashboard() {
  renderAuthNav();
  if (!isLoggedIn()) {
    const grid = document.getElementById("photos-grid");
    if (grid) grid.innerHTML = `<p style="color: var(--fg-muted);">Please sign in above to manage photos, uploads, and collections.</p>`;
    return;
  }

  try {
    const catalog = await fetchJSON("/api/catalog");
    catalogCache = catalog;
    renderPhotos(catalog.photos || []);
    renderCollections(catalog.collections || []);
    renderTags(catalog.tags || []);
  } catch (err) {
    console.error("Failed to load catalog", err);
  }
}

function renderPhotos(photos) {
  const grid = document.getElementById("photos-grid");
  if (!grid) return;
  if (!photos.length) {
    grid.innerHTML = `<p style="color: var(--fg-muted);">No photos found. Drop files above to upload!</p>`;
    return;
  }

  grid.innerHTML = photos.map((p) => `
    <div class="photo-card" data-id="${esc(p.id)}">
      <img src="${esc(p.thumb || p.url)}" alt="${esc(p.description || p.filename || p.id)}" loading="lazy" />
      <div class="photo-info">
        <p class="photo-desc">${esc(p.description || "No description")}</p>
        <div class="photo-meta-tags">
          ${(p.tags || []).map((t) => `<span class="tag-badge">#${esc(t)}</span>`).join("")}
        </div>
      </div>
      <div class="photo-actions">
        <button type="button" class="btn-edit-photo ghost sm" data-id="${esc(p.id)}">✏️ Edit</button>
        <button type="button" class="btn-delete-photo danger sm" data-id="${esc(p.id)}">🗑 Delete</button>
      </div>
    </div>
  `).join("");

  grid.querySelectorAll(".btn-edit-photo").forEach((btn) => {
    btn.addEventListener("click", () => openMetaModal(btn.dataset.id));
  });

  grid.querySelectorAll(".btn-delete-photo").forEach((btn) => {
    btn.addEventListener("click", () => deletePhoto(btn.dataset.id));
  });
}

function renderCollections(collections) {
  const list = document.getElementById("collections-list");
  if (!list) return;
  if (!collections.length) {
    list.innerHTML = `<p style="color: var(--fg-muted);">No collections yet.</p>`;
    return;
  }

  list.innerHTML = collections.map((c) => `
    <div style="display: flex; justify-content: space-between; align-items: center; padding: 0.6rem 0; border-bottom: 1px solid var(--border);">
      <div>
        <strong>${esc(c.title)}</strong>
        <span style="font-size: 0.8rem; color: var(--fg-muted); margin-left: 0.5rem;">(${c.count || 0} photos)</span>
        ${c.description ? `<p style="font-size: 0.85rem; color: var(--fg-muted);">${esc(c.description)}</p>` : ""}
      </div>
      <div style="display: flex; gap: 0.5rem;">
        <button type="button" class="btn-edit-col ghost sm" data-id="${esc(c.id)}" data-title="${esc(c.title)}" data-desc="${esc(c.description || "")}">✏️ Edit</button>
        <button type="button" class="btn-delete-col danger sm" data-id="${esc(c.id)}">🗑</button>
      </div>
    </div>
  `).join("");

  list.querySelectorAll(".btn-edit-col").forEach((btn) => {
    btn.addEventListener("click", () => openCollectionModal(btn.dataset.id, btn.dataset.title, btn.dataset.desc));
  });
  list.querySelectorAll(".btn-delete-col").forEach((btn) => {
    btn.addEventListener("click", () => deleteCollection(btn.dataset.id));
  });
}

function renderTags(tags) {
  const list = document.getElementById("tags-list");
  if (!list) return;
  if (!tags.length) {
    list.innerHTML = `<p style="color: var(--fg-muted);">No tags yet.</p>`;
    return;
  }

  list.innerHTML = tags.map((t) => `
    <span class="tag-badge" style="padding: 0.4rem 0.6rem; font-size: 0.85rem; display: inline-flex; align-items: center; gap: 0.4rem; margin: 0.25rem;">
      <strong>#${esc(t.name)}</strong> (${t.count})
      <button type="button" class="btn-rename-tag" data-name="${esc(t.name)}" style="border:none;background:none;cursor:pointer;padding:0;">✏️</button>
    </span>
  `).join("");

  list.querySelectorAll(".btn-rename-tag").forEach((btn) => {
    btn.addEventListener("click", () => renameTag(btn.dataset.name));
  });
}

// ---------------------------------------------------------------------------
// Photo Uploads
// ---------------------------------------------------------------------------
async function uploadFiles(files) {
  if (!files || !files.length) return;
  if (!isLoggedIn()) {
    alert("Please sign in before uploading.");
    return;
  }

  const modal = document.getElementById("upload-modal");
  const list = document.getElementById("upload-list");
  if (modal) modal.hidden = false;
  if (list) list.innerHTML = `<p>Uploading ${files.length} file(s)…</p>`;

  for (const file of files) {
    try {
      const presigned = await fetchAuthed("/api/admin/uploads", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ filename: file.name, contentType: file.type }),
      });

      if (!presigned?.uploadUrl) throw new Error("No upload URL returned");

      await fetch(presigned.uploadUrl, {
        method: "PUT",
        headers: { "content-type": file.type },
        body: file,
      });

      if (list) list.innerHTML += `<p style="color: var(--success);">✓ ${esc(file.name)} uploaded successfully</p>`;
    } catch (err) {
      console.error(err);
      if (list) list.innerHTML += `<p style="color: var(--danger);">✗ ${esc(file.name)}: ${esc(err.message)}</p>`;
    }
  }

  // Refresh dashboard
  loadAdminDashboard();
}

// ---------------------------------------------------------------------------
// Modals & Metadata Editing
// ---------------------------------------------------------------------------
let activeEditingPhoto = null;

function openMetaModal(photoId) {
  const photo = catalogCache?.photos?.find((p) => p.id === photoId);
  if (!photo) return;
  activeEditingPhoto = photo;

  const modal = document.getElementById("meta-modal");
  const idInput = document.getElementById("meta-id");
  const descInput = document.getElementById("meta-desc");
  const latInput = document.getElementById("meta-lat");
  const lngInput = document.getElementById("meta-lng");
  const colSelect = document.getElementById("meta-collection");
  const chipsContainer = document.getElementById("meta-categories");
  const aiSection = document.getElementById("meta-ai-tags-section");
  const aiList = document.getElementById("meta-ai-tags-list");

  if (idInput) idInput.value = photo.id;
  if (descInput) descInput.value = photo.description || "";
  if (latInput) latInput.value = photo.latitude ?? "";
  if (lngInput) lngInput.value = photo.longitude ?? "";

  // Collections dropdown
  if (colSelect) {
    colSelect.innerHTML = `<option value="">(None)</option>` +
      (catalogCache?.collections || []).map((c) =>
        `<option value="${esc(c.id)}" ${c.id === photo.collectionId ? "selected" : ""}>${esc(c.title)}</option>`
      ).join("");
  }

  // Tags chips
  const tags = new Set(photo.categories || photo.tags || []);
  const renderChips = () => {
    chipsContainer.innerHTML = Array.from(tags).map((t) =>
      `<span class="chip">#${esc(t)} <button type="button" data-tag="${esc(t)}">×</button></span>`
    ).join("") + `<input type="text" placeholder="Add tag + Enter" style="border:none;background:none;color:inherit;outline:none;padding:0.2rem;" />`;

    chipsContainer.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        tags.delete(btn.dataset.tag);
        renderChips();
      });
    });

    const addInput = chipsContainer.querySelector("input");
    addInput?.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === ",") {
        e.preventDefault();
        const val = addInput.value.trim().replace(/^#/, "");
        if (val) {
          tags.add(val);
          renderChips();
        }
      }
    });
  };
  renderChips();

  // AI suggestions
  if (photo.ai_tags && photo.ai_tags.length) {
    aiSection.hidden = false;
    aiList.innerHTML = photo.ai_tags.map((tag) =>
      `<span class="ai-tag-chip" data-tag="${esc(tag)}">+ ${esc(tag)}</span>`
    ).join("");
    aiList.querySelectorAll(".ai-tag-chip").forEach((chip) => {
      chip.addEventListener("click", () => {
        tags.add(chip.dataset.tag);
        chip.remove();
        renderChips();
      });
    });
  } else {
    aiSection.hidden = true;
  }

  modal.hidden = false;
}

async function saveMeta(e) {
  e.preventDefault();
  if (!activeEditingPhoto) return;

  const desc = document.getElementById("meta-desc").value;
  const lat = document.getElementById("meta-lat").value;
  const lng = document.getElementById("meta-lng").value;
  const col = document.getElementById("meta-collection").value;

  const chips = Array.from(document.querySelectorAll("#meta-categories .chip")).map(
    (c) => c.textContent.replace("×", "").replace("#", "").trim()
  );

  const payload = {
    description: desc,
    categories: chips,
    collectionId: col || null,
    latitude: lat ? parseFloat(lat) : null,
    longitude: lng ? parseFloat(lng) : null,
  };

  try {
    await fetchAuthed(`/api/admin/photos/${encodeURIComponent(activeEditingPhoto.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
    document.getElementById("meta-modal").hidden = true;
    loadAdminDashboard();
  } catch (err) {
    alert(`Failed to save metadata: ${err.message}`);
  }
}

async function deletePhoto(photoId) {
  if (!confirm(`Are you sure you want to delete photo ${photoId}?`)) return;
  try {
    await fetchAuthed(`/api/admin/photos/${encodeURIComponent(photoId)}`, { method: "DELETE" });
    loadAdminDashboard();
  } catch (err) {
    alert(`Failed to delete photo: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Collection Modals
// ---------------------------------------------------------------------------
function openCollectionModal(id = "", title = "", desc = "") {
  const modal = document.getElementById("collection-modal");
  const modalTitle = document.getElementById("collection-modal-title");
  const idInput = document.getElementById("collection-id");
  const titleInput = document.getElementById("collection-title");
  const descInput = document.getElementById("collection-desc");

  idInput.value = id;
  titleInput.value = title;
  descInput.value = desc;
  modalTitle.textContent = id ? "Edit Collection" : "New Collection";
  modal.hidden = false;
}

async function saveCollection(e) {
  e.preventDefault();
  const id = document.getElementById("collection-id").value;
  const title = document.getElementById("collection-title").value.trim();
  const description = document.getElementById("collection-desc").value.trim();

  try {
    if (id) {
      await fetchAuthed(`/api/admin/collections/${encodeURIComponent(id)}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, description }),
      });
    } else {
      await fetchAuthed("/api/admin/collections", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title, description }),
      });
    }
    document.getElementById("collection-modal").hidden = true;
    loadAdminDashboard();
  } catch (err) {
    alert(`Failed to save collection: ${err.message}`);
  }
}

async function deleteCollection(id) {
  if (!confirm(`Delete this collection?`)) return;
  try {
    await fetchAuthed(`/api/admin/collections/${encodeURIComponent(id)}`, { method: "DELETE" });
    loadAdminDashboard();
  } catch (err) {
    alert(`Failed to delete collection: ${err.message}`);
  }
}

async function renameTag(oldName) {
  const newName = prompt(`Rename tag "#${oldName}" to:`, oldName);
  if (!newName || newName === oldName) return;
  try {
    await fetchAuthed(`/api/admin/tags/${encodeURIComponent(oldName)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    loadAdminDashboard();
  } catch (err) {
    alert(`Failed to rename tag: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Event Listeners & Startup
// ---------------------------------------------------------------------------
if (typeof window !== "undefined") {
  // Dropzone click & drag
  dropzone?.addEventListener("click", () => fileInput?.click());
  fileInput?.addEventListener("change", (e) => uploadFiles(Array.from(e.target.files || [])));

  // Drag over window
  let dragCounter = 0;
  window.addEventListener("dragenter", (e) => {
    e.preventDefault();
    dragCounter++;
    if (dragOverlay) dragOverlay.hidden = false;
  });
  window.addEventListener("dragleave", (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0 && dragOverlay) {
      dragCounter = 0;
      dragOverlay.hidden = true;
    }
  });
  window.addEventListener("dragover", (e) => e.preventDefault());
  window.addEventListener("drop", (e) => {
    e.preventDefault();
    dragCounter = 0;
    if (dragOverlay) dragOverlay.hidden = true;
    const files = Array.from(e.dataTransfer?.files || []).filter((f) => f.type.startsWith("image/"));
    if (files.length) uploadFiles(files);
  });

  // Modals wireup
  document.getElementById("meta-form")?.addEventListener("submit", saveMeta);
  document.getElementById("meta-cancel")?.addEventListener("click", () => {
    document.getElementById("meta-modal").hidden = true;
  });
  document.getElementById("collection-form")?.addEventListener("submit", saveCollection);
  document.getElementById("collection-cancel")?.addEventListener("click", () => {
    document.getElementById("collection-modal").hidden = true;
  });
  document.getElementById("btn-new-collection")?.addEventListener("click", () => openCollectionModal());
  document.getElementById("upload-close")?.addEventListener("click", () => {
    document.getElementById("upload-modal").hidden = true;
  });

  // Initialization
  (async function initAdmin() {
    await handleAuthRedirect();
    loadAdminDashboard();
  })();
}
