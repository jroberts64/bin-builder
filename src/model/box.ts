import * as THREE from 'three'
import { csgAdd, csgSubtract, weld } from './csg'
import { BoxTexture, FaceRegion, applyTextures, defaultBoxTexture, faceRegion } from './texture'

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
//   'hinged'  — lid is hinged at the back via a pin hinge, with an overlapping
//               lip + snap bead to hold it shut
export type BoxTop = 'sliding' | 'hinged'

// Hinged boxes come in two hinge styles:
//   'flat' — print-in-place: box + lid print as one joined piece, open & flat,
//            folding closed via the pin hinge + a living-hinge wrap (below)
//   'top'  — chest-style snap-on: hinge at the top back edge; box and lid print
//            as two separate parts and the lid's C-clips press onto the pin
export type HingeStyle = 'flat' | 'top'

export interface BoxModel {
  topType: BoxTop
  hingeStyle: HingeStyle // only meaningful when topType === 'hinged'
  innerW: number // mm, X (left-right)
  innerD: number // mm, Y depth (front-back; slide axis for sliding, hinge at back)
  innerH: number // mm, Z height (cavity)
  wall: number // mm, box wall + floor thickness
  lidThickness: number // mm, thickness of the lid panel
  clearance: number // mm, gap per side for moving fits (slide groove or hinge pin)
  texture: BoxTexture // lid-top and outer-wall surface textures (see texture.ts)
}

export function defaultBox(): BoxModel {
  return {
    topType: 'sliding',
    hingeStyle: 'flat',
    innerW: 80,
    innerD: 120,
    innerH: 30,
    wall: 3, // thicker default: 2mm side walls flex and let the lid pop out
    lidThickness: 2.4,
    clearance: 0.2,
    texture: defaultBoxTexture(),
  }
}

