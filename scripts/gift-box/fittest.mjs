// Fit test: the same box, made small.
//
// Grip is set by the cross-section where lid meets base — wall, collar, 0.2
// clearance, skirt, rib profile — and none of that depends on the footprint or
// height. So the fit test is a real box and lid at 80 × 60 inside, sharing that
// cross-section exactly (makeDims fixes everything but the inside size), with
// one rib in the middle of each face. Everything that doesn't touch the fit is
// left off to keep it small: the bases are open frames (no floor) standing only
// 3.2 below the shoulder, and the lid keeps a 10 mm rim of top plate. Three
// bases at 0.05 / 0.10 / 0.15 mm of interference, labelled by 1 / 2 / 3 notches
// in the bottom outer edge, and one lid to try on each.
//
// A small box's walls are stiffer than the real one's 150 mm runs, so it feels a
// little tighter at the same setting; the README says to pick accordingly.
// (A first version cut a strip across the real box; the lid's window split that
// strip in two, so nothing squeezed. Every part here is one piece — tested.)

import { M } from './kernel.mjs'
import { makeDims, DIMS } from './dims.mjs'
import { buildBase, ribPositions } from './base.mjs'
import { buildLidShell, lidToAssembled } from './lid.mjs'

// h is chosen so the shoulder sits 3.2 above the bed: h = shoulder + lidH − floor − top
export const FIT_DIMS = makeDims({ w: 80, d: 60, h: 3.2 + 14 - 2.4 - 2.4 })

function notches(m, n, d) {
  const { Manifold } = M()
  let out = m
  for (let k = 0; k < n; k++) out = out.subtract(Manifold.cube([2, 2, 2]).translate([-10 + k * 4, d.outerD / 2 - 1.2, -1]))
  return out
}

export function buildFitTest() {
  const dims = FIT_DIMS
  const bases = DIMS.rib.fitValues.map((interference, k) => {
    const { body, ribs } = buildBase({ interference, dims, positions: ribPositions(dims, 1), floor: false })
    return { interference, notches: k + 1, body, ribs, assembled: body.add(ribs), manifold: notches(body.add(ribs), k + 1, dims) }
  })
  const lid = buildLidShell({ dims, window: false, rim: 10 })
  return { dims, bases, lid, lidAssembled: lidToAssembled(lid, dims) }
}
