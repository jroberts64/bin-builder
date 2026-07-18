import { useEffect, useRef, useState } from 'react'
import {
  BinModel,
  Divider,
  LipStyle,
  SocketStyle,
  resolvedSize,
} from './model/types'
import { BoxModel } from './model/box'
import { SkadisModel, HolderShape, HookStyle } from './model/skadis'
import { Design, ObjectType, assertNever } from './model/serialize'
import {
  export3MF,
  exportSTL,
  exportBox3MF,
  exportBoxSTL,
  exportSkadisSTL,
  exportSkadis3MF,
  downloadBlob,
} from './model/export'
import SaveMenu from './SaveMenu'

interface Props {
  design: Design
  setBin: (m: BinModel) => void
  setBox: (m: BoxModel) => void
  setSkadis: (m: SkadisModel) => void
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
]

export default function Sidebar({
  design,
  setBin,
  setBox,
  setSkadis,
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
      default:
        assertNever(design.type)
    }
  }
  // 3MF supports multiple objects natively, so the box 3MF carries box + lid as
  // two separate objects in one file.
  const doExport3MF = () => {
    const base = baseName()
    switch (design.type) {
      case 'bin':
        downloadBlob(export3MF(design.bin), `${base}.3mf`)
        break
      case 'box':
        downloadBlob(exportBox3MF(design.box), `${base}.3mf`)
        break
      case 'skadis':
        downloadBlob(exportSkadis3MF(design.skadis), `${base}.3mf`)
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
        <p className="hint">
          {hinged
            ? 'Print-in-place hinged lid: prints open & flat (box + lid joined at the back hinge). Folds closed with an overlapping lip + snap.'
            : 'Sliding lid: slides into grooves in the side walls, inserts from the front.'}
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
    </>
  )
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
    { id: 'rect', label: 'Rect' },
    { id: 'rounded', label: 'Rounded' },
    { id: 'round', label: 'Round' },
  ]
  const hooks: { id: HookStyle; label: string }[] = [
    { id: 'peg', label: 'Peg' },
    { id: 'snap', label: 'Snap' },
    { id: 'clip', label: 'Clip' },
  ]
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
        {model.shape === 'rounded' && (
          <Field label="Corner radius">
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
        <Field label="Front opening">
          <NumberInput value={model.openingDeg} min={0} max={300} step={5} unit="°"
            onChange={(v) => patch({ openingDeg: v })} />
        </Field>
        <p className="hint">
          0° = fully enclosed. Larger opens the front by that angle — a clean arc on round shapes, a
          V-notch on rectangular ones.
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
