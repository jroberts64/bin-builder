import * as THREE from 'three'
import { csgAdd, csgIntersect, csgSubtract, weld } from './csg'
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
import { THREAD, ThreadSpec, threadSpec, threadedRod } from './thread'

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

// How the blades are held together at the pivot.
//   'screw' — a printed two-part barrel post + screw is generated and exported
//             alongside the blades (see "the pivot screw" below). The blade hole
//             is sized to the barrel, so it has a minimum (MIN_SCREW_PIVOT).
//   'hole'  — just a hole; bring your own M3 screw, washer and nut.
export type FanPivotStyle = 'screw' | 'hole'

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
  hubThickness: number // mm, flat thickness of the eye/neck zone. 0 = AUTO: track the
  // relief, which is what the stack needs. Above that it's an explicit floor — a
  // deliberately thicker eye for strength. It can never go BELOW the relief (see
  // `hubPlateThickness`), so a value under the auto one would be a no-op.
  pivotStyle: FanPivotStyle // printed screw, or a plain hole for hardware
  pivotDiameter: number // mm, the hole through the blade eye
  pitch: number // mm per relief sample
  invert: boolean // flip light/dark
  tone: number // %, Beer–Lambert tone correction (0 = the raw linear ramp)
  clearOverlap: boolean // leave the inner zone where blades overlap flat instead of relieved
  borderWidth: number // mm, rim of solid maxThickness around the blade. 0 = off
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
    // Proportions taken off the commercial BTS fan (see the tonal-range note
    // below), which is a much more elegant blade than the stubby one this used
    // to default to: a long 4.8:1 blade on a neck pinched to ~0.29 of its width,
    // so the eye reads as a boss and the fan closes to a slim stick. Its real
    // dimensions, not merely its ratios: 133x28mm blades on an 8mm neck, eleven
    // of them, giving a 262x140mm open fan — a concert fan rather than the
    // 197mm one this used to default to.
    //
    // THE PLATE LAYOUT NO LONGER FITS A 256mm BED. It is 183x283mm, 27mm too
    // deep, because the layout is two rows of (bladeLength + eye + gap) and a
    // 133mm blade makes each row 143mm. Blade COUNT does not help — nine blades
    // at this length are still 283mm deep — and one row of twelve items would
    // be 324mm wide, so no arrangement of this fan fits a 256 bed. That is
    // inherent to the size, and the reference has exactly the same problem: it
    // ships as TWO plates, six items on one and five on the other. A single row
    // is only 183x140mm, so a per-row split lands comfortably on a 256 bed if
    // multi-plate export is ever built. Note `LAYOUT_MAX_W` bounds layout WIDTH
    // only and does not protect against this.
    //
    // The range is snapped to the layer height below, which is worth doing
    // because `ditherGrid` rounds the ends INWARD to whole layers: off-grid ends
    // are simply thrown away. 0.3-2.2 at 0.1mm is 3 and 22 layers exactly, so
    // nothing is lost and the modelled relief is what the printer can build --
    // 20 grey levels and 2.88 stops, against 0.35-2.2's 19 levels and 2.73.
    // The loss is NOT monotonic in layer height, so a finer setting is not
    // reliably better: over this range NOTHING between 0.2 and 0.1 beats 0.2 --
    // 0.16 is worse (2.67), 0.15 and 0.12 merely tie (2.73), 0.14 is worse
    // (2.54), and only 0.1 gains. It is the ends rounding in that decides it,
    // e.g. at 0.16 `ceil(0.3/0.16)` is 2 so the highlights floor at 0.32mm.
    // Re-snap the range if you change layer height; the controls step in 0.01
    // so it can be done exactly.
    blades: 11,
    // 150°, not the 160° this used to be, because blade count, spread, length
    // and width are ONE CONSTRAINT APART and 160° broke it: the blades only
    // reach each other at ~149° (`bladesMeetAtDeg`), so a 160° fan stood open
    // with wedge-shaped gaps between every pair — 15% of its area. Closing that
    // by widening the blade instead would work, but it drags the silhouette off
    // the reference proportions (4.4:1 rather than 4.8:1), and the reference
    // solves it the other way: a 28mm blade opening to ~141°. Costs 6mm of fan
    // width against 160°, since sin is flat up there.
    spreadDeg: 150,
    bladeLength: 133,
    bladeWidth: 28,
    neckWidth: 8,
    neckLength: 29,
    tip: 'petal',
    // The tonal range IS the picture's contrast: transmission through the relief
    // is e^(-mu*t), so what the eye gets is set by the difference between these
    // two, not their ratio. 0.35–2.2mm is ~2.9 stops. The old 0.6–1.8 was 1.8
    // stops — half the contrast — and measuring a well-regarded commercial fan
    // (0.33–2.21mm, 0.12mm layers) is what set these. The thin end is free:
    // blade spacing follows maxThickness alone, so only the thick end costs
    // stack height (0.4mm/blade here, ~3.6mm on a nine-blade hub).
    minThickness: 0.3,
    maxThickness: 2.2,
    hubThickness: 0, // auto: track the relief
    pivotStyle: 'screw',
    pivotDiameter: 8,
    pitch: 0.35,
    invert: false,
    tone: 100,
    clearOverlap: false,
    // A rim of full-thickness material around the outline. Measured off the
    // reference fan, which runs ~1.2mm of solid maxThickness around every blade
    // before the relief starts (92-100% of cells within 1.05mm of the edge are
    // at max, falling to the picture's own 40% dark fraction by 1.35mm). It is
    // structural first: that fan's relief bottoms out at ONE printed layer, and
    // a rim is what keeps such a blade from being a floppy membrane with a
    // feathered, tear-prone edge. It frames the picture as a side effect --
    // at maxThickness it reads dark when backlit.
    borderWidth: 1.2,
    imageZoom: 100,
    imageOffsetX: 0,
    imageOffsetY: 0,
    dither: true,
    // 0.1 rather than 0.2: a blade is 2.2mm, so this only doubles it to 22
    // layers, and it nearly doubles the printable greys (10 -> 20). It also
    // divides the usual 0.2mm first layer, so the dither's grid and the
    // printer's real layer boundaries coincide instead of sitting offset.
    layerHeight: 0.1,
    preview: 'assembled',
  }
}

