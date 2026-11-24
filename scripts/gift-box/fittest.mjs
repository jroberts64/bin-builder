// Fit test: three 20 mm strips cut straight across the real box, through one
// pair of production ribs, plus the matching strip of the real lid.
//
// It has to be a strip across the box, not a corner: grip comes from the two
// opposite skirt walls being pushed apart by ribs on opposite collar faces and
// pulling back through the plate. A corner has nothing opposite, so the lid
// piece just slides away from the rib and every interference feels the same.
//
// Each base strip is the production base (same collar, same 0.2 clearance, the
// two long-face ribs at x = +¼ run) at one of the three interferences, cut
// below the shoulder and held together by a bar across the bottom. It is
// labelled by 1 / 2 / 3 notches in the bottom outer edge.

import { M } from './kernel.mjs'
import { DIMS } from './dims.mjs'
import { buildBase, ribPositions } from './base.mjs'
import { buildLidShell, lidToAssembled } from './lid.mjs'

const WIDTH = 20
const STRIP_X = ribPositions().find((q) => q.axis === 'x' && q.sign > 0 && q.along > 0).along // centred on a rib pair
const X0 = STRIP_X - WIDTH / 2
const BAR = 2.4 // the bar across the bottom that ties the two walls together
const Z0 = DIMS.shoulder - 2 - BAR

const strip = (z0, z1) => M().Manifold.cube([WIDTH, 400, z1 - z0]).translate([X0, -200, z0])

function notches(m, n) {
  const { Manifold } = M()
  let out = m
  for (let k = 0; k < n; k++) out = out.subtract(Manifold.cube([2, 2, 2]).translate([X0 + 3 + k * 4, DIMS.outerD / 2 - 1.2, -1]))
  return out
}

export function buildFitTest() {
  const { Manifold } = M()
  const bar = Manifold.cube([WIDTH, DIMS.inside.d + 2, BAR]).translate([X0, -(DIMS.inside.d + 2) / 2, Z0])
  const bases = DIMS.rib.fitValues.map((interference, k) => {
    const base = buildBase({ interference })
    const assembled = base.body.add(base.ribs).intersect(strip(Z0, DIMS.collarTop + 1)).add(bar)
    return { interference, notches: k + 1, assembled, manifold: notches(assembled.translate([0, 0, -Z0]), k + 1) }
  })
  // Lid strip in print pose: cut in assembled space, then flip back to face-down.
  const lidAssembled = lidToAssembled(buildLidShell()).intersect(strip(DIMS.shoulder - 1, DIMS.topZ + 1))
  const lid = lidAssembled.rotate([180, 0, 0]).translate([0, 0, DIMS.topZ])
  return { bases, lid, lidAssembled }
}
