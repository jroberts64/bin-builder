import * as THREE from 'three'
import { csgIntersect, csgSubtract, weld } from './csg'
import {
  clamp,
  clamp01,
  ditherGrid,
  getGray,
  heightfieldMesh,
  prepareImage,
  sampleLum,
  thicknessForLuminance,
} from './relief'

// Lithophane: an image embossed as varying thickness in a thin panel, so it
// reveals the picture when backlit. A SINGLE watertight mesh (like the bin and
// skadis holder), so it exports as one STL / one 3MF object. The panel shape and
// its placement live here; the image cache, the heightmap mesh builder and the
// dithering are shared with the fan and live in `relief.ts`.
//
// Modelled Y-up standing on Y=0 like a framed picture on the plate: width along
// X, image height along Y, thickness along Z. The flat back is the z=0 plane and
// the relief rises toward +Z (the default camera). The exporter's Y→Z rotation
// keeps it standing in the slicer — the recommended print orientation for
// lithophanes (vertical, so layer lines don't blur the image).
//
// Unlike the other builders this is mostly NOT CSG: the panel is a heightmap
// grid emitted directly as a closed, manifold-by-construction mesh (relief
// front, flat back, perimeter walls). CSG only trims the outline (round /
// rounded-rect) and cuts the optional mounting hole.

export type LithoShape = 'rect' | 'round'

// How the panel is placed for printing. This is a real design decision, not just
// a slicer convenience — it swaps which printer axis carries tone and which
// carries detail:
//   'flat'     — panel on its back, relief up. Tone is built up in layers, so it
//                is quantised by layer height (~12 greys over a 0.8–3mm range at
//                0.2mm layers, ~23 at 0.1mm); detail in the picture plane is
//                limited by extrusion width. Fast, no brim, no overhangs; smooth
//                gradients can band.
//   'standing' — panel on its bottom edge. The slicer varies wall width across
//                the 0.8–3mm wall, so tone is effectively continuous and vertical
//                detail gets the layer height — but it is a tall thin print
//                (~1000 layers for a 200mm panel) that wants a brim.
export type LithoOrientation = 'flat' | 'standing'

export interface LithoModel {
  shape: LithoShape
  image: string | null // source image as a data URL (persisted, but never in share links)
  width: number // mm, panel width X (diameter for round)
  height: number // mm, panel height Y (rect only)
  cornerRadius: number // mm, rect only (0 = sharp)
  minThickness: number // mm, thickness of the lightest areas
  maxThickness: number // mm, thickness of the darkest areas
  pitch: number // mm per relief sample (lower = finer detail, bigger mesh)
  invert: boolean // flip light/dark (e.g. for a negative)
  tone: number // %, Beer–Lambert tone correction (0 = the raw linear ramp)
  mountHole: boolean // through-hole near the top edge for hanging
  mountHoleDiameter: number // mm
  orientation: LithoOrientation // how it's placed for preview + export
  dither: boolean // flat only: quantise the relief to layer steps + error diffusion
  layerHeight: number // mm, the slicer layer height dithering quantises to
}

export function defaultLitho(): LithoModel {
  return {
    shape: 'rect',
    image: null,
    width: 100,
    height: 75,
    cornerRadius: 4,
    minThickness: 0.8,
    maxThickness: 3,
    pitch: 0.3,
    invert: false,
    tone: 100,
    mountHole: false,
    mountHoleDiameter: 4,
    orientation: 'flat',
    dither: true,
    layerHeight: 0.2,
  }
}

export interface BuiltLitho {
  geometry: THREE.BufferGeometry
  size: { x: number; y: number; z: number }
}

// A standing circle would touch the plate at a single point, so round panels get
// a flat chord cut at the bottom to print on.
const ROUND_FLAT = 3
// Cap the sample grid so a big panel + fine pitch can't build a mesh too heavy
// to preview interactively (~2 triangles per cell on the front face).
const MAX_CELLS = 160_000
// The heightmap grid overshoots the outline by this much before the CSG trim so
// the trim is a clean cut, never a coplanar graze of the grid's own walls.
const MARGIN = 2

// The visible panel height: rect panels are as tall as set; round panels lose
// the bottom chord flat.
export function panelHeight(m: LithoModel): number {
  return m.shape === 'round' ? m.width - ROUND_FLAT : m.height
}

