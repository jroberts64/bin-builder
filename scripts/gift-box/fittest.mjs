// Fit test: the box's front-right corner, cut out of the real base and lid.
//
// Three base corners, each with one rib per face at a different interference
// (labelled by 1 / 2 / 3 notches in the bottom edge), and one lid corner. The
// geometry is identical to the full box at that interference — clearance 0.2,
// same collar, same skirt — so the grip the user feels is the grip they get.

import { M, overlapVolume } from './kernel.mjs'
import { DIMS } from './dims.mjs'
import { baseBody, ribAt } from './base.mjs'
import { buildLidShell, lidToAssembled } from './lid.mjs'

// Corner window (assembled coordinates): CLIP × CLIP around the +X/+Y corner.
// Kept small because the fit test has to be a quick print (spec: 15–20 min).
const CLIP = 36
const X0 = DIMS.outerW / 2 - CLIP + 1, Y0 = DIMS.outerD / 2 - CLIP + 1
const clipBox = (z0, z1) => M().Manifold.cube([CLIP, CLIP, z1 - z0]).translate([X0, Y0, z0])
// One rib per face, inside the clip window, clear of the corner radius (which starts 10 in from the corner).
const TEST_RIBS = [{ axis: 'x', sign: 1, along: X0 + 10 }, { axis: 'y', sign: 1, along: Y0 + 10 }]

function notches(m, n) {
  // small square bites out of the outer bottom edge of the long wall, 2 mm apart
  const { Manifold } = M()
  let out = m
  for (let k = 0; k < n; k++) {
    const x = X0 + 3 + k * 4
    out = out.subtract(Manifold.cube([2, 2, 2]).translate([x, DIMS.outerD / 2 - 1.2, -1]))
  }
  return out
}

export function buildFitTest() {
  const { Manifold } = M()
  const z0 = DIMS.shoulder - 2
  const body = baseBody().intersect(clipBox(z0, DIMS.collarTop + 1))
  const bases = DIMS.rib.fitValues.map((interference, k) => {
    const ribs = Manifold.union(TEST_RIBS.map((q) => ribAt(q.axis, q.sign, q.along, interference)))
    const assembled = body.add(ribs.intersect(clipBox(z0, DIMS.collarTop + 1)))
    const printed = notches(assembled.translate([0, 0, -z0]), k + 1)
    return { interference, notches: k + 1, assembled, manifold: printed }
  })
  // Lid corner in print pose: clip in assembled space, then flip back to face-down.
  const lidAssembled = lidToAssembled(buildLidShell()).intersect(clipBox(DIMS.shoulder - 1, DIMS.topZ + 1))
  const lid = lidAssembled.rotate([180, 0, 0]).translate([0, 0, DIMS.topZ])
  return { bases, lid, lidAssembled }
}

export { overlapVolume }
