// ordinary.click — Pluggable Architecture Engine
//
// Provides registries and hooks for themes, layouts, widgets, and user options.
// Keeps the core SPA lightweight and decoupled while allowing clean expansion.

// ---------------------------------------------------------------------------
// Lightweight Event Bus
// ---------------------------------------------------------------------------
export class EventBus {
  constructor() {
    this._listeners = new Map();
  }

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {Function} callback
   * @returns {() => void} Unsubscribe function
   */
  on(event, callback) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(callback);
    return () => this.off(event, callback);
  }

  /**
   * Subscribe to an event once.
   * @param {string} event
   * @param {Function} callback
   * @returns {() => void}
   */
  once(event, callback) {
    const unsub = this.on(event, (...args) => {
      unsub();
      callback(...args);
    });
    return unsub;
  }

  /**
   * Unsubscribe from an event.
   * @param {string} event
   * @param {Function} callback
   */
  off(event, callback) {
    const set = this._listeners.get(event);
    if (set) {
      set.delete(callback);
      if (set.size === 0) this._listeners.delete(event);
    }
  }

  /**
   * Emit an event to all subscribers.
   * @param {string} event
   * @param {any} [data]
   */
  emit(event, data) {
    const set = this._listeners.get(event);
    if (!set) return;
    for (const cb of [...set]) {
      try {
        cb(data);
      } catch (err) {
        console.error(`[EventBus] Error in handler for "${event}":`, err);
      }
    }
  }
}

export const events = new EventBus();

// ---------------------------------------------------------------------------
// Theme Registry
// ---------------------------------------------------------------------------
export class ThemeRegistry {
  constructor() {
    this._themes = new Map();
    this._current = "light";

    // Register baseline themes
    this.register("light", {
      id: "light",
      name: "Warm Light",
      description: "Default subtle warm paper light theme",
      previewColor: "#faf9f7",
    });
    this.register("dark", {
      id: "dark",
      name: "Warm Dark",
      description: "Default warm dark theme",
      previewColor: "#171614",
    });
    this.register("monochrome", {
      id: "monochrome",
      name: "Monochrome",
      description: "Stark black and white gallery aesthetic",
      previewColor: "#0d0d0d",
    });
    this.register("sepia", {
      id: "sepia",
      name: "Sepia Archive",
      description: "Warm vintage film and archival amber tones",
      previewColor: "#f5eedf",
    });
    this.register("nordic", {
      id: "nordic",
      name: "Nordic Slate",
      description: "Cool slate grays and muted iceberg blues",
      previewColor: "#1c2229",
    });
    this.register("oled", {
      id: "oled",
      name: "OLED Black",
      description: "Pure #000000 high-contrast black for OLED displays",
      previewColor: "#000000",
    });
  }

  register(id, theme) {
    this._themes.set(id, { id, ...theme });
  }

  get(id) {
    return this._themes.get(id) || null;
  }

  getAll() {
    return Array.from(this._themes.values());
  }

  has(id) {
    return this._themes.has(id);
  }

  current() {
    if (typeof document !== "undefined" && document.documentElement) {
      const set = document.documentElement.dataset.theme;
      if (set && this.has(set)) return set;
    }
    return this._current;
  }

  apply(id) {
    if (!this.has(id)) return false;
    this._current = id;
    if (typeof document !== "undefined" && document.documentElement) {
      document.documentElement.dataset.theme = id;
      try {
        localStorage.setItem("oc.theme", id);
      } catch {
        /* ignore */
      }
    }
    events.emit("theme:change", { theme: id, meta: this.get(id) });
    return true;
  }
}

export const themes = new ThemeRegistry();

// ---------------------------------------------------------------------------
// Layout Registry
// ---------------------------------------------------------------------------
export class LayoutRegistry {
  constructor() {
    this._layouts = new Map();
    this._current = "grid";

    // Register baseline standard grid
    this.register("grid", {
      id: "grid",
      name: "Square Grid",
      icon: "▦",
      description: "Uniform square grid tiles",
      containerClass: "photo-grid",
    });
    this.register("masonry", {
      id: "masonry",
      name: "Masonry",
      icon: "▤",
      description: "Dynamic multi-column layout preserving natural aspect ratios",
      containerClass: "photo-grid-masonry",
    });
    this.register("justified", {
      id: "justified",
      name: "Justified",
      icon: "▬",
      description: "Proportional row strip layout",
      containerClass: "photo-grid-justified",
    });
    this.register("compact", {
      id: "compact",
      name: "Compact List",
      icon: "☰",
      description: "Detailed list view with metadata",
      containerClass: "photo-grid-compact",
    });
  }