export interface BuiltFan {
  blades: THREE.BufferGeometry[]
  hardware: THREE.BufferGeometry[] // [post, screw] with pivotStyle 'screw', else []
  size: { x: number; y: number; z: number }
}

// The relief grid overshoots the blade outline by this much before the CSG trim,
// so the trim is a clean cut and never a coplanar graze of the grid's own walls.
const MARGIN = 1.5
// Total relief cells across ALL blades, so blade count trades against detail
// rather than building a mesh too heavy to preview or slice.
//
// It is shared, but it is NOT the panel's budget: a lithophane panel gets 160k
// cells to itself, and splitting that across nine blades left each one sampling
// about a third as densely per mm² as a panel (~0.42mm pitch). That is roughly
// one extrusion width, so it barely costs detail in the picture plane — but it
// does coarsen the dither halftone, which is what carries tone between the few
// layer steps a thin blade has. At this budget the default fan lands near 0.3mm,
// matching the panel, for ~2x the triangles.
const MAX_CELLS = 300_000
// mm over which thickness ramps from the flat hub zone into the relief, so there
// is no cliff between them.
const HUB_BLEND = 2
// Clearance between a blade's relief and the back of the next blade in the stack
// (see `hubPlateThickness`). Small on purpose: the blades are separate parts
// assembled by hand, so unlike a print-in-place hinge there is no risk of them
// fusing — this only has to cover print tolerance and let them slide. Every
// 0.1mm here is another 0.1mm on every blade AND on the hub stack, which is what
// makes a fan feel chunky.
const BLADE_SWING_GAP = 0.2
// Material left around the pivot hole in the blade eye. This is what gives the
// blade its bulbous eye once the hole is sized for a printed screw.
const HUB_RING = 3
// mm over which the solid border ramps into the relief, so the rim is not a
// cliff the picture falls off.
const BORDER_BLEND = 0.4
// Print layout: gap between blades, and the width to wrap the row at (blades
// past this go to a second row, which keeps a 9-blade fan on one plate).
const LAYOUT_GAP = 3
const LAYOUT_MAX_W = 220

