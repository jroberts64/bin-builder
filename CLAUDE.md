# CLAUDE.md

Guidance for working in this repo. Read alongside `README.md` (user-facing) — this file is the build/architecture contract.

## What this is

A browser-based parametric builder for 3D-printable storage, with a live 3D preview and print-ready **STL** / **3MF** export. Three **object types** (see "Object types" below):

- **Bin** — a Gridfinity-style bin. Gridfinity-aware (42mm grid, chamfered foot, stacking lip) but not constrained by it: the grid pitch is adjustable and a custom-size mode frees the footprint entirely.
- **Box** — a closed box with a choice of **top type**: a **sliding lid** or a print-in-place **hinged lid**.
- **Skadis** — a container/holder that clips onto an IKEA SKÅDIS pegboard via print-in-place back hooks. Rectangular (adjustable corner radius; 0 = sharp) or round/elliptical cross-section, a full-height taper, an open-bottom rim shelf, and a degrees-based front opening.

Runs 100% in-browser. No backend. Designs persist in localStorage (autosave + named saves) and can be shared via URL.

## Stack

React 18 + Vite 5 + TypeScript (strict) + Three.js. CSG via `manifold-3d` (WASM; guarantees watertight/manifold boolean output). Those four are the only runtime deps — keep it that way unless there's a strong reason.

## Commands

```bash
npm install
npm run dev      # vite dev server (http://localhost:5173 by default)
npm run build    # tsc-less vite production build to dist/
npm run preview  # serve the production build
```

There is **no test suite and no linter configured**. "Verify" means: `npm run build` compiles clean, then load the app and check the 3D preview + export in a browser. Don't claim something works without doing that.

`npm run build` (Vite/esbuild) does **not** full-type-check. Run `npx tsc --noEmit` for that — but note **two known pre-existing errors** it reports (the `manifold-3d/manifold.wasm?url` import has no type decl; a `Uint8Array`→`BlobPart` cast in the ZIP writer). Both are harmless and don't affect the Vite build; ignore them and only act on *new* errors.

Strong way to verify geometry/exports without a human: drive the running dev app via the Playwright MCP tools and `import()` the model/export modules in-page (init CSG first), then assert watertightness (0 open / 0 non-manifold edges), STL size (`84+tris*50`), and 3MF object counts. This is how every geometry change in this repo has been checked.

## Architecture

| Path | Responsibility |
|------|----------------|
| `src/model/types.ts` | `BinModel` data model, `GRIDFINITY` constants, `defaultBin()`, `resolvedSize()`. |
| `src/model/box.ts` | `BoxModel` (incl. `topType: 'sliding' \| 'hinged'`), `defaultBox()`, `boxOuterSize()`, `buildBox()` → `{ box, lid, size }` (two meshes). Sliding + hinged geometry. |
| `src/model/skadis.ts` | `SkadisModel`, `SKADIS` constants, `defaultSkadis()`, `skadisOuterSize()`, `buildSkadis()` → `{ geometry, size }` (one mesh). Container + pegboard hooks. Self-contained. |
| `src/model/geometry.ts` | `buildBin(model)` — assembles the bin mesh via CSG. |
| `src/model/csg.ts` | Manifold (WASM) `csgAdd` / `csgSubtract` wrappers, `initCSG()` async init, THREE↔Manifold mesh conversion, `weld()` (vertex merge). |
| `src/model/export.ts` | Bin `exportSTL`/`export3MF`/`exportSTEP`; box `exportBoxSTL`/`exportBox3MF`/`exportBoxSTEP`; skadis `exportSkadis*`; multi-object 3MF writer + dependency-free ZIP/OPC writer with CRC32; faceted-STEP (AP214) writer. |
| `src/model/serialize.ts` | `Design` envelope `{ type, bin, box }`, versioned (de)serialization, `coerceModel`/`coerceBox`/`coerceDesign` validation, `.json` and share-URL (`?d=` base64url) encode/decode. |
| `src/model/storage.ts` | localStorage: named-design CRUD + the single autosave slot (both store a `Design`). All reads defensive (corrupt store → empty/null). |
| `src/Viewport.tsx` | Three.js scene, lights, OrbitControls, build plate. Renders 1 mesh (bin) or 2 (box + lid) in a group; rebuilds on design change (debounced). |
| `src/Sidebar.tsx` | Object-type switch + per-type controls (`BinControls`/`BoxControls`) + header (export buttons + `SaveMenu`). Shared presentational components at the bottom. |
| `src/SaveMenu.tsx` | Save/load/delete designs, import/export `.json`, copy share link. Dropdown from the header. |
| `src/App.tsx` | Top-level state (`Design`, name, build-plate toggle, fit signal) + layout. Resolves the initial design and autosaves. |
| `src/styles.css` | All styling. Dark theme; CSS variables at `:root`. |

