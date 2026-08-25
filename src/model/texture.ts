import * as THREE from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { csgAdd, csgSubtract, weld } from './csg'

// Surface textures for the box: the lid top and the outer walls, each with its
// own independent settings. Built the way the rest of the box is — a field of
// simple solids (bars, hexagonal prisms, discs) laid over a flat face and
// applied with ONE boolean per tool group: unioned for a raised texture
// ("emboss"), subtracted for a recessed one ("deboss"). Geometric patterns
// only, so edges are exact and the triangle budget stays small (a 4.5mm hex
// field over a whole 80×120 lid is ~10k triangles).
//
// Every print constraint from the design is a named constant in TEXTURE and is
// enforced HERE (resolveTexture + the generators), not by the UI: the UI reads
// the same functions to show the effective values. The constraints are about
// how a face prints, so each region is applied with a TextureContext:
//
//   'top-up'   the face prints facing up (sliding lid top). Raised or recessed;
//              heights snap to whole layers because the relief IS the layer
//              stack.
//   'bed-face' the face prints against the build plate (both hinged lids: the
//              fold-flat lid lies face-down, the snap-on lid exports top-side
//              down). Nothing can be raised below the plate, so the texture is
//              cut in as recesses that the first layers simply skip and the
//              layer above bridges. Hence: deboss only, whole layers, recesses
//              no wider than MAX_SPAN, and MIN_PLATEAU of the face left on the
//              plate so the part still sticks.
//   'wall'     a vertical outer wall. Any pattern, raised or recessed, up to
//              MAX_WALL_DEPTH (a raised bar's underside is an overhang of that
//              length). Depth is horizontal, so no layer snapping.

export type TexturePattern = 'none' | 'ridges' | 'knurl' | 'hex' | 'dots'
export type TextureMode = 'emboss' | 'deboss'
export type RidgeAngle = 0 | 90
export type TextureContext = 'top-up' | 'bed-face' | 'wall'

export const TEXTURE_PATTERNS: TexturePattern[] = ['none', 'ridges', 'knurl', 'hex', 'dots']
export const TEXTURE_MODES: TextureMode[] = ['emboss', 'deboss']

export interface TextureSpec {
  pattern: TexturePattern
  mode: TextureMode // raised or recessed; forced to 'deboss' on a bed-facing lid
  depth: number // mm requested — the built depth is clamped per face (see textureDepthLimit)
  pitch: number // mm, centre-to-centre feature spacing
  angle: RidgeAngle // ridges only: 0 = along the face's u axis (side-to-side / horizontal), 90 = across
}

export interface BoxTexture {
  top: TextureSpec
  sides: TextureSpec
  layerHeight: number // mm slicer layer height — lid-top depths snap to whole layers
}

export function defaultBoxTexture(): BoxTexture {
  return {
    top: { pattern: 'none', mode: 'emboss', depth: 0.6, pitch: 4.5, angle: 0 },
    sides: { pattern: 'none', mode: 'deboss', depth: 0.6, pitch: 4.5, angle: 0 },
    layerHeight: 0.2,
  }
}

// The print rules, in mm unless noted. Change these, not the generators.
export const TEXTURE = {
  // Solid margin around every textured region. Keeps first-layer adhesion on
  // plate-facing faces and keeps the pattern off edges, the lid lip roots, the
  // sliding lid's tongue chamfers and the snap-on lid's knuckle arms.
  BORDER: 3,
  // Narrowest plateau / bar / cell wall. First-layer squish blurs anything
  // finer on a plate-facing face; on a wall it is ~2 extrusion widths.
  MIN_FEATURE: 1,
  // Widest single recess: on a plate-facing face the layer above must bridge
  // it, and 5mm bridges cleanly. Applied to raised features too for symmetry.
  MAX_SPAN: 5,
  // Share of a plate-facing face that must stay on the plate. The duty ratios
  // in PATTERNS are chosen so every pattern satisfies this at every pitch.
  MIN_PLATEAU: 0.5,
  MIN_PITCH: 3,
  MAX_PITCH: 12,
  MAX_TOP_EMBOSS: 2, // raised relief on a face-up lid
  MAX_BED_RECESS: 1, // recess into a plate-facing lid top
  MAX_WALL_DEPTH: 1, // raised or recessed on a vertical wall
  MIN_LID_REMAINING: 1.2, // lid panel that must remain under a recess
  MIN_WALL_REMAINING: 1, // wall that must remain behind a recess
  MIN_DEPTH: 0.1,
  // Tool overlap past the face plane, so the boolean never meets it coplanar.
  EMBED: 0.2,
} as const

