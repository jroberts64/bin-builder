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
  const railRoof = Math.max(0.8, m.wall * 0.8)
  return {
    x: m.innerW + 2 * m.wall,
    y: m.innerD + 2 * m.wall, // walls front and back (front is cut down internally)
    z: m.wall + m.innerH + (m.lidThickness + 2 * m.clearance) + railRoof,
  }
}

export function buildBox(m: BoxModel): BuiltBox {
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