State flows one way: `App` owns a single `Design` (`{ type, bin, box }`), passes it + per-type setters to `Sidebar`, and the whole `Design` to `Viewport`. There is no global store; don't add one for this size of app.

## Persistence

Anything that crosses the trust boundary (localStorage, `.json` import, `?d=` share URL) MUST go through `serialize.ts` — `coerceDesign()` (calling `coerceModel`/`coerceBox`/`coerceSkadis`) clamps every field to a safe range and drops bad enums, so untrusted input can never produce an invalid `Design`. Don't `JSON.parse` a design and feed it to `buildBin`/`buildBox`/`buildSkadis` directly.

The persisted unit is a `Design` envelope `{ type, bin, box, skadis }` — every model is always present so toggling object type preserves each one's settings. `coerceDesign` is back-compatible: a legacy bare-`BinModel` or `{ model }` shape coerces to `{ type: 'bin', … }`, and a save predating a model (e.g. no `skadis`) fills that model from its default.

Initial design resolution order (`App.initialState`): share URL `?d=` → autosave slot → `defaultDesign()`. Autosave is debounced (300ms) on every change. Named designs are keyed by case-insensitive name (re-saving overwrites). Bump `SCHEMA_VERSION` in `serialize.ts` if the shape changes incompatibly, and handle the migration in the coerce functions.

## Object types: bin, box, skadis

`Design.type` (an `ObjectType`) selects which object is built/shown/exported. The three are independent code paths sharing only the CSG kernel and exporters:

- **bin** → `buildBin` (`geometry.ts`), one mesh. See the two axes + bin geometry below.
- **box** → `buildBox` (`box.ts`), returns **two** meshes (`box` body + `lid`). `box.ts` is self-contained; don't fold box logic into `geometry.ts`.
- **skadis** → `buildSkadis` (`skadis.ts`), **one** mesh (container + hooks fused), so it exports like the bin. Self-contained.

