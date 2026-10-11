# 3D Spatial Gallery & Admin Segregation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the ordinary.click frontend into a full-screen interactive 3D chronological landscape with golden ratio axis spacing, Depth-of-Field blur and foggy fade, first-person navigation, full-screen inspection with bottom-left legend, and segregated admin tools at `/admin`.

**Architecture:** Native CSS 3D & DOM transforms with virtual camera math in `spatial.js`, zero-dependency delivery optimization (thumbs for receding landscape, full display images for foreground/focus), and a standalone `/admin` web application isolating Cognito PKCE auth, upload dropzone, and metadata editing.

**Tech Stack:** Vanilla ES6+ JavaScript, CSS3 3D transforms (`perspective`, `transform-style: preserve-3d`), CSS filters (`blur`, `grayscale`), HTML5, Node.js test runner (`node --test`).

**Spec:** [docs/superpowers/specs/2026-10-11-3d-spatial-gallery-and-admin-segregation-design.md](file:///Users/kornfer/projects/poc/ordinary.click/docs/superpowers/specs/2026-10-11-3d-spatial-gallery-and-admin-segregation-design.md)

## Global Constraints

- Pure Vanilla ES6+ JavaScript — no build steps, no webpack/vite, no external 3D libraries.
- Golden ratio $\phi = \frac{1 + \sqrt{5}}{2} \approx 1.61803398875$ applied to spatial axis scaling ($1.0 : \phi : \phi^2$).
- Zero admin or Cognito authentication code inside the visitor `index.html` bundle.
- Admin UI completely contained in `site/admin/index.html`, `site/admin/admin.js`, and `site/admin/admin.css`.
- Test suite: All tests must run cleanly via `node --test tests/test_site.js` and `python3 tests/test_api_handler.py`.

---

### Task 1: Spatial Mathematical & Coordinate Engine (`site/spatial.js`)

**Files:**
- Create: `site/spatial.js`
- Test: `tests/test_site.js`

**Interfaces:**
- Produces:
  - `PHI`: constant `1.61803398875`
  - `calculatePhotoCoordinates(photos, options)`: maps photo timestamps to 3D `(x, y, z)` coordinates using golden ratio progression and axis presets.
  - `calculateDepthShader(photoZ, cameraZ, options)`: returns `{ blur, grayscale, opacity, isVisible, tier }` for optical Depth-of-Field and fog fade.
  - `AXIS_PRESETS`: dictionary of layout presets (`landscape`, `seasonal`, `ribbon`).
  - `clamp(val, min, max)`: numeric clamping helper.

- [ ] **Step 1: Write the failing tests in `tests/test_site.js`**

Add unit tests for spatial math functions to `tests/test_site.js`:
```javascript
import { PHI, calculatePhotoCoordinates, calculateDepthShader, AXIS_PRESETS } from "../site/spatial.js";

test("Spatial Math: PHI equals the golden ratio", () => {
  assert.ok(Math.abs(PHI - 1.61803398875) < 1e-6);
});

test("Spatial Math: calculatePhotoCoordinates orders latest photo at front Z=0", () => {
  const samplePhotos = [
    { id: "p1", createdAt: 1710200000 },
    { id: "p2", createdAt: 1710100000 },
    { id: "p3", createdAt: 1710000000 },
  ];
  const coords = calculatePhotoCoordinates(samplePhotos, { preset: "landscape" });
  assert.equal(coords.length, 3);
  assert.equal(coords[0].id, "p1");
  assert.equal(coords[0].z, 0); // latest photo is at foreground Z=0
  assert.ok(coords[1].z < 0);   // older photo recedes into -Z
  assert.ok(coords[2].z < coords[1].z); // oldest photo is furthest back
});

test("Spatial Math: golden ratio axis scaling applies to coordinates", () => {
  const samplePhotos = [
    { id: "p1", createdAt: 1710000000 },
    { id: "p2", createdAt: 1700000000 },
  ];
  const coords = calculatePhotoCoordinates(samplePhotos, { preset: "landscape", goldenMultiplier: 1.5 });
  assert.ok(coords[1].z < -100);
});

test("Spatial Math: calculateDepthShader calculates DoF blur and foggy fade", () => {
  // Focal plane (camera right at photo Z=0)
  const focal = calculateDepthShader(0, 0);
  assert.equal(focal.blur, 0);
  assert.equal(focal.grayscale, 0);
  assert.equal(focal.opacity, 1);
  assert.equal(focal.tier, "display");

  // Midground (photo at Z=-1000, camera at Z=0)
  const mid = calculateDepthShader(-1000, 0);
  assert.ok(mid.blur > 0);
  assert.ok(mid.grayscale > 0);
  assert.equal(mid.tier, "thumb");

  // Extreme horizon beyond max distance
  const distant = calculateDepthShader(-4000, 0);
  assert.equal(distant.isVisible, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/test_site.js`
Expected: FAIL (cannot find module `../site/spatial.js`)

- [ ] **Step 3: Implement `site/spatial.js`**

Create `site/spatial.js` with pure math and coordinate layout implementations:
- `PHI = 1.61803398875`
- `AXIS_PRESETS`: `landscape`, `seasonal`, `ribbon`
- `calculatePhotoCoordinates(photos, options)`
- `calculateDepthShader(photoZ, cameraZ, options)`

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/test_site.js`
Expected: PASS (all tests pass)

- [ ] **Step 5: Commit**

```bash
GIT_CONFIG_GLOBAL=/dev/null git add site/spatial.js tests/test_site.js
GIT_CONFIG_GLOBAL=/dev/null git commit -m "feat: implement 3D spatial coordinate engine and depth shader math"
```

---

### Task 2: Segregated Admin Portal (`site/admin/index.html`, `site/admin/admin.js`, `site/admin/admin.css`)

**Files:**
- Create: `site/admin/index.html`
- Create: `site/admin/admin.js`
- Create: `site/admin/admin.css`
- Modify: `scripts/dev-server.py:80-120`
- Test: `tests/test_site.js`

**Interfaces:**
- Produces:
  - `site/admin/index.html`: standalone HTML document with admin dashboard, upload dropzone, metadata edit form, collection manager, and login/logout UI.
  - `site/admin/admin.js`: manages Cognito PKCE redirect, mock dev auth (`/api/dev/auth`), photo upload via presigned S3 URLs, metadata editing, AI tags, and tag/collection updates.
  - `dev-server.py`: maps `/admin` and `/admin/` to `site/admin/index.html`.

- [ ] **Step 1: Write integration tests in `tests/test_site.js`**

Add tests to `tests/test_site.js` verifying the existence of `site/admin/index.html`, `site/admin/admin.js`, and `site/admin/admin.css`, and checking that the admin index contains the required admin components:
```javascript
test("Admin Segregation: files exist and contain complete admin interface", () => {
  const adminHtml = fs.readFileSync(new URL("../site/admin/index.html", import.meta.url), "utf8");
  const adminJs = fs.readFileSync(new URL("../site/admin/admin.js", import.meta.url), "utf8");
  const adminCss = fs.readFileSync(new URL("../site/admin/admin.css", import.meta.url), "utf8");

  assert.ok(adminHtml.includes('id="auth-nav"'));
  assert.ok(adminHtml.includes('id="upload-modal"'));
  assert.ok(adminHtml.includes('id="meta-modal"'));
  assert.ok(adminHtml.includes('id="collection-modal"'));
  assert.ok(adminJs.includes("startLogin"));
  assert.ok(adminJs.includes("handleAuthRedirect"));
  assert.ok(adminCss.length > 100);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/test_site.js`
Expected: FAIL (files do not exist yet)

- [ ] **Step 3: Implement `site/admin/index.html`, `site/admin/admin.js`, and `site/admin/admin.css`**

Extract and encapsulate all administration capabilities from `site/index.html` and `site/app.js`:
- Cognito Authorization Code + PKCE (`pkcePair`, `startLogin`, `logout`, `exchangeCode`, `handleAuthRedirect`).
- Dev auth fallback (`/api/dev/auth`).
- Photo upload manager with drag-and-drop overlay and presigned S3 upload logic (`uploadFiles`, `requestPresignedUpload`, direct binary PUT).
- Photo metadata modal (`#meta-modal`) with description textarea, tags input, AI suggestions approval (`#meta-ai-tags-section`), collection dropdown, and GPS location picker.
- Collection creation / editing modal (`#collection-modal`).
- Tag renaming / deletion controls.
- Clean administrative layout and styling in `admin.css`.
- Update `scripts/dev-server.py` to route `/admin` and `/admin/` requests to `site/admin/index.html`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/test_site.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
GIT_CONFIG_GLOBAL=/dev/null git add site/admin/ scripts/dev-server.py tests/test_site.js
GIT_CONFIG_GLOBAL=/dev/null git commit -m "feat: segregate admin UI, auth, and upload workflows into /admin portal"
```

---

### Task 3: Strip Admin Clutter from Visitor App & Prepare 3D Viewport (`site/index.html`, `site/app.js`, `site/styles.css`)

**Files:**
- Modify: `site/index.html`
- Modify: `site/app.js`
- Modify: `site/styles.css`
- Test: `tests/test_site.js`

**Interfaces:**
- Consumes: `site/spatial.js`
- Produces:
  - `site/index.html` without admin modals, drag-and-drop overlays, or auth buttons.
  - Spatial viewport elements: `#spatial-viewport`, `.spatial-world`, `.spatial-hud`.
  - Link in footer / menu pointing to `/admin/` for administrators.

- [ ] **Step 1: Write tests in `tests/test_site.js`**

Add tests ensuring visitor `site/index.html` and `site/app.js` are free of admin clutter:
```javascript
test("Visitor Isolation: index.html has zero admin modals or auth buttons", () => {
  const indexHtml = fs.readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
  assert.equal(indexHtml.includes('id="upload-modal"'), false);
  assert.equal(indexHtml.includes('id="meta-modal"'), false);
  assert.equal(indexHtml.includes('id="collection-modal"'), false);
  assert.equal(indexHtml.includes('id="drag-drop-overlay"'), false);
  assert.ok(indexHtml.includes('id="spatial-viewport"'));
  assert.ok(indexHtml.includes('href="/admin/"') || indexHtml.includes('href="/admin"'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/test_site.js`
Expected: FAIL (index.html still has admin modals)

- [ ] **Step 3: Modify `site/index.html`, `site/app.js`, and `site/styles.css`**

- Remove `#meta-modal`, `#collection-modal`, `#drag-drop-overlay`, `#auth-nav` from `site/index.html`.
- Add `#spatial-viewport` with `.spatial-world` container and `.spatial-hud` to `site/index.html`.
- Add an unobtrusive `/admin/` link in the site menu or footer.
- Remove admin listeners, dropzone handlers, and upload logic from visitor `site/app.js`.
- Add CSS rules in `site/styles.css` for `#spatial-viewport` (`perspective: 1000px`, `overflow: hidden`, full-screen viewport), `.spatial-world` (`transform-style: preserve-3d`), and `.photo-card-3d`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/test_site.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
GIT_CONFIG_GLOBAL=/dev/null git add site/index.html site/app.js site/styles.css tests/test_site.js
GIT_CONFIG_GLOBAL=/dev/null git commit -m "refactor: isolate visitor index.html and initialize 3D spatial viewport"
```

---

### Task 4: Interactive 3D Spatial Scene Controller & Navigation (`site/spatial.js`, `site/styles.css`)

**Files:**
- Modify: `site/spatial.js`
- Modify: `site/styles.css`
- Modify: `site/app.js`
- Test: `tests/test_site.js`

**Interfaces:**
- Produces:
  - `initSpatialScene(container, photos, options)`: mounts 3D landscape nodes, registers mouse wheel, pointer drag, touch pinch, and keyboard listeners.
  - Smooth animation loop applying camera translation/rotation to `.spatial-world`.
  - Frame-by-frame DoF blur and foggy fade shader updates.
  - Dual-tier image delivery (thumbnails for background, full display for foreground).

- [ ] **Step 1: Write unit tests in `tests/test_site.js`**

Add tests for camera state updates and motion damping:
```javascript
import { CameraController } from "../site/spatial.js";

test("Spatial Navigation: CameraController updates position and clamps rotation", () => {
  const camera = new CameraController();
  assert.equal(camera.x, 0);
  assert.equal(camera.y, 0);
  assert.equal(camera.z, 0);

  camera.flyZ(500);
  camera.update(16); // step 16ms
  assert.ok(camera.z !== 0);

  camera.pan(100, -50);
  camera.update(16);
  assert.ok(camera.x !== 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/test_site.js`
Expected: FAIL (`CameraController` not defined)

- [ ] **Step 3: Implement `CameraController` and DOM rendering in `site/spatial.js`**

- Implement `CameraController` with inertia, velocity damping, wheel flying along Z, drag panning on X/Y with subtle pitch/yaw parallax, and keyboard navigation.
- Implement `renderSpatialScene(container, photos, camera, options)`:
  - Renders photo cards with 3D individual transform properties (`translate3d(x, y, z)`).
  - Dynamically updates `filter: blur(...) grayscale(...)` and `opacity` per frame based on distance to camera.
  - Dual-tier image delivery: background photos use `thumb` URL, foreground photos upgrade to display image `url`.
  - Frustum culling: hides cards beyond horizon distance.
- Export `CameraController` and `initSpatialScene`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/test_site.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
GIT_CONFIG_GLOBAL=/dev/null git add site/spatial.js site/styles.css site/app.js tests/test_site.js
GIT_CONFIG_GLOBAL=/dev/null git commit -m "feat: implement 3D camera controller, physics damping, and dynamic DoF rendering"
```

---

### Task 5: Full-Screen Inspection & Bottom-Left Legend (`site/spatial.js`, `site/styles.css`)

**Files:**
- Modify: `site/spatial.js`
- Modify: `site/styles.css`
- Modify: `site/app.js`
- Test: `tests/test_site.js`

**Interfaces:**
- Produces:
  - Clicking any 3D photo card smoothly brings it to front.
  - Background landscape blurs (`backdrop-filter: blur(16px)`).
  - High-res image loaded with `fetchpriority="high"`.
  - Legend and metadata panel displayed at **bottom-left**: formatted date, description with `#hashtags`, collection chip, GPS coords/link, favorite toggle (<kbd>F</kbd>).
  - Dismissal via <kbd>Esc</kbd>, close button, or backdrop click.

- [ ] **Step 1: Write tests in `tests/test_site.js`**

```javascript
test("Spatial Inspection: generates legend metadata with hashtags and bottom-left layout", () => {
  const photo = {
    id: "p_test",
    description: "Alpine sunset over the ridge #mountains #sunset",
    createdAt: 1710000000,
    tags: ["nature", "mountains", "sunset"],
    collectionId: "c_alps",
    latitude: 46.5,
    longitude: 8.2,
  };
  const { createPhotoLegendHtml } = await import("../site/spatial.js");
  const html = createPhotoLegendHtml(photo);
  assert.ok(html.includes("Alpine sunset over the ridge"));
  assert.ok(html.includes("#mountains"));
  assert.ok(html.includes("c_alps") || html.includes("Collection"));
  assert.ok(html.includes("46.5"));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/test_site.js`
Expected: FAIL (`createPhotoLegendHtml` not defined)

- [ ] **Step 3: Implement full-screen inspection & bottom-left legend in `site/spatial.js` and `site/styles.css`**

- Implement `createPhotoLegendHtml(photo)`: formats date, parses `#hashtags`, links tags, adds location pin and collection badge.
- Implement `inspectPhoto(photo, index)`:
  - Animates photo card to center viewport ($Z \approx 400\text{px}$ in front of camera or centered modal overlay).
  - Applies blurred mask over the 3D scene.
  - Attaches bottom-left legend with favorite button.
  - Wire keyboard shortcuts (<kbd>Esc</kbd> to close, <kbd>F</kbd> to favorite, <kbd>[</kbd>/<kbd>]</kbd> to navigate to adjacent photo).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/test_site.js`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
GIT_CONFIG_GLOBAL=/dev/null git add site/spatial.js site/styles.css site/app.js tests/test_site.js
GIT_CONFIG_GLOBAL=/dev/null git commit -m "feat: implement full-screen photo inspection and bottom-left metadata legend"
```

---

### Task 6: Spatial HUD Controls, Multi-Device Responsive Support & Final Verification

**Files:**
- Modify: `site/spatial.js`
- Modify: `site/styles.css`
- Modify: `site/app.js`
- Test: `tests/test_site.js`

**Interfaces:**
- Produces:
  - Floating glassmorphic HUD on 3D view with:
    - Axis preset switcher (Landscape Valley, Seasonal Arch, Linear Ribbon).
    - Golden ratio coarseness adjustment.
    - Camera reset button.
    - View toggle between 3D Landscape and classic views (Tags, Collections, Map, Search, Favorites).
  - Touch gesture handling (1-finger pan, 2-finger pinch) for mobile devices.
  - Responsive layout scaling across mobile, tablet, and wide desktop.

- [ ] **Step 1: Write integration tests in `tests/test_site.js`**

Add tests checking HUD options, axis switching math, and mobile touch handlers:
```javascript
test("Spatial HUD: supports switching axis presets dynamically", () => {
  const photos = [{ id: "p1", createdAt: 1710000000 }, { id: "p2", createdAt: 1700000000 }];
  const valley = calculatePhotoCoordinates(photos, { preset: "landscape" });
  const arch = calculatePhotoCoordinates(photos, { preset: "seasonal" });
  const ribbon = calculatePhotoCoordinates(photos, { preset: "ribbon" });

  assert.notDeepEqual(valley[1], arch[1]);
  assert.notDeepEqual(valley[1], ribbon[1]);
});
```

- [ ] **Step 2: Run test to verify it passes or fails**

Run: `node --test tests/test_site.js`

- [ ] **Step 3: Implement HUD UI and responsive touches in `site/spatial.js`, `site/styles.css`, and `site/app.js`**

- Wire the HUD controls overlay.
- Add touch event listeners (`touchstart`, `touchmove`, `touchend`) with multi-touch distance calculation for smooth pinch-to-fly on mobile.
- Add responsive media queries in `site/styles.css` ensuring legend, HUD, and frame borders adapt gracefully from 320px mobile screens to 4K displays.
- Integrate the 3D scene as default home route (`#/`) in `site/app.js`.

- [ ] **Step 4: Run full test suite**

Run: `node --test tests/test_site.js` and `/usr/bin/python3 tests/test_api_handler.py`
Expected: ALL TESTS PASS (100% green)

- [ ] **Step 5: Commit**

```bash
GIT_CONFIG_GLOBAL=/dev/null git add site/ tests/test_site.js
GIT_CONFIG_GLOBAL=/dev/null git commit -m "feat: complete 3D spatial gallery HUD, touch controls, and responsive styling"
```