// --- the pivot screw -------------------------------------------------------
// A two-part barrel post, the printed equivalent of a Chicago screw: a flanged
// post whose barrel threads the blade holes, and a screw that tightens into the
// barrel's bore from the far side. The BARREL LENGTH sets the spacing, so the
// screw bottoms out against the barrel's end face and never against the blades —
// which is the whole point, because a fan has to keep turning. Tightening it
// hard cannot seize the stack.
const PIVOT_SLIP = 0.3 // barrel OD under the blade hole, so the blades turn on it
const BARREL_WALL = 1.2 // material around the threaded bore
const PIVOT_PLAY = 0.4 // barrel longer than the stack, so the blades stay loose
const CAP_RING = 2.5 // how far the flange and head overhang the hole
const FLANGE_T = 1.8
const HEAD_T = 2.4
const BORE_RUNOUT = 1.5 // bore deeper than the screw, so it seats on the barrel face
const HEAD_FLUTES = 8 // scallops round the head rim, to finger-tighten

// The blade hole can't shrink below this in 'screw' mode: the barrel has to fit
// through it, the bore has to fit inside the barrel, and the thread in that bore
// still has to be printable (THREAD.MIN_MAJOR). Enforced in `coerceFan` against
// the resolved pivot style, and again by `effPivotDiameter`.
export const MIN_SCREW_PIVOT = THREAD.MIN_MAJOR + 2 * BARREL_WALL + PIVOT_SLIP + 0.1

// The image decode is async but buildFan is sync, so the decoded grayscale lives
// in relief.ts's cache: await this before buildFan (Viewport and the export paths
// do), exactly like the lithophane panel.
export const prepareFanImage = (m: FanModel) => prepareImage(m.image)

function effMaxThickness(m: FanModel): number {
  return Math.max(m.maxThickness, m.minThickness + 0.2)
}

export function effPivotDiameter(m: FanModel): number {
  return m.pivotStyle === 'screw' ? Math.max(m.pivotDiameter, MIN_SCREW_PIVOT) : m.pivotDiameter
}

// Diameter of the blade's EYE — the round end around the pivot hole. Derived,
// not a control: the hole always has to keep `HUB_RING` of material around it,
// and once the hole is sized for a printed screw that alone makes the eye wider
// than the neck. Hence the shape a fan blade actually wants: a bulbous eye, a
// pinched waist, then the flare out to the blade.
export function hubDiameter(m: FanModel): number {
  return Math.max(m.neckWidth, effPivotDiameter(m) + 2 * HUB_RING)
}

// The thinnest the eye plate may be: just clear of the relief.
//
// This is the floor because the eye plate's thickness is also the SPACING
// between blades — they sit eye-to-eye on the barrel. Blade i occupies
// z ∈ [i·p, i·p + t] where p is that spacing, so anywhere two blades overlap
// (which is most of the fan — see `overlapRadius`) the relief only clears the
// back of the next blade if t ≤ p. The relief reaches `maxThickness`, so an eye
// thinner than that jams the fan solid and it can't be folded.
export function autoEyeThickness(m: FanModel): number {
  return effMaxThickness(m) + BLADE_SWING_GAP
}

// Thickness of the flat eye/neck plate, and therefore both the blade's overall
// thickness and the stack pitch.
//
// `hubThickness: 0` means AUTO — track the relief, which is all the stack needs.
// A larger value is an explicit override for a deliberately thicker eye; a
// smaller one is impossible, so it is simply floored.
//
// It used to be *only* a lower bound, with no auto: the default sat a hair above
// the floor, so the eye control and the relief control each held the other's
// result in place. Moving either one alone did nothing (dragging the eye across
// its whole range moved the blade by 0.1mm; dropping the relief moved it not at
// all, while quietly halving the picture's contrast) and the only way to a
// thinner blade was to move both, in the right order. Hence the auto default:
// one control — the relief range — decides how thick a blade is.
export function hubPlateThickness(m: FanModel): number {
  return Math.max(m.hubThickness, autoEyeThickness(m))
}

export interface FanPivot {
  pivotD: number
  barrelOD: number
  barrelLen: number
  capD: number // flange and head diameter
  flangeT: number
  headT: number
  threadLen: number // engagement length
  boreDepth: number
  thread: ThreadSpec
  stackH: number
  totalH: number // flange + barrel + head, i.e. the assembled hub height
}

