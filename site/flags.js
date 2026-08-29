// ordinary.click — Client-Side Feature Flagging
//
// Allows dark-shipping features, local beta testing, and URL-based feature activation.
// Flags are evaluated with the following precedence:
//   1. URL query parameters: `?flag:<name>=1|0|true|false`
//   2. URL beta toggle: `?beta=1` (turns on all flags not explicitly disabled)
//   3. localStorage overrides: `oc.flags` JSON object
//   4. Code defaults

const STORAGE_KEY = "oc.flags";

export const DEFAULT_FLAGS = {
  blurredLightbox: false,
  randomRoute: true,
  latestRoute: true,
  recentRoute: true,
  dragDropUpload: false,
  photoSorting: true,
  instantSearch: false,
  favorites: false,
  tagCloud: false,
  customThemes: false,
  customLayouts: false,
};

function getStorage() {
  if (typeof localStorage === "undefined") return null;
  try {
    localStorage.getItem("__probe__");
    return localStorage;
  } catch {
    return null;
  }
}

function getSearchParams() {
  if (typeof window === "undefined" || !window.location) return null;
  try {
    return new URLSearchParams(window.location.search);
  } catch {
    return null;
  }
}

export const Flags = {
  _defaults: { ...DEFAULT_FLAGS },
  _memoryOverrides: {},

  /**
   * Check if a feature flag is enabled.
   * @param {string} flag - Flag name
   * @param {boolean} [fallback] - Optional override for default value
   * @returns {boolean}
   */
  isEnabled(flag, fallback) {
    // 1. Explicit query parameter: ?flag:name=1 or 0
    const qs = getSearchParams();
    if (qs) {
      const key = `flag:${flag}`;
      if (qs.has(key)) {
        const val = qs.get(key);
        return val === "1" || val === "true";
      }
      // 2. Global beta flag ?beta=1
      if (qs.has("beta") && (qs.get("beta") === "1" || qs.get("beta") === "true")) {
        // Only return true if not explicitly disabled in localStorage
        const stored = this.getStored();
        if (typeof stored[flag] === "boolean") return stored[flag];
        return true;
      }
    }

    // 3. LocalStorage / in-memory override
    const stored = this.getStored();
    if (typeof stored[flag] === "boolean") {
      return stored[flag];
    }

    // 4. Default / Fallback
    if (typeof fallback === "boolean") return fallback;
    return this._defaults[flag] ?? false;
  },

  /**
   * Set a feature flag override in localStorage (and memory).
   * @param {string} flag
   * @param {boolean} value
   */
  set(flag, value) {
    this._memoryOverrides[flag] = Boolean(value);
    const storage = getStorage();
    if (!storage) return;
    try {
      const stored = this.getStored();
      stored[flag] = Boolean(value);
      storage.setItem(STORAGE_KEY, JSON.stringify(stored));
    } catch {
      /* ignore */
    }
  },

  /**
   * Clear an override or all overrides.
   * @param {string} [flag] - If provided, clears only this flag; otherwise clears all.
   */
  clear(flag) {
    if (flag) {
      delete this._memoryOverrides[flag];
    } else {
      this._memoryOverrides = {};
    }
    const storage = getStorage();
    if (!storage) return;
    try {
      if (flag) {
        const stored = this.getStored();
        delete stored[flag];
        storage.setItem(STORAGE_KEY, JSON.stringify(stored));
      } else {
        storage.removeItem(STORAGE_KEY);
      }
    } catch {
      /* ignore */
    }
  },

  /**
   * Get all stored overrides.
   * @returns {Record<string, boolean>}
   */
  getStored() {
    const storage = getStorage();
    if (!storage) return { ...this._memoryOverrides };
    try {
      const raw = storage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : { ...this._memoryOverrides };
    } catch {
      return { ...this._memoryOverrides };
    }
  },

  /**
   * Return evaluation report for all known flags.
   * @returns {Record<string, { enabled: boolean, source: 'query'|'beta'|'storage'|'default' }>}
   */
  getAll() {
    const qs = getSearchParams();
    const stored = this.getStored();
    const names = new Set([...Object.keys(this._defaults), ...Object.keys(stored)]);
    const result = {};

    for (const name of names) {
      if (qs?.has(`flag:${name}`)) {
        result[name] = {
          enabled: qs.get(`flag:${name}`) === "1" || qs.get(`flag:${name}`) === "true",
          source: "query",
        };
      } else if (typeof stored[name] === "boolean") {
        result[name] = { enabled: stored[name], source: "storage" };
      } else if (qs?.has("beta") && (qs.get("beta") === "1" || qs.get("beta") === "true")) {
        result[name] = { enabled: true, source: "beta" };
      } else {
        result[name] = { enabled: this._defaults[name] ?? false, source: "default" };
      }
    }
    return result;
  },
};

// Expose globally in browser for debugging in DevTools console
if (typeof window !== "undefined") {
  window.Flags = Flags;
}

export default Flags;