// Per-pattern geometry. `duty` is the feature's share of the pitch (bar width,
// hex across-flats or dot diameter = duty × pitch), sized so the flat left
// between features is ≥ MIN_FEATURE at minPitch and the plateau fraction is
// ≥ MIN_PLATEAU everywhere — see plateauFraction() for the per-pattern area
// formula. Defaults (4.5mm pitch) give ridges a 1.6mm groove and a 2.9mm flat.
export interface PatternInfo {
  label: string
  minPitch: number
  duty: number
}
export const PATTERNS: Record<Exclude<TexturePattern, 'none'>, PatternInfo> = {
  // bar = 35% of pitch → 65% flat. 3mm pitch → 1.05mm bar, 1.95mm flat.
  ridges: { label: 'Ridges', minPitch: 3, duty: 0.35 },
  // two bar sets crossed at ±45°; union covers 1 − (1 − 0.25)² = 44% → 56% flat.
  // 4mm minimum keeps the bars at ≥ 1mm and the diamond islands at 3mm.
  knurl: { label: 'Knurl', minPitch: 4, duty: 0.25 },
  // across-flats = 65% of pitch → area (0.65)² = 42% → 58% flat; cell walls are
  // 35% of pitch, ≥ 1.05mm at 3mm.
  hex: { label: 'Hex', minPitch: 3, duty: 0.65 },
  // diameter = 60% of pitch on a hex lattice → area 0.907·0.36 = 33% → 67% flat;
  // gaps are 40% of pitch, ≥ 1.2mm at 3mm.
  dots: { label: 'Dots', minPitch: 3, duty: 0.6 },
}

export function minPitch(pattern: TexturePattern): number {
  return pattern === 'none' ? TEXTURE.MIN_PITCH : PATTERNS[pattern].minPitch
}

// Feature size (bar width / hex across-flats / dot diameter) for a pitch. The
// MAX_SPAN clamp only ever lowers coverage; the MIN_FEATURE clamp never bites
// inside the allowed pitch range (duty × minPitch ≥ 1 for every pattern).
export function featureSize(pattern: Exclude<TexturePattern, 'none'>, pitch: number): number {
  return clamp(PATTERNS[pattern].duty * pitch, TEXTURE.MIN_FEATURE, TEXTURE.MAX_SPAN)
}

// Fraction of the face left flat (on the plate, for a bed-facing recess).
export function plateauFraction(pattern: Exclude<TexturePattern, 'none'>, pitch: number): number {
  const d = featureSize(pattern, pitch) / pitch
  switch (pattern) {
    case 'ridges':
      return 1 - d
    case 'knurl':
      return (1 - d) * (1 - d)
    case 'hex':
      return 1 - d * d
    case 'dots':
      return 1 - (Math.PI / (2 * Math.sqrt(3))) * d * d
  }
}

// Deepest texture a face allows. `thickness` is the panel/wall behind the face.
export function textureDepthLimit(ctx: TextureContext, mode: TextureMode, thickness: number): number {
  switch (ctx) {
    case 'top-up':
      return mode === 'emboss'
        ? TEXTURE.MAX_TOP_EMBOSS
        : Math.min(TEXTURE.MAX_TOP_EMBOSS, thickness - TEXTURE.MIN_LID_REMAINING)
    case 'bed-face':
      return Math.min(TEXTURE.MAX_BED_RECESS, thickness - TEXTURE.MIN_LID_REMAINING)
    case 'wall':
      return mode === 'emboss'
        ? TEXTURE.MAX_WALL_DEPTH
        : Math.min(TEXTURE.MAX_WALL_DEPTH, thickness - TEXTURE.MIN_WALL_REMAINING)
  }
}

