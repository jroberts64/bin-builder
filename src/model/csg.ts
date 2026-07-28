import * as THREE from 'three'
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js'
import Module from 'manifold-3d'
import wasmUrl from 'manifold-3d/manifold.wasm?url'
import type { ManifoldToplevel, Manifold as ManifoldT } from 'manifold-3d'

// CSG backed by Manifold (elalish/manifold). Unlike a mesh-soup boolean engine,
// Manifold operates on guaranteed-manifold triangle meshes and *outputs* meshes
// where every edge is shared by exactly two triangles. That is exactly what
// strict slicers (e.g. Bambu Studio) require — no post-repair needed.
//
// Manifold is WASM and must be initialised once before use: await initCSG().
// geometry.ts keeps thinking in plain BufferGeometries; conversion happens here.

let wasm: ManifoldToplevel | null = null

export async function initCSG(): Promise<void> {
  if (wasm) return
  const mod = await Module({ locateFile: () => wasmUrl })
  mod.setup()
  wasm = mod
}

export function csgReady(): boolean {
  return wasm !== null
}

function requireWasm(): ManifoldToplevel {
  if (!wasm) throw new Error('CSG not initialised — await initCSG() first')
  return wasm
}

// THREE.BufferGeometry -> Manifold. Manifold needs indexed, manifold input, so
// weld first; we feed only positions (numProp = 3).
function toManifold(geom: THREE.BufferGeometry): ManifoldT {
  const { Manifold, Mesh } = requireWasm()
  const welded = weld(geom)
  const pos = welded.getAttribute('position') as THREE.BufferAttribute
  const index = welded.getIndex()!
  const mesh = new Mesh({
    numProp: 3,
    vertProperties: new Float32Array(pos.array as ArrayLike<number>),
    triVerts: new Uint32Array(index.array as ArrayLike<number>),
  })
  return Manifold.ofMesh(mesh)
}

// Manifold -> THREE.BufferGeometry (indexed, positions only; caller computes
// normals). The output is, by construction, watertight and manifold.
function fromManifold(m: ManifoldT): THREE.BufferGeometry {
  const mesh = m.getMesh()
  const geom = new THREE.BufferGeometry()
  geom.setAttribute(
    'position',
    new THREE.BufferAttribute(mesh.vertProperties.slice(0, mesh.numVert * mesh.numProp), mesh.numProp),
  )
  // numProp may exceed 3 if extra props exist; positions are the first 3.
  if (mesh.numProp !== 3) {
    const verts = new Float32Array(mesh.numVert * 3)
    for (let i = 0; i < mesh.numVert; i++) {
      verts[i * 3] = mesh.vertProperties[i * mesh.numProp]
      verts[i * 3 + 1] = mesh.vertProperties[i * mesh.numProp + 1]
      verts[i * 3 + 2] = mesh.vertProperties[i * mesh.numProp + 2]
    }
    geom.setAttribute('position', new THREE.BufferAttribute(verts, 3))
  }
  geom.setIndex(new THREE.BufferAttribute(new Uint32Array(mesh.triVerts), 1))
  geom.computeVertexNormals()
  return geom
}

export function csgAdd(...geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const { Manifold } = requireWasm()
  const parts = geoms.map(toManifold)
  const result = Manifold.union(parts)
  return fromManifold(result)
}

export function csgIntersect(
  a: THREE.BufferGeometry,
  b: THREE.BufferGeometry,
): THREE.BufferGeometry {
  const { Manifold } = requireWasm()
  return fromManifold(Manifold.intersection(toManifold(a), toManifold(b)))
}

export function csgSubtract(
  base: THREE.BufferGeometry,
  ...tools: THREE.BufferGeometry[]
): THREE.BufferGeometry {
  const { Manifold } = requireWasm()
  let acc = toManifold(base)
  for (const t of tools) {
    acc = Manifold.difference(acc, toManifold(t))
  }
  return fromManifold(acc)
}

// Weld coincident vertices and produce indexed geometry. Used both to clean up
// THREE primitives before handing them to Manifold and anywhere an indexed,
// position-only mesh is wanted. Strips non-position attributes so welding isn't
// blocked by per-face normal/uv mismatches; normals are recomputed.
export function weld(geom: THREE.BufferGeometry, tolerance = 1e-4): THREE.BufferGeometry {
  const g = geom.clone()
  for (const name of Object.keys(g.attributes)) {
    if (name !== 'position') g.deleteAttribute(name)
  }
  const merged = mergeVertices(g, tolerance)
  merged.computeVertexNormals()
  return merged
}
