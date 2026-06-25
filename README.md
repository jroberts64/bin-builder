# Bin Builder

A browser-based parametric bin builder for 3D printing, inspired by the
[Gridfinity Generator](https://gridfinitygenerator.com). Configure a storage bin
with a live 3D preview and export print-ready **STL** and **3MF** files.

Gridfinity-aware but not constrained: bins default to the standard 42mm grid, but
you can change the grid pitch or switch to fully freeform millimetre dimensions.

## Features

- **Two object types** — a Gridfinity-style **bin**, or a **sliding-lid box**
  (closed box whose lid slides into side grooves). Switch via the header tabs.
- **Sliding box** — define the inner width/depth/height; generates a watertight
  box body + a sliding lid with adjustable fit clearance, laid out flat for
  printing. Lid inserts from the front and seats against the closed back.
- **Gridfinity toggle** — switch the Gridfinity foot, baseplate clearance and
  magnet/screw sockets on or off. Off = a plain flat-bottomed tray. Independent
  of how the bin is sized.
- **Grid sizing** — adjustable grid/cell unit (42mm default) with X / Y / Z counts
- **Custom size mode** — freeform width/depth/height in mm, off-grid
- **Accurate Gridfinity base** — three-step chamfered foot profile per grid cell,
  with rounded corners, that mates with standard baseplates (Gridfinity mode)
- **Real magnet & screw holes** — bored into the underside via CSG
  (none / corner / full placement)
- **Construction options** — outer & inner wall thickness, lip style (default / thin / none)
- **Compartments** — add vertical/horizontal dividers and drag them to position
- **Finger scoop** — curved ramp on the back wall of each compartment
- **Label tab** — overhang ledge along the back top edge of each compartment
- **Live 3D viewport** — orbit, zoom, build-plate grid, fit-to-view
- **mm / inch** measurement readout
- **Save / load** — named designs in the browser (localStorage), auto-save of the
  working design across reloads, `.json` export/import, and shareable `?d=` links
- **Export** — **watertight** binary STL and a valid 3MF package (Z-up, millimetres)

> **Watertight output:** geometry is built with the [Manifold](https://github.com/elalish/manifold)
> CSG kernel, which guarantees manifold meshes (every edge shared by exactly two
> triangles). Exports import cleanly into strict slicers like Bambu Studio with no
> repair step required.

## Develop

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # production build to dist/
```

## Deploy

The app is a static SPA hosted on **AWS S3 + CloudFront** (private bucket, served
over HTTPS via Origin Access Control). Live at
**https://bin-builder.jack-roberts.com** (and the underlying `*.cloudfront.net`
URL output by the infra stack).

**Continuous deployment:** every push to `main` triggers
[`.github/workflows/deploy.yml`](.github/workflows/deploy.yml), which builds and
deploys automatically. It authenticates to AWS with **GitHub OIDC** — a
short-lived token exchanged for a repo-scoped IAM role, so no AWS keys are stored
in GitHub.

**Manual deploy** (from a logged-in machine):

```bash
aws sso login --sso-session personal-sso   # refresh credentials
AWS_PROFILE=personal-sso ./deploy/deploy.sh # build, sync to S3, invalidate CDN
```

`deploy.sh` works both locally (set `AWS_PROFILE`) and in CI (uses the assumed
role's ambient credentials). It reads bucket/distribution ids from the
CloudFormation stack outputs, so nothing is hard-coded.

### Infrastructure

Provisioned via CloudFormation in [`deploy/`](deploy/):

| Template | Creates |
|----------|---------|
| `static-site.yaml` | Private S3 bucket + CloudFront + OAC + SPA routing (403/404 → `index.html`) |
| `github-oidc.yaml` | GitHub OIDC provider + a least-privilege, repo+branch-scoped deploy role |

First-time setup:

```bash
# Hosting (stack: bin-builder-site). Omit DomainName/HostedZoneId to serve only
# on the default *.cloudfront.net URL. With them set, the stack also creates a
# DNS-validated ACM cert and Route53 alias records for the custom domain.
aws cloudformation deploy --template-file deploy/static-site.yaml \
  --stack-name bin-builder-site \
  --parameter-overrides BucketName=bin-builder-<accountid> \
    DomainName=bin-builder.jack-roberts.com HostedZoneId=<zone-id> \
  --profile personal-sso --region us-east-1

# CI deploy role (stack: bin-builder-gha-oidc)
aws cloudformation deploy --template-file deploy/github-oidc.yaml \
  --stack-name bin-builder-gha-oidc \
  --parameter-overrides GitHubOrg=<org> GitHubRepo=<repo> \
    SiteBucketName=bin-builder-<accountid> CreateOIDCProvider=true \
  --capabilities CAPABILITY_NAMED_IAM \
  --profile personal-sso --region us-east-1
```

Then set the workflow's `role-to-assume` to the `DeployRoleArn` stack output.
For a second project in the same AWS account, deploy `github-oidc.yaml` with
`CreateOIDCProvider=false` (the provider is account-wide and exists once).

## Architecture

| Path | Responsibility |
|------|----------------|
| `src/model/types.ts` | `BinModel` data model, Gridfinity constants, size resolution |
| `src/model/geometry.ts` | Builds the mesh via CSG: rounded body + chamfered feet, hollowed cavity, dividers, scoops, label tabs, bored magnet/screw holes, lip |
| `src/model/csg.ts` | Manifold (WASM) add/subtract wrappers, async `initCSG()`, THREE↔Manifold conversion, vertex-weld helper |
| `src/model/export.ts` | STL exporter + dependency-free 3MF (ZIP/OPC) writer |
| `src/model/serialize.ts` | Versioned (de)serialization + input validation; `.json` and share-URL encoding. Single trusted-input boundary. |
| `src/model/storage.ts` | localStorage CRUD for named designs + the autosave slot |
| `src/Viewport.tsx` | Three.js scene, lights, orbit controls, build plate (debounced rebuild) |
| `src/Sidebar.tsx` | All parameter controls + header (export + save menu) |
| `src/SaveMenu.tsx` | Save/load/delete designs, import/export `.json`, copy share link |
| `src/App.tsx` | State + layout; resolves initial design (URL → autosave → default) |

## How the geometry is built

The bin is assembled with the [Manifold](https://github.com/elalish/manifold)
CSG kernel (WASM), which guarantees watertight, manifold output:

1. Solid rounded-rectangle body + a chamfered Gridfinity foot per grid cell
2. Subtract the interior cavity to form walls and floor
3. Add dividers; subtract finger-scoop cylinders; add label tabs
4. Subtract magnet / screw sockets from the underside
5. Add the stacking lip, weld coincident vertices into one mesh

Additive parts deliberately overlap their neighbours (rather than touching
coplanar) so booleans produce clean cuts. The kernel is loaded asynchronously on
startup (`initCSG`); rebuilds are debounced in the viewport so dragging a slider
stays responsive.

## Next steps

- **Per-compartment features** — scoop/label are global today; make them
  selectable per compartment.
- **More** — baseplate generator, design save/load, custom corner radius and
  foot-profile controls, magnet/screw size presets.
