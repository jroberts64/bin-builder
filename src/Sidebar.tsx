import { useEffect, useRef, useState } from 'react'
import {
  BinModel,
  Divider,
  LipStyle,
  SocketStyle,
  resolvedSize,
} from './model/types'
import { BoxModel } from './model/box'
import {
  BoxTexture,
  ResolvedTexture,
  TextureContext,
  TextureMode,
  TextureSpec,
  TEXTURE,
  TEXTURE_PATTERNS,
  PATTERNS,
  minPitch,
  resolveTexture,
  textureDepthLimit,
} from './model/texture'
import { SkadisModel, HolderShape, HookStyle, OpeningSide, maxOpeningDeg } from './model/skadis'
import { LithoModel, LithoShape, prepareLithoImage } from './model/litho'
import { panelHeight } from './model/litho'
import {
  FanModel,
  FanTip,
  MIN_SCREW_PIVOT,
  autoEyeThickness,
  bladeCount,
  bladeStepRad,
  fanLayout,
  fanOuterSize,
  fanPivot,
  hubDiameter,
  hubPlateThickness,
  overlapRadius,
  prepareFanImage,
  reliefStartRadius,
} from './model/fan'
import { greyLevels, imageFileToDataURL, TONE_REF_MU } from './model/relief'
import { Design, ObjectType, assertNever, toJSON } from './model/serialize'
import {
  export3MF,
  exportSTL,
  exportSTEP,
  exportBox3MF,
  exportBoxSTL,
  exportBoxSTEP,
  exportSkadisSTL,
  exportSkadis3MF,
  exportSkadisSTEP,
  exportLithoSTL,
  exportLitho3MF,
  exportFanSTL,
  exportFan3MF,
  downloadBlob,
} from './model/export'
import SaveMenu from './SaveMenu'

interface Props {
  design: Design
  setBin: (m: BinModel) => void
  setBox: (m: BoxModel) => void
  setSkadis: (m: SkadisModel) => void
  setLitho: (m: LithoModel) => void
  setFan: (m: FanModel) => void
  setType: (t: ObjectType) => void
  showBuildPlate: boolean
  setShowBuildPlate: (v: boolean) => void
  ready: boolean
  onLoad: (design: Design, name?: string) => void
  onNameChange: (name: string) => void
  currentName: string
}

let dividerSeq = 0

// The object-type switch, driven by data so a new type is one row here plus a
// case in the export/controls dispatch below (the compiler flags both via
// assertNever). "Box" covers both sliding and hinged lids — the lid style is a
// sub-choice inside BoxControls, not a top-level type.
const TYPE_TABS: { id: ObjectType; label: string }[] = [
  { id: 'bin', label: 'Bin' },
  { id: 'box', label: 'Box' },
  { id: 'skadis', label: 'Skadis' },
  { id: 'litho', label: 'Litho' },
  { id: 'fan', label: 'Fan' },
]

