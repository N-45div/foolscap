/**
 * The tray icon, drawn in code: one sheet of paper and one mark.
 *
 * Drawing the pixels here keeps every state crisp at 16 px and 32 px
 * without shipping a folder of PNGs, and lets the ink follow the
 * taskbar's own light or dark theme. Shapes are in the design's 18-unit
 * grid (the sheet from the canvas mockups) and anti-aliased by distance.
 *
 * States: quiet, working (an arc inside the sheet), needs (a filled dot),
 * red (a triangle), paused (a slash). Every state differs in shape, not
 * only colour.
 */

const SHEET = [
  [[4, 2.5], [11, 2.5]],
  [[11, 2.5], [14, 5.5]],
  [[14, 5.5], [14, 15.5]],
  [[14, 15.5], [4, 15.5]],
  [[4, 15.5], [4, 2.5]],
  [[11, 2.5], [11, 5.5]],
  [[11, 5.5], [14, 5.5]],
];

/** An arc from (6.5,13) bulging up to (11.5,13), as short segments. */
const ARC = (() => {
  const points = [];
  for (let i = 0; i <= 8; i++) {
    const t = Math.PI * (1 + i / 8);
    points.push([9 + 2.5 * Math.cos(t), 13 + 1.6 * Math.sin(t)]);
  }
  return points.slice(1).map((p, i) => [points[i], p]);
})();

function distanceToSegment(px, py, [[ax, ay], [bx, by]]) {
  const dx = bx - ax;
  const dy = by - ay;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len)) : 0;
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

function insideTriangle(px, py, [a, b, c]) {
  const sign = (p1, p2, p3) => (p1[0] - p3[0]) * (p2[1] - p3[1]) - (p2[0] - p3[0]) * (p1[1] - p3[1]);
  const p = [px, py];
  const d1 = sign(p, a, b);
  const d2 = sign(p, b, c);
  const d3 = sign(p, c, a);
  return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0));
}

const hex = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/**
 * Raw BGRA pixels for one state, `size` px square.
 * @param {"quiet"|"working"|"needs"|"red"|"paused"} state
 * @param {{ size?: number, dark?: boolean, accent?: string, failed?: string }} opts
 *   dark: the taskbar is dark, so the ink is light.
 */
export function trayPixels(state, { size = 32, dark = true, accent, failed } = {}) {
  const ink = dark ? hex("#E9EBED") : hex("#1C1B19");
  const dim = dark ? hex("#8A939B") : hex("#6A655C");
  const dot = hex(accent ?? (dark ? "#5DB2F5" : "#0A64AD"));
  const red = hex(failed ?? (dark ? "#F28B5B" : "#B0430D"));
  const unit = size / 18;
  const half = 0.8; // half the stroke width, in units
  const buf = Buffer.alloc(size * size * 4);

  const paint = (i, rgb, alpha) => {
    if (alpha <= 0) return;
    const a = Math.min(1, alpha);
    const prev = buf[i + 3] / 255;
    const out = a + prev * (1 - a);
    for (let k = 0; k < 3; k++) {
      const under = buf[i + 2 - k] / 255; // stored as B,G,R
      const mixed = (rgb[k] / 255) * a + under * prev * (1 - a);
      buf[i + 2 - k] = Math.round((out ? mixed / out : 0) * 255);
    }
    buf[i + 3] = Math.round(out * 255);
  };

  const mark = state === "needs" || state === "red";
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / unit;
      const py = (y + 0.5) / unit;
      const i = (y * size + x) * 4;
      // Leave a gap around the corner mark so it reads at 16 px.
      const nearMark = mark && Math.hypot(px - 14, py - 4) < 4.3;
      if (!nearMark) {
        const sheetInk = state === "paused" ? dim : ink;
        const d = Math.min(...SHEET.map((s) => distanceToSegment(px, py, s)));
        paint(i, sheetInk, (half + 0.5 / unit - d) * unit);
        if (state === "working") {
          const a = Math.min(...ARC.map((s) => distanceToSegment(px, py, s)));
          paint(i, dim, (half + 0.5 / unit - a) * unit);
        }
        if (state === "paused") {
          const s = distanceToSegment(px, py, [[2.5, 15.5], [15.5, 2.5]]);
          paint(i, ink, (half + 0.5 / unit - s) * unit);
        }
      }
      if (state === "needs") {
        const d = Math.hypot(px - 14, py - 4);
        paint(i, dot, (3 - d) * unit + 0.5);
      }
      if (state === "red" && insideTriangle(px, py, [[14, 0.8], [17.4, 7], [10.6, 7]])) {
        paint(i, red, 1);
      }
    }
  }
  return buf;
}
