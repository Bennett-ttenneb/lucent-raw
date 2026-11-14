import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { usePrefs, type AfterExportOpen } from '../lib/prefs'
import { api } from '../lib/api'
import { BUILTIN_EXPORT_PRESETS, DEFAULT_WATERMARK, colourOf, deleteUserPreset, edgeIsValid, exportProblem, folderProblem, hexOf, loadFolderPref, loadLastExport, loadUserPresets, matchingPreset, normaliseSettings, saveFolderPref, saveLastExport, saveUserPreset, type ExportPreset } from '../lib/exportSettings'
import { plural } from '../lib/format'
import { fillStyle } from './SliderRow'
import { useStore } from '../lib/store'
import { ANCHORS, COLOUR_SPACES, EXPORT_FORMATS, SIZE_MODES, type SizeMode, type Anchor, type ColourSpace, type ExportCaption, type ExportFormat, type ExportResult, type EnlargeMethod, type ExportSettings, type Progress, type SharpenFor } from '../lib/types'
import { Dialog, ProgressBar } from './Primitives'
import { SliderRow } from './SliderRow'
import { usePanels } from '../lib/panels'

/** A part of the dialog that can be folded away; whether it is open is remembered between launches. */
function Section({ title, busy, children }: { title: string; busy: boolean; children: ReactNode }) {
  const key = `export: ${title}`
  const open = usePanels((s) => s.open[key] ?? true)
  return (
    <details className="export-group export-section" open={open} onToggle={(e) => usePanels.getState().set(key, (e.currentTarget as HTMLDetailsElement).open)}>
      <summary>{title}</summary>
      <fieldset disabled={busy}>
        <legend className="sr-only">{title}</legend>
        {children}
      </fieldset>
    </details>
  )
}

const CAPTION_FIELDS: { key: 'camera' | 'lens' | 'focal' | 'aperture' | 'shutter' | 'iso' | 'date'; label: string }[] = [
  { key: 'camera', label: 'Camera' },
  { key: 'lens', label: 'Lens' },
  { key: 'focal', label: 'Focal length' },
  { key: 'aperture', label: 'Aperture' },
  { key: 'shutter', label: 'Shutter speed' },
  { key: 'iso', label: 'ISO' },
  { key: 'date', label: 'Date' },
]

