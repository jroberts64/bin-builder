import * as THREE from 'three'
import { csgSubtract, weld } from './csg'

// A desk stand for the OPEN fan: a block with the fan's own blades subtracted
// out of it, leaving one slot per blade for its tail to drop into.
//
// WHY A STAND HERE HAS TO DO MORE THAN HOLD THE WEIGHT. The fan's pivot is
// deliberately non-seizing — the barrel is a shoulder, so tightening the screw
// cannot clamp the blades (see `fanPivot`) — and every blade's mass sits well
// above the pivot. Each blade is therefore an inverted pendulum, and so is the
// whole stack. Three things need restraining and only the first is free:
//
//   1. the blades splaying apart — the GOVERNOR already does this. Gravity
//      pushes every adjacent pair to its stop, so a fan held by its hub settles
//      at exactly the spread it was modelled at.
//   2. the whole stack rotating about the pivot and flopping sideways.
//   3. toppling out of plane, the fan being 2.4mm thick and 174mm tall.
//
// So a socket for the hub — the obvious design — does not work on its own. A
// slot per blade fixes 2 and 3 at once and pins the display angle as a bonus.
//
// This module knows nothing about `FanModel`: hand it the tails and it hands
// back a sole. That keeps the dependency one-way (fan.ts imports this, never
// the reverse) and makes the unit testable on its own.

// How deep every tail sits in its slot. This is why the block's top is a
// cylindrical valley rather than flat: the tails all lie on a cylinder about
// the pivot AXIS, but at wildly different heights — the middle blade's tip
// hangs 24mm below the pivot while the outermost pair dip only 4mm — so only a
// surface concentric with the pivot engages them all equally.
const GRIP = 10
const FIT = 0.25 // running clearance round a tail, so it drops in rather than presses
const FLOOR = 6 // material left under the deepest slot
const WALL = 4 // material outboard of the tail tips, and either side of the stack
const LIP = 2.5 // how far the shoulders rise past the pivot, to catch the outermost tails
const LEAN = 8 // degrees the fan leans back, so it does not read as about to fall
const ENVELOPE = 256 // samples across a slot's floor
const REACH_MULT = 2.5 // how far up the blade the slot profile bothers to go

export interface SoleSpec {
  // One entry per blade, in stack order: the angle it sits at in the open fan
  // (radians, as `bladeAngle` gives it) and the z of its underside in the
  // assembled hub.
  tails: { angle: number; z: number }[]
  // The blade's outline, blade-local and closed, with the running clearance
  // already grown into it. The caller owns the silhouette, so a slot cannot
  // drift from the part that goes in it.
  outline: { x: number; y: number }[]
  thickness: number // slot width: the blade's own plate thickness plus clearance
  reach: number // how far the tails reach from the pivot — sets the valley radius
}

export const SOLE_FIT = FIT
export const SOLE_GRIP = GRIP
export const SOLE_REACH_MULT = REACH_MULT

// Outer size of the sole in its own print pose (x across, y depth, z up).
export function soleSize(spec: SoleSpec): { x: number; y: number; z: number } {
  const g = soleFrame(spec)
  return { x: 2 * g.halfW, y: 2 * g.halfDepth, z: g.zTop }
}

function soleFrame(spec: SoleSpec) {
  const lean = (LEAN * Math.PI) / 180
  const zLo = Math.min(...spec.tails.map((t) => t.z))
  const zHi = Math.max(...spec.tails.map((t) => t.z)) + spec.thickness
  const halfDepth = ((zHi - zLo) / 2) * Math.cos(lean) + WALL
  const r = spec.reach - GRIP
  // The pivot axis is tilted, so the valley floor rises across the depth of the
  // block; clear the deepest end of it by FLOOR rather than the average.
  const zPivot = r + FLOOR + halfDepth * Math.tan(lean)
  return { lean, zLo, zHi, zc: (zLo + zHi) / 2, r, halfDepth, zPivot, halfW: spec.reach + WALL, zTop: zPivot + LIP }
}

// Fan coordinates (pivot at the origin, fan plane XY, pivot axis +Z) into the
// stand's own frame (x across, y depth, z up, base on z=0). Rotating by
// (90° - lean) about X stands the fan up and tips it back, which leaves the
// block an ordinary axis-aligned box with a flat base rather than something
// whose underside has to be trimmed off afterwards.
//
// Exported because it is the only statement of where the fan sits in its
// stand: anything checking the fit, or one day drawing the pair assembled,
// needs exactly this.
export function soleFanToStand(spec: SoleSpec): THREE.Matrix4 {
  const f = soleFrame(spec)
  return new THREE.Matrix4()
    .makeTranslation(0, f.zc * Math.cos(f.lean), f.zPivot)
    .multiply(new THREE.Matrix4().makeRotationX(Math.PI / 2 - f.lean))
}

