import * as THREE from 'three'
import { csgIntersect, csgSubtract, weld } from './csg'
import { clamp, clamp01, ditherGrid, getGray, heightfieldMesh, prepareImage, sampleLum } from './relief'

// Lithophane fan: a hand fan whose blades are lithophane panels pivoting on a
// common hub, so one photograph spans the whole fan when it's opened. MANY
// meshes — one per blade — like the box's two parts, since each blade carries a
// different slice of the picture and they're separate printed parts riveted
// together afterwards.
//
// Modelled blade-local, Y-up standing like a lithophane panel: the pivot at the
// origin, the blade running along +Y, thickness along Z with the flat back on
// z=0 and the relief toward +Z. Blades are built identically and differ ONLY in
// which part of the photograph they sample.
//
// The image mapping is the whole point of the object. Each blade knows the angle
// it will sit at in the open fan, so a blade-local sample point is rotated into
// the assembled fan first and the picture is read at THAT position. The result:
// blade 3 carries exactly the slice of the photo that lands under blade 3 once
// the fan is opened. `imageZoom` / `imageOffsetX/Y` move the picture over the
// assembled fan, which is what "position the photo on the fan" means here.
//
// Geometry comes from the shared relief primitives (`relief.ts`) — the same
// heightmap mesh, dithering and image cache the flat lithophane panel uses.

export type FanTip = 'petal' | 'point' | 'round'

// Which pose the VIEWPORT shows. Unlike the lithophane's `orientation` this is
// preview-only: the export is always the print layout, because a fan blade has
// exactly one sensible print pose (flat on its back, relief up).
export type FanPreview = 'assembled' | 'flat'

export interface FanModel {
  image: string | null // source photo as a data URL (persisted, never in share links)
  blades: number // how many blades pivot on the hub
  spreadDeg: number // total angle the open fan covers
  bladeLength: number // mm, pivot centre to tip
  bladeWidth: number // mm, widest point of a blade
  neckWidth: number // mm, width at the pivot (also the root cap diameter)
  neckLength: number // mm, how far the narrow neck runs from the pivot
  tip: FanTip // blade tip silhouette
  minThickness: number // mm, thickness of the lightest areas
  maxThickness: number // mm, thickness of the darkest areas
  hubThickness: number // mm, flat (untextured) thickness of the neck/pivot zone
  pivotDiameter: number // mm, the hole the rivet/screw passes through
  pitch: number // mm per relief sample
  invert: boolean // flip light/dark
  clearOverlap: boolean // leave the inner zone where blades overlap flat instead of relieved
  imageZoom: number // %, 100 = the picture just covers the open fan
  imageOffsetX: number // mm, move the picture across the fan
  imageOffsetY: number // mm, move the picture up/down the fan
  dither: boolean // quantise the relief to layer steps + error diffusion
  layerHeight: number // mm, the slicer layer height dithering quantises to
  preview: FanPreview // which pose the viewport shows (export is always the layout)
}

export function defaultFan(): FanModel {
  return {
    image: null,
    blades: 9,
    spreadDeg: 160,
    bladeLength: 100,
    bladeWidth: 24,
    neckWidth: 12,
    neckLength: 22,
    tip: 'petal',
    minThickness: 0.8,
    maxThickness: 2.4,
    hubThickness: 1.6,
    pivotDiameter: 3.2,
    pitch: 0.35,
    invert: false,
    clearOverlap: false,
    imageZoom: 100,
    imageOffsetX: 0,
    imageOffsetY: 0,
    dither: true,
    layerHeight: 0.2,
    preview: 'assembled',
  }
}

export interface BuiltFan {
  blades: THREE.BufferGeometry[]
  size: { x: number; y: number; z: number }
}