// What actually gets built for a spec on a given face: the mode the face
// allows, the depth clamped to the face's limit (and snapped to whole layers on
// horizontal faces), the pitch clamped to the pattern's range, and the derived
// feature size. null = nothing to build (pattern off, or the face is too thin
// for even one layer).
export interface ResolvedTexture {
  pattern: Exclude<TexturePattern, 'none'>
  mode: TextureMode
  depth: number
  layers: number | null // whole layers, when the face snaps to them
  pitch: number
  feature: number
  angle: RidgeAngle
  plateau: number // fraction of the face left flat
  maxDepth: number
}

export function resolveTexture(
  spec: TextureSpec,
  ctx: TextureContext,
  thickness: number,
  layerHeight: number,
): ResolvedTexture | null {
  if (spec.pattern === 'none') return null
  const pattern = spec.pattern
  const mode: TextureMode = ctx === 'bed-face' ? 'deboss' : spec.mode
  const maxDepth = textureDepthLimit(ctx, mode, thickness)
  let depth = Math.min(spec.depth, maxDepth)
  let layers: number | null = null
  if (ctx !== 'wall') {
    // Horizontal face: the relief is the layer stack, so model what will print.
    // Nearest whole layer, never past the limit, never less than one layer.
    let n = Math.max(1, Math.round(depth / layerHeight))
    if (n * layerHeight > maxDepth + 1e-6) n = Math.floor(maxDepth / layerHeight + 1e-6)
    if (n < 1) return null
    depth = n * layerHeight
    layers = n
  }
  if (depth < TEXTURE.MIN_DEPTH - 1e-9) return null
  const pitch = clamp(spec.pitch, minPitch(pattern), TEXTURE.MAX_PITCH)
  const feature = featureSize(pattern, pitch)
  const plateau = plateauFraction(pattern, pitch)
  // Guaranteed by the duty table; kept as the guard for the invariant so a bad
  // edit to PATTERNS fails safe (no texture) instead of printing a part that
  // barely touches the plate.
  if (plateau < TEXTURE.MIN_PLATEAU) return null
  return { pattern, mode, depth, layers, pitch, feature, angle: spec.angle, plateau, maxDepth }
}

// A flat rectangular patch of a face, in model space. `origin` is the corner
// where u = v = 0, ON the face plane; u and v are unit vectors along the
// patch's width and height, and u × v MUST be the face's OUTWARD normal (the
// tools extrude along it). The pattern's u axis is the ridges' angle-0
// direction. faceRegion() insets the full face rectangle by BORDER, so callers
// pass the real face extents and the margin is enforced in one place.
export interface FaceRegion {
  origin: THREE.Vector3
  u: THREE.Vector3
  v: THREE.Vector3
  w: number
  h: number
}

type V3 = [number, number, number]

export function faceRegion(origin: V3, u: V3, v: V3, w: number, h: number): FaceRegion | null {
  const B = TEXTURE.BORDER
  const iw = w - 2 * B
  const ih = h - 2 * B
  if (iw < TEXTURE.MIN_FEATURE || ih < TEXTURE.MIN_FEATURE) return null
  const U = new THREE.Vector3(...u).normalize()
  const V = new THREE.Vector3(...v).normalize()
  const O = new THREE.Vector3(...origin).addScaledVector(U, B).addScaledVector(V, B)
  return { origin: O, u: U, v: V, w: iw, h: ih }
}

// Apply one texture spec to a set of regions of the same body with the same
// context (e.g. all four outer walls). The tools from every region are merged
// into one multi-shell geometry and applied in ONE boolean — the regions are on
// different faces and inset by BORDER, so their tools never meet. Returns the
// body untouched when there is nothing to build.
export function applyTextures(
  body: THREE.BufferGeometry,
  regions: (FaceRegion | null)[],
  spec: TextureSpec,
  ctx: TextureContext,
  thickness: number,
  layerHeight: number,
): THREE.BufferGeometry {
  const r = resolveTexture(spec, ctx, thickness, layerHeight)
  if (!r) return body
  const tools: THREE.BufferGeometry[] = []
  for (const region of regions) {
    if (!region) continue
    const t = textureTool(region, r)
    if (t) tools.push(t)
  }
  if (tools.length === 0) return body
  const tool = tools.length === 1 ? tools[0] : mergeGeometries(tools, false)!
  return r.mode === 'emboss' ? csgAdd(body, tool) : csgSubtract(body, tool)
}