// Outer size in the VIEWPORT's axes (Y up), so the dims readout matches how the
// preview is placed: standing puts the image height up, flat puts the thickness up.
export function lithoOuterSize(m: LithoModel): { x: number; y: number; z: number } {
  const h = panelHeight(m)
  const t = effMaxThickness(m)
  return m.orientation === 'flat' ? { x: m.width, y: t, z: h } : { x: m.width, y: h, z: t }
}

// The panel is always MODELLED standing (Y = image height, Z = thickness) because
// that matches the viewport's Y-up-on-Y=0 convention. Placing it for preview is
// therefore a no-op when standing, and a lie-down when flat. Mutates in place —
// callers pass a freshly built geometry.
export function orientLithoForPreview(
  geom: THREE.BufferGeometry,
  m: LithoModel,
): THREE.BufferGeometry {
  if (m.orientation === 'standing') return geom
  geom.rotateX(-Math.PI / 2) // height +Y -> depth -Z, thickness +Z -> up +Y
  geom.translate(0, 0, panelHeight(m) / 2) // centre the footprint on the plate
  geom.computeBoundingBox()
  return geom
}

function effMaxThickness(m: LithoModel): number {
  return Math.max(m.maxThickness, m.minThickness + 0.2)
}

// The image decode is async but buildLitho is sync, so the decoded grayscale
// lives in relief.ts's cache: await this before buildLitho (Viewport and the
// export paths do).
export const prepareLithoImage = (m: LithoModel) => prepareImage(m.image)

// Thickness at panel-space (u,v), u/v ∈ [0,1] with v=0 at the BOTTOM of the
// panel. The image covers the panel like CSS `object-fit: cover` — scaled to
// fill, overflow cropped — so it never distorts regardless of panel aspect.
// Dark = thick (blocks light); `invert` flips. No image → a uniform mid-plate.
function thicknessSampler(m: LithoModel, panelW: number, panelH: number): (u: number, v: number) => number {
  const minT = m.minThickness
  const maxT = effMaxThickness(m)
  if (!m.image) {
    const mid = (minT + maxT) / 2
    return () => mid
  }
  const gray = getGray(m.image)
  const { w, h } = gray
  const ia = w / h
  const pa = panelW / panelH
  const su = ia > pa ? pa / ia : 1 // crop left/right when the image is wider
  const sv = ia > pa ? 1 : ia / pa // crop top/bottom when it's taller
  return (u, v) => {
    const px = clamp01(0.5 + (u - 0.5) * su) * (w - 1)
    const py = clamp01(1 - (0.5 + (v - 0.5) * sv)) * (h - 1) // image row 0 = top
    const l = sampleLum(gray, px, py)
    return thicknessForLuminance(m.invert ? 1 - l : l, minT, maxT, m.tone)
  }
}

// --- outline ---------------------------------------------------------------

// The panel outline in the XY plane (y up from 0), extruded along +Z into the
// trimming prism. Round is a circle with the bottom chord cut flat; rect uses
// the same rounded construction as the other builders (radius 0 = sharp, in
// which case the caller skips the trim entirely).
function outlinePrism(m: LithoModel, zTop: number): THREE.BufferGeometry {
  const s = new THREE.Shape()
  let curveSegments = 8
  if (m.shape === 'round') {
    curveSegments = 64
    const R = m.width / 2
    const cy = R - ROUND_FLAT // circle centre; the part below y=0 is the chord flat
    const cx0 = Math.sqrt(Math.max(0.01, R * R - cy * cy)) // chord half-width at y=0
    const a0 = Math.atan2(-cy, cx0)
    const a1 = Math.atan2(-cy, -cx0)
    s.absarc(0, cy, R, a0, a1, false) // CCW over the top, (cx0,0) → (−cx0,0)
    s.closePath() // straight chord back along y=0
  } else {
    const x = m.width / 2
    const h = m.height
    const rr = clamp(m.cornerRadius, 0, Math.min(x - 0.01, h / 2 - 0.01))
    s.moveTo(-x + rr, 0)
    s.lineTo(x - rr, 0)
    s.quadraticCurveTo(x, 0, x, rr)
    s.lineTo(x, h - rr)
    s.quadraticCurveTo(x, h, x - rr, h)
    s.lineTo(-x + rr, h)
    s.quadraticCurveTo(-x, h, -x, h - rr)
    s.lineTo(-x, rr)
    s.quadraticCurveTo(-x, 0, -x + rr, 0)
  }
  const geom = new THREE.ExtrudeGeometry(s, { depth: zTop + 2, bevelEnabled: false, curveSegments })
  geom.translate(0, 0, -1) // span z ∈ [-1, zTop+1], past both panel faces
  return weld(geom)
}

