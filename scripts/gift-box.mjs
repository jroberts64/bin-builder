#!/usr/bin/env node
// Vine gift box — print-file generator.
// Spec: docs/superpowers/specs/2026-11-24-gift-box-design.md
//
//   node scripts/gift-box.mjs fit-test                 # print this first
//   node scripts/gift-box.mjs build --interference 0.10
//
// Options:
//   --out           output directory              (~/Downloads/gift-box)
//   --interference  rib grip in mm, 0–0.3 (build)  (0.10)

import { writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { initKernel, write3MF, toSTL } from './gift-box/kernel.mjs'
import { DIMS } from './gift-box/dims.mjs'
import { buildFitTest } from './gift-box/fittest.mjs'
import { buildBase } from './gift-box/base.mjs'
import { buildLidShell } from './gift-box/lid.mjs'
import { buildWindowParts } from './gift-box/vine.mjs'
import { buildFrame } from './gift-box/frame.mjs'
import { writeBambuLid, pauseLayer } from './gift-box/bambu3mf.mjs'
import { tulleTemplateSVG, readme } from './gift-box/docs.mjs'

function parseArgs(argv) {
  const [cmd, ...rest] = argv
  const o = { cmd }
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (!a.startsWith('--')) throw new Error(`unexpected argument: ${a}`)
    const [k, inline] = a.slice(2).split('=')
    o[k] = inline ?? rest[++i]
    if (o[k] === undefined) throw new Error(`--${k} needs a value`)
  }
  return o
}

/** Lay parts out left-to-right in a row centred on the bed, 10 mm apart. */
export function layoutRow(parts, gap = 10) {
  const boxes = parts.map((p) => p.manifold.boundingBox())
  const total = boxes.reduce((s, b) => s + (b.max[0] - b.min[0]), 0) + gap * (parts.length - 1)
  let x = (DIMS.bed - total) / 2
  return parts.map((p, i) => {
    const b = boxes[i]
    const y = (DIMS.bed - (b.max[1] - b.min[1])) / 2
    const placed = p.manifold.translate([x - b.min[0], y - b.min[1], -b.min[2]])
    x += b.max[0] - b.min[0] + gap
    return { ...p, manifold: placed }
  })
}

function fitTest(outDir) {
  const fit = buildFitTest()
  const parts = [
    ...fit.bases.map((b) => ({ name: `base corner ${b.notches} notch (interference ${b.interference.toFixed(2)})`, manifold: b.manifold })),
    { name: 'lid corner', manifold: fit.lid },
  ]
  const file = join(outDir, 'gift-box-fit-test.3mf')
  writeFileSync(file, write3MF(layoutRow(parts)))
  return file
}

/** --interference: a number in 0–max, defaulting (and saying so) to the spec's 0.10. */
export function parseInterference(raw) {
  const max = DIMS.rib.maxInterference
  if (raw === undefined) return { value: DIMS.rib.defaultInterference, defaulted: true }
  const v = Number(raw)
  if (!Number.isFinite(v) || v < 0 || v > max) throw new Error(`--interference must be a number from 0 to ${max} mm (got "${raw}")`)
  return { value: v, defaulted: false }
}

function build(outDir, interference) {
  const base = buildBase({ interference })
  const baseM = base.body.add(base.ribs)
  const [basePlaced] = layoutRow([{ name: 'gift box base', manifold: baseM }])
  writeFileSync(join(outDir, 'gift-box-base.3mf'), write3MF([basePlaced]))
  writeFileSync(join(outDir, 'gift-box-base.stl'), toSTL([basePlaced.manifold]))

  const w = buildWindowParts()
  const pause = pauseLayer(DIMS.tullePlane)
  writeFileSync(join(outDir, 'gift-box-lid.3mf'), writeBambuLid({
    pause,
    parts: [
      { name: 'lid body + petals (White Marble)', manifold: buildLidShell().add(w.petals), extruder: 1 },
      { name: 'vine (Mistletoe Green)', manifold: w.vine, extruder: 2 },
      { name: 'flower centres (Silk+ Gold)', manifold: w.centres, extruder: 3 },
    ],
  }))

  const [framePlaced] = layoutRow([{ name: 'gift box frame', manifold: buildFrame() }])
  writeFileSync(join(outDir, 'gift-box-frame.3mf'), write3MF([framePlaced]))
  writeFileSync(join(outDir, 'gift-box-frame.stl'), toSTL([framePlaced.manifold]))

  writeFileSync(join(outDir, 'tulle-template.svg'), tulleTemplateSVG())
  writeFileSync(join(outDir, 'README.txt'), readme({
    interference, pause,
    sliceNotes: 'Checked: Bambu Studio 2.09 slices this lid with the pause at the start of layer ' + pause.nextLayer + '.',
  }))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const outDir = args.out ?? join(homedir(), 'Downloads', 'gift-box')
  mkdirSync(outDir, { recursive: true })
  await initKernel()
  switch (args.cmd) {
    case 'fit-test':
      console.log(`wrote ${fitTest(outDir)}`)
      break
    case 'build': {
      const { value, defaulted } = parseInterference(args.interference)
      console.log(`interference ${value.toFixed(2)} mm${defaulted ? ' (default — run the fit test and pass --interference to change it)' : ''}`)
      build(outDir, value)
      console.log(`wrote base, lid, frame, tulle template and README to ${outDir}`)
      break
    }
    default:
      throw new Error('usage: gift-box.mjs fit-test | build [--interference 0.10] [--out DIR]')
  }
}

main().catch((e) => { console.error(e.message); process.exit(1) })
