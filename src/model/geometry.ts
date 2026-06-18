import * as THREE from 'three'
import { GRIDFINITY, BinModel, resolvedSize } from './types'
import { csgAdd, csgSubtract, weld } from './csg'

// Small overlap so additive parts interpenetrate (never merely touch). Coplanar
// contact in CSG yields open edges; a sliver of overlap forces a clean cut that
// the final weld pass then stitches into one manifold.
const EPS = 0.05

// Build a watertight, printable bin mesh using CSG. Pipeline:
//   1. Solid outer body (rounded box) + chamfered Gridfinity feet (per grid cell)
//   2. Subtract the interior cavity to create the walls and floor
//   3. Add dividers, then subtract scoop ramps; add label tabs
//   4. Subtract magnet / screw sockets from the underside
//   5. Add the stacking lip
//
// Y is up in the viewport; the build plate is Y = 0. Exporters rotate to Z-up.
//
// CSG is comparatively expensive, so callers should debounce regeneration.

export interface BuiltBin {
  geometry: THREE.BufferGeometry
  size: { x: number; y: number; z: number }
}

// --- primitives -----------------------------------------------------------

// Rounded-rectangle prism extruded along Y, centred on X/Z, base at y=y0.
function roundedPrism(
  w: number,
  d: number,
  h: number,
  radius: number,
  y0: number,
): THREE.BufferGeometry {
  const r = Math.max(0, Math.min(radius, w / 2 - 0.01, d / 2 - 0.01))
  const shape = new THREE.Shape()
  const x = w / 2
  const z = d / 2
  shape.moveTo(-x + r, -z)
  shape.lineTo(x - r, -z)
  shape.quadraticCurveTo(x, -z, x, -z + r)
  shape.lineTo(x, z - r)
  shape.quadraticCurveTo(x, z, x - r, z)
  shape.lineTo(-x + r, z)
  shape.quadraticCurveTo(-x, z, -x, z - r)
  shape.lineTo(-x, -z + r)
  shape.quadraticCurveTo(-x, -z, -x + r, -z)
  const geom = new THREE.ExtrudeGeometry(shape, {
    depth: h,
    bevelEnabled: false,
    curveSegments: 6,
  })
  // ExtrudeGeometry lies in the XY plane and extrudes along +Z (z in [0, h]).
  // Rotate −90° about X so +Z maps to +Y (y' = z): a point at z=h lands at y=h.
  geom.rotateX(-Math.PI / 2)
  // Now the prism spans y in [0, h]; lift it so its base sits at y0.
  geom.translate(0, y0, 0)
  // ExtrudeGeometry leaves cap and wall vertices unwelded, which makes it a
  // non-manifold input that corrupts CSG. Weld it closed before any boolean op.
  return weld(geom, 1e-4)
}

function box(w: number, h: number, d: number, cx: number, cy: number, cz: number) {
  const g = new THREE.BoxGeometry(w, h, d)
  g.translate(cx, cy, cz)
  return g
}

function cylinderY(radius: number, h: number, cx: number, cy: number, cz: number) {
  const g = new THREE.CylinderGeometry(radius, radius, h, 24)
  g.translate(cx, cy, cz)
  return g
}

// One Gridfinity foot for a single grid cell, built as a lathe of the 3-step
// chamfer profile and intersected to the cell footprint via a rounded prism.
// For simplicity and manifold safety we approximate the foot as a stack of three
// rounded prisms (bottom chamfer / straight / top chamfer) — visually faithful
// to the real profile and fully watertight.
function gridFoot(cellW: number, cellD: number, cx: number, cz: number): THREE.BufferGeometry {
  const { bottomChamfer, straight, topChamfer } = GRIDFINITY.foot
  const r = GRIDFINITY.cornerRadius
  const fullInset = bottomChamfer + topChamfer // total horizontal pull-in at bottom
  const parts: THREE.BufferGeometry[] = []

  // Bottom chamfer: from (cell - 2*fullInset) up to (cell - 2*topChamfer)
  const bw0 = cellW - 2 * fullInset
  const bd0 = cellD - 2 * fullInset
  parts.push(roundedPrism(bw0, bd0, bottomChamfer, Math.max(0.5, r - fullInset), 0))

  // Straight mid section at (cell - 2*topChamfer)
  const sw = cellW - 2 * topChamfer
  const sd = cellD - 2 * topChamfer
  parts.push(roundedPrism(sw, sd, straight, Math.max(0.5, r - topChamfer), bottomChamfer))

  // Top chamfer: rises to full cell footprint, overshooting up into the body so
  // foot and body interpenetrate rather than touch coplanar at y = baseH.
  parts.push(roundedPrism(cellW, cellD, topChamfer + EPS, r, bottomChamfer + straight))

  const foot = csgAdd(...parts)
  foot.translate(cx, 0, cz)
  return foot
}

