// The window contents: a vine (stem, leaves with vein slots, two spiral
// tendrils) and three five-petal flowers, floating on the tulle in the lid's
// oval window. Ported from the artifact's vineParts(): same S-curve, same
// alternating leaves, same flower spots.
//
// Three parts, each a full-plate-thickness slab (0 → top) so it sits flush with
// both lid faces and is split by the tulle at the pause:
//   vine     — Mistletoe Green
//   petals   — White Marble (same filament as the lid body)
//   centres  — Silk+ Gold
// Parts abut and never overlap: a flower lies on top of the vine, so the vine
// is cut away under it. Every part is then morphologically opened by 1.0 mm
// (erode 0.5, dilate 0.5), which removes any sliver a 0.4 nozzle could not
// print while keeping holes (the vein slots) and the stem ends on the window.

import { M, ellipse } from './kernel.mjs'
import { DIMS } from './dims.mjs'

export const VEIN_WIDTH = 0.9
const MIN_FEATURE = 1.0
const FLOWER_LIMIT = 0.96 // flowers stay clear of the frame lip, which covers the outer 1 mm of the window

const cs = (polys) => M().CrossSection.ofPolygons(polys, 'EvenOdd')
const open = (s) => s.offset(-MIN_FEATURE / 2, 'Round', 2, 24).offset(MIN_FEATURE / 2, 'Round', 2, 24)

/** Sample a quadratic Bézier from a to b with control c. */
function quad(a, c, b, n = 16, from = 0) {
  const out = []
  for (let k = from; k <= n; k++) {
    const t = k / n, u = 1 - t
    out.push([u * u * a[0] + 2 * u * t * c[0] + t * t * b[0], u * u * a[1] + 2 * u * t * c[1] + t * t * b[1]])
  }
  return out
}

const place = (pts, x, y, ang) => {
  const c = Math.cos(ang), s = Math.sin(ang)
  return pts.map(([px, py]) => [x + px * c - py * s, y + px * s + py * c])
}

/** Leaf of length len and width ~wid with a lens-shaped vein slot, base at the origin pointing +x. */
function leafPolys(len, wid) {
  const outline = [...quad([0, 0], [len * 0.45, wid], [len, 0]), ...quad([len, 0], [len * 0.45, -wid], [0, 0], 16, 1).slice(0, -1)]
  const vein = [...quad([len * 0.22, 0], [len * 0.5, VEIN_WIDTH], [len * 0.82, 0]), ...quad([len * 0.82, 0], [len * 0.5, -VEIN_WIDTH], [len * 0.22, 0], 16, 1).slice(0, -1)]
  return [outline, vein]
}

