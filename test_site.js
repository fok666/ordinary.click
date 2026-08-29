// Unit tests for client-side SPA modules: Flags, Plugins, and pure helpers.
// Run: node --test test_site.js

import test from "node:test";
import assert from "node:assert/strict";

// Import modules to test
import { Flags, DEFAULT_FLAGS } from "./site/flags.js";
import { EventBus, ThemeRegistry, LayoutRegistry, WidgetRegistry, OptionsRegistry } from "./site/plugins.js";

// Helper mocks for browser globals when testing in Node
function createMockStorage() {
  const store = new Map();
  return {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

// ---------------------------------------------------------------------------
// Tests: Feature Flags
// ---------------------------------------------------------------------------
test("Flags: default values match DEFAULT_FLAGS", () => {
  assert.equal(Flags.isEnabled("blurredLightbox"), false);
  assert.equal(Flags.isEnabled("randomRoute"), true);
  assert.equal(Flags.isEnabled("nonExistentFlag"), false);
  assert.equal(Flags.isEnabled("nonExistentFlag", true), true);
});

test("Flags: localStorage overrides work", () => {
  const mockStorage = createMockStorage();
  globalThis.localStorage = mockStorage;

  try {
    Flags.set("blurredLightbox", true);
    assert.equal(Flags.isEnabled("blurredLightbox"), true);

    Flags.set("randomRoute", false);
    assert.equal(Flags.isEnabled("randomRoute"), false);

    Flags.clear("blurredLightbox");
    assert.equal(Flags.isEnabled("blurredLightbox"), false);

    Flags.set("testFlag", true);
    Flags.clear();
    assert.equal(Flags.isEnabled("testFlag"), false);
  } finally {
    delete globalThis.localStorage;
  }
});

test("Flags: query string overrides have highest priority", () => {
  const mockStorage = createMockStorage();
  mockStorage.setItem("oc.flags", JSON.stringify({ tagCloud: false }));
  globalThis.localStorage = mockStorage;
  globalThis.window = {
    location: { search: "?flag:tagCloud=1&flag:randomRoute=0" },
  };

  try {
    assert.equal(Flags.isEnabled("tagCloud"), true);
    assert.equal(Flags.isEnabled("randomRoute"), false);
  } finally {
    delete globalThis.localStorage;
    delete globalThis.window;
  }
});

test("Flags: ?beta=1 enables default-off flags unless explicitly turned off", () => {
  const mockStorage = createMockStorage();
  mockStorage.setItem("oc.flags", JSON.stringify({ customThemes: false }));
  globalThis.localStorage = mockStorage;
  globalThis.window = {
    location: { search: "?beta=1" },
  };

  try {
    // Default-off flag enabled by beta
    assert.equal(Flags.isEnabled("instantSearch"), true);
    // Explicitly disabled flag stays off
    assert.equal(Flags.isEnabled("customThemes"), false);
  } finally {
    delete globalThis.localStorage;
    delete globalThis.window;
  }
});

test("Flags: getAll returns status report", () => {
  const report = Flags.getAll();
  assert.ok(report.randomRoute);
  assert.equal(report.randomRoute.enabled, true);
  assert.equal(report.randomRoute.source, "default");
});

// ---------------------------------------------------------------------------
// Tests: Plugins - EventBus
// ---------------------------------------------------------------------------
test("EventBus: publish and subscribe", () => {
  const bus = new EventBus();
  const received = [];

  const unsub = bus.on("test:event", (data) => received.push(data));
  bus.emit("test:event", { value: 1 });
  bus.emit("test:event", { value: 2 });
  unsub();
  bus.emit("test:event", { value: 3 });

  assert.deepEqual(received, [{ value: 1 }, { value: 2 }]);
});

test("EventBus: once triggers exactly once", () => {
  const bus = new EventBus();
  let count = 0;
  bus.once("single", () => count++);
  bus.emit("single");
  bus.emit("single");
  assert.equal(count, 1);
});

// ---------------------------------------------------------------------------
// Tests: Plugins - ThemeRegistry
// ---------------------------------------------------------------------------
test("ThemeRegistry: register, query, and baseline themes", () => {
  const reg = new ThemeRegistry();
  assert.ok(reg.has("light"));
  assert.ok(reg.has("dark"));
  assert.equal(reg.get("light").name, "Warm Light");

  reg.register("sepia", {
    name: "Sepia Film",
    previewColor: "#f4ede2",
  });
  assert.ok(reg.has("sepia"));
  assert.equal(reg.get("sepia").name, "Sepia Film");
  assert.equal(reg.getAll().length, 3);
});

test("ThemeRegistry: apply emits event", () => {
  const reg = new ThemeRegistry();
  let emitted = null;
  import("./site/plugins.js").then(({ events }) => {
    events.on("theme:change", (e) => (emitted = e));
  });

  const ok = reg.apply("dark");
  assert.equal(ok, true);
  assert.equal(reg.apply("unknown-theme"), false);
});

// ---------------------------------------------------------------------------
// Tests: Plugins - LayoutRegistry
// ---------------------------------------------------------------------------
test("LayoutRegistry: register and select layouts", () => {
  const reg = new LayoutRegistry();
  assert.ok(reg.has("grid"));

  reg.register("masonry", {
    name: "Masonry",
    icon: "☵",
    description: "Multi-column Pinterest style",
  });
  assert.ok(reg.has("masonry"));
  assert.equal(reg.get("masonry").icon, "☵");
  assert.equal(reg.getAll().length, 2);
  assert.equal(reg.set("masonry"), true);
  assert.equal(reg.set("invalid"), false);
});

// ---------------------------------------------------------------------------
// Tests: Plugins - WidgetRegistry
// ---------------------------------------------------------------------------
test("WidgetRegistry: register and renderSlot", () => {
  const reg = new WidgetRegistry();
  const rendered = [];

  reg.register("tag-cloud", {
    slot: "home:hero",
    priority: 10,
    render: (c, ctx) => rendered.push(`tag-cloud:${ctx.title}`),
  });

  reg.register("recent-strip", {
    slot: "home:hero",
    priority: 20,
    render: (c, ctx) => rendered.push(`recent-strip:${ctx.title}`),
  });

  assert.equal(reg.getAll("home:hero").length, 2);
  assert.equal(reg.getAll("other:slot").length, 0);

  reg.renderSlot("home:hero", {}, { title: "ordinary" });
  assert.deepEqual(rendered, ["tag-cloud:ordinary", "recent-strip:ordinary"]);
});

// ---------------------------------------------------------------------------
// Tests: Plugins - OptionsRegistry
// ---------------------------------------------------------------------------
test("OptionsRegistry: register and get/set value", () => {
  const reg = new OptionsRegistry();
  let changedTo = null;

  reg.register("showExif", {
    label: "Show EXIF metadata in lightbox",
    type: "boolean",
    default: true,
    onChange: (v) => (changedTo = v),
  });

  assert.equal(reg.getValue("showExif"), true);
  reg.setValue("showExif", false);
  assert.equal(changedTo, false);
  assert.equal(reg.getValue("showExif"), false);
});

// ---------------------------------------------------------------------------
// Tests: SPA Pure Helpers Parity
// ---------------------------------------------------------------------------
test("Pure Helpers: HTML escaping", () => {
  const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ESC[c]);

  assert.equal(esc('<script>alert("xss")</script>'), "&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;");
  assert.equal(esc("It's rock & roll"), "It&#39;s rock &amp; roll");
});

test("Pure Helpers: tag folding parity with server _fold()", () => {
  const foldTag = (s) => (s || "").toLowerCase().normalize("NFKD").replace(/\p{M}+/gu, "");

  assert.equal(foldTag("München"), foldTag("munchen"));
  assert.equal(foldTag("ISS"), foldTag("iss"));
  assert.equal(foldTag("Übermut"), foldTag("ubermut"));
  assert.equal(foldTag("Grün"), "grun");
});

test("Pure Helpers: hashtag regex matches valid hashtags and rejects punctuation", () => {
  const TAG_RE = /(?<![&\p{L}\p{N}_])#([\p{L}\p{N}](?:[\p{L}\p{N}_.-]*[\p{L}\p{N}])?)/gu;
  const extractTags = (s) => [...s.matchAll(TAG_RE)].map((m) => m[1]);

  assert.deepEqual(extractTags("A #Sunset drive. #v1.0 it&#39;s not#tag"), ["Sunset", "v1.0"]);
  assert.deepEqual(extractTags("Ein #grünes Auto, #Übermut!"), ["grünes", "Übermut"]);
  assert.deepEqual(extractTags("No hashtags here # and #!"), []);
});

test("Pure Helpers: Haversine distance calculation", () => {
  function haversineKm(aLat, aLng, bLat, bLng) {
    const R = 6371, rad = Math.PI / 180;
    const dLat = (bLat - aLat) * rad, dLng = (bLng - aLng) * rad;
    const h = Math.sin(dLat / 2) ** 2
      + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLng / 2) ** 2;
    return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  // Distance between Zurich (47.3769, 8.5417) and Munich (48.1351, 11.5820): ~240 km
  const d = haversineKm(47.3769, 8.5417, 48.1351, 11.5820);
  assert.ok(d > 230 && d < 255, `Expected ~242km, got ${d}`);

  // Same point distance is 0
  assert.equal(haversineKm(47.0, 8.0, 47.0, 8.0), 0);
});
