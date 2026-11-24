// The base, in print pose (= assembled pose: floor on z = 0).
//
// Lower walls 3.2 thick up to the shoulder; above it a 1.4 collar whose inner
// face continues the cavity wall, so the inside stays 165 × 125 all the way
// up. The lid skirt slides over the collar with 0.2 a side and sits on the
// shoulder, flush with the walls below. Grip comes only from 8 crush ribs on
// the collar's outer face; the faces themselves never touch.

import { M, roundedRect, prism, chamferedPrism } from './kernel.mjs'
import { DIMS } from './dims.mjs'

const collarOf = (d) => ({ w: d.inside.w + 2 * d.collar, d: d.inside.d + 2 * d.collar, r: d.innerR + d.collar })
export const collarW = collarOf(DIMS).w
export const collarD = collarOf(DIMS).d

/** Radius of the circular-segment rib whose chord on the collar face is rib.width and which stands p proud. */
const ribRadius = (p, d = DIMS) => ((d.rib.width / 2) ** 2 + p * p) / (2 * p)

/** Area of the part of a rib (protruding baseProud + i) that crosses into the skirt, i.e. sticks out past baseProud. */
export function ribSegmentArea(i, d = DIMS) {
  const r = ribRadius(d.rib.baseProud + i, d)
  const c = r - i // distance from rib centre to the skirt face
  return r * r * Math.acos(c / r) - c * Math.sqrt(r * r - c * c)
}

/**
 * One crush rib on a collar face. `axis` 'x' = a long face (normal ±Y), 'y' = a
 * short face (normal ±X); `sign` picks the side; `along` is the position along
 * the face. Full protrusion from z0 to z1 − leadIn, then hulled down to flush at z1.
 */
export function ribAt(axis, sign, along, interference, d = DIMS) {
  const { Manifold } = M()
  const { rib } = d, col = collarOf(d)
  const p = rib.baseProud + interference, r = ribRadius(p, d)
  const face = axis === 'x' ? col.d / 2 : col.w / 2
  const seg = 48
  const full = Manifold.cylinder(rib.z1 - rib.leadIn - rib.z0, r, r, seg).translate([0, face - (r - p), rib.z0])
  const flushDisc = Manifold.cylinder(0.01, r, r, seg).translate([0, face - r, rib.z1 - 0.01])
  const m = Manifold.hull([full, flushDisc])
  // Built on the +Y face at x = 0: turn it to the requested face first, then slide it
  // along that face's own world axis, so `along` is a world x (long faces) or y (short faces).
  if (axis === 'x') return (sign > 0 ? m : m.rotate([0, 0, 180])).translate([along, 0, 0])
  return m.rotate([0, 0, sign > 0 ? -90 : 90]).translate([0, along, 0])
}

/** Production rib positions: 2 per face at ±¼ of each face's straight run (perFace 1: one at each face's middle). */
export function ribPositions(d = DIMS, perFace = 2) {
  const col = collarOf(d)
  const longRun = col.w - 2 * col.r, shortRun = col.d - 2 * col.r
  const out = []
  for (const sign of [1, -1]) {
    if (perFace === 1) { out.push({ axis: 'x', sign, along: 0 }, { axis: 'y', sign, along: 0 }); continue }
    for (const s of [1, -1]) {
      out.push({ axis: 'x', sign, along: s * longRun / 4 })
      out.push({ axis: 'y', sign, along: s * shortRun / 4 })
    }
  }
  return out
}

/** Base body (no ribs) — walls, floor, collar, chamfers. `floor: false` leaves it an open frame (the fit test). */
export function baseBody(d = DIMS, { floor = true } = {}) {
  const col = collarOf(d)
  const outer = chamferedPrism(roundedRect(d.outerW, d.outerD, d.cornerR), 0, d.shoulder, d.chamferBase, 0)
  const c = chamferedPrism(roundedRect(col.w, col.d, col.r), d.shoulder - 1, d.collarTop, 0, d.collarLeadIn)
  const cavity = prism([roundedRect(d.inside.w, d.inside.d, d.innerR)], floor ? d.floor : -1, d.collarTop + 1)
  return outer.add(c).subtract(cavity)
}

export function buildBase({ interference, dims = DIMS, positions = ribPositions(dims), floor = true }) {
  const { Manifold } = M()
  const ribs = Manifold.union(positions.map((q) => ribAt(q.axis, q.sign, q.along, interference, dims)))
  return { body: baseBody(dims, { floor }), ribs }
}
