# 3D Spatial Gallery & Admin Segregation Design Specification

- **Date:** 2026-10-11
- **Status:** Approved
- **Target Platform:** ordinary.click (Vanilla ES6+ JS, S3 + CloudFront, Python 3.14 Lambda)

## 1. Executive Summary

This specification defines the transformation of the `ordinary.click` frontend:
1. **Visitor 3D Spatial Experience:** A full-screen 3D landscape of photos ordered chronologically, starting with the latest photo prominently framed in the foreground ($Z=0$), receding into depth with realistic Depth of Field (DoF) blur and atmospheric gray fog.
2. **Golden Ratio Spacing & Configurable Axes:** Grouping coarseness expands by powers of the golden ratio ($\phi \approx 1.618$), mapping Day granularity to $X$, Month to $Y$, and Year/Timeline to $Z$. Visitors can adjust grouping and axis mappings on the fly via a sleek HUD.
3. **Interactive Navigation & Full-Screen Inspection:** First-person mouse wheel / touch pinch / keyboard navigation along the spatial timeline. Clicking any photo brings it to front in full-screen with a blurred background and photo legend/metadata at the bottom left.
4. **Segregated `/admin` Portal:** All admin authentication (Cognito PKCE / dev auth), upload dropzones, photo editing modals, AI tags, and collection/tag management are isolated under `/admin/` in dedicated files (`site/admin/index.html`, `admin.js`, `admin.css`), keeping the visitor app lightweight, secure, and clean.

---

## 2. Architecture & File Structure

```
site/
├── index.html              # Clean visitor landing page (3D viewport + HUD + classic views)
├── spatial.js              # 3D spatial math, coordinate layout, camera navigation, DoF/fog shaders
├── app.js                  # Visitor SPA router, catalog loader, theme management, lightbox/inspector
├── styles.css              # Core styling, 3D viewport styles, HUD glassmorphism, responsive styles
├── favorites.js            # Favorites persistence & helpers
├── search.js               # Client search engine
├── sorter.js               # Chronological sorting & visual ordering helpers
├── flags.js                # Feature flags
├── plugins.js              # Theme and layout registries
└── admin/
    ├── index.html          # Segregated admin portal (auth, upload, photo/tag management)
    ├── admin.js            # Admin controller (Cognito PKCE, dev auth, upload dropzone, modals)
    └── admin.css           # Admin styling
```

### 2.1 CloudFront & Local Dev Server Alignment
- **Production:** CloudFront routes `/admin/` to `site/admin/index.html` in the S3 site bucket.
- **Local Dev Server (`scripts/dev-server.py`):** Serves `site/admin/index.html` on `http://localhost:8000/admin` and `http://localhost:8000/admin/`.

---

## 3. 3D Spatial Landscape Math & Layout

### 3.1 Golden Ratio & Axis Mapping
The golden ratio $\phi = \frac{1 + \sqrt{5}}{2} \approx 1.61803398875$.

Photos are sorted chronologically descending:
$$P_0, P_1, P_2, \dots, P_{N-1}$$
where $P_0$ is the latest photo (timestamp $T_0$).

For photo $P_i$ with timestamp $T_i$ ($T_i \le T_0$):
- Time delta: $\Delta t_i = T_0 - T_i \ge 0$ (measured in days: $\Delta d_i = \Delta t_i / 86400$).
- Closer times have shorter $\Delta Z$:
  $$Z_i = - (\Delta d_i)^{0.75} \times S_z \times \phi^2$$
  (where $S_z$ is the base Z-spacing parameter). This non-linear golden progression keeps recent photos intimate while allowing deep history to remain visible in the atmospheric landscape.

#### Default Axis Mapping ("Landscape Valley")
- **X-axis (Day Granularity, base scale $1.0$):**
  $$X_i = ((d_i \pmod{31}) - 15.5) \times S_x \times 1.0$$
  Day of month horizontally scatters photos across the landscape ribbon.
- **Y-axis (Month Granularity, scale $\phi^1 \approx 1.618$):**
  $$Y_i = (\sin(m_i \times \frac{\pi}{6}) \times 0.6 + ((m_i \pmod{12}) - 6) \times 0.4) \times S_y \times \phi$$
  Seasonal/monthly oscillations create natural topographical terraces.
- **Z-axis (Year & Timeline, scale $\phi^2 \approx 2.618$):**
  $$Z_i = -(\text{year}(T_0) - \text{year}(T_i) + \text{fractionalYear}_i) \times S_z \times \phi^2$$

#### Configurable Presets (Switchable in HUD)
1. **Landscape Valley (Default):** X = Day, Y = Month, Z = Year/Timeline.
2. **Seasonal Arch:** X = Month, Y = Day, Z = Year/Timeline.
3. **Linear Sinuous Ribbon:** Undulating ribbon flowing across $X/Y$ into $-Z$.
4. **Golden Multiplier:** Adjusts coarseness scaling exponent ($1.0 \times \dots 2.5 \times$).

