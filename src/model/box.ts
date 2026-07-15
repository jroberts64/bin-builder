import * as THREE from 'three'
import { csgAdd, csgSubtract, weld } from './csg'

// Sliding-lid box: a closed box whose lid slides into grooves cut along the top
// inner edges of the left/right walls. The back wall is closed (stops the lid);
// the front is open so the lid inserts from the front and sits flush when shut.
//
// Dimensions are the usable INNER cavity (width X, depth Y/front-back, height Z).
// Two separate watertight meshes are produced — box body and lid — both modelled
// Y-up sitting on Y=0, ready for the exporter's Y->Z rotation.
//
//        ┌───────────────┐  ← back wall (closed)
//        │  ▏ groove ▕   │
//   left │  ▏       ▕    │ right   (grooves run front↔back in these walls)
//   wall │               │
//        └───────────────┘
//             front (open — lid slides in here)

const EPS = 0.05

// The box supports two top types:
//   'sliding' — lid slides into grooves in the side walls (the original)
//   'hinged'  — lid is hinged at the back via a print-in-place pin hinge, with
//               an overlapping lip + snap bead to hold it shut
export type BoxTop = 'sliding' | 'hinged'

export interface BoxModel {
  topType: BoxTop
  innerW: number // mm, X (left-right)
  innerD: number // mm, Y depth (front-back; slide axis for sliding, hinge at back)
  innerH: number // mm, Z height (cavity)
  wall: number // mm, box wall + floor thickness
  lidThickness: number // mm, thickness of the lid panel
  clearance: number // mm, gap per side for moving fits (slide groove or hinge pin)
}

export function defaultBox(): BoxModel {
  return {
    topType: 'sliding',
    innerW: 80,
    innerD: 120,
    innerH: 30,
    wall: 3, // thicker default: 2mm side walls flex and let the lid pop out
    lidThickness: 2.4,
    clearance: 0.2,
  }
}

export interface BuiltBox {
  box: THREE.BufferGeometry
  lid: THREE.BufferGeometry
  size: { x: number; y: number; z: number } // overall outer bounds of the box body
}

function box(
  w: number, h: number, d: number, cx: number, cy: number, cz: number,
): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate(cx, cy, cz)
  return g
}

// Cylinder whose axis runs along X (length `len`), centred at (cx,cy,cz).
// Used for hinge knuckle barrels and the pin.
function cylinderX(
  radius: number, len: number, cx: number, cy: number, cz: number, seg = 24,
): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius, radius, len, seg)
  g.rotateZ(Math.PI / 2) // default +Y axis → +X
  g.translate(cx, cy, cz)
  return g
}

// Outer dimensions of the assembled (closed) box, for the dims readout / camera.
export function boxOuterSize(m: BoxModel): { x: number; y: number; z: number } {
  if (m.topType === 'hinged') {
    // Closed: cavity + floor + lid on top; lip overlaps the outside of the walls.
    const lipWall = Math.max(1, m.wall * 0.6)
    return {
      x: m.innerW + 2 * m.wall + 2 * (m.clearance + lipWall),
      y: m.innerD + 2 * m.wall,
      z: m.wall + m.innerH + m.lidThickness,
    }
  }
  return {
    x: m.innerW + 2 * m.wall,
    y: m.innerD + 2 * m.wall, // walls front and back (front is cut down internally)
    z: m.wall + m.innerH + (m.lidThickness + 2 * m.clearance), // top = top of lid slot
  }
}

export function buildBox(m: BoxModel): BuiltBox {
  return m.topType === 'hinged' ? buildHingedBox(m) : buildSlidingBox(m)
}

