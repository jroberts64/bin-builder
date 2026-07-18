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

export type HolderShape = 'rect' | 'rounded' | 'round'

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
  if (shape === 'rect') {
    s.moveTo(-x, -z)
    s.lineTo(x, -z)
    s.lineTo(x, z)
    s.lineTo(-x, z)
    s.closePath()
    return s
  }
  // rounded rectangle (same construction as geometry.ts roundedPrism)
  const rr = clamp(r, 0, Math.min(w / 2 - 0.01, d / 2 - 0.01))
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

const segFor = (shape: HolderShape) => (shape === 'round' ? 64 : shape === 'rounded' ? 8 : 1)

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

// A prism whose cross-section is a polygon in the (Z,Y) plane, extruded along X.
// `pts` are [worldZ, worldY]; the solid spans X ∈ [xCenter-xLen/2, xCenter+xLen/2].
// Used for the 45° hook gussets. Local shape X→world -Z, local Y→world Y; after
// extruding along +Z we rotate that axis onto +X.
function prismX(pts: [number, number][], xCenter: number, xLen: number): THREE.BufferGeometry {
  const s = new THREE.Shape()
  s.moveTo(-pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length; i++) s.lineTo(-pts[i][0], pts[i][1])
  s.closePath()
  const g = new THREE.ExtrudeGeometry(s, { depth: xLen, bevelEnabled: false })
  g.rotateY(Math.PI / 2) // extrude axis +Z → +X (now x ∈ [0, xLen])
  g.translate(xCenter - xLen / 2, 0, 0)
  return weld(g)
}

// --- mount ----------------------------------------------------------------

// Back plate + hooks, fused to the container's back. The plate rests flat on the
// board (its back face is the board contact plane at z = -depth/2); each hook is
// a peg through a slot plus a downward catch that hooks the board behind the
// slot, with a 45° gusset so the peg prints self-supported in the upright
// orientation. Hooks sit on the 40mm grid.
function buildMount(m: SkadisModel): THREE.BufferGeometry[] {
  const { width, depth, height, wall, clearance } = m
  const parts: THREE.BufferGeometry[] = []

  const plateBackZ = -depth / 2 // board contact plane
  const plateT = Math.max(3, wall * 1.5)
  const mountH = height

  // Hook grid: columns on 40mm centres across the width, ≥1.
  const cols = Math.max(1, Math.floor(width / SKADIS.holePitch))
  const colSpan = (cols - 1) * SKADIS.holePitch
  const hookW = Math.max(2, SKADIS.slotW - clearance) // fits the 5mm slot
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

  const armThk = 4 // peg height (Y); must clear the 15mm slot
  const catchT = 2.4 // catch depth behind the board (Z)
  const catchDrop = 6 // how far the catch hooks down (Y)
  const boardBackZ = plateBackZ - SKADIS.boardThickness // far face of the board
  const armFrontZ = plateBackZ + EPS // slight embed into the plate
  const armBackZ = boardBackZ - clearance - catchT // reaches just past the board
  const armLenZ = armFrontZ - armBackZ
  const armCz = (armFrontZ + armBackZ) / 2

  for (const rowY of rowYs) {
    for (let i = 0; i < cols; i++) {
      const hx = -colSpan / 2 + i * SKADIS.holePitch
      // Peg through the slot.
      parts.push(box(hookW, armThk, armLenZ, hx, rowY, armCz))
      // Downward catch behind the board.
      const catchCz = armBackZ + catchT / 2
      parts.push(
        box(hookW, catchDrop, catchT, hx, rowY - armThk / 2 - catchDrop / 2 + EPS, catchCz),
      )
      // 45° gusset under the peg (plate side) so the overhang prints supportless.
      const leg = Math.min(SKADIS.boardThickness, catchDrop)
      const yUnder = rowY - armThk / 2 + EPS
      parts.push(
        prismX(
          [
            [plateBackZ + EPS, yUnder],
            [plateBackZ + EPS - leg, yUnder],
            [plateBackZ + EPS, yUnder - leg],
          ],
          hx,
          hookW,
        ),
      )
    }
  }
  return parts
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
