import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { initKernel, roundedRect, prism, edgeCheck, overlapVolume } from '../kernel.mjs'
import { DIMS } from '../dims.mjs'
import { buildBase, ribSegmentArea } from '../base.mjs'
import { buildLidShell, lidToAssembled } from '../lid.mjs'
import { buildFitTest } from '../fittest.mjs'

let base, baseAll, lid, lidA, fit
before(async () => {
  await initKernel()
  base = buildBase({ interference: DIMS.rib.defaultInterference })
  baseAll = base.body.add(base.ribs)
  lid = buildLidShell()
  lidA = lidToAssembled(lid)
  fit = buildFitTest()
})

const closed = (m) => assert.deepEqual(edgeCheck(m), { open: 0, nonManifold: 0 })

test('derived dimensions match the spec', () => {
  assert.equal(DIMS.outerW, 171.4)
  assert.equal(DIMS.outerD, 131.4)
  assert.ok(Math.abs(DIMS.seat - 47.4) < 1e-9)
  assert.ok(Math.abs(DIMS.topZ - 49.8) < 1e-9)
  assert.ok(Math.abs(DIMS.shoulder - 35.8) < 1e-9)
  assert.ok(Math.abs(DIMS.collarTop - 47.1) < 1e-9)
})

test('base, lid shell and every fit-test piece are closed manifolds', () => {
  closed(baseAll); closed(lid)
  for (const p of fit.bases) closed(p.manifold)
  closed(fit.lid)
})

test('the cavity is exactly 165 × 125 × 45', () => {
  const inside = prism([roundedRect(164.9, 124.9, 6.7)], DIMS.floor + 0.01, DIMS.seat - 0.01)
  assert.ok(overlapVolume(inside, baseAll) < 1e-6, 'probe just inside the cavity must not touch the base')
  assert.ok(overlapVolume(inside, lidA) < 1e-6, 'probe must not touch the closed lid')
  const wider = prism([roundedRect(165.3, 125.3, 6.9)], DIMS.floor + 0.01, DIMS.seat - 0.01)
  assert.ok(overlapVolume(wider, baseAll) > 0, 'a probe 0.15 larger per side must hit the walls')
  const taller = prism([roundedRect(100, 80, 5)], DIMS.floor + 0.01, DIMS.seat + 0.1)
  assert.ok(overlapVolume(taller, lidA) > 0, 'a probe past 45 mm must hit the lid underside')
})

test('outer size and height of the base', () => {
  const bb = baseAll.boundingBox()
  assert.ok(Math.abs(bb.max[0] - bb.min[0] - 171.4) < 0.01)
  assert.ok(Math.abs(bb.max[1] - bb.min[1] - 131.4) < 0.01)
  assert.ok(Math.abs(bb.min[2]) < 1e-9 && Math.abs(bb.max[2] - 47.1) < 1e-6)
})

test('the closed lid is flush with the base and clears the collar', () => {
  const bb = lidA.boundingBox()
  assert.ok(Math.abs(bb.max[0] - bb.min[0] - 171.4) < 0.01, 'lid outer = base outer')
  assert.ok(Math.abs(bb.min[2] - 35.8) < 1e-6 && Math.abs(bb.max[2] - 49.8) < 1e-6)
  assert.ok(overlapVolume(lidA, base.body) < 1e-3, 'skirt must not touch the collar except at ribs')
})

test('there are 8 ribs and they overlap the skirt by the interference', () => {
  assert.equal(base.ribs.decompose().length, 8)
  const i = DIMS.rib.defaultInterference
  const len = DIMS.rib.z1 - DIMS.rib.z0 - DIMS.rib.leadIn
  const expected = 8 * ribSegmentArea(i) * len
  const got = overlapVolume(lidA, base.ribs)
  assert.ok(got > expected * 0.95 && got < expected * 1.3, `rib overlap ${got} vs ${expected}`)
})

test('fit-test pieces: overlap rises with the labelled interference', () => {
  assert.deepEqual(fit.bases.map(b => b.interference), DIMS.rib.fitValues)
  const v = fit.bases.map(b => overlapVolume(b.assembled, fit.lidAssembled))
  assert.ok(v[0] > 0 && v[0] < v[1] && v[1] < v[2], `overlaps ${v}`)
  for (const m of [...fit.bases.map(b => b.manifold), fit.lid]) {
    const bb = m.boundingBox()
    assert.ok(bb.max[0] - bb.min[0] <= 60 && bb.max[1] - bb.min[1] <= 60, 'piece ≤ 60 × 60')
    assert.ok(Math.abs(bb.min[2]) < 1e-6, 'piece sits on z = 0')
  }
})

test('fit-test base pieces carry 1, 2 and 3 label notches', () => {
  assert.deepEqual(fit.bases.map(b => b.notches), [1, 2, 3])
})

test('the base has a bottom chamfer', () => {
  const at = (z) => { const bb = baseAll.trimByPlane([0, 0, 1], z - 0.005).trimByPlane([0, 0, -1], -(z + 0.005)).boundingBox(); return bb.max[0] - bb.min[0] }
  assert.ok(Math.abs(at(1) - at(0.01) - 2 * (DIMS.chamferBase - 0.01)) < 0.05, `${at(1)} vs ${at(0.01)}`)
})