// --- main build --------------------------------------------------------------

export function buildLitho(m: LithoModel): BuiltLitho {
  const round = m.shape === 'round'
  const maxT = effMaxThickness(m)
  const panelH = round ? m.width - ROUND_FLAT : m.height
  const needTrim = round || m.cornerRadius > 0.05
  const mg = needTrim ? MARGIN : 0

  // Grid extent: the panel plus (when trimming) an overshoot margin.
  const gx0 = -m.width / 2 - mg
  const gw = m.width + 2 * mg
  const gy0 = -mg
  const gh = panelH + 2 * mg

  // Effective pitch, backed off if the requested one would blow the cell cap.
  const pitch = Math.max(m.pitch, Math.sqrt((gw * gh) / MAX_CELLS))
  const nx = Math.max(2, Math.round(gw / pitch) + 1)
  const ny = Math.max(2, Math.round(gh / pitch) + 1)

  // World (x,y) → image-space (u,v). Round maps against the FULL circle bounding
  // box (the ideal circle dips ROUND_FLAT below y=0) so the crop stays centred
  // on the circle, not on the flattened visible part.
  const thick = thicknessSampler(m, m.width, round ? m.width : m.height)
  const zRaw = round
    ? (x: number, y: number) => thick((x + m.width / 2) / m.width, (y + ROUND_FLAT) / m.width)
    : (x: number, y: number) => thick((x + m.width / 2) / m.width, y / m.height)

  // Dithering only makes sense FLAT, where the relief is the layer stack. Printed
  // standing, thickness is drawn horizontally by varying wall width — there are no
  // layer steps in the tone to dither away, and quantising would only throw
  // resolution away. So the flag is deliberately a no-op when standing.
  let zAt: (x: number, y: number, i: number, j: number) => number = (x, y) => zRaw(x, y)
  if (m.dither && m.orientation === 'flat') {
    const raw = new Float32Array(nx * ny)
    const dx = gw / (nx - 1)
    const dy = gh / (ny - 1)
    for (let j = 0; j < ny; j++) {
      for (let i = 0; i < nx; i++) raw[j * nx + i] = zRaw(gx0 + i * dx, gy0 + j * dy)
    }
    const dithered = ditherGrid(nx, ny, raw, m.layerHeight, m.minThickness, maxT)
    if (dithered) zAt = (_x, _y, i, j) => dithered[j * nx + i]
  }

  let geo = heightfieldMesh(gx0, gy0, gw, gh, nx, ny, zAt)

  if (needTrim) {
    geo = csgIntersect(geo, outlinePrism(m, maxT))
  }

  if (m.mountHole) {
    const r = m.mountHoleDiameter / 2
    const topY = panelH
    const cyl = new THREE.CylinderGeometry(r, r, maxT + 2, 48)
    cyl.rotateX(Math.PI / 2) // cylinder axis Y → Z (through the panel)
    cyl.translate(0, topY - 2.5 - r, maxT / 2) // 2.5mm rim below the top edge
    geo = csgSubtract(geo, weld(cyl))
  }

  // NO final weld() here — deliberately, unlike the other builders. Whatever
  // reaches this point is already indexed and manifold (a heightfield built that
  // way by construction, or a Manifold CSG result), and weld() is *destructive*
  // on it. Trimming a fine relief grid against the outline leaves pinch points
  // where two topologically distinct vertices share one position; merging those
  // fuses separate corners into edges shared by 3+ triangles (measured: 20
  // non-manifold edges on a 140×200mm r4 photo panel, 0 without the weld).
  //
  // Consequence for verification: those coincident-position pairs mean a
  // position-quantizing edge check REPORTS FALSE non-manifold edges on litho
  // meshes (it re-does the very merge we avoid). Check litho output with the
  // exact index-based edge test on the indexed geometry instead; the mesh is
  // edge-manifold (every edge in exactly 2 triangles), which is what slicers and
  // 3MF/STL require, even though a few vertices are bowties.
  geo.computeBoundingBox()

  return { geometry: geo, size: { x: m.width, y: panelH, z: maxT } }
}
