import * as THREE from 'three'
import { STLExporter } from 'three/examples/jsm/exporters/STLExporter.js'
import { mergeGeometries, mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import { BinModel } from './types'
import { BoxModel } from './box'
import { SkadisModel } from './skadis'
import { LithoModel, buildLitho } from './litho'
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

// A binary STL is EXACTLY `84 + tris*50` bytes and carries nothing else. We used
// to append the design JSON as a trailing footer on the theory that readers
// consume `count` triangles and ignore the rest — they don't. admesh-derived
// readers (Bambu Studio, OrcaSlicer, PrusaSlicer) cross-check the file size
// against the header count, and on mismatch fall back to parsing the file as
// ASCII STL, find no `facet normal`, and reject it as "does not contain any
// geometry data". Design metadata therefore lives ONLY in the 3MF (a namespaced
// <metadata> element — standards-clean and re-importable); never re-add trailing
// bytes to an STL.
function geometryToSTL(geom: THREE.BufferGeometry): Blob {
  return new Blob([stlBytes(geom)], { type: 'model/stl' })
}

function exportGeometry(model: BinModel): THREE.BufferGeometry {
  return toZUp(buildBin(model).geometry)
}

export function exportSTL(model: BinModel): Blob {
  return geometryToSTL(exportGeometry(model))
}

export function exportSTEP(model: BinModel): Blob {
  return geometriesToBlobSTEP([exportGeometry(model)], 'bin')
}

// --- Skadis holder: one fused mesh (container + hooks), like the bin --------

function skadisExportGeometry(model: SkadisModel): THREE.BufferGeometry {
  return toZUp(buildSkadis(model).geometry)
}

export function exportSkadisSTL(model: SkadisModel): Blob {
  return geometryToSTL(skadisExportGeometry(model))
}

export function exportSkadis3MF(model: SkadisModel, meta?: string): Blob {
  return geometryToBlob3MF(skadisExportGeometry(model), meta)
}

export function exportSkadisSTEP(model: SkadisModel): Blob {
  return geometriesToBlobSTEP([skadisExportGeometry(model)], 'skadis')
}

// --- Lithophane: one fused mesh, like the bin. No STEP export — a faceted
// B-rep of a 200k-triangle relief would be enormous and useless in CAD. -------

function lithoExportGeometry(model: LithoModel): THREE.BufferGeometry {
  return toZUp(buildLitho(model).geometry)
}

export function exportLithoSTL(model: LithoModel): Blob {
  return geometryToSTL(lithoExportGeometry(model))
}

export function exportLitho3MF(model: LithoModel, meta?: string): Blob {
  return geometryToBlob3MF(lithoExportGeometry(model), meta)
}

// --- Sliding-lid box: box body + lid as TWO separate objects, laid out side by
// side on the plate. 3MF keeps them as distinct objects; STL (which has no
// object concept) ships two files in a zip. -----------------------------------

// Return the box and lid as two Z-up geometries. A flat-hinged box is a
// print-in-place assembly, so both parts stay exactly as modelled (interlocked
// at the hinge). Everything else (sliding, snap-on top hinge) is two separate
// hand-assembled parts: the lid is placed beside the box on the plate — and
// for the top hinge it's first flipped over, since it's modelled closed
// (lip down) but prints top-side down (lip up).
function boxExportParts(model: BoxModel): { box: THREE.BufferGeometry; lid: THREE.BufferGeometry } {
  const { box, lid, size } = buildBox(model)
  const boxG = box.clone()
  const lidG = lid.clone()
  if (model.topType === 'hinged' && model.hingeStyle === 'flat') {
    // Keep relative positions (the hinge must print in place). Both already sit
    // on Y=0 as modelled; just convert to Z-up.
    return { box: toZUp(boxG), lid: toZUp(lidG) }
  }
  if (model.topType === 'hinged') lidG.rotateX(Math.PI) // top hinge: print orientation
  // Drop the lid to the plate and place it beside the box with a gap.
  lidG.computeBoundingBox()
  const lb = lidG.boundingBox!
  lidG.translate(0, -lb.min.y, 0)
  lidG.translate(size.x / 2 + (lb.max.x - lb.min.x) / 2 + 10, 0, 0)
  return { box: toZUp(boxG), lid: toZUp(lidG) }
}

export function exportBox3MF(model: BoxModel, meta?: string): Blob {
  const { box, lid } = boxExportParts(model)
  // Two <object>s, in their export positions (interlocked for hinged, apart for
  // sliding) — slicers load them as two objects either way.
  return geometriesToBlob3MF([box, lid], meta)
}

// STL export for a box. STL has no notion of separate objects, so:
//   - flat-hinged: a single print-in-place assembly → one combined .stl
//   - sliding / top-hinged: two hand-assembled parts → two .stl files in a .zip
// Returns the blob and the file extension to use.
export function exportBoxSTL(model: BoxModel, baseName: string): { blob: Blob; ext: string } {
  const { box, lid } = boxExportParts(model)
  if (model.topType === 'hinged' && model.hingeStyle === 'flat') {
    const combined = mergeGeometries([box, lid], false)!
    return { blob: geometryToSTL(combined), ext: 'stl' }
  }
  // Two separate .stls in a .zip.
  const bytes = (g: THREE.BufferGeometry) => new Uint8Array(stlBytes(g))
  const zip = zipStoreBinary([
    { name: `${baseName}-box.stl`, data: bytes(box) },
    { name: `${baseName}-lid.stl`, data: bytes(lid) },
  ])
  return { blob: new Blob([zip as unknown as ArrayBuffer], { type: 'application/zip' }), ext: 'zip' }
}

// STEP holds multiple solid bodies in one file, so — unlike STL — both box
// cases are a single .step: box + lid as two solids, in their export positions
// (apart for sliding, interlocked for hinged).
export function exportBoxSTEP(model: BoxModel): Blob {
  const { box, lid } = boxExportParts(model)
  return geometriesToBlobSTEP([box, lid], 'box')
}

function stlBytes(geom: THREE.BufferGeometry): ArrayBuffer {
  const mesh = new THREE.Mesh(geom)
  const dv = new STLExporter().parse(mesh, { binary: true }) as unknown as DataView
  return dv.buffer as ArrayBuffer
}

// --- Minimal 3MF writer ---------------------------------------------------
// 3MF is an OPC (ZIP) package containing a 3D model XML in millimetres. We emit
// the smallest valid package: [Content_Types].xml, _rels/.rels and 3dmodel.model.

export function export3MF(model: BinModel, meta?: string): Blob {
  return geometryToBlob3MF(exportGeometry(model), meta)
}

function geometryToBlob3MF(geom: THREE.BufferGeometry, meta?: string): Blob {
  return geometriesToBlob3MF([geom], meta)
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
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
function geometriesToBlob3MF(geoms: THREE.BufferGeometry[], meta?: string): Blob {
  const objects = geoms.map((g, i) => meshObjectXml(g, i + 1)).join('')
  const items = geoms.map((_, i) => `<item objectid="${i + 1}"/>`).join('')

  // Custom design metadata via a namespaced <metadata> element (3MF core: a
  // colon in `name` must reference a declared namespace; metadata precedes
  // <resources>). Standards-clean, unlike the STL footer.
  const metaXml = meta
    ? `<metadata name="bb:design">${escapeXml(meta)}</metadata>\n`
    : ''

  const modelXml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02" xmlns:bb="https://bin-builder.local/3mf/design">\n` +
    metaXml +
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

// --- Minimal STEP (AP214) writer ------------------------------------------
// STL/3MF are meshes; a STEP file is a boundary representation (B-rep) with real
// topology (solids, faces, edges, vertices) that CAD tools can select and edit.
// We can't recover the original analytic surfaces from a triangle mesh, so this
// emits a FACETED B-rep: every triangle becomes a planar ADVANCED_FACE, but with
// shared vertices and shared edges so the result is a genuine MANIFOLD_SOLID_BREP
// (one closed shell), not a loose triangle soup. It imports as a real solid body
// — you just can't grab, say, a fillet and change its radius (it's facets).
//
// Hand-rolled to stay dependency-free, like the 3MF/ZIP writers. Entity ids are
// assigned sequentially; STEP allows forward references, so emission order is
// free (we build the solids first, then the shared context + product wrapper).

// Format a real for STEP: always a decimal point, trailing zeros trimmed.
function sNum(n: number): string {
  if (!Number.isFinite(n)) n = 0
  let s = n.toFixed(6).replace(/0+$/, '')
  if (s.endsWith('.')) s += '0'
  return s
}

// Emit one geometry as a MANIFOLD_SOLID_BREP; returns its entity id. Each passed
// geometry is assumed to be a single connected, closed, manifold mesh (true for
// every per-part output of our builders). `E(body)` appends `#id=body;` and hands
// back the id.
function emitSolidSTEP(geometry: THREE.BufferGeometry, E: (body: string) => number): number {
  // Weld on POSITION ONLY (stripping normals etc.) so coincident vertices merge
  // into shared topology — split normals would otherwise keep edges unshared and
  // the shell wouldn't close.
  const g0 = new THREE.BufferGeometry()
  g0.setAttribute('position', geometry.getAttribute('position'))
  if (geometry.index) g0.setIndex(geometry.index)
  const geom = mergeVertices(g0)

  const pos = geom.getAttribute('position') as THREE.BufferAttribute
  const idx = geom.getIndex()!
  const nv = pos.count

  // One CARTESIAN_POINT + VERTEX_POINT per unique vertex, reused everywhere.
  const cp: number[] = new Array(nv)
  for (let i = 0; i < nv; i++) {
    cp[i] = E(`CARTESIAN_POINT('',(${sNum(pos.getX(i))},${sNum(pos.getY(i))},${sNum(pos.getZ(i))}))`)
  }
  const vp: number[] = new Array(nv)
  for (let i = 0; i < nv; i++) vp[i] = E(`VERTEX_POINT('',#${cp[i]})`)

  // One EDGE_CURVE per undirected edge (keyed low*nv+high), oriented low→high.
  const edgeMap = new Map<number, number>()
  const getEdge = (lo: number, hi: number): number => {
    const key = lo * nv + hi
    const found = edgeMap.get(key)
    if (found !== undefined) return found
    let dx = pos.getX(hi) - pos.getX(lo)
    let dy = pos.getY(hi) - pos.getY(lo)
    let dz = pos.getZ(hi) - pos.getZ(lo)
    const len = Math.hypot(dx, dy, dz) || 1
    dx /= len; dy /= len; dz /= len
    const dir = E(`DIRECTION('',(${sNum(dx)},${sNum(dy)},${sNum(dz)}))`)
    const vec = E(`VECTOR('',#${dir},${sNum(len)})`)
    const line = E(`LINE('',#${cp[lo]},#${vec})`)
    const ec = E(`EDGE_CURVE('',#${vp[lo]},#${vp[hi]},#${line},.T.)`)
    edgeMap.set(key, ec)
    return ec
  }
  // ORIENTED_EDGE from u→v, flagging whether it runs with (.T.) or against
  // (.F.) the shared curve's canonical low→high direction.
  const orientedEdge = (u: number, v: number): number => {
    const ec = getEdge(Math.min(u, v), Math.max(u, v))
    return E(`ORIENTED_EDGE('',*,*,#${ec},${u < v ? '.T.' : '.F.'})`)
  }

  const faceIds: number[] = []
  for (let t = 0; t < idx.count; t += 3) {
    const a = idx.getX(t), b = idx.getX(t + 1), c = idx.getX(t + 2)
    // Outward normal from the CCW winding (right-hand rule).
    const ux = pos.getX(b) - pos.getX(a), uy = pos.getY(b) - pos.getY(a), uz = pos.getZ(b) - pos.getZ(a)
    const vx = pos.getX(c) - pos.getX(a), vy = pos.getY(c) - pos.getY(a), vz = pos.getZ(c) - pos.getZ(a)
    let nx = uy * vz - uz * vy
    let ny = uz * vx - ux * vz
    let nz = ux * vy - uy * vx
    const nl = Math.hypot(nx, ny, nz)
    if (nl < 1e-12) continue // skip degenerate (zero-area) triangles
    nx /= nl; ny /= nl; nz /= nl
    // A reference direction in the plane: project a helper axis off the normal.
    let hx = 0, hy = 0, hz = 0
    if (Math.abs(nx) < 0.9) hx = 1; else hy = 1
    const d = hx * nx + hy * ny + hz * nz
    let rx = hx - d * nx, ry = hy - d * ny, rz = hz - d * nz
    const rl = Math.hypot(rx, ry, rz) || 1
    rx /= rl; ry /= rl; rz /= rl

    const loop = E(
      `EDGE_LOOP('',(#${orientedEdge(a, b)},#${orientedEdge(b, c)},#${orientedEdge(c, a)}))`,
    )
    const fob = E(`FACE_OUTER_BOUND('',#${loop},.T.)`)
    const nDir = E(`DIRECTION('',(${sNum(nx)},${sNum(ny)},${sNum(nz)}))`)
    const rDir = E(`DIRECTION('',(${sNum(rx)},${sNum(ry)},${sNum(rz)}))`)
    const plc = E(`AXIS2_PLACEMENT_3D('',#${cp[a]},#${nDir},#${rDir})`)
    const plane = E(`PLANE('',#${plc})`)
    faceIds.push(E(`ADVANCED_FACE('',(#${fob}),#${plane},.T.)`))
  }

  const shell = E(`CLOSED_SHELL('',(${faceIds.map((f) => `#${f}`).join(',')}))`)
  return E(`MANIFOLD_SOLID_BREP('',#${shell})`)
}

// Emit one STEP file containing each geometry as its own solid body (like the
// multi-object 3MF writer). Geometries must already be positioned in Z-up mm.
function geometriesToBlobSTEP(geoms: THREE.BufferGeometry[], productName: string): Blob {
  const lines: string[] = []
  let id = 0
  const E = (body: string): number => {
    const n = ++id
    lines.push(`#${n}=${body};`)
    return n
  }

  const solidIds = geoms.map((g) => emitSolidSTEP(g, E))

  // Units: length in millimetres, plane angle in radians, plus a solid angle.
  const lengthUnit = E(`( LENGTH_UNIT() NAMED_UNIT(*) SI_UNIT(.MILLI.,.METRE.) )`)
  const angleUnit = E(`( NAMED_UNIT(*) PLANE_ANGLE_UNIT() SI_UNIT($,.RADIAN.) )`)
  const solidAngleUnit = E(`( NAMED_UNIT(*) SI_UNIT($,.STERADIAN.) SOLID_ANGLE_UNIT() )`)
  const uncertainty = E(
    `UNCERTAINTY_MEASURE_WITH_UNIT(LENGTH_MEASURE(1.E-06),#${lengthUnit},'distance_accuracy_value','confusion accuracy')`,
  )
  const context = E(
    `( GEOMETRIC_REPRESENTATION_CONTEXT(3) GLOBAL_UNCERTAINTY_ASSIGNED_CONTEXT((#${uncertainty})) ` +
      `GLOBAL_UNIT_ASSIGNED_CONTEXT((#${lengthUnit},#${angleUnit},#${solidAngleUnit})) ` +
      `REPRESENTATION_CONTEXT('Context','3D') )`,
  )

  const originPt = E(`CARTESIAN_POINT('',(0.0,0.0,0.0))`)
  const zDir = E(`DIRECTION('',(0.0,0.0,1.0))`)
  const xDir = E(`DIRECTION('',(1.0,0.0,0.0))`)
  const axis = E(`AXIS2_PLACEMENT_3D('',#${originPt},#${zDir},#${xDir})`)

  const repItems = [axis, ...solidIds].map((i) => `#${i}`).join(',')
  const shapeRep = E(`ADVANCED_BREP_SHAPE_REPRESENTATION('',(${repItems}),#${context})`)

  // Minimal product structure tying the shape representation to a named product.
  const appContext = E(`APPLICATION_CONTEXT('core data for automotive mechanical design processes')`)
  E(`APPLICATION_PROTOCOL_DEFINITION('international standard','automotive_design',2000,#${appContext})`)
  const prodContext = E(`PRODUCT_CONTEXT('',#${appContext},'mechanical')`)
  const product = E(`PRODUCT('${productName}','${productName}','',(#${prodContext}))`)
  const formation = E(`PRODUCT_DEFINITION_FORMATION('','',#${product})`)
  const defContext = E(`PRODUCT_DEFINITION_CONTEXT('part definition',#${appContext},'design')`)
  const prodDef = E(`PRODUCT_DEFINITION('design','',#${formation},#${defContext})`)
  const defShape = E(`PRODUCT_DEFINITION_SHAPE('','',#${prodDef})`)
  E(`SHAPE_DEFINITION_REPRESENTATION(#${defShape},#${shapeRep})`)
  E(`PRODUCT_RELATED_PRODUCT_CATEGORY('part','',(#${product}))`)

  const header =
    `ISO-10303-21;\n` +
    `HEADER;\n` +
    `FILE_DESCRIPTION(('faceted b-rep exported by Bin Builder'),'2;1');\n` +
    `FILE_NAME('${productName}.step','${new Date().toISOString()}',(''),(''),'Bin Builder','Bin Builder','');\n` +
    `FILE_SCHEMA(('AUTOMOTIVE_DESIGN { 1 0 10303 214 1 1 1 1 }'));\n` +
    `ENDSEC;\n`
  const text = header + `DATA;\n` + lines.join('\n') + `\nENDSEC;\nEND-ISO-10303-21;\n`
  return new Blob([text], { type: 'application/step' })
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