// The relief grid overshoots the blade outline by this much before the CSG trim,
// so the trim is a clean cut and never a coplanar graze of the grid's own walls.
const MARGIN = 1.5
// Total relief cells across ALL blades. A fan is many panels, so the budget is
// shared: a 12-blade fan samples a little coarser rather than building a mesh too
// heavy to preview or slice. At the default size this lands near 0.4mm, which is
// about one extrusion width anyway.
const MAX_CELLS = 150_000
// mm over which thickness ramps from the flat hub zone into the relief, so there
// is no cliff between them.
const HUB_BLEND = 2
// Preview-only separation between stacked blades: enough that one blade's relief
// doesn't interpenetrate the next in the assembled render. The real stack at the
// pivot is thinner — blades × hubThickness — because the neck zone is flat.
const STACK_GAP = 0.2
// Print layout: gap between blades, and the width to wrap the row at (blades
// past this go to a second row, which keeps a 9-blade fan on one plate).
const LAYOUT_GAP = 3
const LAYOUT_MAX_W = 220

// The image decode is async but buildFan is sync, so the decoded grayscale lives
// in relief.ts's cache: await this before buildFan (Viewport and the export paths
// do), exactly like the lithophane panel.
export const prepareFanImage = (m: FanModel) => prepareImage(m.image)

function effMaxThickness(m: FanModel): number {
  return Math.max(m.maxThickness, m.minThickness + 0.2)
}

// The pivot hole has to leave a ring of material around it in the neck, so it is
// capped by the neck width however large the model asks for.
function effPivotDiameter(m: FanModel): number {
  return clamp(m.pivotDiameter, 0, Math.max(0, m.neckWidth - 3))
}

export function bladeCount(m: FanModel): number {
  return Math.max(1, Math.round(m.blades))
}

// Angle between adjacent blades in the open fan.
export function bladeStepRad(m: FanModel): number {
  const n = bladeCount(m)
  return n < 2 ? 0 : ((m.spreadDeg * Math.PI) / 180) / (n - 1)
}

// Where blade `i` sits in the open fan: blade 0 at one edge of the spread, the
// last at the other, fanned symmetrically about straight up (+Y).
export function bladeAngle(m: FanModel, i: number): number {
  const n = bladeCount(m)
  if (n < 2) return 0
  const spread = (m.spreadDeg * Math.PI) / 180
  return -spread / 2 + (i * spread) / (n - 1)
}

// --- blade silhouette -------------------------------------------------------

// How long the tip section runs, as a multiple of the blade's half-width. A
// round tip is a semicircle; a petal is the long ogee of the reference fan.
const TIP_LEN: Record<FanTip, number> = { round: 1, point: 1.8, petal: 2.6 }

// Tip half-width as a fraction of the blade's, over s ∈ [0,1] from the start of
// the tip section to the very point.
function tipShape(tip: FanTip, s: number): number {
  switch (tip) {
    case 'round':
      return Math.sqrt(Math.max(0, 1 - s * s))
    case 'point':
      return 1 - s
    case 'petal':
      // A full ogee coming to a point, with a small concave shoulder cusp where
      // the body meets the tip.
      return (
        Math.pow(Math.cos((s * Math.PI) / 2), 0.62) *
        (1 - 0.12 * Math.exp(-Math.pow((s - 0.1) / 0.06, 2)))
      )
    default:
      return 0
  }
}

interface BladeProfile {
  L: number // pivot centre to tip
  hw: number // half of the widest width
  r0: number // root cap radius (half the neck width)
  neck: number // the narrow neck runs from the pivot out to here
  flare: number // mm over which the neck widens to full width
  tipStart: number // where the tip section begins
  tip: FanTip
}

// Resolve the model's blade dimensions into a consistent profile: every span is
// clamped against the others so a short blade with a long neck and a long tip
// still produces a sane silhouette instead of a self-crossing one.
function bladeProfile(m: FanModel): BladeProfile {
  const L = m.bladeLength
  const hw = Math.max(m.bladeWidth, m.neckWidth + 2) / 2
  const r0 = m.neckWidth / 2
  const neck = clamp(m.neckLength, r0 + 2, L * 0.6)
  const tipLen = Math.min(hw * TIP_LEN[m.tip], (L - neck) * 0.75)
  const tipStart = L - tipLen
  // Widen over a distance in proportion to how much width is gained, but never
  // past the start of the tip.
  const flare = Math.min((hw - r0) * 1.6 + 2, (tipStart - neck) * 0.8)
  return { L, hw, r0, neck, flare, tipStart, tip: m.tip }
}

