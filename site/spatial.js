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
    const zDepth = -(Math.pow(deltaDays, 0.75) * sz * scaleZ * 0.15 + (index * sz * 0.25));

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
      // Default: Landscape Valley (X = Day, Y = Month, Z = Year/Timeline)
      const dayOffset = (day - 16) / 15;
      const landscapeCurve = Math.cos(dayOffset * Math.PI * 0.5);
      x = (dayOffset * sx * 3.6 + Math.sin(index * 0.5) * (sx * 0.4)) * scaleX;
      const monthWave = Math.sin((month / 12) * Math.PI * 2);
      y = (monthWave * 0.6 + ((month - 5.5) / 5.5) * 0.4 + landscapeCurve * 0.2) * sy * scaleY;
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
  const exitRange = options.exitRange || 280;

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
  // Gracefully fade out so it doesn't obstruct view or clicks
  if (depth < 0) {
    const fade = clamp((depth + exitRange) / exitRange, 0, 1);
    const exitProgress = clamp(-depth / exitRange, 0, 1);
    return {
      blur: Math.round((1 - fade) * 4 * 10) / 10,
      grayscale: Math.round((1 - fade) * 40),
      opacity: Math.round(fade * 0.8 * 100) / 100,
      isVisible: fade > 0.02,
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
  // Smoothstep easing (C1 continuous): zero start-jerk, zero end-jerk
  const ease = p * p * (3 - 2 * p);

  const vpWidth = (viewport && viewport.width) || 1200;

  // Determine which side of the viewport to exit toward:
  // If photo is already off-center (|x| > 20), exit toward that side;
  // otherwise, alternate side based on photo index (even -> right, odd -> left).
  const side = Math.abs(coord.x || 0) > 20
    ? Math.sign(coord.x)
    : ((coord.index || 0) % 2 === 0 ? 1 : -1);

  // Distance needed to clear the central viewport: half viewport + margin
  const edgeDistX = Math.max(650, vpWidth * 0.55);
  const offsetX = Math.round(side * edgeDistX * ease);

  // Subtle natural arc: vertical drift and card rotation
  const offsetY = Math.round(((coord.index || 0) % 3 === 0 ? -1 : 1) * 60 * ease);
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

  // Drag detection state (to separate camera panning from clicking a photo)
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let totalDragDist = 0;

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
      // If user dragged to pan, ignore click to prevent accidental modal popups
      if (totalDragDist > 8) return;

      // If photo is already in camera focal plane, open full inspection lightbox;
      // otherwise, smoothly glide camera to focus on it so visitor walks directly to it
      const distFromFocal = Math.abs(camera.z - coord.z);
      if (distFromFocal < 350) {
        if (onSelectPhoto) {
          onSelectPhoto(coord, i);
        }
      } else {
        jumpToIndex(i);
      }
    });

    world.appendChild(card);
    return { el: card, img, coord, wasExiting: false };
  });

  // Camera animation loop
  let animationFrameId = null;
  let lastTime = performance.now();

  function tick(now) {
    const dt = Math.min(50, now - lastTime);
    lastTime = now;

    camera.update(dt);

    // Apply inverse camera transform to world so camera movement reveals the 3D scene
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
      // Prevent passed cards behind camera from capturing clicks or obstructing view
      item.el.style.pointerEvents = shader.depth < 0 ? "none" : "auto";
      item.el.style.filter = `blur(${shader.blur}px) grayscale(${shader.grayscale}%)`;
      item.el.style.opacity = String(shader.opacity);

      // Foreground frames exiting view: disperse outward to viewport edges
      if (shader.exitProgress > 0) {
        const disp = calculateExitDisplacement(item.coord, shader.exitProgress, vpDims);
        item.el.style.transform = `translate3d(${item.coord.x + disp.offsetX}px, ${item.coord.y + disp.offsetY}px, ${item.coord.z}px) rotateY(${disp.rotateY}deg) rotateZ(${disp.rotateZ}deg)`;
        item.el.style.zIndex = "0";
        item.wasExiting = true;
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

  // Pointer panning & drag handling
  const onPointerDown = (e) => {
    isDragging = true;
    startX = e.clientX;
    startY = e.clientY;
    totalDragDist = 0;
  };

  const onPointerMove = (e) => {
    if (!isDragging) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    totalDragDist += Math.hypot(dx, dy);
    startX = e.clientX;
    startY = e.clientY;
    camera.pan(dx * 1.2, dy * 1.2);
  };

  const onPointerUp = () => {
    isDragging = false;
  };

  // Wheel zoom / travel along Z timeline
  const onWheel = (e) => {
    e.preventDefault();
    // Scrolling down (deltaY > 0) flies forward into negative Z (past photos)
    // Scrolling up (deltaY < 0) flies backward into positive Z (entrance / newer photos)
    const delta = -e.deltaY * 1.8;
    camera.flyZ(delta);
  };

  // Touch gesture support: 1-finger pan, 2-finger pinch
  let touchStartDist = 0;
  const onTouchStart = (e) => {
    if (e.touches.length === 1) {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      totalDragDist = 0;
      isDragging = true;
    } else if (e.touches.length === 2) {
      isDragging = false;
      touchStartDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
    }
  };

  const onTouchMove = (e) => {
    if (e.touches.length === 1 && isDragging) {
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      totalDragDist += Math.hypot(dx, dy);
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
    isDragging = false;
    touchStartDist = 0;
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
    viewport.removeEventListener("pointerdown", onPointerDown);
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
