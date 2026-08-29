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
  return {
    x: width / 2 + p.x * scale,
    y: height / 2 + p.y * scale,
    scale,
    // Deeper points are slightly more transparent
    alpha: Math.max(0.18, Math.min(1.0, 0.4 + 0.6 * ((p.z + radius) / (2 * radius)))),
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

  // Setup HiDPI resolution
  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = (rect.width || 400) * dpr;
    canvas.height = (rect.height || 360) * dpr;
  }
  resize();
  window.addEventListener("resize", resize);

  const baseRadius = Math.min(canvas.width, canvas.height) * 0.38 / (window.devicePixelRatio || 1);
  let points = createSpherePoints(filteredTags, baseRadius);

  // Rotation physics
  let angleX = 0.0018;
  let angleY = 0.0028;
  let targetAngleX = angleX;
  let targetAngleY = angleY;
  let isDragging = false;
  let lastPos = { x: 0, y: 0 };
  let hoveredTag = null;
  let animId = null;

  // Track hitboxes and drag state
  let projectedPoints = [];
  let dragDistance = 0;
  let downPos = { x: 0, y: 0 };
  const DRAG_THRESHOLD_PX = 6;

  function getTagAt(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const mx = (clientX - rect.left) * (canvas.width / rect.width);
    const my = (clientY - rect.top) * (canvas.height / rect.height);

    for (const p of [...projectedPoints].sort((a, b) => b.z - a.z)) {
      if (p.z < 0) continue; // Only hover front hemisphere
      const d = Math.hypot(p.x - mx, p.y - my);
      if (d < p.hitRadius) {
        return p.name;
      }
    }
    return null;
  }

  function onPointerDown(e) {
    isDragging = true;
    dragDistance = 0;
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    lastPos = { x: clientX, y: clientY };
    downPos = { x: clientX, y: clientY };
  }

  function onPointerMove(e) {
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
  window.addEventListener("mouseup", onPointerUp);

  canvas.addEventListener("touchstart", onPointerDown, { passive: true });
  canvas.addEventListener("touchmove", onPointerMove, { passive: true });
  window.addEventListener("touchend", onPointerUp);

  canvas.addEventListener("click", onClick);

  function render() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.width;
    const h = canvas.height;
    const radius = Math.min(w, h) * 0.38;

    // Smooth inertia interpolation
    angleX += (targetAngleX - angleX) * 0.08;
    angleY += (targetAngleY - angleY) * 0.08;

    // Decay drag impulse back to gentle idle drift
    if (!isDragging) {
      targetAngleX *= 0.96;
      targetAngleY *= 0.96;
      if (Math.abs(targetAngleX) < 0.001) targetAngleX = 0.0015;
      if (Math.abs(targetAngleY) < 0.001) targetAngleY = 0.0025;
    }

    ctx.clearRect(0, 0, w, h);

    // Rotate points
    for (let i = 0; i < points.length; i++) {
      const rotated = rotatePoint(points[i], angleX, angleY);
      points[i].x = rotated.x;
      points[i].y = rotated.y;
      points[i].z = rotated.z;
    }

    // Determine current theme accent & text color
    const isDark = document.documentElement.dataset.theme === "dark" ||
      (!document.documentElement.dataset.theme && window.matchMedia?.("(prefers-color-scheme: dark)").matches);
    const baseColor = isDark ? "236, 231, 223" : "32, 29, 26";
    const accentColor = isDark ? "100, 182, 172" : "47, 111, 106";

    // Project and sort by depth (z-index)
    projectedPoints = points.map((p) => {
      const proj = projectPoint(p, w, h, radius);
      const fontSize = Math.max(11 * dpr, Math.min(22 * dpr, (12 + Math.log2(p.count + 1) * 3) * dpr)) * proj.scale;
      const hitRadius = fontSize * (p.name.length * 0.38);
      return {
        name: p.name,
        count: p.count,
        x: proj.x,
        y: proj.y,
        z: p.z,
        scale: proj.scale,
        alpha: proj.alpha,
        fontSize,
        hitRadius,
      };
    }).sort((a, b) => a.z - b.z);

    // Draw tags
    for (const p of projectedPoints) {
      const isHovered = hoveredTag === p.name;
      ctx.font = `${isHovered ? "700" : "500"} ${p.fontSize}px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";

      if (isHovered) {
        ctx.fillStyle = `rgb(${accentColor})`;
        // Subtle glow backdrop
        ctx.shadowColor = `rgba(${accentColor}, 0.5)`;
        ctx.shadowBlur = 8 * dpr;
      } else {
        ctx.fillStyle = `rgba(${baseColor}, ${p.alpha})`;
        ctx.shadowBlur = 0;
      }

      ctx.fillText(`#${p.name}`, p.x, p.y);
      ctx.shadowBlur = 0;
    }

    animId = requestAnimationFrame(render);
  }

  animId = requestAnimationFrame(render);

  return () => {
    if (animId) cancelAnimationFrame(animId);
    window.removeEventListener("resize", resize);
    canvas.removeEventListener("mousedown", onPointerDown);
    canvas.removeEventListener("mousemove", onPointerMove);
    window.removeEventListener("mouseup", onPointerUp);
    canvas.removeEventListener("touchstart", onPointerDown);
    canvas.removeEventListener("touchmove", onPointerMove);
    window.removeEventListener("touchend", onPointerUp);
    canvas.removeEventListener("click", onClick);
  };
}
