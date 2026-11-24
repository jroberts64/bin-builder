import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { initKernel, edgeCheck, overlapVolume, M } from '../kernel.mjs'
import { DIMS } from '../dims.mjs'
import { buildLidShell, lidToAssembled, pinCentres } from '../lid.mjs'
import { buildFrame, frameToAssembled, pinsAssembled } from '../frame.mjs'

let frame, frameA, lidA, pins
before(async () => {
  await initKernel()
  frame = buildFrame()
  frameA = frameToAssembled(frame)
  lidA = lidToAssembled(buildLidShell())
  pins = pinsAssembled()
})

test('the frame is a closed, positive-volume manifold with a 5.8 peak', () => {
  assert.deepEqual(edgeCheck(frame), { open: 0, nonManifold: 0 })
  assert.ok(frame.volume() > 0)
  const bb = frame.boundingBox()
  assert.ok(Math.abs(bb.min[2]) < 1e-6 && Math.abs(bb.max[2] - DIMS.frame.peak) < 0.05, `peak ${bb.max[2]}`)
})

test('the frame has no overhangs: only its underside and the pin-hole ceilings face down', () => {
  const mesh = frame.getMesh(); const vp = mesh.vertProperties, tv = mesh.triVerts, np = mesh.numProp
  const P = (i) => [vp[i * np], vp[i * np + 1], vp[i * np + 2]]
  const nearPin = (x, y) => pinCentres().some(([px, py]) => Math.hypot(x - px, y - py) < DIMS.pin.hole / 2 + 0.01)
  let bad = 0
  for (let t = 0; t < tv.length; t += 3) {
    const a = P(tv[t]), b = P(tv[t + 1]), c = P(tv[t + 2])
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], w = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const n = [u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]]
    const nz = n[2] / (Math.hypot(...n) || 1)
    if (nz < -0.01) {
      const onBed = [a, b, c].every((p) => p[2] < 0.01)
      const pinCeiling = [a, b, c].every((p) => nearPin(p[0], p[1]))
      if (!onBed && !pinCeiling) bad++
    }
  }
  assert.equal(bad, 0, `${bad} downward-facing triangles off the bed`)
})

test('the frame sits on the lid without intersecting it, and the pins fit both hole sets', () => {
  assert.ok(overlapVolume(frameA, lidA) < 1e-3)
  assert.ok(overlapVolume(pins, frameA) < 1e-3, 'pins vs frame')
  assert.ok(overlapVolume(pins, lidA) < 1e-3, 'pins vs lid')
  assert.equal(pins.decompose().length, 4)
})

test('the pins index the frame: shifted 0.5 mm they hit the lid', () => {
  assert.ok(overlapVolume(pins.translate([0.5, 0, 0]), lidA) > 0)
})

test('the frame inner edge overlaps the window by 1 mm and fits the bed', () => {
  const bb = frame.boundingBox()
  assert.ok(bb.max[0] - bb.min[0] <= DIMS.bed && bb.max[1] - bb.min[1] <= DIMS.bed)
  // a probe just inside window − 1 is clear; one just outside it hits the frame lip
  const { Manifold } = M()
  const probe = (r) => Manifold.cylinder(1, 0.2, 0.2, 12).translate([r, 0, 0.2])
  assert.ok(overlapVolume(probe(DIMS.win.rx - DIMS.frame.inset - 0.3), frame) < 1e-9)
  assert.ok(overlapVolume(probe(DIMS.win.rx - DIMS.frame.inset + 0.3), frame) > 0)
})
