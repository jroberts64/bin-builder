import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { initKernel, edgeCheck, overlapVolume } from '../kernel.mjs'
import { DIMS } from '../dims.mjs'
import { buildLidShell } from '../lid.mjs'
import { buildWindowParts, windowSections, VEIN_WIDTH } from '../vine.mjs'

let parts, shell, secs
before(async () => {
  await initKernel()
  parts = buildWindowParts()
  shell = buildLidShell()
  secs = windowSections()
})

const names = ['vine', 'petals', 'centres']

test('each window part is a closed manifold spanning the plate thickness', () => {
  for (const n of names) {
    assert.deepEqual(edgeCheck(parts[n]), { open: 0, nonManifold: 0 }, n)
    const bb = parts[n].boundingBox()
    assert.ok(Math.abs(bb.min[2]) < 1e-9 && Math.abs(bb.max[2] - DIMS.top) < 1e-9, `${n} z range`)
  }
})

test('window parts abut and never overlap each other or the lid', () => {
  for (let i = 0; i < 3; i++) {
    for (let j = i + 1; j < 3; j++) assert.ok(overlapVolume(parts[names[i]], parts[names[j]]) < 1e-3, `${names[i]} ∩ ${names[j]}`)
    assert.ok(overlapVolume(parts[names[i]], shell) < 1e-3, `${names[i]} ∩ lid`)
  }
})

const ellipseR = (x, y) => Math.sqrt((x / DIMS.win.rx) ** 2 + (y / DIMS.win.ry) ** 2)
const maxR = (m) => {
  const mesh = m.getMesh(); const vp = mesh.vertProperties, np = mesh.numProp
  let r = 0
  for (let i = 0; i < mesh.numVert; i++) r = Math.max(r, ellipseR(vp[i * np], vp[i * np + 1]))
  return r
}

test('flowers sit wholly inside the frame opening; the vine reaches but never crosses the window edge', () => {
  // the frame's inner lip covers the outer 1 mm of the window, so flowers keep clear of window − 1.5
  assert.ok(maxR(parts.petals) < 0.97, `petals reach ${maxR(parts.petals)}`)
  assert.ok(maxR(parts.centres) < 0.97)
  assert.ok(maxR(parts.vine) < 1.0001)
  assert.ok(maxR(parts.vine) > 0.999, 'stem ends must reach the frame')
})

test('the vine is anchored: grown 0.05 it bites into the lid', () => {
  const grown = secs.vine.offset(0.05, 'Round', 2, 16).extrude(DIMS.top)
  assert.ok(overlapVolume(grown, shell) > 0)
})

test('no feature narrower than 1.0 mm', () => {
  for (const n of names) {
    const a = secs[n].area()
    const opened = secs[n].offset(-0.5, 'Round', 2, 16).offset(0.5, 'Round', 2, 16).area()
    assert.ok(opened / a >= 0.97, `${n}: ${(100 * opened / a).toFixed(1)}% survives a 1.0 mm opening`)
  }
})

test('leaf vein slots are at least 0.8 mm wide', () => {
  assert.ok(VEIN_WIDTH >= 0.8)
})

test('there are three flowers, each with its own centre', () => {
  assert.equal(parts.centres.decompose().length, 3)
})