// Half-width of the blade at distance y along its axis from the pivot: constant
// neck, a smoothstep flare, the full-width body, then the tip.
function halfWidthAt(p: BladeProfile, y: number): number {
  if (y <= p.neck) return p.r0
  if (y >= p.tipStart) {
    const s = clamp01((y - p.tipStart) / Math.max(1e-6, p.L - p.tipStart))
    return p.hw * clamp01(tipShape(p.tip, s))
  }
  const t = clamp01((y - p.neck) / Math.max(1e-6, p.flare))
  return p.r0 + (p.hw - p.r0) * (t * t * (3 - 2 * t))
}

// Same, but including the round root cap below the pivot (y < 0), so this is the
// blade's full silhouette. Used for bounding boxes and the grid extent.
function silhouetteHalfWidth(p: BladeProfile, y: number): number {
  if (y < 0) return Math.sqrt(Math.max(0, p.r0 * p.r0 - y * y))
  return halfWidthAt(p, y)
}

// The y values the outline is sampled at: uniform along the blade, plus extra
// density through the tip section where the profile curves hardest.
function outlineYs(p: BladeProfile): number[] {
  const ys: number[] = []
  const body = 80
  for (let k = 0; k <= body; k++) ys.push((p.L * k) / body)
  const tipN = 40
  for (let k = 1; k < tipN; k++) ys.push(p.tipStart + ((p.L - p.tipStart) * k) / tipN)
  return ys.sort((a, b) => a - b)
}

// The blade outline in the XY plane: up the right side, across the point, down
// the left side, then the round root cap under the pivot. Wound CCW seen from
// +Z, like every other shape fed to ExtrudeGeometry here.
function bladeShape(m: FanModel): THREE.Shape {
  const p = bladeProfile(m)
  const s = new THREE.Shape()
  const ys = outlineYs(p)

  let px = p.r0
  let py = 0
  s.moveTo(px, py)
  // Drop points that land on top of their predecessor — near the point the
  // profile converges, and duplicates make ExtrudeGeometry emit degenerate
  // triangles that Manifold then rejects.
  const line = (x: number, y: number) => {
    if (Math.hypot(x - px, y - py) < 0.03) return
    s.lineTo(x, y)
    px = x
    py = y
  }
  for (const y of ys) line(halfWidthAt(p, y), y)
  line(0, p.L) // the point itself, whatever the sampling did
  for (let k = ys.length - 1; k >= 0; k--) line(-halfWidthAt(p, ys[k]), ys[k])
  line(-p.r0, 0)
  // CCW from (-r0,0) through (0,-r0) back to (r0,0) — the cap closes the loop.
  s.absarc(0, 0, p.r0, Math.PI, 2 * Math.PI, false)
  return s
}

// The trim tool, shared by every blade: the outline extruded past both faces,
// with the pivot hole already subtracted. Cutting the hole out of the TOOL means
// each blade needs only one boolean instead of two.
function trimTool(m: FanModel, zTop: number): THREE.BufferGeometry {
  const prism = new THREE.ExtrudeGeometry(bladeShape(m), {
    depth: zTop + 2,
    bevelEnabled: false,
    curveSegments: 32,
  })
  prism.translate(0, 0, -1) // span z ∈ [-1, zTop+1], past both blade faces
  const tool = weld(prism)
  const d = effPivotDiameter(m)
  if (d < 0.5) return tool
  const cyl = new THREE.CylinderGeometry(d / 2, d / 2, zTop + 6, 48)
  cyl.rotateX(Math.PI / 2) // cylinder axis Y → Z (through the blade)
  cyl.translate(0, 0, zTop / 2) // centred on the pivot, crossing both prism ends
  return csgSubtract(tool, weld(cyl))
}

