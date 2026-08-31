// ordinary.click — Zero-Dependency 3D Interactive Tag Cloud
//
// Mathematical 3D sphere tag cloud using pure HTML5 Canvas and spherical
// Fibonacci projection. Supports mouse/touch rotation, inertia momentum,
// hover highlighting, and click navigation. Zero external dependencies.

/**
 * Distribute points evenly on a 3D sphere using the Fibonacci lattice.
 * @param {Array<{ name: string, count: number }>} tags
 * @param {number} radius
 * @returns {Array<{ name: string, count: number, x: number, y: number, z: number }>}
 */
export function createSpherePoints(tags, radius) {
  const count = tags.length;
  if (!count) return [];
  const goldenAngle = Math.PI * (3 - Math.sqrt(5)); // ~2.3999 rad

  return tags.map((tag, i) => {
    // y goes from 1 - 1/n to 1/n - 1
    const y = 1 - (i / (count - 1 || 1)) * 2;
    const rAtY = Math.sqrt(Math.max(0, 1 - y * y));
    const theta = goldenAngle * i;

    return {
      name: tag.name,
      count: tag.count,
      x: Math.cos(theta) * rAtY * radius,
      y: y * radius,
      z: Math.sin(theta) * rAtY * radius,
    };
  });
}

/**
 * Rotate a 3D point around X and Y axes.
 * @param {{ x: number, y: number, z: number }} p
 * @param {number} ax - Radians around X axis
 * @param {number} ay - Radians around Y axis
 * @returns {{ x: number, y: number, z: number }}
 */
export function rotatePoint(p, ax, ay) {
  // Y-axis rotation (horizontal)
  const cosY = Math.cos(ay), sinY = Math.sin(ay);
  const x1 = p.x * cosY + p.z * sinY;
  const z1 = -p.x * sinY + p.z * cosY;

  // X-axis rotation (vertical)
  const cosX = Math.cos(ax), sinX = Math.sin(ax);
  const y2 = p.y * cosX - z1 * sinX;
  const z2 = p.y * sinX + z1 * cosX;

  return { x: x1, y: y2, z: z2 };
}

/**
 * Project a 3D point onto 2D canvas coordinates with perspective.
 * @param {{ x: number, y: number, z: number }} p
 * @param {number} width
 * @param {number} height
 * @param {number} radius
 * @param {number} fov
 */
export function projectPoint(p, width, height, radius, fov = 450) {
  const scale = fov / Math.max(1, fov - p.z);
  const normZ = Math.max(0, Math.min(1, (p.z + radius) / (2 * radius)));
  // Enhanced depth contrast: receding elements fade to ~0.15, front elements reach full 1.0
  const alpha = Math.max(0.15, Math.min(1.0, Math.pow(normZ, 1.35) * 0.85 + 0.15));
  return {
    x: width / 2 + p.x * scale,
    y: height / 2 + p.y * scale,
    scale,
    alpha,
  };
}

/**
 * Filter and limit tags for the 3D tag cloud to prevent dense clustering.
 * @param {Array<{ name: string, count: number }>} tags
 * @param {number} [maxTags=35]
 * @returns {Array<{ name: string, count: number }>}
 */
export function filterCloudTags(tags, maxTags = 35) {
  if (!Array.isArray(tags)) return [];
  if (tags.length <= maxTags) return [...tags];
  return [...tags].sort((a, b) => (b.count || 0) - (a.count || 0)).slice(0, maxTags);
}

/**
 * Resolve RGB color values for active theme tokens.
 * Supports all 6 built-in themes (light, dark, monochrome, sepia, nordic, oled).
 * @returns {{ baseColor: string, accentColor: string, isDark: boolean }}
 */