// --- tool generation ------------------------------------------------------

type Poly = [number, number][]

// One tool solid per region: a single mesh whose shells never overlap or touch
// each other. That matters — two shells with coplanar, overlapping faces (the
// obvious way to build a knurl, as two crossed bar sets) make Manifold leave
// coincident-but-distinct vertices at the crossings, which slicers see as
// pinched non-manifold edges once the STL is re-welded. So the knurl is built
// as ONE shell (see knurlTool) and the other patterns are disjoint cells/bars.
function textureTool(region: FaceRegion, r: ResolvedTexture): THREE.BufferGeometry | null {
  // Emboss: from EMBED inside the face up to depth. Deboss: from depth inside
  // out to EMBED beyond the face. Either way the tool's walls cross the face
  // plane transversally and nothing sits coplanar with it.
  const z0 = r.mode === 'emboss' ? -TEXTURE.EMBED : -r.depth
  const z1 = r.mode === 'emboss' ? r.depth : TEXTURE.EMBED
  const n = new THREE.Vector3().crossVectors(region.u, region.v).normalize()
  const frame = new THREE.Matrix4().makeBasis(region.u, region.v, n).setPosition(region.origin)
  if (r.pattern === 'knurl') return knurlTool(region.w, region.h, r.feature, r.pitch, z0, z1, frame)
  const polys = patternPolys(r, region.w, region.h)
  return polys.length ? extrudePolys(polys, z0, z1, frame) : null
}

function patternPolys(r: ResolvedTexture, w: number, h: number): Poly[] {
  switch (r.pattern) {
    case 'ridges':
      return ridgePolys(w, h, r.feature, r.pitch, r.angle)
    case 'hex':
      return cellPolys(w, h, r.pitch, hexPoly(r.feature))
    case 'dots':
      return cellPolys(w, h, r.pitch, circlePoly(r.feature))
    case 'knurl':
      return [] // built as one solid by knurlTool
  }
}

// Knurl: two bar sets crossed at ±45°. Their union is the region minus the
// diamond islands between the bars, so build exactly that — the whole region
// slab with the islands cut out by Manifold — instead of overlapping bar
// solids (see textureTool). Islands are laid out in the bars' own rotated
// frame (s along n1, t along n2), left UNclipped and taller than the slab, so
// every island face crosses the slab's faces transversally, never coplanar.
function knurlTool(
  w: number,
  h: number,
  f: number,
  pitch: number,
  z0: number,
  z1: number,
  frame: THREE.Matrix4,
): THREE.BufferGeometry {
  const slab = extrudePolys([[[0, 0], [w, 0], [w, h], [0, h]]], z0, z1, frame)
  const islands = knurlIslands(w, h, f, pitch)
  if (islands.length === 0) return slab
  return csgSubtract(slab, extrudePolys(islands, z0 - 1, z1 + 1, frame))
}

function knurlIslands(w: number, h: number, f: number, pitch: number): Poly[] {
  const r = Math.SQRT1_2
  // Orthonormal rotated frame: s = n1·p, t = n2·p; p = s·n1 + t·n2.
  const n1: [number, number] = [-r, r]
  const n2: [number, number] = [r, r]
  const c1 = n1[0] * (w / 2) + n1[1] * (h / 2) // bar-set offsets through the region centre
  const c2 = n2[0] * (w / 2) + n2[1] * (h / 2)
  const side = pitch - f // island square side, in the rotated frame
  const corners: [number, number][] = [[0, 0], [w, 0], [w, h], [0, h]]
  const sRange = corners.map(([x, y]) => n1[0] * x + n1[1] * y)
  const tRange = corners.map(([x, y]) => n2[0] * x + n2[1] * y)
  const kMin = Math.floor((Math.min(...sRange) - c1) / pitch) - 1
  const kMax = Math.ceil((Math.max(...sRange) - c1) / pitch) + 1
  const lMin = Math.floor((Math.min(...tRange) - c2) / pitch) - 1
  const lMax = Math.ceil((Math.max(...tRange) - c2) / pitch) + 1
  const out: Poly[] = []
  for (let k = kMin; k <= kMax; k++) {
    const s0 = c1 + k * pitch + f / 2
    for (let l = lMin; l <= lMax; l++) {
      const t0 = c2 + l * pitch + f / 2
      const poly: Poly = [[s0, t0], [s0 + side, t0], [s0 + side, t0 + side], [s0, t0 + side]].map(
        ([s, t]) => [s * n1[0] + t * n2[0], s * n1[1] + t * n2[1]],
      )
      // Keep islands whose bounding box reaches the region; the rest can't cut.
      const xs = poly.map((p) => p[0])
      const ys = poly.map((p) => p[1])
      if (Math.max(...xs) <= 0 || Math.min(...xs) >= w || Math.max(...ys) <= 0 || Math.min(...ys) >= h) continue
      out.push(poly)
    }
  }
  return out
}