// --- the open fan -----------------------------------------------------------

// Bounding box of the assembled open fan in its own XY plane (pivot at the
// origin). This is the frame the photograph is fitted to, so it must not depend
// on the preview mode — and it's what the dims readout reports for the assembled
// view.
export interface FanFrame {
  minX: number
  maxX: number
  minY: number
  maxY: number
  w: number
  h: number
  cx: number
  cy: number
}

export function fanFrame(m: FanModel): FanFrame {
  const p = bladeProfile(m)
  const n = bladeCount(m)
  const ys = [-p.r0, ...outlineYs(p)]
  let minX = Infinity
  let maxX = -Infinity
  let minY = Infinity
  let maxY = -Infinity
  for (let i = 0; i < n; i++) {
    const a = bladeAngle(m, i)
    const ca = Math.cos(a)
    const sa = Math.sin(a)
    for (const y of ys) {
      const hw = silhouetteHalfWidth(p, y)
      for (const x of [hw, -hw]) {
        const X = x * ca - y * sa
        const Y = x * sa + y * ca
        if (X < minX) minX = X
        if (X > maxX) maxX = X
        if (Y < minY) minY = Y
        if (Y > maxY) maxY = Y
      }
    }
  }
  return {
    minX,
    maxX,
    minY,
    maxY,
    w: maxX - minX,
    h: maxY - minY,
    cx: (minX + maxX) / 2,
    cy: (minY + maxY) / 2,
  }
}

// How far out from the pivot adjacent blades still overlap each other. At radius
// r a blade spans an angular half-width of asin(halfWidth(r)/r), so two blades
// Δθ apart overlap wherever halfWidth(r) > r·sin(Δθ/2). A fan has to overlap
// there — that's what lets it fold — so this is a fact about the design, not a
// fault to fix.
//
// It matters because the picture is read in TRANSMISSION: backlight crosses
// every blade in the stack, so the inner zone comes out darker and muddier than
// the photo asks for however it's modelled. The relief still covers the whole
// blade by default, because how much is actually hidden changes as the fan is
// opened and closed — leave the inner zone blank and it shows as bare plastic
// the moment someone opens the fan wider than the modelled spread.
export function overlapRadius(m: FanModel): number {
  const n = bladeCount(m)
  if (n < 2) return 0
  const p = bladeProfile(m)
  const half = Math.sin(bladeStepRad(m) / 2)
  if (half <= 1e-6) return p.L // every blade on one angle: overlapping everywhere
  let r = 0
  for (let y = 0.5; y <= p.L; y += 0.5) {
    if (halfWidthAt(p, y) > y * half) r = y
  }
  return r
}

// Radius inside which the blade is left flat and untextured. Always at least the
// neck — blades stack and pivot against each other there, so relief would make
// them bind. `clearOverlap` pushes it out past the overlap instead, which trades
// the muddy inner zone for a deliberately plain one (and only holds at the
// modelled spread). Capped so it can never eat the whole blade.
export function reliefStartRadius(m: FanModel): number {
  const p = bladeProfile(m)
  const base = clamp(m.neckLength, p.r0 + 2, p.L * 0.6)
  return Math.min(m.clearOverlap ? Math.max(base, overlapRadius(m)) : base, p.L * 0.75)
}

// Thickness of the photograph at a point in the ASSEMBLED fan's XY plane.
//
// The picture is cover-fitted to the fan's bounding box at 100% zoom — so every
// blade is covered by real image content — then scaled by `imageZoom` and shifted
// by the offsets. Samples that fall outside the picture read as white (the
// thinnest relief), which gives a clean bright margin when zoomed out instead of
// the smeared edge pixels an edge-clamp would produce.
function fanSampler(m: FanModel, frame: FanFrame): (X: number, Y: number) => number {
  const minT = m.minThickness
  const maxT = effMaxThickness(m)
  if (!m.image) {
    const mid = (minT + maxT) / 2
    return () => mid
  }
  const gray = getGray(m.image)
  const cover = Math.max(frame.w / gray.w, frame.h / gray.h) // mm per pixel at 100%
  const mmPerPx = cover / Math.max(0.01, m.imageZoom / 100)
  return (X, Y) => {
    const px = gray.w / 2 + (X - frame.cx - m.imageOffsetX) / mmPerPx
    const py = gray.h / 2 - (Y - frame.cy - m.imageOffsetY) / mmPerPx // image row 0 = top
    const outside = px < -0.5 || py < -0.5 || px > gray.w - 0.5 || py > gray.h - 0.5
    const l = outside ? 1 : sampleLum(gray, px, py)
    const dark = m.invert ? l : 1 - l
    return minT + (maxT - minT) * dark
  }
}