// --- main build -----------------------------------------------------------

export function buildBin(m: BinModel): BuiltBin {
  const { x: sx, y: sy, z: sz } = resolvedSize(m)
  const ow = m.outerWall
  const floorH = Math.max(ow, 1.0)
  const gf = m.gridfinity // Gridfinity features (foot, clearance, sockets)
  const gridded = !m.customSize // sized by unit counts (needed for per-cell layout)
  const baseH = gf ? GRIDFINITY.baseHeight : 0
  const radius = gf ? GRIDFINITY.cornerRadius : Math.min(2, ow * 1.5)

  // 1) Outer body (above the feet) ----------------------------------------
  const bodyH = sz
  let solid = roundedPrism(sx, sy, bodyH, radius, baseH)

  // Feet: a chamfered Gridfinity foot per grid cell when sized by units, or a
  // single foot spanning the footprint for a custom-sized Gridfinity bin. Plain
  // trays (gridfinity off) get no foot — they sit flat on the build plate.
  if (gf) {
    const feet: THREE.BufferGeometry[] = []
    if (gridded) {
      const cellW = m.gridUnit - GRIDFINITY.clearance
      const cellD = m.gridUnit - GRIDFINITY.clearance
      for (let ix = 0; ix < m.unitsX; ix++) {
        for (let iy = 0; iy < m.unitsY; iy++) {
          const cx = -sx / 2 + cellW / 2 + ix * m.gridUnit
          const cz = -sy / 2 + cellD / 2 + iy * m.gridUnit
          feet.push(gridFoot(cellW, cellD, cx, cz))
        }
      }
    } else {
      feet.push(gridFoot(sx, sy, 0, 0))
    }
    solid = csgAdd(solid, ...feet)
  }

  // 2) Hollow out the interior cavity --------------------------------------
  const cavityW = sx - 2 * ow
  const cavityD = sy - 2 * ow
  const cavityH = bodyH - floorH + 1 // overshoot the top so the opening is clean
  const cavityBottom = baseH + floorH
  const cavity = roundedPrism(
    cavityW,
    cavityD,
    cavityH,
    Math.max(0.5, radius - ow),
    cavityBottom,
  )
  let geo = csgSubtract(solid, cavity)

  // Interior span used to place dividers / features
  const innerX = cavityW
  const innerY = cavityD
  const wallTop = baseH + bodyH
  const wallH = wallTop - cavityBottom

  // 3a) Dividers ------------------------------------------------------------
  // Sized to overlap the floor (extend down) and both walls (span past inner
  // edges) so each divider fuses to the shell instead of touching it coplanar.
  const dThick = m.innerWall
  const dH = wallH + EPS // dip into the floor
  const dyc = cavityBottom + wallH / 2 - EPS / 2 // centre shifted down by the dip
  const spanX = innerX + 2 * ow // reach into the left/right walls
  const spanY = innerY + 2 * ow // reach into the front/back walls
  const adds: THREE.BufferGeometry[] = []
  for (const d of m.dividers) {
    const p = Math.min(0.95, Math.max(0.05, d.position))
    if (d.axis === 'x') {
      const xc = -innerX / 2 + p * innerX
      adds.push(box(dThick, dH, spanY, xc, dyc, 0))
    } else {
      const zc = -innerY / 2 + p * innerY
      adds.push(box(spanX, dH, dThick, 0, dyc, zc))
    }
  }
  if (adds.length) geo = csgAdd(geo, ...adds)

  // Compute compartment bands along Y (depth) for scoop/label placement.
  // Dividers on the 'y' axis split depth into bands; 'x' dividers split width.
  const yCuts = [0, ...m.dividers.filter((d) => d.axis === 'y').map((d) => d.position), 1]
    .sort((a, b) => a - b)
  const xCuts = [0, ...m.dividers.filter((d) => d.axis === 'x').map((d) => d.position), 1]
    .sort((a, b) => a - b)

  // 3b) Scoop ramps — a quarter-cylinder cut along the back (−Z) wall of each
  // compartment, giving a curved floor to sweep contents out.
  if (m.scoop) {
    const scoopTools: THREE.BufferGeometry[] = []
    const scoopR = Math.min(wallH * 0.9, innerY * 0.4)
    for (let xi = 0; xi < xCuts.length - 1; xi++) {
      const cx0 = -innerX / 2 + xCuts[xi] * innerX + dThick / 2
      const cx1 = -innerX / 2 + xCuts[xi + 1] * innerX - dThick / 2
      const cw = cx1 - cx0
      if (cw <= 1) continue
      const cxMid = (cx0 + cx1) / 2
      for (let yi = 0; yi < yCuts.length - 1; yi++) {
        const backZ = -innerY / 2 + yCuts[yi] * innerY + dThick / 2
        // Cylinder axis along X, placed at the back wall, radius up from floor.
        const cyl = new THREE.CylinderGeometry(scoopR, scoopR, cw, 24)
        cyl.rotateZ(Math.PI / 2) // axis -> X
        cyl.translate(cxMid, cavityBottom + scoopR, backZ + scoopR)
        scoopTools.push(cyl)
      }
    }
    if (scoopTools.length) geo = csgSubtract(geo, ...scoopTools)
  }

  // 3c) Label tab — a flat overhang ledge along the back top edge of each depth
  // band (the classic Gridfinity grab/label feature). Built as an axis-aligned
  // box that starts embedded in the back wall and reaches forward over the
  // compartment, overlapping the shell so it fuses cleanly.
  if (m.label) {
    const labelAdds: THREE.BufferGeometry[] = []
    const tabDepth = 12
    const tabH = 1.2
    for (let yi = 0; yi < yCuts.length - 1; yi++) {
      // back edge of this band (interior face of the −Y wall, or a divider)
      const bandBackInner = -innerY / 2 + yCuts[yi] * innerY + (yi === 0 ? 0 : dThick / 2)
      // start ow behind the inner face (inside the wall) and run forward tabDepth
      const z0 = bandBackInner - ow
      const z1 = bandBackInner + tabDepth
      const depth = z1 - z0
      const tab = box(spanX, tabH, depth, 0, wallTop - tabH / 2, (z0 + z1) / 2)
      labelAdds.push(tab)
    }
    if (labelAdds.length) geo = csgAdd(geo, ...labelAdds)
  }

  // 4) Magnet / screw sockets in the underside of each foot ----------------
  // Only meaningful for a grid-laid-out Gridfinity bin (sockets sit at cell
  // corners). Plain trays and custom-sized bins skip this.
  if (gf && gridded && (m.magnets !== 'none' || m.screws !== 'none')) {
    const tools: THREE.BufferGeometry[] = []
    const cellW = m.gridUnit - GRIDFINITY.clearance
    const inset = GRIDFINITY.socketInset
    for (let ix = 0; ix < m.unitsX; ix++) {
      for (let iy = 0; iy < m.unitsY; iy++) {
        const cx0 = -sx / 2 + cellW / 2 + ix * m.gridUnit
        const cz0 = -sy / 2 + cellW / 2 + iy * m.gridUnit
        const offs = inset - cellW / 2 // negative => toward corner
        const corners = [
          [cx0 - (cellW / 2 - inset), cz0 - (cellW / 2 - inset)],
          [cx0 + (cellW / 2 - inset), cz0 - (cellW / 2 - inset)],
          [cx0 - (cellW / 2 - inset), cz0 + (cellW / 2 - inset)],
          [cx0 + (cellW / 2 - inset), cz0 + (cellW / 2 - inset)],
        ]
        void offs
        const pick = (style: typeof m.magnets) =>
          style === 'full' ? corners : style === 'corner'
            ? (ix === 0 || ix === m.unitsX - 1) && (iy === 0 || iy === m.unitsY - 1)
              ? corners
              : []
            : []
        // Magnets: shallow wide bore from the very bottom
        for (const [px, pz] of pick(m.magnets)) {
          tools.push(
            cylinderY(GRIDFINITY.magnetDiameter / 2, GRIDFINITY.magnetDepth + 0.2,
              px, GRIDFINITY.magnetDepth / 2 - 0.1, pz),
          )
        }
        // Screws: narrow deeper bore, concentric
        for (const [px, pz] of pick(m.screws)) {
          tools.push(
            cylinderY(GRIDFINITY.screwDiameter / 2, GRIDFINITY.screwDepth + 0.2,
              px, GRIDFINITY.screwDepth / 2 - 0.1, pz),
          )
        }
      }
    }
    if (tools.length) geo = csgSubtract(geo, ...tools)
  }

  // 5) Stacking lip ---------------------------------------------------------
  let lipH = 0
  if (m.lip !== 'none') {
    lipH = m.lip === 'thin' ? GRIDFINITY.lipHeight * 0.55 : GRIDFINITY.lipHeight
    const lipT = m.lip === 'thin' ? ow * 0.6 : ow
    // Lip = thin rounded frame (outer prism minus inner prism), overlapping the
    // body top by EPS so it fuses rather than sits coplanar.
    const outer = roundedPrism(sx, sy, lipH + EPS, radius, wallTop - EPS)
    const inner = roundedPrism(
      sx - 2 * lipT,
      sy - 2 * lipT,
      lipH + 1,
      Math.max(0.5, radius - lipT),
      wallTop - 0.5,
    )
    const lip = csgSubtract(outer, inner)
    geo = csgAdd(geo, lip)
  }

  // Final weld: stitch all the boolean seams into one closed manifold mesh.
  geo = weld(geo)
  geo.computeBoundingBox()
  return { geometry: geo, size: { x: sx, y: sy, z: wallTop + lipH } }
}
