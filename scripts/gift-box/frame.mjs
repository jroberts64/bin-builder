// The wood frame: an oval moulding that sits on the lid around the window.
//
// Print pose = assembled orientation: flat underside on the bed, profile up,
// so every surface either faces up or is vertical (no overhangs; the only
// downward faces besides the underside are the tiny ceilings of the pin
// holes). The inner edge sits 1 mm inside the window, so it frames the
// opening and hides the window's own edge.
//
// Built as a swept closed mesh — one ring of the profile per angle around the
// ellipse — which is manifold by construction (a torus of quads), then handed
// to Manifold for the pin holes. The profile is the artifact's ovalFrame():
// a 1.0 inner lip, a quarter-round rising to a flat at 3.6, a half-round bead
// peaking at 5.8, a short flat, a rolled outer edge, then down to the bed.

import { M } from './kernel.mjs'
import { DIMS } from './dims.mjs'
import { pinCentres } from './lid.mjs'

const SEGS = 360

function arc(cx, cy, r, a0, a1, n) {
  return Array.from({ length: n + 1 }, (_, k) => {
    const a = a0 + ((a1 - a0) * k) / n
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)]
  })
}

/** The closed profile as (d = mm outward from the inner edge, h = mm up), traversed inner wall → top → outer wall → bottom. */
export function profile() {
  const pts = [
    [0, 0], [0, 1.0],
    ...arc(2.6, 1.0, 2.6, Math.PI, Math.PI / 2, 12).slice(1), // quarter-round up to the flat
    [5.0, 3.6],
    ...arc(7.2, 3.6, 2.2, Math.PI, 0, 20).slice(1), // the bead, peak 5.8
    [10.8, 3.6],
    ...arc(10.8, 2.4, 1.2, Math.PI / 2, 0, 8).slice(1), // rolled outer edge
    [12.0, 0],
  ]
  return pts
}

export function buildFrame() {
  const { Manifold, Mesh } = M()
  const rx = DIMS.win.rx - DIMS.frame.inset, ry = DIMS.win.ry - DIMS.frame.inset
  const prof = profile(), P = prof.length
  const vert = new Float32Array(SEGS * P * 3)
  for (let i = 0; i < SEGS; i++) {
    const th = (2 * Math.PI * i) / SEGS, c = Math.cos(th), s = Math.sin(th)
    let nx = c / rx, ny = s / ry
    const L = Math.hypot(nx, ny); nx /= L; ny /= L
    for (let j = 0; j < P; j++) {
      const [d, h] = prof[j], o = (i * P + j) * 3
      vert[o] = rx * c + nx * d; vert[o + 1] = ry * s + ny * d; vert[o + 2] = h
    }
  }
  const tri = new Uint32Array(SEGS * P * 6)
  let t = 0
  for (let i = 0; i < SEGS; i++) {
    const i1 = (i + 1) % SEGS
    for (let j = 0; j < P; j++) {
      const j1 = (j + 1) % P
      const a = i * P + j, b = i1 * P + j, a1 = i * P + j1, b1 = i1 * P + j1
      tri.set([a, a1, b, a1, b1, b], t); t += 6
    }
  }
  let m = Manifold.ofMesh(new Mesh({ numProp: 3, vertProperties: vert, triVerts: tri }))
  if (m.volume() < 0) throw new Error('frame mesh is inside-out')
  const holes = Manifold.union(pinCentres().map(([x, y]) =>
    Manifold.cylinder(DIMS.pin.frameDepth + 1, DIMS.pin.hole / 2, DIMS.pin.hole / 2, 32).translate([x, y, -1])))
  return m.subtract(holes)
}

/** Print pose → sitting on the closed lid's top face. */
export const frameToAssembled = (m) => m.translate([0, 0, DIMS.topZ])

/** The four 1.75 filament dowel pins in their assembled position, 0.1 clear of each hole bottom. */
export function pinsAssembled() {
  const { Manifold } = M()
  const z0 = DIMS.topZ - DIMS.pin.lidDepth + 0.1
  return Manifold.union(pinCentres().map(([x, y]) =>
    Manifold.cylinder(DIMS.pin.len, DIMS.pin.d / 2, DIMS.pin.d / 2, 32).translate([x, y, z0])))
}