// --- print layout -----------------------------------------------------------

// Where each blade goes on the plate. Blades are laid out in a grid rather than
// one long row so a full fan still fits: the row wraps at LAYOUT_MAX_W and the
// rows are then evened out.
export interface FanLayout {
  cols: number
  rows: number
  w: number
  h: number
  offsets: { x: number; y: number }[] // translation to apply to a blade-local mesh
}

export function fanLayout(m: FanModel): FanLayout {
  const n = bladeCount(m)
  const p = bladeProfile(m)
  const cw = 2 * p.hw + LAYOUT_GAP
  const ch = p.L + p.r0 + LAYOUT_GAP
  let cols = Math.min(n, Math.max(1, Math.floor((LAYOUT_MAX_W + LAYOUT_GAP) / cw)))
  const rows = Math.ceil(n / cols)
  cols = Math.ceil(n / rows) // even the rows out (9 blades over 2 rows → 5 + 4)
  const w = cols * cw - LAYOUT_GAP
  const h = rows * ch - LAYOUT_GAP
  const yc = (p.L - p.r0) / 2 // the blade's own centre along its axis
  const offsets: { x: number; y: number }[] = []
  for (let i = 0; i < n; i++) {
    const col = i % cols
    const row = Math.floor(i / cols)
    offsets.push({
      x: -w / 2 + cw * col + cw / 2,
      y: h / 2 - ch * row - ch / 2 - yc,
    })
  }
  return { cols, rows, w, h, offsets }
}

// Outer size in the VIEWPORT's axes (Y up), matching whichever pose the preview
// is showing — so the dims readout always describes what's on screen.
export function fanOuterSize(m: FanModel): { x: number; y: number; z: number } {
  const maxT = effMaxThickness(m)
  if (m.preview === 'assembled') {
    const f = fanFrame(m)
    return { x: f.w, y: f.h, z: (bladeCount(m) - 1) * (maxT + STACK_GAP) + maxT }
  }
  const l = fanLayout(m)
  return { x: l.w, y: maxT, z: l.h }
}

// --- placement --------------------------------------------------------------

// Place freshly built blades for the viewport (Y-up, sitting on the plate) in
// the chosen preview pose. Mutates in place — callers pass fresh geometry.
export function orientFanForPreview(
  blades: THREE.BufferGeometry[],
  m: FanModel,
): THREE.BufferGeometry[] {
  if (m.preview === 'assembled') {
    // Open the fan: rotate each blade to its angle about the pivot and stack it
    // in thickness. Lifting by the frame's lowest point puts the fan on the
    // plate — for a wide spread the outermost blade dips further than the pivot.
    const lift = -fanFrame(m).minY
    const stack = effMaxThickness(m) + STACK_GAP
    blades.forEach((g, i) => {
      g.rotateZ(bladeAngle(m, i))
      g.translate(0, lift, i * stack)
      g.computeBoundingBox()
    })
    return blades
  }
  // The print layout, lain down: the blades are modelled in the XY plane with
  // the relief toward +Z, so rotating -90° about X drops them onto the plate
  // relief-up. The layout is already centred on the origin, so nothing else
  // needs moving.
  const { offsets } = fanLayout(m)
  blades.forEach((g, i) => {
    const o = offsets[i]
    g.translate(o.x, o.y, 0)
    g.rotateX(-Math.PI / 2)
    g.computeBoundingBox()
  })
  return blades
}

