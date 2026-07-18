import * as THREE from 'three'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { BinModel } from './types'
import { BoxModel } from './box'
import { SkadisModel } from './skadis'
import { buildBin } from './geometry'
import { buildBox } from './box'
import { buildSkadis } from './skadis'

// Models are Y-up in the viewport (sitting on Y=0); slicers expect Z-up.
// Rotating +90° about X maps +Y -> +Z (y'=-z, z'=y), keeping parts upright.
function toZUp(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const g = geometry.clone()
  g.rotateX(Math.PI / 2)
  return g
}

function geometryToSTL(geom: THREE.BufferGeometry): Blob {
  const mesh = new THREE.Mesh(geom)
  const stl = new STLExporter().parse(mesh, { binary: true }) as unknown as DataView
  return new Blob([stl as unknown as ArrayBuffer], { type: 'model/stl' })
}

function exportGeometry(model: BinModel): THREE.BufferGeometry {
  return toZUp(buildBin(model).geometry)
}

export function exportSTL(model: BinModel): Blob {
  return geometryToSTL(exportGeometry(model))
}

// --- Skadis holder: one fused mesh (container + hooks), like the bin --------

function skadisExportGeometry(model: SkadisModel): THREE.BufferGeometry {
  return toZUp(buildSkadis(model).geometry)
}

export function exportSkadisSTL(model: SkadisModel): Blob {
  return geometryToSTL(skadisExportGeometry(model))
}

export function exportSkadis3MF(model: SkadisModel): Blob {
  return geometryToBlob3MF(skadisExportGeometry(model))
}

// --- Sliding-lid box: box body + lid as TWO separate objects, laid out side by
// side on the plate. 3MF keeps them as distinct objects; STL (which has no
// object concept) ships two files in a zip. -----------------------------------

// Return the box and lid as two Z-up geometries. For a SLIDING box the two
// parts are separated side by side on the plate (they're assembled by hand). For
// a HINGED box they're a print-in-place assembly, so they stay exactly as
// modelled (interlocked at the hinge) and are only dropped to the plate.
function boxExportParts(model: BoxModel): { box: THREE.BufferGeometry; lid: THREE.BufferGeometry } {
  const { box, lid, size } = buildBox(model)
  const boxG = box.clone()
  const lidG = lid.clone()
  if (model.topType === 'hinged') {
    // Keep relative positions (the hinge must print in place). Both already sit
    // on Y=0 as modelled; just convert to Z-up.
    return { box: toZUp(boxG), lid: toZUp(lidG) }
  }
  // Sliding: drop the lid to the plate and place it beside the box with a gap.
  lidG.computeBoundingBox()
  const lb = lidG.boundingBox!
  lidG.translate(0, -lb.min.y, 0)
  lidG.translate(size.x / 2 + (lb.max.x - lb.min.x) / 2 + 10, 0, 0)
  return { box: toZUp(boxG), lid: toZUp(lidG) }
}

export function exportBox3MF(model: BoxModel): Blob {
  const { box, lid } = boxExportParts(model)
  // Two <object>s, in their export positions (interlocked for hinged, apart for
  // sliding) — slicers load them as two objects either way.
  return geometriesToBlob3MF([box, lid])
}

// STL export for a box. STL has no notion of separate objects, so:
//   - hinged: a single print-in-place assembly → one combined .stl (Blob, .stl)
//   - sliding: two hand-assembled parts → two .stl files in a .zip
// Returns the blob and the file extension to use.
export function exportBoxSTL(model: BoxModel, baseName: string): { blob: Blob; ext: string } {
  const { box, lid } = boxExportParts(model)
  if (model.topType === 'hinged') {
    const combined = mergeGeometries([box, lid], false)!
    return { blob: geometryToSTL(combined), ext: 'stl' }
  }
  const zip = zipStoreBinary([
    { name: `${baseName}-box.stl`, data: new Uint8Array(stlBytes(box)) },
    { name: `${baseName}-lid.stl`, data: new Uint8Array(stlBytes(lid)) },
  ])
  return { blob: new Blob([zip as unknown as ArrayBuffer], { type: 'application/zip' }), ext: 'zip' }
}

function stlBytes(geom: THREE.BufferGeometry): ArrayBuffer {
  const mesh = new THREE.Mesh(geom)
  const dv = new STLExporter().parse(mesh, { binary: true }) as unknown as DataView
  return dv.buffer as ArrayBuffer
}

// --- Minimal 3MF writer ---------------------------------------------------
// 3MF is an OPC (ZIP) package containing a 3D model XML in millimetres. We emit
// the smallest valid package: [Content_Types].xml, _rels/.rels and 3dmodel.model.

export function export3MF(model: BinModel): Blob {
  return geometryToBlob3MF(exportGeometry(model))
}

function geometryToBlob3MF(geom: THREE.BufferGeometry): Blob {
  return geometriesToBlob3MF([geom])
}

