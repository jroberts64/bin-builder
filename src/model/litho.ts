import * as THREE from 'three'
import { csgIntersect, csgSubtract, weld } from './csg'

// Lithophane: an image embossed as varying thickness in a thin panel, so it
// reveals the picture when backlit. A SINGLE watertight mesh (like the bin and
// skadis holder), so it exports as one STL / one 3MF object. Self-contained
// module — keep the litho geometry here.
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
  mountHole: boolean // through-hole near the top edge for hanging
  mountHoleDiameter: number // mm
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
    mountHole: false,
    mountHoleDiameter: 4,
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

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const clamp01 = (v: number) => clamp(v, 0, 1)

// The visible panel height: rect panels are as tall as set; round panels lose
// the bottom chord flat.
export function lithoOuterSize(m: LithoModel): { x: number; y: number; z: number } {
  const h = m.shape === 'round' ? m.width - ROUND_FLAT : m.height
  return { x: m.width, y: h, z: effMaxThickness(m) }
}

function effMaxThickness(m: LithoModel): number {
  return Math.max(m.maxThickness, m.minThickness + 0.2)
}

// --- image decode + cache ---------------------------------------------------

// Decoding a data URL is async (browser image pipeline), but buildLitho must be
// synchronous like the other builders. So the grayscale image lives in a
// single-entry cache keyed by the data URL: await prepareLithoImage() first
// (Viewport and the export paths do), then buildLitho reads it synchronously —
// the same shape as the initCSG()/buildBin contract.

interface GrayImage {
  w: number
  h: number
  lum: Float32Array // luminance 0..1, row 0 = image top
}

let grayCache: { key: string; gray: GrayImage } | null = null

export async function prepareLithoImage(m: LithoModel): Promise<void> {
  const src = m.image
  if (!src || grayCache?.key === src) return
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('litho image failed to decode'))
    img.src = src
  })
  const w = img.naturalWidth
  const h = img.naturalHeight
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff' // transparent pixels read as white (thin), not black
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(img, 0, 0)
  const data = ctx.getImageData(0, 0, w, h).data
  const lum = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) {
    lum[i] = (0.2126 * data[i * 4] + 0.7152 * data[i * 4 + 1] + 0.0722 * data[i * 4 + 2]) / 255
  }
  grayCache = { key: src, gray: { w, h, lum } }
}

// Downscale an uploaded image file to a compact data URL for embedding in the
// design (longest side ≤ 800px — finer than any printable relief pitch — JPEG
// on a white underlay). Returns the pixel size too so the caller can match the
// panel aspect to the image.
export async function imageFileToDataURL(
  file: File,
): Promise<{ dataUrl: string; width: number; height: number }> {
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, 800 / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, w, h)
  ctx.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  return { dataUrl: canvas.toDataURL('image/jpeg', 0.85), width: w, height: h }
}

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
  if (grayCache?.key !== m.image) {
    throw new Error('litho image not decoded — await prepareLithoImage() first')
  }
  const { w, h, lum } = grayCache.gray
  const ia = w / h
  const pa = panelW / panelH
  const su = ia > pa ? pa / ia : 1 // crop left/right when the image is wider
  const sv = ia > pa ? 1 : ia / pa // crop top/bottom when it's taller
  return (u, v) => {
    const x = clamp01(0.5 + (u - 0.5) * su) * (w - 1)
    const y = clamp01(1 - (0.5 + (v - 0.5) * sv)) * (h - 1) // image row 0 = top
    const x0 = Math.floor(x)
    const y0 = Math.floor(y)
    const x1 = Math.min(x0 + 1, w - 1)
    const y1 = Math.min(y0 + 1, h - 1)
    const fx = x - x0
    const fy = y - y0
    const l =
      lum[y0 * w + x0] * (1 - fx) * (1 - fy) +
      lum[y0 * w + x1] * fx * (1 - fy) +
      lum[y1 * w + x0] * (1 - fx) * fy +
      lum[y1 * w + x1] * fx * fy
    const dark = m.invert ? l : 1 - l
    return minT + (maxT - minT) * dark
  }
}

// --- heightmap mesh ---------------------------------------------------------

// A closed heightmap slab over [x0,x0+w]×[y0,y0+h]: relief front at z=zAt(x,y),
// flat back on z=0, perimeter walls. Manifold by construction — every edge is
// shared by exactly two triangles: front grid edges pair with each other and
// with the walls; back ring edges pair walls with a centre-fan back face (the
// back only needs its boundary to match the walls, so its interior is one fan
// vertex, halving the mesh vs mirroring the grid).
function heightfieldMesh(
  x0: number,
  y0: number,
  w: number,
  h: number,
  nx: number,
  ny: number,
  zAt: (x: number, y: number) => number,
): THREE.BufferGeometry {
  const dx = w / (nx - 1)
  const dy = h / (ny - 1)
  const nFront = nx * ny
  const ringLen = 2 * (nx + ny) - 4

  const positions = new Float32Array((nFront + ringLen + 1) * 3)
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const x = x0 + i * dx
      const y = y0 + j * dy
      const k = (j * nx + i) * 3
      positions[k] = x
      positions[k + 1] = y
      positions[k + 2] = zAt(x, y)
    }
  }

  // Perimeter ring, CCW viewed from +Z (each corner exactly once).
  const ring: number[] = []
  for (let i = 0; i < nx; i++) ring.push(i) // bottom, left→right
  for (let j = 1; j < ny; j++) ring.push(j * nx + (nx - 1)) // right, up
  for (let i = nx - 2; i >= 0; i--) ring.push((ny - 1) * nx + i) // top, right→left
  for (let j = ny - 2; j >= 1; j--) ring.push(j * nx) // left, down

  // Back copies of the ring at z=0, plus one centre vertex for the back fan.
  for (let k = 0; k < ringLen; k++) {
    const f = ring[k] * 3
    const b = (nFront + k) * 3
    positions[b] = positions[f]
    positions[b + 1] = positions[f + 1]
    positions[b + 2] = 0
  }
  const center = nFront + ringLen
  positions[center * 3] = x0 + w / 2
  positions[center * 3 + 1] = y0 + h / 2
  positions[center * 3 + 2] = 0

  const index = new Uint32Array((2 * (nx - 1) * (ny - 1) + 3 * ringLen) * 3)
  let p = 0
  const tri = (a: number, b: number, c: number) => {
    index[p++] = a
    index[p++] = b
    index[p++] = c
  }
  // Front grid, wound CCW seen from +Z.
  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i
      const b = a + 1
      const c = b + nx
      const d = a + nx
      tri(a, b, c)
      tri(a, c, d)
    }
  }
  // Walls (outward) and back fan (facing -Z), one ring segment at a time.
  for (let k = 0; k < ringLen; k++) {
    const k2 = (k + 1) % ringLen
    const fA = ring[k]
    const fB = ring[k2]
    const bA = nFront + k
    const bB = nFront + k2
    tri(fA, bA, bB)
    tri(fA, bB, fB)
    tri(center, bB, bA)
  }

  const geom = new THREE.BufferGeometry()
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3))
  geom.setIndex(new THREE.BufferAttribute(index, 1))
  geom.computeVertexNormals()
  return geom
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
  const zAt = round
    ? (x: number, y: number) => thick((x + m.width / 2) / m.width, (y + ROUND_FLAT) / m.width)
    : (x: number, y: number) => thick((x + m.width / 2) / m.width, y / m.height)

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

  geo = weld(geo)
  geo.computeBoundingBox()

  return { geometry: geo, size: { x: m.width, y: panelH, z: maxT } }
}
