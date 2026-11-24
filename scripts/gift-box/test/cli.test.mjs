import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readdirSync, statSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const CLI = new URL('../../gift-box.mjs', import.meta.url).pathname

/** Per-object XY bounding boxes from a plain 3MF's model XML. */
export function objectBoxes(file) {
  const xml = execFileSync('unzip', ['-p', file, '3D/3dmodel.model'], { maxBuffer: 1 << 30 }).toString()
  return [...xml.matchAll(/<object [^>]*>([\s\S]*?)<\/object>/g)].map(([, body]) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, z0 = Infinity
    for (const m of body.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)) {
      const x = +m[1], y = +m[2], z = +m[3]
      x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); z0 = Math.min(z0, z)
    }
    return { x0, y0, x1, y1, z0 }
  })
}

test('fit-test writes 4 non-overlapping pieces on a 256 plate', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gb-cli-'))
  const out = execFileSync('node', [CLI, 'fit-test', '--out', dir]).toString()
  const f = join(dir, 'gift-box-fit-test.3mf')
  assert.ok(existsSync(f))
  assert.match(out, /gift-box-fit-test\.3mf/)
  execFileSync('unzip', ['-tq', f])
  const boxes = objectBoxes(f)
  assert.equal(boxes.length, 4)
  for (const b of boxes) {
    assert.ok(b.x0 >= 0 && b.y0 >= 0 && b.x1 <= 256 && b.y1 <= 256, `inside the plate: ${JSON.stringify(b)}`)
    assert.ok(Math.abs(b.z0) < 1e-6, 'on the bed')
  }
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) {
    const a = boxes[i], b = boxes[j]
    assert.ok(a.x1 < b.x0 || b.x1 < a.x0 || a.y1 < b.y0 || b.y1 < a.y0, `pieces ${i} and ${j} overlap`)
  }
})

const BUILD_FILES = ['gift-box-base.3mf', 'gift-box-base.stl', 'gift-box-lid.3mf', 'gift-box-frame.3mf', 'gift-box-frame.stl', 'tulle-template.svg', 'README.txt']

test('build writes every print file, and STLs are well-formed', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gb-build-'))
  execFileSync('node', [CLI, 'build', '--interference', '0.1', '--out', dir])
  assert.deepEqual(readdirSync(dir).sort(), [...BUILD_FILES].sort())
  for (const f of BUILD_FILES.filter((f) => f.endsWith('.stl'))) {
    const buf = readFileSync(join(dir, f))
    assert.equal(statSync(join(dir, f)).size, 84 + 50 * buf.readUInt32LE(80), f)
  }
  for (const f of BUILD_FILES.filter((f) => f.endsWith('.3mf'))) execFileSync('unzip', ['-tq', join(dir, f)])
  assert.match(readFileSync(join(dir, 'README.txt'), 'utf8'), /0\.10 mm/)
})

test('build rejects an interference outside 0–0.3', () => {
  for (const bad of ['0.5', '-1', 'abc']) {
    let err
    try { execFileSync('node', [CLI, 'build', '--interference', bad, '--out', mkdtempSync(join(tmpdir(), 'gb-bad-'))], { stdio: 'pipe' }) } catch (e) { err = e }
    assert.ok(err, `--interference ${bad} must fail`)
    assert.match(err.stderr.toString(), /0.*0\.3/)
  }
})

test('build without --interference uses 0.10 and says so', () => {
  const out = execFileSync('node', [CLI, 'build', '--out', mkdtempSync(join(tmpdir(), 'gb-def-'))]).toString()
  assert.match(out, /interference 0\.10 mm \(default/)
})