### 3.2 Visual Shaders: Depth of Field (DoF) & Foggy Fade
Calculated per frame based on relative distance from camera $D_i = -(Z_i - Z_{\text{cam}})$:

| Depth Region | Distance $D_i$ | DoF Blur | Fog Grayscale | Opacity | Image Source |
|---|---|---|---|---|---|
| **Foreground / Focal** | $D_i \approx 0$ | `0px` | `0%` | `1.0` | `/images/<id>.jpg` (high-res) |
| **Near Midground** | $0 < D_i \le 600$ | `1px - 3px` | `10% - 35%` | `0.95` | `/thumbs/<id>.jpg` |
| **Distant Landscape** | $600 < D_i \le 2000$ | `4px - 10px` | `40% - 85%` | `0.75 - 0.4` | `/thumbs/<id>.jpg` |
| **Atmospheric Horizon** | $D_i > 2000$ | `12px - 16px` | `100%` | `0.2 - 0.0` | `/thumbs/<id>.jpg` |
| **Beyond Max Horizon** | $D_i > 3500$ | Culled | Culled | `0` (`display: none`) | None |

---

## 4. Navigation & Inspection Controls

### 4.1 Mouse & Pointer Controls
- **Drag / Pan:** Rotates camera pitch/yaw slightly ($\pm 15^\circ$) and translates $X, Y$ with inertial dampening.
- **Wheel:** Flies camera along the $Z$ axis (smooth travel forward and backward through time).

### 4.2 Keyboard Navigation
- <kbd>W</kbd> / <kbd>↑</kbd>: Fly forward into the landscape.
- <kbd>S</kbd> / <kbd>↓</kbd>: Fly backward towards recent photos.
- <kbd>A</kbd> / <kbd>←</kbd> and <kbd>D</kbd> / <kbd>→</kbd>: Pan left and right.
- <kbd>[</kbd> / <kbd>]</kbd>: Step camera frame-to-frame to adjacent chronological photo.
- <kbd>Home</kbd> / <kbd>0</kbd>: Reset camera to front framing the latest photo.
- <kbd>Space</kbd> / <kbd>Enter</kbd>: Inspect current focused photo.
- <kbd>Esc</kbd>: Exit full-screen focus back to landscape.

### 4.3 Mobile & Touch Gestures
- **1-finger Drag:** Pan across $X, Y$.
- **2-finger Pinch:** Zoom / fly along $Z$.
- **Tap:** Focus and inspect photo.

### 4.4 Full-Screen Inspection & Legend
- **Action:** Clicking any photo card brings it to the center front.
- **Backdrop:** Background landscape dims and blurs (`backdrop-filter: blur(16px)`).
- **Asset Swap:** Promotes image from thumbnail to `/images/<id>.jpg`.
- **Legend (Bottom-Left Corner):**
  - Captured date & time.
  - Description with clickable `#hashtags`.
  - Collection name chip.
  - GPS coordinates / location link.
  - Resolution and format badges.
  - Favorite toggle (<kbd>F</kbd>).

---

## 5. Administrative Segregation (`/admin`)

### 5.1 Clean Separation
- Visitor files (`site/index.html`, `site/app.js`) have **no admin code**:
  - No Cognito PKCE verifier generation or callback handling.
  - No upload drag-and-drop listener on window.
  - No metadata edit modals or AI suggestion buttons in the visitor DOM.
- Admin files (`site/admin/index.html`, `site/admin/admin.js`, `site/admin/admin.css`):
  - Self-contained login button and Cognito redirect handler.
  - Mock dev auth support (`/api/dev/auth`).
  - Drag-and-drop upload zone with presigned S3 upload engine.
  - Metadata editor modal (description, hashtags, tags, collection selector, GPS location picker, Rekognition AI tags).
  - Tag and collection CRUD management.

---

## 6. Testing & Quality Assurance

1. **Spatial Math Unit Tests (`tests/test_site.js`):**
   - Chronological coordinate calculation & distance delta Z.
   - Golden ratio scaling across $X, Y, Z$.
   - Depth of field blur & fog grayscale clamping equations.
   - Frustum culling logic.
   - Axis preset transformations.
2. **Admin Segregation Parity Tests:**
   - Confirm visitor `index.html` contains no admin elements.
   - Confirm `site/admin/index.html` contains admin auth and upload elements.
   - Test router redirection and navigation between `/` and `/admin`.
3. **End-to-End Suite:** Run `node --test tests/test_site.js` and `python3 tests/test_api_handler.py`.
