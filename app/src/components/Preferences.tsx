import { useEffect, useState } from 'react'
import { LicenceSection } from './Licence'
import { api } from '../lib/api'
import { useCropPrefs, type CropGrid } from '../lib/cropPrefs'
import { bytesText } from '../lib/format'
import { keyFor, REMAPPABLE, resetKeys, setKey } from '../lib/keys'
import { numberMarks } from '../lib/format'
import type { WatchConfig, WatchStatus } from '../lib/types'
import { type CardAction, type NumberFormat, type SizeUnits, AI_TOOLS, COMPONENTS, PREVIEW_LIMIT_GB, PREVIEW_MAX_DAYS, REMINDER_CHOICES, usePrefs, type ReminderDays } from '../lib/prefs'
import { useSliderPrefs } from '../lib/sliderPrefs'
import { useTheme, type ThemeChoice } from '../lib/theme'
import { plural } from '../lib/format'
import { useStore } from '../lib/store'
import type { CacheInfo, CatalogDetails, DisplayProfile, PerfState, Progress } from '../lib/types'
import { Dialog, ProgressBar } from './Primitives'
import privacyPolicy from '../../../docs/privacy-policy.md?raw'
import terms from '../../../docs/terms-and-conditions.md?raw'

export const APP_VERSION = '0.1.0'

const GRIDS: { id: CropGrid; name: string }[] = [
  { id: 'thirds', name: 'Rule of thirds' },
  { id: 'golden', name: 'Golden ratio' },
  { id: 'diagonal', name: 'Diagonals' },
  { id: 'triangle', name: 'Triangles' },
  { id: 'fine', name: 'Fine grid' },
  { id: 'off', name: 'None' },
]
/** The settings kept in this window's storage that Preferences and the view menus change. Presets, saved filters, export presets and the licence are not in it. */
export const PREFERENCE_KEYS = [
  'penumbra.theme',
  'penumbra.backupReminderDays',
  'penumbra.sliderArrows',
  'penumbra.cropGrid',
  'penumbra.viewOptions',
  'lucent.hideAi',
  'lucent.externalEditor',
  'lucent.threads',
  'lucent.checkMissing',
  'lucent.afterExport',
  'lucent.afterExportOpen',
  'lucent.watch',
  'lucent.tetherShow',
  'lucent.smartOnImport',
  'lucent.cardAction',
  'lucent.sizeUnits',
  'lucent.numberLocale',
  'lucent.importDefaults',
  'lucent.previewLimitGb',
  'lucent.previewMaxDays',
  'lucent.keymap',
  'lucent.panels',
  'lucent.panelsSolo',
]

function resetPreferences() {
  for (const k of PREFERENCE_KEYS) {
    try {
      localStorage.removeItem(k)
    } catch {
      /* nothing to remove */
    }
  }
  void api().perfSet(0).catch(() => undefined)
  void api().watchSet(null).catch(() => undefined)
  window.location.reload() // every part of the window reads its setting again
}

/** 1, 2, 4, 8 ... up to the computer's processors, and the number of processors itself. */
export function threadChoices(cores: number): number[] {
  const out = new Set<number>()
  for (let n = 1; n < cores; n *= 2) out.add(n)
  out.add(Math.max(1, Math.min(32, cores)))
  return [...out]
}
const REMINDER_NAMES: Record<number, string> = { 7: 'After a week', 30: 'After a month', 90: 'After three months', 0: 'Never' }

/**
 * Preferences: the previews kept on disk (how much room they take, making them again, clearing them), how Develop behaves,
 * how often to be reminded about a backup, and what this program is made of. Everything here is remembered.
 */
