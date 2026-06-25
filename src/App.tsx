import { useEffect, useMemo, useRef, useState } from 'react'
import Viewport from './Viewport'
import Sidebar from './Sidebar'
import { BinModel, resolvedSize } from './model/types'
import { BoxModel, boxOuterSize } from './model/box'
import { initCSG } from './model/csg'
import { Design, ObjectType, defaultDesign, readShareUrl } from './model/serialize'
import { readAutosave, writeAutosave } from './model/storage'

// Initial design, resolved once: a shared ?d= URL wins, then the autosave slot,
// then the built-in default.
function initialState(): { design: Design; name: string } {
  const shared = readShareUrl()
  if (shared) return { design: shared.design, name: shared.name ?? '' }
  const auto = readAutosave()
  if (auto) return { design: auto, name: '' }
  return { design: defaultDesign(), name: '' }
}

export default function App() {
  const start = useRef(initialState())
  const [design, setDesign] = useState<Design>(start.current.design)
  const [currentName, setCurrentName] = useState(start.current.name)
  const [showBuildPlate, setShowBuildPlate] = useState(true)
  const [fitSignal, setFitSignal] = useState(0)
  const [ready, setReady] = useState(false)

  // Initialise the Manifold WASM CSG kernel once before any geometry is built.
  useEffect(() => {
    initCSG().then(() => setReady(true))
  }, [])

  // Autosave the working design (debounced) so a reload restores it.
  useEffect(() => {
    const t = setTimeout(() => writeAutosave(design), 300)
    return () => clearTimeout(t)
  }, [design])

  // Per-type model setters that update the active model within the design.
  const setBin = (bin: BinModel) => setDesign((d) => ({ ...d, bin }))
  const setBox = (box: BoxModel) => setDesign((d) => ({ ...d, box }))
  const setType = (type: ObjectType) => {
    setDesign((d) => ({ ...d, type }))
    setFitSignal((s) => s + 1)
  }

  const loadDesign = (d: Design, name?: string) => {
    setDesign(d)
    setCurrentName(name ?? '')
    setFitSignal((s) => s + 1)
  }

  const size = useMemo(
    () => (design.type === 'bin' ? resolvedSize(design.bin) : boxOuterSize(design.box)),
    [design],
  )

  return (
    <div className="app">
      <Sidebar
        design={design}
        setBin={setBin}
        setBox={setBox}
        setType={setType}
        showBuildPlate={showBuildPlate}
        setShowBuildPlate={setShowBuildPlate}
        ready={ready}
        onLoad={loadDesign}
        onNameChange={setCurrentName}
        currentName={currentName}
      />
      <div className="stage">
        <Viewport
          design={design}
          showBuildPlate={showBuildPlate}
          fitSignal={fitSignal}
          ready={ready}
        />
        <div className="dims-readout">
          {size.x.toFixed(1)} × {size.y.toFixed(1)} × {size.z.toFixed(1)} mm
        </div>
        {!ready && <div className="loading">Loading CSG engine…</div>}
        <button className="fit-btn" onClick={() => setFitSignal((s) => s + 1)}>
          Fit to view
        </button>
      </div>
    </div>
  )
}
