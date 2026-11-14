import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import { plural } from '../lib/format'
import type { FolderRow, SyncPreview } from '../lib/types'
import { Dialog } from './Primitives'

export interface FolderTarget {
  row: FolderRow
  mode: 'rename' | 'move'
}

const leafOf = (rel: string, root: string) => (rel === '' ? root : rel.slice(rel.lastIndexOf('/') + 1))

/** Rename or move a folder: the folder on the disk and the catalog change together, and the photos inside are still found. */
export function FolderActionDialog({ target, onClose }: { target: FolderTarget | null; onClose: () => void }) {
  const folders = useStore((s) => s.folders)
  const [name, setName] = useState('')
  const [dest, setDest] = useState('top')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!target) return
    setName(leafOf(target.row.relPath, target.row.root))
    setDest('top')
    setError(null)
    setBusy(false)
  }, [target])
  if (!target) return null
  const { row, mode } = target
  // where it can go: any other folder of the same place, except itself and the folders inside it
  const places = folders.filter((f) => f.root === row.root && f.id !== row.id && f.relPath !== '' && f.relPath !== row.relPath && !f.relPath.startsWith(row.relPath + '/'))
  const label = leafOf(row.relPath, row.root)

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      if (mode === 'rename') await api().folderRename(row.id, name)
      else await api().folderMove(row.id, dest === 'top' ? null : Number(dest))
      await useStore.getState().reload()
      useStore.getState().say(mode === 'rename' ? `Renamed to "${name.trim()}".` : `Moved "${label}".`)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open onClose={onClose} title={mode === 'rename' ? 'Rename folder' : 'Move folder'} busy={busy}>
      <div className="form">
        {mode === 'rename' ? (
          <>
            <div className="field-row">
              <label className="lbl" htmlFor="folder-new-name">
                New name
              </label>
              <input id="folder-new-name" className="field" type="text" maxLength={120} value={name} disabled={busy} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && void run()} />
            </div>
            <p className="hint">The folder is renamed on the disk too. The photos inside stay in the catalog with all their edits.</p>
          </>
        ) : (
          <>
            <div className="field-row">
              <label className="lbl" htmlFor="folder-dest">
                Move "{label}" into
              </label>
              <select id="folder-dest" className="field" value={dest} disabled={busy} onChange={(e) => setDest(e.target.value)}>
                <option value="top">The top of {row.root}</option>
                {places.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.relPath}
                  </option>
                ))}
              </select>
            </div>
            <p className="hint">The folder and everything in it are moved on the disk too, inside {row.root}. Only the choices inside the same place are offered.</p>
          </>
        )}
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="dialog-foot">
        <button className="btn" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button className="btn accent" onClick={() => void run()} disabled={busy || (mode === 'rename' && !name.trim())}>
          {mode === 'rename' ? 'Rename' : 'Move'}
        </button>
      </div>
    </Dialog>
  )
}

/** Synchronize a folder: what is new on the disk and what is gone, and what to do about each. */
export function SyncFolderDialog({ row, onClose }: { row: FolderRow | null; onClose: () => void }) {
  const [preview, setPreview] = useState<SyncPreview | null>(null)
  const [importNew, setImportNew] = useState(true)
  const [removeGone, setRemoveGone] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (!row) return
    setPreview(null)
    setError(null)
    setBusy(false)
    setImportNew(true)
    setRemoveGone(false)
    let alive = true
    api()
      .folderSyncPreview(row.id)
      .then((p) => alive && setPreview(p))
      .catch((e: Error) => alive && setError(e.message))
    return () => {
      alive = false
    }
  }, [row])
  if (!row) return null
  const label = row.relPath === '' ? row.root : row.relPath
  const nothing = preview !== null && preview.newFiles.length === 0 && preview.gone.length === 0
  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      const r = await api().folderSyncRun(row.id, importNew, removeGone)
      await useStore.getState().reload()
      const parts = [r.imported ? `${plural(r.imported, 'photo')} imported` : '', r.duplicates ? `${plural(r.duplicates, 'duplicate')} skipped` : '', r.removed ? `${plural(r.removed, 'photo')} removed from the catalog` : '', r.markedMissing ? `${plural(r.markedMissing, 'photo')} marked missing` : ''].filter(Boolean)
      useStore.getState().say(parts.length ? `Synchronized “${label}”: ${parts.join(', ')}.` : `“${label}” was already in step.`)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open onClose={onClose} title="Synchronize folder" busy={busy}>
      <div className="form">
        <p>
          Looking at <strong>{label}</strong> on the disk, and the folders inside it.
        </p>
        {preview === null && !error && <p className="hint">Looking…</p>}
        {preview && (
          <>
            <p role="status">
              {plural(preview.newFiles.length, 'new photo')} on the disk that the catalog does not have. {plural(preview.gone.length, 'photo')} in the catalog {preview.gone.length === 1 ? 'has' : 'have'} no file any more. ({plural(preview.present, 'photo')} in the catalog here.)
            </p>
            {!nothing && (
              <>
                <label className="check">
                  <input type="checkbox" checked={importNew} disabled={busy || preview.newFiles.length === 0} onChange={(e) => setImportNew(e.target.checked)} /> Import the new photos (they stay where they are)
                </label>
                <label className="check">
                  <input type="checkbox" checked={removeGone} disabled={busy || preview.gone.length === 0} onChange={(e) => setRemoveGone(e.target.checked)} /> Remove the photos with no file from the catalog (otherwise they are marked missing)
                </label>
                {preview.gone.length > 0 && (
                  <details>
                    <summary>The photos with no file</summary>
                    <ul>
                      {preview.gone.slice(0, 20).map((g) => (
                        <li key={g.id}>{g.name}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </>
            )}
          </>
        )}
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="dialog-foot">
        <button className="btn" onClick={onClose} disabled={busy}>
          {nothing ? 'Close' : 'Cancel'}
        </button>
        {!nothing && (
          <button className="btn accent" onClick={() => void run()} disabled={busy || preview === null}>
            Synchronize
          </button>
        )}
      </div>
    </Dialog>
  )
}