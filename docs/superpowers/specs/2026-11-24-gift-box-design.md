# Vine gift box: marble and wood, with embedded tulle

**Date:** 2026-11-24
**Status:** draft, awaiting approval (builder check done; findings folded in)
**Visual reference:** https://claude.ai/artifact/KSjFyWFkWa4M8aEHzvxMun (the top render, "Vine in marble & wood")

## Intent

A one-time-use gift box that feels premium. The inside is exactly **165 × 125 × 45 mm**. The design is a white marble box with a flush-fitting lift-off lid. The lid has an oval window with white tulle embedded in it, a vine with leaves, tendrils and small flowers floating on the tulle, and a separately printed, moulded wood frame glued around the window.

The user asked for a custom design, explicitly **not** built with this repo's bin-builder app. It is a one-off object for a gift, so it is a standalone generator script, not a new object type in the app.

## Goals

- Inside cavity of exactly 165 (W) × 125 (D) × 45 (H) mm, measured from the floor top to the lid underside.
- Reads as premium: a flush lid with a single fine seam, generous rounded corners, no visible elephant's foot, a moulded frame, and a stone-finish top.
- White tulle embedded in the lid top during the print, with one pause.
- A vine and flowers that float on the tulle in their own filaments, fused through the mesh.
- Print-ready files the user can open in Bambu Studio and print on their **Bambu Lab P2S (256 mm bed) with AMS** and a **0.4 mm nozzle**.

## Non-goals

- Integration into the bin-builder React app, its UI, persistence or exporters.
- Reusability: no hinges, latches or magnets. The box is opened once.
- A general parametric gift-box tool. A few CLI flags are fine (see "Left to the builder"), but this is not a product.

## Anti-goals (failure even if it technically works)

- A lid that drops loose or has to be pried off.
- Tulle that is wrinkled or slack, or whose cut edge shows.
- Vine pieces that pop off the tulle.
- Anything that needs supports, or leaves a visibly rough, supported surface.
- Elephant's foot or a visible seam on a face the recipient looks at.
- A design that only prints well on the 0.2 mm nozzle. Bambu does not support PLA Marble or PLA Wood on it (clog risk).

## Materials (the user's own spools, from the Bambu Studio filament inventory)

| Part | Filament |
|---|---|
| Base, lid body, flower petals | Bambu PLA Marble, White Marble |
| Frame | Bambu PLA Wood, Rosewood |
| Vine (stem, leaves, tendrils) | Bambu PLA Basic, Mistletoe Green (user confirmed) |
| Flower centres | Bambu PLA Silk+, Gold (user confirmed) |
| Tulle | The user's white tulle (not printed) |

The vine and flower-centre colours **do not change the files**. Each is its own part in the lid's 3MF, and the user maps parts to AMS slots in Bambu Studio.

## Approaches considered

**What to build.** Five directions were mocked up in the artifact: Trellis, Ribbon & Bow, Vine, Lantern and Confetti. **The user chose Vine**, then refined it to a premium version: a white marble box with a wood frame, and later white tulle.

**How to build it:**

1. **A standalone Node script using `manifold-3d`** (chosen). It matches the user's existing `scripts/paper-stl.mjs` pattern. It reuses the CSG kernel already in this repo's dependencies, so the output is guaranteed manifold, and it needs nothing new installed.
2. **A new object type in the app.** Rejected: the user said not to use the bin-builder boxes, and a one-off doesn't justify the compiler-guided type plumbing described in CLAUDE.md.
3. **OpenSCAD or another CAD tool.** Rejected: it is a new tool, and the repo already has a proven manifold pipeline and verification method.

## Design

All dimensions are in mm. Y-up in the description below. The generator writes print-pose Z-up files.

### Base (print upright, open side up)

- Outer footprint **171.4 × 131.4**: inside plus 2 × 3.2 walls. Vertical corner radius **10** outside (6.8 inside).
- Floor **2.4**. Inside height 45, so the lid's underside sits at y = 47.4.
- **Shoulder** at y = 35.8, where the lower wall ends and the collar starts. This is 14 below the lid's outer top face, which sits at y = 49.8.
- **Collar**: 1.4 thick, its inner face flush with the cavity wall (so the inside stays 165 × 125 all the way up), rising from the shoulder to y = 47.1 (0.3 below the lid underside). Give the collar's top outer edge a small lead-in chamfer (about 0.6) so the lid finds it.
- 0.6 chamfer on the bottom outer edge, to hide elephant's foot.
- Cavity floor-to-wall junction: square is acceptable. A small fillet is the builder's call.

### Lid (print face-down: the outer top face is on the plate)

