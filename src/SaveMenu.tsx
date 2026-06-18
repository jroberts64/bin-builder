import { useEffect, useRef, useState } from 'react'
import { BinModel } from './model/types'
import {
  StoredDesign,
  listDesigns,
  saveDesign,
  deleteDesign,
  loadDesign,
} from './model/storage'
import { toJSON, fromJSON, buildShareUrl } from './model/serialize'
import { downloadBlob } from './model/export'

interface Props {
  model: BinModel
  onLoad: (model: BinModel, name?: string) => void
  onNameChange: (name: string) => void
  currentName: string
}

// Save / load menu: named designs in localStorage, .json import/export, and a
// copyable share link. Rendered as a dropdown panel from the header.
export default function SaveMenu({ model, onLoad, onNameChange, currentName }: Props) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(currentName)
  const [designs, setDesigns] = useState<StoredDesign[]>([])
  const [toast, setToast] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const panelRef = useRef<HTMLDivElement>(null)

  useEffect(() => setName(currentName), [currentName])

  // Refresh the list whenever the menu opens.
  useEffect(() => {
    if (open) setDesigns(listDesigns())
  }, [open])

  // Close on outside click.
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const flash = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(null), 1800)
  }

  const handleSave = () => {
    const trimmed = name.trim() || 'Untitled'
    saveDesign(trimmed, model, Date.now())
    setDesigns(listDesigns())
    onNameChange(trimmed) // adopt as the current design name (used by export filenames)
    flash(`Saved "${trimmed}"`)
  }

  const handleLoad = (id: string) => {
    const d = loadDesign(id)
    if (d) {
      onLoad(d.model, d.name)
      setOpen(false)
      flash(`Loaded "${d.name}"`)
    }
  }

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation()
    deleteDesign(id)
    setDesigns(listDesigns())
  }

  const handleExport = () => {
    const fname = (name.trim() || 'design').replace(/[^a-z0-9-_]+/gi, '_')
    downloadBlob(new Blob([toJSON(model, name.trim())], { type: 'application/json' }), `${fname}.json`)
  }

  const handleImportClick = () => fileRef.current?.click()

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const text = await file.text()
      const { model: m, name: n } = fromJSON(text)
      onLoad(m, n)
      setOpen(false)
      flash(`Imported "${n ?? file.name}"`)
    } catch {
      flash('Import failed — invalid file')
    }
    e.target.value = '' // allow re-importing the same file
  }

  const handleCopyLink = async () => {
    const url = buildShareUrl(model, name.trim())
    try {
      await navigator.clipboard.writeText(url)
      flash('Share link copied')
    } catch {
      // clipboard blocked — drop the link into the URL bar at least
      window.history.replaceState(null, '', url)
      flash('Link added to address bar')
    }
  }

  return (
    <div className="savemenu" ref={panelRef}>
      <button className="btn" onClick={() => setOpen((o) => !o)}>
        Save / Load ▾
      </button>
      {toast && <div className="savemenu-toast">{toast}</div>}
      {open && (
        <div className="savemenu-panel">
          <div className="savemenu-row">
            <input
              className="savemenu-name"
              placeholder="Design name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && handleSave()}
            />
            <button className="btn primary small" onClick={handleSave}>Save</button>
          </div>

          <div className="savemenu-actions">
            <button className="btn small" onClick={handleExport}>Export .json</button>
            <button className="btn small" onClick={handleImportClick}>Import .json</button>
            <button className="btn small" onClick={handleCopyLink}>Copy link</button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              style={{ display: 'none' }}
              onChange={handleImportFile}
            />
          </div>

          <div className="savemenu-list">
            {designs.length === 0 && <p className="hint">No saved designs yet.</p>}
            {designs.map((d) => (
              <div className="savemenu-item" key={d.id} onClick={() => handleLoad(d.id)}>
                <span className="savemenu-item-name">{d.name}</span>
                <button
                  className="icon-btn"
                  title="Delete"
                  onClick={(e) => handleDelete(d.id, e)}
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
