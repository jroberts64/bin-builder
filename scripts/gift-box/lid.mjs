// The lid, in PRINT pose: outer top face on the bed (z = 0), skirt rising to
// z = 14. Printing face-down is what puts the tulle plane (z = 1.16) inside
// the plate and gives the top its plate finish. lidToAssembled() flips it
// onto the base.

import { M, roundedRect, ellipse, prism, chamferedPrism } from './kernel.mjs'
import { DIMS } from './dims.mjs'

const { win, pin } = DIMS

/** Pin-hole centres on the frame band's midline (window + bandOffset) at 0°, 90°, 180°, 270°. */
export function pinCentres() {
  const ax = win.rx + pin.bandOffset, ay = win.ry + pin.bandOffset
  return [[ax, 0], [0, ay], [-ax, 0], [0, -ay]]
}

export function windowHole(z0 = -1, z1 = DIMS.top + 1) {
  return prism([ellipse(win.rx, win.ry)], z0, z1)
}

/**
 * Lid body: plate + skirt and bed-edge chamfer, plus (for the real lid) the
 * window and the frame's pin holes. `window: false` gives a plain top; with
 * `rim` it keeps only a band of top plate that wide (the fit test's lid).
 */
export function buildLidShell({ dims = DIMS, window = true, rim = 0 } = {}) {
  const { Manifold } = M()
  const { outerW, outerD, cornerR, skirt, top, lidH } = dims
  const outer = chamferedPrism(roundedRect(outerW, outerD, cornerR), 0, lidH, dims.chamferLid, 0)
  const inner = prism([roundedRect(outerW - 2 * skirt, outerD - 2 * skirt, cornerR - skirt)], top, lidH + 1)
  const shell = outer.subtract(inner)
  // rim > 0 (fit test only): keep just a band of top plate that wide, so the lid is light but still one piece
  if (!window) return rim > 0 ? shell.subtract(prism([roundedRect(outerW - 2 * rim, outerD - 2 * rim, cornerR)], -1, top + 1)) : shell
  const holes = Manifold.union(pinCentres().map(([x, y]) =>
    Manifold.cylinder(pin.lidDepth + 1, pin.hole / 2, pin.hole / 2, 32).translate([x, y, -1])))
  return shell.subtract(windowHole()).subtract(holes)
}

/** Print pose → closed on the base (outer top face at z = topZ). */
export function lidToAssembled(m, dims = DIMS) {
  return m.rotate([180, 0, 0]).translate([0, 0, dims.topZ])
}