- Outer footprint identical to the base, **flush**. Same corner radius 10.
- Top plate **2.4** thick. Skirt **1.6** thick, total lid height **14**. The skirt slides over the collar with **0.2 clearance per side** (skirt inner 168.2 × 128.2 against collar outer 167.8 × 127.8). Closed, the skirt's bottom edge rests on the shoulder, which makes the single seam line.
- **Grip (user's decision): the lid must stay on when the box is tipped or carried at an angle, and still lift off with a gentle pull.** The clearance stays 0.2 so the skirt never binds across its whole face. The grip comes from **crush ribs** on the collar's outer face: narrow vertical half-round ribs that stand slightly proud of the skirt's inner face, so they deform a little as the lid goes on. Suggested starting point: 8 ribs (2 per long side and 2 per short side, away from the corners), 1.0 wide, standing 0.3 proud of the collar (0.1 interference). They run from 2 above the shoulder to 1 below the collar top, with a tapered lead-in at the top so the lid starts on easily. The **interference is a single parameter**, set from the fit test below.
- **Fit test first (user's decision).** The generator writes `gift-box-fit-test.3mf`: **a mini box** (80 × 60 inside) built by the same code with the real box's exact cross-section — walls, collar, 0.2 clearance, skirt, rib profile — and one rib in the middle of each face. Three open-frame bases (no floor, 3.2 below the shoulder) at rib interference **0.05 / 0.10 / 0.15**, labelled by 1 / 2 / 3 notches, and one lid with only a 10 mm rim of top plate. About 56 min and 39 g at 0.20 mm. Its walls are stiffer than the real 150 mm runs, so it reads slightly tight; pick "right or a touch firm". *(Revised after two failed designs: a corner piece had no opposing face to squeeze against, and a strip across the box was cut in two by the lid's window. Every fit-test part must be one connected piece — tested.)* The user reports which one felt right, and the full box is generated with that value (`--interference`). Default before the test: 0.10.
- 0.6 chamfer on the top outer edge, which is the bed edge in the print pose. The builder may enlarge it to about 0.8 for a softer look.
- **Oval window**, centred: semi-axes **63.7 × 44.7** (outer half-size − 22 / − 21).
- **Tulle plane**: 1.16 above the plate. This is a layer boundary at a 0.2 mm first layer plus 0.12 mm layers. The pause goes before the first layer above it. If layer settings change, the builder re-snaps it.
- **Frame locating holes**: 4 blind holes, Ø1.95 × 0.9 deep, in the outer top face for the filament dowel pins (see Frame). They sit on the frame band's midline (window + 5) at 0°, 90°, 180° and 270°. They must stay shallower than the tulle plane.

### Window contents (lid parts, printed in the lid job)

All of them span the **full plate thickness** (0 → 2.4), so they sit flush with both faces of the lid and are split by the tulle at the pause.

- **Vine** (one part): an S-curved stem (2.5–2.8 wide) that crosses the window and ends exactly on the window ellipse, abutting the lid body without overlapping it. It has about 12 leaves (15–19 long, about 10 wide, each with a vein slot) and 2 spiral tendrils. Every leaf and tendril lies wholly inside the window. Composition as in the artifact render.
- **Flower petals**: 3 five-petal flowers, as islands in the marble lid-body part.
- **Flower centres** (one part): the centre discs, subtracted from the petals so the parts don't overlap.
- Minimum solid feature **1.0**, minimum slot **0.8** (0.4 nozzle). Tendrils taper no thinner than 1.0.
- Parts must abut, never overlap. Overlapping volumes of different filaments make the slicer's result undefined.

### Frame (print flat, underside down)

- An oval moulding swept around the window. The inner edge sits at **window − 1** (so it overlaps the window opening by 1), and the frame is **12** wide.
- Profile from inside to out: a 1.0 vertical inner lip, a convex quarter-round rising to a flat at 3.6, a half-round **bead** peaking at **5.8**, a short flat, a rolled outer edge, then a vertical outer edge down to the plate. Use the same profile as `ovalFrame()` in the artifact.
- No overhangs: every surface faces up or is vertical.
- **Alignment uses loose dowel pins cut from 1.75 mm filament**, not printed pegs. Pegs on the frame's underside would hold it off the bed and make the whole underside an overhang. The lid's outer face is also a bed face, so pegs can't go there either. Instead, both parts get blind holes in their bed faces, and the user cuts 4 pins about 2.2 long from any spare filament. *(Builder's-check finding; the call is mine.)*
  - Frame: 4 holes, Ø1.95 × 1.5 deep, in the underside, on the band's midline at 0°, 90°, 180° and 270°.
  - Lid: 4 matching holes, Ø1.95 × 0.9 deep (staying below the 1.16 tulle plane).
  - A few drops of CA or PLA-safe glue do the holding. The pins only align.

### Tulle

- The user cuts the tulle to an oval **window + 8 mm** all round. The generator outputs a 1:1 SVG cutting template with the window outline dashed for reference.
- At the pause the user centres it over the window opening and **holds it down with a few dabs of glue stick** (the P2S ships with one) on the margin ring, pressing it flat and taut. It is not taped: there is no edge outside the print to tape to, and tape printed over would bury a thick layer in the plate and could catch the nozzle. The thin glue film is water-soluble, sits only in small spots, and ends up hidden inside the opaque marble under the frame band. *(Builder's-check finding; the call is mine.)*
- It sits entirely inside the plate, so its cut edge never shows. It must **not** reach the skirt; a full sheet would weaken the skirt-to-plate bond and leave a visible hairline on the lid's sides.

## Output

`scripts/gift-box.mjs`, run with `node scripts/gift-box.mjs`, writes to `~/Downloads/gift-box/` (the same convention as `paper-stl.mjs`):

| File | Contents |
|---|---|
| `gift-box-base.3mf` (+ `.stl`) | Base, print pose |
| `gift-box-lid.3mf` | **One object with three parts**: body (marble, includes petals), vine, flower centres. Face-down print pose. |
| `gift-box-frame.3mf` (+ `.stl`) | Frame, print pose |
| `gift-box-fit-test.3mf` | Base corner + three labelled lid-corner pieces (rib interference 0.05 / 0.10 / 0.15). **Printed first.** |
| `tulle-template.svg` | 1:1 cutting template, in mm units so it prints at true size |
| `README.txt` | Which filament goes on which part, the pause layer (number and height), plate and settings notes |

**Pause in the 3MF (preferred):** write Bambu-style project metadata: per-part filament assignment in `Metadata/model_settings.config`, and the pause in `Metadata/custom_gcode_per_layer.xml`. The file should then open with the parts already mapped and the pause already set. If Bambu Studio doesn't honour hand-written metadata (verify with its CLI), fall back to a plain multi-part 3MF and put the exact layer number and Add Pause instructions in `README.txt`.

## Print settings (for README.txt)

- 0.4 mm nozzle, 0.2 first layer, 0.12 layers.
- Walls solid: enough wall loops that the 3.2 walls, the 1.4 collar and the 1.6 skirt are all perimeters, with no infill sandwiches.
- Seam on the back.
- Lid on the **textured PEI plate**, which gives the honed-stone top. Base and frame on either plate.
- No supports on any part.
- Rough material estimate: about 220–250 g of White Marble (the user has about 900 g) and about 10 g of Rosewood.

## Verification (CLAUDE.md conventions)

- Every part: exact edge check, 0 open and 0 non-manifold edges (Manifold output, indexed). STL size = 84 + 50 × triangles.
- **Fit**: in the closed pose, `lid ∩ (base without ribs)` (computed as `A − (A − B)`) has zero volume, and the radial gap between skirt and collar measures 0.2. With ribs, the intersection is exactly the rib interference volume: 8 ribs × interference × rib length, within tolerance. Check this for each fit-test piece too, so each label matches its geometry.
- **Frame**: with Ø1.75 pin cylinders in both sets of holes, `(frame ∪ pins) ∩ lid` has zero volume apart from the pins sitting in the lid holes. Shift the frame 0.5 sideways (pins moving with it) and assert the pins now collide with the lid, which proves the pins actually index it.
- **Lid parts**: vine ∩ body and centres ∩ body have zero volume, and no vine or centre vertex lies outside the window ellipse except where the stem ends sit on it.
- **Cavity**: measure the inner size directly off the mesh: 165 × 125 at floor level and at collar-top level, and 45 from floor to lid underside in the closed pose.
- **Slicer**: Bambu Studio CLI (`/Applications/BambuStudio.app/Contents/MacOS/BambuStudio --slice 0 …`) slices each 3MF without error. For the lid, confirm the pause is in the G-code at the expected layer if the metadata route is used.
- Bed fit: every part within 256 × 256.

## Left to the builder

- Exact vine composition (leaf count, placement and seed), as long as it matches the artifact's look and obeys the feature-size and inside-window rules.
- Cavity floor fillet, and the collar lead-in chamfer size (0.4–0.8).
- Lid top-edge chamfer, 0.6–0.8.
- Glue recommendation wording.
- CLI flags, if any (e.g. `--out`, overriding the inside size).
- Mesh resolution (segments on arcs and ellipses), within a sensible slicer-friendly triangle count.
