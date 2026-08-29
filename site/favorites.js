// ordinary.click — User Favorites System
//
// Manages client-side favorited photos in localStorage (`oc.favorites`).
// Allows users to bookmark favorite images across the gallery, export/import
// collections, and view them in a dedicated #/favorites view.

import { events } from "./plugins.js";

const STORAGE_KEY = "oc.favorites";

function getStorage() {
  if (typeof localStorage === "undefined") return null;
  try {
    localStorage.getItem("__probe__");
    return localStorage;
  } catch {
    return null;
  }
}

let _cache = null;

function loadFromStorage() {
  if (_cache) return _cache;
  const storage = getStorage();
  if (!storage) {
    _cache = [];
    return _cache;
  }
  try {
    const raw = storage.getItem(STORAGE_KEY);
    _cache = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(_cache)) _cache = [];
  } catch {
    _cache = [];
  }
  return _cache;
}

function saveToStorage(list) {
  _cache = list;
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
}

export const Favorites = {
  /**
   * Get all favorited photos.
   * @returns {Array<object>}
   */
  getAll() {
    return [...loadFromStorage()];
  },

  /**
   * Check if a photo id is favorited.
   * @param {string} id
   * @returns {boolean}
   */
  has(id) {
    if (!id) return false;
    const list = loadFromStorage();
    return list.some((p) => p.id === id);
  },

  /**
   * Toggle a photo's favorite status.
   * @param {object} photo
   * @returns {boolean} New favorite state (true = added, false = removed)
   */
  toggle(photo) {
    if (!photo || !photo.id) return false;
    let list = loadFromStorage();
    const index = list.findIndex((p) => p.id === photo.id);
    let isNowFavorite = false;

    if (index >= 0) {
      list.splice(index, 1);
      isNowFavorite = false;
    } else {
      // Save clean subset of photo metadata
      const snapshot = {
        id: photo.id,
        url: photo.url,
        thumb: photo.thumb || photo.url,
        categories: photo.categories || [],
        tags: photo.tags || photo.categories || [],
        description: photo.description || "",
        filename: photo.filename || "",
        collectionId: photo.collectionId || null,
        latitude: photo.latitude ?? null,
        longitude: photo.longitude ?? null,
        createdAt: photo.createdAt || Date.now(),
        updatedAt: photo.updatedAt || Date.now(),
        favoritedAt: Date.now(),
      };
      list.unshift(snapshot);
      isNowFavorite = true;
    }

    saveToStorage(list);
    events.emit("favorite:change", {
      id: photo.id,
      isFavorite: isNowFavorite,
      count: list.length,
      photo,
    });
    return isNowFavorite;
  },

  /**
   * Remove a photo from favorites.
   * @param {string} id
   */
  remove(id) {
    if (!id) return;
    let list = loadFromStorage();
    const next = list.filter((p) => p.id !== id);
    if (next.length !== list.length) {
      saveToStorage(next);
      events.emit("favorite:change", { id, isFavorite: false, count: next.length });
    }
  },

  /**
   * Clear all favorites.
   */
  clear() {
    saveToStorage([]);
    events.emit("favorite:change", { id: null, isFavorite: false, count: 0 });
  },

  /**
   * Get total count of favorited photos.
   * @returns {number}
   */
  count() {
    return loadFromStorage().length;
  },

  /**
   * Export favorites as formatted JSON string.
   * @returns {string}
   */
  exportJSON() {
    return JSON.stringify(loadFromStorage(), null, 2);
  },

  /**
   * Import favorites from JSON string.
   * @param {string} jsonString
   * @returns {number} Count of newly added favorites
   */
  importJSON(jsonString) {
    try {
      const parsed = JSON.parse(jsonString);
      if (!Array.isArray(parsed)) return 0;
      let list = loadFromStorage();
      const existingIds = new Set(list.map((p) => p.id));
      let added = 0;

      for (const item of parsed) {
        if (item && item.id && !existingIds.has(item.id)) {
          existingIds.add(item.id);
          list.push(item);
          added++;
        }
      }

      if (added > 0) {
        saveToStorage(list);
        events.emit("favorite:change", { count: list.length });
      }
      return added;
    } catch {
      return 0;
    }
  },
};

export default Favorites;