// Place blades for PRINT. A blade is modelled with its flat back on z=0 and the
// relief toward +Z, which is already print space (back on the bed, relief up) —
// exactly like a flat lithophane panel, so the exporter rotates nothing. All
// this does is move each blade to its slot on the plate. Mutates in place.
export function placeFanForPrint(
  blades: THREE.BufferGeometry[],
  m: FanModel,
): THREE.BufferGeometry[] {
  const { offsets } = fanLayout(m)
  blades.forEach((g, i) => {
    const o = offsets[i]
    g.translate(o.x, o.y, 0)
    g.computeBoundingBox()
  })
  return blades
}

// --- main build --------------------------------------------------------------

export function buildFan(m: FanModel): BuiltFan {
  const n = bladeCount(m)
  const p = bladeProfile(m)
  const maxT = effMaxThickness(m)
  const hubT = clamp(m.hubThickness, m.minThickness, maxT)
  const frame = fanFrame(m)
  const sample = fanSampler(m, frame)
  const rStart = reliefStartRadius(m)

  // Grid extent: the blade's own bounding box plus the trim overshoot.
  const gx0 = -p.hw - MARGIN
  const gw = 2 * p.hw + 2 * MARGIN
  const gy0 = -p.r0 - MARGIN
  const gh = p.L + p.r0 + 2 * MARGIN

  // Effective pitch, backed off if the requested one would blow the cell budget
  // across all the blades.
  const pitch = Math.max(m.pitch, Math.sqrt((gw * gh * n) / MAX_CELLS))
  const nx = Math.max(2, Math.round(gw / pitch) + 1)
  const ny = Math.max(2, Math.round(gh / pitch) + 1)
  const dx = gw / (nx - 1)
  const dy = gh / (ny - 1)

  // Every blade has the same outline and pivot hole, so the trim tool is built
  // once and reused — one boolean per blade.
  const tool = trimTool(m, maxT)

  const blades: THREE.BufferGeometry[] = []
  for (let i = 0; i < n; i++) {
    const a = bladeAngle(m, i)
    const ca = Math.cos(a)
    const sa = Math.sin(a)

    // Blade-local (x,y) → where that point lands in the open fan → the picture.
    // Inside rStart the blade is a flat plate: blades have to stack cleanly
    // around the pivot, and relief there would be buried under other blades.
    const zRaw = (x: number, y: number): number => {
      const r = Math.hypot(x, y)
      if (r <= rStart) return hubT
      const t = sample(x * ca - y * sa, x * sa + y * ca)
      const f = Math.min(1, (r - rStart) / HUB_BLEND)
      return hubT + (t - hubT) * f
    }

    let zAt: (x: number, y: number, i: number, j: number) => number = (x, y) => zRaw(x, y)
    if (m.dither) {
      const raw = new Float32Array(nx * ny)
      for (let j = 0; j < ny; j++) {
        for (let k = 0; k < nx; k++) raw[j * nx + k] = zRaw(gx0 + k * dx, gy0 + j * dy)
      }
      const d = ditherGrid(nx, ny, raw, m.layerHeight, Math.min(m.minThickness, hubT), maxT)
      // The hub zone is re-flattened after dithering: error diffusing in from
      // the relief boundary would otherwise leave a layer of speckle on the
      // faces the blades pivot against.
      if (d) zAt = (x, y, k, j) => (Math.hypot(x, y) <= rStart ? hubT : d[j * nx + k])
    }

    // Trim the grid to the blade outline (and open the pivot hole). NO weld()
    // afterwards, for the same reason as the lithophane panel: the input is
    // manifold by construction and the CSG output is manifold, and welding a
    // trimmed relief grid fuses its pinch points into non-manifold edges. Verify
    // fan blades with the exact index-based edge test, not a quantized one.
    blades.push(csgIntersect(heightfieldMesh(gx0, gy0, gw, gh, nx, ny, zAt), tool))
  }

  return { blades, size: fanOuterSize(m) }
}