// Shared hinge stock derived from the wall/clearance — used by both hinge
// styles (and by boxOuterSize) so the proportions stay consistent.
function hingeStock(m: BoxModel): { pinR: number; boreGap: number; barrelR: number } {
  const pinR = Math.max(1.4, m.wall * 0.6) // pin radius
  const boreGap = Math.max(0.25, m.clearance + 0.05) // pin→bore clearance (research: 0.2–0.3)
  const barrelR = pinR + boreGap + Math.max(1.0, m.wall * 0.5) // knuckle outer radius
  return { pinR, boreGap, barrelR }
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
// Texture regions for the four outer walls of a body centred on X/Z with its
// floor on Y=0. `tops` is the highest Y each wall's texture may reach (null =
// leave that wall plain); faceRegion() insets every edge by TEXTURE.BORDER.
// Each frame's u runs along the wall (so ridges at angle 0 are horizontal), v
// is up, and u × v is the wall's outward normal.
function wallRegions(
  outerW: number,
  outerD: number,
  tops: { left: number | null; right: number | null; front: number | null; back: number | null },
): (FaceRegion | null)[] {
  const hw = outerW / 2
  const hd = outerD / 2
  return [
    tops.left === null ? null : faceRegion([-hw, 0, -hd], [0, 0, 1], [0, 1, 0], outerD, tops.left),
    tops.right === null ? null : faceRegion([hw, 0, hd], [0, 0, -1], [0, 1, 0], outerD, tops.right),
    tops.front === null ? null : faceRegion([-hw, 0, hd], [1, 0, 0], [0, 1, 0], outerW, tops.front),
    tops.back === null ? null : faceRegion([hw, 0, -hd], [-1, 0, 0], [0, 1, 0], outerW, tops.back),
  ]
}

export function boxOuterSize(m: BoxModel): { x: number; y: number; z: number } {
  if (m.topType === 'hinged') {
    // Closed: cavity + floor + lid on top; lip overlaps the outside of the walls.
    const lipWall = Math.max(1, m.wall * 0.6)
    const x = m.innerW + 2 * m.wall + 2 * (m.clearance + lipWall)
    if (m.hingeStyle === 'top') {
      // Chest hinge adds boss columns above the lid and knuckles behind the box.
      const { pinR, barrelR } = hingeStock(m)
      return {
        x,
        y: m.innerD + 2 * m.wall + (m.clearance + lipWall) + 2 * barrelR + m.clearance,
        z: m.wall + m.innerH + m.lidThickness + (pinR + 1.7) + pinR + 1.2,
      }
    }
    return {
      x,
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
  if (m.topType !== 'hinged') return buildSlidingBox(m)
  return m.hingeStyle === 'top' ? buildTopHingedBox(m) : buildHingedBox(m)
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

  // Click detent: a rounded ridge on each side ledge, a few mm from the back,
  // that snaps into a matching dimple in the lid tongue at full closure. As the
  // lid slides the last few mm home the ridge cams against the flat tongue
  // underside (the lid flexes over it) then drops into the dimple — a click —
  // and to slide back out it must climb over the ridge again (a little force).
  const detentR = Math.min(0.6, td * 0.5, lidT * 0.3) // ridge radius
  const detentXlen = Math.max(1, td - 2 * c) // length along X, stays under tongue
  const detentZ = -m.innerD / 2 + Math.min(5, Math.max(3, m.innerD * 0.06)) // near back
  const detentCx = ii + td / 2 // centred on each side ledge (mirror with sx)

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

  // Detent ridges: a rounded bump on each side ledge (centred at y=grooveBottom
  // so it half-embeds in the ledge and protrudes detentR-c above the tongue
  // underside). The lid's dimple nests over these when shut.
  for (const sx of [-1, 1]) {
    body = csgAdd(body, cylinderX(detentR, detentXlen, sx * detentCx, grooveBottom, detentZ))
  }

  body = weld(body)

  // Outer-wall texture. The side walls stop at the groove ledge: above it the
  // dovetail channel leaves only wall − td (~1.2mm) of outer wall, which a
  // recess would breach. The front stops there too (the mouth is open above).
  // The back wall is solid full height (the channel starts at its inner face).
  body = applyTextures(
    body,
    wallRegions(outerW, outerD, { left: grooveBottom, right: grooveBottom, front: grooveBottom, back: outerH }),
    m.texture.sides, 'wall', wall, m.texture.layerHeight,
  )
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

  // Detent dimples: scallop the tongue underside so the box ridges nest in when
  // shut (radius a touch larger than the ridge for a clean snap fit). Centred at
  // y=grooveBottom (below the tongue) so only the top of the cut removes tongue
  // material, leaving a shallow pocket the ridge clicks into.
  for (const sx of [-1, 1]) {
    lid = csgSubtract(lid, cylinderX(detentR + 0.15, detentXlen + 2 * c, sx * detentCx, grooveBottom, detentZ))
  }

  lid = weld(lid)

  // Lid-top texture: the flat between the tongue chamfers (|x| < ii), from the
  // back-wall face to the front edge (the pull is beyond zFront). The lid
  // exports on its bottom, so this face prints UP — raised or recessed. u = +X
  // so ridges at angle 0 run side to side; u × v = +Y, the outward normal.
  lid = applyTextures(
    lid,
    [faceRegion([-ii, grooveTop - c, zFront], [1, 0, 0], [0, 0, -1], 2 * ii, m.innerD + wall)],
    m.texture.top, 'top-up', lidT, m.texture.layerHeight,
  )
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
// The lid needs TWO articulations to close: the pin hinge alone can't do it,
// because rotating a rigid slab about the plate-level axis sweeps it straight
// into the box back wall — the lid has to wrap AROUND the wall. So the flat
// lid is riser → living hinge → panel (see the lid section below).
//
//   side view (printed/open):                living hinge (thin band)
//        cavity                                   ↓
//      ┌────────┐   ╔═ riser ═╗▁▁▁╔═════ lid panel ═════╗
//      │  box   │ ◯ hinge axis (knuckles + pin, at plate)
//      └────────┴───┘
//      Y=0 ───────────────────────────────────────────────
//
//   closing: fold ~90° at the pin (the riser stands up behind the back wall,
//   spanning its height), then the living hinge bends ~90° more around the
//   top back edge so the panel lands flat on the rim.
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
  const { pinR, boreGap, barrelR } = hingeStock(m)
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
  // Three sections, hinge edge outward (−Z):
  //   • RISER — rigid strip fused to the pin-hinge connectors; folds ~90° up
  //     at the pin and stands behind the back wall, spanning its height.
  //   • LIVING HINGE — a thin full-width membrane (bandT, 2–3 print layers)
  //     left at the PLATE side of the slab, so it prints solid with no
  //     bridging; bends ~90° around the box's top back edge when closing.
  //   • PANEL — the lid proper: overlapping lip + snap bead, modelled flat
  //     with the lip pointing up (downward once folded over onto the rim).
  //
  // CRITICAL: only the lid knuckles + pin may enter the hinge axis zone (they
  // interleave with the box knuckles in the X-gaps). The full-width slab and
  // lip rails MUST stop a clearance behind the box's rearmost hinge material
  // (the barrels reach back to axisZ - barrelR), or they fuse the lid to the
  // box knuckle barrels and the hinge won't move. lidHingeEdgeZ is that plane.
  const lipWall = Math.max(1, wall * 0.6)
  const lidHingeEdgeZ = axisZ - barrelR - c // slab front edge: clears box barrels
  const lidPanelW = outerW + 2 * (c + lipWall) // covers walls + lip

  // Living hinge band: thin enough to flex for the life of the part, long
  // enough that the 90° bend stays gentle (bend radius = bandLen / (π/2)).
  const bandT = Math.min(0.5, lidT * 0.4)
  const bandLen = 5
  const bendR = (2 * bandLen) / Math.PI

  // Riser length, derived from the closed pose: the band should form a
  // quarter arc hugging the top back edge — its start sits bendR behind the
  // back face at height outerH + lidT/2 − bendR — and the rigid strip pivoting
  // on the pin axis (connectors + riser) must reach from the axis to that
  // point. The strip's mid-plane rides dPerp below the axis, hence the √ term.
  // Err slightly long (+0.5): extra length just leans the riser / bows the
  // band a touch; too short and the lid physically can't close.
  const reachY = outerH + lidT / 2 - bendR - axisY
  const reachZ = barrelR + c - bendR
  const dPerp = axisY - lidT / 2
  const reach2 = reachY * reachY + reachZ * reachZ - dPerp * dPerp
  const riserD = Math.max(2, Math.sqrt(Math.max(0, reach2)) - (barrelR + c) + 0.5)

  // Panel covers the rim (outerD) plus the front lip overhang when closed.
  const panelD = outerD + (c + lipWall)
  const slabD = riserD + bandLen + panelD
  let lid = box(lidPanelW, lidT, slabD, 0, lidT / 2, lidHingeEdgeZ - slabD / 2)

  // Living-hinge groove: cut the slab down to the bandT membrane, full width.
  lid = csgSubtract(lid, box(
    lidPanelW + 2, lidT - bandT + EPS, bandLen,
    0, bandT + (lidT - bandT + EPS) / 2, lidHingeEdgeZ - riserD - bandLen / 2,
  ))

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

  // Downward lip rim around the 3 non-hinge edges of the PANEL section only.
  // Modelled pointing +Y; folds to wrap the box outside when closed. The rails
  // MUST NOT cross the living hinge (they'd stiffen it solid) and stay well
  // clear of the hinge axis zone.
  const lipH = Math.max(2, m.innerH * 0.15)
  const panelZcenter = lidHingeEdgeZ - riserD - bandLen - panelD / 2
  const lipFrontZ = lidHingeEdgeZ - slabD + lipWall / 2
  lid = csgAdd(lid, box(lidPanelW, lipH + lidT, lipWall, 0, (lipH + lidT) / 2, lipFrontZ))
  for (const sx of [-1, 1]) {
    const lx = sx * (lidPanelW / 2 - lipWall / 2)
    lid = csgAdd(lid, box(lipWall, lipH + lidT, panelD, lx, (lipH + lidT) / 2, panelZcenter))
  }

  // Snap bead: a small ridge on the inside of the front lip that clicks past a
  // matching ridge on the box front when closed.
  const beadR = 0.6
  const beadZ = lipFrontZ + lipWall / 2
  lid = csgAdd(lid, cylinderX(beadR, lidPanelW * 0.5, 0, lipH * 0.7, beadZ))

  lid = weld(lid)

  // Lid-top texture. The panel's PLATE face (y = 0) is the lid's outer top
  // once folded closed, so it is a 'bed-face': recessed only, whole layers.
  // Panel section only — from the front edge to the start of the living hinge
  // (BORDER short of it, via faceRegion) — never the band or the riser. u = +X,
  // v = +Z so u × v = −Y, the outward (downward) normal of this face.
  const panelFrontZ = lidHingeEdgeZ - slabD
  lid = applyTextures(
    lid,
    [faceRegion([-lidPanelW / 2, 0, panelFrontZ], [1, 0, 0], [0, 0, 1], lidPanelW, panelD)],
    m.texture.top, 'bed-face', lidT, m.texture.layerHeight,
  )
  lid.computeBoundingBox()

  // Matching snap ridge on the box front exterior.
  const frontRidge = cylinderX(beadR, m.innerW * 0.5, 0, outerH - beadR, zFront - EPS)
  body = csgAdd(body, frontRidge)
  body = weld(body)

  // Outer-wall texture, kept below the band the closed lid's lip wraps (the top
  // lipH of the walls, with BORDER to spare) so a raised pattern can't collide
  // with the lid closing. Back wall plain: the knuckle webs are there and the
  // riser folds up against it.
  body = applyTextures(
    body,
    wallRegions(outerW, outerD, { left: outerH - lipH, right: outerH - lipH, front: outerH - lipH, back: null }),
    m.texture.sides, 'wall', wall, m.texture.layerHeight,
  )
  body.computeBoundingBox()

  // Overall closed size for the readout.
  const sz = boxOuterSize(m)
  return { box: body, lid, size: { x: sz.x, y: sz.y, z: sz.z } }
}

// Solid prism from a (z, y) cross-section extruded along X over [x0, x0+len].
// Same role as prismZ in the sliding builder, for shapes that run across the
// width (hinge boss columns). ExtrudeGeometry normalizes shape winding, and
// the weld makes it a clean CSG input.
function prismX(pts: [number, number][], x0: number, len: number): THREE.BufferGeometry {
  const s = new THREE.Shape()
  // Shape x carries -z so the rotation below lands z with the right sign.
  s.moveTo(-pts[0][0], pts[0][1])
  for (let i = 1; i < pts.length; i++) s.lineTo(-pts[i][0], pts[i][1])
  s.closePath()
  const g = new THREE.ExtrudeGeometry(s, { depth: len, bevelEnabled: false })
  g.rotateY(Math.PI / 2) // extrusion axis +Z → +X; shape -x → +z
  g.translate(x0, 0, 0)
  return weld(g)
}

// Snap-on top-hinged box ("chest" style). Unlike the fold-flat design the two
// parts print SEPARATELY (print the lid top-side down) and assemble with one
// press: the lid's C-shaped knuckles snap over the box's hinge pin — the same
// downward push also clicks the front bead into its groove. So the box + lid
// are modelled ASSEMBLED in the closed position, and the exporters pull them
// apart (like the sliding box).
//
//   side view (closed / as modelled):
//                       arm ╻ ◎ ← pin in C-knuckle (lid) / boss column (box)
//     ╔══ lid panel ══════╗ ╱ 45° gusset anchors the boss to the back wall
//     ║ ┌─────────────────╨─┐
//    lip│        box        │
//       └───────────────────┘
//
// The hinge axis sits ABOVE the lid plane and BEHIND the back wall
// (axisY = outerH + lidT + axisLift, axisZ = zBack − barrelR − c). The lift is
// load-bearing, not styling: when the lid opens, the panel's back corners
// sweep circles about the axis and cross the boss front plane at a height of
// (their printed depth below the axis) above it — only an axis lifted past the
// boss top keeps those crossings in free air. With the axis at panel height
// every possible pin support collides with either the closed panel or its
// swing. Don't lower axisLift below (bossTop − axisY) + margin.
function buildTopHingedBox(m: BoxModel): BuiltBox {
  const wall = m.wall
  const c = m.clearance
  const lidT = m.lidThickness

  const floorH = wall
  const outerW = m.innerW + 2 * wall
  const outerD = m.innerD + 2 * wall
  const outerH = floorH + m.innerH

  const zFront = outerD / 2
  const zBack = -outerD / 2

  const { pinR, boreGap, barrelR } = hingeStock(m)
  const axisLift = pinR + 1.7 // axis height above the lid top — see header note
  const axisY = outerH + lidT + axisLift
  const axisZ = zBack - barrelR - c // behind the wall so knuckles clear it by c
  const bossTop = axisY + pinR + 1.2 // 1.2 of material over the pin

  const knuckleCount = 5
  const knuckleW = m.innerW / knuckleCount
  const kGap = Math.max(0.3, c)

  const lipWall = Math.max(1, wall * 0.6)
  const lipH = Math.max(2, m.innerH * 0.15)
  const beadR = 0.6
  const grooveY = outerH - lipH / 2 // snap groove/bead height, mid-lip

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

  // Boss columns (box knuckle bands): hold the pin above/behind the top back
  // edge. Profile in (z, y): anchored EPS into the wall below the rim, stepped
  // 0.25 behind the wall plane above it (the closed panel's back edge passes
  // at zBack), flat top over the pin, and a ≥45° gusset underside so the
  // column prints supportless off the back wall.
  const bossBackZ = axisZ - pinR - 1.2
  const gussetTopY = outerH - 1
  const gussetBotY = Math.max(0.5, gussetTopY - (zBack + EPS - bossBackZ))
  const bossPts: [number, number][] = [
    [zBack + EPS, gussetBotY],
    [zBack + EPS, outerH - 0.5],
    [zBack - 0.25, outerH - 0.5],
    [zBack - 0.25, bossTop],
    [bossBackZ, bossTop],
    [bossBackZ, gussetTopY],
  ]
  for (let i = 0; i < knuckleCount; i += 2) {
    const cx = -m.innerW / 2 + knuckleW * (i + 0.5)
    const w = knuckleW - kGap
    body = csgAdd(body, prismX(bossPts, cx - w / 2, w))
  }
  // Pin: one rod through all bosses, exposed in the lid bands for the C-clips.
  body = csgAdd(body, cylinderX(pinR, m.innerW + EPS, 0, axisY, axisZ))

  // Front snap groove: a half-round channel in the front face that the lid's
  // bead clicks into (the lip flexes ~beadR−c over the wall face on the way).
  body = csgSubtract(body, cylinderX(beadR + 0.15, m.innerW * 0.5 + 2, 0, grooveY, zFront))

  body = weld(body)

  // Outer-wall texture, below the lip band (see the fold-flat builder). Back
  // wall plain: boss columns, gussets and the panel's back-edge swing are there.
  body = applyTextures(
    body,
    wallRegions(outerW, outerD, { left: outerH - lipH, right: outerH - lipH, front: outerH - lipH, back: null }),
    m.texture.sides, 'wall', wall, m.texture.layerHeight,
  )
  body.computeBoundingBox()

  // --- Lid (modelled closed: panel on the rim, lip wrapping the walls) ------
  const lidPanelW = outerW + 2 * (c + lipWall)
  const panelD = outerD + c + lipWall // back rim edge → front lip outer face
  const panelZc = zBack + panelD / 2
  let lid = box(lidPanelW, lidT, panelD, 0, outerH + lidT / 2, panelZc)

  // Downward lip on the 3 non-hinge edges + the snap bead on the front lip.
  const lipRailH = lipH + lidT
  const lipYc = outerH + lidT - lipRailH / 2
  const lipFrontZ = zFront + c + lipWall / 2
  lid = csgAdd(lid, box(lidPanelW, lipRailH, lipWall, 0, lipYc, lipFrontZ))
  for (const sx of [-1, 1]) {
    const lx = sx * (lidPanelW / 2 - lipWall / 2)
    lid = csgAdd(lid, box(lipWall, lipRailH, panelD, lx, lipYc, panelZc))
  }
  lid = csgAdd(lid, cylinderX(beadR, m.innerW * 0.5, 0, grooveY, zFront + c))

  // C-knuckles + arms (lid knuckle bands). Each is a barrel on the axis with
  // the pin bore and a snap mouth cut from below — the mouth is narrower than
  // the pin, so pressing the lid down flexes the C's arms over the pin and
  // clicks on. The arm bridging knuckle → panel starts a play margin behind
  // the pin's press channel (z > axisZ + pinR) or it would ram the pin before
  // the C engages.
  const boreR = pinR + boreGap
  const mouthW = 1.6 * pinR
  const armZ0 = axisZ + pinR + 0.4
  const armZ1 = zBack + 1.5 // overlaps the panel over the back rim
  for (let i = 1; i < knuckleCount; i += 2) {
    const cx = -m.innerW / 2 + knuckleW * (i + 0.5)
    const w = knuckleW - kGap
    let k = cylinderX(barrelR, w, cx, axisY, axisZ)
    k = csgAdd(k, box(w, axisY + 1 - outerH, armZ1 - armZ0, cx, (axisY + 1 + outerH) / 2, (armZ0 + armZ1) / 2))
    k = csgSubtract(k, cylinderX(boreR, w + 1, cx, axisY, axisZ))
    const slotTop = axisY - pinR * 0.5 // reaches into the bore, below centre → ~270° wrap
    const slotBot = axisY - barrelR - 1
    k = csgSubtract(k, box(w + 1, slotTop - slotBot, mouthW, cx, (slotTop + slotBot) / 2, axisZ))
    lid = csgAdd(lid, k)
  }

  lid = weld(lid)

  // Lid-top texture. Modelled closed (face up) but exported top-side down, so
  // a 'bed-face': recessed only, whole layers. The BORDER inset from the back
  // edge also clears the knuckle arms, which rise above the panel to armZ1.
  lid = applyTextures(
    lid,
    [faceRegion([-lidPanelW / 2, outerH + lidT, zBack + panelD], [1, 0, 0], [0, 0, -1], lidPanelW, panelD)],
    m.texture.top, 'bed-face', lidT, m.texture.layerHeight,
  )
  lid.computeBoundingBox()

  const sz = boxOuterSize(m)
  return { box: body, lid, size: { x: sz.x, y: sz.y, z: sz.z } }
}
