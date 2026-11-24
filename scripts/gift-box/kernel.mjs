// CSG kernel for the gift-box generator: Manifold init, 2D outlines, prisms,
// exact edge checks and the STL / 3MF / ZIP writers. Everything is Z-up, mm.
//
// Kept dependency-free beyond manifold-3d, like the app's own export.ts
// (hand-rolled stored ZIP + CRC32, no JSZip).

import Module from 'manifold-3d'

let wasm = null

/** Load the Manifold WASM module once. Every builder assumes this has resolved. */
export async function initKernel() {
  if (!wasm) {
    wasm = await Module()
    wasm.setup()
  }
  return wasm
}

export function M() {
  if (!wasm) throw new Error('initKernel() must resolve before building geometry')
  return wasm
}

// ---------- 2D outlines (CCW, centred) ----------

/** Rounded rectangle w × d with corner radius r, as a CCW polygon. */
export function roundedRect(w, d, r, segs = 16) {
  const pts = []
  r = Math.max(0, Math.min(r, w / 2, d / 2))
  const hx = w / 2 - r, hy = d / 2 - r
  const corners = [[hx, -hy, -Math.PI / 2], [hx, hy, 0], [-hx, hy, Math.PI / 2], [-hx, -hy, Math.PI]]
  for (const [cx, cy, a0] of corners) {
    if (r === 0) { pts.push([cx, cy]); continue }
    for (let k = 0; k <= segs; k++) {
      const a = a0 + (Math.PI / 2) * (k / segs)
      pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)])
    }
  }
  return pts
}

/** Ellipse with semi-axes rx, ry as a CCW polygon. */
export function ellipse(rx, ry, segs = 256) {
  return Array.from({ length: segs }, (_, i) => {
    const a = (2 * Math.PI * i) / segs
    return [rx * Math.cos(a), ry * Math.sin(a)]
  })
}

/** Polygons (outer CCW + holes, even-odd) → CrossSection. */
export function section(polygons) {
  return M().CrossSection.ofPolygons(polygons, 'EvenOdd')
}

/** Extrude polygons from z0 to z1. */
export function prism(polygons, z0, z1) {
  const cs = Array.isArray(polygons) ? section(polygons) : polygons
  return cs.extrude(z1 - z0).translate([0, 0, z0])
}

/**
 * A convex outline extruded z0→z1 with 45° chamfers of size cb (bottom) and
 * ct (top). Built as the hull of the inset and full outlines at their
 * heights, so the outline must be convex (every outline here is).
 */
export function chamferedPrism(poly, z0, z1, cb, ct) {
  const inset = (c) => section([poly]).offset(-c, 'Round', 2, 32).toPolygons()[0]
  const pts = []
  const ring = (p, z) => { for (const [x, y] of p) pts.push([x, y, z]) }
  if (cb > 0) { ring(inset(cb), z0); ring(poly, z0 + cb) } else ring(poly, z0)
  if (ct > 0) { ring(poly, z1 - ct); ring(inset(ct), z1) } else ring(poly, z1)
  return M().Manifold.hull(pts)
}

// ---------- checks ----------

/** Exact, index-based manifold check: every undirected edge used by exactly two triangles. */
export function edgeCheck(m) {
  const mesh = m.getMesh()
  const tri = mesh.triVerts
  const canon = new Uint32Array(mesh.numVert)
  for (let i = 0; i < canon.length; i++) canon[i] = i
  if (mesh.mergeFromVert) for (let i = 0; i < mesh.mergeFromVert.length; i++) canon[mesh.mergeFromVert[i]] = mesh.mergeToVert[i]
  const count = new Map()
  for (let t = 0; t < tri.length; t += 3) {
    for (let e = 0; e < 3; e++) {
      const a = canon[tri[t + e]], b = canon[tri[t + (e + 1) % 3]]
      const key = a < b ? a * 4294967296 + b : b * 4294967296 + a
      count.set(key, (count.get(key) || 0) + 1)
    }
  }
  let open = 0, nonManifold = 0
  for (const c of count.values()) { if (c === 1) open++; else if (c > 2) nonManifold++ }
  return { open, nonManifold }
}

export const volume = (m) => m.volume()
export const overlapVolume = (a, b) => a.intersect(b).volume()

// ---------- writers ----------