export default function Sidebar({
  design,
  setBin,
  setBox,
  setSkadis,
  setLitho,
  setFan,
  setType,
  showBuildPlate,
  setShowBuildPlate,
  ready,
  onLoad,
  onNameChange,
  currentName,
}: Props) {
  // Use the saved design name for export downloads, falling back to the type name.
  const baseName = () =>
    currentName.trim().replace(/[^a-z0-9-_]+/gi, '_') || design.type

  // The design metadata embedded in 3MF exports (a namespaced <metadata>
  // element): the same serialized Design envelope as the .json export, so the
  // exported model file is re-importable, not just self-describing. STL can't
  // carry it — a binary STL is exactly 84+tris*50 bytes and slicers reject any
  // trailing bytes (see export.ts).
  const metaJson = () => toJSON(design, currentName.trim() || undefined)

  // Bin → single .stl. Sliding box → .zip of box.stl + lid.stl. Hinged box →
  // one combined .stl (it's a single print-in-place assembly). exportBoxSTL
  // returns the right extension for the box case.
  const doExportSTL = () => {
    const base = baseName()
    switch (design.type) {
      case 'bin':
        downloadBlob(exportSTL(design.bin), `${base}.stl`)
        break
      case 'box': {
        const { blob, ext } = exportBoxSTL(design.box, base)
        downloadBlob(blob, `${base}.${ext}`)
        break
      }
      case 'skadis':
        downloadBlob(exportSkadisSTL(design.skadis), `${base}.stl`)
        break
      case 'litho':
        // The relief needs the decoded image in the cache (usually a no-op —
        // the viewport preview already decoded it).
        prepareLithoImage(design.litho).then(() =>
          downloadBlob(exportLithoSTL(design.litho), `${base}.stl`),
        )
        break
      case 'fan':
        // Every blade is a different part, but they all print together on one
        // plate — so the STL is the whole plate as one mesh (see export.ts).
        prepareFanImage(design.fan).then(() =>
          downloadBlob(exportFanSTL(design.fan), `${base}.stl`),
        )
        break
      default:
        assertNever(design.type)
    }
  }
  // 3MF supports multiple objects natively, so the box 3MF carries box + lid as
  // two separate objects in one file.
  const doExport3MF = () => {
    const base = baseName()
    const meta = metaJson()
    switch (design.type) {
      case 'bin':
        downloadBlob(export3MF(design.bin, meta), `${base}.3mf`)
        break
      case 'box':
        downloadBlob(exportBox3MF(design.box, meta), `${base}.3mf`)
        break
      case 'skadis':
        downloadBlob(exportSkadis3MF(design.skadis, meta), `${base}.3mf`)
        break
      case 'litho':
        prepareLithoImage(design.litho).then(() =>
          downloadBlob(exportLitho3MF(design.litho, meta), `${base}.3mf`),
        )
        break
      case 'fan':
        // One <object> per blade, in their plate positions.
        prepareFanImage(design.fan).then(() =>
          downloadBlob(exportFan3MF(design.fan, meta), `${base}.3mf`),
        )
        break
      default:
        assertNever(design.type)
    }
  }
  // STEP is a faceted B-rep (one solid per part). A box carries body + lid as
  // two solids in one .step, so — unlike STL — there's no zip for the box case.
  const doExportSTEP = () => {
    const base = baseName()
    switch (design.type) {
      case 'bin':
        downloadBlob(exportSTEP(design.bin), `${base}.step`)
        break
      case 'box':
        downloadBlob(exportBoxSTEP(design.box), `${base}.step`)
        break
      case 'skadis':
        downloadBlob(exportSkadisSTEP(design.skadis), `${base}.step`)
        break
      case 'litho':
      case 'fan':
        // No STEP for relief objects (the button is hidden): a faceted B-rep of
        // a ~200k-triangle relief would be enormous and useless in CAD.
        break
      default:
        assertNever(design.type)
    }
  }

  // Per-type controls panel. Each case owns its model + setter; assertNever makes
  // a new object type a compile error until it has a controls component here.
  const renderControls = () => {
    switch (design.type) {
      case 'bin':
        return (
          <BinControls
            model={design.bin}
            setModel={setBin}
            showBuildPlate={showBuildPlate}
            setShowBuildPlate={setShowBuildPlate}
          />
        )
      case 'box':
        return (
          <BoxControls
            model={design.box}
            setModel={setBox}
            showBuildPlate={showBuildPlate}
            setShowBuildPlate={setShowBuildPlate}
          />
        )
      case 'skadis':
        return (
          <SkadisControls
            model={design.skadis}
            setModel={setSkadis}
            showBuildPlate={showBuildPlate}
            setShowBuildPlate={setShowBuildPlate}
          />
        )
      case 'litho':
        return (
          <LithoControls
            model={design.litho}
            setModel={setLitho}
            showBuildPlate={showBuildPlate}
            setShowBuildPlate={setShowBuildPlate}
          />
        )
      case 'fan':
        return (
          <FanControls
            model={design.fan}
            setModel={setFan}
            showBuildPlate={showBuildPlate}
            setShowBuildPlate={setShowBuildPlate}
          />
        )
      default:
        return assertNever(design.type)
    }
  }

  return (
    <aside className="sidebar">
      <header className="sidebar-head">
        <div className="sidebar-head-top">
          <span className="logo">▦ Bin Builder</span>
          <SaveMenu
            design={design}
            onLoad={onLoad}
            onNameChange={onNameChange}
            currentName={currentName}
          />
        </div>

        {/* Object-type switch */}
        <div className="seg type-switch">
          {TYPE_TABS.map((t) => (
            <button
              key={t.id}
              className={design.type === t.id ? 'active' : ''}
              onClick={() => setType(t.id)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="export-group">
          <button
            className="btn primary"
            disabled={!ready}
            title="Download a watertight binary STL, ready to slice."
            onClick={doExportSTL}
          >
            Export STL
          </button>
          <button
            className="btn"
            disabled={!ready}
            title="Download a watertight 3MF package, ready to slice."
            onClick={doExport3MF}
          >
            Export 3MF
          </button>
          {design.type !== 'litho' && design.type !== 'fan' && (
            <button
              className="btn"
              disabled={!ready}
              title="Download a STEP file for CAD. Faceted B-rep solid — imports as a real body, but the faces are triangles (not editable as parametric surfaces)."
              onClick={doExportSTEP}
            >
              Export STEP
            </button>
          )}
        </div>
      </header>

      {renderControls()}
    </aside>
  )
}

// ---------- Bin controls ----------

function BinControls({
  model,
  setModel,
  showBuildPlate,
  setShowBuildPlate,
}: {
  model: BinModel
  setModel: (m: BinModel) => void
  showBuildPlate: boolean
  setShowBuildPlate: (v: boolean) => void
}) {
  const [inches, setInches] = useState(false)
  const patch = (p: Partial<BinModel>) => setModel({ ...model, ...p })
  const size = resolvedSize(model)
  const fmtLen = (mm: number) =>
    inches ? `${(mm / 25.4).toFixed(2)} in` : `${mm.toFixed(1)} mm`

  const addDivider = (axis: 'x' | 'y') =>
    patch({ dividers: [...model.dividers, { id: `d${dividerSeq++}`, axis, position: 0.5 }] })
  const updateDivider = (id: string, p: Partial<Divider>) =>
    patch({ dividers: model.dividers.map((d) => (d.id === id ? { ...d, ...p } : d)) })
  const removeDivider = (id: string) =>
    patch({ dividers: model.dividers.filter((d) => d.id !== id) })

  return (
    <>
      <Section title="Size" defaultOpen>
        <Toggle label="Gridfinity" checked={model.gridfinity}
          onChange={(v) => patch({ gridfinity: v })} />
        <p className="hint">
          {model.gridfinity
            ? 'Standard Gridfinity foot, baseplate clearance and magnet/screw sockets.'
            : 'Plain tray: flat bottom, no Gridfinity foot or sockets.'}
        </p>

        <Field label={model.gridfinity ? 'Grid unit size' : 'Cell size'}>
          <NumberInput value={model.gridUnit} min={10} max={80} step={1} unit="mm"
            onChange={(v) => patch({ gridUnit: v })} />
        </Field>

        {!model.customSize && (
          <>
            <UnitStepper label="X units" value={model.unitsX} onChange={(v) => patch({ unitsX: v })} />
            <UnitStepper label="Y units" value={model.unitsY} onChange={(v) => patch({ unitsY: v })} />
            <UnitStepper label="Z units" value={model.unitsZ} min={1} max={20}
              onChange={(v) => patch({ unitsZ: v })} />
          </>
        )}

        <Toggle label="Custom Size" checked={model.customSize}
          onChange={(v) => patch({ customSize: v, sizeX: size.x, sizeY: size.y, sizeZ: size.z })} />

        {model.customSize && (
          <>
            <Field label="Width (X)">
              <NumberInput value={model.sizeX} min={10} max={500} step={0.5} unit="mm"
                onChange={(v) => patch({ sizeX: v })} />
            </Field>
            <Field label="Depth (Y)">
              <NumberInput value={model.sizeY} min={10} max={500} step={0.5} unit="mm"
                onChange={(v) => patch({ sizeY: v })} />
            </Field>
            <Field label="Height (Z)">
              <NumberInput value={model.sizeZ} min={5} max={300} step={0.5} unit="mm"
                onChange={(v) => patch({ sizeZ: v })} />
            </Field>
          </>
        )}

        <Measurements size={size} fmtLen={fmtLen} inches={inches} setInches={setInches} />
      </Section>

      <Section title="General" defaultOpen>
        <Toggle label="Show Build Plate" checked={showBuildPlate} onChange={setShowBuildPlate} />
        {model.gridfinity && (
          <>
            <SegMessage label="Base magnets" value={model.magnets}
              onChange={(v) => patch({ magnets: v })} />
            <SegMessage label="Screw holes" value={model.screws}
              onChange={(v) => patch({ screws: v })} />
          </>
        )}
        <SegLip value={model.lip} onChange={(v) => patch({ lip: v })} />
        <Field label="Outer wall thickness">
          <NumberInput value={model.outerWall} min={0.4} max={5} step={0.1} unit="mm"
            onChange={(v) => patch({ outerWall: v })} />
        </Field>
        <Field label="Inner wall thickness">
          <NumberInput value={model.innerWall} min={0.4} max={5} step={0.1} unit="mm"
            onChange={(v) => patch({ innerWall: v })} />
        </Field>
      </Section>

      <Section title="Elements" defaultOpen>
        <Toggle label="Finger scoop" checked={model.scoop} onChange={(v) => patch({ scoop: v })} />
        <Toggle label="Label tab" checked={model.label} onChange={(v) => patch({ label: v })} />
        <div className="add-row">
          <button className="btn small" onClick={() => addDivider('x')}>+ Divider ↕</button>
          <button className="btn small" onClick={() => addDivider('y')}>+ Divider ↔</button>
        </div>
        {model.dividers.length === 0 && (
          <p className="hint">Add dividers to split the bin into compartments.</p>
        )}
        {model.dividers.map((d) => (
          <div className="divider-item" key={d.id}>
            <span className="divider-label">
              {d.axis === 'x' ? 'Vertical' : 'Horizontal'} divider
            </span>
            <input type="range" min={0.05} max={0.95} step={0.001} value={d.position}
              onChange={(e) => updateDivider(d.id, { position: +e.target.value })} />
            <span className="divider-pos">
              <CommittedInput value={d.position * 100} min={5} max={95} step={0.1}
                onCommit={(pct) => updateDivider(d.id, { position: pct / 100 })} />%
            </span>
            <button className="icon-btn" onClick={() => removeDivider(d.id)}>✕</button>
          </div>
        ))}
      </Section>
    </>
  )
}

// ---------- Sliding-box controls ----------

function BoxControls({
  model,
  setModel,
  showBuildPlate,
  setShowBuildPlate,
}: {
  model: BoxModel
  setModel: (m: BoxModel) => void
  showBuildPlate: boolean
  setShowBuildPlate: (v: boolean) => void
}) {
  const [inches, setInches] = useState(false)
  const patch = (p: Partial<BoxModel>) => setModel({ ...model, ...p })
  const fmtLen = (mm: number) =>
    inches ? `${(mm / 25.4).toFixed(2)} in` : `${mm.toFixed(1)} mm`

  const hinged = model.topType === 'hinged'

  // Textures: the lid top and the outer walls are independent specs. Which
  // rules apply to the lid depends on how it prints — the sliding lid face-up,
  // both hinged lids with the top against the plate (see texture.ts).
  const tex = model.texture
  const patchTex = (p: Partial<BoxTexture>) => patch({ texture: { ...tex, ...p } })
  const lidCtx: TextureContext = hinged ? 'bed-face' : 'top-up'
  const lidTex = resolveTexture(tex.top, lidCtx, model.lidThickness, tex.layerHeight)

  return (
    <>
      <Section title="Top type" defaultOpen>
        <div className="seg">
          <button className={!hinged ? 'active' : ''} onClick={() => patch({ topType: 'sliding' })}>
            Sliding lid
          </button>
          <button className={hinged ? 'active' : ''} onClick={() => patch({ topType: 'hinged' })}>
            Hinged lid
          </button>
        </div>
        {hinged && (
          <Field label="Hinge style">
            <div className="seg">
              <button
                className={model.hingeStyle !== 'top' ? 'active' : ''}
                onClick={() => patch({ hingeStyle: 'flat' })}
              >
                Fold-flat
              </button>
              <button
                className={model.hingeStyle === 'top' ? 'active' : ''}
                onClick={() => patch({ hingeStyle: 'top' })}
              >
                Snap-on top
              </button>
            </div>
          </Field>
        )}
        <p className="hint">
          {!hinged
            ? 'Sliding lid: slides into grooves in the side walls, inserts from the front.'
            : model.hingeStyle === 'top'
              ? 'Chest-style hinge at the top back edge. Box and lid print as two separate parts (lid top-side down); one press snaps the lid’s hinge clips onto the pin and the front bead into its groove.'
              : 'Print-in-place hinged lid: prints open & flat (box + lid joined at the back hinge). Folds closed with an overlapping lip + snap.'}
        </p>
      </Section>

      <Section title="Inner size" defaultOpen>
        <p className="hint">Dimensions are the usable interior cavity.</p>
        <Field label="Width (X)">
          <NumberInput value={model.innerW} min={10} max={400} step={0.5} unit="mm"
            onChange={(v) => patch({ innerW: v })} />
        </Field>
        <Field label="Depth (Y)">
          <NumberInput value={model.innerD} min={10} max={400} step={0.5} unit="mm"
            onChange={(v) => patch({ innerD: v })} />
        </Field>
        <Field label="Height (Z)">
          <NumberInput value={model.innerH} min={5} max={300} step={0.5} unit="mm"
            onChange={(v) => patch({ innerH: v })} />
        </Field>
        <Measurements
          size={{ x: model.innerW, y: model.innerD, z: model.innerH }}
          fmtLen={fmtLen} inches={inches} setInches={setInches}
        />
      </Section>

      <Section title="Construction" defaultOpen>
        <Toggle label="Show Build Plate" checked={showBuildPlate} onChange={setShowBuildPlate} />
        <Field label="Wall thickness">
          <NumberInput value={model.wall} min={1} max={6} step={0.1} unit="mm"
            onChange={(v) => patch({ wall: v })} />
        </Field>
        <Field label="Lid thickness">
          <NumberInput value={model.lidThickness} min={1} max={6} step={0.1} unit="mm"
            onChange={(v) => patch({ lidThickness: v })} />
        </Field>
        <Field label={hinged ? 'Hinge clearance (fit)' : 'Lid clearance (fit)'}>
          <NumberInput value={model.clearance} min={0} max={1} step={0.05} unit="mm"
            onChange={(v) => patch({ clearance: v })} />
        </Field>
        <p className="hint">
          {hinged
            ? 'Gap around the hinge pin/knuckles. 0.2–0.3mm is the sweet spot; too small fuses the hinge solid, too large is floppy.'
            : 'Smaller clearance = tighter slide. 0.2mm is a good starting point; increase if the lid binds.'}
        </p>
      </Section>

      <Section title="Lid texture" defaultOpen>
        <TextureControls
          spec={tex.top} onChange={(s) => patchTex({ top: s })}
          ctx={lidCtx} thickness={model.lidThickness} layerHeight={tex.layerHeight}
          ridgeLabels={['Side to side', 'Front to back']}
        />
        {tex.top.pattern !== 'none' && (
          <Field label="Slicer layer height">
            <NumberInput value={tex.layerHeight} min={0.04} max={0.4} step={0.02} unit="mm"
              onChange={(v) => patchTex({ layerHeight: v })} />
          </Field>
        )}
        <p className="hint">
          {lidCtx === 'top-up'
            ? `The sliding lid prints face-up, so the texture can be raised or recessed; heights snap to whole layers because the relief is the layer stack.${
                lidTex && lidTex.mode === 'emboss'
                  ? ` A raised pattern stands ${fmtNum(Math.max(0, lidTex.depth - model.clearance))} mm above the box rim.`
                  : ''
              }`
            : `${model.hingeStyle === 'top'
                ? 'The snap-on lid prints top-side down, so its top is the face on the build plate.'
                : 'The fold-flat lid prints face-down — this face becomes the top once folded closed.'} The texture is cut in as recesses the first layers skip and the layer above bridges: whole layers, no recess wider than ${TEXTURE.MAX_SPAN} mm, a ${TEXTURE.BORDER} mm solid border, and at least ${Math.round(TEXTURE.MIN_PLATEAU * 100)}% of the face left on the plate so it still sticks.${
                model.hingeStyle === 'top'
                  ? ''
                  : ' In the preview it is on the underside: hide the build plate and orbit below to see it.'
              }`}
        </p>
      </Section>

      <Section title="Side texture" defaultOpen>
        <TextureControls
          spec={tex.sides} onChange={(s) => patchTex({ sides: s })}
          ctx="wall" thickness={model.wall} layerHeight={tex.layerHeight}
          ridgeLabels={['Horizontal', 'Vertical']}
        />
        <p className="hint">
          {`Walls print vertical, so any pattern works raised or recessed (up to ${TEXTURE.MAX_WALL_DEPTH} mm). Kept ${TEXTURE.BORDER} mm from every edge${
            hinged
              ? ', below the band the lid’s lip wraps, and off the back wall where the hinge lives.'
              : ' and below the lid groove, where the channel leaves the outer wall thin.'
          }`}
        </p>
      </Section>
    </>
  )
}

// One texture spec: pattern / relief / depth / pitch / direction. The face's
// print context decides what is allowed, and the effective values in the hint
// come from the same resolveTexture() the builder uses, so they never disagree
// with the geometry.
function TextureControls({ spec, onChange, ctx, thickness, layerHeight, ridgeLabels }: {
  spec: TextureSpec
  onChange: (s: TextureSpec) => void
  ctx: TextureContext
  thickness: number
  layerHeight: number
  ridgeLabels: [string, string]
}) {
  const patch = (p: Partial<TextureSpec>) => onChange({ ...spec, ...p })
  const bedFace = ctx === 'bed-face'
  const mode: TextureMode = bedFace ? 'deboss' : spec.mode
  const snaps = ctx !== 'wall' // horizontal faces: depth in whole layers
  const maxDepth = textureDepthLimit(ctx, mode, thickness)
  const minDepth = snaps ? layerHeight : TEXTURE.MIN_DEPTH
  const active = spec.pattern !== 'none'
  const resolved = resolveTexture(spec, ctx, thickness, layerHeight)

  return (
    <>
      <div className="seg">
        {TEXTURE_PATTERNS.map((p) => (
          <button
            key={p}
            className={spec.pattern === p ? 'active' : ''}
            onClick={() => patch({ pattern: p, pitch: Math.max(spec.pitch, minPitch(p)) })}
          >
            {p === 'none' ? 'None' : PATTERNS[p].label}
          </button>
        ))}
      </div>
      {active && maxDepth < minDepth - 1e-9 && (
        <p className="hint">
          Too thin to texture: a {fmtNum(minDepth)} mm cut needs more than{' '}
          {fmtNum(ctx === 'wall' ? TEXTURE.MIN_WALL_REMAINING : TEXTURE.MIN_LID_REMAINING)} mm left behind it.
        </p>
      )}
      {active && maxDepth >= minDepth - 1e-9 && (
        <>
          {!bedFace && (
            <Field label="Relief">
              <div className="seg">
                <button className={mode === 'emboss' ? 'active' : ''} onClick={() => patch({ mode: 'emboss' })}>
                  Raised
                </button>
                <button className={mode === 'deboss' ? 'active' : ''} onClick={() => patch({ mode: 'deboss' })}>
                  Recessed
                </button>
              </div>
            </Field>
          )}
          <Field label={mode === 'emboss' ? 'Height' : 'Depth'}>
            <NumberInput value={clamp(spec.depth, minDepth, maxDepth)} min={minDepth} max={maxDepth}
              step={snaps ? layerHeight : 0.1} unit="mm" onChange={(v) => patch({ depth: v })} />
          </Field>
          <Field label="Spacing (pitch)">
            <NumberInput value={spec.pitch} min={minPitch(spec.pattern)} max={TEXTURE.MAX_PITCH} step={0.5}
              unit="mm" onChange={(v) => patch({ pitch: v })} />
          </Field>
          {spec.pattern === 'ridges' && (
            <Field label="Direction">
              <div className="seg">
                <button className={spec.angle === 0 ? 'active' : ''} onClick={() => patch({ angle: 0 })}>
                  {ridgeLabels[0]}
                </button>
                <button className={spec.angle === 90 ? 'active' : ''} onClick={() => patch({ angle: 90 })}>
                  {ridgeLabels[1]}
                </button>
              </div>
            </Field>
          )}
          {resolved && <p className="hint">{describeTexture(resolved)}</p>}
        </>
      )}
    </>
  )
}

function describeTexture(r: ResolvedTexture): string {
  const f = fmtNum(r.feature)
  const gap = fmtNum(r.pitch - r.feature)
  const raised = r.mode === 'emboss'
  const what =
    r.pattern === 'ridges' ? `${f} mm ${raised ? 'ridges' : 'grooves'} with ${gap} mm flats between`
    : r.pattern === 'knurl' ? `${f} mm ${raised ? 'bars' : 'grooves'} crossed at 45°, ${fmtNum(r.pitch)} mm apart`
    : r.pattern === 'hex' ? `${f} mm hexagonal ${raised ? 'bosses' : 'pockets'} with ${gap} mm walls`
    : `${f} mm ${raised ? 'studs' : 'dimples'}, ${gap} mm apart`
  const layers = r.layers === null ? '' : ` (${r.layers} layer${r.layers === 1 ? '' : 's'})`
  return `${what}, ${fmtNum(r.depth)} mm ${raised ? 'high' : 'deep'}${layers}. ${Math.round(r.plateau * 100)}% of the face stays flat.`
}

// ---------- Skadis-holder controls ----------

function SkadisControls({
  model,
  setModel,
  showBuildPlate,
  setShowBuildPlate,
}: {
  model: SkadisModel
  setModel: (m: SkadisModel) => void
  showBuildPlate: boolean
  setShowBuildPlate: (v: boolean) => void
}) {
  const [inches, setInches] = useState(false)
  const patch = (p: Partial<SkadisModel>) => setModel({ ...model, ...p })
  const fmtLen = (mm: number) =>
    inches ? `${(mm / 25.4).toFixed(2)} in` : `${mm.toFixed(1)} mm`

  const shapes: { id: HolderShape; label: string }[] = [
    { id: 'rect', label: 'Rectangle' },
    { id: 'round', label: 'Round' },
  ]
  const hooks: { id: HookStyle; label: string }[] = [
    { id: 'peg', label: 'Peg' },
    { id: 'snap', label: 'Snap' },
    { id: 'clip', label: 'Clip' },
  ]
  // Ordered as seen looking at the holder from the front (the back is the
  // pegboard side, so it can't open).
  const sides: { id: OpeningSide; label: string }[] = [
    { id: 'left', label: 'Left' },
    { id: 'front', label: 'Front' },
    { id: 'right', label: 'Right' },
  ]
  const openMax = maxOpeningDeg(model.openingSide)
  const open = model.bottom === 'open'

  return (
    <>
      <Section title="Shape" defaultOpen>
        <div className="seg">
          {shapes.map((s) => (
            <button
              key={s.id}
              className={model.shape === s.id ? 'active' : ''}
              onClick={() => patch({ shape: s.id })}
            >
              {s.label}
            </button>
          ))}
        </div>
        <p className="hint">
          Clips onto an IKEA Skadis pegboard (40mm hole grid) via print-in-place back hooks.
        </p>
      </Section>

      <Section title="Size" defaultOpen>
        <Field label={model.shape === 'round' ? 'Width / diameter (X)' : 'Width (X)'}>
          <NumberInput value={model.width} min={15} max={300} step={0.5} unit="mm"
            onChange={(v) => patch({ width: v })} />
        </Field>
        <Field label={model.shape === 'round' ? 'Depth / diameter (Z)' : 'Depth (Z)'}>
          <NumberInput value={model.depth} min={15} max={300} step={0.5} unit="mm"
            onChange={(v) => patch({ depth: v })} />
        </Field>
        <Field label="Height (Y)">
          <NumberInput value={model.height} min={15} max={300} step={0.5} unit="mm"
            onChange={(v) => patch({ height: v })} />
        </Field>
        {model.shape === 'rect' && (
          <Field label="Corner radius (0 = sharp)">
            <NumberInput value={model.cornerRadius} min={0} max={60} step={0.5} unit="mm"
              onChange={(v) => patch({ cornerRadius: v })} />
          </Field>
        )}
        <Field label="Taper (base size)">
          <NumberInput value={model.taper} min={30} max={100} step={1} unit="%"
            onChange={(v) => patch({ taper: v })} />
        </Field>
        <p className="hint">
          100% = straight walls; lower narrows the base (a tapered cup). The mouth stays full size.
        </p>
        <Measurements
          size={{ x: model.width, y: model.height, z: model.depth }}
          fmtLen={fmtLen} inches={inches} setInches={setInches}
        />
      </Section>

      <Section title="Opening" defaultOpen>
        <div className="seg">
          {sides.map((s) => (
            <button
              key={s.id}
              className={model.openingSide === s.id ? 'active' : ''}
              // Side openings allow a smaller angle than the front, so trim the
              // current angle to fit rather than letting it silently clamp.
              onClick={() =>
                patch({ openingSide: s.id, openingDeg: Math.min(model.openingDeg, maxOpeningDeg(s.id)) })
              }
            >
              {s.label}
            </button>
          ))}
        </div>
        <Field label="Opening angle">
          <NumberInput value={model.openingDeg} min={0} max={openMax} step={5} unit="°"
            onChange={(v) => patch({ openingDeg: v })} />
        </Field>
        <p className="hint">
          0° = fully enclosed. Larger snips that much out of the chosen wall — a clean arc on round
          shapes, a V-notch on rectangular ones. The floor stays whole.
          {model.openingSide !== 'front' &&
            ` Side openings cap at ${openMax}° so the cut stays clear of the pegboard mount at the back.`}
        </p>
      </Section>

      <Section title="Bottom" defaultOpen>
        <div className="seg">
          <button className={!open ? 'active' : ''} onClick={() => patch({ bottom: 'full' })}>
            Closed
          </button>
          <button className={open ? 'active' : ''} onClick={() => patch({ bottom: 'open' })}>
            Open
          </button>
        </div>
        {open && (
          <Field label="Support lip">
            <NumberInput value={model.supportLip} min={0} max={40} step={0.5} unit="mm"
              onChange={(v) => patch({ supportLip: v })} />
          </Field>
        )}
        <p className="hint">
          {open
            ? 'Open floor with an inward rim shelf of this width to support what it holds.'
            : 'Solid floor.'}
        </p>
      </Section>

      <Section title="Mount" defaultOpen>
        <div className="seg-head">
          <span>Hook style</span>
          <InfoDot
            text={
              <>
                <b>Peg</b> — a peg that friction-fits the slot. Lightest hold, lifts straight off,
                simplest to print.<br />
                <b>Snap</b> — peg plus a catch that drops behind the solid board below the slot. A
                positive everyday hold; easy on and off.<br />
                <b>Clip</b> — like Snap but the catch drops deeper and grips the board back snugly for
                the strongest, most positive lock.<br />
                All three print upright and seat flush; the hook fit is tuned by the clearance below.
              </>
            }
          />
        </div>
        <div className="seg">
          {hooks.map((h) => (
            <button
              key={h.id}
              className={model.hookStyle === h.id ? 'active' : ''}
              onClick={() => patch({ hookStyle: h.id })}
            >
              {h.label}
            </button>
          ))}
        </div>
        <p className="hint">
          {model.hookStyle === 'peg'
            ? 'Friction peg: lightest hold, lifts straight off. Best for light items.'
            : model.hookStyle === 'snap'
              ? 'Snap hook: catch behind the board below the slot. Solid everyday hold, easy on/off.'
              : 'Wrap clip: deeper, snug catch for the strongest, most positive hold.'}
        </p>
      </Section>

      <Section title="Construction" defaultOpen>
        <Toggle label="Show Build Plate" checked={showBuildPlate} onChange={setShowBuildPlate} />
        <Field label="Wall thickness">
          <NumberInput value={model.wall} min={1} max={6} step={0.1} unit="mm"
            onChange={(v) => patch({ wall: v })} />
        </Field>
        <Field label="Hook fit (clearance)">
          <NumberInput value={model.clearance} min={0} max={1} step={0.05} unit="mm"
            onChange={(v) => patch({ clearance: v })} />
        </Field>
        <p className="hint">
          Gap on the pegboard hooks. 0.2–0.4mm is typical; increase if the hooks won't seat.
        </p>
      </Section>
    </>
  )
}

// ---------- Lithophane controls ----------

function LithoControls({
  model,
  setModel,
  showBuildPlate,
  setShowBuildPlate,
}: {
  model: LithoModel
  setModel: (m: LithoModel) => void
  showBuildPlate: boolean
  setShowBuildPlate: (v: boolean) => void
}) {
  const [inches, setInches] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const patch = (p: Partial<LithoModel>) => setModel({ ...model, ...p })
  const fmtLen = (mm: number) =>
    inches ? `${(mm / 25.4).toFixed(2)} in` : `${mm.toFixed(1)} mm`

  const round = model.shape === 'round'
  const flat = model.orientation === 'flat'
  const shapes: { id: LithoShape; label: string }[] = [
    { id: 'rect', label: 'Rectangle' },
    { id: 'round', label: 'Round' },
  ]

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const { dataUrl, width: iw, height: ih } = await imageFileToDataURL(file)
      const p: Partial<LithoModel> = { image: dataUrl }
      // Match the rect panel's aspect to the picture so nothing gets cropped.
      if (model.shape === 'rect') p.height = clamp(model.width * (ih / iw), 20, 300)
      patch(p)
    } catch {
      // unreadable file — leave the model unchanged
    }
    e.target.value = '' // allow re-uploading the same file
  }

  return (
    <>
      <Section title="Image" defaultOpen>
        <div className="litho-upload">
          <button className="btn small" onClick={() => fileRef.current?.click()}>
            {model.image ? 'Replace image…' : 'Upload image…'}
          </button>
          {model.image && (
            <button className="btn small" onClick={() => patch({ image: null })}>
              Remove
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={onFile}
          />
        </div>
        {model.image ? (
          <img className="litho-preview" src={model.image} alt="lithophane source" />
        ) : (
          <p className="hint">
            Upload a photo to emboss. Until then the panel previews at a uniform mid thickness.
          </p>
        )}
        <Toggle label="Invert (negative)" checked={model.invert}
          onChange={(v) => patch({ invert: v })} />
        <p className="hint">
          Dark areas print thick, light areas thin — backlight the print to reveal the picture.
          The image covers the panel and any aspect-ratio overflow is cropped.
        </p>
        <p className="hint">
          <b>Pick a high-contrast photo.</b> The whole picture has to fit in{' '}
          {greyLevels(model.minThickness, model.maxThickness, model.layerHeight)} printable grey
          levels, so a bright, evenly-lit shot comes out flat and muddy no matter how the relief is
          tuned. What works is real blacks against real highlights — a lit subject on a dark
          background is close to ideal. Crop tight before uploading, and raise the contrast in a
          photo editor first if it looks washed out here.
        </p>
      </Section>

      <Section title="Shape & size" defaultOpen>
        <div className="seg">
          {shapes.map((s) => (
            <button
              key={s.id}
              className={model.shape === s.id ? 'active' : ''}
              onClick={() => patch({ shape: s.id })}
            >
              {s.label}
            </button>
          ))}
        </div>
        <Field label={round ? 'Diameter' : 'Width (X)'}>
          <NumberInput value={model.width} min={20} max={300} step={1} unit="mm"
            onChange={(v) => patch({ width: v })} />
        </Field>
        {!round && (
          <>
            <Field label="Height (Y)">
              <NumberInput value={model.height} min={20} max={300} step={1} unit="mm"
                onChange={(v) => patch({ height: v })} />
            </Field>
            <Field label="Corner radius (0 = sharp)">
              <NumberInput value={model.cornerRadius} min={0} max={40} step={0.5} unit="mm"
                onChange={(v) => patch({ cornerRadius: v })} />
            </Field>
          </>
        )}
        {round && (
          <p className="hint">
            The bottom gets a small flat so the disc can stand on the print bed.
          </p>
        )}
        <Measurements
          size={{ x: model.width, y: panelHeight(model), z: model.maxThickness }}
          fmtLen={fmtLen} inches={inches} setInches={setInches}
        />
      </Section>

      <Section title="Relief" defaultOpen>
        <Field label="Min thickness (lightest)">
          <NumberInput value={model.minThickness} min={0.4} max={3} step={0.1} unit="mm"
            onChange={(v) => patch({ minThickness: v })} />
        </Field>
        <Field label="Max thickness (darkest)">
          <NumberInput value={model.maxThickness} min={1} max={8} step={0.1} unit="mm"
            onChange={(v) => patch({ maxThickness: v })} />
        </Field>
        <Field label="Detail (sample size)">
          <NumberInput value={model.pitch} min={0.2} max={1} step={0.05} unit="mm"
            onChange={(v) => patch({ pitch: v })} />
        </Field>
        <ToneControl value={model.tone} onChange={(v) => patch({ tone: v })} />
        <p className="hint">
          0.8 / 3.0 mm is the classic range for translucent filament. Smaller samples mean finer
          detail but a heavier model; very large panels cap the effective detail automatically.
        </p>
      </Section>

      <Section title="Print orientation" defaultOpen>
        <div className="seg">
          <button className={flat ? 'active' : ''} onClick={() => patch({ orientation: 'flat' })}>
            Flat
          </button>
          <button
            className={!flat ? 'active' : ''}
            onClick={() => patch({ orientation: 'standing' })}
          >
            Standing
          </button>
        </div>
        <p className="hint">
          {flat
            ? `Exported lying on its back with the relief up — already oriented, don’t rotate it in the slicer. Only ${Math.ceil(model.maxThickness / model.layerHeight)} layers tall, so it prints fast with no brim and no overhangs.`
            : `Exported standing on its bottom edge. The slicer varies wall width across the panel, so tone is continuous and vertical detail gets the layer height — but it’s ${Math.ceil(panelHeight(model) / model.layerHeight)} layers of a thin upright part: use a brim.`}
        </p>

        {flat && (
          <>
            <Field label="Slicer layer height">
              <NumberInput value={model.layerHeight} min={0.04} max={0.4} step={0.02} unit="mm"
                onChange={(v) => patch({ layerHeight: v })} />
            </Field>
            <Toggle label="Dither (smooth gradients)" checked={model.dither}
              onChange={(v) => patch({ dither: v })} />
            <p className="hint">
              Flat, brightness is the layer stack, so this range gives only{' '}
              <b>
                {greyLevels(model.minThickness, model.maxThickness, model.layerHeight)} grey levels
              </b>{' '}
              at {model.layerHeight}mm layers.{' '}
              {model.dither
                ? 'Dithering picks the nearest printable level per sample and pushes the rounding error into its neighbours, so the local average still tracks the photo — halftone printing, applied to height. Set this to match your slicer. The preview looks grainy up close, which is the point: backlit, the eye averages the halftone into smooth tone instead of reading hard contour lines.'
                : 'Without dithering, every gradient crossing a level boundary prints as a hard contour line. Turn it on unless you want the raw stepped relief.'}
            </p>
          </>
        )}
      </Section>

      <Section title="Mounting" defaultOpen>
        <Toggle label="Hanging hole" checked={model.mountHole}
          onChange={(v) => patch({ mountHole: v })} />
        {model.mountHole && (
          <Field label="Hole diameter">
            <NumberInput value={model.mountHoleDiameter} min={2} max={12} step={0.5} unit="mm"
              onChange={(v) => patch({ mountHoleDiameter: v })} />
          </Field>
        )}
        <p className="hint">
          {model.mountHole
            ? 'A through-hole centred near the top edge, for a nail or cord.'
            : 'Optional through-hole near the top edge for hanging.'}
        </p>
      </Section>

      <Section title="General" defaultOpen>
        <Toggle label="Show Build Plate" checked={showBuildPlate} onChange={setShowBuildPlate} />
        <p className="hint">
          The preview shows the print orientation chosen above, and the exported file matches it.
        </p>
      </Section>
    </>
  )
}

// ---------- Lithophane-fan controls ----------

function FanControls({
  model,
  setModel,
  showBuildPlate,
  setShowBuildPlate,
}: {
  model: FanModel
  setModel: (m: FanModel) => void
  showBuildPlate: boolean
  setShowBuildPlate: (v: boolean) => void
}) {
  const [inches, setInches] = useState(false)
  const fileRef = useRef<HTMLInputElement>(null)
  const patch = (p: Partial<FanModel>) => setModel({ ...model, ...p })
  const fmtLen = (mm: number) =>
    inches ? `${(mm / 25.4).toFixed(2)} in` : `${mm.toFixed(1)} mm`

  const assembled = model.preview === 'assembled'
  const screw = model.pivotStyle === 'screw'
  const pv = fanPivot(model)
  const plate = hubPlateThickness(model)
  const autoEye = autoEyeThickness(model)
  const eyeOverride = model.hubThickness > autoEye + 1e-6
  const n = bladeCount(model)
  const size = fanOuterSize(model)
  const layout = fanLayout(model)
  const stepDeg = (bladeStepRad(model) * 180) / Math.PI
  const overlap = overlapRadius(model)
  const reliefStart = reliefStartRadius(model)
  const tips: { id: FanTip; label: string }[] = [
    { id: 'petal', label: 'Petal' },
    { id: 'point', label: 'Pointed' },
    { id: 'round', label: 'Round' },
  ]

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const { dataUrl } = await imageFileToDataURL(file)
      // Start a new picture centred and just covering the fan, so it's framed
      // before the position controls are touched.
      patch({ image: dataUrl, imageZoom: 100, imageOffsetX: 0, imageOffsetY: 0 })
    } catch {
      // unreadable file — leave the model unchanged
    }
    e.target.value = '' // allow re-uploading the same file
  }

  return (
    <>
      <Section title="Photo" defaultOpen>
        <div className="litho-upload">
          <button className="btn small" onClick={() => fileRef.current?.click()}>
            {model.image ? 'Replace photo…' : 'Upload photo…'}
          </button>
          {model.image && (
            <button className="btn small" onClick={() => patch({ image: null })}>
              Remove
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            style={{ display: 'none' }}
            onChange={onFile}
          />
        </div>
        {model.image ? (
          <img className="litho-preview" src={model.image} alt="fan source photo" />
        ) : (
          <p className="hint">
            Upload a photo to spread across the open fan. Until then every blade previews at a
            uniform mid thickness.
          </p>
        )}
        <Toggle label="Invert (negative)" checked={model.invert}
          onChange={(v) => patch({ invert: v })} />
        <p className="hint">
          One picture spans the whole fan: each blade carries the slice of the photo that lands
          under it when the fan is open. Dark areas print thick, light areas thin — backlight the
          fan to reveal the picture.
        </p>
        <p className="hint">
          <b>Pick a high-contrast photo.</b> The whole picture has to fit in{' '}
          {greyLevels(model.minThickness, model.maxThickness, model.layerHeight)} printable grey
          levels, so a bright, evenly-lit shot comes out flat and muddy no matter how the relief is
          tuned. What works is real blacks against real highlights — a lit subject on a dark
          background is close to ideal. Crop tight before uploading, and raise the contrast in a
          photo editor first if it looks washed out here.
        </p>
      </Section>

      <Section title="Position on the fan" defaultOpen>
        <Field label="Zoom">
          <NumberInput value={model.imageZoom} min={25} max={400} step={5} unit="%"
            onChange={(v) => patch({ imageZoom: v })} />
        </Field>
        <Field label="Move across (X)">
          <NumberInput value={model.imageOffsetX} min={-200} max={200} step={1} unit="mm"
            onChange={(v) => patch({ imageOffsetX: v })} />
        </Field>
        <Field label="Move up / down (Y)">
          <NumberInput value={model.imageOffsetY} min={-200} max={200} step={1} unit="mm"
            onChange={(v) => patch({ imageOffsetY: v })} />
        </Field>
        <div className="add-row">
          <button
            className="btn small"
            onClick={() => patch({ imageZoom: 100, imageOffsetX: 0, imageOffsetY: 0 })}
          >
            Reset framing
          </button>
        </div>
        <p className="hint">
          The photo is placed over the <b>open fan</b>, so watch the Assembled view while you move
          it. 100% zoom just covers the fan{model.imageZoom < 100 && ', so at this zoom the blades outside the picture come out at their thinnest (a bright margin)'}
          . Zoom in to crop to faces; move it to pick what lands on the blades.
        </p>
      </Section>

      <Section title="Fan" defaultOpen>
        <Field label="View">
          <div className="seg">
            <button className={assembled ? 'active' : ''}
              onClick={() => patch({ preview: 'assembled' })}>
              Assembled
            </button>
            <button className={!assembled ? 'active' : ''}
              onClick={() => patch({ preview: 'flat' })}>
              Print layout
            </button>
          </div>
        </Field>
        <p className="hint">
          Preview only — the export is always the print layout, since a blade has one sensible
          print pose (flat on its back, relief up).
        </p>
        <UnitStepper label="Blades" value={n} min={1} max={24}
          onChange={(v) => patch({ blades: v })} />
        <Field label="Open angle (spread)">
          <NumberInput value={model.spreadDeg} min={20} max={300} step={5} unit="°"
            onChange={(v) => patch({ spreadDeg: v })} />
        </Field>
        <p className="hint">
          {n < 2
            ? 'A single blade — add more to make a fan.'
            : `${n} blades ${stepDeg.toFixed(1)}° apart across ${model.spreadDeg}°.`}
        </p>
        <Measurements size={size} fmtLen={fmtLen} inches={inches} setInches={setInches} />
      </Section>

      <Section title="Blade shape" defaultOpen>
        <div className="seg">
          {tips.map((t) => (
            <button key={t.id} className={model.tip === t.id ? 'active' : ''}
              onClick={() => patch({ tip: t.id })}>
              {t.label}
            </button>
          ))}
        </div>
        <Field label="Length (pivot to tip)">
          <NumberInput value={model.bladeLength} min={30} max={250} step={1} unit="mm"
            onChange={(v) => patch({ bladeLength: v })} />
        </Field>
        <Field label="Width (widest)">
          <NumberInput value={model.bladeWidth} min={8} max={80} step={0.5} unit="mm"
            onChange={(v) => patch({ bladeWidth: v })} />
        </Field>
        <Field label="Neck width (at the pivot)">
          <NumberInput value={model.neckWidth} min={6} max={60} step={0.5} unit="mm"
            onChange={(v) => patch({ neckWidth: v })} />
        </Field>
        <Field label="Neck length">
          <NumberInput value={model.neckLength} min={5} max={150} step={1} unit="mm"
            onChange={(v) => patch({ neckLength: v })} />
        </Field>
        <p className="hint">
          Blades are widest in the middle and narrow to a neck at the pivot, so they can fan out
          without their hubs fighting. Spans are re-fitted to each other, so a short blade won't
          produce a broken outline.
        </p>
      </Section>

      <Section title="Pivot" defaultOpen>
        <div className="seg">
          <button className={screw ? 'active' : ''}
            onClick={() => patch({ pivotStyle: 'screw',
              pivotDiameter: Math.max(model.pivotDiameter, MIN_SCREW_PIVOT) })}>
            Printed screw
          </button>
          <button className={!screw ? 'active' : ''}
            onClick={() => patch({ pivotStyle: 'hole' })}>
            Plain hole
          </button>
        </div>
        <p className="hint">
          {screw
            ? `A two-part barrel post and screw print alongside the blades — the printed equivalent of a Chicago screw. The barrel threads the blade holes and the screw tightens into it from the far side, and because the barrel is what the screw bottoms out against, tightening it hard can’t seize the fan: the blades always keep turning.`
            : 'Just a hole through the eye — bring your own M3 screw, washer and nut. Use a shouldered screw or a spacer, or tightening the nut will clamp the fan shut.'}
        </p>
        <Field label={screw ? 'Pivot hole (sets the screw size)' : 'Pivot hole'}>
          <NumberInput value={model.pivotDiameter} min={screw ? MIN_SCREW_PIVOT : 0} max={14}
            step={0.2} unit="mm" onChange={(v) => patch({ pivotDiameter: v })} />
        </Field>
        {screw && pv && (
          <p className="hint">
            {`Barrel ${fmtNum(pv.barrelOD)} mm through the blades, with a ${fmtNum(pv.thread.majorD)} mm thread at ${fmtNum(pv.thread.pitch)} mm pitch inside it — coarse on purpose, and its own profile rather than a metric one, because a standard fine pitch here gives teeth a nozzle can’t resolve. Barrel ${fmtNum(pv.barrelLen)} mm long for a ${fmtNum(pv.stackH)} mm stack, so the assembled hub is ${fmtNum(pv.totalH)} mm thick and the screw takes ${fmtNum(pv.threadLen)} mm of thread. The hole can’t go below ${fmtNum(MIN_SCREW_PIVOT)} mm — the thread has to fit inside the barrel and still print.`}
          </p>
        )}
        <Toggle label="Thicker eye for strength" checked={eyeOverride}
          onChange={(v) => patch({ hubThickness: v ? +(autoEye + 0.6).toFixed(2) : 0 })} />
        {eyeOverride && (
          <Field label="Eye plate thickness">
            <NumberInput value={model.hubThickness} min={autoEye} max={8} step={0.1} unit="mm"
              onChange={(v) => patch({ hubThickness: v })} />
          </Field>
        )}
        <Toggle label="Leave the overlapping inner zone plain" checked={model.clearOverlap}
          onChange={(v) => patch({ clearOverlap: v })} />
        <p className="hint">
          {`The eye around the pivot is left flat and untextured so the blades stack cleanly and turn. Because they sit eye-to-eye, that thickness is also the gap between blades — so it can never be thinner than the relief, or a blade’s picture jams into the back of the next one where they overlap and the fan won’t fold. It tracks the relief automatically (${fmtNum(autoEye)} mm right now); to thin the blade, thin the relief. Turn this on only to make the eye deliberately thicker.${
            eyeOverride ? ` Set to ${fmtNum(plate)} mm, ${fmtNum(plate - autoEye)} mm above the minimum.` : ''
          } The eye is ${fmtNum(hubDiameter(model))} mm across, sized to keep material round the hole.`}
        </p>
        <p className="hint">
          {n < 2
            ? 'With one blade there is nothing to overlap.'
            : `Blades have to overlap to fold, here out to ${fmtNum(overlap)} mm from the pivot — and backlight crosses every blade in the stack, so that inner zone always reads darker than the photo asks for. ${
                model.clearOverlap
                  ? `Left plain: the picture starts at ${fmtNum(reliefStart)} mm and the inner fan is bare. Note it only lines up at ${model.spreadDeg}° — open the fan wider and the bare zone shows.`
                  : `The picture still covers the whole blade (from ${fmtNum(reliefStart)} mm out), so it reads however far the fan is opened; the inner zone just comes out dark. Turn this on for a deliberately plain inner fan instead.`
              }`}
        </p>
      </Section>

      <Section title="Relief" defaultOpen>
        <Field label="Min thickness (lightest)">
          <NumberInput value={model.minThickness} min={0.3} max={3} step={0.1} unit="mm"
            onChange={(v) => patch({ minThickness: v })} />
        </Field>
        <Field label="Max thickness (darkest)">
          <NumberInput value={model.maxThickness} min={1} max={8} step={0.1} unit="mm"
            onChange={(v) => patch({ maxThickness: v })} />
        </Field>
        <Field label="Detail (sample size)">
          <NumberInput value={model.pitch} min={0.2} max={1} step={0.05} unit="mm"
            onChange={(v) => patch({ pitch: v })} />
        </Field>
        <ToneControl value={model.tone} onChange={(v) => patch({ tone: v })} />
        <Field label="Slicer layer height">
          <NumberInput value={model.layerHeight} min={0.04} max={0.4} step={0.02} unit="mm"
            onChange={(v) => patch({ layerHeight: v })} />
        </Field>
        <Toggle label="Dither (smooth gradients)" checked={model.dither}
          onChange={(v) => patch({ dither: v })} />
        <p className="hint">
          {`This range is what sets how thick a blade is: ${fmtNum(plate)} mm${
            eyeOverride ? ' (held there by the thicker eye below)' : ` — the ${fmtNum(model.maxThickness)} mm darkest point plus the clearance the next blade in the stack needs`
          }, so the hub stacks to ${fmtNum(n * plate)} mm. Thinning the blade costs contrast, and that is the real trade here: light falls off as e^(-μt), so all the picture can show is set by the ${fmtNum(model.maxThickness - model.minThickness)} mm GAP between the two — ${(Math.exp(TONE_REF_MU * (model.maxThickness - model.minThickness))).toFixed(1)}:1 between lightest and darkest, about ${(Math.log2(Math.exp(TONE_REF_MU * (model.maxThickness - model.minThickness)))).toFixed(1)} stops. Scaling both ends down keeps their ratio but halves the picture.`}
        </p>
        <p className="hint">
          Blades print flat, so brightness is the layer stack and this range gives only{' '}
          <b>{greyLevels(model.minThickness, model.maxThickness, model.layerHeight)} grey levels</b>{' '}
          at {model.layerHeight}mm layers.{' '}
          {model.dither
            ? 'Dithering picks the nearest printable level per sample and pushes the rounding error into its neighbours, so local averages still track the photo. The preview looks grainy up close, which is the point: backlit, the eye averages it into smooth tone.'
            : 'Without dithering, every gradient crossing a level boundary prints as a hard contour line.'}{' '}
          {`Layer height is the strongest lever you have here — halving it doubles the levels for no extra thickness, and a ${fmtNum(plate)} mm blade is only ${Math.ceil(plate / model.layerHeight)} layers, so it costs very little time. Reach for that before adding thickness. The sample budget is shared across all ${n} blades, so adding blades coarsens the detail.`}
        </p>
      </Section>

      <Section title="General" defaultOpen>
        <Toggle label="Show Build Plate" checked={showBuildPlate} onChange={setShowBuildPlate} />
        <p className="hint">
          {`Exported as ${n + (pv ? 2 : 0)} parts — ${n} blade${n === 1 ? '' : 's'}${pv ? ' plus the post and screw' : ''} — laid out ${layout.cols} × ${layout.rows} on the plate (${fmtNum(layout.w)} × ${fmtNum(layout.h)} mm). Blades lie flat on their backs with the relief up${pv ? `, and the two pivot parts stand on their thread axis, ${fmtNum(pv.flangeT + pv.barrelLen)} mm tall` : ''} — already oriented, don’t rotate anything in the slicer. 3MF keeps every part as a separate object; the STL is the whole plate as one mesh.`}
        </p>
        {pv && (
          <p className="hint">
            Print the pivot parts at the same layer height as everything else, no supports needed —
            the thread flanks are self-supporting with the axis vertical, which is why they are
            exported standing while the blades lie down. Assemble by stacking the blades on the
            barrel and threading the screw in from the top.
          </p>
        )}
      </Section>
    </>
  )
}

// Tone correction, shared by the lithophane panel and the fan. Both map the
// photo's luminance to thickness through the same curve, so the control and its
// explanation live in one place.
function ToneControl({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <>
      <div className="seg-head">
        <span>Tone correction</span>
        <InfoDot
          text={
            <>
              Light through plastic falls off <b>exponentially</b> with thickness, so a straight
              thickness ramp does not print as a straight brightness ramp — it crushes the shadows
              together and flattens the midtones. This bends the curve the other way, picking the
              thickness whose transmission lands where the photo wants it.<br />
              <b>0%</b> — no correction: raw linear thickness.<br />
              <b>100%</b> — matched to white PLA.<br />
              <b>More</b> — for denser or darker filament, or if the print still looks flat.
            </>
          }
        />
      </div>
      <NumberInput value={value} min={0} max={300} step={5} unit="%" onChange={onChange} />
      <p className="hint">
        {value === 0
          ? 'Off — thickness ramps linearly with brightness, which prints muddy: most of the range is spent on shadows that are already nearly opaque.'
          : `Compensates for light falling off exponentially through the material. 100% suits white PLA; raise it if prints still look flat, lower it if highlights blow out. Set 0 for the old linear ramp.`}
      </p>
    </>
  )
}

// ---------- shared presentational components ----------

// A small "ⓘ" badge that reveals a tooltip on hover/focus (CSS-driven). Used to
// explain multi-option choices inline without cluttering the panel.
function InfoDot({ text }: { text: React.ReactNode }) {
  return (
    <span className="info" tabIndex={0}>
      i<span className="info-pop">{text}</span>
    </span>
  )
}

function Measurements({
  size, fmtLen, inches, setInches,
}: {
  size: { x: number; y: number; z: number }
  fmtLen: (mm: number) => string
  inches: boolean
  setInches: (v: boolean) => void
}) {
  return (
    <div className="measure-row">
      <div className="measure-head">
        <span>Measurements</span>
        <button className="link" onClick={() => setInches(!inches)}>
          {inches ? 'show mm' : 'show inches'}
        </button>
      </div>
      <div className="measure-grid">
        <span>X</span><b>{fmtLen(size.x)}</b>
        <span>Y</span><b>{fmtLen(size.y)}</b>
        <span>Z</span><b>{fmtLen(size.z)}</b>
      </div>
    </div>
  )
}

function Section({ title, defaultOpen, children }: {
  title: string; defaultOpen?: boolean; children: React.ReactNode
}) {
  const [open, setOpen] = useState(!!defaultOpen)
  return (
    <section className="panel">
      <button className="panel-head" onClick={() => setOpen(!open)}>
        <span className={`chev ${open ? 'open' : ''}`}>▸</span>
        {title}
      </button>
      {open && <div className="panel-body">{children}</div>}
    </section>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
    </div>
  )
}

function NumberInput({ value, min, max, step, unit, onChange }: {
  value: number; min: number; max: number; step: number; unit?: string
  onChange: (v: number) => void
}) {
  return (
    <div className="num-input">
      {/* Slider commits live (dragging is expected to update as you go). */}
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(+e.target.value)} />
      <div className="num-box">
        <CommittedInput value={value} min={min} max={max} step={step} onCommit={onChange} />
        {unit && <span className="unit">{unit}</span>}
      </div>
    </div>
  )
}

// A numeric <input> that only commits on blur or Enter — NOT on every keystroke.
// Typing is kept in local text state so mid-edit values (an empty box, or "2"
// while changing "25" to "26") don't snap the model to `min`. Escape reverts.
// Stays in sync with `value` whenever the field isn't being edited (e.g. the
// slider moved it). Bare <input> so callers control the surrounding chrome.
function CommittedInput({ value, min, max, step, onCommit }: {
  value: number; min: number; max: number; step: number
  onCommit: (v: number) => void
}) {
  const [text, setText] = useState(() => fmtNum(value))
  const focused = useRef(false)

  useEffect(() => {
    if (!focused.current) setText(fmtNum(value))
  }, [value])

  const commit = () => {
    focused.current = false
    const parsed = parseFloat(text)
    if (Number.isNaN(parsed)) {
      setText(fmtNum(value)) // empty / garbage → revert to the last good value
      return
    }
    const c = clamp(parsed, min, max)
    onCommit(c)
    setText(fmtNum(c))
  }

  return (
    <input
      type="number" min={min} max={max} step={step} value={text}
      onFocus={() => { focused.current = true }}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        else if (e.key === 'Escape') {
          setText(fmtNum(value))
          ;(e.target as HTMLInputElement).blur()
        }
      }}
    />
  )
}

function UnitStepper({ label, value, onChange, min = 1, max = 12 }: {
  label: string; value: number; onChange: (v: number) => void; min?: number; max?: number
}) {
  return (
    <div className="field stepper">
      <label>{label}</label>
      <div className="stepper-ctrl">
        <button onClick={() => onChange(clamp(value - 1, min, max))}>−</button>
        <input type="range" min={min} max={max} step={1} value={value}
          onChange={(e) => onChange(+e.target.value)} />
        <span className="stepper-val">{value}</span>
        <button onClick={() => onChange(clamp(value + 1, min, max))}>+</button>
      </div>
    </div>
  )
}

function Toggle({ label, checked, onChange }: {
  label: string; checked: boolean; onChange: (v: boolean) => void
}) {
  return (
    <div className="field toggle-field">
      <label>{label}</label>
      <button className={`switch ${checked ? 'on' : ''}`} onClick={() => onChange(!checked)}>
        <span className="knob" />
      </button>
    </div>
  )
}

function SegMessage({ label, value, onChange }: {
  label: string; value: SocketStyle; onChange: (v: SocketStyle) => void
}) {
  const opts: SocketStyle[] = ['none', 'corner', 'full']
  return (
    <div className="field seg-field">
      <label>{label}</label>
      <div className="seg">
        {opts.map((o) => (
          <button key={o} className={value === o ? 'active' : ''} onClick={() => onChange(o)}>
            {cap(o)}
          </button>
        ))}
      </div>
    </div>
  )
}

function SegLip({ value, onChange }: { value: LipStyle; onChange: (v: LipStyle) => void }) {
  const opts: LipStyle[] = ['default', 'thin', 'none']
  return (
    <div className="field seg-field">
      <label>Lip style</label>
      <div className="seg">
        {opts.map((o) => (
          <button key={o} className={value === o ? 'active' : ''} onClick={() => onChange(o)}>
            {cap(o)}
          </button>
        ))}
      </div>
    </div>
  )
}

const clamp = (v: number, min: number, max: number) =>
  Number.isNaN(v) ? min : Math.min(max, Math.max(min, v))
// Round to 3 decimals and stringify, so float noise (e.g. 0.333*100) doesn't
// show as "33.30000000000001" in the input.
const fmtNum = (n: number) => String(Math.round(n * 1000) / 1000)
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
