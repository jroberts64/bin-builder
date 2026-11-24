// The paperwork that ships with the print files: a true-size tulle cutting
// template and the README.

import { DIMS } from './dims.mjs'

const f = (x) => Number(x.toFixed(2)).toString()

/** 1:1 SVG (mm units) — solid line = cut, dashed = the window, for centring at the pause. */
export function tulleTemplateSVG() {
  const crx = DIMS.win.rx + DIMS.tulleMargin, cry = DIMS.win.ry + DIMS.tulleMargin
  const W = 2 * crx + 20, H = 2 * cry + 34
  const cx = W / 2, cy = cry + 10
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${f(W)}mm" height="${f(H)}mm" viewBox="0 0 ${f(W)} ${f(H)}">
  <ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(crx)}" ry="${f(cry)}" fill="none" stroke="#000" stroke-width="0.35"/>
  <ellipse cx="${f(cx)}" cy="${f(cy)}" rx="${f(DIMS.win.rx)}" ry="${f(DIMS.win.ry)}" fill="none" stroke="#888" stroke-width="0.25" stroke-dasharray="2 1.5"/>
  <path d="M${f(cx - 4)} ${f(cy)}H${f(cx + 4)}M${f(cx)} ${f(cy - 4)}V${f(cy + 4)}" stroke="#888" stroke-width="0.25"/>
  <path d="M10 ${f(H - 14)}h50M10 ${f(H - 16)}v4M60 ${f(H - 16)}v4" stroke="#000" stroke-width="0.35" fill="none"/>
  <text x="10" y="${f(H - 6)}" font-family="Helvetica, Arial, sans-serif" font-size="3.2">50 mm — check this measures 50 mm before cutting. Cut on the solid line; dashed = the lid window.</text>
</svg>
`
}

export function readme({ interference, pause, sliceNotes = '' }) {
  const i = interference.toFixed(2)
  return `VINE GIFT BOX — PRINT GUIDE
===========================

Inside: 165 x 125 x 45 mm. Outside about 171 x 131 x 50 mm, plus the 5.8 mm frame.
Built for: Bambu Lab P2S + AMS, 0.4 mm nozzle. Lid grip (rib interference): ${i} mm.

FILES
  gift-box-base.3mf / .stl   base                       White Marble (PLA Marble)
  gift-box-lid.3mf           lid, 3 parts in one object:
                               slot 1  body + petals    White Marble (PLA Marble)
                               slot 2  vine             Mistletoe Green (PLA Basic)
                               slot 3  flower centres   Silk+ Gold (PLA Silk+)
  gift-box-frame.3mf / .stl  oval frame                 Rosewood (PLA Wood)
  tulle-template.svg         print at 100% and cut your white tulle on the solid line

SETTINGS
  Process: 0.12mm High Quality @BBL P2S, first layer 0.2 mm. 0.4 mm nozzle only
  (Bambu does not support PLA Marble or PLA Wood on the 0.2 mm nozzle).
  Base and frame: 4 walls, seam at the back, no supports. Either plate.
  Lid: Textured PEI plate (it gives the top its stone finish). The lid file
  already carries its settings (0.12 layers, 0.2 first layer, a solid plate,
  4 walls) — keep them when Bambu Studio asks. Press "Sync" in the filament
  panel so slots 1-3 pick up your real AMS spools.

ORDER
  1. Fit test (if you haven't): gift-box-fit-test.3mf, 0.20mm Standard. The base
     corners carry 1, 2 or 3 notches on the bottom edge = 0.05 / 0.10 / 0.15 mm
     of grip. Pick the one that holds when tipped but lifts with a gentle pull.
  2. Base.
  3. Lid — with the tulle pause (below).
  4. Frame.

THE LID AND THE TULLE PAUSE
  The lid prints face-down: its top is the first layers on the plate.
  The pause is already in the file: Bambu Studio's layer slider shows it on
  layer ${pause.nextLayer} (${pause.nextTop} mm), i.e. after layer ${pause.layer} finishes at the tulle plane, ${pause.top} mm.
  If it is missing, right-click the slider on layer ${pause.nextLayer} (${pause.nextTop} mm) -> Add Pause.
${sliceNotes ? `  ${sliceNotes}\n` : ''}
  At the pause:
    - Cut the tulle with the template (an oval 8 mm bigger than the window).
    - Centre it over the open window. The half-printed vine and flowers are
      visible through it; the window edge should sit on the dashed line.
    - Hold it flat and taut with a few dabs of glue stick (the one that came with
      the P2S) on the margin, outside the window. Don't use tape: it would be
      printed over and buried, and it can catch the nozzle.
    - Keep it clear of the lid's outer wall.
    - Resume. The next layers press through the mesh and lock it in.

ASSEMBLY
  Frame: cut 4 pins about 2.2 mm long from any spare 1.75 mm filament. Push
  them into the 4 small holes in the lid top, put a drop of CA or PLA-safe glue
  on the frame's underside, and press the frame down over the pins.
  Optional: sand the frame lightly and rub in a little furniture wax.
`
}