export function PreferencesDialog() {
  const hideAi = usePrefs((s) => s.hideAi)
  const editor = usePrefs((s) => s.externalEditor)
  const threads = usePrefs((s) => s.threads)
  const cardAction = usePrefs((s) => s.cardAction)
  const sizeUnits = usePrefs((s) => s.sizeUnits)
  const numberFormat = usePrefs((s) => s.numberFormat)
  const limitGb = usePrefs((s) => s.previewLimitGb)
  const limitDays = usePrefs((s) => s.previewMaxDays)
  const checkMissing = usePrefs((s) => s.checkMissing)
  const [confirmReset, setConfirmReset] = useState(false)
  const [keyError, setKeyError] = useState<string | null>(null)
  const [, setKeyTick] = useState(0) // the shortcut letters live outside React: this redraws them
  const [perf, setPerf] = useState<PerfState | null>(null)
  const [display, setDisplay] = useState<DisplayProfile | null | undefined>(undefined)
  const [details, setDetails] = useState<CatalogDetails | null>(null)
  const catalogName = useStore((s) => s.info?.name ?? 'Catalog')
  const open = useStore((s) => s.preferencesOpen)
  const close = () => useStore.setState({ preferencesOpen: false })
  const arrows = useSliderPrefs((s) => s.arrows)
  const grid = useCropPrefs((s) => s.grid)
  const reminder = usePrefs((s) => s.reminderDays)
  const themeChoice = useTheme((s) => s.choice)
  const [info, setInfo] = useState<CacheInfo | null>(null)
  const [catalogPath, setCatalogPath] = useState<string | null>(null)
  const [busy, setBusy] = useState<'clear' | 'make' | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [smart, setSmart] = useState<{ built: number; total: number; bytes: number } | null>(null)
  const [smartBusy, setSmartBusy] = useState(false)
  const [smartProgress, setSmartProgress] = useState<Progress | null>(null)
  const [smartNote, setSmartNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let off = () => {}
    let offSmart = () => {}
    void api().on<Progress>('preview:progress', (p) => (setProgress(p), p.done >= p.total && void refresh())).then((u) => (off = u))
    void api().on<Progress>('smart:progress', setSmartProgress).then((u) => (offSmart = u))
    return () => (off(), offSmart())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  useEffect(() => {
    if (open) void api().perfGet().then(setPerf).catch(() => undefined)
    if (open) void api().smartInfo([]).then(setSmart).catch(() => setSmart(null))
    if (open) void api().catalogDetails().then(setDetails).catch(() => setDetails(null))
    if (open) void api().displayProfile().then(setDisplay).catch(() => setDisplay(null))
  }, [open, threads])
  const refresh = () =>
    api()
      .cacheInfo()
      .then(setInfo)
      .catch((e) => setError((e as Error).message))
  useEffect(() => {
    if (!open) return
    setConfirmClear(false)
    setNote(null)
    setError(null)
    setProgress(null)
    void refresh()
    void api()
      .catalogInfo()
      .then((c) => setCatalogPath(c.path))
      .catch(() => {})
  }, [open])

  const make = async (which: 'missing' | 'all') => {
    setBusy('make')
    setError(null)
    setNote(null)
    setProgress(null)
    try {
      const n = await api().cacheRebuild(which)
      setNote(n === 0 ? 'Every preview is already there.' : `Making previews for ${plural(n, 'photo')} in the background. You can keep working.`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
      void refresh()
    }
  }
  const watch = usePrefs((s) => s.watch)
  const tetherShow = usePrefs((s) => s.tetherShow)
  const [watchStatus, setWatchStatus] = useState<WatchStatus | null>(null)
  const [watchError, setWatchError] = useState<string | null>(null)
  useEffect(() => {
    if (open && watch) void api().watchStatus().then(setWatchStatus).catch(() => setWatchStatus(null))
    else setWatchStatus(null)
  }, [open, watch])
  const changeWatch = async (w: WatchConfig) => {
    setWatchError(null)
    try {
      setWatchStatus(await api().watchSet(w))
      usePrefs.getState().setWatch(w)
    } catch (e) {
      usePrefs.getState().setWatch(w) // kept, so the missing part can be filled in
      setWatchError((e as Error).message)
    }
  }
  const chooseWatch = async () => {
    const folder = await api().pickFolder('Choose the folder to watch for new photos')
    if (folder) await changeWatch({ folder, mode: watch?.mode ?? 'add', destination: watch?.destination ?? null })
  }
  const stopWatch = async () => {
    setWatchError(null)
    await api().watchSet(null).catch(() => undefined)
    usePrefs.getState().setWatch(null)
  }
  const refreshSmart = () => void api().smartInfo([]).then(setSmart).catch(() => setSmart(null))
  const buildSmart = async () => {
    setSmartBusy(true)
    setSmartNote(null)
    setSmartProgress(null)
    try {
      const r = await api().smartBuild([])
      setSmartNote(r.failed.length ? `${plural(r.made, 'smart preview')} made; ${r.failed.length} could not be: ${r.failed[0]}` : r.made === 0 ? 'Every photo that can have one already has a smart preview.' : `${plural(r.made, 'smart preview')} made.`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSmartBusy(false)
      refreshSmart()
    }
  }
  const trimNow = async () => {
    setBusy('clear')
    setError(null)
    setNote(null)
    try {
      const r = await api().cacheTrim(limitGb * 1_000_000_000, limitDays)
      setNote(r.removed === 0 ? 'The previews are already within the limits.' : `Discarded ${plural(r.removed, 'preview')}, freeing ${bytesText(r.freed)}. Each is made again when needed.`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
      void refresh()
    }
  }
  const clear = async () => {
    setBusy('clear')
    setError(null)
    setNote(null)
    setConfirmClear(false)
    try {
      setInfo(await api().cacheClear('all'))
      setNote('The previews were cleared. Each one is made again when you look at its photo.')
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onClose={close} title="Preferences" wide busy={busy !== null}>
      <div className="form">
        <fieldset className="export-group">
          <legend>Appearance</legend>
          <div className="field-row">
            <label className="lbl" htmlFor="pref-theme">
              Colour scheme
            </label>
            <select id="pref-theme" className="field" value={themeChoice} onChange={(e) => useTheme.getState().setChoice(e.target.value as ThemeChoice)}>
              <option value="dark">Dark</option>
              <option value="light">Light</option>
              <option value="system">Match my computer</option>
            </select>
          </div>
          <p className="hint">Dark is easier on the eyes for judging colour in a dim room; light suits a bright room. The button in the title bar switches between them.</p>
        </fieldset>

        <fieldset className="export-group">
          <legend>Previews</legend>
          <p className="hint">
            Small pictures of your photos are kept so the grid and Develop are quick. They are copies: your photos are not touched, and every preview can be made again.
          </p>
          {info && (
            <p role="status">
              <strong>{bytesText(info.bytes)}</strong> in {plural(info.files, 'preview file')} for {plural(info.photos, 'photo')} ({bytesText(info.baseBytes)} untouched, {bytesText(info.editedBytes)} showing edits).{' '}
              {info.withoutPreview > 0 ? `${plural(info.withoutPreview, 'photo')} ${info.withoutPreview === 1 ? 'has' : 'have'} no preview.` : 'Every photo has a preview.'}
              {info.editedWithout > 0 ? ` ${plural(info.editedWithout, 'edited photo')} ${info.editedWithout === 1 ? 'has' : 'have'} no edited preview.` : ''}
            </p>
          )}
          {progress && progress.done < progress.total && <ProgressBar done={progress.done} total={progress.total} label="Making previews" />}
          <div className="row">
            <button type="button" className="btn" disabled={busy !== null} onClick={() => void make('missing')}>
              Make missing previews
            </button>
            <button type="button" className="btn" disabled={busy !== null} onClick={() => void make('all')}>
              Make every preview again
            </button>
            {confirmClear ? (
              <>
                <button type="button" className="btn danger" disabled={busy !== null} onClick={() => void clear()}>
                  Yes, clear all previews
                </button>
                <button type="button" className="btn" onClick={() => setConfirmClear(false)}>
                  Keep them
                </button>
              </>
            ) : (
              <button type="button" className="btn" disabled={busy !== null || !info || info.files === 0} onClick={() => setConfirmClear(true)}>
                Clear all previews…
              </button>
            )}
          </div>
          <div className="field-row">
            <label className="lbl" htmlFor="pref-prev-gb">
              Keep previews to at most
            </label>
            <select id="pref-prev-gb" className="field" value={limitGb} onChange={(e) => usePrefs.getState().setPreviewLimits(Number(e.target.value), limitDays)}>
              {PREVIEW_LIMIT_GB.map((g) => (
                <option key={g} value={g}>
                  {g === 0 ? 'No limit' : g + ' GB'}
                </option>
              ))}
            </select>
            <label className="lbl" htmlFor="pref-prev-days">
              Discard previews older than
            </label>
            <select id="pref-prev-days" className="field" value={limitDays} onChange={(e) => usePrefs.getState().setPreviewLimits(limitGb, Number(e.target.value))}>
              {PREVIEW_MAX_DAYS.map((d) => (
                <option key={d} value={d}>
                  {d === 0 ? 'Never' : d + ' days'}
                </option>
              ))}
            </select>
            <button type="button" className="btn" disabled={limitGb === 0 && limitDays === 0} onClick={() => void trimNow()}>
              Apply now
            </button>
          </div>
          <p className="hint">The limits are applied each time the program starts. A preview that is discarded is made again when it is needed, so nothing is lost.</p>
          {note && <p role="status">{note}</p>}
        </fieldset>

        <fieldset className="export-group">
          <legend>Smart previews</legend>
          <p className="hint">
            A smart preview is a copy of a photo, 2560 pixels on the long side, that stays in the catalog. With it you can still edit a photo and export it at up to that size when the original is not there (a drive that is unplugged, a folder that was moved). The edits apply to the original when it comes back. Clearing or limiting the previews does not remove them.
          </p>
          {smart && (
            <p role="status">
              {smart.built === 0 ? 'No photo has a smart preview yet.' : `${plural(smart.built, 'photo')} of ${smart.total} ${smart.built === 1 ? 'has' : 'have'} a smart preview, taking ${bytesText(smart.bytes)}.`}
            </p>
          )}
          {smartProgress && smartProgress.done < smartProgress.total && <ProgressBar done={smartProgress.done} total={smartProgress.total} label="Building smart previews" />}
          <div className="row">
            <button type="button" className="btn" disabled={smartBusy} onClick={() => void buildSmart()}>
              Build smart previews for all photos
            </button>
          </div>
          {smartNote && <p role="status">{smartNote}</p>}
        </fieldset>

        <fieldset className="export-group">
          <legend>Develop</legend>
          <label className="check">
            <input type="checkbox" checked={arrows} onChange={(e) => useSliderPrefs.getState().setArrows(e.target.checked)} /> Show up and down arrows beside each adjustment for fine tuning
          </label>
          <div className="field-row">
            <label className="lbl" htmlFor="pref-grid">
              Grid in the crop frame
            </label>
            <select id="pref-grid" className="field" value={grid} onChange={(e) => useCropPrefs.getState().setGrid(e.target.value as CropGrid)}>
              {GRIDS.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </select>
          </div>
        </fieldset>

        <fieldset className="export-group">
          <legend>Catalog</legend>
          <div className="field-row">
            <label className="lbl" htmlFor="pref-remind">
              Remind me to back up
            </label>
            <select id="pref-remind" className="field" value={reminder} onChange={(e) => usePrefs.getState().setReminderDays(Number(e.target.value) as ReminderDays)}>
              {REMINDER_CHOICES.map((d) => (
                <option key={d} value={d}>
                  {REMINDER_NAMES[d]}
                </option>
              ))}
            </select>
          </div>
          <label>
            <input type="checkbox" checked={checkMissing} onChange={(e) => usePrefs.getState().setCheckMissing(e.target.checked)} /> Look for photos whose files are gone each time the program starts
          </label>
          <p className="hint">The reminder shows in the Catalogs window. Backups and sidecar files are made from there too.</p>
        </fieldset>

        <fieldset className="export-group">
          <legend>Keyboard shortcuts</legend>
          {REMAPPABLE.map((r) => (
            <div className="field-row" key={r.id}>
              <label className="lbl" htmlFor={`key-${r.id}`}>
                {r.label}
              </label>
              <input
                id={`key-${r.id}`}
                className="field key-field"
                type="text"
                maxLength={1}
                size={2}
                value={keyFor(r.id).toUpperCase()}
                onFocus={(e) => e.currentTarget.select()}
                onChange={(e) => {
                  const v = e.target.value
                  if (v === '') return
                  setKeyError(setKey(r.id, v))
                  setKeyTick((n) => n + 1)
                }}
              />
            </div>
          ))}
          {keyError && (
            <p className="err" role="alert">
              {keyError}
            </p>
          )}
          <div className="field-row">
            <button
              type="button"
              className="btn sm"
              onClick={() => {
                resetKeys()
                setKeyError(null)
                setKeyTick((n) => n + 1)
              }}
            >
              Put every shortcut back
            </button>
          </div>
          <p className="hint">Letters only. Numbers, arrows, Delete and the Ctrl keys keep their places. The Help screen shows the letters you chose.</p>
        </fieldset>

        <fieldset className="export-group">
          <legend>Display</legend>
          <p role="status">
            {display === undefined ? 'Looking for the display profile…' : display === null ? 'Windows does not say which colour profile this display uses.' : `Display profile: ${display.name}`}
          </p>
          {display && display.path && <p className="hint">{display.path}</p>}
          <p className="hint">
            Photos are edited and shown in sRGB, and each picture is tagged sRGB. The window converts them to your display's profile when it draws them, so colours are right on a calibrated or wide-gamut screen without anything to set. {display && !display.isSrgb ? 'This display is not plain sRGB: the colours beyond sRGB it can show are not used by the edits.' : ''}
          </p>
        </fieldset>

        <fieldset className="export-group">
          <legend>Reset</legend>
          {!confirmReset ? (
            <button type="button" className="btn sm" onClick={() => setConfirmReset(true)}>
              Reset all preferences…
            </button>
          ) : (
            <div className="field-row">
              <span>Put every setting on this page back to how the program came? Your catalogs, photos, presets, saved filters and licence are not touched.</span>
              <button type="button" className="btn sm danger" onClick={resetPreferences}>
                Yes, reset them
              </button>
              <button type="button" className="btn sm" onClick={() => setConfirmReset(false)}>
                Keep them
              </button>
            </div>
          )}
        </fieldset>

        <fieldset className="export-group">
          <legend>Updates</legend>
          <ul className="plain-list">
            <li>This program never updates itself, never asks for a new purchase to keep working, and never stops you opening your photos.</li>
            <li>A licence key for version 1 works in every 1.x version.</li>
            <li>When a newer version needs a different catalog layout, a copy of your catalog is made first (in the catalog's backups folder), and the older program can still be installed.</li>
            <li>Your edits can also be kept beside the photos as sidecar files (Catalogs &gt; Sidecar files), so they survive without the catalog.</li>
          </ul>
        </fieldset>

        <fieldset className="export-group">
          <legend>This catalog</legend>
          {details ? (
            <dl className="meta">
              <dt>Name</dt>
              <dd>{catalogName}</dd>
              <dt>Photos</dt>
              <dd>{plural(details.photos, 'photo')}{details.virtualCopies > 0 ? `, ${plural(details.virtualCopies, 'virtual copy')}` : ''}, {plural(details.edited, 'edited photo')}</dd>
              <dt>Organised in</dt>
              <dd>{plural(details.folders, 'folder')}, {plural(details.collections, 'collection')}, {plural(details.keywords, 'keyword')}</dd>
              <dt>The catalog file</dt>
              <dd>{bytesText(details.catalogBytes)}</dd>
              <dt>Previews</dt>
              <dd>{bytesText(details.previewsBytes)}</dd>
              <dt>Layout version</dt>
              <dd>{details.schemaVersion}</dd>
            </dl>
          ) : (
            <p className="hint">Reading the catalog…</p>
          )}
          <p className="hint">Each catalog keeps its own backups and sidecar settings: see the Catalogs window.</p>
        </fieldset>

        <fieldset className="export-group">
          <legend>Language and units</legend>
          <div className="field-row">
            <label className="lbl" htmlFor="pref-lang">
              Language
            </label>
            <select id="pref-lang" className="field" value="en" disabled>
              <option value="en">English</option>
            </select>
          </div>
          <p className="hint">English is the only language so far.</p>
          <div className="field-row">
            <label className="lbl" htmlFor="pref-numbers">
              Numbers
            </label>
            <select id="pref-numbers" className="field" value={numberFormat} onChange={(e) => usePrefs.getState().setNumberFormat(e.target.value as NumberFormat)}>
              <option value="system">As my computer does ({numberMarks().group === ' ' ? '1 234' : '1' + numberMarks().group + '234'}{numberMarks().decimal}5)</option>
              <option value="en">English (1,234.5)</option>
              <option value="de">German (1.234,5)</option>
              <option value="fr">French (1 234,5)</option>
            </select>
          </div>
          <p className="hint">How numbers are shown, for instance on the sliders. Typing either a point or a comma for the fraction is understood.</p>
          <div className="field-row">
            <label className="lbl" htmlFor="pref-units">
              File sizes
            </label>
            <select id="pref-units" className="field" value={sizeUnits} onChange={(e) => usePrefs.getState().setSizeUnits(e.target.value as SizeUnits)}>
              <option value="decimal">GB, MB (1 GB is a thousand million bytes)</option>
              <option value="binary">GiB, MiB (1 GiB is 1024 x 1024 x 1024 bytes)</option>
            </select>
          </div>
        </fieldset>

        <fieldset className="export-group">
          <legend>Watched folder</legend>
          <p className="hint">Photos that appear in this folder (from a camera program, a card reader or another computer) are imported by themselves, a few seconds after they have been written. It works while the program is open.</p>
          <div className="field-row">
            <span className="lbl">Folder</span>
            <button type="button" className="btn sm" onClick={() => void chooseWatch()}>
              Choose folder…
            </button>
            <span className="path" title={watch?.folder ?? ''}>
              {watch?.folder ?? 'None: nothing is watched'}
            </span>
            {watch && (
              <button type="button" className="btn sm" onClick={() => void stopWatch()}>
                Stop watching
              </button>
            )}
          </div>
          {watch && (
            <>
              <div className="field-row">
                <label className="lbl" htmlFor="pref-watch-mode">
                  What to do with them
                </label>
                <select id="pref-watch-mode" className="field" value={watch.mode} onChange={(e) => void changeWatch({ ...watch, mode: e.target.value as WatchConfig['mode'] })}>
                  <option value="add">Import them where they are</option>
                  <option value="move">Move them into a folder, by date</option>
                  <option value="copy">Copy them into a folder, by date</option>
                </select>
              </div>
              {watch.mode !== 'add' && (
                <div className="field-row">
                  <span className="lbl">File them in</span>
                  <button type="button" className="btn sm" onClick={async () => void changeWatch({ ...watch, destination: (await api().pickFolder('Choose the destination folder for the photos')) ?? watch.destination })}>
                    Choose folder…
                  </button>
                  <span className="path" title={watch.destination ?? ''}>
                    {watch.destination ?? 'Not chosen yet'}
                  </span>
                </div>
              )}
              <label className="check">
                <input type="checkbox" checked={tetherShow} onChange={(e) => usePrefs.getState().setTetherShow(e.target.checked)} /> Show each new photo big as it arrives (for shooting with the camera connected to its own program, which saves into this folder)
              </label>
              {watchStatus && <p role="status">{watchStatus.error ? watchStatus.error : `Watching. ${plural(watchStatus.imported, 'photo')} imported since it was switched on.`}</p>}
            </>
          )}
          {watchError && (
            <p className="err" role="alert">
              {watchError}
            </p>
          )}
        </fieldset>

        <fieldset className="export-group">
          <legend>Memory cards</legend>
          <div className="field-row">
            <label className="lbl" htmlFor="pref-card">
              When a memory card is plugged in
            </label>
            <select id="pref-card" className="field" value={cardAction} onChange={(e) => usePrefs.getState().setCardAction(e.target.value as CardAction)}>
              <option value="tell">Tell me</option>
              <option value="open">Open the Import window with the card chosen</option>
              <option value="nothing">Do nothing</option>
            </select>
          </div>
        </fieldset>

        <fieldset className="export-group">
          <legend>Performance</legend>
          <div className="field-row">
            <label className="lbl" htmlFor="pref-threads">
              Processor threads
            </label>
            <select id="pref-threads" className="field" value={threads} onChange={(e) => usePrefs.getState().setThreads(Number(e.target.value))}>
              <option value={0}>Automatic{perf ? ` (${perf.automatic})` : ''}</option>
              {threadChoices(perf?.cores ?? 4).map((n) => (
                <option key={n} value={n}>
                  {n === 1 ? '1 thread' : `${n} threads`}
                </option>
              ))}
            </select>
          </div>
          <p className="hint">How many processor threads previews, exports, face finding and enlarging may use at once. Fewer leaves the computer freer for other work; more finishes batches sooner. The program does its work on the processor: there is no graphics card path, so there is no GPU switch.</p>
        </fieldset>

        <fieldset className="export-group">
          <legend>External editor</legend>
          <div className="field-row">
            <label className="lbl" htmlFor="pref-editor">
              Program
            </label>
            <input id="pref-editor" className="field" type="text" value={editor} placeholder="Windows chooses (or paste the .exe path)" onChange={(e) => usePrefs.getState().setExternalEditor(e.target.value)} />
          </div>
          <p className="hint">"Open in external editor" in the Library sends the selected photo's original file to this program, for example C:\Program Files\Adobe\Adobe Photoshop 2025\Photoshop.exe. Left empty, Windows opens it with the program it normally uses for that kind of file.</p>
        </fieldset>

        <fieldset className="export-group">
          <legend>AI tools</legend>
          <label>
            <input type="checkbox" checked={hideAi} onChange={(e) => usePrefs.getState().setHideAi(e.target.checked)} /> Hide every tool that uses an AI model
          </label>
          <p className="hint">Hidden: {AI_TOOLS.join(', ')}. Everything else keeps working, and nothing you already made with them is removed. Turn it off to see them again.</p>
        </fieldset>

        <LicenceSection open={open} />

        <fieldset className="export-group">
          <legend>About</legend>
          <p>
            <strong>Lucent Raw</strong> version {APP_VERSION}. Your catalog is kept in <span className="path">{catalogPath ?? '…'}</span>.
          </p>
          <p className="hint">Built with other people's work. The main parts and their licences:</p>
          <ul className="plain-list" aria-label="What Lucent Raw is built with">
            {COMPONENTS.map((c) => (
              <li key={c.name}>
                {c.name} for {c.use}: {c.licence}
              </li>
            ))}
          </ul>
          <p className="hint">
            The complete list of code libraries and the licence texts are in the licences folder that comes with the program, and in THIRD_PARTY.md.
          </p>
          <details className="privacy-policy">
            <summary>Privacy policy</summary>
            <pre className="hint" style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{privacyPolicy}</pre>
          </details>
          <details className="privacy-policy">
            <summary>Terms and conditions</summary>
            <pre className="hint" style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit' }}>{terms}</pre>
          </details>
        </fieldset>
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="dialog-foot">
        <button type="button" className="btn" disabled={busy !== null} onClick={close}>
          Done
        </button>
      </div>
    </Dialog>
  )
}