// Resolve the printed pivot hardware, or null when the pivot is a plain hole.
export function fanPivot(m: FanModel): FanPivot | null {
  if (m.pivotStyle !== 'screw') return null
  const pivotD = effPivotDiameter(m)
  const barrelOD = pivotD - PIVOT_SLIP
  const majorD = barrelOD - 2 * BARREL_WALL
  if (majorD < THREAD.MIN_MAJOR) return null // unreachable: MIN_SCREW_PIVOT guarantees it
  const thread = threadSpec(majorD)
  const stackH = bladeCount(m) * hubPlateThickness(m)
  const barrelLen = stackH + PIVOT_PLAY
  // Only the top of the bore is threaded: a screw as long as the whole barrel
  // would take a dozen turns to fit for no extra strength, since the head pulls
  // against the barrel's end face right where the engagement is. The bore is
  // allowed to reach down into the flange (leaving a floor), so a fan of two or
  // three blades still gets what engagement its short barrel can offer.
  const threadLen = clamp(majorD * 1.6, 1.5, FLANGE_T + barrelLen - BORE_RUNOUT - 0.8)
  return {
    pivotD,
    barrelOD,
    barrelLen,
    capD: Math.max(barrelOD + 2, Math.min(hubDiameter(m) - 1, pivotD + 2 * CAP_RING)),
    flangeT: FLANGE_T,
    headT: HEAD_T,
    threadLen,
    boreDepth: threadLen + BORE_RUNOUT,
    thread,
    stackH,
    totalH: FLANGE_T + barrelLen + HEAD_T,
  }
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
// Tip length as a multiple of the blade's half-width. These are short on
// purpose: a long tip forces the blade to reach FULL WIDTH early, and a blade at
// full width near the pivot is one that buries its neighbours. See `flare`.
const TIP_LEN: Record<FanTip, number> = { round: 0.8, point: 1.2, petal: 1.5 }

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
  r0: number // eye radius (also the root cap radius)
  eyeHold: number // the eye stays full width out to here
  waistEnd: number // ...then pinches in to the neck by here
  neckHW: number // half-width of the pinched neck
  neck: number // the neck runs out to here
  flare: number // mm over which the neck widens to full width
  tipStart: number // where the tip section begins
  tip: FanTip
}

// Resolve the model's blade dimensions into a consistent profile: every span is
// clamped against the others so a short blade with a long neck and a long tip
// still produces a sane silhouette instead of a self-crossing one.
function bladeProfile(m: FanModel): BladeProfile {
  const L = m.bladeLength
  const r0 = hubDiameter(m) / 2
  const hw = Math.max(m.bladeWidth, m.neckWidth + 2) / 2
  const neckHW = Math.min(m.neckWidth, hubDiameter(m)) / 2
  // Hold the eye at full width briefly so it reads as a round boss rather than a
  // cone, then pinch in over a distance proportional to the width given up.
  const eyeHold = r0 * 0.25
  const waistEnd = eyeHold + Math.max(1.5, (r0 - neckHW) * 1.8)
  const neck = clamp(m.neckLength, waistEnd + 1, L * 0.6)
  const tipLen = Math.min(hw * TIP_LEN[m.tip], (L - neck) * 0.75)
  const tipStart = L - tipLen
  // Widen over very nearly the whole body, so the blade only reaches full width
  // just before the tip.
  //
  // THIS IS WHAT DECIDES HOW MUCH OF THE PICTURE THE FAN BURIES, and it is not
  // obvious from looking at one blade. Adjacent blades Δθ apart overlap wherever
  // `halfWidth(r) > r·sin(Δθ/2)`, so a blade that reaches full width close to
  // the pivot is buried by its neighbours over most of its length. The old rule
  // widened over a distance proportional to the width gained — ~18mm on the
  // default blade, full width by r=47 of 133 — and buried **43%** of the picture
  // area at the default 11 blades / 160°. Widening over 0.95 of the body instead
  // reaches full width at r≈108 and buries **1%**. The reference fan is shaped
  // the same way (full width by ~110mm) and buries 0%.
  const flare = (tipStart - neck) * 0.95
  return { L, hw, r0, eyeHold, waistEnd, neckHW, neck, flare, tipStart, tip: m.tip }
}

