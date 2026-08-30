// ordinary.click — Client-Side Feature Flagging
//
// Allows dark-shipping features, local beta testing, and URL-based feature activation.
// Flags are evaluated with the following precedence:
//   1. URL query parameters: `?flag:<name>=1|0|true|false`
//   2. URL beta toggle: `?beta=1` (turns on all flags not explicitly disabled)
//   3. localStorage overrides: `oc.flags` JSON object
//   4. Code defaults

const STORAGE_KEY = "oc.flags";

/**
 * Comprehensive schema and documentation for all application feature flags.
 * Each entry provides functional purpose and system impact for full configurability.
 */
export const FLAG_DEFINITIONS = {
  blurredLightbox: {
    id: "blurredLightbox",
    label: "Blurred Lightbox Backdrop",
    category: "UI & Visuals",
    purpose: "Underlays the photo viewer with an enlarged, high-radius blurred clone of the active photo.",
    impact: "Provides an immersive cinematic gallery presentation. Minor GPU composition overhead on very low-end mobile devices.",
    default: true,
  },
  randomRoute: {
    id: "randomRoute",
    label: "Random Photo Discovery",
    category: "Discovery & Navigation",
    purpose: "Enables the #/random route and navigation link to pick a surprise discovery photo.",
    impact: "Adds a serendipitous discovery path. Fetches a tag photo over the network on navigation.",
    default: true,
  },
  latestRoute: {
    id: "latestRoute",
    label: "Latest Photo Spotlight",
    category: "Discovery & Navigation",
    purpose: "Enables the #/latest route directly jumping to the single most recently uploaded photo.",
    impact: "Convenient direct link for returning visitors to view the newest moment. Uses cached photo catalog.",
    default: true,
  },
  recentRoute: {
    id: "recentRoute",
    label: "Recent Timeline Archive",
    category: "Discovery & Navigation",
    purpose: "Enables the #/recent route rendering uploads grouped by chronological buckets (Today, Yesterday, This Week, Month Year).",
    impact: "Renders an organized chronological timeline. Performs client-side date clustering on the photo catalog.",
    default: true,
  },
  dragDropUpload: {
    id: "dragDropUpload",
    label: "Drag & Drop Upload Target",
    category: "Admin DX",
    purpose: "Enables viewport-wide drag-and-drop file upload target when logged in as admin.",
    impact: "Allows dragging photos directly from desktop into the gallery. Disabled for public visitors.",
    default: true,
  },
  photoSorting: {
    id: "photoSorting",
    label: "Photo Grid Sorting Controls",
    category: "User Experience",
    purpose: "Enables the sorting dropdown (date, title, tag count) on gallery grids and search pages.",
    impact: "Provides visitor flexibility in ordering photos. Instant client-side array sorting with zero network requests.",
    default: true,
  },
  instantSearch: {
    id: "instantSearch",
    label: "Instant Catalog Search",
    category: "Discovery & Navigation",
    purpose: "Enables the #/search instant search route with multi-term keyword and hashtag matching.",
    impact: "Fast client-side indexing across tags, descriptions, filenames, and places. Requires cached catalog in memory.",
    default: true,
  },
  favorites: {
    id: "favorites",
    label: "User Favorites & Bookmarks",
    category: "User Experience",
    purpose: "Enables photo favoriting with heart buttons (♥) and the dedicated #/favorites archive with JSON export/import.",
    impact: "Lets visitors save personal favorites locally in localStorage without needing an account.",
    default: true,
  },
  tagCloud: {
    id: "tagCloud",
    label: "3D Interactive Tag Cloud",
    category: "UI & Visuals",
    purpose: "Renders the zero-dependency 3D rotating canvas sphere on the #/tags page.",
    impact: "Interactive 3D tag discovery with momentum physics. 60fps HTML5 canvas rendering; turn off for static list on low-spec hardware.",
    default: true,
  },
  customThemes: {
    id: "customThemes",
    label: "Configurable Color Themes",
    category: "UI & Visuals",
    purpose: "Enables the theme picker supporting Warm Light, Dark, Monochrome, Sepia, Nordic, and OLED themes.",
    impact: "Customizable color palettes and contrast rules; saves OLED battery life. Persists choice in localStorage.",
    default: true,
  },
  customLayouts: {
    id: "customLayouts",
    label: "Configurable Grid Layouts",
    category: "UI & Visuals",
    purpose: "Enables switching gallery grids between Square Grid, Masonry, Justified Rows, and Compact List.",
    impact: "Provides dynamic layouts tailored to photo aspect ratios using pure CSS; zero JavaScript layout reflow overhead.",
    default: true,
  },
  contextHelp: {
    id: "contextHelp",
    label: "Contextual Help & Shortcuts",
    category: "User Experience",
    purpose: "Enables keyboard shortcuts modal (?) and contextual navigation tips across the gallery.",
    impact: "Assists new visitors with hashtag drill-down, keyboard navigation, and gallery tips. Zero network cost.",
    default: true,
  },
  mapView: {
    id: "mapView",
    label: "Geolocation Map Explorer",
    category: "Network & Offline",
    purpose: "Enables the #/map and #/near geolocation routes and interactive map tiles.",
    impact: "Visualizes geo-tagged photos on an interactive Leaflet map. When disabled, eliminates external CDN dependencies for offline/air-gapped operation.",
    default: true,
  },
};

export const DEFAULT_FLAGS = Object.fromEntries(
  Object.entries(FLAG_DEFINITIONS).map(([k, v]) => [k, v.default])
);

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

  /**
   * Return flag definitions containing explanations of purpose and impact.
   * @returns {typeof FLAG_DEFINITIONS}
   */
  getDefinitions() {
    return { ...FLAG_DEFINITIONS };
  },

  /**
   * Return comprehensive evaluation report with functional explanations and impact metadata.
   */
  getDetailedReport() {
    const statuses = this.getAll();
    const result = {};
    for (const [id, def] of Object.entries(FLAG_DEFINITIONS)) {
      result[id] = {
        ...def,
        enabled: statuses[id]?.enabled ?? def.default,
        source: statuses[id]?.source ?? "default",
      };
    }
    return result;
  },
};

// Expose globally in browser for debugging in DevTools console
if (typeof window !== "undefined") {
  window.Flags = Flags;
}

export default Flags;
