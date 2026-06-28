import { BinModel, Divider, LipStyle, SocketStyle, defaultBin } from './types'
import { BoxModel, defaultBox } from './box'

// Versioned (de)serialization for a design. Everything that persists or shares —
// localStorage, .json files, share URLs — goes through here so there is exactly
// one place that validates untrusted input and handles schema drift.
//
// A design is one of two object types: a Gridfinity-style bin, or a sliding-lid
// box. The envelope carries the type plus the matching model.

export const SCHEMA_VERSION = 2

export type ObjectType = 'bin' | 'box'

// A live design in the app: the active object type plus both models (so toggling
// type preserves each one's settings).
export interface Design {
  type: ObjectType
  bin: BinModel
  box: BoxModel
}

export function defaultDesign(): Design {
  return { type: 'bin', bin: defaultBin(), box: defaultBox() }
}

export interface SavedDesign {
  v: number // schema version
  name?: string
  type: ObjectType
  bin: BinModel
  box: BoxModel
}

const LIPS: LipStyle[] = ['default', 'thin', 'none']
const SOCKETS: SocketStyle[] = ['none', 'corner', 'full']

// --- coercion helpers (never throw; fall back to defaults) ---

function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? value : fallback
  return Math.min(max, Math.max(min, n))
}
function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}
function oneOf<T extends string>(value: unknown, allowed: T[], fallback: T): T {
  return allowed.includes(value as T) ? (value as T) : fallback
}

function coerceDividers(value: unknown): Divider[] {
  if (!Array.isArray(value)) return []
  const out: Divider[] = []
  value.forEach((d, i) => {
    if (!d || typeof d !== 'object') return
    const axis = (d as Divider).axis
    if (axis !== 'x' && axis !== 'y') return
    out.push({
      id: typeof (d as Divider).id === 'string' ? (d as Divider).id : `d${i}`,
      axis,
      position: num((d as Divider).position, 0.5, 0.02, 0.98),
    })
  })
  return out
}

// Turn arbitrary parsed JSON into a guaranteed-valid BoxModel.
export function coerceBox(raw: unknown): BoxModel {
  const d = defaultBox()
  const m = (raw && typeof raw === 'object' ? raw : {}) as Partial<BoxModel>
  return {
    topType: oneOf(m.topType, ['sliding', 'hinged'], d.topType),
    innerW: num(m.innerW, d.innerW, 10, 400),
    innerD: num(m.innerD, d.innerD, 10, 400),
    innerH: num(m.innerH, d.innerH, 5, 300),
    wall: num(m.wall, d.wall, 1, 6),
    lidThickness: num(m.lidThickness, d.lidThickness, 1, 6),
    clearance: num(m.clearance, d.clearance, 0, 1),
  }
}

// Turn arbitrary parsed JSON into a guaranteed-valid BinModel. Unknown or
// out-of-range fields snap to the defaults.
export function coerceModel(raw: unknown): BinModel {
  const d = defaultBin()
  const m = (raw && typeof raw === 'object' ? raw : {}) as Partial<BinModel>
  return {
    gridfinity: bool(m.gridfinity, d.gridfinity),
    gridUnit: num(m.gridUnit, d.gridUnit, 10, 80),
    unitsX: Math.round(num(m.unitsX, d.unitsX, 1, 12)),
    unitsY: Math.round(num(m.unitsY, d.unitsY, 1, 12)),
    unitsZ: Math.round(num(m.unitsZ, d.unitsZ, 1, 20)),
    customSize: bool(m.customSize, d.customSize),
    sizeX: num(m.sizeX, d.sizeX, 10, 500),
    sizeY: num(m.sizeY, d.sizeY, 10, 500),
    sizeZ: num(m.sizeZ, d.sizeZ, 5, 300),
    outerWall: num(m.outerWall, d.outerWall, 0.4, 5),
    innerWall: num(m.innerWall, d.innerWall, 0.4, 5),
    lip: oneOf(m.lip, LIPS, d.lip),
    magnets: oneOf(m.magnets, SOCKETS, d.magnets),
    screws: oneOf(m.screws, SOCKETS, d.screws),
    dividers: coerceDividers(m.dividers),
    scoop: bool(m.scoop, d.scoop),
    label: bool(m.label, d.label),
  }
}

// Coerce any parsed JSON into a valid Design. Handles three shapes:
//   - v2 envelope { type, bin, box }
//   - v1 envelope { model: <bin> } (legacy save → bin design)
//   - bare bin model object (oldest/loosest)
export function coerceDesign(raw: unknown): Design {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  if ('type' in o && (o.type === 'bin' || o.type === 'box')) {
    return { type: o.type, bin: coerceModel(o.bin), box: coerceBox(o.box) }
  }
  if ('model' in o) {
    return { type: 'bin', bin: coerceModel(o.model), box: defaultBox() }
  }
  return { type: 'bin', bin: coerceModel(raw), box: defaultBox() }
}

// --- public API ---

export function serializeDesign(design: Design, name?: string): SavedDesign {
  return { v: SCHEMA_VERSION, name, type: design.type, bin: design.bin, box: design.box }
}

// Accepts a SavedDesign envelope OR looser/legacy inputs.
export function deserializeDesign(raw: unknown): { design: Design; name?: string } {
  const name =
    raw && typeof raw === 'object' && typeof (raw as SavedDesign).name === 'string'
      ? (raw as SavedDesign).name
      : undefined
  return { design: coerceDesign(raw), name }
}

export function toJSON(design: Design, name?: string): string {
  return JSON.stringify(serializeDesign(design, name), null, 2)
}

export function fromJSON(text: string): { design: Design; name?: string } {
  return deserializeDesign(JSON.parse(text))
}

// --- share URL: compact base64url of the design in the `d` query param ---

function base64UrlEncode(s: string): string {
  const b64 = btoa(unescape(encodeURIComponent(s)))
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
function base64UrlDecode(s: string): string {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  return decodeURIComponent(escape(atob(b64)))
}

export function encodeShareParam(design: Design, name?: string): string {
  // Minify (no pretty-print) for shorter URLs.
  return base64UrlEncode(JSON.stringify(serializeDesign(design, name)))
}

export function decodeShareParam(param: string): { design: Design; name?: string } | null {
  try {
    return deserializeDesign(JSON.parse(base64UrlDecode(param)))
  } catch {
    return null
  }
}

export function buildShareUrl(design: Design, name?: string): string {
  const url = new URL(window.location.href)
  url.searchParams.set('d', encodeShareParam(design, name))
  return url.toString()
}

// Read a design from the current URL's `d` param, if present.
export function readShareUrl(): { design: Design; name?: string } | null {
  const param = new URLSearchParams(window.location.search).get('d')
  return param ? decodeShareParam(param) : null
}