export function ExportDialog() {
  const open = useStore((s) => s.exportOpen)
  const close = () => useStore.setState({ exportOpen: false })
  const [dest, setDest] = useState<string | null>(null)
  const [settings, setSettings] = useState<ExportSettings>(loadLastExport)
  const [edgeText, setEdgeText] = useState(String(settings.longEdge))
  const hideAi = usePrefs((s) => s.hideAi)
  const [userPresets, setUserPresets] = useState<ExportPreset[]>(loadUserPresets)
  const [presetName, setPresetName] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState<Progress>({ done: 0, total: 0 })
  const [result, setResult] = useState<ExportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ids, setIds] = useState<number[]>([])
  const [folder, setFolder] = useState(loadFolderPref)
  const [bump, setBump] = useState(0)
  const latest = useRef(settings)
  latest.current = settings
  const previewing = useRef({ running: false, dirty: false })
  const [preview, setPreview] = useState<{ url: string | null; busy: boolean; error: string | null }>({ url: null, busy: false, error: null })

  const set = (patch: Partial<ExportSettings>) => setSettings((s) => ({ ...s, ...patch }))
  const setMark = (patch: Partial<ExportSettings['watermark']>) => setSettings((s) => ({ ...s, watermark: { ...s.watermark, ...patch } }))
  const setBorder = (patch: Partial<ExportSettings['border']>) => setSettings((s) => ({ ...s, border: { ...s.border, ...patch } }))
  const setCaption = (patch: Partial<ExportCaption>) => setSettings((s) => ({ ...s, border: { ...s.border, caption: { ...s.border.caption, ...patch } } }))

  useEffect(() => {
    if (open) {
      setIds(useStore.getState().targetIds())
      setResult(null)
      setError(null)
      setBusy(false)
      const patch = useStore.getState().exportPatch
      const last = patch ? normaliseSettings({ ...loadLastExport(), ...patch }) : loadLastExport()
      if (patch) useStore.setState({ exportPatch: null })
      setSettings(last)
      setEdgeText(String(last.longEdge))
      setUserPresets(loadUserPresets())
      setFolder(loadFolderPref())
    }
  }, [open])
  useEffect(() => {
    if (open) saveFolderPref(folder)
  }, [open, folder])
  useEffect(() => {
    let off = () => {}
    void api().on<Progress>('export:progress', setProgress).then((u) => (off = u))
    return () => off()
  }, [])
  const [tiles, setTiles] = useState<Progress | null>(null)
  useEffect(() => {
    let off = () => {}
    void api().on<Progress>('enlarge:progress', setTiles).then((u) => (off = u))
    return () => off()
  }, [])
  // what was chosen is what comes back next time
  const key = JSON.stringify(settings)
  // written a moment after the last change, so that dragging a slider is not a disk write for every pixel
  useEffect(() => {
    if (!open) return
    const t = setTimeout(() => saveLastExport(settings), 300)
    // closing the dialog or the page inside that moment must not lose the last change
    const flush = () => saveLastExport(settings)
    window.addEventListener('pagehide', flush)
    return () => {
      clearTimeout(t)
      window.removeEventListener('pagehide', flush)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, key])
  useEffect(() => {
    if (!open) return
    return () => saveLastExport(latest.current)
  }, [open])

  // a picture of the first photo as it would come out, a moment after the settings stop changing
  useEffect(() => {
    if (!open || ids.length === 0) return
    let alive = true
    // one picture is made at a time, and only for the newest settings: while the engine is busy with one, a drag of a slider
    // just notes that the settings have moved on, and the picture for where it stopped is made when the busy one is done
    const t = setTimeout(async () => {
      const q = previewing.current
      if (q.running) {
        q.dirty = true
        return
      }
      q.running = true
      setPreview((p) => ({ ...p, busy: true, error: null }))
      try {
        const url = await api().exportPreview(ids[0], settings)
        if (alive) setPreview({ url, busy: false, error: null })
      } catch (e) {
        if (alive) setPreview((p) => ({ ...p, busy: false, error: (e as Error).message }))
      } finally {
        q.running = false
        if (q.dirty) {
          q.dirty = false
          setBump((b) => b + 1)
        }
      }
    }, 250)
    return () => {
      alive = false
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, ids, key, bump])

  const edgeOk = edgeIsValid(edgeText)
  const folderBad = folder.on ? folderProblem(folder.name) : null
  const problem = exportProblem(settings)
  const matched = useMemo(() => matchingPreset(settings, userPresets), [settings, userPresets])
  const isUserPreset = matched !== null && userPresets.some((p) => p.name === matched)

  const apply = (name: string) => {
    const p = [...BUILTIN_EXPORT_PRESETS, ...userPresets].find((x) => x.name === name)
    if (!p) return
    setSettings(JSON.parse(JSON.stringify(p.settings)) as ExportSettings)
    setEdgeText(String(p.settings.longEdge))
  }

  const run = async () => {
    if (!dest) return
    setBusy(true)
    setError(null)
    try {
      const r = await api().exportRun(ids, dest, settings, folder.on ? folder.name.trim() : null)
      setResult(r)
      if (r.written > 0 && usePrefs.getState().afterExport === 'folder') void api().openFolder(r.folder).catch(() => undefined)
      const open = usePrefs.getState().afterExportOpen
      if (r.written > 0 && open !== 'no') {
        const editor = open === 'editor' ? usePrefs.getState().externalEditor.trim() || null : null
        for (const file of r.files.slice(0, 10)) void api().openInEditor(file, editor).catch((e: Error) => setError(e.message))
      }
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const afterFolder = usePrefs((s) => s.afterExport) === 'folder'
  const afterOpen = usePrefs((s) => s.afterExportOpen)
  const lossless = settings.format !== 'jpeg'
  const wm = settings.watermark
  const bd = settings.border

  return (
    <Dialog open={open} onClose={close} title="Export photos" busy={busy} wide xl>
      <div className="export-grid">
        <div className="form export-options">
          <p>{ids.length === 0 ? 'Select at least one photo first.' : `Exporting ${plural(ids.length, 'photo')}.`}</p>
          <div className="field-row">
            <span className="lbl">To</span>
            <button className="btn" disabled={busy} onClick={async () => setDest(await api().pickFolder('Choose the destination folder'))}>
              Choose folder…
            </button>
            <span className="path" title={dest ?? ''}>
              {dest ?? 'Nothing chosen yet'}
            </span>
          </div>
          <div className="field-row">
            <label className="check">
              <input type="checkbox" checked={folder.on} disabled={busy} onChange={(e) => setFolder((f) => ({ ...f, on: e.target.checked }))} /> Put the files in a new folder
            </label>
            {folder.on && (
              <>
                <input className="field" type="text" aria-label="New folder name" maxLength={100} value={folder.name} disabled={busy} aria-invalid={!!folderBad} onChange={(e) => setFolder((f) => ({ ...f, name: e.target.value }))} />
                {folderBad && (
                  <span className="err" role="alert">
                    {folderBad}
                  </span>
                )}
              </>
            )}
          </div>

          <div className="field-row">
            <label className="lbl" htmlFor="preset">
              Preset
            </label>
            <select id="preset" className="field" value={matched ?? ''} disabled={busy} onChange={(e) => apply(e.target.value)}>
              {matched === null && <option value="">Your own settings</option>}
              <optgroup label="Built in">
                {BUILTIN_EXPORT_PRESETS.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </optgroup>
              {userPresets.length > 0 && (
                <optgroup label="Yours">
                  {userPresets.map((p) => (
                    <option key={p.name} value={p.name}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              )}
            </select>
            {isUserPreset && (
              <button className="btn sm" disabled={busy} onClick={() => setUserPresets(deleteUserPreset(matched!))}>
                Delete preset
              </button>
            )}
          </div>
          <div className="field-row">
            <label className="lbl" htmlFor="presetname">
              Save these
            </label>
            <input id="presetname" className="field" type="text" placeholder="Name for a new preset" maxLength={60} value={presetName} onChange={(e) => setPresetName(e.target.value)} disabled={busy} />
            <button
              className="btn sm"
              disabled={busy || presetName.trim() === ''}
              onClick={() => {
                setUserPresets(saveUserPreset(presetName, settings))
                setPresetName('')
              }}
            >
              Save as preset
            </button>
          </div>

          <Section title="File and size" busy={busy}>
          <div className="field-row">
            <label className="lbl" htmlFor="format">
              Format
            </label>
            <select id="format" className="field" value={settings.format} disabled={busy} onChange={(e) => set({ format: e.target.value as ExportFormat })}>
              {EXPORT_FORMATS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </div>
          {!lossless && (
            <div className="field-row">
              <label className="lbl" htmlFor="q">
                Quality
              </label>
              <input id="q" type="range" min={10} max={100} style={fillStyle(settings.quality, 10, 100)} value={settings.quality} onChange={(e) => set({ quality: Number(e.target.value) })} disabled={busy} />
              <output>{settings.quality}</output>
            </div>
          )}
          {settings.format === 'dng' && <p className="hint">The photo's RAW file is written again as a DNG (the open RAW format), with the picture data unchanged, so other programs can read it. Edits, size, sharpening, watermark, border and colour space are not applied, and a photo that is not a RAW photo is reported as failed.</p>}
          {settings.format === 'original' && <p className="hint">The photo's own file is copied as it is, with its sidecar file when it has one. Edits, size, sharpening, watermark, border and colour space are not applied.</p>}
          {lossless && settings.format !== 'original' && settings.format !== 'dng' && <p className="hint">{settings.format === 'tiff' ? 'TIFF keeps every detail and makes large files.' : settings.format === 'png' ? 'PNG keeps every detail and makes large files.' : 'Lossless WebP keeps every detail in a smaller file than PNG.'}</p>}
          <div className="field-row">
            <label className="lbl" htmlFor="size-mode">
              Size by
            </label>
            <select id="size-mode" className="field" value={settings.sizeMode} onChange={(e) => set({ sizeMode: e.target.value as SizeMode })} disabled={busy}>
              {SIZE_MODES.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          {settings.sizeMode === 'dimensions' && (
            <div className="field-row">
              <label className="lbl" htmlFor="size-w">
                Width (px)
              </label>
              <input id="size-w" className="field narrow" type="number" min={0} max={20000} value={settings.width} onChange={(e) => set({ width: Math.max(0, Math.min(20000, Math.round(Number(e.target.value) || 0))) })} disabled={busy} />
              <label className="lbl" htmlFor="size-h">
                Height (px)
              </label>
              <input id="size-h" className="field narrow" type="number" min={0} max={20000} value={settings.height} onChange={(e) => set({ height: Math.max(0, Math.min(20000, Math.round(Number(e.target.value) || 0))) })} disabled={busy} />
              <span className="hint">The picture fits inside this box and keeps its shape. 0 leaves that direction free.</span>
            </div>
          )}
          {settings.sizeMode === 'percent' && (
            <div className="field-row">
              <label className="lbl" htmlFor="size-p">
                Percentage
              </label>
              <input id="size-p" className="field narrow" type="number" min={1} max={1000} value={settings.percent} onChange={(e) => set({ percent: Math.max(1, Math.min(1000, Number(e.target.value) || 1)) })} disabled={busy} />
              <span className="hint">Of the size the edits and the crop leave. 100 keeps it.</span>
            </div>
          )}
          {settings.sizeMode === 'megapixels' && (
            <div className="field-row">
              <label className="lbl" htmlFor="size-mp">
                Megapixels
              </label>
              <input id="size-mp" className="field narrow" type="number" min={0.1} max={500} step={0.1} value={settings.megapixels} onChange={(e) => set({ megapixels: Math.max(0.1, Math.min(500, Number(e.target.value) || 0.1)) })} disabled={busy} />
              <span className="hint">The picture is made about this many million pixels, keeping its shape.</span>
            </div>
          )}
          {settings.sizeMode === 'longEdge' && (
          <div className="field-row">
            <label className="lbl" htmlFor="edge">
              Longest side (px)
            </label>
            <input
              id="edge"
              className="field narrow"
              type="number"
              min={0}
              max={20000}
              value={edgeText}
              aria-invalid={!edgeOk}
              aria-describedby="edge-h"
              onChange={(e) => {
                setEdgeText(e.target.value)
                if (edgeIsValid(e.target.value)) set({ longEdge: Number(e.target.value) })
              }}
              disabled={busy}
            />
            <span id="edge-h" className="hint">
              {edgeOk ? '0 keeps the original size' : 'Enter a whole number from 0 to 20000'}
            </span>
          </div>
          )}
          <div className="field-row">
            <label className="lbl" htmlFor="dpi">
              Resolution (ppi)
            </label>
            <input id="dpi" className="field narrow" type="number" min={36} max={2400} value={settings.dpi} onChange={(e) => set({ dpi: Math.max(36, Math.min(2400, Math.round(Number(e.target.value) || 300))) })} disabled={busy || settings.format === 'webp' || settings.format === 'original' || settings.format === 'dng'} />
            <span className="hint">{settings.format === 'webp' || settings.format === 'original' || settings.format === 'dng' ? 'Not written for this kind of file.' : 'Pixels to the inch, for a printer or a layout program. The pixels themselves do not change.'}</span>
          </div>
          <div className="field-row">
            <label className="lbl" htmlFor="space">
              Colour space
            </label>
            <select id="space" className="field" value={settings.colourSpace} onChange={(e) => set({ colourSpace: e.target.value as ColourSpace })} disabled={busy} aria-describedby="space-h">
              {COLOUR_SPACES.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>
          <p id="space-h" className="hint">
            {settings.colourSpace === 'srgb' ? 'sRGB works everywhere.' : 'The file is tagged with this profile. Lucent Raw edits in sRGB, so this space labels the colours correctly but cannot add colours beyond sRGB.'}
          </p>
          <div className="field-row">
            <label className="lbl" htmlFor="enlarge">
              Enlarge small photos
            </label>
            <select id="enlarge" className="field" value={hideAi && settings.enlarge === 'ai' ? 'smooth' : settings.enlarge} onChange={(e) => set({ enlarge: e.target.value as EnlargeMethod })} disabled={busy} aria-describedby="enlarge-h">
              <option value="none">No, keep their size</option>
              <option value="smooth">Yes, smooth</option>
              {!hideAi && <option value="ai">Yes, with AI (slow)</option>}
            </select>
          </div>
          <p id="enlarge-h" className="hint">
            Only used when the longest side above is more than the photo has. Photos are never made smaller by this. The preview shows the photo at a smaller size, so it does not show the enlarging.
          </p>
          <div className="field-row">
            <label className="check">
              <input type="checkbox" checked={settings.cameraInfo} disabled={busy || lossless} onChange={(e) => set({ cameraInfo: e.target.checked })} aria-describedby="camera-h" /> Keep camera details in the file
            </label>
          </div>
          <p id="camera-h" className="hint">
            {lossless ? 'Only JPEG files can carry them here.' : 'Camera, lens, exposure and when it was taken. Where the photo was taken is never copied.'}
          </p>
          <div className="field-row">
            <label className="lbl" htmlFor="meta-level">
              Details in the file
            </label>
            <select id="meta-level" className="field" value={settings.metadata} disabled={busy || settings.format === 'tiff' || settings.format === 'webp' || settings.format === 'original' || settings.format === 'dng'} onChange={(e) => set({ metadata: e.target.value as ExportSettings['metadata'] })} aria-describedby="meta-h">
              <option value="none">None</option>
              <option value="copyright">Copyright: creator, copyright, credit, source, usage terms</option>
              <option value="all">Everything: also title, caption, headline, place and keywords</option>
            </select>
          </div>
          <p id="meta-h" className="hint">
            {settings.format === 'tiff' || settings.format === 'webp' ? 'Only JPEG and PNG files can carry them here.' : 'Written from the Metadata panel into the file, so it travels with the picture. Private keywords, ratings, flags and labels are never written.'}
          </p>
          <div className="field-row">
            <label className="lbl" htmlFor="sharpen">
              Sharpening
            </label>
            <select id="sharpen" className="field" value={settings.sharpen} onChange={(e) => set({ sharpen: e.target.value as SharpenFor })} disabled={busy}>
              <option value="none">None</option>
              <option value="screen">For screen</option>
              <option value="print">For print</option>
            </select>
          </div>
          <div className="field-row">
            <label className="lbl" htmlFor="names">
              File names
            </label>
            <input id="names" className="field" type="text" maxLength={120} value={settings.nameTemplate} onChange={(e) => set({ nameTemplate: e.target.value })} disabled={busy} aria-describedby="names-h" />
          </div>
          <p id="names-h" className="hint">
            Use {'{name}'} (the photo's own name), {'{date}'}, {'{seq}'} (001, 002 …) and {'{camera}'}. A name already taken gets a number added.
          </p>

          </Section>

          <Section title="Watermark" busy={busy}>
            <div className="row" role="radiogroup" aria-label="Watermark">
              {(['none', 'text', 'image'] as const).map((k) => (
                <label key={k}>
                  <input type="radio" name="wm-kind" checked={wm.kind === k} onChange={() => setMark({ kind: k })} /> {k === 'none' ? 'None' : k === 'text' ? 'Text' : 'Logo image'}
                </label>
              ))}
            </div>
            {wm.kind === 'text' && (
              <div className="field-row">
                <label className="lbl" htmlFor="wm-text">
                  Text
                </label>
                <input id="wm-text" className="field" type="text" maxLength={200} value={wm.text} onChange={(e) => setMark({ text: e.target.value })} />
              </div>
            )}
            {wm.kind === 'image' && (
              <div className="field-row">
                <span className="lbl">Logo</span>
                <button
                  className="btn"
                  onClick={async () => {
                    const p = await api().pickImage('Choose the logo to put on your photos')
                    if (p) setMark({ imagePath: p })
                  }}
                >
                  Choose image…
                </button>
                <span className="path" title={wm.imagePath}>
                  {wm.imagePath || 'Nothing chosen yet'}
                </span>
              </div>
            )}
            {wm.kind !== 'none' && (
              <>
                <div className="anchors" role="radiogroup" aria-label="Watermark position">
                  {ANCHORS.map((a) => (
                    <label key={a.id} className={wm.anchor === a.id ? 'on' : ''}>
                      <input type="radio" name="wm-anchor" aria-label={a.label} checked={wm.anchor === a.id} onChange={() => setMark({ anchor: a.id as Anchor })} />
                      <span aria-hidden />
                    </label>
                  ))}
                </div>
                <SliderRow id="sl-wm-size" label="Watermark size" value={wm.size} min={1} max={wm.kind === 'text' ? 20 : 60} step={0.5} digits={1} neutral={DEFAULT_WATERMARK.size} onLive={(v) => setMark({ size: v })} onCommit={() => undefined} onReset={() => setMark({ size: DEFAULT_WATERMARK.size })} />
                <SliderRow id="sl-wm-opacity" label="Watermark opacity" value={wm.opacity} min={0} max={100} step={1} digits={0} neutral={DEFAULT_WATERMARK.opacity} onLive={(v) => setMark({ opacity: v })} onCommit={() => undefined} onReset={() => setMark({ opacity: DEFAULT_WATERMARK.opacity })} />
                <SliderRow id="sl-wm-margin" label="Watermark margin" value={wm.margin} min={0} max={20} step={0.5} digits={1} neutral={DEFAULT_WATERMARK.margin} onLive={(v) => setMark({ margin: v })} onCommit={() => undefined} onReset={() => setMark({ margin: DEFAULT_WATERMARK.margin })} />
              </>
            )}
            {wm.kind === 'text' && (
              <div className="row">
                <label>
                  Text colour <input type="color" aria-label="Watermark colour" value={hexOf(wm.colour)} onChange={(e) => setMark({ colour: colourOf(e.target.value) })} />
                </label>
                <label>
                  <input type="checkbox" checked={wm.shadow} onChange={(e) => setMark({ shadow: e.target.checked })} /> Soft shadow
                </label>
              </div>
            )}
          </Section>

          <Section title="Border and camera settings" busy={busy}>
            <label>
              <input type="checkbox" checked={bd.enabled} onChange={(e) => setBorder({ enabled: e.target.checked })} /> Add a border round the photo
            </label>
            {bd.enabled && (
              <>
                <SliderRow id="sl-border-width" label="Border width" value={bd.width} min={0} max={20} step={0.5} digits={1} neutral={4} onLive={(v) => setBorder({ width: v })} onCommit={() => undefined} onReset={() => setBorder({ width: 4 })} />
                <div className="row">
                  <label>
                    Border colour <input type="color" aria-label="Border colour" value={hexOf(bd.colour)} onChange={(e) => setBorder({ colour: colourOf(e.target.value) })} />
                  </label>
                  <button className="btn sm" onClick={() => setBorder({ colour: [255, 255, 255] })}>
                    White
                  </button>
                  <button className="btn sm" onClick={() => setBorder({ colour: [0, 0, 0] })}>
                    Black
                  </button>
                </div>
                <label>
                  <input type="checkbox" checked={bd.caption.show} onChange={(e) => setCaption({ show: e.target.checked })} /> Show the camera settings under the photo
                </label>
                {bd.caption.show && (
                  <>
                    <div className="row" role="group" aria-label="Settings to show">
                      {CAPTION_FIELDS.map((f) => (
                        <label key={f.key}>
                          <input type="checkbox" checked={bd.caption[f.key]} onChange={(e) => setCaption({ [f.key]: e.target.checked })} /> {f.label}
                        </label>
                      ))}
                    </div>
                    <div className="field-row">
                      <label className="lbl" htmlFor="caption-note">
                        Your own line
                      </label>
                      <input id="caption-note" className="field" type="text" maxLength={200} placeholder="A title or a credit (optional)" value={bd.caption.note} onChange={(e) => setCaption({ note: e.target.value })} />
                    </div>
                    <div className="field-row">
                      <label className="lbl" htmlFor="caption-layout">
                        Layout
                      </label>
                      <select id="caption-layout" className="field" value={bd.caption.layout} onChange={(e) => setCaption({ layout: e.target.value as ExportCaption['layout'] })}>
                        <option value="grouped">Two lines: camera and lens, then the settings</option>
                        <option value="single">One line: everything together</option>
                        <option value="items">One line for each item</option>
                      </select>
                    </div>
                    <div className="field-row">
                      <label className="lbl" htmlFor="caption-separator">
                        Between items
                      </label>
                      <select id="caption-separator" className="field" value={bd.caption.separator} disabled={bd.caption.layout === 'items'} onChange={(e) => setCaption({ separator: e.target.value as ExportCaption['separator'] })}>
                        <option value="dot">A dot  ·</option>
                        <option value="bar">A bar  |</option>
                        <option value="slash">A slash  /</option>
                        <option value="gap">Space only</option>
                      </select>

                    </div>
                    <SliderRow id="sl-caption-spacing" label="Space round the separator" value={bd.caption.spacing} min={0} max={12} step={1} digits={0} neutral={2} onLive={(v) => setCaption({ spacing: v })} onCommit={() => undefined} onReset={() => setCaption({ spacing: 2 })} />
                    <SliderRow id="sl-caption-size" label="Letter size" value={bd.caption.size} min={0.8} max={4} step={0.1} digits={1} neutral={1.6} onLive={(v) => setCaption({ size: v })} onCommit={() => undefined} onReset={() => setCaption({ size: 1.6 })} />
                    <div className="field-row">
                      <label className="lbl" htmlFor="caption-weight">
                        Letters
                      </label>
                      <select id="caption-weight" className="field" value={bd.caption.weight} onChange={(e) => setCaption({ weight: e.target.value as ExportCaption['weight'] })}>
                        <option value="light">Light</option>
                        <option value="regular">Regular</option>
                        <option value="semibold">Semibold</option>
                        <option value="bold">Bold</option>
                      </select>
                    </div>
                    <p className="hint">Photos without camera information (scans, screenshots) get only your own line.</p>
                  </>
                )}
              </>
            )}
          </Section>

          <p className="hint">Exports are copies with your edits applied. Your originals stay as they are.</p>
          {problem && (
            <p className="err" role="alert">
              {problem}
            </p>
          )}
          {busy && <ProgressBar done={progress.done} total={progress.total} label="Export progress" />}
          {busy && settings.enlarge === 'ai' && tiles && tiles.done < tiles.total && (
            <p className="hint" role="status">
              Enlarging with AI: part {tiles.done} of {tiles.total} of this photo.
            </p>
          )}
          {error && (
            <p className="err" role="alert">
              {error}
            </p>
          )}
          {result && (
            <div role="status" className="result">
              <p>
                Wrote {plural(result.written, 'file')}
                {folder.on ? <> to <span className="path" title={result.folder}>{result.folder}</span></> : null}.
              </p>
              {result.written > 0 && (
                <div className="row">
                  <button type="button" className="btn sm" onClick={() => void api().openFolder(result.folder).catch((e: Error) => setError(e.message))}>
                    Show in folder
                  </button>
                  <label className="inline">
                    <input type="checkbox" checked={afterFolder} onChange={(e) => usePrefs.getState().setAfterExport(e.target.checked ? 'folder' : 'nothing')} /> Show the folder after every export
                  </label>
                  <label className="inline">
                    After every export, open the pictures in
                    <select className="field" value={afterOpen} onChange={(e) => usePrefs.getState().setAfterExportOpen(e.target.value as AfterExportOpen)}>
                      <option value="no">Nothing</option>
                      <option value="editor">My editing program (Preferences)</option>
                      <option value="viewer">The program Windows uses for pictures</option>
                    </select>
                  </label>
                </div>
              )}
              {result.failed.length > 0 && (
                <details open>
                  <summary>{plural(result.failed.length, 'file')} failed</summary>
                  <ul>
                    {result.failed.slice(0, 20).map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                </details>
              )}
            </div>
          )}
        </div>

        <figure className="export-preview" aria-busy={preview.busy}>
          {preview.url ? <img src={preview.url} alt="How the first photo will look with these settings" style={{ opacity: preview.busy ? 0.55 : 1 }} /> : <div className="export-preview-empty">{preview.error ?? (ids.length ? 'Preparing a preview…' : 'No photo to preview')}</div>}
          <figcaption className="hint">
            <span role="status">{preview.error && preview.url ? `The preview could not be updated: ${preview.error}` : 'Preview of the first photo, smaller than the real export.'}</span>
          </figcaption>
        </figure>
      </div>
      <div className="dialog-foot">
        <button className="btn" onClick={close} disabled={busy}>
          {result ? 'Done' : 'Cancel'}
        </button>
        {!result && (
          <button className="btn accent" onClick={() => void run()} disabled={busy || !dest || !ids.length || !edgeOk || !!problem || !!folderBad} aria-busy={busy}>
            {busy ? 'Exporting…' : 'Export'}
          </button>
        )}
      </div>
    </Dialog>
  )
}