function buildSlidingBox(m: BoxModel): BuiltBox {
  const wall = m.wall
  const c = m.clearance
  const lidT = m.lidThickness

  // The lid is the TOP of the box, captured in a DOVETAIL channel cut into the
  // top inner edge of the left/right walls. The channel roof is a 45° chamfer,
  // NOT a flat overhang — a flat roof prints as an unsupported overhang and the
  // slicer drops it, leaving the lid unretained. A 45° face is self-supporting,
  // and the lid's tongues carry a matching chamfer so the lid can't lift out.
  // It slides in from the open front and butts the closed back wall (the stop).
  //
  //   wall cross-section (right side, Y up):
  //        │outer│        outer wall, full height to grooveTop
  //        │    ╲         ← 45° roof chamfer (self-supporting overhang)
  //        │  ╲tongue     lid tongue, chamfered to match, clearance c
  //        │ ▔▔▔▔▔         ← ledge at grooveBottom (faces up, supports lid)
  //        │ cavity

  const floorH = wall
  const grooveH = lidT + 2 * c // vertical slot the lid rides in
  const grooveBottom = floorH + m.innerH
  const grooveTop = grooveBottom + grooveH
  const outerH = grooveTop // box top = channel roof apex (at the cavity edge)

  const outerW = m.innerW + 2 * wall
  const outerD = m.innerD + 2 * wall
  // Centre on X/Z, box on Y=0. +Z = front (lid inserts here), -Z = back (stop).
  const zFront = outerD / 2

  const ii = m.innerW / 2 // cavity inner edge (x)
  // Tongue engagement into each side wall. Capped so the 45° roof chamfer (whose
  // vertical rise equals this depth) fits within the groove height.
  const td = Math.min(wall - 0.6, wall * 0.6, grooveH - EPS)

  // Build a solid prism from an (x,y) cross-section extruded along Z (front↔back).
  const prismZ = (pts: [number, number][], zStart: number, depth: number) => {
    const s = new THREE.Shape()
    s.moveTo(pts[0][0], pts[0][1])
    for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1])
    s.closePath()
    const g = new THREE.ExtrudeGeometry(s, { depth, bevelEnabled: false })
    g.translate(0, 0, zStart)
    return weld(g)
  }

  // --- Box body ------------------------------------------------------------
  let body = box(outerW, outerH, outerD, 0, outerH / 2, 0)

  // Hollow the cavity (closed on 4 sides + floor, open at the top).
  const cavity = box(
    m.innerW,
    outerH - floorH + EPS,
    m.innerD,
    0,
    floorH + (outerH - floorH) / 2 + EPS,
    0,
  )
  body = csgSubtract(body, cavity)

  // Cut the dovetail channel into each side wall, from the back inner face out
  // through the front. Cross-section (right side): ledge along the bottom, outer
  // wall up the side, then the 45° roof chamfer (edge P2→P3) back to the cavity
  // edge. Mirror for the left. Runs the full depth so the lid slides in.
  const grooveDepth = m.innerD + wall + EPS // back inner face → just past front
  for (const sx of [-1, 1]) {
    const pts: [number, number][] = [
      [sx * (ii - EPS), grooveBottom],
      [sx * (ii + td), grooveBottom],
      [sx * (ii + td), grooveTop - td],
      [sx * ii, grooveTop], // chamfer apex at the cavity edge (P2→P3 = 45°)
      [sx * (ii - EPS), grooveTop],
    ]
    body = csgSubtract(body, prismZ(pts, -m.innerD / 2, grooveDepth))
  }

  // Open the front over the cavity so the lid panel can enter (the side grooves
  // already open the tongue path). Remove the front wall above the ledge.
  const frontMouth = box(
    m.innerW + EPS,
    outerH - grooveBottom + EPS,
    wall + 2 * EPS, // span the whole front wall (cavity face → outer), no remnant
    0,
    grooveBottom + (outerH - grooveBottom) / 2 + EPS,
    zFront - wall / 2, // centred on the front wall so both faces are cleared
  )
  body = csgSubtract(body, frontMouth)

  body = weld(body)
  body.computeBoundingBox()

  // --- Lid: panel + chamfered tongues, slides into the dovetail channel ------
  // Cross-section mirrors the groove, shrunk by clearance c on the bottom, outer
  // and roof faces; open on the cavity side where it joins the flat panel. The
  // tongue's top chamfer (edge [xo,·]→[ii,·]) is parallel to the roof, offset c.
  const yb = grooveBottom + c // lid bottom, c above the ledge
  const xo = ii + td - c // tongue outer extent, c inside the groove outer wall
  const lidPts: [number, number][] = [
    [xo, yb],
    [xo, grooveTop - td],
    [ii, grooveTop - c],
    [-ii, grooveTop - c],
    [-xo, grooveTop - td],
    [-xo, yb],
  ]
  // Seats against the back wall, flush with the front; slides in along +Z.
  let lid = prismZ(lidPts, -m.innerD / 2, m.innerD + wall)

  // Finger pull: a small tab projecting from the front edge of the lid to grip.
  const pullW = Math.min(20, m.innerW * 0.4)
  const pullDepth = 5
  const pullY = grooveBottom + c + lidT / 2
  const pull = box(pullW, lidT, pullDepth, 0, pullY, zFront + pullDepth / 2 - EPS)
  lid = csgAdd(lid, pull)

  lid = weld(lid)
  lid.computeBoundingBox()

  return {
    box: body,
    lid,
    size: { x: outerW, y: outerD, z: outerH },
  }
}

