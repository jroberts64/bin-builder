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
  Base: 8 walls (the 3.2 mm walls are then solid perimeters), seam at the back,
  no supports. Frame: 4 walls. Either plate for both.
  Lid: Textured PEI plate (it gives the top its stone finish). The lid file
  already carries its settings — keep them when Bambu Studio asks. Load the
  spools so the order matches the parts: White Marble in AMS slot 1, Mistletoe
  Green in AMS slot 2, Silk+ Gold in AMS slot 3. Then press "Sync" in the
  filament panel so slots 1-3 pick up their real profiles.
  On first open, check the Process panel shows Top shell layers 12, Bottom shell
  layers 12 and Wall loops 4. If not, follow the next section.

IF THE LID OPENS WITHOUT ITS SETTINGS
  The plate around the tulle must be solid plastic, or the tulle is only held by
  sparse infill. Set these by hand:
    - Process: 0.12mm High Quality @BBL P2S, Initial layer height 0.2.
    - Strength: Top shell layers 12, Bottom shell layers 12, Wall loops 4.
    - Seam position: Back. Plate type: Textured PEI.
    - Prime tower on (it is by default with more than one filament).
  Filaments per part: in the Objects list expand gift-box-lid, right-click each
  part -> Change Filament: body + petals -> 1, vine -> 2, flower centres -> 3.
  Pause: see below.

ORDER
  1. Fit test: gift-box-fit-test.3mf, White Marble, 0.20mm Standard. A mini box
     (80 x 60 mm inside) with exactly the real box's walls, collar, gap, skirt
     and ribs: three mini bases (open frames, no floor) and one mini lid (a rim,
     no top). The bases carry 1, 2 or 3
     notches on the bottom edge = 0.05 / 0.10 / 0.15 mm of grip. Press the lid
     onto each base. The mini box's short walls are stiffer than the real
     box's, so it feels a little tighter than the real one will: pick the one
     that feels right or a touch firm, not the loosest that holds. (The fit
     comes from the sides, not the layer height, so 0.20 is fine for the test.)
  2. Base.                                 about 5 h 55 m, 147 g White Marble
  3. Lid — with the tulle pause (below).   about 3 h 50 m, 65 g Marble + 6 g Green + 8 g Gold (mostly purge)
  4. Frame.                                about 55 m, 15 g Rosewood
  (Bambu Studio estimates on 0.12mm High Quality; the fit test is about 56 m, 39 g.)

THE LID AND THE TULLE PAUSE
  The lid prints face-down: its top is the first layers on the plate.
  The pause is already in the file: Bambu Studio's layer slider shows a custom
  G-code marker on layer ${pause.nextLayer} (${pause.nextTop} mm), i.e. after layer ${pause.layer} finishes at the
  tulle plane, ${pause.top} mm. When it pauses, the head lifts 10 mm and parks at the
  back of the plate, out of your way.
  If the marker is missing, right-click the slider on layer ${pause.nextLayer} (${pause.nextTop} mm) ->
  Add custom G-code, and paste:  G91 / G1 Z10 F900 / G90 / G1 X128 Y250 F9000 / M400 U1
  (one per line). A plain Add Pause also works, but leaves the hot nozzle
  resting on the print, in the middle of the window.
${sliceNotes ? `  ${sliceNotes}\n` : ''}
  At the pause:
    - Cut the tulle with the template (an oval 8 mm bigger than the window).
    - Centre it over the open window, so about 8 mm of tulle lies on the
      printed plate all round. The half-printed vine and flowers show through.
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