export function getThemeColors() {
  if (typeof window === "undefined" || typeof document === "undefined" || !document.documentElement) {
    return { baseColor: "32, 29, 26", accentColor: "47, 111, 106", isDark: false };
  }

  const theme = document.documentElement.dataset.theme || "";
  const darkThemes = new Set(["dark", "monochrome", "nordic", "oled"]);
  const isDark = darkThemes.has(theme) ||
    (!theme && window.matchMedia?.("(prefers-color-scheme: dark)").matches);

  try {
    const cs = getComputedStyle(document.documentElement);
    const fg = cs.getPropertyValue("--fg")?.trim();
    const accent = cs.getPropertyValue("--accent")?.trim();

    const hexToRgb = (hex) => {
      if (!hex || typeof hex !== "string") return null;
      let c = hex.replace(/^#/, "");
      if (c.length === 3) c = c.split("").map((x) => x + x).join("");
      if (c.length === 6) {
        const num = parseInt(c, 16);
        if (Number.isNaN(num)) return null;
        return `${(num >> 16) & 255}, ${(num >> 8) & 255}, ${num & 255}`;
      }
      return null;
    };

    const fgRgb = hexToRgb(fg);
    const accentRgb = hexToRgb(accent);

    return {
      baseColor: fgRgb || (isDark ? "236, 231, 223" : "32, 29, 26"),
      accentColor: accentRgb || (isDark ? "100, 182, 172" : "47, 111, 106"),
      isDark,
    };
  } catch {
    return {
      baseColor: isDark ? "236, 231, 223" : "32, 29, 26",
      accentColor: isDark ? "100, 182, 172" : "47, 111, 106",
      isDark,
    };
  }
}

/**
 * Initialize and render the interactive 3D Tag Cloud on a canvas element.
 * @param {HTMLCanvasElement} canvas
 * @param {Array<{ name: string, count: number }>} tags
 * @param {(tag: string) => void} onTagClick
 * @param {{ maxTags?: number }} [options]
 * @returns {() => void} Cleanup/destroy function to stop animation loop and detach listeners
 */
export function initTagCloud(canvas, tags, onTagClick, options = {}) {
  if (!canvas || !tags || !tags.length) return () => {};

  const maxTags = options.maxTags || 35;
  const filteredTags = filterCloudTags(tags, maxTags);

  const ctx = canvas.getContext("2d");
  if (!ctx) return () => {};

  const hasWindow = typeof window !== "undefined";
  const getDpr = () => (hasWindow && window.devicePixelRatio ? window.devicePixelRatio : 1);

  // Setup HiDPI resolution
  function resize() {
    const rect = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : { width: 400, height: 360 };
    const dpr = getDpr();
    canvas.width = (rect.width || 400) * dpr;
    canvas.height = (rect.height || 360) * dpr;
  }
  resize();
  if (hasWindow && typeof window.addEventListener === "function") {
    window.addEventListener("resize", resize);
  }

  const baseRadius = Math.min(canvas.width, canvas.height) * 0.38 / getDpr();
  let points = createSpherePoints(filteredTags, baseRadius);

  // Rotation & Dolly Camera physics
  let angleX = 0.0018;
  let angleY = 0.0028;
  let targetAngleX = angleX;
  let targetAngleY = angleY;
  let zoom = options.zoom || 1.0;
  let targetZoom = zoom;
  let dollyZ = options.dollyZ || 0; // camera dolly offset along Z
  let targetDollyZ = dollyZ;
  let isDragging = false;
  let lastPos = { x: 0, y: 0 };
  let hoveredTag = null;
  let animId = null;

  // Track hitboxes and drag state
  let projectedPoints = [];
  let dragDistance = 0;
  let downPos = { x: 0, y: 0 };
  let touchStartDist = 0;
  const DRAG_THRESHOLD_PX = 6;

  function getTagAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const mx = (clientX - rect.left) * (canvas.width / rect.width);
    const my = (clientY - rect.top) * (canvas.height / rect.height);

    for (const p of [...projectedPoints].sort((a, b) => b.z - a.z)) {
      if (p.z < -baseRadius * 0.9) continue; // Behind clipping plane
      const d = Math.hypot(p.x - mx, p.y - my);
      if (d < p.hitRadius) {
        return p.name;
      }
    }
    return null;
  }

  function onPointerDown(e) {
    if (e.touches && e.touches.length === 2) {
      isDragging = false;
      touchStartDist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      return;
    }
    isDragging = true;
    dragDistance = 0;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    lastPos = { x: clientX, y: clientY };
    downPos = { x: clientX, y: clientY };
  }

  function onPointerMove(e) {
    if (e.touches && e.touches.length === 2) {
      const dist = Math.hypot(
        e.touches[0].clientX - e.touches[1].clientX,
        e.touches[0].clientY - e.touches[1].clientY
      );
      if (touchStartDist > 0) {
        const factor = dist / touchStartDist;
        targetDollyZ = Math.max(-baseRadius * 1.5, Math.min(baseRadius * 2.5, targetDollyZ + (factor - 1) * 120));
        touchStartDist = dist;
      }
      return;
    }

    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;

    if (isDragging) {
      const dx = clientX - lastPos.x;
      const dy = clientY - lastPos.y;
      dragDistance += Math.hypot(dx, dy);
      targetAngleY = dx * 0.0035;
      targetAngleX = -dy * 0.0035;
      lastPos = { x: clientX, y: clientY };
    }

    if (!isDragging || dragDistance <= DRAG_THRESHOLD_PX) {
      hoveredTag = getTagAt(clientX, clientY);
      canvas.style.cursor = hoveredTag ? "pointer" : "default";
    } else {
      hoveredTag = null;
      canvas.style.cursor = "grabbing";
    }
  }

  function onPointerUp(e) {
    if (e.touches && e.touches.length < 2) {
      touchStartDist = 0;
    }
    if (!isDragging) return;
    isDragging = false;
    canvas.style.cursor = hoveredTag ? "pointer" : "default";

    // For touch devices: trigger click on stationary tap
    if (e.type === "touchend" && dragDistance <= DRAG_THRESHOLD_PX) {
      const tag = getTagAt(downPos.x, downPos.y);
      if (tag && typeof onTagClick === "function") {
        onTagClick(tag);
      }
    }
  }

  function onWheel(e) {
    e.preventDefault();
    // Dolly camera forward/backward along Z axis
    const delta = -Math.sign(e.deltaY) * Math.min(80, Math.max(20, Math.abs(e.deltaY) * 0.6));
    targetDollyZ = Math.max(-baseRadius * 1.8, Math.min(baseRadius * 2.8, targetDollyZ + delta));
  }

  function onClick(e) {
    // Suppress click navigation if user was dragging/spinning the sphere
    if (dragDistance > DRAG_THRESHOLD_PX) {
      return;
    }
    const tag = getTagAt(e.clientX, e.clientY) || hoveredTag;
    if (tag && typeof onTagClick === "function") {
      onTagClick(tag);
    }
  }

  canvas.addEventListener("mousedown", onPointerDown);
  canvas.addEventListener("mousemove", onPointerMove);
  if (hasWindow && typeof window.addEventListener === "function") {
    window.addEventListener("mouseup", onPointerUp);
  }

  canvas.addEventListener("touchstart", onPointerDown, { passive: true });
  canvas.addEventListener("touchmove", onPointerMove, { passive: true });
  if (hasWindow && typeof window.addEventListener === "function") {
    window.addEventListener("touchend", onPointerUp);
  }

  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("click", onClick);

  function render() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width;
    const h = canvas.height;
    const radius = Math.min(w, h) * 0.38;

    // Smooth inertia and dolly camera interpolation
    angleX += (targetAngleX - angleX) * 0.08;
    angleY += (targetAngleY - angleY) * 0.08;
    dollyZ += (targetDollyZ - dollyZ) * 0.1;
    zoom += (targetZoom - zoom) * 0.1;

    // Decay drag impulse back to gentle idle drift
    if (!isDragging) {
      targetAngleX *= 0.96;
      targetAngleY *= 0.96;
      if (Math.abs(targetAngleX) < 0.001) targetAngleX = 0.0015;
      if (Math.abs(targetAngleY) < 0.001) targetAngleY = 0.0025;
    }

    ctx.clearRect(0, 0, w, h);

    // Rotate points and apply dolly camera offset
    for (let i = 0; i < points.length; i++) {
      const rotated = rotatePoint(points[i], angleX, angleY);
      points[i].x = rotated.x;
      points[i].y = rotated.y;
      points[i].z = rotated.z;
    }

    // Determine current theme accent & text color dynamically from active theme tokens
    const { baseColor, accentColor, isDark } = getThemeColors();

    // Project and sort by depth (z-index) with camera dolly translation
    const effectiveFov = 450 * zoom;
    projectedPoints = points
      .map((p) => {
        // Point shifted by camera dolly along Z
        const shiftedPoint = { x: p.x, y: p.y, z: p.z + dollyZ };
        // Near-plane clipping for fly-by (fade out as point passes behind the camera)
        const clipDist = effectiveFov * 0.85;
        if (shiftedPoint.z >= clipDist) return null;

        const proj = projectPoint(shiftedPoint, w, h, radius, effectiveFov);
        const nearFade = Math.max(0, Math.min(1, (clipDist - shiftedPoint.z) / 120));
        const alpha = proj.alpha * nearFade;
        if (alpha <= 0.01) return null;

        const fontSize = Math.max(11 * dpr, Math.min(26 * dpr, (12 + Math.log2(p.count + 1) * 3) * dpr)) * proj.scale;
        const hitRadius = fontSize * (p.name.length * 0.38);
        return {
          name: p.name,
          count: p.count,
          x: proj.x,
          y: proj.y,
          z: shiftedPoint.z,
          scale: proj.scale,
          alpha,
          fontSize,
          hitRadius,
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.z - b.z);

    // Draw tags
    for (const p of projectedPoints) {
      const isHovered = hoveredTag === p.name;
      // Dynamic focal weight: background (400), midground (500), foreground (600), hovered (700)
      const fontWeight = isHovered ? "700" : (p.z > radius * 0.2 ? "600" : (p.z > -radius * 0.2 ? "500" : "400"));
      ctx.font = `${fontWeight} ${p.fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      // Depth of Field (DoF): subtle optical blur on receding background elements, crisp on foreground
      if (!isHovered && p.z < -radius * 0.15) {
        const blurPx = Math.min(2.0, ((-p.z - radius * 0.15) / (radius * 0.85)) * 1.5 * dpr);
        ctx.filter = `blur(${blurPx.toFixed(1)}px)`;
      } else {
        ctx.filter = "none";
      }

      if (isHovered) {
        ctx.fillStyle = `rgb(${accentColor})`;
        // Subtle glow backdrop on hover
        ctx.shadowColor = `rgba(${accentColor}, 0.6)`;
        ctx.shadowBlur = 8 * dpr;
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
      } else {
        ctx.fillStyle = `rgba(${baseColor}, ${p.alpha})`;

        // Small drop shadow on frontmost elements for pop and contrast
        if (p.z > radius * 0.25) {
          const shadowFactor = (p.z - radius * 0.25) / (radius * 0.75);
          const shadowAlpha = isDark ? (0.35 * shadowFactor) : (0.22 * shadowFactor);
          ctx.shadowColor = `rgba(0, 0, 0, ${shadowAlpha.toFixed(2)})`;
          ctx.shadowBlur = 3.5 * dpr;
          ctx.shadowOffsetX = 0;
          ctx.shadowOffsetY = 1.5 * dpr;
        } else {
          ctx.shadowColor = "transparent";
          ctx.shadowBlur = 0;
          ctx.shadowOffsetX = 0;
          ctx.shadowOffsetY = 0;
        }
      }

      ctx.fillText(`#${p.name}`, p.x, p.y);
    }

    // Reset filter & shadow after loop
    ctx.filter = "none";
    ctx.shadowBlur = 0;

    if (hasWindow && typeof requestAnimationFrame === "function") {
      animId = requestAnimationFrame(render);
    }
  }

  if (hasWindow && typeof requestAnimationFrame === "function") {
    animId = requestAnimationFrame(render);
  }

  const cleanup = () => {
    if (animId && hasWindow && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(animId);
    }
    if (hasWindow && typeof window.removeEventListener === "function") {
      window.removeEventListener("resize", resize);
      window.removeEventListener("mouseup", onPointerUp);
      window.removeEventListener("touchend", onPointerUp);
    }
    canvas.removeEventListener("mousedown", onPointerDown);
    canvas.removeEventListener("mousemove", onPointerMove);
    canvas.removeEventListener("touchstart", onPointerDown);
    canvas.removeEventListener("touchmove", onPointerMove);
    canvas.removeEventListener("wheel", onWheel);
    canvas.removeEventListener("click", onClick);
  };

  cleanup.zoomIn = () => { targetDollyZ = Math.min(baseRadius * 2.8, targetDollyZ + 90); };
  cleanup.zoomOut = () => { targetDollyZ = Math.max(-baseRadius * 1.8, targetDollyZ - 90); };
  cleanup.reset = () => { targetDollyZ = 0; targetAngleX = 0.0018; targetAngleY = 0.0028; };

  return cleanup;
}