// Parallel bars centred on the region, only those that fit whole — a bar
// clipped at the border would be a sub-MIN_FEATURE sliver of groove.
function ridgePolys(w: number, h: number, f: number, pitch: number, angle: RidgeAngle): Poly[] {
  const span = angle === 0 ? h : w // extent across the bars
  const K = Math.floor((span / 2 - f / 2) / pitch)
  const out: Poly[] = []
  if (K < 0) return out
  for (let k = -K; k <= K; k++) {
    const c = span / 2 + k * pitch
    const lo = c - f / 2
    const hi = c + f / 2
    out.push(angle === 0 ? [[0, lo], [w, lo], [w, hi], [0, hi]] : [[lo, 0], [hi, 0], [hi, h], [lo, h]])
  }
  return out
}

// A template polygon stamped at every point of a hex lattice (rows pitch·√3/2
// apart, alternate rows offset half a pitch) centred on the region; only cells
// wholly inside the region are kept.
function cellPolys(w: number, h: number, pitch: number, template: Poly): Poly[] {
  const rowH = (pitch * Math.sqrt(3)) / 2
  const J = Math.ceil(h / rowH / 2) + 1
  const I = Math.ceil(w / pitch / 2) + 1
  const out: Poly[] = []
  for (let j = -J; j <= J; j++) {
    const cy = h / 2 + j * rowH
    const xOff = j % 2 !== 0 ? pitch / 2 : 0
    for (let i = -I; i <= I; i++) {
      const cx = w / 2 + i * pitch + xOff
      const poly: Poly = template.map(([x, y]) => [cx + x, cy + y])
      if (poly.every(([x, y]) => x >= 0 && x <= w && y >= 0 && y <= h)) out.push(poly)
    }
  }
  return out
}

// Pointy-top hexagon with the given across-flats width (flats face ±u), so a
// row of them at `pitch` spacing leaves walls of pitch − f, and — hex lattice —
// so do the diagonal neighbours.
function hexPoly(acrossFlats: number): Poly {
  const R = acrossFlats / Math.sqrt(3)
  const out: Poly = []
  for (let k = 0; k < 6; k++) {
    const a = Math.PI / 6 + (k * Math.PI) / 3
    out.push([R * Math.cos(a), R * Math.sin(a)])
  }
  return out
}

function circlePoly(diameter: number): Poly {
  const N = 16
  const out: Poly = []
  for (let k = 0; k < N; k++) {
    const a = (k * 2 * Math.PI) / N
    out.push([(diameter / 2) * Math.cos(a), (diameter / 2) * Math.sin(a)])
  }
  return out
}

// Extrude a set of non-overlapping polygons from z0 to z1 in the region's local
// frame and move them into model space. ExtrudeGeometry normalises shape
// winding and the weld makes it a clean CSG input (as in box.ts's prismZ).
function extrudePolys(polys: Poly[], z0: number, z1: number, frame: THREE.Matrix4): THREE.BufferGeometry {
  const shapes = polys.map((poly) => {
    const s = new THREE.Shape()
    s.moveTo(poly[0][0], poly[0][1])
    for (let i = 1; i < poly.length; i++) s.lineTo(poly[i][0], poly[i][1])
    s.closePath()
    return s
  })
  const g = new THREE.ExtrudeGeometry(shapes, { depth: z1 - z0, bevelEnabled: false })
  g.translate(0, 0, z0)
  g.applyMatrix4(frame)
  return weld(g)
}

const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v))
