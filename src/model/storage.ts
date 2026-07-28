import { Design } from './serialize'
import { coerceDesign, serializeDesign, SavedDesign } from './serialize'

// localStorage persistence for named designs plus a separate autosave slot for
// the in-progress design. All reads are defensive: a corrupt or absent store
// yields an empty list / null rather than throwing.

const DESIGNS_KEY = 'binbuilder.designs.v1'
const AUTOSAVE_KEY = 'binbuilder.autosave.v1'

export interface StoredDesign extends SavedDesign {
  id: string
  name: string
  savedAt: number // epoch ms
}

function readAll(): StoredDesign[] {
  try {
    const raw = localStorage.getItem(DESIGNS_KEY)
    if (!raw) return []
    const arr = JSON.parse(raw)
    if (!Array.isArray(arr)) return []
    return arr
      .filter((d) => d && typeof d.id === 'string')
      .map((d) => {
        const design = coerceDesign(d)
        return {
          id: d.id,
          name: typeof d.name === 'string' ? d.name : 'Untitled',
          savedAt: typeof d.savedAt === 'number' ? d.savedAt : 0,
          v: d.v ?? 1,
          type: design.type,
          bin: design.bin,
          box: design.box,
          skadis: design.skadis,
          litho: design.litho,
        }
      })
  } catch {
    return []
  }
}

function writeAll(designs: StoredDesign[]): void {
  try {
    localStorage.setItem(DESIGNS_KEY, JSON.stringify(designs))
  } catch {
    // quota or disabled storage — fail silently; UI will reflect no save
  }
}

export function listDesigns(): StoredDesign[] {
  return readAll().sort((a, b) => b.savedAt - a.savedAt)
}

// Save a design by name. If a design with the same (case-insensitive) name
// exists, it is overwritten; otherwise a new entry is created. Returns the id.
export function saveDesign(name: string, design: Design, now: number): string {
  const designs = readAll()
  const trimmed = name.trim() || 'Untitled'
  const existing = designs.find((d) => d.name.toLowerCase() === trimmed.toLowerCase())
  const id = existing?.id ?? `bin-${now}-${Math.floor(now % 100000)}`
  const entry: StoredDesign = {
    ...serializeDesign(design, trimmed),
    id,
    name: trimmed,
    savedAt: now,
  }
  const next = existing
    ? designs.map((d) => (d.id === id ? entry : d))
    : [...designs, entry]
  writeAll(next)
  return id
}

export function deleteDesign(id: string): void {
  writeAll(readAll().filter((d) => d.id !== id))
}

export function loadDesign(id: string): StoredDesign | null {
  return readAll().find((d) => d.id === id) ?? null
}

// --- autosave (single slot, last-edited design) ---

export function writeAutosave(design: Design): void {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify(serializeDesign(design)))
  } catch {
    /* ignore */
  }
}

export function readAutosave(): Design | null {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY)
    if (!raw) return null
    return coerceDesign(JSON.parse(raw))
  } catch {
    return null
  }
}
