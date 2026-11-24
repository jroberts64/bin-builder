import { test, before } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { initKernel } from '../kernel.mjs'
import { buildLidShell } from '../lid.mjs'
import { buildWindowParts } from '../vine.mjs'
import { writeBambuLid, pauseLayer } from '../bambu3mf.mjs'
import { tulleTemplateSVG, readme } from '../docs.mjs'

let file
const unz = (name) => execFileSync('unzip', ['-p', file, name], { maxBuffer: 1 << 30 }).toString()
before(async () => {
  await initKernel()
  const w = buildWindowParts()
  const parts = [
    { name: 'lid body + petals (White Marble)', manifold: buildLidShell().add(w.petals), extruder: 1 },
    { name: 'vine (Mistletoe Green)', manifold: w.vine, extruder: 2 },
    { name: 'flower centres (Silk+ Gold)', manifold: w.centres, extruder: 3 },
  ]
  file = join(mkdtempSync(join(tmpdir(), 'gb-out-')), 'lid.3mf')
  writeFileSync(file, writeBambuLid({ parts, pause: pauseLayer(1.16) }))
})

test('pauseLayer finds the layer whose top is the tulle plane', () => {
  const p = pauseLayer(1.16)
  assert.equal(p.layer, 9)
  assert.ok(Math.abs(p.top - 1.16) < 1e-9)
  assert.ok(Math.abs(p.nextTop - 1.28) < 1e-9)
  assert.throws(() => pauseLayer(1.2), /not on a layer boundary/)
})

test('the lid 3MF is a valid zip with Bambu metadata', () => {
  execFileSync('unzip', ['-tq', file])
  const list = execFileSync('unzip', ['-l', file]).toString()
  for (const f of ['3D/3dmodel.model', 'Metadata/model_settings.config', 'Metadata/custom_gcode_per_layer.xml', 'Metadata/project_settings.config']) {
    assert.ok(list.includes(f), `missing ${f}`)
  }
  assert.match(unz('3D/3dmodel.model'), /BambuStudio/)
})

test('one object, three parts on extruders 1 / 2 / 3', () => {
  const cfg = unz('Metadata/model_settings.config')
  assert.equal((cfg.match(/<object id=/g) || []).length, 1)
  const parts = [...cfg.matchAll(/<part id="(\d+)"[\s\S]*?key="extruder" value="(\d+)"/g)].map((m) => +m[2])
  assert.deepEqual(parts, [1, 2, 3])
  const model = unz('3D/3dmodel.model')
  assert.equal((model.match(/<component /g) || []).length, 3)
})

test('the pause is stored on the layer after the tulle plane, lifting and parking the head first', () => {
  const xml = unz('Metadata/custom_gcode_per_layer.xml')
  assert.match(xml, /top_z="1\.28"/)
  const gcode = xml.match(/gcode="([^"]*)"/)[1].replace(/&#10;/g, '\n')
  const lines = gcode.split('\n')
  const lift = lines.findIndex((l) => /^G1 Z/.test(l)), park = lines.findIndex((l) => /^G1 X[\d.]+ Y[\d.]+/.test(l)), pause = lines.indexOf('M400 U1')
  assert.ok(lines.includes('G91') && lift > lines.indexOf('G91'), 'relative Z lift')
  assert.ok(lift >= 0 && park > lift && pause > park, `lift → park → pause, got ${JSON.stringify(lines)}`)
  const y = +gcode.match(/G1 X[\d.]+ Y([\d.]+)/)[1]
  assert.ok(y > 128 + 131.4 / 2 + 20 && y <= 256, `park clear of the lid's back edge: Y ${y}`)
})

test('the embedded settings are P2S 0.4, 0.12 layers on a 0.2 first layer, textured plate', () => {
  const cfg = JSON.parse(unz('Metadata/project_settings.config'))
  assert.equal(cfg.printer_model, 'Bambu Lab P2S')
  assert.deepEqual(cfg.nozzle_diameter, ['0.4'])
  assert.equal(cfg.layer_height, '0.12')
  assert.equal(cfg.initial_layer_print_height, '0.2')
  assert.equal(cfg.curr_bed_type, 'Textured PEI Plate')
})

test('the tulle template is true-size: mm units, cut line = window + 8', () => {
  const svg = tulleTemplateSVG()
  assert.match(svg, /width="[\d.]+mm"/)
  assert.match(svg, /<ellipse[^>]*rx="71\.7"[^>]*ry="52\.7"/)
  assert.match(svg, /<ellipse[^>]*rx="63\.7"[^>]*ry="44\.7"[^>]*stroke-dasharray/)
})

test('the README carries everything needed to print by hand', () => {
  const r = readme({ interference: 0.1, pause: pauseLayer(1.16) })
  for (const s of ['White Marble', 'Mistletoe Green', 'Silk+ Gold', 'Rosewood', 'layer 10', '1.28', '1.16', 'glue stick', '1.75', 'Textured PEI', 'Sync', 'notch',
    'Top shell layers', 'Bottom shell layers', 'Wall loops', 'Change Filament', 'AMS slot 1', 'lifts 10 mm', 'strips']) {
    assert.ok(r.includes(s), `README must mention "${s}"`)
  }
  assert.ok(!/sit on the dashed line/.test(r), 'the dashed line is on the paper, not the tulle')
})
