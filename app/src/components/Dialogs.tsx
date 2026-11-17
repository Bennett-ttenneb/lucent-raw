import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { plural } from '../lib/format'
import { useDevelop } from '../lib/develop'
import { loadImportDefaults, saveImportDefaults } from '../lib/importDefaults'
import { load as loadMetaPresets, type MetaPreset } from '../lib/metaPresets'
import { usePrefs } from '../lib/prefs'
import { useStore } from '../lib/store'
import type { Card, ImportItem, ImportOptions, ImportResult, Progress } from '../lib/types'
import { Dialog, ProgressBar } from './Primitives'

const PATTERNS_KEY = 'lucent.namePatterns'
/** The file name patterns kept from earlier imports (in this window's storage, like presets). */
function loadPatterns(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(PATTERNS_KEY) ?? '[]') as unknown
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, 30) : []
  } catch {
    return []
  }
}
function storePatterns(list: string[]): string[] {
  try {
    localStorage.setItem(PATTERNS_KEY, JSON.stringify(list))
  } catch {
    /* the list lasts until the window closes */
  }
  return list
}
const savePattern = (p: string) => storePatterns([p, ...loadPatterns().filter((x) => x !== p)].slice(0, 30))
const forgetPattern = (p: string) => storePatterns(loadPatterns().filter((x) => x !== p))
/** The keywords typed in the import window: separated by commas, a "Parent > Child" path for one inside another. */
export function parseKeywords(text: string): string[][] {
  return text
    .split(',')
    .map((k) => k.split('>').map((s) => s.trim()).filter(Boolean))
    .filter((p) => p.length > 0)
}

/** Put the chosen develop preset, details preset and keywords on the photos an import just added. Returns what to tell the person. */
async function putOnImported(ids: number[], devPreset: string, metaPresetName: string, keywordText: string): Promise<string[]> {
  const notes: string[] = []
  if (ids.length === 0) return notes
  if (devPreset) {
    const p = useDevelop.getState().presets.find((x) => x.name === devPreset)
    if (p) {
      const r = await useDevelop.getState().applyPresetToMany(ids, p)
      notes.push(r.failed.length ? `Could not put the preset "${p.name}" on ${r.failed.length} photos: ${r.failed[0]}` : `Preset "${p.name}" applied.`)
    }
  }
  const mp = metaPresetName ? loadMetaPresets().find((x) => x.name === metaPresetName) : undefined
  if (mp) {
    try {
      await api().metadataSet(ids, mp.values)
      notes.push(`Details "${mp.name}" applied.`)
    } catch (e) {
      notes.push(`Could not put the details on: ${(e as Error).message}`)
    }
  }
  const paths = parseKeywords(keywordText)
  if (paths.length > 0) {
    try {
      for (const path of paths) await api().keywordAdd(ids, path)
      notes.push(`${paths.length === 1 ? 'Keyword' : 'Keywords'} added.`)
    } catch (e) {
      notes.push(`Could not add the keywords: ${(e as Error).message}`)
    }
  }
  return notes
}

