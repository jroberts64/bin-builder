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
  const railRoof = Math.max(0.8, m.wall * 0.8)
  return {
    x: m.innerW + 2 * m.wall,
    y: m.innerD + 2 * m.wall, // walls front and back (front is cut down internally)
    z: m.wall + m.innerH + (m.lidThickness + 2 * m.clearance) + railRoof,
  }
}

export function buildBox(m: BoxModel): BuiltBox {
  return m.topType === 'hinged' ? buildHingedBox(m) : buildSlidingBox(m)
}

function buildSlidingBox(m: BoxModel): BuiltBox {
  const wall = m.wall
  const c = m.clearance
  const lidT = m.lidThickness

  // The lid is the TOP of the box: it slides across grooves cut into the top
  // inner edge of the left/right walls. Build cross-section bottom→top:
  //
  //   rail roof   ── thin overhang holding the lid down ─┐
  //   groove slot ── lidT + 2c tall, lid rides here ─────┤  (in side walls only)
  //   cavity      ── innerH of usable space ─────────────┘
  //   floor       ── wall thick
  //
  // The front wall is cut down to the groove so the lid slides in; the back
  // wall stays full height to stop it.

  const floorH = wall
  const grooveH = lidT + 2 * c // vertical slot the lid rides in
  const railRoof = Math.max(0.8, wall * 0.8) // overhang above the groove

  const cavityBottom = floorH
  const grooveBottom = cavityBottom + m.innerH
  const grooveTop = grooveBottom + grooveH
  const outerH = grooveTop + railRoof

  const outerW = m.innerW + 2 * wall
  const outerD = m.innerD + 2 * wall // closed front AND back; front is cut down

  // Centre on X/Z, box on Y=0. +Z = front (lid inserts here), -Z = back (stop).
  const zFront = outerD / 2
  const zBack = -outerD / 2

  // How far the groove reaches into each side wall (the lid tongue depth).
  const tongueDepth = Math.min(wall - 0.6, wall * 0.6)
  const grooveW = m.innerW + 2 * tongueDepth // full width across cavity + into walls

  // --- Box body ------------------------------------------------------------
  // Solid outer block, then hollow the cavity, cut the side grooves, and lower
  // the front wall so the lid can enter.
  let body = box(outerW, outerH, outerD, 0, outerH / 2, 0)

  // Main cavity: innerW × innerH × innerD, closed on all four sides + floor,
  // open at the top (up through the groove band).
  const cavity = box(
    m.innerW,
    outerH - floorH + EPS, // from floor up through the top
    m.innerD,
    0,
    floorH + (outerH - floorH) / 2 + EPS,
    0,
  )
  body = csgSubtract(body, cavity)

  // Side grooves: widen the opening into the two side walls, only across the
  // groove height band, running the full depth and out through the FRONT so the
  // lid slides in. Stops at the inner back face so the lid butts the back wall.
  const groove = box(
    grooveW,
    grooveH,
    m.innerD + wall + EPS, // from inner back face out through the front wall
    0,
    grooveBottom + grooveH / 2,
    zFront - (m.innerD + wall) / 2 + EPS, // pushed toward the front opening
  )
  body = csgSubtract(body, groove)

  // Lower the front wall to the groove bottom so the lid passes over it (the
  // groove already opened the band; this removes the wall above the cavity at
  // the front too, giving a clean mouth). Remove front wall from groove-bottom
  // up across the full inner width.
  const frontMouth = box(
    m.innerW + EPS,
    outerH - grooveBottom + EPS,
    wall + EPS,
    0,
    grooveBottom + (outerH - grooveBottom) / 2 + EPS,
    zFront - wall / 2 + EPS,
  )
  body = csgSubtract(body, frontMouth)
  void zBack

  body = weld(body)
  body.computeBoundingBox()

  // --- Lid: flat panel sized to slide in the grooves with clearance ---------
  const lidW = grooveW - 2 * c
  const lidLen = m.innerD + tongueDepth - c // seats against back, flush at front
  const lidY = grooveBottom + c + lidT / 2

  // Positioned where it sits when closed (for the assembled preview): front
  // edge flush with the box front, extending back toward the stop.
  const lidFrontZ = zFront - wall + EPS
  const lidCenterZ = lidFrontZ - lidLen / 2
  let lid = box(lidW, lidT, lidLen, 0, lidY, lidCenterZ)

  // Finger pull: a small tab projecting from the front edge of the lid to grip.
  const pullW = Math.min(20, m.innerW * 0.4)
  const pullDepth = 5
  const pull = box(pullW, lidT, pullDepth, 0, lidY, lidFrontZ + pullDepth / 2 - EPS)
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
  const axisZ = zBack - barrelR + EPS // just behind the box back wall

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
  const lipWall = Math.max(1, wall * 0.6)
  const lidPanelW = outerW + 2 * (c + lipWall) // covers walls + lip
  const lidPanelD = outerD + (c + lipWall) // covers front + sides when closed
  // Panel sits flat at plate level, its hinge edge meeting the knuckle axis.
  const lidPanelZcenter = axisZ - lidPanelD / 2
  let lid = box(lidPanelW, lidT, lidPanelD, 0, lidT / 2, lidPanelZcenter)

  // Lid knuckles: solid barrels fused to the pin AND to the lid panel front edge.
  let lidKnuckle = knuckles.lid.length ? csgAdd(...knuckles.lid) : null
  if (lidKnuckle) {
    lidKnuckle = csgAdd(lidKnuckle, pin)
    // connect each lid knuckle to the lid panel hinge edge
    for (let i = 1; i < knuckleCount; i += 2) {
      const cx = -m.innerW / 2 + knuckleW * (i + 0.5)
      const w = knuckleW - kGap
      const connZ = (axisZ + (lidPanelZcenter + lidPanelD / 2)) / 2
      const conn = box(w, lidT, Math.abs(axisZ - (lidPanelZcenter + lidPanelD / 2)) + EPS,
        cx, lidT / 2, connZ)
      lidKnuckle = csgAdd(lidKnuckle, conn)
    }
    lid = csgAdd(lid, lidKnuckle)
  } else {
    // even knuckleCount edge case: still need the pin carried somewhere
    lid = csgAdd(lid, pin)
  }

  // Downward lip rim around the 3 non-hinge edges (front, left, right). Modelled
  // pointing +Y from the panel; folds to wrap the box outside when closed.
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
