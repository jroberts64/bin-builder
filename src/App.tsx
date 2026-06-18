import { useEffect, useMemo, useRef, useState } from 'react'
import Viewport from './Viewport'
import Sidebar from './Sidebar'
import { BinModel, defaultBin, resolvedSize } from './model/types'
import { initCSG } from './model/csg'
import { readShareUrl } from './model/serialize'
import { readAutosave, writeAutosave } from './model/storage'

// Initial design, resolved once: a shared ?d= URL wins, then the autosave slot,
// then the built-in default.
function initialState(): { model: BinModel; name: string } {
  const shared = readShareUrl()
  if (shared) return { model: shared.model, name: shared.name ?? '' }
  const auto = readAutosave()
  if (auto) return { model: auto, name: '' }
  return { model: defaultBin(), name: '' }
}

export default function App() {
  const start = useRef(initialState())
  const [model, setModel] = useState<BinModel>(start.current.model)
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
    const t = setTimeout(() => writeAutosave(model), 300)
    return () => clearTimeout(t)
  }, [model])

  const loadModel = (m: BinModel, name?: string) => {
    setModel(m)
    setCurrentName(name ?? '')
    setFitSignal((s) => s + 1) // reframe the camera on the loaded design
  }

  const size = useMemo(() => resolvedSize(model), [model])

  return (
    <div className="app">
      <Sidebar
        model={model}
        setModel={setModel}
        showBuildPlate={showBuildPlate}
        setShowBuildPlate={setShowBuildPlate}
        ready={ready}
        onLoad={loadModel}
        onNameChange={setCurrentName}
        currentName={currentName}
      />
      <div className="stage">
        <Viewport
          model={model}
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