// One <object> with a <mesh> for a single geometry, numbered by id.
function meshObjectXml(geom: THREE.BufferGeometry, id: number): string {
  const pos = geom.getAttribute('position') as THREE.BufferAttribute
  const verts: string[] = []
  const tris: string[] = []
  const count = pos.count
  for (let i = 0; i < count; i++) {
    verts.push(`<vertex x="${fmt(pos.getX(i))}" y="${fmt(pos.getY(i))}" z="${fmt(pos.getZ(i))}"/>`)
  }
  const index = geom.getIndex()
  if (index) {
    for (let i = 0; i < index.count; i += 3) {
      tris.push(`<triangle v1="${index.getX(i)}" v2="${index.getX(i + 1)}" v3="${index.getX(i + 2)}"/>`)
    }
  } else {
    for (let i = 0; i < count; i += 3) {
      tris.push(`<triangle v1="${i}" v2="${i + 1}" v3="${i + 2}"/>`)
    }
  }
  return (
    `<object id="${id}" type="model"><mesh>` +
    `<vertices>${verts.join('')}</vertices>` +
    `<triangles>${tris.join('')}</triangles>` +
    `</mesh></object>`
  )
}

// Emit one 3MF package containing each geometry as its OWN object, so slicers
// load them as separate objects (no "split to parts" needed). Geometries must
// already be positioned (e.g. laid out side by side) in Z-up mm.
function geometriesToBlob3MF(geoms: THREE.BufferGeometry[]): Blob {
  const objects = geoms.map((g, i) => meshObjectXml(g, i + 1)).join('')
  const items = geoms.map((_, i) => `<item objectid="${i + 1}"/>`).join('')

  const modelXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n` +
    `<resources>${objects}</resources>\n` +
    `<build>${items}</build>\n` +
    `</model>`

  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>` +
    `</Types>`

  const rels =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>` +
    `</Relationships>`

  const zip = zipStore([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: '3D/3dmodel.model', data: modelXml },
  ])
  return new Blob([zip], { type: 'model/3mf' })
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(4).replace(/\.?0+$/, '') : '0'
}

// --- Stored (uncompressed) ZIP builder with CRC32, no dependencies ---------
interface ZipEntry {
  name: string
  data: string
}
interface ZipEntryBinary {
  name: string
  data: Uint8Array
}

// String-data convenience wrapper (used by the 3MF package writer).
function zipStore(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder()
  return zipStoreBinary(entries.map((e) => ({ name: e.name, data: enc.encode(e.data) })))
}

function zipStoreBinary(entries: ZipEntryBinary[]): Uint8Array {
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const e of entries) {
    const nameBytes = enc.encode(e.name)
    const dataBytes = e.data
    const crc = crc32(dataBytes)
    const size = dataBytes.length

    const local = new Uint8Array(30 + nameBytes.length)
    const lv = new DataView(local.buffer)
    lv.setUint32(0, 0x04034b50, true) // local file header sig
    lv.setUint16(4, 20, true) // version needed
    lv.setUint16(6, 0, true) // flags
    lv.setUint16(8, 0, true) // method: store
    lv.setUint16(10, 0, true) // mod time
    lv.setUint16(12, 0, true) // mod date
    lv.setUint32(14, crc, true)
    lv.setUint32(18, size, true) // compressed size
    lv.setUint32(22, size, true) // uncompressed size
    lv.setUint16(26, nameBytes.length, true)
    lv.setUint16(28, 0, true)
    local.set(nameBytes, 30)
    chunks.push(local, dataBytes)

    const cen = new Uint8Array(46 + nameBytes.length)
    const cv = new DataView(cen.buffer)
    cv.setUint32(0, 0x02014b50, true) // central dir sig
    cv.setUint16(4, 20, true)
    cv.setUint16(6, 20, true)
    cv.setUint16(8, 0, true)
    cv.setUint16(10, 0, true)
    cv.setUint16(12, 0, true)
    cv.setUint16(14, 0, true)
    cv.setUint32(16, crc, true)
    cv.setUint32(20, size, true)
    cv.setUint32(24, size, true)
    cv.setUint16(28, nameBytes.length, true)
    cv.setUint16(30, 0, true)
    cv.setUint16(32, 0, true)
    cv.setUint16(34, 0, true)
    cv.setUint16(36, 0, true)
    cv.setUint32(38, 0, true)
    cv.setUint32(42, offset, true)
    cen.set(nameBytes, 46)
    central.push(cen)

    offset += local.length + dataBytes.length
  }

  const centralSize = central.reduce((s, c) => s + c.length, 0)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, entries.length, true)
  ev.setUint16(10, entries.length, true)
  ev.setUint32(12, centralSize, true)
  ev.setUint32(16, offset, true)
  ev.setUint16(20, 0, true)

  const total =
    chunks.reduce((s, c) => s + c.length, 0) + centralSize + end.length
  const out = new Uint8Array(total)
  let p = 0
  for (const c of chunks) {
    out.set(c, p)
    p += c.length
  }
  for (const c of central) {
    out.set(c, p)
    p += c.length
  }
  out.set(end, p)
  return out
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
