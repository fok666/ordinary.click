// ordinary.click — 3D Spatial Gallery Engine
//
// Implements 3D chronological landscape coordinates, golden ratio axis scaling,
// Depth-of-Field (DoF) blur, atmospheric fog shaders, and camera controller.
// Pure vanilla ES6+, zero external dependencies.

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
      // Day of month creates horizontal landscape width
      const dayOffset = (day - 16) / 15; // roughly -1 to 1
      const landscapeCurve = Math.cos(dayOffset * Math.PI * 0.5);
      x = (dayOffset * sx * 3.6 + Math.sin(index * 0.5) * (sx * 0.4)) * scaleX;
      // Month creates gentle terraces/elevation
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
  // Relative depth: positive distance means photo is in front of camera (receding into distance)
  const depth = -(photoZ - cameraZ);
  const maxHorizon = options.maxHorizon || 3500;
  const focalRange = options.focalRange || 300;

  // If photo is behind camera or beyond max horizon
  if (depth < -600 || depth > maxHorizon) {
    return {
      blur: 16,
      grayscale: 100,
      opacity: 0,
      isVisible: false,
      tier: "thumb",
    };
  }

  // Foreground / Focal plane
  if (Math.abs(depth) <= focalRange) {
    const factor = Math.abs(depth) / focalRange;
    return {
      blur: Math.round(factor * 1.5 * 10) / 10,
      grayscale: Math.round(factor * 15),
      opacity: 1.0,
      isVisible: true,
      tier: "display",
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
  };
}
