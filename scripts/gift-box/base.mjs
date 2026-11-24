// The base, in print pose (= assembled pose: floor on z = 0).
//
// Lower walls 3.2 thick up to the shoulder; above it a 1.4 collar whose inner
// face continues the cavity wall, so the inside stays 165 × 125 all the way
// up. The lid skirt slides over the collar with 0.2 a side and sits on the
// shoulder, flush with the walls below. Grip comes only from 8 crush ribs on
// the collar's outer face; the faces themselves never touch.

import { M, roundedRect, prism, chamferedPrism } from './kernel.mjs'
import { DIMS } from './dims.mjs'

const { outerW, outerD, cornerR, innerR, inside, floor, shoulder, collarTop, collar, rib } = DIMS
export const collarW = inside.w + 2 * collar
export const collarD = inside.d + 2 * collar
const collarR = innerR + collar

/** Radius of the circular-segment rib whose chord on the collar face is rib.width and which stands p proud. */
const ribRadius = (p) => ((rib.width / 2) ** 2 + p * p) / (2 * p)

/** Area of the part of a rib (protruding baseProud + i) that crosses into the skirt, i.e. sticks out past baseProud. */
export function ribSegmentArea(i) {
  const r = ribRadius(rib.baseProud + i)
  const d = r - i // distance from rib centre to the skirt face
  return r * r * Math.acos(d / r) - d * Math.sqrt(r * r - d * d)
}

/**
 * One crush rib on a collar face. `axis` 'x' = a long face (normal ±Y), 'y' = a
 * short face (normal ±X); `sign` picks the side; `along` is the position along
 * the face. Full protrusion from z0 to z1 − leadIn, then hulled down to flush at z1.
 */
export function ribAt(axis, sign, along, interference) {
  const { Manifold } = M()
  const p = rib.baseProud + interference, r = ribRadius(p)
  const face = axis === 'x' ? collarD / 2 : collarW / 2
  const seg = 48
  const full = Manifold.cylinder(rib.z1 - rib.leadIn - rib.z0, r, r, seg).translate([0, face - (r - p), rib.z0])
  const flushDisc = Manifold.cylinder(0.01, r, r, seg).translate([0, face - r, rib.z1 - 0.01])
  let m = Manifold.hull([full, flushDisc])
  // Built on the +Y face at x = 0: turn it to the requested face first, then slide it
  // along that face's own world axis, so `along` is a world x (long faces) or y (short faces).
  if (axis === 'x') return (sign > 0 ? m : m.rotate([0, 0, 180])).translate([along, 0, 0])
  return m.rotate([0, 0, sign > 0 ? -90 : 90]).translate([0, along, 0])
}

/** The 8 production rib positions: 2 per face at ±¼ of each face's straight run. */
export function ribPositions() {
  const longRun = collarW - 2 * collarR, shortRun = collarD - 2 * collarR
  const out = []
  for (const sign of [1, -1]) for (const s of [1, -1]) {
    out.push({ axis: 'x', sign, along: s * longRun / 4 })
    out.push({ axis: 'y', sign, along: s * shortRun / 4 })
  }
  return out
}

/** Base body (no ribs) — walls, floor, collar, chamfers. */
export function baseBody() {
  const outer = chamferedPrism(roundedRect(outerW, outerD, cornerR), 0, shoulder, DIMS.chamferBase, 0)
  const col = chamferedPrism(roundedRect(collarW, collarD, collarR), shoulder - 1, collarTop, 0, DIMS.collarLeadIn)
  const cavity = prism([roundedRect(inside.w, inside.d, innerR)], floor, collarTop + 1)
  return outer.add(col).subtract(cavity)
}

export function buildBase({ interference, positions = ribPositions() }) {
  const { Manifold } = M()
  const ribs = Manifold.union(positions.map((q) => ribAt(q.axis, q.sign, q.along, interference)))
  return { body: baseBody(), ribs }
}