// Can a sole be built for these tails at all?
export function soleFits(spec: SoleSpec): boolean {
  return spec.tails.length > 0 && spec.reach > GRIP + 2
}

// The profile of one slot: the blade's outline swept straight up, so the fan
// can be LOWERED in rather than having to be slid in sideways.
//
// Cutting the tail's static footprint would look right and be unusable — the
// slot has to be the volume the tail passes through on its way down, which is
// everything above the outline's lower envelope. A happy side effect is that
// the slot walls come out dead vertical, so the sole prints with no overhang,
// and the blade is still held because the floor is the tail's exact underside
// and any rotation lifts it off.
function sweepUp(
  poly: { x: number; y: number }[],
  top: number,
  xLimit: number,
): { x: number; y: number }[] {
  let xmin = Infinity
  let xmax = -Infinity
  for (const q of poly) {
    if (q.x < xmin) xmin = q.x
    if (q.x > xmax) xmax = q.x
  }
  // Clip to what the block can actually contain. The outer blades run a long
  // way past it, and sampling their whole span would spend all the resolution
  // where there is no material to remove.
  const lo = Math.max(xmin + 1e-3, -xLimit)
  const hi = Math.min(xmax - 1e-3, xLimit)
  if (hi <= lo) return []
  const floor: { x: number; y: number }[] = []
  for (let k = 0; k <= ENVELOPE; k++) {
    const x = lo + ((hi - lo) * k) / ENVELOPE
    let y = Infinity
    for (let j = 0, p = poly.length - 1; j < poly.length; p = j++) {
      const a = poly[p]
      const b = poly[j]
      if (a.x > x === b.x > x) continue
      const t = (x - a.x) / (b.x - a.x)
      const yy = a.y + t * (b.y - a.y)
      if (yy < y) y = yy
    }
    if (Number.isFinite(y)) floor.push({ x, y })
  }
  if (floor.length < 2) return []
  // Left to right along the floor, then back across the top: CCW, which is what
  // ExtrudeGeometry wants.
  return [...floor, { x: floor[floor.length - 1].x, y: top }, { x: floor[0].x, y: top }]
}

export function buildSole(spec: SoleSpec): THREE.BufferGeometry | null {
  if (!soleFits(spec)) return null
  const f = soleFrame(spec)

  // --- tools, built in FAN coordinates: pivot at the origin, fan plane XY,
  // pivot axis +Z, blades pointing +Y.
  const tools: THREE.BufferGeometry[] = []

  // The valley: everything within `r` of the pivot axis. Concentric with the
  // pivot, so every tail engages by exactly GRIP however far round it sits.
  const cyl = new THREE.CylinderGeometry(f.r, f.r, f.zHi - f.zLo + 8 * WALL, 128)
  cyl.rotateX(Math.PI / 2) // cylinder axis Y -> Z, i.e. onto the pivot axis
  cyl.translate(0, 0, f.zc)
  tools.push(weld(cyl))

  // One slot per blade.
  const top = spec.reach * REACH_MULT
  const xLimit = f.halfW + 2
  for (const t of spec.tails) {
    const ca = Math.cos(t.angle)
    const sa = Math.sin(t.angle)
    const rot = spec.outline.map((q) => ({ x: q.x * ca - q.y * sa, y: q.x * sa + q.y * ca }))
    const prof = sweepUp(rot, top, xLimit)
    if (prof.length < 3) continue
    const shape = new THREE.Shape(prof.map((q) => new THREE.Vector2(q.x, q.y)))
    const slot = new THREE.ExtrudeGeometry(shape, {
      depth: spec.thickness,
      bevelEnabled: false,
      curveSegments: 4,
    })
    slot.translate(0, 0, t.z)
    tools.push(weld(slot))
  }

  const into = soleFanToStand(spec)
  for (const g of tools) g.applyMatrix4(into)

  const box = new THREE.BoxGeometry(2 * f.halfW, 2 * f.halfDepth, f.zTop)
  box.translate(0, 0, f.zTop / 2)
  return csgSubtract(weld(box), ...tools)
}
