import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useBook } from '../lib/book'
import { useDevelop } from '../lib/develop'
import { num, plural } from '../lib/format'
import { backupDue, usePrefs } from '../lib/prefs'
import { DEFAULT_FILTERS, useStore } from '../lib/store'
import type { CatalogBackup, CatalogCheck, CatalogEntry, CatalogList } from '../lib/types'
import { AutoBackups } from './AutoBackups'
import { Dialog } from './Primitives'

/** Everything shown belongs to the catalog that was open, so after a change the window starts again from the new one. */
async function startAgain(say: string) {
  await useDevelop.getState().open(null)
  useStore.setState((s) => ({ module: 'library', view: 'grid', filters: DEFAULT_FILTERS, selected: new Set(), active: -1, anchor: -1, previewVersion: s.previewVersion + 1, photoVersion: {}, catalogsOpen: false }))
  await useStore.getState().reload()
  useStore.getState().say(say)
}

/**
 * Catalogs: the ones kept, which is open, and how to make or open another. A catalog holds the ratings, keywords and edits;
 * the original photos are never moved or changed, and taking a catalog off the list only forgets where it is.
 */
export function CatalogsDialog() {
  const open = useStore((s) => s.catalogsOpen)
  const close = () => useStore.setState({ catalogsOpen: false })
  const [list, setList] = useState<CatalogList | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [renaming, setRenaming] = useState<{ id: string; text: string } | null>(null)
  const [name, setName] = useState('')
  const [where, setWhere] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null)
  const [share, setShare] = useState<{ name: string; previews: boolean; working: boolean; note: string | null; error: string | null }>({ name: 'Exported photos', previews: true, working: false, note: null, error: null })
  const picked = useStore((s) => s.selected.size || (s.photoAt(s.active) ? 1 : 0))
  const [care, setCare] = useState<{ check: CatalogCheck | null; backup: CatalogBackup | null; optimized: { before: number; after: number } | null; last: string | null; working: 'check' | 'backup' | 'optimize' | null; error: string | null }>({ check: null, backup: null, optimized: null, last: null, working: null, error: null })

  const refresh = async () => {
    try {
      setList(await api().catalogList())
    } catch (e) {
      setError((e as Error).message)
    }
  }
  useEffect(() => {
    if (!open) return
    setError(null)
    setRenaming(null)
    setName('')
    setWhere(null)
    setConfirmRemove(null)
    setShare((s) => ({ ...s, working: false, note: null, error: null }))
    setCare({ check: null, backup: null, optimized: null, last: null, working: null, error: null })
    void refresh()
    void api()
      .catalogLastBackup()
      .then((last) => setCare((c) => ({ ...c, last })))
      .catch(() => {})
  }, [open])

  const check = async () => {
    setCare((c) => ({ ...c, working: 'check', error: null, check: null }))
    try {
      const r = await api().catalogCheck()
      setCare((c) => ({ ...c, check: r, working: null }))
    } catch (e) {
      setCare((c) => ({ ...c, working: null, error: (e as Error).message }))
    }
  }
  const optimize = async () => {
    setCare((c) => ({ ...c, working: 'optimize', error: null, optimized: null }))
    try {
      const r = await api().catalogOptimize()
      setCare((c) => ({ ...c, working: null, optimized: r }))
    } catch (e) {
      setCare((c) => ({ ...c, working: null, error: (e as Error).message }))
    }
  }
  const backUp = async () => {
    const where = await api().pickFolder('Choose the folder to keep the backup in')
    if (!where) return
    setCare((c) => ({ ...c, working: 'backup', error: null, backup: null }))
    try {
      const b = await api().catalogBackup(where)
      setCare((c) => ({ ...c, backup: b, last: b.when, working: null }))
    } catch (e) {
      setCare((c) => ({ ...c, working: null, error: (e as Error).message }))
    }
  }
  const reminderDays = usePrefs((s) => s.reminderDays)
  const stale = backupDue(care.last, reminderDays)

  const run = async (job: () => Promise<CatalogList>, say: (l: CatalogList) => string) => {
    setBusy(true)
    setError(null)
    try {
      // a book that is being edited is saved into the catalog it belongs to before another one opens
      await useBook.getState().flush()
      const l = await job()
      setList(l)
      useBook.getState().reset()
      await startAgain(say(l))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const nameOf = (l: CatalogList) => l.items.find((i) => i.id === l.current)?.name ?? 'the catalog'

  const rename = async () => {
    if (!renaming) return
    setBusy(true)
    setError(null)
    try {
      setList(await api().catalogRename(renaming.id, renaming.text))
      setRenaming(null)
      await useStore.getState().reload() // the name is shown in the Library too
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const forget = async (id: string) => {
    setBusy(true)
    setError(null)
    try {
      setList(await api().catalogRemove(id))
      setConfirmRemove(null)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const row = (c: CatalogEntry) => (
    <li key={c.id} className={c.current ? 'catalog-row current' : 'catalog-row'}>
      <div className="catalog-main">
        {renaming?.id === c.id ? (
          <form
            className="row"
            onSubmit={(e) => {
              e.preventDefault()
              void rename()
            }}
          >
            <input className="field" aria-label={`New name for ${c.name}`} autoFocus maxLength={60} value={renaming.text} onChange={(e) => setRenaming({ id: c.id, text: e.target.value })} />
            <button type="submit" className="btn sm accent" disabled={busy}>
              Save
            </button>
            <button type="button" className="btn sm" onClick={() => setRenaming(null)}>
              Cancel
            </button>
          </form>
        ) : (
          <strong className="trunc">{c.name}</strong>
        )}
        <span className="hint trunc" title={c.path}>
          {c.exists ? `${c.photos === null ? 'Photos not counted' : plural(c.photos, 'photo')} · ${c.path}` : `Folder not found · ${c.path}`}
        </span>
      </div>
      <div className="row catalog-actions">
        {c.current ? (
          <span className="pill-badge" role="status">
            Open now
          </span>
        ) : (
          <button type="button" className="btn sm" disabled={busy || !c.exists} aria-label={`Switch to ${c.name}`} onClick={() => void run(() => api().catalogSwitch(c.id), (l) => `Now working in "${nameOf(l)}".`)}>
            Switch to
          </button>
        )}
        <button type="button" className="btn sm" disabled={busy || renaming !== null} aria-label={`Rename ${c.name}`} onClick={() => setRenaming({ id: c.id, text: c.name })}>
          Rename
        </button>
        {confirmRemove === c.id ? (
          <>
            <button type="button" className="btn sm danger" disabled={busy} onClick={() => void forget(c.id)} aria-label={`Confirm: take ${c.name} off the list`}>
              Take it off the list
            </button>
            <button type="button" className="btn sm" onClick={() => setConfirmRemove(null)}>
              Keep
            </button>
          </>
        ) : (
          <button type="button" className="btn sm" disabled={busy || c.current} title={c.current ? 'Switch to another catalog first' : 'Forget this catalog. Its photos and its folder are not touched.'} aria-label={`Remove ${c.name} from the list`} onClick={() => setConfirmRemove(c.id)}>
            Remove
          </button>
        )}
      </div>
    </li>
  )

  const exportPhotos = async () => {
    const where = await api().pickFolder('Choose the destination folder for the new catalog')
    if (!where) return
    setShare((s) => ({ ...s, working: true, note: null, error: null }))
    try {
      const r = await api().catalogExportPhotos(useStore.getState().targetIds(), where, share.name, share.previews)
      setShare((s) => ({ ...s, working: false, note: `Made a catalog of ${plural(r.photos, 'photo')} in ${r.folder}${r.skipped ? ` (${r.skipped} left out)` : ''}. To open it, choose "Open an existing catalog…" and pick that folder.` }))
    } catch (e) {
      setShare((s) => ({ ...s, working: false, error: (e as Error).message }))
    }
  }
  const importCatalog = async () => {
    const folder = await api().pickFolder('Choose the folder of the catalog to take photos from (it has a catalog.db file in it)')
    if (!folder) return
    setShare((s) => ({ ...s, working: true, note: null, error: null }))
    try {
      const r = await api().catalogImportFrom(folder, share.previews)
      await useStore.getState().reload()
      setShare((s) => ({ ...s, working: false, note: `Added ${plural(r.photos, 'photo')} from that catalog${r.skipped ? `; ${plural(r.skipped, 'photo')} ${r.skipped === 1 ? 'was' : 'were'} here already` : ''}. A backup of this catalog was made first.` }))
    } catch (e) {
      setShare((s) => ({ ...s, working: false, error: (e as Error).message }))
    }
  }
  const create = () =>
    void run(
      () => api().catalogCreate(name, where),
      (l) => `Made "${nameOf(l)}" and opened it. It is empty: import photos to start.`,
    )
  const openExisting = async () => {
    let folder: string | null = null
    try {
      folder = await api().pickFolder('Choose a catalog folder (it has a catalog.db file in it)')
    } catch (e) {
      return setError((e as Error).message)
    }
    if (folder) void run(() => api().catalogOpen(folder!), (l) => `Opened "${nameOf(l)}" (${num(l.items.find((i) => i.current)?.photos ?? 0)} photos).`)
  }

  return (
    <Dialog open={open} onClose={close} title="Catalogs" wide busy={busy}>
      <div className="form">
        <p>A catalog is where Lucent Raw keeps what you do to your photos: ratings, flags, keywords, collections and edits. Your original files are never moved or changed. Keep one catalog for everything, or one for each client or year.</p>
        <ul className="catalog-list" aria-label="Your catalogs">
          {list?.items.map(row)}
        </ul>
        <fieldset className="export-group">
          <legend>New catalog</legend>
          <div className="field-row">
            <label className="lbl" htmlFor="catalog-name">
              Name
            </label>
            <input id="catalog-name" className="field" maxLength={60} value={name} placeholder="For example: Weddings 2026" disabled={busy} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && create()} />
          </div>
          <div className="field-row">
            <span className="lbl">Kept in</span>
            <button type="button" className="btn sm" disabled={busy} onClick={async () => setWhere((await api().pickFolder('Choose a folder to keep the new catalog in')) ?? where)}>
              Choose folder…
            </button>
            <span className="path" title={where ?? ''}>
              {where ?? "Lucent Raw's own folder"}
            </span>
          </div>
          <button type="button" className="btn accent" disabled={busy || name.trim() === ''} onClick={create}>
            Create and open
          </button>
        </fieldset>
        <fieldset className="export-group">
          <legend>Share photos between catalogs</legend>
          <p className="hint">Export the selected photos as a catalog of their own (with their ratings, keywords, edits and history), for a client or another computer, or add the photos of another catalog to this one. The photo files are not copied: each photo points at the same file as before.</p>
          <div className="field-row">
            <label className="lbl" htmlFor="share-name">
              Name of the new catalog
            </label>
            <input id="share-name" className="field" maxLength={60} value={share.name} disabled={busy || share.working} onChange={(e) => setShare((s) => ({ ...s, name: e.target.value }))} />
          </div>
          <label className="check">
            <input type="checkbox" checked={share.previews} disabled={busy || share.working} onChange={(e) => setShare((s) => ({ ...s, previews: e.target.checked }))} /> Take the previews along
          </label>
          <div className="row">
            <button type="button" className="btn" disabled={busy || share.working || picked === 0 || share.name.trim() === ''} onClick={() => void exportPhotos()} title={picked === 0 ? 'Select photos in the Library first' : undefined}>
              {picked === 0 ? 'Export selected photos as a catalog…' : `Export ${plural(picked, 'selected photo')} as a catalog…`}
            </button>
            <button type="button" className="btn" disabled={busy || share.working} onClick={() => void importCatalog()}>
              Import from another catalog…
            </button>
          </div>
          {share.note && <p role="status">{share.note}</p>}
          {share.error && (
            <p className="err" role="alert">
              {share.error}
            </p>
          )}
        </fieldset>
        <fieldset className="export-group">
          <legend>Look after this catalog</legend>
          <p className="hint" role="status">
            {care.last ? `Last backup: ${care.last}.` : 'This catalog has never been backed up.'}
            {stale ? ' A backup is worth making now: your ratings, edits and books are only kept here.' : ''}
          </p>
          <div className="row">
            <button type="button" className="btn" disabled={busy || care.working !== null} onClick={() => useStore.setState({ catalogsOpen: false, missingOpen: true })}>
              Find missing photos…
            </button>
            <button type="button" className="btn" disabled={busy || care.working !== null} onClick={() => useStore.setState({ catalogsOpen: false, sidecarsOpen: true })}>
              Sidecar files…
            </button>
            <button type="button" className="btn" disabled={busy || care.working !== null} onClick={() => void backUp()}>
              {care.working === 'backup' ? 'Backing up…' : 'Back up…'}
            </button>
            <button type="button" className="btn" disabled={busy || care.working !== null} onClick={() => void check()}>
              {care.working === 'check' ? 'Checking…' : 'Check for problems'}
            </button>
            <button type="button" className="btn" disabled={busy || care.working !== null} onClick={() => void optimize()} title="Compact the catalog file and rebuild its indexes">
              {care.working === 'optimize' ? 'Optimizing…' : 'Optimize'}
            </button>
          </div>
          {care.optimized && (
            <p role="status">
              Optimized: the catalog was {(care.optimized.before / 1_000_000).toFixed(1)} MB and is now {(care.optimized.after / 1_000_000).toFixed(1)} MB. Nothing in it changed.
            </p>
          )}
          {care.backup && (
            <p role="status">
              Backed up to <span className="path">{care.backup.folder}</span> ({(care.backup.bytes / 1_000_000).toFixed(1)} MB). To use it, choose "Open an existing catalog…" and pick that folder. Previews are made again when it is opened. Your photos are not copied; they stay where they are.
            </p>
          )}
          {care.check && (
            <div role="status">
              {care.check.ok ? (
                <p>No problems found: {plural(care.check.photos, 'photo')}, {plural(care.check.books, 'book')}.</p>
              ) : (
                <>
                  <p>
                    <strong>Problems were found.</strong> Make a backup first, then open the backup or an older one if something looks wrong.
                  </p>
                  <ul className="plain-list">
                    {care.check.problems.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                </>
              )}
            </div>
          )}
          {care.error && (
            <p className="err" role="alert">
              {care.error}
            </p>
          )}
        </fieldset>
        <AutoBackups open={open} disabled={busy} onRestored={() => startAgain('Restored from a backup.')} />
        <div className="row">
          <button type="button" className="btn" disabled={busy} onClick={() => void openExisting()}>
            Open an existing catalog…
          </button>
          <span className="hint">For a catalog made earlier, on another drive or by another copy of Lucent Raw.</span>
        </div>
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="dialog-foot">
        <button className="btn" onClick={close} disabled={busy}>
          Done
        </button>
      </div>
    </Dialog>
  )
}