// Print-in-place hinged box. Modelled — and printed — in the OPEN/FLAT position:
// the box sits open-top up, and the lid lies flat on the plate directly behind
// it, joined by a knuckle-and-pin hinge at the shared bottom-back edge. Both
// pieces lie on Y=0 so the whole thing prints supportless with the pin axis
// horizontal (strong layer lines). Fold the lid up and over to close.
//
// Research-backed clearances (FDM, 0.4mm nozzle): 0.2–0.3mm pin-to-bore gap;
// never print the bore on the Z axis (we don't); knuckle gaps >= clearance.
//
//   side view (printed/open):
//        cavity
//      ┌────────┐
//      │  box   │   ╔════════ lid (flat on plate) ════════╗
//      │        │ ◯ hinge axis (knuckles + pin, at plate)
//      └────────┴───┘
//      Y=0 ───────────────────────────────────────────────
function buildHingedBox(m: BoxModel): BuiltBox {
  const wall = m.wall
  const c = m.clearance
  const lidT = m.lidThickness

  const floorH = wall
  const outerW = m.innerW + 2 * wall
  const outerD = m.innerD + 2 * wall
  const outerH = floorH + m.innerH // open-top box: walls rise to cavity top

  const zFront = outerD / 2
  const zBack = -outerD / 2

  // --- Box body: open-top box ----------------------------------------------
  let body = box(outerW, outerH, outerD, 0, outerH / 2, 0)
  const cavity = box(
    m.innerW,
    m.innerH + EPS,
    m.innerD,
    0,
    floorH + m.innerH / 2 + EPS,
    0,
  )
  body = csgSubtract(body, cavity)

  // --- Hinge geometry ------------------------------------------------------
  // Knuckle barrels run along X, centred on the hinge axis at the bottom-back
  // outer edge, sitting on the plate. Odd count so both ends are box knuckles.
  const pinR = Math.max(1.4, wall * 0.6) // pin radius
  const boreGap = Math.max(0.25, c + 0.05) // pin→bore clearance (research: 0.2–0.3)
  const barrelR = pinR + boreGap + Math.max(1.0, wall * 0.5) // knuckle outer radius
  const axisY = barrelR // axis height so barrels rest on the plate
  // Hinge axis sits behind the box back wall by the full barrel radius + a
  // clearance, so the LID knuckle barrels (which reach forward to axisZ+barrelR)
  // never touch the box back wall — otherwise they fuse to it (a 0.05mm graze is
  // enough) and the hinge won't open. Box knuckles bridge the gap via their web.
  const axisZ = zBack - barrelR - c

  const knuckleCount = 5
  const knuckleW = m.innerW / knuckleCount // along X
  const kGap = Math.max(0.3, c) // gap between adjacent knuckles

  // Helper: one knuckle = barrel minus the pin bore (for box knuckles) or solid
  // around the pin (lid knuckles carry the pin). We use the common scheme:
  // box knuckles have a clear bore (free to rotate); lid knuckles are fused to
  // the pin. Alternate starting and ending with box knuckles (indices even).
  const knuckles: { box: THREE.BufferGeometry[]; lid: THREE.BufferGeometry[] } = {
    box: [], lid: [],
  }
  for (let i = 0; i < knuckleCount; i++) {
    const cx = -m.innerW / 2 + knuckleW * (i + 0.5)
    const w = knuckleW - kGap // leave a gap to its neighbour
    const barrel = cylinderX(barrelR, w, cx, axisY, axisZ)
    if (i % 2 === 0) knuckles.box.push(barrel)
    else knuckles.lid.push(barrel)
  }

  // Pin: a single rod spanning the full width, fused into the lid knuckles and
  // running (with clearance) through the box knuckles.
  const pin = cylinderX(pinR, m.innerW + EPS, 0, axisY, axisZ)

  // Bores through the BOX knuckles so the pin spins freely there.
  const boreTool = cylinderX(pinR + boreGap, m.innerW + 1, 0, axisY, axisZ)

  // Attach box knuckles to the box back wall: a small web from the barrel up to
  // the back wall bottom so they're structurally part of the box.
  const webH = axisY + barrelR
  const webZ = zBack // at the back face
  // Build the box side of the hinge: barrels (bored) + web, unioned to body.
  let boxKnuckle = knuckles.box.length ? csgAdd(...knuckles.box) : null
  if (boxKnuckle) {
    boxKnuckle = csgSubtract(boxKnuckle, boreTool)
    // web connecting barrels to the back wall
    for (let i = 0; i < knuckleCount; i += 2) {
      const cx = -m.innerW / 2 + knuckleW * (i + 0.5)
      const w = knuckleW - kGap
      const web = box(w, webH, wall + EPS, cx, webH / 2, webZ)
      boxKnuckle = csgAdd(boxKnuckle, web)
    }
    body = csgAdd(body, boxKnuckle)
  }

  body = weld(body)
  body.computeBoundingBox()

  // --- Lid (lies flat on the plate behind the box) -------------------------
  // Overlapping-lip lid: panel + a downward rim that, when closed, wraps the
  // outside of the box walls. Modelled flat: panel on the plate extending −Z
  // from the hinge, lip pointing up (becomes downward when folded over).
  //
  // CRITICAL: only the lid knuckles + pin may enter the hinge axis zone (they
  // interleave with the box knuckles in the X-gaps). The full-width panel and
  // lip rails MUST stop a clearance behind the box's rearmost hinge material
  // (the barrels reach back to axisZ - barrelR), or they fuse the lid to the
  // box knuckle barrels and the hinge won't move. lidHingeEdgeZ is that plane.
  const lipWall = Math.max(1, wall * 0.6)
  const lidHingeEdgeZ = axisZ - barrelR - c // panel/lip front edge: clears box barrels
  const lidPanelW = outerW + 2 * (c + lipWall) // covers walls + lip
  // Panel runs from its hinge edge back far enough to cover the closed box.
  const lidPanelD = outerD + (c + lipWall)
  const lidPanelZcenter = lidHingeEdgeZ - lidPanelD / 2
  let lid = box(lidPanelW, lidT, lidPanelD, 0, lidT / 2, lidPanelZcenter)

  // Lid knuckles: solid barrels fused to the pin AND bridged back to the panel
  // hinge edge by connectors. Connectors live only in the lid X-bands (width
  // knuckleW - kGap), so they pass between the box knuckles without touching.
  let lidKnuckle = knuckles.lid.length ? csgAdd(...knuckles.lid) : null
  if (lidKnuckle) {
    lidKnuckle = csgAdd(lidKnuckle, pin)
    // Bridge each lid knuckle (at axisZ) back to the panel hinge edge.
    const connZ = (axisZ + lidHingeEdgeZ) / 2
    const connLen = Math.abs(axisZ - lidHingeEdgeZ) + EPS
    for (let i = 1; i < knuckleCount; i += 2) {
      const cx = -m.innerW / 2 + knuckleW * (i + 0.5)
      const w = knuckleW - kGap
      const conn = box(w, lidT, connLen, cx, lidT / 2, connZ)
      lidKnuckle = csgAdd(lidKnuckle, conn)
    }
    lid = csgAdd(lid, lidKnuckle)
  } else {
    // even knuckleCount edge case: still need the pin carried somewhere
    lid = csgAdd(lid, pin)
  }

  // Downward lip rim around the 3 non-hinge edges (front, left, right). Modelled
  // pointing +Y from the panel; folds to wrap the box outside when closed. The
  // side rails run only along the panel (front edge → hinge edge), NOT into the
  // hinge axis zone, so they never reach the box barrels.
  const lipH = Math.max(2, m.innerH * 0.15)
  const lipFrontZ = lidPanelZcenter - lidPanelD / 2 + lipWall / 2
  lid = csgAdd(lid, box(lidPanelW, lipH + lidT, lipWall, 0, (lipH + lidT) / 2, lipFrontZ))
  for (const sx of [-1, 1]) {
    const lx = sx * (lidPanelW / 2 - lipWall / 2)
    lid = csgAdd(lid, box(lipWall, lipH + lidT, lidPanelD, lx, (lipH + lidT) / 2, lidPanelZcenter))
  }

  // Snap bead: a small ridge on the inside of the front lip that clicks past a
  // matching ridge on the box front when closed.
  const beadR = 0.6
  const beadZ = lipFrontZ + lipWall / 2
  lid = csgAdd(lid, cylinderX(beadR, lidPanelW * 0.5, 0, lipH * 0.7, beadZ))

  lid = weld(lid)
  lid.computeBoundingBox()

  // Matching snap ridge on the box front exterior.
  const frontRidge = cylinderX(beadR, m.innerW * 0.5, 0, outerH - beadR, zFront - EPS)
  body = csgAdd(body, frontRidge)
  body = weld(body)
  body.computeBoundingBox()

  // Overall closed size for the readout.
  const sz = boxOuterSize(m)
  return { box: body, lid, size: { x: sz.x, y: sz.y, z: sz.z } }
}
