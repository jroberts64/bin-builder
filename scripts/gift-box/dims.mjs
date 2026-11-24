// Every number from the spec (docs/superpowers/specs/2026-11-24-gift-box-design.md)
// in one place. mm throughout. Assembled frame: base floor on z = 0, Z up.

/**
 * All dimensions for a box of the given inside size. Everything that decides
 * the fit — walls, collar, skirt, clearance, ribs (relative to the shoulder and
 * collar top) — is fixed; only the footprint and height follow `inside`. The
 * fit test is the same box made small.
 */
export function makeDims(inside) {
  const wall = 3.2, floor = 2.4, top = 2.4, lidH = 14, skirt = 1.6, collar = 1.4, clearance = 0.2
  const cornerR = 10
  const seat = floor + inside.h // lid underside when closed
  const topZ = seat + top // lid outer top face when closed
  const shoulder = topZ - lidH // where the lid skirt rests
  const collarTop = seat - 0.3
  return Object.freeze({
    inside: Object.freeze({ ...inside }), wall, floor, top, lidH, skirt, collar, clearance, cornerR,
    outerW: inside.w + 2 * wall,
    outerD: inside.d + 2 * wall,
    innerR: cornerR - wall,
    seat, topZ, shoulder, collarTop,
    collarLeadIn: 0.6,
    chamferBase: 0.6,
    chamferLid: 0.8,
    rib: Object.freeze({
      count: 8, width: 1.0, baseProud: clearance,
      defaultInterference: 0.10, fitValues: [0.05, 0.10, 0.15], maxInterference: 0.3,
      z0: shoulder + 2, z1: collarTop - 1, leadIn: 2,
    }),
    win: Object.freeze({ rx: 63.7, ry: 44.7 }),
    tullePlane: 1.16, tulleMargin: 8,
    layer: Object.freeze({ first: 0.2, step: 0.12 }),
    pin: Object.freeze({ hole: 1.95, lidDepth: 0.9, frameDepth: 1.5, d: 1.75, len: 2.2, bandOffset: 5 }),
    frame: Object.freeze({ inset: 1, width: 12, peak: 5.8 }),
    bed: 256,
  })
}

export const DIMS = makeDims({ w: 165, d: 125, h: 45 })
