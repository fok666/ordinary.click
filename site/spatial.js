// ordinary.click — 3D Spatial Gallery Engine
//
// Implements 3D chronological landscape coordinates, golden ratio axis scaling,
// Depth-of-Field (DoF) blur, atmospheric fog shaders, camera controller, and
// first-person navigation. Pure vanilla ES6+, zero external dependencies.

export const PHI = 1.61803398875;

export const AXIS_PRESETS = {
  landscape: {
    name: "Landscape Valley",
    desc: "X: Day, Y: Month, Z: Year/Timeline (Default)",
  },
  seasonal: {
    name: "Seasonal Arch",
    desc: "X: Month, Y: Day, Z: Year/Timeline",
  },
  ribbon: {
    name: "Linear Sinuous Ribbon",
    desc: "Undulating chronological ribbon",
  },
};

export function clamp(val, min, max) {
  return Math.max(min, Math.min(max, val));
}

function esc(str) {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export const DEPTH_COMPRESSION = 0.6;
export const PERSPECTIVE_PX = 1000;

/**
 * Fan displacement: cards whose projected screen position is near the pointer (mouse or finger)
 * spread radially away from it and lift toward the camera, so cards behind others can be reached.
 * A card directly under the pointer does not flee laterally (it stays clickable) but comes forward.
 *
 * @param {{x:number,y:number,z:number}} coord
 * @param {{x:number,y:number,z:number}} cam
 * @param {{x:number,y:number}|null} pointer - px offset from viewport center
 * @returns {{dx:number, dy:number, dz:number}} world-space offsets
 */
export function calculateFanDisplacement(coord, cam, pointer, viewport = {}, options = {}) {
  const zero = { dx: 0, dy: 0, dz: 0 };
  if (!coord || !cam || !pointer) return zero;
  const radius = options.radius || 260;
  const strength = options.strength || 190;
  const lift = options.lift || 160;

  const depth = cam.z - coord.z;
  if (depth <= -PERSPECTIVE_PX * 0.5) return zero;
  const scale = PERSPECTIVE_PX / (PERSPECTIVE_PX + Math.max(depth, -PERSPECTIVE_PX * 0.5));
  const sx = (coord.x - cam.x) * scale;
  const sy = (coord.y - cam.y) * scale;
  const vx = sx - pointer.x;
  const vy = sy - pointer.y;
  const dist = Math.hypot(vx, vy);
  if (dist >= radius) return zero;

  const t = dist / radius; // 0 under pointer .. 1 at edge
  const dz = Math.round(lift * (1 - t) * (1 - t));
  if (dist < 1) return { dx: 0, dy: 0, dz };

  const push = strength * Math.sin(Math.PI * t) / scale; // screen px -> world units
  const capped = Math.min(push, 700);
  return {
    dx: Math.round((vx / dist) * capped),
    dy: Math.round((vy / dist) * capped),
    dz,
  };
}

/**
 * Maps photos to 3D spatial coordinates based on timestamps and golden ratio scaling.
 * 
 * @param {Array<Object>} photos - List of photo items (must have createdAt or updatedAt)
 * @param {Object} [options]
 * @param {string} [options.preset="landscape"] - "landscape", "seasonal", or "ribbon"
 * @param {number} [options.goldenMultiplier=1.0] - multiplier for golden ratio coarseness
 * @param {number} [options.spacingX=120] - base X spacing
 * @param {number} [options.spacingY=80] - base Y spacing
 * @param {number} [options.spacingZ=100] - base Z spacing
 * @returns {Array<Object>} Photos with x, y, z coordinates
 */
export function calculatePhotoCoordinates(photos, options = {}) {
  if (!Array.isArray(photos) || photos.length === 0) return [];

  const preset = options.preset || "landscape";
  const goldenMultiplier = options.goldenMultiplier || 1.0;
  const sx = options.spacingX || 120;
  const sy = options.spacingY || 80;
  const sz = options.spacingZ || 100;

  // Golden ratio progression scales: 1.0 for X, PHI for Y, PHI^2 for Z
  const scaleX = 1.0;
  const scaleY = PHI * goldenMultiplier;
  const scaleZ = Math.pow(PHI, 2) * goldenMultiplier;

  // Sort chronologically descending (latest photo first)
  const sorted = [...photos].sort((a, b) => {
    const ta = Number(a.createdAt || a.updatedAt || 0);
    const tb = Number(b.createdAt || b.updatedAt || 0);
    return tb - ta;
  });

  const latestTime = Number(sorted[0].createdAt || sorted[0].updatedAt || 0) || Math.floor(Date.now() / 1000);

  return sorted.map((photo, index) => {
    if (index === 0) {
      // Latest photo is placed squarely at the foreground focal plane (0, 0, 0)
      return {
        ...photo,
        x: 0,
        y: 0,
        z: 0,
        index: 0,
      };
    }

    const t = Number(photo.createdAt || photo.updatedAt || 0) || (latestTime - index * 86400);
    const date = new Date(t * 1000);
    const day = date.getUTCDate(); // 1..31
    const month = date.getUTCMonth(); // 0..11
    const deltaDays = Math.max(0, (latestTime - t) / 86400);

    // Closer times have shorter delta-Z: power scale (deltaDays)^0.75
    // so recent days cluster nicely while deeper history recedes gracefully
    // DEPTH_COMPRESSION pulls the back of the timeline closer so deep photos are easier to reach
    const zDepth = -(Math.pow(deltaDays, 0.75) * sz * scaleZ * 0.15 + (index * sz * 0.25)) * DEPTH_COMPRESSION;

    let x = 0;
    let y = 0;

    if (preset === "seasonal") {
      // X = Month, Y = Day, Z = Year/Timeline
      const monthOffset = (month - 5.5) / 5.5; // -1 to 1
      x = monthOffset * sx * 4.5 * scaleX;
      const dayWave = Math.sin((day / 31) * Math.PI * 2);
      y = (dayWave * 0.7 + ((day - 15.5) / 15.5) * 0.3) * sy * scaleY;
    } else if (preset === "ribbon") {
      // Sinuous ribbon undulating across X/Y receding into Z
      const angle = index * 0.45;
      x = Math.sin(angle) * sx * 2.8 * scaleX;
      y = Math.cos(angle * 0.7) * sy * 1.8 * scaleY;
    } else {
      // Default: Landscape Valley (Wide 3D Amphitheater Valley)
      // Alternating bilateral flanks with golden ratio progression across valley floor
      const dayOffset = (day - 16) / 15;
      const side = (index % 2 === 0 ? 1 : -1);
      // Lateral flank offset: alternating left and right flanks with golden spiral variation
      const flankDistance = (0.55 + 0.45 * Math.sin(index * 0.75)) * sx * 3.2;
      x = (side * flankDistance + dayOffset * sx * 1.5) * scaleX;

      // Amphitheater bowl curvature: photos higher on the valley ridges
      const bowlHeight = Math.min(100, Math.pow(x / (sx * 2.5), 2) * 18);
      const terraceTier = ((index % 3) - 1) * sy * 0.45;
      const monthWave = Math.sin((month / 12) * Math.PI * 2);
      y = (-bowlHeight + monthWave * sy * 0.6 + terraceTier) * scaleY;
    }

    return {
      ...photo,
      x: Math.round(x),
      y: Math.round(y),
      z: Math.round(zDepth),
      index,
    };
  });
}

/**
 * Calculates Depth-of-Field (DoF) blur, foggy grayscale fade, opacity, and image tier.
 * 
 * @param {number} photoZ - photo position on Z axis (typically <= 0)
 * @param {number} cameraZ - camera position on Z axis
 * @param {Object} [options]
 * @returns {{ blur: number, grayscale: number, opacity: number, isVisible: boolean, tier: "display"|"thumb" }}
 */
export function calculateDepthShader(photoZ, cameraZ, options = {}) {
  // depth: positive means photo is in front of camera (into depth),
  // 0 means photo is right at the camera focal plane,
  // negative means photo has passed behind the camera
  const depth = cameraZ - photoZ;
  const maxHorizon = options.maxHorizon || 3500;
  const focalRange = options.focalRange || 300;
  const exitHold = options.exitHold !== undefined ? options.exitHold : 60;
  const exitRange = options.exitRange || 520;

  // If photo is far behind camera or beyond max horizon
  if (depth < -exitRange || depth > maxHorizon) {
    return {
      blur: 16,
      grayscale: 100,
      opacity: 0,
      isVisible: false,
      tier: "thumb",
      depth,
      exitProgress: depth < 0 ? 1 : 0,
    };
  }

  // Photo is behind camera focal plane (-exitRange <= depth < 0):
  // Gracefully hold in focal center for exitHold window, then smoothly disperse outward
  if (depth < 0) {
    const absDepth = -depth;
    if (absDepth <= exitHold) {
      // Focal hold window: stay centered, fully visible, zero blur
      return {
        blur: 0,
        grayscale: 0,
        opacity: 1.0,
        isVisible: true,
        tier: "display",
        depth,
        exitProgress: 0,
      };
    }

    const activeExitDist = absDepth - exitHold;
    const activeSpan = exitRange - exitHold;
    const exitProgress = clamp(activeExitDist / activeSpan, 0, 1);
    const fade = 1 - exitProgress;

    return {
      blur: Math.round(exitProgress * 5 * 10) / 10,
      grayscale: Math.round(exitProgress * 35),
      opacity: Math.round(clamp(0.15 + fade * 0.85, 0, 1) * 100) / 100,
      isVisible: exitProgress < 1,
      tier: "display",
      depth,
      exitProgress,
    };
  }

  // Foreground / Focal plane (0 <= depth <= focalRange)
  if (depth <= focalRange) {
    const factor = depth / focalRange;
    return {
      blur: Math.round(factor * 1.5 * 10) / 10,
      grayscale: Math.round(factor * 15),
      opacity: 1.0,
      isVisible: true,
      tier: "display",
      depth,
      exitProgress: 0,
    };
  }

  // Receding into background: increasingly out of focus (DoF) and increasingly gray (fog)
  const recedeDist = depth - focalRange;
  const normalizedDepth = clamp(recedeDist / (maxHorizon - focalRange), 0, 1);

  // Optical DoF blur: 1.5px up to 16px
  const blur = Math.round((1.5 + Math.pow(normalizedDepth, 0.8) * 14.5) * 10) / 10;

  // Foggy fade: grayscale from 15% to 100%
  const grayscale = Math.round(15 + Math.pow(normalizedDepth, 1.1) * 85);

  // Opacity fade into ambient fog: 1.0 down to 0.15
  const opacity = Math.round((1.0 - Math.pow(normalizedDepth, 1.2) * 0.85) * 100) / 100;

  return {
    blur,
    grayscale,
    opacity,
    isVisible: true,
    tier: "thumb",
    depth,
    exitProgress: 0,
  };
}

/**
 * Calculates outward lateral and angular displacement for foreground frames exiting view.
 * As frames pass behind the focal plane (depth < 0), this moves them toward the edges of the viewport
 * to clear the line of sight for incoming frames.
 * 
 * @param {Object} coord - Photo coordinate object with x, y, z, index
 * @param {number} exitProgress - Value from 0 (at focal plane) to 1 (fully exited)
 * @param {Object} [viewport] - Optional viewport dimensions { width, height }
 * @returns {{ offsetX: number, offsetY: number, rotateY: number, rotateZ: number }}
 */
export function calculateExitDisplacement(coord, exitProgress, viewport = {}) {
  if (!coord || !exitProgress || exitProgress <= 0) {
    return { offsetX: 0, offsetY: 0, rotateY: 0, rotateZ: 0 };
  }

  const p = clamp(exitProgress, 0, 1);
  // Ease-out cubic: frames leave the focal center quickly so they never block what is coming into focus
  const ease = 1 - Math.pow(1 - p, 3);

  const vpWidth = (viewport && viewport.width) || 1200;
  const vpHeight = (viewport && viewport.height) || 800;
  const idx = Number(coord.index) || 0;

  // Symmetrical bilateral distribution:
  // Alternate strictly left/right based on photo index (even -> right, odd -> left).
  // Guarantees 50% left, 50% right regardless of photo coordinate X!
  const side = idx % 2 === 0 ? 1 : -1;

  // Symmetrical vertical quadrant drift:
  // Alternate upward drift vs downward drift (4-quadrant dispersal)
  const vertSide = (idx % 4 === 0 || idx % 4 === 1) ? -1 : 1;

  // Distance needed to clear the central viewport: half viewport + a card's width of margin.
  // Scales with screen size, with a floor so small screens still fully clear the center.
  const edgeDistX = Math.max(470, vpWidth * 0.5 + 200);
  const offsetX = Math.round(side * edgeDistX * ease);

  // Subtle natural arc: vertical drift (scaled to viewport height) and card rotation
  const offsetY = Math.round(vertSide * Math.max(65, vpHeight * 0.12) * ease);
  const rotateY = Math.round(side * -22 * ease);
  const rotateZ = Math.round(side * 12 * ease);

  return { offsetX, offsetY, rotateY, rotateZ };
}

/**
 * 3D Virtual Camera Controller with inertial velocity damping and limits.
 */
export class CameraController {
  constructor(options = {}) {
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.targetX = 0;
    this.targetY = 0;
    this.targetZ = 0;
    this.pitch = 0;
    this.yaw = 0;
    this.targetPitch = 0;
    this.targetYaw = 0;
    this.damping = 0.12;
    this.minZ = options.minZ !== undefined ? options.minZ : -50000;
    this.maxZ = options.maxZ !== undefined ? options.maxZ : 400;
  }

  setBounds(minZ, maxZ) {
    this.minZ = minZ;
    this.maxZ = maxZ;
    this.targetZ = clamp(this.targetZ, this.minZ, this.maxZ);
  }

  flyZ(delta) {
    this.targetZ += delta;
    this.targetZ = clamp(this.targetZ, this.minZ, this.maxZ);
  }

  pan(dx, dy) {
    this.targetX -= dx;
    this.targetY -= dy;
    this.targetX = clamp(this.targetX, -4000, 4000);
    this.targetY = clamp(this.targetY, -3000, 3000);

    // Subtle pitch/yaw parallax tilt
    this.targetPitch = clamp(-dy * 0.08, -12, 12);
    this.targetYaw = clamp(dx * 0.08, -15, 15);
  }

  reset() {
    this.targetX = 0;
    this.targetY = 0;
    this.targetZ = 0;
    this.targetPitch = 0;
    this.targetYaw = 0;
  }

  focusPhoto(coord) {
    if (!coord) return;
    this.targetX = coord.x;
    this.targetY = coord.y;
    this.targetZ = clamp(coord.z, this.minZ, this.maxZ);
    this.targetPitch = 0;
    this.targetYaw = 0;
  }

  update(dt = 16) {
    const factor = Math.min(1.0, this.damping * (dt / 16));
    this.x += (this.targetX - this.x) * factor;
    this.y += (this.targetY - this.y) * factor;
    this.z += (this.targetZ - this.z) * factor;
    this.pitch += (this.targetPitch - this.pitch) * factor;
    this.yaw += (this.targetYaw - this.yaw) * factor;

    this.targetPitch *= 0.95;
    this.targetYaw *= 0.95;
  }
}

/**
 * Creates bottom-left HTML legend for a photo card with formatted date, hashtags, collection & location.
 */
export function createPhotoLegendHtml(photo) {
  if (!photo) return "";
  const dateStr = photo.createdAt
    ? new Date(photo.createdAt * 1000).toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "";

  const desc = esc(photo.description || "");
  const formattedDesc = desc.replace(
    /(^|\s)#([a-zA-Z0-9_\u0080-\uFFFF]+)/g,
    `$1<a href="#/t/$2" class="hashtag-link">#$2</a>`
  );

  const tags = (photo.tags || photo.categories || []).map(
    (t) => `<a href="#/t/${encodeURIComponent(t)}" class="chip">#${esc(t)}</a>`
  ).join(" ");

  const collectionBadge = photo.collectionId
    ? `<a href="#/collection/${encodeURIComponent(photo.collectionId)}" class="chip collection-chip">📁 Collection</a>`
    : "";

  const geoBadge = photo.latitude != null && photo.longitude != null
    ? `<span class="lb-geo">📍 <a href="#/near/${photo.latitude},${photo.longitude},5">${photo.latitude.toFixed(2)}, ${photo.longitude.toFixed(2)}</a></span>`
    : "";

  const resBadge = photo.width && photo.height
    ? `<span class="res-badge" style="font-size:0.75rem; color:var(--muted);">${photo.width}×${photo.height}</span>`
    : "";

  return `
    <div class="legend-content">
      <div class="legend-header" style="display:flex; justify-content:space-between; align-items:center; margin-bottom:0.4rem; font-size:0.8rem; color:#bbb;">
        <span class="legend-date">📅 ${dateStr}</span>
        <div style="display:flex; gap:0.5rem; align-items:center;">
          ${geoBadge}
          ${resBadge}
        </div>
      </div>
      ${formattedDesc ? `<div class="lb-desc" style="margin-bottom:0.6rem; color:#fff;">${formattedDesc}</div>` : ""}
      <div class="lb-row" style="display:flex; flex-wrap:wrap; gap:0.35rem;">
        ${collectionBadge}
        ${tags}
      </div>
    </div>
  `;
}

/**
 * Initializes and mounts the interactive 3D spatial scene.
 * 
 * @param {HTMLElement} viewport - #spatial-viewport element
 * @param {Array<Object>} rawPhotos - Photos from catalog
 * @param {Object} [options] - Configuration options
 * @param {Function} [onSelectPhoto] - Callback when photo is clicked
 * @returns {Function} Cleanup function
 */
export function initSpatialScene(viewport, rawPhotos, options = {}, onSelectPhoto = null) {
  if (!viewport || !Array.isArray(rawPhotos) || rawPhotos.length === 0) {
    return () => {};
  }

  const world = viewport.querySelector(".spatial-world") || viewport;
  const camera = new CameraController();
  let currentPreset = options.preset || "landscape";
  let currentGoldenMultiplier = options.goldenMultiplier || 1.0;

  let photoCoords = calculatePhotoCoordinates(rawPhotos, {
    preset: currentPreset,
    goldenMultiplier: currentGoldenMultiplier,
  });

  // Calculate dynamic camera bounds based on chronological timeline depth
  const deepestZ = photoCoords.length > 0 ? photoCoords[photoCoords.length - 1].z : -5000;
  camera.setBounds(Math.min(-5000, deepestZ - 800), 350);

  // Pointer (mouse hover or finger) position relative to viewport center; null when idle
  let fanPointer = null;
  const setFanPointer = (clientX, clientY) => {
    const rect = viewport.getBoundingClientRect ? viewport.getBoundingClientRect() : { left: 0, top: 0, width: 1200, height: 800 };
    fanPointer = {
      x: clientX - (rect.left + (rect.width || 1200) / 2),
      y: clientY - (rect.top + (rect.height || 800) / 2),
    };
  };

  // Drag detection state (to separate camera panning from clicking a photo)
  let isPointerDown = false;
  let hasDragged = false;
  let dragResetTimer = null;
  let startX = 0;
  let startY = 0;
  let totalDragDist = 0;
  const DRAG_THRESHOLD = 5; // Pixels of movement required before panning starts

  // Active photo tracking & navigation helpers
  let activeIndex = 0;
  let lastReportedIdx = -1;

  function findClosestIndex() {
    let closestIdx = 0;
    let minAbsDepth = Infinity;
    for (let i = 0; i < photoCoords.length; i++) {
      const d = Math.abs(camera.z - photoCoords[i].z);
      if (d < minAbsDepth) {
        minAbsDepth = d;
        closestIdx = i;
      }
    }
    return closestIdx;
  }

  function updateCounter() {
    const idx = findClosestIndex();
    if (idx === lastReportedIdx) return;
    lastReportedIdx = idx;

    if (counterEl && photoCoords.length > 0) {
      counterEl.textContent = `${idx + 1} / ${photoCoords.length}`;
    }
    if (btnPrevPhoto) {
      btnPrevPhoto.disabled = idx === 0;
    }
    if (btnNextPhoto) {
      btnNextPhoto.disabled = idx >= photoCoords.length - 1;
    }

    // Update focused frame styling and accessible tooltips on cards
    cardElements.forEach((item, i) => {
      if (i === idx) {
        item.el.classList.add("photo-frame-focused");
        item.el.title = "Click or double-click to view in fullscreen lightbox";
      } else {
        item.el.classList.remove("photo-frame-focused");
        item.el.title = "Click to bring to foreground";
      }
    });
  }

  function jumpToPhoto(delta) {
    const currentIdx = findClosestIndex();
    const nextIdx = clamp(currentIdx + delta, 0, photoCoords.length - 1);
    jumpToIndex(nextIdx);
  }

  function jumpToIndex(idx) {
    if (idx >= 0 && idx < photoCoords.length) {
      activeIndex = idx;
      camera.focusPhoto(photoCoords[activeIndex]);
      updateCounter();
    }
  }

  // Render cards
  world.innerHTML = "";
  const cardElements = photoCoords.map((coord, i) => {
    const card = document.createElement("div");
    card.className = `photo-card-3d ${i === 0 ? "photo-frame-latest" : ""}`;
    card.dataset.id = coord.id;
    card.dataset.index = String(i);
    card.title = i === 0 ? "Click to view in fullscreen lightbox" : "Click to bring to foreground";

    // Initial position
    card.style.transform = `translate3d(${coord.x}px, ${coord.y}px, ${coord.z}px)`;

    const img = document.createElement("img");
    img.alt = coord.description || coord.filename || coord.id;
    img.src = coord.thumb || coord.url;
    img.loading = i === 0 ? "eager" : "lazy";
    img.decoding = "async";
    if (i === 0) {
      img.fetchPriority = "high";
      img.src = coord.url || coord.thumb;
    }

    card.appendChild(img);

    const metaTag = document.createElement("div");
    metaTag.className = "card-meta-tag";
    const tagText = (coord.tags || coord.categories || [])[0];
    metaTag.innerHTML = `<span>${tagText ? "#" + esc(tagText) : ""}</span><span>${coord.createdAt ? new Date(coord.createdAt * 1000).getFullYear() : ""}</span>`;
    card.appendChild(metaTag);

    card.addEventListener("click", (e) => {
      e.stopPropagation();
      // If user dragged to pan, ignore click to prevent accidental modal popups or jumps
      if (hasDragged) return;

      const currentIdx = findClosestIndex();
      // A photo is considered already squarely centered if it is active/closest AND camera is squarely aligned with it
      const isAlreadyCentered = (activeIndex === i || currentIdx === i) &&
        Math.hypot(camera.x - coord.x, camera.y - coord.y) < 25 &&
        Math.abs(camera.z - coord.z) < 45 &&
        Math.abs(camera.pitch) < 3 &&
        Math.abs(camera.yaw) < 3;

      if (isAlreadyCentered) {
        // Photo is already squarely in foreground focus -> open full inspection lightbox
        if (onSelectPhoto) {
          onSelectPhoto(coord, i);
        }
      } else {
        // Bring this picture squarely to the foreground!
        jumpToIndex(i);
      }
    });

    card.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      if (onSelectPhoto) {
        onSelectPhoto(coord, i);
      }
    });

    world.appendChild(card);
    return { el: card, img, coord, wasExiting: false, fan: { dx: 0, dy: 0, dz: 0 } };
  });

  // Camera animation loop
  let animationFrameId = null;
  let lastTime = performance.now();

  function tick(now) {
    const dt = Math.min(50, now - lastTime);
    lastTime = now;

    camera.update(dt);

    // Dynamic rotation pivot point: shifts down the timeline along with camera X/Y/Z
    // so rotating pitches/yaws around where the visitor is currently looking instead of swinging around Z=0
    world.style.transformOrigin = `${camera.x}px ${camera.y}px ${camera.z}px`;
    world.style.transform = `translate3d(${-camera.x}px, ${-camera.y}px, ${-camera.z}px) rotateX(${camera.pitch}deg) rotateY(${camera.yaw}deg)`;

    // Viewport dimensions for calculating responsive edge dispersion
    const vpDims = {
      width: viewport.clientWidth || window.innerWidth || 1200,
      height: viewport.clientHeight || window.innerHeight || 800,
    };

    // Update Depth of Field, grayscale fog, pointer events, and exit displacement for cards
    for (const item of cardElements) {
      const shader = calculateDepthShader(item.coord.z, camera.z);
      if (!shader.isVisible) {
        item.el.style.display = "none";
        continue;
      }
      item.el.style.display = "block";
      // Maintain pointerEvents for visible cards (including in focal hold and exiting frames)
      // Only disable pointerEvents if card is fully culled or transparent
      const isCardClickable = shader.isVisible && shader.opacity > 0.05 && shader.exitProgress < 1;
      item.el.style.pointerEvents = isCardClickable ? "auto" : "none";
      item.el.style.filter = `blur(${shader.blur}px) grayscale(${shader.grayscale}%)`;
      item.el.style.opacity = String(shader.opacity);

      // Smoothed fan displacement around the pointer / finger (exiting cards are not fanned)
      const target = shader.exitProgress > 0
        ? { dx: 0, dy: 0, dz: 0 }
        : calculateFanDisplacement(item.coord, camera, fanPointer, vpDims);
      const f = item.fan;
      const k = 0.25;
      f.dx += (target.dx - f.dx) * k;
      f.dy += (target.dy - f.dy) * k;
      f.dz += (target.dz - f.dz) * k;
      const settled = Math.abs(f.dx) < 0.5 && Math.abs(f.dy) < 0.5 && Math.abs(f.dz) < 0.5;
      if (settled) { f.dx = 0; f.dy = 0; f.dz = 0; }

      // Foreground frames exiting view: disperse outward to viewport edges
      if (shader.exitProgress > 0) {
        const disp = calculateExitDisplacement(item.coord, shader.exitProgress, vpDims);
        item.el.style.transform = `translate3d(${item.coord.x + disp.offsetX}px, ${item.coord.y + disp.offsetY}px, ${item.coord.z}px) rotateY(${disp.rotateY}deg) rotateZ(${disp.rotateZ}deg)`;
        item.el.style.zIndex = "0";
        item.wasExiting = true;
      } else if (!settled) {
        item.el.style.transform = `translate3d(${item.coord.x + f.dx}px, ${item.coord.y + f.dy}px, ${item.coord.z + f.dz}px)`;
        item.wasExiting = true; // flag so the resting transform is restored once settled
      } else if (item.wasExiting) {
        item.el.style.transform = `translate3d(${item.coord.x}px, ${item.coord.y}px, ${item.coord.z}px)`;
        item.el.style.zIndex = "";
        item.wasExiting = false;
      }

      // Promote image tier when camera is near
      if (shader.tier === "display" && item.img.src !== (item.coord.url || item.coord.thumb)) {
        item.img.src = item.coord.url || item.coord.thumb;
      }
    }

    updateCounter();

    animationFrameId = requestAnimationFrame(tick);
  }

  animationFrameId = requestAnimationFrame(tick);

  // Pointer panning & drag handling with stationary threshold
  const onPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    if (dragResetTimer) {
      clearTimeout(dragResetTimer);
      dragResetTimer = null;
    }
    isPointerDown = true;
    hasDragged = false;
    startX = e.clientX;
    startY = e.clientY;
    totalDragDist = 0;
  };

  const onPointerLeave = () => {
    fanPointer = null;
  };

  const onPointerMove = (e) => {
    if (e.target && viewport.contains && !viewport.contains(e.target)) {
      fanPointer = null;
    } else if (!isPointerDown || !hasDragged) {
      // Mouse roaming (or a stationary finger): fan cards around the pointer
      setFanPointer(e.clientX, e.clientY);
    } else {
      fanPointer = null; // panning: keep the scene calm
    }
    if (!isPointerDown) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const dist = Math.hypot(dx, dy);
    totalDragDist += dist;

    if (!hasDragged) {
      if (totalDragDist < DRAG_THRESHOLD) {
        // Keep elements completely stationary during clicks
        return;
      }
      hasDragged = true;
    }

    startX = e.clientX;
    startY = e.clientY;
    camera.pan(dx * 1.2, dy * 1.2);
  };

  const onPointerUp = () => {
    isPointerDown = false;
    // Delay clearing hasDragged slightly so click event handlers firing in this frame/event loop can see it
    dragResetTimer = setTimeout(() => {
      hasDragged = false;
      totalDragDist = 0;
      dragResetTimer = null;
    }, 60);
  };

  // Wheel zoom / travel along Z timeline
  const onWheel = (e) => {
    e.preventDefault();
    // Scrolling down (deltaY > 0) flies forward into negative Z (past photos)
    // Scrolling up (deltaY < 0) flies backward into positive Z (entrance / newer photos)
    const delta = -e.deltaY * 1.8;
    camera.flyZ(delta);
  };

  // Touch gesture support: 1-finger pan with threshold, 2-finger pinch
  let touchStartDist = 0;
  const onTouchStart = (e) => {
    if (e.touches.length === 1) {
      if (dragResetTimer) {
        clearTimeout(dragResetTimer);
        dragResetTimer = null;
      }
      isPointerDown = true;
      hasDragged = false;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      totalDragDist = 0;
      setFanPointer(startX, startY);
    } else if (e.touches.length === 2) {
      isPointerDown = false;
      hasDragged = true;
      touchStartDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    }
  };

  const onTouchMove = (e) => {
    if (e.touches.length === 1 && isPointerDown) {
      if (!hasDragged) setFanPointer(e.touches[0].clientX, e.touches[0].clientY);
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      const dist = Math.hypot(dx, dy);
      totalDragDist += dist;

      if (!hasDragged) {
        if (totalDragDist < DRAG_THRESHOLD) return;
        hasDragged = true;
      }

      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      camera.pan(dx * 1.5, dy * 1.5);
    } else if (e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      const deltaDist = dist - touchStartDist;
      touchStartDist = dist;
      // Spreading fingers (pinch-out / deltaDist > 0) flies forward into past photos (-Z)
      camera.flyZ(-deltaDist * 4);
    }
  };

  const onTouchEnd = () => {
    isPointerDown = false;
    fanPointer = null;
    touchStartDist = 0;
    dragResetTimer = setTimeout(() => {
      hasDragged = false;
      totalDragDist = 0;
      dragResetTimer = null;
    }, 60);
  };

  // Keyboard navigation
  const onKeyDown = (e) => {
    if (document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") return;
    if (e.key === "w" || e.key === "W" || e.key === "ArrowUp") {
      camera.flyZ(-220); // Walk forward down the line
    } else if (e.key === "s" || e.key === "S" || e.key === "ArrowDown") {
      camera.flyZ(220); // Walk backward toward entrance
    } else if (e.key === "a" || e.key === "A" || e.key === "ArrowLeft") {
      camera.pan(80, 0);
    } else if (e.key === "d" || e.key === "D" || e.key === "ArrowRight") {
      camera.pan(-80, 0);
    } else if (e.key === "PageDown" || (e.key === " " && !e.shiftKey)) {
      e.preventDefault();
      camera.flyZ(-550); // Large step forward down the line
    } else if (e.key === "PageUp" || (e.key === " " && e.shiftKey)) {
      e.preventDefault();
      camera.flyZ(550); // Large step backward
    } else if (e.key === "Home" || e.key === "0") {
      camera.reset();
      jumpToIndex(0);
    } else if (e.key === "End") {
      jumpToIndex(photoCoords.length - 1);
    } else if (e.key === "[") {
      jumpToPhoto(-1); // Newer photo
    } else if (e.key === "]") {
      jumpToPhoto(1); // Past photo down the line
    }
  };

  viewport.addEventListener("pointerdown", onPointerDown);
  viewport.addEventListener("pointerleave", onPointerLeave);
  window.addEventListener("pointermove", onPointerMove);
  window.addEventListener("pointerup", onPointerUp);
  viewport.addEventListener("wheel", onWheel, { passive: false });
  viewport.addEventListener("touchstart", onTouchStart, { passive: true });
  viewport.addEventListener("touchmove", onTouchMove, { passive: true });
  viewport.addEventListener("touchend", onTouchEnd);
  window.addEventListener("keydown", onKeyDown);

  // Wire HUD Controls
  const btnReset = document.getElementById("hud-reset-cam");
  const btnPrevPhoto = document.getElementById("hud-prev-photo");
  const btnNextPhoto = document.getElementById("hud-next-photo");
  const counterEl = document.getElementById("hud-photo-counter");
  const selectPreset = document.getElementById("hud-preset-select");
  const sliderGolden = document.getElementById("hud-golden-scale");
  const btnFullscreen = document.getElementById("hud-fullscreen-btn");

  const onResetCam = () => {
    camera.reset();
    jumpToIndex(0);
  };

  const onPrevPhoto = () => {
    jumpToPhoto(-1);
  };

  const onNextPhoto = () => {
    jumpToPhoto(1);
  };

  const onPresetChange = (e) => {
    currentPreset = e.target.value;
    updateLayout();
  };

  const onGoldenChange = (e) => {
    currentGoldenMultiplier = parseFloat(e.target.value) || 1.0;
    updateLayout();
  };

  const onToggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  };

  const onFullscreenChange = () => {
    if (btnFullscreen) {
      btnFullscreen.textContent = document.fullscreenElement ? "⛷ Exit" : "⛶ Fullscreen";
    }
  };

  function updateLayout() {
    photoCoords = calculatePhotoCoordinates(rawPhotos, {
      preset: currentPreset,
      goldenMultiplier: currentGoldenMultiplier,
    });
    const deepest = photoCoords.length > 0 ? photoCoords[photoCoords.length - 1].z : -5000;
    camera.setBounds(Math.min(-5000, deepest - 800), 350);

    photoCoords.forEach((coord, i) => {
      if (cardElements[i]) {
        cardElements[i].coord = coord;
        cardElements[i].wasExiting = false;
        cardElements[i].el.style.transform = `translate3d(${coord.x}px, ${coord.y}px, ${coord.z}px)`;
        cardElements[i].el.style.zIndex = "";
      }
    });
    updateCounter();
  }

  btnReset?.addEventListener("click", onResetCam);
  btnPrevPhoto?.addEventListener("click", onPrevPhoto);
  btnNextPhoto?.addEventListener("click", onNextPhoto);
  selectPreset?.addEventListener("change", onPresetChange);
  sliderGolden?.addEventListener("input", onGoldenChange);
  btnFullscreen?.addEventListener("click", onToggleFullscreen);
  document.addEventListener("fullscreenchange", onFullscreenChange);

  // Initial counter state
  updateCounter();

  // Return teardown function
  return () => {
    if (animationFrameId) cancelAnimationFrame(animationFrameId);
    if (dragResetTimer) clearTimeout(dragResetTimer);
    viewport.removeEventListener("pointerdown", onPointerDown);
    viewport.removeEventListener("pointerleave", onPointerLeave);
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    viewport.removeEventListener("wheel", onWheel);
    viewport.removeEventListener("touchstart", onTouchStart);
    viewport.removeEventListener("touchmove", onTouchMove);
    viewport.removeEventListener("touchend", onTouchEnd);
    window.removeEventListener("keydown", onKeyDown);

    btnReset?.removeEventListener("click", onResetCam);
    btnPrevPhoto?.removeEventListener("click", onPrevPhoto);
    btnNextPhoto?.removeEventListener("click", onNextPhoto);
    selectPreset?.removeEventListener("change", onPresetChange);
    sliderGolden?.removeEventListener("input", onGoldenChange);
    btnFullscreen?.removeEventListener("click", onToggleFullscreen);
    document.removeEventListener("fullscreenchange", onFullscreenChange);
  };
}
