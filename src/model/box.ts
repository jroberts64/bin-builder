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

export interface BoxModel {
  innerW: number // mm, X (left-right)
  innerD: number // mm, Y depth (front-back, the slide axis)
  innerH: number // mm, Z height (cavity)
  wall: number // mm, box wall + floor thickness
  lidThickness: number // mm, thickness of the sliding lid panel
  clearance: number // mm, gap per side between lid tongue and groove
}

export function defaultBox(): BoxModel {
  return {
    innerW: 80,
    innerD: 120,
    innerH: 30,
    wall: 2,
    lidThickness: 2,
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

// Outer dimensions of the box body, for the dims readout / camera framing.
export function boxOuterSize(m: BoxModel): { x: number; y: number; z: number } {
  // Top rail above the groove + a small roof allowance over the lid.
  const railTop = m.wall // material above the groove on the side walls
  return {
    x: m.innerW + 2 * m.wall,
    y: m.innerD + m.wall, // back wall closed; front open
    z: m.wall + m.innerH + m.lidThickness + 2 * m.clearance + railTop,
  }
}

export function buildBox(m: BoxModel): BuiltBox {
  const wall = m.wall
  const c = m.clearance
  const lidT = m.lidThickness

  const outerW = m.innerW + 2 * wall
  // Front is open, back is a full wall: outer depth = cavity + one wall.
  const outerD = m.innerD + wall
  const floorH = wall

  // Groove that carries the lid: a slot of height (lidT + 2c) cut into the inner
  // face of each side wall, plus the lid's running channel. Material thickness
  // above the groove ("rail roof") keeps the lid captured and the top flush.
  const grooveH = lidT + 2 * c
  const railRoof = wall // solid material above the groove
  // The lid rides at this height band inside the side walls.
  const grooveBottomY = floorH + m.innerH + c // gap above the cavity floor space
  const grooveTopY = grooveBottomY + grooveH
  const outerH = grooveTopY + railRoof

  // Centre everything on X/Z; box sits on Y=0. Depth spans z in
  // [-outerD/2, +outerD/2]; the back wall is at -Z, the open mouth at +Z.
  const zFront = outerD / 2

  // --- Box body: solid block, then subtract cavity, groove channel, mouth ---
  let body = box(outerW, outerH, outerD, 0, outerH / 2, 0)

  // Main interior cavity (open top, holds contents). Spans full inner W/D/H and
  // continues upward as the slot the lid slides over.
  const cavity = box(
    m.innerW,
    outerH, // cut all the way up; the rail roof is re-added by side groove geometry below
    m.innerD + EPS, // open toward the front
    0,
    floorH + (outerH - floorH) / 2 + EPS,
    zFront - m.innerD / 2 + EPS / 2,
  )
  body = csgSubtract(body, cavity)

  // Re-add the rail roof: a thin ceiling spanning the full inner width above the
  // groove, so the lid is captured top-and-bottom and the box has a closed top.
  const roof = box(
    m.innerW + 2 * (wall - 0) + EPS, // span into both side walls
    railRoof,
    m.innerD + EPS,
    0,
    grooveTopY + railRoof / 2,
    zFront - m.innerD / 2 + EPS / 2,
  )
  body = csgAdd(body, roof)

  // Now carve the groove channel itself: a slot wider than the cavity (reaching
  // into both side walls by the tongue depth) at the lid's height band, open to
  // the front so the lid can enter. The back end stops short of the back wall so
  // the lid butts against it.
  const tongueDepth = wall - 0.6 // how far the lid tongue reaches into each wall
  const grooveW = m.innerW + 2 * tongueDepth
  const groove = box(
    grooveW,
    grooveH,
    m.innerD + EPS, // from the front opening back to the inner back face
    0,
    grooveBottomY + grooveH / 2,
    zFront - m.innerD / 2 + EPS / 2,
  )
  body = csgSubtract(body, groove)

  // Reopen the front mouth fully across the groove+cavity so the lid inserts.
  // (The cavity subtraction already opens the front; nothing more needed.)

  body = weld(body)
  body.computeBoundingBox()

  // --- Lid: flat panel with side tongues, sized with clearance all round ------
  // Width spans into the grooves; running length = inner depth so it seats
  // against the back wall and is flush at the front. Height = lidT.
  const lidW = grooveW - 2 * c
  const lidLen = m.innerD - c // small gap at the back so it fully seats
  const lidY = grooveBottomY + c + lidT / 2

  // Build the lid where it would sit (for the assembled preview), then the
  // exporter/caller can relocate it to print flat.
  let lid = box(lidW, lidT, lidLen, 0, lidY, zFront - m.innerD / 2)

  // Finger pull: a small nub on the front edge of the lid to grip it.
  const pullW = Math.min(20, m.innerW * 0.4)
  const pull = box(pullW, lidT, 4, 0, lidY, zFront - c - 2 + EPS)
  lid = csgAdd(lid, pull)

  lid = weld(lid)
  lid.computeBoundingBox()

  return {
    box: body,
    lid,
    size: { x: outerW, y: outerD, z: outerH },
  }
}
