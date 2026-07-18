import * as THREE from 'three'
import { csgAdd, csgSubtract, weld } from './csg'

// Skadis holder: a container that clips onto an IKEA SKÅDIS pegboard via
// integrated back hooks. Unlike the box, this is a SINGLE watertight mesh
// (container + hooks fused), so it exports like the bin (one STL / one 3MF
// object). Self-contained module — don't fold into geometry.ts.
//
// Modelled Y-up, sitting on Y=0 (mouth opening at +Y), ready for the exporter's
// Y->Z rotation. Cross-section lies in the XZ plane; +Z is the front, -Z the
// back (the pegboard sits behind, in -Z).
//
//   side view (Y up):            top view (XZ):
//     mouth  ___                   +Z front
//   ┌─┴─┐   ╱   ╲  ← taper          ┌───────┐
//   │   │  │     │                  │       │
//   │pl │  │     │                  │  axis │  (round / rounded / rect)
//   │ate│   ╲___╱  ← base           └───────┘
//   └─┬─┘                            -Z back  → back plate + hooks

const EPS = 0.05

// Real IKEA SKÅDIS pegboard geometry. Slots are 5×15mm rounded holes on a 40mm
// grid in a ~5mm board. These drive the hook dimensions; `clearance` tunes fit.
export const SKADIS = {
  holePitch: 40, // mm, hole spacing (both axes)
  slotW: 5, // mm, slot width
  slotH: 15, // mm, slot height
  boardThickness: 5, // mm
} as const

// Two cross-sections: a rectangle (with an adjustable corner radius — 0 = sharp
// corners, so a plain rectangle is just radius 0) or a round/elliptical tube.
export type HolderShape = 'rect' | 'round'

// How the back hooks grip the pegboard. All three print upright (the same
// orientation the holder is used in) and leave the board channel clear so the
// back plate seats flush; they trade holding strength for simplicity:
//   'peg'  — a peg that friction-fits the slot. Lightest hold, lifts straight
//            off, nothing to catch. Simplest to print.
//   'snap' — peg + a catch that drops behind the solid board below the slot.
//            A positive, everyday hold.
//   'clip' — peg + catch + a toe under the slot's bottom edge, gripping the
//            board on three sides. Strongest / most positive.
export type HookStyle = 'peg' | 'snap' | 'clip'

export interface SkadisModel {
  shape: HolderShape
  width: number // mm, X outer (diameter for round; W≠D → ellipse)
  depth: number // mm, Z front-back outer
  height: number // mm, Y
  cornerRadius: number // mm, 'rounded' only
  wall: number // mm, wall + floor thickness
  taper: number // base size as % of the mouth (100 = straight; 70 = base 70%)
  bottom: 'full' | 'open'
  supportLip: number // mm, inward rim shelf width when bottom = 'open'
  openingDeg: number // front opening angle in degrees (0 = fully enclosed)
  hookStyle: HookStyle // how the back hooks grip the pegboard
  clearance: number // mm, Skadis hook fit
}

export function defaultSkadis(): SkadisModel {
  return {
    shape: 'round',
    width: 60,
    depth: 60,
    height: 80,
    cornerRadius: 8,
    wall: 2.4,
    taper: 100,
    bottom: 'full',
    supportLip: 4,
    openingDeg: 0,
    hookStyle: 'clip',
    clearance: 0.4,
  }
}