// Half-width of the blade at distance y along its axis from the pivot: the eye,
// a smoothstep waist in to the neck, the neck, a smoothstep flare out to full
// width, the body, then the tip.
function halfWidthAt(p: BladeProfile, y: number): number {
  const smooth = (t: number) => t * t * (3 - 2 * t)
  if (y <= p.eyeHold) return p.r0
  if (y < p.waistEnd) {
    const t = clamp01((y - p.eyeHold) / Math.max(1e-6, p.waistEnd - p.eyeHold))
    return p.r0 + (p.neckHW - p.r0) * smooth(t)
  }
  if (y <= p.neck) return p.neckHW
  if (y >= p.tipStart) {
    const s = clamp01((y - p.tipStart) / Math.max(1e-6, p.L - p.tipStart))
    return p.hw * clamp01(tipShape(p.tip, s))
  }
  // LINEAR, not smoothstepped. Blades tile the open fan exactly when
  // halfWidth(r) = r·sin(Δθ/2) — a straight wedge from the pivot. A smoothstep
  // starts shallow and so runs under that line through the inner half of the
  // blade, which is a wedge-shaped GAP between neighbours (15% of the fan area
  // at the default, against 11% for the straight taper).
  const t = clamp01((y - p.neck) / Math.max(1e-6, p.flare))
  return p.neckHW + (p.hw - p.neckHW) * t
}

// Same, but including the round root cap below the pivot (y < 0), so this is the
// blade's full silhouette. Used for bounding boxes and the grid extent.
function silhouetteHalfWidth(p: BladeProfile, y: number): number {
  if (y < 0) return Math.sqrt(Math.max(0, p.r0 * p.r0 - y * y))
  return halfWidthAt(p, y)
}

// The spread at which adjacent blades exactly TOUCH at their widest point.
//
// Blades tile the open fan when `halfWidth(r) = r·sin(Δθ/2)`; the binding radius
// is where the blade is widest, just before the tip. Open the fan wider than
// this and wedge-shaped gaps appear between blades; narrower and they bury each
// other. Four controls — blade count, spread, length and width — are one
// constraint apart, and nothing in the geometry stops them disagreeing, so the
// UI reports this number rather than silently resolving it.
export function bladesMeetAtDeg(m: FanModel): number {
  const p = bladeProfile(m)
  // The binding radius is where the blade FIRST reaches full width — the end of
  // the flare, not the start of the tip. It stays full width between the two,
  // and the inner end of that run is what touches its neighbour first.
  const rWidest = Math.min(p.tipStart, p.neck + p.flare)
  const half = Math.asin(Math.min(1, p.hw / Math.max(1e-6, rWidest)))
  return ((2 * half * 180) / Math.PI) * (bladeCount(m) - 1)
}

// Distance in from the blade's silhouette, for the border rim.
//
// The outline is a 1-D half-width profile, so the lateral gap has to be divided
// by the profile's own slope to become a true PERPENDICULAR distance. Without
// that correction the rim pinches to nothing wherever the outline runs steeply
// — which is the tip and the waist, exactly where a thin edge is most fragile.
function edgeInset(p: BladeProfile, x: number, y: number): number {
  if (y <= 0) return p.r0 - Math.hypot(x, y) // the round root cap below the pivot
  const h = 0.25
  const ya = Math.max(0, y - h)
  const yb = Math.min(p.L, y + h)
  const slope = yb > ya ? (halfWidthAt(p, yb) - halfWidthAt(p, ya)) / (yb - ya) : 0
  const lateral = (halfWidthAt(p, y) - Math.abs(x)) / Math.hypot(1, slope)
  return Math.min(lateral, p.L - y) // ...and the tip end
}