export function ImportDialog() {
  const open = useStore((s) => s.importOpen)
  const close = () => useStore.setState({ importOpen: false })
  const [source, setSource] = useState<string | null>(null)
  const [items, setItems] = useState<ImportItem[] | null>(null)
  /** the photos ticked for import, by path */
  const [picked, setPicked] = useState<Set<string>>(new Set())
  /** the last photo ticked or unticked, where a Shift-click range starts from */
  const anchor = useRef<number | null>(null)
  const start = useRef(loadImportDefaults()).current
  const [mode, setMode] = useState<'add' | 'copy' | 'copy_dng' | 'move'>(start.mode)
  const [embedOriginal, setEmbedOriginal] = useState(false)
  const smartOn = usePrefs((s) => s.smartOnImport)
  const [nameTemplate, setNameTemplate] = useState(start.nameTemplate)
  const [folderFormat, setFolderFormat] = useState<ImportOptions['folderFormat']>(start.folderFormat)
  const [dest, setDest] = useState<string | null>(null)
  const [skipSuspected, setSkipSuspected] = useState(start.skipSuspected)
  const [subfolders, setSubfolders] = useState(start.subfolders)
  const [seqStart, setSeqStart] = useState(1)
  const [savedPatterns, setSavedPatterns] = useState<string[]>(loadPatterns)
  /** put on every photo that is added: a develop preset (by name), a details preset (by name) and keywords (comma separated, "Parent > Child" for a keyword inside another) */
  const [devPreset, setDevPreset] = useState(start.devPreset)
  const [metaPresetName, setMetaPresetName] = useState(start.metaPreset)
  const [keywordText, setKeywordText] = useState(start.keywords)
  const presets = useDevelop((s) => s.presets)
  const [metaPresets, setMetaPresets] = useState<MetaPreset[]>([])
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<Progress>({ done: 0, total: 0 })
  const [result, setResult] = useState<ImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setSource(null)
      setItems(null)
      setPicked(new Set())
      anchor.current = null
      setResult(null)
      setError(null)
      setBusy(false)
      setProgress({ done: 0, total: 0 })
      setMetaPresets(loadMetaPresets())
      void useDevelop.getState().loadPresets()
      // opened because a card was plugged in: start from it
      const card = useStore.getState().importCard
      if (card) {
        useStore.setState({ importCard: null })
        void load(card)
      }
    }
  }, [open])

  useEffect(() => {
    let off = () => {}
    void api().on<Progress>('import:progress', setProgress).then((u) => (off = u))
    return () => off()
  }, [])

  const [cards, setCards] = useState<Card[]>([])
  // memory cards that are plugged in are offered by name; looked for again every few seconds while this window is open
  useEffect(() => {
    if (!open) return
    let alive = true
    const look = () =>
      api()
        .importCards()
        .then((c) => alive && setCards((old) => (JSON.stringify(old) === JSON.stringify(c) ? old : c)))
        .catch(() => undefined)
    void look()
    const t = setInterval(look, 3000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [open])

  const choose = async () => {
    setError(null)
    const p = await api().pickFolder('Choose the folder or card to import from')
    if (!p) return
    await load(p)
  }
  const load = async (p: string, sub = subfolders) => {
    setError(null)
    setSource(p)
    setResult(null)
    try {
      const list = await api().importList(p, sub)
      setItems(list)
      setPicked(new Set(list.map((i) => i.path))) // everything ticked to start with; untick what is not wanted
      anchor.current = null
    } catch (e) {
      setItems(null)
      setPicked(new Set())
      setError((e as Error).message)
    }
  }
  /** Tick or untick one photo; with Shift, every photo from the last one clicked to this one. */
  const toggle = (i: number, range: boolean) => {
    if (!items) return
    const on = !picked.has(items[i].path)
    const [from, to] = range && anchor.current !== null ? [Math.min(anchor.current, i), Math.max(anchor.current, i)] : [i, i]
    setPicked((prev) => {
      const next = new Set(prev)
      for (let k = from; k <= to; k++) (on ? next.add(items[k].path) : next.delete(items[k].path))
      return next
    })
    anchor.current = i
  }
  const chooseDest = async () => setDest(await api().pickFolder('Choose the destination folder'))

  const run = async () => {
    if (!source) return
    setBusy(true)
    setError(null)
    try {
      // what is ticked is what is imported, in the order shown
      const files = (items ?? []).filter((i) => picked.has(i.path)).map((i) => i.path)
      const opts = mode === 'add' && !skipSuspected ? undefined : { nameTemplate: mode === 'add' || nameTemplate.trim() === '' ? '{name}' : nameTemplate, folderFormat, skipSuspected, seqStart: Math.max(1, Math.round(seqStart) || 1), embedOriginal: mode === 'copy_dng' && embedOriginal }
      const r = await api().importRun(source, mode, mode === 'add' ? null : dest, files, opts)
      setResult(r)
      saveImportDefaults({ mode, nameTemplate: nameTemplate.trim() === '' ? '{name}' : nameTemplate, folderFormat, skipSuspected, subfolders, devPreset, metaPreset: metaPresetName, keywords: keywordText })
      if (usePrefs.getState().smartOnImport && (r.addedIds?.length ?? 0) > 0) void api().smartBuild(r.addedIds).catch(() => undefined) // in the background
      const notes = await putOnImported(r.addedIds ?? [], devPreset, metaPresetName, keywordText)
      await useStore.getState().reload()
      useStore.getState().say(`${plural(r.added, 'photo')} imported${notes.length ? '. ' + notes.join(' ') : ''}`, notes.some((n) => n.startsWith('Could not')))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const found = items?.length ?? 0
  const rawFound = items?.filter((i) => i.raw).length ?? 0
  const canRun = !!source && picked.size > 0 && !busy && !result && (mode === 'add' || !!dest)

  return (
    <Dialog open={open} onClose={close} title="Import photos" busy={busy} wide>
      <div className="form">
        <div className="field-row">
          <span className="lbl">From</span>
          <button className="btn" onClick={() => void choose()} disabled={busy}>
            Choose folder…
          </button>
          <span className="path" title={source ?? ''}>
            {source ?? 'Nothing chosen yet'}
          </span>
        </div>
        <div className="field-row">
          <label>
            <input
              type="checkbox"
              checked={subfolders}
              disabled={busy || !!result}
              onChange={(e) => {
                setSubfolders(e.target.checked)
                if (source) void load(source, e.target.checked)
              }}
            />{' '}
            Include photos in sub-folders
          </label>
        </div>
        {cards.length > 0 && !busy && !result && (
          <div className="field-row" role="group" aria-label="Memory cards">
            <span className="lbl">Cards</span>
            {cards.map((c) => (
              <button key={c.path} type="button" className="btn" aria-pressed={source === c.path} onClick={() => void load(c.path)} title={c.path}>
                {c.label} {c.hasDcim ? '(camera photos)' : '(removable drive)'}
              </button>
            ))}
          </div>
        )}
        {items && (
          <p className="hint" role="status">
            {found === 0
              ? 'No supported photos found in that folder.'
              : `Found ${plural(found - rawFound, 'photo')}${rawFound ? ` and ${plural(rawFound, 'RAW file')} (DNG files count as RAW files)` : ''}.`}
          </p>
        )}
        {items && found > 0 && (
          <div className="import-pick">
            <div className="import-bar">
              <span aria-live="polite">
                {picked.size} of {found} selected
              </span>
              <button type="button" className="btn sm" onClick={() => setPicked(new Set(items.map((i) => i.path)))} disabled={busy || picked.size === found}>
                Select all
              </button>
              <button type="button" className="btn sm" onClick={() => setPicked(new Set())} disabled={busy || picked.size === 0}>
                Select none
              </button>
            </div>
            <ul className="import-grid" aria-label="Photos in this folder">
              {items.map((it, i) => (
                <li key={it.path}>
                  <label className={`import-tile ${picked.has(it.path) ? 'on' : ''}`} title={`${it.folder ? it.folder + '/' : ''}${it.name}`}>
                    <input
                      type="checkbox"
                      checked={picked.has(it.path)}
                      disabled={busy || !!result}
                      onChange={() => undefined}
                      onClick={(e) => toggle(i, e.shiftKey)} // the tick follows what is selected; Shift ticks a whole range
                    />
                    <img src={api().importThumbUrl(it.path)} alt="" loading="lazy" decoding="async" />
                    <span className="import-name">{it.name}</span>
                    {it.raw && <span className="import-raw">RAW</span>}
                    {picked.has(it.path) && (
                      <span className="import-tick" aria-hidden>
                        ✓
                      </span>
                    )}
                  </label>
                </li>
              ))}
            </ul>
            <p className="hint">Click a photo to tick or untick it. Shift-click ticks or unticks everything between two photos.</p>
          </div>
        )}
        <fieldset className="field-row" disabled={busy}>
          <legend className="lbl">How</legend>
          <label>
            <input type="radio" name="mode" checked={mode === 'add'} onChange={() => setMode('add')} /> Leave in place
          </label>
          <label>
            <input type="radio" name="mode" checked={mode === 'copy'} onChange={() => setMode('copy')} /> Copy into a folder, sorted by date
          </label>
          <label>
            <input type="radio" name="mode" checked={mode === 'copy_dng'} onChange={() => setMode('copy_dng')} /> Copy as DNG into a folder, sorted by date (RAW photos are written as DNG)
          </label>
          <label>
            <input type="radio" name="mode" checked={mode === 'move'} onChange={() => setMode('move')} /> Move into a folder (the originals are removed once the copies are checked)
          </label>
        </fieldset>
        {mode === 'copy_dng' && (
          <label className="check">
            <input type="checkbox" checked={embedOriginal} disabled={busy} onChange={(e) => setEmbedOriginal(e.target.checked)} /> Also keep the original RAW file inside each DNG (the DNG is then about twice as big)
          </label>
        )}
        {mode !== 'add' && (
          <>
            <div className="field-row">
              <label className="lbl" htmlFor="import-names">
                File names
              </label>
              <input id="import-names" className="field" type="text" maxLength={120} value={nameTemplate} disabled={busy} onChange={(e) => setNameTemplate(e.target.value)} />
            </div>
            <p className="hint">
              Use {'{name}'} (the photo's own name), {'{date}'} (2026-10-19), {'{time}'} (14-05-09), {'{year}'}, {'{month}'}, {'{day}'}, {'{seq}'} (001, 002 … or {'{seq:5}'} for five digits), {'{camera}'}, {'{lens}'} and {'{iso}'}. A name already taken gets a number added.
            </p>
            <div className="field-row">
              <label className="lbl" htmlFor="import-seq">
                Start numbering at
              </label>
              <input id="import-seq" className="field narrow" type="number" min={1} max={999999} value={seqStart} disabled={busy} onChange={(e) => setSeqStart(Math.max(1, Math.min(999999, Math.round(Number(e.target.value) || 1))))} />
              <label className="lbl" htmlFor="import-saved">
                Saved patterns
              </label>
              <select id="import-saved" className="field" value="" disabled={busy || savedPatterns.length === 0} onChange={(e) => e.target.value && setNameTemplate(e.target.value)}>
                <option value="">{savedPatterns.length ? 'Use a saved pattern…' : 'None saved yet'}</option>
                {savedPatterns.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
              <button type="button" className="btn sm" disabled={busy || nameTemplate.trim() === ''} onClick={() => setSavedPatterns(savePattern(nameTemplate.trim()))}>
                Keep this pattern
              </button>
              <button type="button" className="btn sm" disabled={busy || !savedPatterns.includes(nameTemplate.trim())} onClick={() => setSavedPatterns(forgetPattern(nameTemplate.trim()))}>
                Forget it
              </button>
            </div>
            <div className="field-row">
              <label className="lbl" htmlFor="import-folders">
                Folders
              </label>
              <select id="import-folders" className="field" value={folderFormat} disabled={busy} onChange={(e) => setFolderFormat(e.target.value as ImportOptions['folderFormat'])}>
                <option value="YYYY-MM-DD">One folder a day: 2026-10-19</option>
                <option value="YYYY/MM/DD">Year, month, day: 2026/10/19</option>
                <option value="YYYY/YYYY-MM-DD">Year, then day: 2026/2026-10-19</option>
                <option value="YYYY-MM">One folder a month: 2026-10</option>
                <option value="YYYY">One folder a year: 2026</option>
                <option value="flat">No sub-folders</option>
              </select>
            </div>
          </>
        )}
        {mode !== 'add' && (
          <div className="field-row">
            <span className="lbl">Into</span>
            <button className="btn" onClick={() => void chooseDest()} disabled={busy}>
              Choose destination…
            </button>
            <span className="path" title={dest ?? ''}>
              {dest ?? 'Required for copying'}
            </span>
          </div>
        )}
        <fieldset className="field-row" disabled={busy}>
          <legend className="lbl">Duplicates</legend>
          <label>
            <input type="checkbox" checked={skipSuspected} onChange={(e) => setSkipSuspected(e.target.checked)} /> Also skip suspected duplicates (the same name, taken at the same moment by the same camera, even if the file was saved again)
          </label>
        </fieldset>
        <div className="field-row">
          <label className="lbl" htmlFor="import-develop">
            Develop preset
          </label>
          <select id="import-develop" className="field" value={devPreset} disabled={busy} onChange={(e) => setDevPreset(e.target.value)}>
            <option value="">None</option>
            {presets.map((p) => (
              <option key={`${p.id}-${p.name}`} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field-row">
          <label className="lbl" htmlFor="import-details">
            Details preset
          </label>
          <select id="import-details" className="field" value={metaPresetName} disabled={busy} onChange={(e) => setMetaPresetName(e.target.value)}>
            <option value="">None</option>
            {metaPresets.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field-row">
          <label className="lbl" htmlFor="import-keywords">
            Keywords
          </label>
          <input id="import-keywords" className="field" type="text" maxLength={500} placeholder="wedding, Places > Cape Town" value={keywordText} disabled={busy} onChange={(e) => setKeywordText(e.target.value)} />
        </div>
        <label className="check">
          <input type="checkbox" checked={smartOn} disabled={busy} onChange={(e) => usePrefs.getState().setSmartOnImport(e.target.checked)} /> Also build smart previews (so the photos can be edited and exported when their files are offline)
        </label>
        <p className="hint">The preset, the details and the keywords are put on every photo this import adds. Details presets are made in the Library's Metadata panel.</p>
        <p className="hint">{mode === 'move' ? 'Each photo is copied, the copy is read back and compared with the original, and only then is the original removed. Duplicates are skipped.' : 'Your original files are never changed. Duplicates are skipped.'}</p>
        {busy && <ProgressBar done={progress.done} total={progress.total} label="Import progress" />}
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
        {result && (
          <div role="status" className="result">
            <p>
              Added {plural(result.added, 'photo')}.{result.duplicates ? ` Skipped ${plural(result.duplicates, 'duplicate')}.` : ''}
            </p>
            {result.leftBehind?.length > 0 && (
              <p className="err" role="alert">
                {plural(result.leftBehind.length, 'photo')} copied but the original could not be removed, so {result.leftBehind.length === 1 ? 'it is' : 'they are'} still where {result.leftBehind.length === 1 ? 'it was' : 'they were'}.
              </p>
            )}
            {result.failed.length > 0 && (
              <details>
                <summary>{plural(result.failed.length, 'file')} could not be imported</summary>
                <ul>
                  {result.failed.slice(0, 20).map((f, i) => (
                    <li key={i}>{f}</li>
                  ))}
                </ul>
              </details>
            )}
            {result.unsupportedPreviews > 0 && <p className="hint">{plural(result.unsupportedPreviews, 'file')} could not be previewed.</p>}
          </div>
        )}
      </div>
      <div className="dialog-foot">
        <button className="btn" onClick={close} disabled={busy}>
          {result ? 'Done' : 'Cancel'}
        </button>
        {!result && (
          <button className="btn accent" onClick={() => void run()} disabled={!canRun} aria-busy={busy}>
            {busy ? 'Importing…' : picked.size ? `Import ${plural(picked.size, 'photo')}` : 'Import'}
          </button>
        )}
      </div>
    </Dialog>
  )
}

export { ExportDialog } from './Export'

export function RemoveDialog() {
  const open = useStore((s) => s.removeOpen)
  const n = useStore((s) => (s.removeOpen ? s.targetIds().length : 0))
  const disk = useStore((s) => s.removeDisk)
  const [files, setFiles] = useState<string[]>([])
  const close = () => useStore.setState({ removeOpen: false, removeDisk: false })
  useEffect(() => {
    if (!open || n === 0) return
    let alive = true
    api()
      .photoDeletePreview(useStore.getState().targetIds())
      .then((f) => alive && setFiles(f))
      .catch(() => alive && setFiles([]))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, n])
  return (
    <Dialog open={open} onClose={close} title="Remove from the catalog?">
      <div className="form">
        <p>
          Remove {plural(n, 'photo')} from this catalog? Ratings, keywords and other details kept in the catalog for {n === 1 ? 'it' : 'them'} are lost, and so are any virtual copies of {n === 1 ? 'it' : 'them'}. Removing a virtual copy only removes the copy.
        </p>
        <label>
          <input type="checkbox" checked={disk} disabled={files.length === 0} onChange={(e) => useStore.setState({ removeDisk: e.target.checked })} /> Also move the {plural(files.length, 'file')} to the Recycle Bin
        </label>
        <p className="hint">{disk ? 'The original files and their sidecar files go to the Recycle Bin, where you can still get them back. If they cannot be moved, nothing is removed.' : 'The files stay on your disk.'}</p>
      </div>
      <div className="dialog-foot">
        <button className="btn" onClick={close} autoFocus>
          Cancel
        </button>
        <button className="btn danger" onClick={() => void useStore.getState().confirmRemove(disk && files.length > 0).then(() => useStore.setState({ removeDisk: false }))}>
          {disk && files.length > 0 ? 'Delete files and remove' : 'Remove from catalog'}
        </button>
      </div>
    </Dialog>
  )
}
