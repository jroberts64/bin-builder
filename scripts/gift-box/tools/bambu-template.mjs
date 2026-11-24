#!/usr/bin/env node
// One-off: build scripts/gift-box/bambu-project-settings.json, the Bambu Studio
// project settings the lid 3MF carries so its pause lands on the tulle layer.
//
//   node scripts/gift-box/tools/bambu-template.mjs <reference-project.3mf>
//
// Base = a real P2S 0.4 project's full config (Bambu writes ~640 keys and its
// system presets only define ~440 of them, so a config assembled from presets
// alone is incomplete). Overlay = Bambu's own "0.12mm High Quality @BBL P2S"
// process, resolved through its `inherits` chain from the installed app, then
// the lid's own needs: 0.2 first layer, a solid plate (12 top + 12 bottom shell
// layers cover all 2.4 mm, so the tulle is clamped in solid plastic on both
// sides; 100% infill is rejected by Bambu with the default gyroid), 4 walls (the 1.6 skirt is all perimeter), seam at the back,
// textured plate, and the three slot colours.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const PROFILES = '/Applications/BambuStudio.app/Contents/Resources/profiles/BBL'
const PROCESS = '0.12mm High Quality @BBL P2S'
const SKIP = new Set(['name', 'type', 'from', 'setting_id', 'instantiation', 'compatible_printers', 'inherits'])

function resolve(kind, name) {
  const d = JSON.parse(readFileSync(join(PROFILES, kind, `${name}.json`), 'utf8'))
  const base = d.inherits ? resolve(kind, d.inherits) : {}
  return { ...base, ...d }
}

const ref = process.argv[2]
if (!ref) throw new Error('usage: bambu-template.mjs <reference P2S 0.4 project .3mf>')
const cfg = JSON.parse(execFileSync('unzip', ['-p', ref, 'Metadata/project_settings.config']).toString())
if (cfg.printer_model !== 'Bambu Lab P2S' || cfg.nozzle_diameter?.[0] !== '0.4') throw new Error('reference must be a P2S 0.4 nozzle project')

for (const [k, v] of Object.entries(resolve('process', PROCESS))) {
  if (SKIP.has(k) || !(k in cfg)) continue
  cfg[k] = Array.isArray(cfg[k]) && !Array.isArray(v) ? cfg[k].map(() => v) : v
}
Object.assign(cfg, {
  print_settings_id: PROCESS,
  layer_height: '0.12',
  initial_layer_print_height: '0.2',
  bottom_shell_layers: '12',
  top_shell_layers: '12',
  wall_loops: '4',
  seam_position: 'back',
  curr_bed_type: 'Textured PEI Plate',
})
cfg.different_settings_to_system = cfg.different_settings_to_system.map(() => '')
const colours = ['#F7F3F0', '#3F8E43', '#F4A925'] // White Marble, Mistletoe Green, Silk+ Gold
cfg.filament_colour = cfg.filament_colour.map((c, i) => colours[i] ?? c)

const out = new URL('../bambu-project-settings.json', import.meta.url).pathname
writeFileSync(out, JSON.stringify(cfg, null, 1))
console.log(`wrote ${out} (${Object.keys(cfg).length} keys)`)