  register(id, layout) {
    this._layouts.set(id, { id, ...layout });
  }

  get(id) {
    return this._layouts.get(id) || null;
  }

  getAll() {
    return Array.from(this._layouts.values());
  }

  has(id) {
    return this._layouts.has(id);
  }

  current() {
    if (typeof localStorage !== "undefined") {
      try {
        const stored = localStorage.getItem("oc.layout");
        if (stored && this.has(stored)) return stored;
      } catch {
        /* ignore */
      }
    }
    return this._current;
  }

  set(id) {
    if (!this.has(id)) return false;
    this._current = id;
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem("oc.layout", id);
      } catch {
        /* ignore */
      }
    }
    events.emit("layout:change", { layout: id, meta: this.get(id) });
    return true;
  }
}

export const layouts = new LayoutRegistry();

// ---------------------------------------------------------------------------
// Widget Registry (for home / cover / drilldown slots)
// ---------------------------------------------------------------------------
export class WidgetRegistry {
  constructor() {
    this._widgets = new Map();
  }

  /**
   * Register a widget for a UI slot.
   * @param {string} id - Unique widget ID
   * @param {object} widget - { slot: string, name: string, priority?: number, render: (container, ctx) => void }
   */
  register(id, widget) {
    this._widgets.set(id, { id, priority: 100, ...widget });
  }

  get(id) {
    return this._widgets.get(id) || null;
  }

  getAll(slot) {
    const list = Array.from(this._widgets.values());
    if (!slot) return list;
    return list
      .filter((w) => w.slot === slot)
      .sort((a, b) => (a.priority ?? 100) - (b.priority ?? 100));
  }

  /**
   * Render all registered widgets for a specific slot into a container element.
   * @param {string} slot
   * @param {HTMLElement} container
   * @param {object} [context]
   */
  renderSlot(slot, container, context = {}) {
    if (!container) return;
    const widgets = this.getAll(slot);
    for (const w of widgets) {
      if (typeof w.render === "function") {
        try {
          w.render(container, context);
        } catch (err) {
          console.error(`[WidgetRegistry] Error rendering widget "${w.id}":`, err);
        }
      }
    }
  }
}

export const widgets = new WidgetRegistry();

// ---------------------------------------------------------------------------
// Options Registry
// ---------------------------------------------------------------------------
export class OptionsRegistry {
  constructor() {
    this._options = new Map();
    this._values = new Map();
  }

  register(id, opt) {
    this._options.set(id, { id, ...opt });
  }

  get(id) {
    return this._options.get(id) || null;
  }

  getAll() {
    return Array.from(this._options.values());
  }

  getValue(id) {
    const opt = this.get(id);
    if (!opt) return null;
    if (typeof localStorage !== "undefined") {
      try {
        const stored = localStorage.getItem(`oc.opt.${id}`);
        if (stored !== null) return JSON.parse(stored);
      } catch {
        /* fallback */
      }
    }
    if (this._values.has(id)) {
      return this._values.get(id);
    }
    return opt.default ?? null;
  }

  setValue(id, val) {
    const opt = this.get(id);
    if (!opt) return;
    this._values.set(id, val);
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(`oc.opt.${id}`, JSON.stringify(val));
      } catch {
        /* ignore */
      }
    }
    if (typeof opt.onChange === "function") {
      try {
        opt.onChange(val);
      } catch (err) {
        console.error(`[OptionsRegistry] Error in onChange for "${id}":`, err);
      }
    }
    events.emit("option:change", { id, value: val });
  }
}

export const options = new OptionsRegistry();

// Expose globally in browser for debugging
if (typeof window !== "undefined") {
  window.Plugins = { events, themes, layouts, widgets, options };
}

export default {
  events,
  themes,
  layouts,
  widgets,
  options,
};
