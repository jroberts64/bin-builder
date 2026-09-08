import * as THREE from 'three'

// Shared primitives for the image-relief object types — the lithophane panel
// (`litho.ts`) and the lithophane fan (`fan.ts`). Both turn a photograph into
// varying thickness the same way, so the machinery lives here and each module
// keeps only its own shape logic:
//
//   - the async image decode + grayscale cache (the sync-builder contract)
//   - `heightfieldMesh`, a closed manifold-by-construction heightmap slab
//   - `ditherGrid`, layer-step quantisation with error diffusion
//
// This is a primitive layer like `csg.ts`, not an object type: nothing here
// knows about panels, blades, or any model shape.

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
export const clamp01 = (v: number) => clamp(v, 0, 1)

// --- image decode + cache ---------------------------------------------------

// Decoding a data URL is async (browser image pipeline), but the geometry
// builders must be synchronous like every other builder in this app. So the
// grayscale image lives in a single-entry cache keyed by the data URL: await
// prepareImage() first (Viewport and the export paths do), then the builder
// reads it synchronously — the same shape as the initCSG()/buildBin contract.
//
// One entry is enough: only one object type is ever being built at a time, so
// the only cost of switching between a litho panel and a fan with different
// pictures is one re-decode on the switch.

export interface GrayImage {
  w: number
  h: number
  lum: Float32Array // luminance 0..1, row 0 = image top
}

let grayCache: { key: string; gray: GrayImage } | null = null

export async function prepareImage(src: string | null): Promise<void> {
  if (!src || grayCache?.key === src) return
  const img = new Image()
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve()
    img.onerror = () => reject(new Error('relief image failed to decode'))
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

// The decoded image for `src`. Throws if the cache is cold — callers are
// builders, and a silent fallback would quietly print the wrong picture.
export function getGray(src: string): GrayImage {
  if (grayCache?.key !== src) {
    throw new Error('relief image not decoded — await prepareImage() first')
  }
  return grayCache.gray
}

// Bilinear luminance at fractional pixel (px, py), clamped at the edges.
export function sampleLum(g: GrayImage, px: number, py: number): number {
  const { w, h, lum } = g
  const x = clamp(px, 0, w - 1)
  const y = clamp(py, 0, h - 1)
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const x1 = Math.min(x0 + 1, w - 1)
  const y1 = Math.min(y0 + 1, h - 1)
  const fx = x - x0
  const fy = y - y0
  return (
    lum[y0 * w + x0] * (1 - fx) * (1 - fy) +
    lum[y0 * w + x1] * fx * (1 - fy) +
    lum[y1 * w + x0] * (1 - fx) * fy +
    lum[y1 * w + x1] * fx * fy
  )
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

// --- dithering --------------------------------------------------------------

// Printed FLAT, the relief height is the stack height, so tone is quantised by
// layer height whatever we model: a 0.8–3mm range at 0.2mm layers is only 12
// greys, and a smooth gradient crossing a level boundary prints as a hard contour
// line (banding). Dithering fixes that the way newspapers print photographs: pick
// the nearest printable level per cell, then push the rounding error into
// neighbouring cells so the LOCAL AVERAGE still tracks the true height. Adjacent
// cells alternate between the two bracketing levels and the eye (and the diffused
// backlight) blends them into the in-between tone.
//
// Floyd–Steinberg weights over a serpentine (boustrophedon) scan — alternating
// row direction keeps the error from marching in one direction and laying down
// the diagonal streaks a raster-order scan produces.
//
// Returns a grid of quantised heights, indexed [j*nx + i], or null when there
// aren't at least 2 printable levels to dither between.
export function ditherGrid(
  nx: number,
  ny: number,
  raw: Float32Array,
  layerHeight: number,
  minT: number,
  maxT: number,
): Float32Array | null {
  // Printable levels are whole layer counts. Round the ends INWARD so dithering
  // never asks for a thinner floor than requested (a level below minT could thin
  // the panel to nothing) or a taller peak than the panel.
  const loLevel = Math.ceil(minT / layerHeight - 1e-6)
  const hiLevel = Math.floor(maxT / layerHeight + 1e-6)
  if (hiLevel - loLevel < 1) return null
  const lo = loLevel * layerHeight
  const hi = hiLevel * layerHeight

  const out = new Float32Array(nx * ny)
  // Diffuse into a copy so the source stays clean; errors accumulate here.
  const buf = Float32Array.from(raw)
  const add = (i: number, j: number, err: number, wt: number) => {
    if (i < 0 || i >= nx || j < 0 || j >= ny) return // error off the edge is dropped
    buf[j * nx + i] += err * wt
  }

  for (let j = 0; j < ny; j++) {
    const leftToRight = j % 2 === 0
    for (let s = 0; s < nx; s++) {
      const i = leftToRight ? s : nx - 1 - s
      const k = j * nx + i
      // Clamp the carried value before quantising, so a run of clipped cells
      // can't accumulate unbounded error and smear across the panel.
      const want = clamp(buf[k], lo, hi)
      const level = Math.round(want / layerHeight)
      const got = clamp(level, loLevel, hiLevel) * layerHeight
      out[k] = got
      const err = want - got
      // Forward neighbours, mirrored when scanning right-to-left.
      const fwd = leftToRight ? 1 : -1
      add(i + fwd, j, err, 7 / 16)
      add(i - fwd, j + 1, err, 3 / 16)
      add(i, j + 1, err, 5 / 16)
      add(i + fwd, j + 1, err, 1 / 16)
    }
  }
  return out
}

// Distinct printable levels over a thickness range at a given layer height —
// the grey count a flat print can actually resolve. Matches ditherGrid's inward
// rounding of the range ends, so the UI and the geometry always agree.
export function greyLevels(minT: number, maxT: number, layerHeight: number): number {
  return Math.max(
    1,
    Math.floor(maxT / layerHeight + 1e-6) - Math.ceil(minT / layerHeight - 1e-6) + 1,
  )
}

// --- heightmap mesh ---------------------------------------------------------

// A closed heightmap slab over [x0,x0+w]×[y0,y0+h]: relief front at z=zAt(x,y),
// flat back on z=0, perimeter walls. Manifold by construction — every edge is
// shared by exactly two triangles: front grid edges pair with each other and
// with the walls; back ring edges pair walls with a centre-fan back face (the
// back only needs its boundary to match the walls, so its interior is one fan
// vertex, halving the mesh vs mirroring the grid).
// zAt receives the grid indices alongside the world position so a precomputed
// grid (the dithered relief) can be looked up directly instead of re-derived.
export function heightfieldMesh(
  x0: number,
  y0: number,
  w: number,
  h: number,
  nx: number,
  ny: number,
  zAt: (x: number, y: number, i: number, j: number) => number,
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
      positions[k + 2] = zAt(x, y, i, j)
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
