import { useState } from 'react'
import {
  BinModel,
  Divider,
  GRIDFINITY,
  LipStyle,
  SocketStyle,
  resolvedSize,
} from './model/types'
import { export3MF, exportSTL, downloadBlob } from './model/export'
import SaveMenu from './SaveMenu'

interface Props {
  model: BinModel
  setModel: (m: BinModel) => void
  showBuildPlate: boolean
  setShowBuildPlate: (v: boolean) => void
  ready: boolean
  onLoad: (model: BinModel, name?: string) => void
  onNameChange: (name: string) => void
  currentName: string
}

let dividerSeq = 0

export default function Sidebar({
  model,
  setModel,
  showBuildPlate,
  setShowBuildPlate,
  ready,
  onLoad,
  onNameChange,
  currentName,
}: Props) {
  const [inches, setInches] = useState(false)
  const patch = (p: Partial<BinModel>) => setModel({ ...model, ...p })
  const size = resolvedSize(model)

  const fmtLen = (mm: number) =>
    inches ? `${(mm / 25.4).toFixed(2)} in` : `${mm.toFixed(1)} mm`

  // Use the saved design name for export downloads, falling back to "bin".
  const exportFilename = (ext: string) => {
    const base = currentName.trim().replace(/[^a-z0-9-_]+/gi, '_') || 'bin'
    return `${base}.${ext}`
  }

  const addDivider = (axis: 'x' | 'y') => {
    const d: Divider = { id: `d${dividerSeq++}`, axis, position: 0.5 }
    patch({ dividers: [...model.dividers, d] })
  }
  const updateDivider = (id: string, p: Partial<Divider>) =>
    patch({ dividers: model.dividers.map((d) => (d.id === id ? { ...d, ...p } : d)) })
  const removeDivider = (id: string) =>
    patch({ dividers: model.dividers.filter((d) => d.id !== id) })

  return (
    <aside className="sidebar">
      <header className="sidebar-head">
        <div className="sidebar-head-top">
          <span className="logo">▦ Bin Builder</span>
          <SaveMenu
            model={model}
            onLoad={onLoad}
            onNameChange={onNameChange}
            currentName={currentName}
          />
        </div>
        <div className="export-group">
          <button
            className="btn primary"
            disabled={!ready}
            title="Download a watertight binary STL, ready to slice."
            onClick={() => downloadBlob(exportSTL(model), exportFilename('stl'))}
          >
            Export STL
          </button>
          <button
            className="btn"
            disabled={!ready}
            title="Download a watertight 3MF package, ready to slice."
            onClick={() => downloadBlob(export3MF(model), exportFilename('3mf'))}
          >
            Export 3MF
          </button>
        </div>
      </header>

      <Section title="Size" defaultOpen>
        <Toggle
          label="Gridfinity"
          checked={model.gridfinity}
          onChange={(v) => patch({ gridfinity: v })}
        />
        <p className="hint">
          {model.gridfinity
            ? 'Standard Gridfinity foot, baseplate clearance and magnet/screw sockets.'
            : 'Plain tray: flat bottom, no Gridfinity foot or sockets.'}
        </p>

        <Field label={model.gridfinity ? 'Grid unit size' : 'Cell size'}>
          <NumberInput
            value={model.gridUnit}
            min={10}
            max={80}
            step={1}
            unit="mm"
            onChange={(v) => patch({ gridUnit: v })}
          />
        </Field>

        {!model.customSize && (
          <>
            <UnitStepper
              label="X units"
              value={model.unitsX}
              onChange={(v) => patch({ unitsX: v })}
            />
            <UnitStepper
              label="Y units"
              value={model.unitsY}
              onChange={(v) => patch({ unitsY: v })}
            />
            <UnitStepper
              label="Z units"
              value={model.unitsZ}
              min={1}
              max={20}
              onChange={(v) => patch({ unitsZ: v })}
            />
          </>
        )}

        <Toggle
          label="Custom Size"
          checked={model.customSize}
          onChange={(v) =>
            patch({
              customSize: v,
              sizeX: size.x,
              sizeY: size.y,
              sizeZ: size.z,
            })
          }
        />

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
            <input
              type="range"
              min={0.05}
              max={0.95}
              step={0.01}
              value={d.position}
              onChange={(e) => updateDivider(d.id, { position: +e.target.value })}
            />
            <span className="divider-pos">{Math.round(d.position * 100)}%</span>
            <button className="icon-btn" onClick={() => removeDivider(d.id)}>✕</button>
          </div>
        ))}
      </Section>
    </aside>
  )
}

// ---------- small presentational components ----------

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
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(+e.target.value)} />
      <div className="num-box">
        <input type="number" min={min} max={max} step={step} value={value}
          onChange={(e) => onChange(clamp(+e.target.value, min, max))} />
        {unit && <span className="unit">{unit}</span>}
      </div>
    </div>
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
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

// keep GRIDFINITY import referenced for potential preset use
void GRIDFINITY
