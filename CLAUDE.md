# CLAUDE.md

Guidance for working in this repo. Read alongside `README.md` (user-facing) — this file is the build/architecture contract.

## What this is

A browser-based parametric **bin builder** for 3D printing, inspired by the Gridfinity Generator. Configure a storage bin with a live 3D preview and export print-ready **STL** and **3MF** files. Gridfinity-aware (42mm grid, chamfered foot, stacking lip) but **not constrained by it** — the grid pitch is adjustable and a custom-size mode frees the footprint entirely.

Runs 100% in-browser. No backend, no persistence.

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

## Architecture

| Path | Responsibility |
|------|----------------|
| `src/model/types.ts` | `BinModel` data model, `GRIDFINITY` constants, `defaultBin()`, `resolvedSize()`. Single source of truth for parameters. |
| `src/model/geometry.ts` | `buildBin(model)` — assembles the mesh via CSG. The heart of the app. |
| `src/model/csg.ts` | Manifold (WASM) `csgAdd` / `csgSubtract` wrappers, `initCSG()` async init, THREE↔Manifold mesh conversion, `weld()` (vertex merge). |
| `src/model/export.ts` | `exportSTL` / `export3MF` + a dependency-free ZIP/OPC writer with CRC32. |
| `src/model/serialize.ts` | Versioned (de)serialization, `coerceModel()` validation, `.json` and share-URL (`?d=` base64url) encode/decode. |
| `src/model/storage.ts` | localStorage: named-design CRUD + the single autosave slot. All reads defensive (corrupt store → empty/null). |
| `src/Viewport.tsx` | Three.js scene, lights, OrbitControls, build plate. Rebuilds the mesh on model change (debounced). |
| `src/Sidebar.tsx` | All parameter controls + header (export buttons + `SaveMenu`). Self-contained presentational components at the bottom. |
| `src/SaveMenu.tsx` | Save/load/delete designs, import/export `.json`, copy share link. Dropdown from the header. |
| `src/App.tsx` | Top-level state (`BinModel`, name, build-plate toggle, fit signal) + layout. Resolves the initial design and autosaves. |
| `src/styles.css` | All styling. Dark theme; CSS variables at `:root`. |

State flows one way: `App` owns the `BinModel`, passes it + a setter to `Sidebar`, and the model to `Viewport`. There is no global store; don't add one for this size of app.

## Persistence

Anything that crosses the trust boundary (localStorage, `.json` import, `?d=` share URL) MUST go through `serialize.ts` — `coerceModel()` clamps every field to a safe range and drops bad enums/dividers, so untrusted input can never produce an invalid `BinModel`. Don't `JSON.parse` a design and feed it to `buildBin` directly.

Initial design resolution order (`App.initialState`): share URL `?d=` → autosave slot → `defaultBin()`. Autosave is debounced (300ms) on every model change. Named designs are keyed by case-insensitive name (re-saving the same name overwrites). Bump `SCHEMA_VERSION` in `serialize.ts` if the model shape changes incompatibly, and handle the migration in `coerceModel`.

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

**Coordinate convention:** Y is up in the viewport; the build plate is at `Y = 0`. Exporters bake a `-90° X` rotation to convert to **Z-up** (slicer convention) — see `exportGeometry` in `export.ts`.

### Hard-won rules for editing geometry — read before touching `buildBin`

- **Additive parts must overlap their neighbours, never touch coplanar.** Coplanar contact in CSG produces open edges. Use the `EPS` overlap constant. Dividers dip into the floor and span past the inner walls; feet overshoot up into the body; the lip overlaps the body top by `EPS`.
- **`ExtrudeGeometry` is not a clean CSG input.** Its caps and walls aren't welded, and Manifold's `ofMesh` rejects non-manifold input. `roundedPrism` runs `weld()` on its output; `toManifold` in `csg.ts` also welds before conversion. Keep both — Manifold throws on bad input rather than silently producing garbage.
- **CSG is async to initialise.** `initCSG()` loads the WASM module once; `App` awaits it and gates rendering/export on a `ready` flag. `buildBin` itself is synchronous and throws if called before init. Don't call `buildBin`/`exportSTL`/`export3MF` before `ready`.
- **CSG is expensive.** The viewport debounces rebuilds (~80ms). Don't move `buildBin` into a render path that runs every frame.

## Watertightness

Output is **guaranteed watertight and manifold** — Manifold operates on manifold meshes and produces meshes where every edge is shared by exactly two triangles. This was switched from `three-bvh-csg` (which left hundreds of non-manifold edges that Bambu Studio rejected) specifically to fix that.

When verifying exports: check structural validity (STL header/size consistency `84 + tris*50`; 3MF is a valid ZIP with the model XML) **and** that the manifold edge check returns 0 open / 0 non-manifold edges. Quantize vertices (~1e-3mm) when checking exported STL because the STLExporter re-expands to non-indexed triangles. A regression here means the WASM kernel got bypassed or an input primitive isn't manifold.

## Export format notes

- **STL** — binary, via Three's `STLExporter`. File size must equal `84 + triangles*50`; that's the validity check.
- **3MF** — built by hand: a stored (uncompressed) ZIP of `[Content_Types].xml`, `_rels/.rels`, and `3D/3dmodel.model`. Millimetre units. The ZIP writer + CRC32 in `export.ts` are intentionally dependency-free; don't pull in JSZip.
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
