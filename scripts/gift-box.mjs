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
import { initKernel, write3MF } from './gift-box/kernel.mjs'
import { DIMS } from './gift-box/dims.mjs'
import { buildFitTest } from './gift-box/fittest.mjs'

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

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const outDir = args.out ?? join(homedir(), 'Downloads', 'gift-box')
  mkdirSync(outDir, { recursive: true })
  await initKernel()
  switch (args.cmd) {
    case 'fit-test':
      console.log(`wrote ${fitTest(outDir)}`)
      break
    default:
      throw new Error('usage: gift-box.mjs fit-test | build [--interference 0.10] [--out DIR]')
  }
}

main().catch((e) => { console.error(e.message); process.exit(1) })
