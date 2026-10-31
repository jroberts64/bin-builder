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
//
// A pattern has ONE size control, its pitch. Everything else — feature width,
// the gap between features, the relief depth — is a fixed ratio of it (PATTERNS
// and DEPTH_RATIO), so turning the knob scales the whole pattern uniformly
// instead of spreading the same small features further apart. The print rules
// below only clamp those ratios where a face actually needs it.
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
  pitch: number // mm, centre-to-centre feature spacing — THE size knob; widths and depth follow from it
  angle: RidgeAngle // ridges only: 0 = along the face's u axis (side-to-side / horizontal), 90 = across
}

export interface BoxTexture {
  top: TextureSpec
  sides: TextureSpec
  layerHeight: number // mm slicer layer height — lid-top depths snap to whole layers
}

export function defaultBoxTexture(): BoxTexture {
  return {
    top: { pattern: 'none', mode: 'emboss', pitch: 5, angle: 0 },
    sides: { pattern: 'none', mode: 'deboss', pitch: 5, angle: 0 },
    layerHeight: 0.2,
  }
}

// The print rules, in mm unless noted. Change these, not the generators.
export const TEXTURE = {
  // Solid margin around every textured region. Keeps first-layer adhesion on
  // plate-facing faces and keeps the pattern off edges, the lid lip roots, the
  // sliding lid's tongue chamfers and the snap-on lid's knuckle arms.
  BORDER: 3,
  // Narrowest plateau / bar / cell wall, and narrowest gap between features.
  // First-layer squish blurs anything finer on a plate-facing face; on a wall
  // it is ~2 extrusion widths.
  MIN_FEATURE: 1,
  // Widest single recess on a plate-facing face: the layer above must bridge
  // it, and 5mm bridges cleanly. Nothing bridges anywhere else (a face-up
  // pocket has a floor; a wall recess is a ≤1mm overhang), so only the
  // bed-face is held to it.
  MAX_SPAN: 5,
  // Share of a plate-facing face that must stay on the plate. Bed-face only —
  // featureSize() caps each pattern's duty to keep it.
  MIN_PLATEAU: 0.5,
  MIN_PITCH: 3,
  MAX_PITCH: 12,
  // Relief depth as a share of the pitch. With the PATTERNS duties this is the
  // proportion that reads as texture: measured over 0.2–1.4mm at a 4.5mm
  // pitch, 0.2–0.4 vanishes under raking light and past ~1mm the pockets read
  // as a dark grille. 1/6 lands at 0.75 → 0.8mm there. Clamped per face by
  // textureDepthLimit and snapped to layers on horizontal faces.
  DEPTH_RATIO: 1 / 6,
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
// hex across-flats or dot diameter = duty × pitch): the IDEAL proportion, which
// featureSize() then clamps to the print rules. The values come from rendering
// each pattern across a sweep of duties and judging them by eye, and the rule
// that fell out is that a pattern reads as a SURFACE when the ground between
// features is no wider than the features themselves — the old duties (ridges
// 0.35, hex 0.65, dots 0.6) left 35–65% of the face as flat field between
// small features, which reads as studs scattered on a plate. So: tiles
// (hex, knurl) get thin grout, ridges are half-and-half, dots sit close.
export interface PatternInfo {
  label: string
  minPitch: number
  duty: number
}
export const PATTERNS: Record<Exclude<TexturePattern, 'none'>, PatternInfo> = {
  // bar = flat, the classic reeded proportion. Exactly MIN_PLATEAU on the
  // bed-face, so it needs no cap there.
  ridges: { label: 'Ridges', minPitch: 3, duty: 0.5 },
  // two bar sets crossed at ±45°, bars narrow so the diamonds dominate. At
  // every pitch below 4.5mm the bar is held at MIN_FEATURE instead; 3.5mm is
  // the smallest pitch where that 1mm bar still leaves (1 − 1/3.5)² = 51% on
  // the plate.
  knurl: { label: 'Knurl', minPitch: 3.5, duty: 0.22 },
  // across-flats = 85% of pitch: a honeycomb (recessed) or hex tiles (raised)
  // with thin walls. The wall is MIN_FEATURE below a 6.7mm pitch. On the
  // bed-face the pockets are capped at √0.5 of the pitch (50% area), so the
  // walls there are ~29% of the pitch.
  hex: { label: 'Hex', minPitch: 3, duty: 0.85 },
  // diameter = 70% of pitch on a hex lattice → 44% coverage, 56% flat, so it
  // needs no cap on the bed-face either.
  dots: { label: 'Dots', minPitch: 3, duty: 0.7 },
}

export function minPitch(pattern: TexturePattern): number {
  return pattern === 'none' ? TEXTURE.MIN_PITCH : PATTERNS[pattern].minPitch
}

// Largest pitch a face takes for a pattern. On the bed-face the recess grows
// with the pitch until MAX_SPAN stops it, and past that point featureSize would
// hold the feature at 5mm while the spacing kept growing — exactly the sparse
// studs-on-a-plate look the duties exist to avoid (hex at 12mm would be 83%
// bare). So the knob stops there instead, rounded down to 0.5mm, and the
// proportions hold all the way: ridges 10mm, hex and dots 7mm, knurl (whose
// recess is the narrow bar) the full range.
export function maxPitch(pattern: TexturePattern, ctx: TextureContext): number {
  if (pattern === 'none' || ctx !== 'bed-face') return TEXTURE.MAX_PITCH
  const d = Math.min(PATTERNS[pattern].duty, maxBedDuty(pattern))
  return Math.min(TEXTURE.MAX_PITCH, Math.floor((2 * TEXTURE.MAX_SPAN) / d) / 2)
}

// Feature size (bar width / hex across-flats / dot diameter) for a pitch on a
// face: the pattern's duty, held so the gap between features stays at least
// MIN_FEATURE, and on the bed-face no wider than MAX_SPAN nor covering more
// than 1 − MIN_PLATEAU of the face. Finally never thinner than MIN_FEATURE;
// each pattern's minPitch is set so that floor never undoes the plateau cap.
export function featureSize(
  pattern: Exclude<TexturePattern, 'none'>,
  pitch: number,
  ctx: TextureContext,
): number {
  let f = Math.min(PATTERNS[pattern].duty * pitch, pitch - TEXTURE.MIN_FEATURE)
  if (ctx === 'bed-face') f = Math.min(f, TEXTURE.MAX_SPAN, maxBedDuty(pattern) * pitch)
  return Math.max(f, TEXTURE.MIN_FEATURE)
}

// Share of a hex lattice's area covered by its dots, per (diameter/pitch)².
const DOT_AREA = Math.PI / (2 * Math.sqrt(3))

// Fraction of the face left flat (on the plate, for a bed-facing recess), for
// a duty d = feature / pitch.
export function plateauFraction(pattern: Exclude<TexturePattern, 'none'>, d: number): number {
  switch (pattern) {
    case 'ridges':
      return 1 - d
    case 'knurl':
      return (1 - d) * (1 - d)
    case 'hex':
      return 1 - d * d
    case 'dots':
      return 1 - DOT_AREA * d * d
  }
}

// plateauFraction() solved for d at MIN_PLATEAU: the largest duty that still
// leaves enough of a plate-facing face on the plate.
function maxBedDuty(pattern: Exclude<TexturePattern, 'none'>): number {
  const P = TEXTURE.MIN_PLATEAU
  switch (pattern) {
    case 'ridges':
      return 1 - P
    case 'knurl':
      return 1 - Math.sqrt(P)
    case 'hex':
      return Math.sqrt(1 - P)
    case 'dots':
      return Math.sqrt((1 - P) / DOT_AREA)
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
// allows, the pitch clamped to the pattern's range on that face, and the
// feature size and depth derived from it — the depth clamped to the face's
// limit (and snapped to whole layers on horizontal faces). null = nothing to
// build (pattern off, or the face is too thin for even one layer).
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
  const pitch = clamp(spec.pitch, minPitch(pattern), maxPitch(pattern, ctx))
  const maxDepth = textureDepthLimit(ctx, mode, thickness)
  let depth = Math.min(pitch * TEXTURE.DEPTH_RATIO, maxDepth)
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
  const feature = featureSize(pattern, pitch, ctx)
  const plateau = plateauFraction(pattern, feature / pitch)
  // Guaranteed by featureSize's cap and the minPitch table; kept as the guard
  // for the invariant so a bad edit to PATTERNS fails safe (no texture) instead
  // of printing a part that barely touches the plate. (The cap can land
  // exactly ON the limit, hence the tolerance.)
  if (ctx === 'bed-face' && plateau < TEXTURE.MIN_PLATEAU - 1e-9) return null
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

// Parallel bars centred on the region, as many as fit whole — a bar clipped at
// the border would be a sub-MIN_FEATURE sliver of groove. Odd or even count,
// whichever fits more, so the margin at each end is under half a pitch rather
// than up to a whole one (which reads as a missing ridge).
function ridgePolys(w: number, h: number, f: number, pitch: number, angle: RidgeAngle): Poly[] {
  const span = angle === 0 ? h : w // extent across the bars
  const out: Poly[] = []
  if (span < f) return out
  const n = Math.floor((span - f) / pitch) + 1
  const first = span / 2 - ((n - 1) * pitch) / 2
  for (let k = 0; k < n; k++) {
    const c = first + k * pitch
    const lo = c - f / 2
    const hi = c + f / 2
    out.push(angle === 0 ? [[0, lo], [w, lo], [w, hi], [0, hi]] : [[lo, 0], [hi, 0], [hi, h], [lo, h]])
  }
  return out
}

// A template polygon (symmetric about its origin) stamped at every point of a
// hex lattice — rows pitch·√3/2 apart, alternate rows offset half a pitch —
// keeping only cells wholly inside the region. The lattice is tried at four
// phases and the one that fits the most cells wins, then the kept block is
// re-centred so opposite margins match: a lattice simply pinned to the region
// centre leaves one side up to a pitch wider than the other, which is the
// first thing the eye finds on a textured lid.
function cellPolys(w: number, h: number, pitch: number, template: Poly): Poly[] {
  const rowH = (pitch * Math.sqrt(3)) / 2
  const rx = Math.max(...template.map((p) => Math.abs(p[0])))
  const ry = Math.max(...template.map((p) => Math.abs(p[1])))
  const J = Math.ceil(h / rowH / 2) + 1
  const I = Math.ceil(w / pitch / 2) + 1
  let best: [number, number][] = []
  for (const [px, py] of [[0, 0], [pitch / 2, 0], [0, rowH / 2], [pitch / 2, rowH / 2]]) {
    const centres: [number, number][] = []
    for (let j = -J; j <= J; j++) {
      const cy = h / 2 + py + j * rowH
      const xOff = j % 2 !== 0 ? pitch / 2 : 0
      for (let i = -I; i <= I; i++) {
        const cx = w / 2 + px + i * pitch + xOff
        if (cx - rx >= 0 && cx + rx <= w && cy - ry >= 0 && cy + ry <= h) centres.push([cx, cy])
      }
    }
    if (centres.length > best.length) best = centres
  }
  if (best.length === 0) return []
  const xs = best.map((c) => c[0])
  const ys = best.map((c) => c[1])
  const dx = w / 2 - (Math.min(...xs) + Math.max(...xs)) / 2
  const dy = h / 2 - (Math.min(...ys) + Math.max(...ys)) / 2
  return best.map(([cx, cy]) => template.map(([x, y]) => [cx + dx + x, cy + dy + y] as [number, number]))
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

// Facets ~0.5mm long (a multiple of 4, at least 16), so a large dot stays round
// instead of showing its polygon.
function circlePoly(diameter: number): Poly {
  const N = Math.max(16, 4 * Math.ceil((Math.PI * diameter) / 0.5 / 4))
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
