// Core data model for the bin builder.
//
// Gridfinity-aware but not constrained: a bin is defined on a grid of `gridUnit`
// millimetres (42mm == standard Gridfinity), with integer unit counts in X/Y/Z.
// Setting `customSize` frees the footprint from the grid entirely.

export type SocketStyle = 'none' | 'corner' | 'full'
export type LipStyle = 'default' | 'thin' | 'none'

// A divider that splits the interior into compartments. `axis: 'x'` means the
// wall runs across the X span, partitioning the bin along X. `position` is a
// fraction (0..1) of the interior span on that axis.
export interface Divider {
  id: string
  axis: 'x' | 'y'
  position: number
}

export interface BinModel {
  // Gridfinity features master switch. When true, the bin gets the chamfered
  // stacking foot, baseplate clearance, the standard corner radius, and access
  // to magnet/screw sockets. When false it's a plain tray with a flat bottom and
  // no Gridfinity-specific geometry. Independent of how the bin is *sized*:
  // either mode can be sized by grid units or by freeform mm.
  gridfinity: boolean

  // Grid definition
  gridUnit: number // mm per grid unit (42 = Gridfinity)
  unitsX: number
  unitsY: number
  unitsZ: number // height in 7mm-equivalent z-units when not custom

  // Freeform override of the footprint/height in mm
  customSize: boolean
  sizeX: number // mm
  sizeY: number // mm
  sizeZ: number // mm

  // Construction
  outerWall: number // mm
  innerWall: number // mm (divider thickness)
  lip: LipStyle
  magnets: SocketStyle
  screws: SocketStyle

  // Interior subdivisions
  dividers: Divider[]

  // Per-compartment features applied to every compartment
  scoop: boolean // curved finger-scoop ramp on the back wall
  label: boolean // angled label tab overhang along the back edge
}

// Gridfinity-standard constants (used as sensible defaults; all overridable).
// The base foot is a three-step chamfer profile (the canonical 0.8 / 1.8 / 2.15
// rise stack that mates with a baseplate).
export const GRIDFINITY = {
  unit: 42, // mm grid pitch
  zUnit: 7, // mm per height unit
  baseHeight: 4.75, // mm total height of the stacking foot profile
  clearance: 0.5, // mm gap so bins drop into a baseplate
  lipHeight: 3.6, // mm of the upper stacking lip
  // Chamfered foot steps (rise, horizontal inset) from the outer footprint up.
  foot: {
    bottomChamfer: 0.8, // 45deg chamfer at the very bottom
    straight: 1.8, // vertical mid section
    topChamfer: 2.15, // 45deg chamfer transitioning to full footprint
  },
  cornerRadius: 3.75, // mm outer corner fillet radius
  // Magnet + screw socket geometry
  magnetDiameter: 6.5,
  magnetDepth: 2.4,
  screwDiameter: 3.0,
  screwDepth: 6.0,
  socketInset: 8.0, // mm from each grid-cell edge to socket centre (~13mm/2 spec ≈ 4.8 from corner)
} as const

export function defaultBin(): BinModel {
  return {
    gridfinity: true,
    gridUnit: 42,
    unitsX: 2,
    unitsY: 2,
    unitsZ: 3,
    customSize: false,
    sizeX: 84,
    sizeY: 84,
    sizeZ: 25.4,
    outerWall: 1.2,
    innerWall: 0.8,
    lip: 'default',
    magnets: 'none',
    screws: 'none',
    dividers: [],
    scoop: false,
    label: false,
  }
}

// Resolve the model into concrete outer dimensions in mm.
export function resolvedSize(m: BinModel): { x: number; y: number; z: number } {
  if (m.customSize) {
    return { x: m.sizeX, y: m.sizeY, z: m.sizeZ }
  }
  // On a grid: Gridfinity bins shrink by the baseplate clearance so they drop
  // into a baseplate; a plain tray uses the full grid footprint.
  const clearance = m.gridfinity ? GRIDFINITY.clearance : 0
  return {
    x: m.unitsX * m.gridUnit - clearance,
    y: m.unitsY * m.gridUnit - clearance,
    z: m.unitsZ * GRIDFINITY.zUnit,
  }
}
