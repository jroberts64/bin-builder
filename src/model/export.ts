import * as THREE from 'three'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { BinModel } from './types'
import { BoxModel } from './box'
import { buildBin } from './geometry'
import { buildBox } from './box'

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

// --- Sliding-lid box: box body + lid, both laid out flat and combined into one
// STL/3MF positioned side by side so they print together. ---------------------

function boxExportGeometry(model: BoxModel): THREE.BufferGeometry {
  const { box, lid, size } = buildBox(model)
  // Box prints as-is (open mouth up is fine). Lid: drop it to the plate next to
  // the box so both sit flat and don't overlap.
  const boxG = box.clone()
  const lidG = lid.clone()
  lidG.computeBoundingBox()
  const lb = lidG.boundingBox!
  // Move lid down to y=0 and beside the box along +X with a 10mm gap.
  lidG.translate(0, -lb.min.y, 0)
  lidG.translate(size.x / 2 + (lb.max.x - lb.min.x) / 2 + 10, 0, 0)
  const combined = mergeGeometries([boxG, lidG], false)!
  return toZUp(combined)
}

export function exportBoxSTL(model: BoxModel): Blob {
  return geometryToSTL(boxExportGeometry(model))
}

export function exportBox3MF(model: BoxModel): Blob {
  return geometryToBlob3MF(boxExportGeometry(model))
}

// --- Minimal 3MF writer ---------------------------------------------------
// 3MF is an OPC (ZIP) package containing a 3D model XML in millimetres. We emit
// the smallest valid package: [Content_Types].xml, _rels/.rels and 3dmodel.model.

export function export3MF(model: BinModel): Blob {
  return geometryToBlob3MF(exportGeometry(model))
}

function geometryToBlob3MF(geom: THREE.BufferGeometry): Blob {
  const pos = geom.getAttribute('position') as THREE.BufferAttribute

  const verts: string[] = []
  const tris: string[] = []
  const count = pos.count
  for (let i = 0; i < count; i++) {
    verts.push(
      `<vertex x="${fmt(pos.getX(i))}" y="${fmt(pos.getY(i))}" z="${fmt(pos.getZ(i))}"/>`,
    )
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

  const modelXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n` +
    `<resources><object id="1" type="model"><mesh>\n` +
    `<vertices>${verts.join('')}</vertices>\n` +
    `<triangles>${tris.join('')}</triangles>\n` +
    `</mesh></object></resources>\n` +
    `<build><item objectid="1"/></build>\n` +
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

function zipStore(entries: ZipEntry[]): Uint8Array {
  const enc = new TextEncoder()
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0

  for (const e of entries) {
    const nameBytes = enc.encode(e.name)
    const dataBytes = enc.encode(e.data)
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
