import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import {
  initKernel, roundedRect, ellipse, prism, chamferedPrism, edgeCheck, volume,
  overlapVolume, toSTL, zipStore, write3MF,
} from '../kernel.mjs'

let cube
before(async () => {
  await initKernel()
  cube = prism([roundedRect(10, 10, 0)], 0, 10)
})

test('a prism cube is closed and manifold', () => {
  assert.deepEqual(edgeCheck(cube), { open: 0, nonManifold: 0 })
})

test('prism volume is area × height', () => {
  assert.ok(Math.abs(volume(prism([roundedRect(20, 10, 0)], 0, 5)) - 1000) < 0.01)
})

test('rounded rect and ellipse are CCW polygons of the right extent', () => {
  const r = roundedRect(30, 20, 5)
  const xs = r.map(p => p[0]), ys = r.map(p => p[1])
  assert.ok(Math.abs(Math.max(...xs) - 15) < 1e-9 && Math.abs(Math.min(...ys) + 10) < 1e-9)
  const e = ellipse(8, 4)
  let a = 0
  for (let i = 0; i < e.length; i++) { const p = e[i], q = e[(i + 1) % e.length]; a += p[0] * q[1] - q[0] * p[1] }
  assert.ok(a > 0, 'ellipse must be CCW')
})

test('STL size is 84 + 50 × triangles', () => {
  const bytes = toSTL([cube])
  assert.equal(bytes.length, 84 + 50 * cube.numTri())
})

test('overlapVolume of two cubes offset by half is half a cube', () => {
  assert.ok(Math.abs(overlapVolume(cube, cube.translate([5, 0, 0])) - 500) < 1e-6)
})

test('chamferedPrism shrinks the bottom face by 2 × chamfer', () => {
  const m = chamferedPrism(roundedRect(20, 10, 2), 0, 5, 1, 0)
  const bottom = m.trimByPlane([0, 0, -1], -0.01) // keep z ≤ 0.01
  const bb = bottom.boundingBox()
  assert.ok(Math.abs((bb.max[0] - bb.min[0]) - 18) < 0.05, `bottom width ${bb.max[0] - bb.min[0]}`)
  assert.ok(Math.abs((bb.max[1] - bb.min[1]) - 8) < 0.05)
  assert.deepEqual(edgeCheck(m), { open: 0, nonManifold: 0 })
})

test('write3MF produces a valid zip with one object per input, in mm', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gb-'))
  const f = join(dir, 't.3mf')
  writeFileSync(f, write3MF([{ name: 'a', manifold: cube }, { name: 'b', manifold: cube.translate([20, 0, 0]) }]))
  execFileSync('unzip', ['-tq', f])
  const xml = execFileSync('unzip', ['-p', f, '3D/3dmodel.model']).toString()
  assert.match(xml, /unit="millimeter"/)
  assert.equal(xml.split('<object ').length - 1, 2)
})

test('zipStore round-trips text through unzip', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gb-'))
  const f = join(dir, 't.zip')
  writeFileSync(f, zipStore([{ name: 'hello.txt', data: 'hi there' }]))
  assert.equal(execFileSync('unzip', ['-p', f, 'hello.txt']).toString(), 'hi there')
})