export interface BuiltSkadis {
  geometry: THREE.BufferGeometry
  size: { x: number; y: number; z: number }
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

// --- primitives -----------------------------------------------------------

// A closed 2D cross-section outline centred on the origin, in the XZ plane
// (returned as a THREE.Shape whose local X→world X, local Y→world -Z).
function crossSection(shape: HolderShape, w: number, d: number, r: number): THREE.Shape {
  const s = new THREE.Shape()
  const x = w / 2
  const z = d / 2
  if (shape === 'round') {
    // Ellipse (circle when w === d).
    s.absellipse(0, 0, Math.max(0.5, x), Math.max(0.5, z), 0, Math.PI * 2, false, 0)
    return s
  }
  // Rectangle with an optional corner radius. r ≈ 0 → sharp corners (a plain
  // rectangle); a small radius uses the same rounded construction as
  // geometry.ts roundedPrism. Sharp is special-cased to avoid emitting
  // degenerate zero-radius arcs.
  const rr = clamp(r, 0, Math.min(w / 2 - 0.01, d / 2 - 0.01))
  if (rr < 0.05) {
    s.moveTo(-x, -z)
    s.lineTo(x, -z)
    s.lineTo(x, z)
    s.lineTo(-x, z)
    s.closePath()
    return s
  }
  s.moveTo(-x + rr, -z)
  s.lineTo(x - rr, -z)
  s.quadraticCurveTo(x, -z, x, -z + rr)
  s.lineTo(x, z - rr)
  s.quadraticCurveTo(x, z, x - rr, z)
  s.lineTo(-x + rr, z)
  s.quadraticCurveTo(-x, z, -x, z - rr)
  s.lineTo(-x, -z + rr)
  s.quadraticCurveTo(-x, -z, -x + rr, -z)
  return s
}

const segFor = (shape: HolderShape) => (shape === 'round' ? 64 : 8)

// Loft a cross-section into a tapered solid spanning y ∈ [y0, y0+h].
//
// Trick: build a STRAIGHT extrusion (which gives ExtrudeGeometry's clean,
// correctly-wound caps + walls), then scale each vertex's X/Z by a factor that
// depends on its height. A bevel-free extrude has vertices ONLY at its two ends,
// so the factor is exactly bottomScale (base) or topScale (mouth) — an exact
// linear taper, no intermediate geometry. Welded before any boolean, since raw
// ExtrudeGeometry is non-manifold (see geometry.ts / csg.ts notes).
function taperedExtrude(
  shape: THREE.Shape,
  h: number,
  y0: number,
  bottomScale: number,
  topScale: number,
  curveSegments: number,
): THREE.BufferGeometry {
  const geom = new THREE.ExtrudeGeometry(shape, { depth: h, bevelEnabled: false, curveSegments })
  // ExtrudeGeometry lies in XY and extrudes along +Z; rotate so it spans y∈[0,h].
  geom.rotateX(-Math.PI / 2)
  const pos = geom.getAttribute('position') as THREE.BufferAttribute
  for (let i = 0; i < pos.count; i++) {
    const t = h > 0 ? clamp(pos.getY(i) / h, 0, 1) : 0
    const s = bottomScale + (topScale - bottomScale) * t
    pos.setX(i, pos.getX(i) * s)
    pos.setZ(i, pos.getZ(i) * s)
  }
  geom.translate(0, y0, 0)
  return weld(geom)
}

function box(w: number, h: number, d: number, cx: number, cy: number, cz: number) {
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate(cx, cy, cz)
  return g
}

// --- mount ----------------------------------------------------------------

// Back plate + hooks, fused to the container's back. The plate rests flat on the
// board (its back face is the board contact plane at z = -depth/2) and hooks sit
// on the 40mm grid. Everything behind the plate stays OUT of the board channel
// (the z gap between the plate face and the board back) except the peg, which
// threads the slot — so the plate always seats flush. `hookStyle` picks how the
// hook grips (see HookStyle); `hookParts` builds one hook.
function buildMount(m: SkadisModel): THREE.BufferGeometry[] {
  const { width, depth, height, wall, clearance, hookStyle } = m
  const parts: THREE.BufferGeometry[] = []

  const plateBackZ = -depth / 2 // board contact plane (board front face here)
  const plateT = Math.max(3, wall * 1.5)
  const mountH = height
  const boardBackZ = plateBackZ - SKADIS.boardThickness // far (back) face of the board
  const armFrontZ = plateBackZ + EPS // hooks start slightly embedded in the plate

  // Hook grid: columns on 40mm centres across the width, ≥1.
  const cols = Math.max(1, Math.floor(width / SKADIS.holePitch))
  const colSpan = (cols - 1) * SKADIS.holePitch
  const hookW = Math.max(2, SKADIS.slotW - clearance) // fits the 5mm slot width
  const plateW = Math.max(width, colSpan + hookW + 6)

  // Rows: top row a little below the mouth; a second row 40mm down when tall
  // enough (anti-rotation). Keep rows clear of the plate bottom.
  const topRowY = mountH - (SKADIS.slotH / 2 + 4)
  const rowYs = [topRowY]
  if (topRowY - SKADIS.holePitch >= 10) rowYs.push(topRowY - SKADIS.holePitch)

  // Plate: embeds plateT into the container (front face at plateBackZ+plateT) so
  // it fuses across a solid overlap even on round backs (a tangent line alone
  // wouldn't be manifold-safe).
  parts.push(box(plateW, mountH, plateT, 0, mountH / 2, plateBackZ + plateT / 2))

  for (const rowY of rowYs) {
    for (let i = 0; i < cols; i++) {
      const hx = -colSpan / 2 + i * SKADIS.holePitch
      parts.push(...hookParts(hookStyle, hx, rowY, armFrontZ, boardBackZ, hookW, clearance))
    }
  }
  return parts
}

// One hook's solids. The board can only be gripped between the plate (front) and
// a catch reaching behind the SOLID board below the slot — the board is a
// continuous sheet, so there's nowhere in front of it to hook except the slot
// itself. The three styles trade holding strength for simplicity; none reaches
// into the board channel except the peg (which threads the slot).
function hookParts(
  style: HookStyle,
  hx: number,
  rowY: number,
  armFrontZ: number,
  boardBackZ: number,
  hookW: number,
  clearance: number,
): THREE.BufferGeometry[] {
  const out: THREE.BufferGeometry[] = []

  if (style === 'peg') {
    // Friction peg: nearly fills the slot height and pokes just past the board
    // back. Held by friction; no catch, so it lifts straight off.
    const pegH = Math.max(3, SKADIS.slotH - 2 * clearance)
    const pegBackZ = boardBackZ - 1 // 1mm proud of the board back
    out.push(box(hookW, pegH, armFrontZ - pegBackZ, hx, rowY, (armFrontZ + pegBackZ) / 2))
    return out
  }

  // snap / clip: a thin peg through the slot (rests on the slot's bottom edge
  // under load) plus a catch that drops behind the solid board below the slot.
  // clip drops deeper and sits snug to the board back for a more positive lock;
  // snap keeps a clearance gap so it's easy to take on and off.
  const strong = style === 'clip'
  const armThk = 3.5 // peg height (Y); leaves room in the 15mm slot to drop-engage
  const catchT = 2.4 // catch thickness behind the board (Z)
  const catchDrop = strong ? 9 : 5 // deeper overlap with the solid board = stronger
  const gap = strong ? 0 : clearance // clip grips the board back snugly
  const pegBackZ = boardBackZ - gap // peg tip just behind the board back

  out.push(box(hookW, armThk, armFrontZ - pegBackZ, hx, rowY, (armFrontZ + pegBackZ) / 2))
  const catchCz = pegBackZ - catchT / 2 // catch body sits behind the board
  const catchCy = rowY - armThk / 2 - catchDrop / 2 + EPS
  out.push(box(hookW, catchDrop, catchT, hx, catchCy, catchCz))
  return out
}

// --- main build -----------------------------------------------------------

export function buildSkadis(m: SkadisModel): BuiltSkadis {
  const { shape, width, depth, height, wall } = m
  const seg = segFor(shape)
  const floorH = Math.max(wall, 1.0)
  const bottomScale = clamp(m.taper / 100, 0.1, 1) // mouth = 1, base = bottomScale

  // 1) Outer tapered solid ---------------------------------------------------
  const outer = crossSection(shape, width, depth, m.cornerRadius)
  let geo = taperedExtrude(outer, height, 0, bottomScale, 1, seg)

  // 2) Hollow the cavity -----------------------------------------------------
  // Inner outline = outer shrunk by the wall; the same scale profile keeps walls
  // roughly parallel. Cavity runs from the floor up and overshoots the mouth.
  const innerW = width - 2 * wall
  const innerD = depth - 2 * wall
  const innerR = m.cornerRadius - wall
  if (innerW > 1 && innerD > 1) {
    const cavityBottomScale = bottomScale + (1 - bottomScale) * (floorH / height)
    const inner = crossSection(shape, innerW, innerD, innerR)
    const cavity = taperedExtrude(inner, height - floorH + EPS, floorH, cavityBottomScale, 1, seg)
    geo = csgSubtract(geo, cavity)
  }

  // 3) Partial bottom: open the floor, leaving a support-lip rim shelf --------
  if (m.bottom === 'open') {
    const holeW = innerW - 2 * m.supportLip
    const holeD = innerD - 2 * m.supportLip
    if (holeW > 1 && holeD > 1) {
      const cavityBottomScale = bottomScale + (1 - bottomScale) * (floorH / height)
      const holeShape = crossSection(shape, holeW, holeD, innerR - m.supportLip)
      const hole = taperedExtrude(holeShape, floorH + 2 * EPS, -EPS, bottomScale, cavityBottomScale, seg)
      geo = csgSubtract(geo, hole)
    }
  }

  // 4) Partial enclosure: subtract a full-height wedge from the front ---------
  // Pie slice with apex on the axis, bisected by +Z, spanning openingDeg. One
  // uniform rule: a clean arc on round, a V-notch on rectangular shapes.
  if (m.openingDeg > 0) {
    const half = (clamp(m.openingDeg, 0, 300) * Math.PI) / 360 // half-angle, radians
    const R = Math.max(width, depth) * 1.5 // beyond the container at any scale
    const wedge = new THREE.Shape()
    // Shape local X→world X, local Y→world -Z (see taperedExtrude). Front (+Z) is
    // local -Y. Azimuth φ from +Z toward +X: worldX=R sinφ, worldZ=R cosφ.
    wedge.moveTo(0, 0)
    const steps = Math.max(2, Math.ceil((half * 2) / (Math.PI / 36))) // ~5° arc
    for (let i = 0; i <= steps; i++) {
      const phi = -half + (2 * half * i) / steps
      wedge.lineTo(R * Math.sin(phi), -R * Math.cos(phi)) // (worldX, localY=-worldZ)
    }
    wedge.closePath()
    const tool = new THREE.ExtrudeGeometry(wedge, {
      depth: height + 2 * EPS,
      bevelEnabled: false,
    })
    tool.rotateX(-Math.PI / 2)
    tool.translate(0, -EPS, 0)
    geo = csgSubtract(geo, weld(tool))
  }

  // 5) Skadis mount: back plate + hooks --------------------------------------
  geo = csgAdd(geo, ...buildMount(m))

  geo = weld(geo)
  geo.computeBoundingBox()

  const mountDepth = SKADIS.boardThickness + m.clearance + 2.4
  return {
    geometry: geo,
    size: { x: width, y: height, z: depth + mountDepth },
  }
}

// Outer footprint for the dims readout / camera fit (includes the mount depth).
export function skadisOuterSize(m: SkadisModel): { x: number; y: number; z: number } {
  const mountDepth = SKADIS.boardThickness + m.clearance + 2.4
  return { x: m.width, y: m.height, z: m.depth + mountDepth }
}