function triangles(m) {
  const mesh = m.getMesh()
  const np = mesh.numProp, vp = mesh.vertProperties, tv = mesh.triVerts
  const v = (i) => [vp[i * np], vp[i * np + 1], vp[i * np + 2]]
  const out = []
  for (let t = 0; t < tv.length; t += 3) out.push([v(tv[t]), v(tv[t + 1]), v(tv[t + 2])])
  return out
}

/** Binary STL of all manifolds combined into one mesh soup. */
export function toSTL(manifolds) {
  const tris = manifolds.flatMap(triangles)
  const buf = new ArrayBuffer(84 + 50 * tris.length)
  const dv = new DataView(buf)
  dv.setUint32(80, tris.length, true)
  let o = 84
  for (const [a, b, c] of tris) {
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
    const l = Math.hypot(...n) || 1
    for (const x of [n[0] / l, n[1] / l, n[2] / l, ...a, ...b, ...c]) { dv.setFloat32(o, x, true); o += 4 }
    o += 2
  }
  return new Uint8Array(buf)
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

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** Stored (uncompressed) ZIP of the given entries. */
export function zipStore(entries) {
  const enc = new TextEncoder()
  const files = entries.map((e) => ({ name: enc.encode(e.name), data: typeof e.data === 'string' ? enc.encode(e.data) : e.data }))
  const chunks = [], central = []
  let offset = 0
  for (const f of files) {
    const crc = crc32(f.data)
    const lh = new DataView(new ArrayBuffer(30))
    lh.setUint32(0, 0x04034b50, true); lh.setUint16(4, 20, true); lh.setUint32(14, crc, true)
    lh.setUint32(18, f.data.length, true); lh.setUint32(22, f.data.length, true); lh.setUint16(26, f.name.length, true)
    chunks.push(new Uint8Array(lh.buffer), f.name, f.data)
    const ch = new DataView(new ArrayBuffer(46))
    ch.setUint32(0, 0x02014b50, true); ch.setUint16(4, 20, true); ch.setUint16(6, 20, true); ch.setUint32(16, crc, true)
    ch.setUint32(20, f.data.length, true); ch.setUint32(24, f.data.length, true); ch.setUint16(28, f.name.length, true)
    ch.setUint32(42, offset, true)
    central.push(new Uint8Array(ch.buffer), f.name)
    offset += 30 + f.name.length + f.data.length
  }
  const cdSize = central.reduce((s, c) => s + c.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true)
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true)
  const all = [...chunks, ...central, new Uint8Array(end.buffer)]
  const out = new Uint8Array(all.reduce((s, c) => s + c.length, 0))
  let p = 0
  for (const c of all) { out.set(c, p); p += c.length }
  return out
}

const num = (x) => (Math.abs(x) < 5e-7 ? '0' : x.toFixed(6).replace(/\.?0+$/, ''))

/** The <mesh> element for one manifold. */
export function meshXml(m) {
  const mesh = m.getMesh()
  const np = mesh.numProp, vp = mesh.vertProperties, tv = mesh.triVerts
  const verts = []
  for (let i = 0; i < mesh.numVert; i++) verts.push(`<vertex x="${num(vp[i * np])}" y="${num(vp[i * np + 1])}" z="${num(vp[i * np + 2])}"/>`)
  const tris = []
  for (let t = 0; t < tv.length; t += 3) tris.push(`<triangle v1="${tv[t]}" v2="${tv[t + 1]}" v3="${tv[t + 2]}"/>`)
  return `<mesh><vertices>${verts.join('')}</vertices><triangles>${tris.join('')}</triangles></mesh>`
}

export const CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/><Default Extension="config" ContentType="text/xml"/><Default Extension="xml" ContentType="text/xml"/></Types>'
export const RELS = '<?xml version="1.0" encoding="UTF-8"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>'
export const escapeXml = (s) => String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c])

/** Plain 3MF: one <object> + build item per entry, in place, millimetres. */
export function write3MF(objects) {
  const objs = objects.map((o, i) => `<object id="${i + 1}" name="${escapeXml(o.name)}" type="model">${meshXml(o.manifold)}</object>`)
  const items = objects.map((_, i) => `<item objectid="${i + 1}"/>`)
  const model = `<?xml version="1.0" encoding="UTF-8"?>\n<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources>${objs.join('')}</resources><build>${items.join('')}</build></model>`
  return zipStore([
    { name: '[Content_Types].xml', data: CONTENT_TYPES },
    { name: '_rels/.rels', data: RELS },
    { name: '3D/3dmodel.model', data: model },
  ])
}
