import { BinModel, Divider, LipStyle, SocketStyle, defaultBin } from './types'

// Versioned (de)serialization for a BinModel. Everything that persists or shares
// a design — localStorage, .json files, share URLs — goes through here so there
// is exactly one place that validates untrusted input and handles schema drift.

export const SCHEMA_VERSION = 1

export interface SavedDesign {
  v: number // schema version
  name?: string
  model: BinModel
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

// --- public API ---

export function serializeDesign(model: BinModel, name?: string): SavedDesign {
  return { v: SCHEMA_VERSION, name, model }
}

// Accepts a SavedDesign envelope OR a bare model object (older/looser inputs).
export function deserializeDesign(raw: unknown): { model: BinModel; name?: string } {
  if (raw && typeof raw === 'object' && 'model' in raw) {
    const env = raw as SavedDesign
    return { model: coerceModel(env.model), name: env.name }
  }
  return { model: coerceModel(raw) }
}

export function toJSON(model: BinModel, name?: string): string {
  return JSON.stringify(serializeDesign(model, name), null, 2)
}

export function fromJSON(text: string): { model: BinModel; name?: string } {
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

export function encodeShareParam(model: BinModel, name?: string): string {
  // Minify (no pretty-print) for shorter URLs.
  return base64UrlEncode(JSON.stringify(serializeDesign(model, name)))
}

export function decodeShareParam(param: string): { model: BinModel; name?: string } | null {
  try {
    return deserializeDesign(JSON.parse(base64UrlDecode(param)))
  } catch {
    return null
  }
}

export function buildShareUrl(model: BinModel, name?: string): string {
  const url = new URL(window.location.href)
  url.searchParams.set('d', encodeShareParam(model, name))
  return url.toString()
}

// Read a design from the current URL's `d` param, if present.
export function readShareUrl(): { model: BinModel; name?: string } | null {
  const param = new URLSearchParams(window.location.search).get('d')
  return param ? decodeShareParam(param) : null
}