**Every dispatch on `ObjectType` is an exhaustive `switch` guarded by `assertNever`** (in `serialize.ts`, `App.tsx`, `Viewport.tsx`, and `Sidebar.tsx`'s `renderControls`/`doExportSTL`/`doExport3MF`), and the header tabs come from the `TYPE_TABS` array. `OBJECT_TYPES` in `serialize.ts` is the single source of the type set. So **adding a fourth type is compiler-guided**: extend the `ObjectType` union + `OBJECT_TYPES`, and every site that needs a new branch fails to compile until handled. The rest of the recipe: a model + `default*()` + `*OuterSize()` + builder in its own module, a `coerce*` in `serialize.ts` (threaded into `Design`/`SavedDesign`/`defaultDesign`/`serializeDesign`/`coerceDesign` **and** the `StoredDesign` literal in `storage.ts` + the `onLoad` literal in `SaveMenu.tsx`), export functions in `export.ts`, a `TYPE_TABS` row + `*Controls` in `Sidebar.tsx`. Keep each object's geometry in its own module.

## Box top types (`box.ts`)

`BoxModel.topType` is `'sliding' | 'hinged'`; `buildBox` dispatches to `buildSlidingBox` / `buildHingedBox`. Box dimensions are the **inner cavity** (not outer). Both builders return watertight `box` + `lid` meshes, modelled Y-up on Y=0.

- **sliding** — lid rides in grooves cut into the top inner edge of the side walls; back wall closed (stop), front open (insert). Exported as **two separate parts** (3MF = 2 objects; STL = `.zip` of `-box.stl` + `-lid.stl`).
- **hinged** — **print-in-place pin hinge** at the back edge. Modelled/printed **open & flat**: box open-top up, lid flat on the plate behind it, joined by interleaved knuckles + a fused pin. Prints supportless with the pin axis along the bed (never on Z — that cracks). Overlapping lip + snap bead hold it shut. Exported as **one print-in-place assembly**, parts left **interlocked in place, NOT moved apart** (3MF = 2 objects in position; STL = one combined `.stl`).

### Hinge clearances (research-backed; don't reduce blindly)

FDM print-in-place sweet spot is **0.2–0.3mm**. Defaults: pin-to-bore `boreGap` ≈ 0.25mm, knuckle-to-knuckle gap ≈ 0.3mm, odd knuckle count (5) so both ends are box knuckles. Too small fuses the hinge solid (the #1 failure); too large is floppy. The `clearance` field drives these. If you touch hinge geometry, re-verify: knuckles interleave (alternating box/lid bands, no overlap) and the exported STL stays **interlocked** (X-extent ≈ box width, not ≈ box+lid moved apart).

## Skadis holders (`skadis.ts`)

One fused watertight mesh, modelled Y-up on Y=0 (mouth opening at +Y; **+Z = front**, **−Z = back** where the pegboard sits). Dimensions are the **outer** container. `buildSkadis` pipeline: outer tapered solid → subtract cavity → (open bottom) subtract inner-inset floor → (opening) subtract front wedge → union back plate + hooks → weld.

- **Taper** — one primitive `taperedExtrude(shape, h, y0, bottomScale, topScale)`: build a bevel-free `ExtrudeGeometry` (clean, correctly-wound caps + walls), then scale each vertex's X/Z by a factor from its Y. A bevel-free extrude has vertices **only** at its two ends, so the factor is exactly `bottomScale`/`topScale` → an exact linear taper. `bottomScale = taper/100`, mouth = 1. (ExtrudeGeometry itself can't taper; don't try.) Weld before any boolean, as always.
- **Front opening** (`openingDeg`) — subtract a full-height **pie-slice wedge** (apex on the axis, bisected by +Z, sampled arc). One uniform rule: a clean arc on round, a V-notch on rect. Capped at 300° so it never reaches the back plate/hooks.
- **Open bottom** — subtract the inner outline inset by `supportLip` through the floor, leaving a rim shelf.
- **Mount** — `SKADIS` constants are the real pegboard spec: **40mm** hole pitch, **5×15mm** slots, **5mm** board. Hooks sit on the 40mm grid (columns `floor(width/40)+1`, a 2nd row 40mm down when tall enough). `hookStyle` (`'peg' | 'snap' | 'clip'`, built per-hook by `hookParts`) trades holding strength for simplicity: **peg** = friction peg filling the slot; **snap** = thin peg + a catch that drops behind the solid board below the slot (clearance gap, easy on/off); **clip** = same but a deeper catch snug to the board back (strongest). The back plate embeds into the container back so the union is a solid overlap (a tangent line on round backs wouldn't be manifold-safe).
  - **Critical invariant — the plate must seat flush.** The board is a continuous sheet whose only gaps are the slots, so the board thickness can only be gripped between the plate (front) and a catch behind the *solid* board below the slot — there's nowhere to hook in front of the board except the slot itself. **Nothing may enter the "board channel"** (the z gap between the plate face at `-depth/2` and the board back) except the peg threading the slot; anything else (an earlier 45° print-gusset did this) blocks flush seating. Verify with the exact-intersection test: build a board proxy (slab with the slots cut at the hook positions) and assert `holder ∩ board` (`A − (A − B)`, see [[hinge-overlap-verification]]) is **empty**. The hooks are the part most likely to need a real test-print to tune the fit.

## Two independent axes: Gridfinity vs sizing

These are separate and must stay separate — a common source of confusion:

- **`gridfinity: boolean`** — whether the bin has Gridfinity *features*: the
  chamfered stacking foot, baseplate clearance, the standard corner radius, and
  magnet/screw sockets. Off = a plain flat-bottomed tray.
- **`customSize: boolean`** — whether the bin is *sized* by unit counts
  (`unitsX/Y/Z` × `gridUnit`) or by freeform mm (`sizeX/Y/Z`).

All four combinations are valid and tested. In `buildBin` the locals are
`gf = m.gridfinity` and `gridded = !m.customSize`. Feet/sockets need `gf`; the
per-cell layout needs `gridded` too (a `gf && customSize` bin gets one foot
spanning the whole footprint instead of per-cell feet). Baseplate clearance is
only subtracted from the footprint when `gf` is on (see `resolvedSize`). The
Sidebar hides the magnet/screw controls when `gridfinity` is off.

## How geometry is built (`buildBin`)

Constructive solid geometry pipeline, in order:

1. Solid rounded-rectangle body (`roundedPrism`) + one chamfered Gridfinity foot per grid cell
2. Subtract the interior cavity → walls + floor
3. Add dividers; subtract finger-scoop cylinders; add label tabs
4. Subtract magnet / screw sockets from the underside
5. Add the stacking lip, then `weld()` the whole thing into one indexed mesh

**Coordinate convention:** Y is up in the viewport; the build plate is at `Y = 0`. Exporters bake a `+90° X` rotation (`toZUp` in `export.ts`) to convert to **Z-up** (slicer convention). (It's +90°, not −90° — −90° prints upside down; that was a real bug we fixed.)

### Hard-won rules for editing geometry — read before touching `buildBin`

- **Additive parts must overlap their neighbours, never touch coplanar.** Coplanar contact in CSG produces open edges. Use the `EPS` overlap constant. Dividers dip into the floor and span past the inner walls; feet overshoot up into the body; the lip overlaps the body top by `EPS`.
- **`ExtrudeGeometry` is not a clean CSG input.** Its caps and walls aren't welded, and Manifold's `ofMesh` rejects non-manifold input. `roundedPrism` runs `weld()` on its output; `toManifold` in `csg.ts` also welds before conversion. Keep both — Manifold throws on bad input rather than silently producing garbage.
- **CSG is async to initialise.** `initCSG()` loads the WASM module once; `App` awaits it and gates rendering/export on a `ready` flag. `buildBin` itself is synchronous and throws if called before init. Don't call `buildBin`/`exportSTL`/`export3MF` before `ready`.
- **CSG is expensive.** The viewport debounces rebuilds (~80ms). Don't move `buildBin` into a render path that runs every frame.

## Watertightness

Output is **guaranteed watertight and manifold** — Manifold operates on manifold meshes and produces meshes where every edge is shared by exactly two triangles. This was switched from `three-bvh-csg` (which left hundreds of non-manifold edges that Bambu Studio rejected) specifically to fix that.

When verifying exports: check structural validity (STL header/size consistency `84 + tris*50`; 3MF is a valid ZIP with the model XML) **and** that the manifold edge check returns 0 open / 0 non-manifold edges. Quantize vertices (~1e-3mm) when checking exported STL because the STLExporter re-expands to non-indexed triangles. A regression here means the WASM kernel got bypassed or an input primitive isn't manifold.

## Export format notes

- **STL** — binary, via Three's `STLExporter`. File size must equal `84 + triangles*50`; that's the validity check. STL has **no concept of separate objects** (one file = one mesh soup), which is why multi-part exports differ from 3MF: a sliding box ships a **`.zip` of two `.stl`s**; a hinged box is one combined `.stl` (single print-in-place assembly); a bin and a skadis holder are each one `.stl`.
- **3MF** — built by hand: a stored (uncompressed) ZIP of `[Content_Types].xml`, `_rels/.rels`, and `3D/3dmodel.model`. Millimetre units. Supports **multiple objects**: `geometriesToBlob3MF([...])` emits one `<object>` + `<build><item>` per geometry, so boxes export as 2 objects (bins and skadis holders as 1). The ZIP writer (string + binary variants) + CRC32 in `export.ts` are intentionally dependency-free; don't pull in JSZip.
- **STEP** — hand-rolled AP214 text writer (`geometriesToBlobSTEP`), dependency-free like the ZIP/3MF writers. A **faceted B-rep**: it can't recover analytic surfaces from a mesh, so every triangle becomes a planar `ADVANCED_FACE`, but with shared `VERTEX_POINT`s and shared `EDGE_CURVE`s (welded position-only via `mergeVertices`, stripping split normals) so the output is a real `MANIFOLD_SOLID_BREP` (one `CLOSED_SHELL`), not triangle soup. Multiple bodies per file (like 3MF): a box exports as 2 solids in **one** `.step` (no zip — STEP holds multiple bodies natively), for both sliding and hinged. Millimetre units. Verify like the others: parse the text and assert Euler `V−E+F==2` per solid, every undirected edge used exactly twice with cancelling orientation (`.T.`/`.F.`), and `ADVANCED_FACE`/`VERTEX_POINT`/`EDGE_CURVE` counts equal the welded topology.
- Models are Y-up; `toZUp()` rotates **+90° about X** to Z-up for export (slicer convention).
- `grep -c "<triangle"` on the 3MF lies — all triangles are on one line, so it returns 1. Count substring occurrences, not lines.

## Conventions

- TypeScript strict mode is on (`noUnusedLocals`, `noUnusedParameters`). The build fails on unused symbols.
- Match the existing comment density — geometry code is heavily commented because the math isn't obvious; UI components are not.
- Keep `GRIDFINITY` constants in `types.ts` as the single source; don't scatter magic numbers into `geometry.ts`.
- Sidebar uses small inline presentational components (`Section`, `Field`, `NumberInput`, `Toggle`, `Seg*`). Reuse them rather than adding bespoke markup.

## Gotchas

- The `.playwright-mcp/` dir is gitignored scratch space from browser verification; safe to delete.
- `dist/` is build output; delete after verifying a build.
- Dev server: if a port is taken, vite picks the next one — check its startup log for the actual URL.
