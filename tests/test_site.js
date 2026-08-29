// Unit tests for client-side SPA modules: Flags, Plugins, and pure helpers.
// Run: node --test tests/test_site.js

import test from "node:test";
import assert from "node:assert/strict";

// Import modules to test
import { Flags, DEFAULT_FLAGS } from "../site/flags.js";
import { events, EventBus, ThemeRegistry, LayoutRegistry, WidgetRegistry, OptionsRegistry } from "../site/plugins.js";
import { createSpherePoints, rotatePoint, projectPoint } from "../site/tagcloud.js";
import { Favorites } from "../site/favorites.js";
import { sortPhotos, groupPhotosByDate } from "../site/sorter.js";
import { tokenizeQuery, buildPhotoSearchText, searchPhotos, highlightMatches } from "../site/search.js";

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
  assert.equal(Flags.isEnabled("blurredLightbox"), true);
  assert.equal(Flags.isEnabled("randomRoute"), true);
  assert.equal(Flags.isEnabled("nonExistentFlag"), false);
  assert.equal(Flags.isEnabled("nonExistentFlag", true), true);
});

test("Flags: localStorage overrides work", () => {
  const mockStorage = createMockStorage();
  globalThis.localStorage = mockStorage;

  try {
    Flags.set("randomRoute", false);
    assert.equal(Flags.isEnabled("randomRoute"), false);

    Flags.set("randomRoute", true);
    assert.equal(Flags.isEnabled("randomRoute"), true);

    Flags.set("randomRoute", false);
    Flags.clear("randomRoute");
    assert.equal(Flags.isEnabled("randomRoute"), true);

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
    // Flag enabled by beta or default
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
  assert.ok(report.blurredLightbox);
  assert.equal(report.blurredLightbox.enabled, true);
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
  assert.ok(reg.has("monochrome"));
  assert.ok(reg.has("sepia"));
  assert.ok(reg.has("nordic"));
  assert.ok(reg.has("oled"));
  assert.equal(reg.get("light").name, "Warm Light");

  reg.register("custom-theme", {
    name: "Custom Palette",
    previewColor: "#ff00ff",
  });
  assert.ok(reg.has("custom-theme"));
  assert.equal(reg.get("custom-theme").name, "Custom Palette");
  assert.equal(reg.getAll().length, 7);
});

test("ThemeRegistry: apply emits event", () => {
  const reg = new ThemeRegistry();
  let emitted = null;
  events.on("theme:change", (e) => (emitted = e));

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
  assert.ok(reg.has("masonry"));
  assert.ok(reg.has("justified"));
  assert.ok(reg.has("compact"));

  reg.register("custom-mosaic", {
    name: "Mosaic",
    icon: "☵",
    description: "Multi-column custom mosaic style",
  });
  assert.ok(reg.has("custom-mosaic"));
  assert.equal(reg.get("custom-mosaic").icon, "☵");
  assert.equal(reg.getAll().length, 5);
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

// ---------------------------------------------------------------------------
// Tests: 3D Tag Cloud Math
// ---------------------------------------------------------------------------
test("TagCloud: createSpherePoints generates points within sphere radius", () => {
  const tags = [
    { name: "nature", count: 10 },
    { name: "urban", count: 5 },
    { name: "portrait", count: 2 },
  ];
  const radius = 100;
  const points = createSpherePoints(tags, radius);

  assert.equal(points.length, 3);
  for (const p of points) {
    const dist = Math.hypot(p.x, p.y, p.z);
    assert.ok(Math.abs(dist - radius) < 1.0, `Point distance ${dist} should equal radius ${radius}`);
  }
});

test("TagCloud: rotatePoint preserves 3D radius", () => {
  const p = { x: 50, y: 50, z: 70.71 };
  const rBefore = Math.hypot(p.x, p.y, p.z);
  const rotated = rotatePoint(p, 0.5, -0.3);
  const rAfter = Math.hypot(rotated.x, rotated.y, rotated.z);

  assert.ok(Math.abs(rBefore - rAfter) < 0.001, "Rotation should preserve distance from center");
});

test("TagCloud: projectPoint maps points with depth scale and alpha", () => {
  const front = { x: 0, y: 0, z: 50 };
  const back = { x: 0, y: 0, z: -50 };
  const pFront = projectPoint(front, 400, 400, 100);
  const pBack = projectPoint(back, 400, 400, 100);

  // Front point should be larger and more opaque than back point
  assert.ok(pFront.scale > pBack.scale, "Front point scale must be larger than back point scale");
  assert.ok(pFront.alpha > pBack.alpha, "Front point alpha must be higher than back point alpha");
});

// ---------------------------------------------------------------------------
// Tests: Favorites System
// ---------------------------------------------------------------------------
test("Favorites: toggle, check, count, and export/import", () => {
  const mockStorage = createMockStorage();
  globalThis.localStorage = mockStorage;

  try {
    const photoA = { id: "photo_a", url: "/img/a.jpg", tags: ["cat"] };
    const photoB = { id: "photo_b", url: "/img/b.jpg", tags: ["dog"] };

    assert.equal(Favorites.has("photo_a"), false);
    assert.equal(Favorites.count(), 0);

    // Toggle on
    const isFav = Favorites.toggle(photoA);
    assert.equal(isFav, true);
    assert.equal(Favorites.has("photo_a"), true);
    assert.equal(Favorites.count(), 1);

    // Add second
    Favorites.toggle(photoB);
    assert.equal(Favorites.count(), 2);

    // Toggle off
    const toggledOff = Favorites.toggle(photoA);
    assert.equal(toggledOff, false);
    assert.equal(Favorites.has("photo_a"), false);
    assert.equal(Favorites.count(), 1);

    // Export & Import
    const json = Favorites.exportJSON();
    assert.ok(json.includes("photo_b"));

    Favorites.clear();
    assert.equal(Favorites.count(), 0);

    const imported = Favorites.importJSON(json);
    assert.equal(imported, 1);
    assert.equal(Favorites.has("photo_b"), true);
  } finally {
    delete globalThis.localStorage;
  }
});

// ---------------------------------------------------------------------------
// Tests: Photo Sorter & Date Grouping
// ---------------------------------------------------------------------------
test("Sorter: sorts photos by date, name, and tag count", () => {
  const items = [
    { id: "1", filename: "zebra.jpg", createdAt: 100, tags: ["a"] },
    { id: "2", filename: "apple.jpg", createdAt: 300, tags: ["a", "b", "c"] },
    { id: "3", filename: "mountain.jpg", createdAt: 200, tags: ["a", "b"] },
  ];

  const dateDesc = sortPhotos(items, "date-desc");
  assert.deepEqual(dateDesc.map((p) => p.id), ["2", "3", "1"]);

  const dateAsc = sortPhotos(items, "date-asc");
  assert.deepEqual(dateAsc.map((p) => p.id), ["1", "3", "2"]);

  const nameAsc = sortPhotos(items, "name-asc");
  assert.deepEqual(nameAsc.map((p) => p.filename), ["apple.jpg", "mountain.jpg", "zebra.jpg"]);

  const nameDesc = sortPhotos(items, "name-desc");
  assert.deepEqual(nameDesc.map((p) => p.filename), ["zebra.jpg", "mountain.jpg", "apple.jpg"]);

  const tagsDesc = sortPhotos(items, "tags-desc");
  assert.deepEqual(tagsDesc.map((p) => p.id), ["2", "3", "1"]);
});

test("Sorter: groupPhotosByDate clusters into chronological buckets", () => {
  const now = new Date("2026-08-29T12:00:00Z").getTime();
  const todayItem = { id: "p1", createdAt: Math.floor(now / 1000) }; // seconds
  const yesterdayItem = { id: "p2", createdAt: Math.floor((now - 86400 * 1000) / 1000) };
  const olderItem = { id: "p3", createdAt: Math.floor(new Date("2026-05-15").getTime() / 1000) };

  const groups = groupPhotosByDate([olderItem, todayItem, yesterdayItem], now);
  assert.ok(groups.length >= 2);
  assert.equal(groups[0].label, "Today");
  assert.deepEqual(groups[0].photos.map((p) => p.id), ["p1"]);
  assert.equal(groups[1].label, "Yesterday");
  assert.deepEqual(groups[1].photos.map((p) => p.id), ["p2"]);
});

// ---------------------------------------------------------------------------
// Tests: Instant Search
// ---------------------------------------------------------------------------
test("Search: tokenizeQuery splits and normalizes", () => {
  assert.deepEqual(tokenizeQuery("  Nature   #Sunset  Summer  "), ["nature", "#sunset", "summer"]);
  assert.deepEqual(tokenizeQuery(""), []);
});

test("Search: searchPhotos matches tags, hashtags, descriptions and collections", () => {
  const collTitles = new Map([["c1", "Alpine Expeditions"]]);
  const photos = [
    { id: "1", tags: ["nature", "forest"], description: "Tall pine trees #sunlight", filename: "trees.jpg", collectionId: "c1" },
    { id: "2", tags: ["urban", "street"], description: "Rainy city street", filename: "city.jpg" },
    { id: "3", tags: ["nature", "mountain"], description: "Snowy peak at dawn", filename: "peak.jpg", collectionId: "c1" },
  ];

  // Search by single tag
  const r1 = searchPhotos(photos, "nature", collTitles);
  assert.equal(r1.length, 2);
  assert.ok(r1.some((p) => p.id === "1"));
  assert.ok(r1.some((p) => p.id === "3"));

  // Search by hashtag
  const r2 = searchPhotos(photos, "#sunlight", collTitles);
  assert.equal(r2.length, 1);
  assert.equal(r2[0].id, "1");

  // Multi-term AND search
  const r3 = searchPhotos(photos, "nature alpine", collTitles);
  assert.equal(r3.length, 2); // Both photos 1 and 3 are in collection 'Alpine Expeditions' and have tag 'nature'

  const r4 = searchPhotos(photos, "nature city", collTitles);
  assert.equal(r4.length, 0); // No photo has both
});

test("Search: highlightMatches wraps matching terms in mark tags", () => {
  const highlighted = highlightMatches("A peaceful forest with tall trees", "forest trees");
  assert.equal(
    highlighted,
    'A peaceful <mark class="search-highlight">forest</mark> with tall <mark class="search-highlight">trees</mark>'
  );
});