/** Assembled top-view sections (x right, y toward the back), before clipping and cleanup. */
function rawSections() {
  const { rx, ry } = DIMS.win
  const inEll = (x, y, k = 1) => (x * x) / (rx * rx) + (y * y) / (ry * ry) <= k * k
  const N = 160, path = []
  for (let i = 0; i <= N; i++) {
    const x = -rx - 6 + ((2 * rx + 12) * i) / N
    path.push([x, 15 * Math.sin((x / rx) * Math.PI * 1.05) - 4 * Math.cos((x / rx) * Math.PI * 0.5)])
  }
  const left = [], right = [], norms = []
  for (let i = 0; i <= N; i++) {
    const a = path[Math.max(0, i - 1)], b = path[Math.min(N, i + 1)]
    let tx = b[0] - a[0], ty = b[1] - a[1]
    const L = Math.hypot(tx, ty); tx /= L; ty /= L
    const nx = -ty, ny = tx
    norms.push([nx, ny, tx, ty])
    const hw = 1.25 - 0.35 * Math.abs(i / N - 0.5)
    left.push([path[i][0] + nx * hw, path[i][1] + ny * hw])
    right.push([path[i][0] - nx * hw, path[i][1] - ny * hw])
  }
  const vineParts = [cs([[...left, ...right.reverse()]])]

  let side = 1
  for (let i = 10; i < N - 6; i += 9) {
    const [px, py] = path[i], [nx, ny, tx, ty] = norms[i]
    const ang = Math.atan2(ny * side + ty * 0.9, nx * side + tx * 0.9)
    const len = 15 + 4 * Math.sin(i * 0.7)
    const tip = [px + Math.cos(ang) * len, py + Math.sin(ang) * len]
    if (inEll(px, py, 0.97) && inEll(tip[0], tip[1], 0.93)) {
      vineParts.push(cs(leafPolys(len, 5.2).map((p) => place(p, px, py, ang))))
    }
    side = -side
  }

  const spiral = (cx, cy, dir, rot) => {
    const L = [], R = []
    for (let k = 0; k <= 60; k++) {
      const t = k / 60, th = rot + dir * t * Math.PI * 2.4, rr = 7 * (1 - t * 0.78)
      const x = cx + rr * Math.cos(th), y = cy + rr * Math.sin(th)
      const hw = 0.75 - 0.2 * t // 1.5 → 1.1 wide: never under the 1.0 minimum
      L.push([x + Math.cos(th) * hw, y + Math.sin(th) * hw])
      R.push([x - Math.cos(th) * hw, y - Math.sin(th) * hw])
    }
    return cs([[...L, ...R.reverse()]])
  }
  for (const [i, dir] of [[45, 1], [118, -1]]) {
    const [px, py] = path[i], [nx, ny] = norms[i]
    vineParts.push(spiral(px + nx * 7 * dir, py + ny * 7 * dir, dir, Math.atan2(-ny * dir, -nx * dir)))
  }

  const circle = (x, y, r) => cs([Array.from({ length: 48 }, (_, k) => [x + r * Math.cos((k / 48) * 2 * Math.PI), y + r * Math.sin((k / 48) * 2 * Math.PI)])])
  const petals = [], centres = []
  for (const [i, off, s] of [[30, -8, 1.05], [82, 8, 1.2], [140, -7, 0.95]]) {
    const [px, py] = path[i], [nx, ny] = norms[i]
    let cx = px + nx * off, cy = py + ny * off
    // Keep the whole flower (radius 6.5·s) inside the frame opening: pull it toward the middle until it fits.
    const R = 6.5 * s
    const fits = () => Array.from({ length: 24 }, (_, k) => (k / 24) * 2 * Math.PI)
      .every((a) => inEll(cx + R * Math.cos(a), cy + R * Math.sin(a), FLOWER_LIMIT))
    while (!fits()) { cx *= 0.98; cy *= 0.98 }
    for (let k = 0; k < 5; k++) {
      const a = (k * 2 * Math.PI) / 5 + 0.3
      petals.push(circle(cx + Math.cos(a) * 3.6 * s, cy + Math.sin(a) * 3.6 * s, 2.9 * s))
    }
    centres.push(circle(cx, cy, 1.8 * s))
  }
  const { CrossSection } = M()
  return { vine: CrossSection.union(vineParts), petals: CrossSection.union(petals), centres: CrossSection.union(centres) }
}

/** Final 2D sections in the lid's PRINT pose (mirrored in y: the lid prints face-down). */
export function windowSections() {
  const raw = rawSections()
  const win = cs([ellipse(DIMS.win.rx, DIMS.win.ry)])
  // Opening can poke a hair past its input (polygonised round joins), so re-clip after it.
  const centres = open(raw.centres.intersect(win)).intersect(win)
  const petals = open(raw.petals.intersect(win).subtract(centres)).subtract(centres).intersect(win)
  const flowers = petals.add(centres)
  const vine = open(raw.vine.subtract(flowers).intersect(win)).subtract(flowers).intersect(win)
  const mirror = (s) => s.mirror([0, 1])
  return { vine: mirror(vine), petals: mirror(petals), centres: mirror(centres) }
}

/** The three window parts as full-thickness slabs, z 0 → top, print pose. */
export function buildWindowParts() {
  const s = windowSections()
  return {
    vine: s.vine.extrude(DIMS.top),
    petals: s.petals.extrude(DIMS.top),
    centres: s.centres.extrude(DIMS.top),
  }
}
