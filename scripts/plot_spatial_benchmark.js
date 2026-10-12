// Benchmark and 2D Chart Generator for 3D Spatial Navigation
// Gauges focal hold, displacement curves, and Landscape Valley distribution.

import { calculateDepthShader, calculateExitDisplacement, calculatePhotoCoordinates } from "../site/spatial.js";

// Helper: render ASCII 2D scatter plot grid
function renderScatterPlot(points, width = 60, height = 18, xLabel = "X", yLabel = "Y") {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const grid = Array.from({ length: height }, () => Array(width).fill(" "));

  points.forEach((p) => {
    const gx = Math.round(((p.x - minX) / (maxX - minX || 1)) * (width - 1));
    const gy = Math.round(((maxY - p.y) / (maxY - minY || 1)) * (height - 1));
    grid[gy][gx] = p.char || "•";
  });

  const lines = [];
  lines.push(`▲ ${yLabel} (max: ${Math.round(maxY)}, min: ${Math.round(minY)})`);
  for (let r = 0; r < height; r++) {
    const axisY = r === Math.round(height / 2) ? "┼" : "│";
    lines.push(`${axisY} ${grid[r].join("")}`);
  }
  lines.push(`└${"─".repeat(width)}► ${xLabel} (min: ${Math.round(minX)}, max: ${Math.round(maxX)})`);
  return lines.join("\n");
}

console.log("================================================================================");
console.log("1. EXIT DISPLACEMENT VS CAMERA DEPTH TRAJECTORY (Focal Hold -> Margin Exit)");
console.log("================================================================================");

const depthPoints = [];
const depthTable = [];
for (let d = 0; d >= -560; d -= 20) {
  const shader = calculateDepthShader(0, d);
  const disp = calculateExitDisplacement({ index: 0, x: 0, y: 0, z: 0 }, shader.exitProgress, { width: 1200, height: 800 });
  depthPoints.push({ x: -d, y: Math.abs(disp.offsetX), char: d >= -60 ? "o" : "*" });
  if (d % 40 === 0) {
    depthTable.push({
      cameraDepth: d,
      holdActive: d >= -60 ? "YES (Centered)" : "NO (Exiting)",
      exitProgress: shader.exitProgress.toFixed(3),
      opacity: (shader.opacity * 100).toFixed(0) + "%",
      offsetX: `${disp.offsetX}px`,
      rotY: `${disp.rotateY}°`,
    });
  }
}

console.log(renderScatterPlot(depthPoints, 62, 14, "Camera Depth behind photo (px)", "Lateral Displacement |OffsetX| (px)"));
console.log("\nSampled Metrics Table:");
console.table(depthTable);

console.log("\n================================================================================");
console.log("2. LANDSCAPE VALLEY 2D SPATIAL SPREAD (X vs Y Flanks & Terraces)");
console.log("================================================================================");

const dummyPhotos = Array.from({ length: 32 }, (_, i) => ({
  id: `photo-${i}`,
  createdAt: 1710000000 - i * 3600 * 6, // sample gallery sequence
}));

const coords = calculatePhotoCoordinates(dummyPhotos, { preset: "landscape" });
const valleyPoints = coords.map((c, i) => ({
  x: c.x,
  y: c.y,
  char: i === 0 ? "★" : (i % 2 === 0 ? "R" : "L"),
}));

console.log(renderScatterPlot(valleyPoints, 62, 14, "Valley Lateral X (px)", "Terraced Elevation Y (px)"));
console.log("Legend: ★ = Photo 0 (Focal Entrance), L = Left Flank, R = Right Flank");

console.log("\n================================================================================");
console.log("3. EXIT DISPLACEMENT BILATERAL BALANCE (20 consecutive frames)");
console.log("================================================================================");

let left = 0;
let right = 0;
coords.slice(0, 20).forEach((c, i) => {
  const disp = calculateExitDisplacement(c, 1.0, { width: 1200, height: 800 });
  if (disp.offsetX < 0) left++;
  else right++;
  if (i < 8) {
    console.log(`Photo #${i}: OffsetX = ${disp.offsetX}px (${disp.offsetX < 0 ? "LEFT" : "RIGHT"}), OffsetY = ${disp.offsetY}px, RotY = ${disp.rotateY}°`);
  }
});
console.log(`\nFinal Bilateral Balance: Left = ${left} (${(left / 20) * 100}%), Right = ${right} (${(right / 20) * 100}%)`);