// The y values the outline is sampled at: uniform along the blade, plus extra
// density through the two sections where the profile curves hardest — the eye's
// waist and the tip.
function outlineYs(p: BladeProfile): number[] {
  const ys: number[] = []
  const body = 80
  for (let k = 0; k <= body; k++) ys.push((p.L * k) / body)
  const tipN = 40
  for (let k = 1; k < tipN; k++) ys.push(p.tipStart + ((p.L - p.tipStart) * k) / tipN)
  const waistN = 24
  for (let k = 1; k < waistN; k++) ys.push((p.waistEnd * k) / waistN)
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

// --- pivot hardware ---------------------------------------------------------

// A cylinder along +Z spanning z ∈ [z0, z0+h], welded ready for CSG.
function post0(d: number, z0: number, h: number, seg = 64): THREE.BufferGeometry {
  const c = new THREE.CylinderGeometry(d / 2, d / 2, h, seg)
  c.rotateX(Math.PI / 2) // cylinder axis Y → Z
  c.translate(0, 0, z0 + h / 2)
  return weld(c)
}

// The barrel post and its screw, both modelled axis-along-Z in their PRINT pose:
// flange down / head down on z=0, threads pointing up. Axis-Z is also the fan's
// own pivot axis, so the same geometry drops straight into the assembled view.
//
// Threads must print with the axis vertical — that way each thread turn is just
// a layer's worth of circle, and the flanks (~50° here) are self-supporting. A
// thread printed on its side needs supports inside the helix and comes out
// unusable.
function buildFanHardware(m: FanModel): THREE.BufferGeometry[] {
  const pv = fanPivot(m)
  if (!pv) return []
  const EPS = 0.01 // additive parts must overlap, never meet coplanar

  // --- post: flange on the plate, barrel up, threaded bore down from its top.
  const barrelTop = pv.flangeT + pv.barrelLen
  const body = csgAdd(
    post0(pv.capD, 0, pv.flangeT),
    post0(pv.barrelOD, pv.flangeT - EPS, pv.barrelLen + EPS),
  )
  // The bore tool overshoots the barrel's end face by more than its own lead-in
  // taper, so the thread is full depth right at the mouth and the screw starts.
  const over = pv.thread.pitch + 1
  const post = csgSubtract(
    body,
    threadedRod(pv.thread, barrelTop - pv.boreDepth, pv.boreDepth + over, {
      grow: THREAD.FIT,
    }),
  )

  // --- screw: head down (its flat face is the one on show once assembled),
  // threaded shaft up. The shaft's start lead is switched off and buried in the
  // head instead, so the engagement is full depth over its whole length.
  const shaftBase = pv.headT - 1.5
  let screw = csgAdd(
    post0(pv.capD, 0, pv.headT),
    threadedRod(pv.thread, shaftBase, pv.threadLen + 1.5, { leadStart: false }),
  )
  // Scallops round the rim to finger-tighten: vertical walls, so they print
  // clean, and they cross the head's side surface transversally (no coplanar
  // overlap for Manifold to pinch on).
  const flutes: THREE.BufferGeometry[] = []
  for (let i = 0; i < HEAD_FLUTES; i++) {
    const a = (2 * Math.PI * i) / HEAD_FLUTES
    const c = post0(2.2, -1, pv.headT + 2, 24)
    c.translate((Math.cos(a) * pv.capD) / 2, (Math.sin(a) * pv.capD) / 2, 0)
    flutes.push(c)
  }
  screw = csgSubtract(screw, ...flutes)

  return [post, screw]
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
// blade is covered by real image content — then scaled UP by `imageZoom` (200% =
// twice as large on the fan, i.e. a tighter crop) and shifted by the offsets.
// Samples that fall outside the picture read as white (the thinnest relief),
// which gives a clean bright margin below 100% instead of the smeared edge
// pixels an edge-clamp would produce.
function fanSampler(m: FanModel, frame: FanFrame): (X: number, Y: number) => number {
  const minT = m.minThickness
  const maxT = effMaxThickness(m)
  if (!m.image) {
    const mid = (minT + maxT) / 2
    return () => mid
  }
  const gray = getGray(m.image)
  const cover = Math.max(frame.w / gray.w, frame.h / gray.h) // mm per pixel at 100%
  // Zoom SCALES the picture on the fan, so it multiplies here: at 200% the photo
  // is twice as big, every pixel covers twice as many mm, and the fan sees half
  // as much of it — a tighter crop. Dividing inverts the control, which is the
  // bug this replaces: 400% rendered the picture at quarter size and left most
  // of the fan at minimum thickness, i.e. blank.
  const mmPerPx = cover * Math.max(0.01, m.imageZoom / 100)
  return (X, Y) => {
    const px = gray.w / 2 + (X - frame.cx - m.imageOffsetX) / mmPerPx
    const py = gray.h / 2 - (Y - frame.cy - m.imageOffsetY) / mmPerPx // image row 0 = top
    const outside = px < -0.5 || py < -0.5 || px > gray.w - 0.5 || py > gray.h - 0.5
    const l = outside ? 1 : sampleLum(gray, px, py)
    return thicknessForLuminance(m.invert ? 1 - l : l, minT, maxT, m.tone)
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
  hardware: { x: number; y: number }[] // ...and to each pivot part, same order
}

export function fanLayout(m: FanModel): FanLayout {
  const n = bladeCount(m)
  const pv = fanPivot(m)
  // The two pivot parts are small enough to share one blade cell (a cell is over
  // 100mm long and they are ~13mm across), so the grid only grows by one.
  const items = n + (pv ? 1 : 0)
  const p = bladeProfile(m)
  const cw = 2 * p.hw + LAYOUT_GAP
  const ch = p.L + p.r0 + LAYOUT_GAP
  let cols = Math.min(items, Math.max(1, Math.floor((LAYOUT_MAX_W + LAYOUT_GAP) / cw)))
  const rows = Math.ceil(items / cols)
  cols = Math.ceil(items / rows) // even the rows out (10 items over 2 rows → 5 + 5)
  const w = cols * cw - LAYOUT_GAP
  const h = rows * ch - LAYOUT_GAP
  const cell = (i: number) => ({
    x: -w / 2 + cw * (i % cols) + cw / 2,
    y: h / 2 - ch * Math.floor(i / cols) - ch / 2,
  })
  const yc = (p.L - p.r0) / 2 // the blade's own centre along its axis
  const offsets: { x: number; y: number }[] = []
  for (let i = 0; i < n; i++) {
    const c = cell(i)
    offsets.push({ x: c.x, y: c.y - yc })
  }
  const hardware: { x: number; y: number }[] = []
  if (pv) {
    const c = cell(n)
    const gap = pv.capD / 2 + 2
    hardware.push({ x: c.x, y: c.y - gap }, { x: c.x, y: c.y + gap })
  }
  return { cols, rows, w, h, offsets, hardware }
}

// Outer size in the VIEWPORT's axes (Y up), matching whichever pose the preview
// is showing — so the dims readout always describes what's on screen.
export function fanOuterSize(m: FanModel): { x: number; y: number; z: number } {
  const maxT = effMaxThickness(m)
  const pv = fanPivot(m)
  const p = hubPlateThickness(m)
  if (m.preview === 'assembled') {
    const f = fanFrame(m)
    // The hub is the tallest thing in the assembled fan: the whole blade stack
    // plus the post flange under it and the screw head on top.
    const z = pv ? pv.totalH : (bladeCount(m) - 1) * p + maxT
    return { x: f.w, y: f.h, z }
  }
  const l = fanLayout(m)
  // On the plate the blades are ~2mm tall but the pivot parts stand on end.
  return { x: l.w, y: Math.max(maxT, pv ? pv.flangeT + pv.barrelLen : 0), z: l.h }
}

// --- placement --------------------------------------------------------------

// Place a freshly built fan for the viewport (Y-up, sitting on the plate) in the
// chosen preview pose. Mutates in place — callers pass fresh geometry.
export function orientFanForPreview(built: BuiltFan, m: FanModel): BuiltFan {
  const pv = fanPivot(m)
  if (m.preview === 'assembled') {
    // Open the fan: rotate each blade to its angle about the pivot and stack it
    // at the real eye-to-eye spacing (which is why that spacing has to clear the
    // relief — otherwise this render would show blades intersecting, because the
    // print would). Lifting by the frame's lowest point puts the fan on the
    // plate: for a wide spread the outermost blade dips below the pivot.
    const lift = -fanFrame(m).minY
    const p = hubPlateThickness(m)
    const base = pv ? pv.flangeT : 0 // the stack sits on the post's flange
    built.blades.forEach((g, i) => {
      g.rotateZ(bladeAngle(m, i))
      g.translate(0, lift, base + i * p)
      g.computeBoundingBox()
    })
    if (pv) {
      const [post, screw] = built.hardware
      post.translate(0, lift, 0)
      // Flip the screw over: it is modelled head-down for printing, but sits
      // head-up on the barrel's end face with the shaft reaching back down the
      // bore. The gap left by PIVOT_PLAY is what keeps the blades turning.
      // (A 180° rotation is proper, so it preserves the thread's handedness.)
      screw.rotateX(Math.PI)
      // Screw it in far enough to be in phase. The bore was cut by a tool whose
      // helix is keyed to z=0, so a shaft landing `dz` up the axis only mates
      // when turned by dz/pitch of a turn — otherwise the modelled screw sits
      // crossing the bore's threads and the assembled fan is interfering solids.
      const dz = pv.flangeT + pv.barrelLen + pv.headT
      screw.rotateZ((dz * 2 * Math.PI) / pv.thread.pitch)
      screw.translate(0, lift, dz)
      post.computeBoundingBox()
      screw.computeBoundingBox()
    }
    return built
  }
  // The print layout, lain down: parts are modelled in the XY plane with the
  // relief (and the screw axis) toward +Z, so rotating -90° about X drops the
  // blades onto the plate relief-up and stands the pivot parts on end — which is
  // exactly how each has to print. The layout is already centred on the origin.
  const l = fanLayout(m)
  const lay = (g: THREE.BufferGeometry, o: { x: number; y: number }) => {
    g.translate(o.x, o.y, 0)
    g.rotateX(-Math.PI / 2)
    g.computeBoundingBox()
  }
  built.blades.forEach((g, i) => lay(g, l.offsets[i]))
  built.hardware.forEach((g, i) => lay(g, l.hardware[i]))
  return built
}

// Place a fan for PRINT. Every part is modelled in its print pose already — a
// blade with its flat back on z=0 and the relief toward +Z (like a flat
// lithophane panel), and the pivot parts standing on the axis they must print
// about — so the exporter rotates nothing. All this does is move each part to
// its slot on the plate. Mutates in place.
export function placeFanForPrint(built: BuiltFan, m: FanModel): BuiltFan {
  const l = fanLayout(m)
  const move = (g: THREE.BufferGeometry, o: { x: number; y: number }) => {
    g.translate(o.x, o.y, 0)
    g.computeBoundingBox()
  }
  built.blades.forEach((g, i) => move(g, l.offsets[i]))
  built.hardware.forEach((g, i) => move(g, l.hardware[i]))
  return built
}

// --- main build --------------------------------------------------------------

export function buildFan(m: FanModel): BuiltFan {
  const n = bladeCount(m)
  const p = bladeProfile(m)
  const maxT = effMaxThickness(m)
  const hubT = hubPlateThickness(m) // the eye plate — also the blade spacing
  const frame = fanFrame(m)
  const sample = fanSampler(m, frame)
  const bw = m.borderWidth
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
  // once and reused — one boolean per blade. The eye plate is the blade's
  // thickest point (it has to clear the relief), so it sets the tool's height.
  const tool = trimTool(m, Math.max(maxT, hubT))

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
      let t = sample(x * ca - y * sa, x * sa + y * ca)
      if (bw > 0) {
        // Solid rim around the outline, ramped into the picture. Cells beyond
        // the outline (the trim overshoot) come out at maxT too, so the cut
        // passes through full-thickness material and leaves a clean edge.
        const d = edgeInset(p, x, y)
        if (d < bw + BORDER_BLEND) {
          const u = Math.max(0, Math.min(1, (d - bw) / BORDER_BLEND))
          t = maxT + (t - maxT) * (u * u * (3 - 2 * u))
        }
      }
      const f = Math.min(1, (r - rStart) / HUB_BLEND)
      return hubT + (t - hubT) * f
    }

    let zAt: (x: number, y: number, i: number, j: number) => number = (x, y) => zRaw(x, y)
    if (m.dither) {
      const raw = new Float32Array(nx * ny)
      for (let j = 0; j < ny; j++) {
        for (let k = 0; k < nx; k++) raw[j * nx + k] = zRaw(gx0 + k * dx, gy0 + j * dy)
      }
      // The range runs up to the eye plate, not just maxThickness: the blend out
      // of the flat hub zone legitimately passes through everything between the
      // two, and clipping it there would put a step back in.
      const d = ditherGrid(nx, ny, raw, m.layerHeight, m.minThickness, Math.max(maxT, hubT))
      // The hub zone is re-flattened after dithering: error diffusing in from
      // the relief boundary would otherwise leave a layer of speckle on the
      // faces the blades pivot against.
      // The rim is re-flattened after dithering for the same reason as the hub:
      // error diffusing in from the relief boundary would speckle a surface
      // that is meant to be solid, and the rim is structure, not picture.
      if (d)
        zAt = (x, y, k, j) =>
          Math.hypot(x, y) <= rStart
            ? hubT
            : bw > 0 && edgeInset(p, x, y) <= bw
              ? maxT
              : d[j * nx + k]
    }

    // Trim the grid to the blade outline (and open the pivot hole). NO weld()
    // afterwards, for the same reason as the lithophane panel: the input is
    // manifold by construction and the CSG output is manifold, and welding a
    // trimmed relief grid fuses its pinch points into non-manifold edges. Verify
    // fan blades with the exact index-based edge test, not a quantized one.
    blades.push(csgIntersect(heightfieldMesh(gx0, gy0, gw, gh, nx, ny, zAt), tool))
  }

  return { blades, hardware: buildFanHardware(m), size: fanOuterSize(m) }
}
