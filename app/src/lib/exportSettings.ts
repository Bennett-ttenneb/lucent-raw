import {
  ANCHORS,
  COLOUR_SPACES,
  EXPORT_FORMATS,
  type Anchor,
  type ColourSpace,
  type ExportBorder,
  type CaptionLayout,
  type CaptionSeparator,
  type CaptionWeight,
  type ExportCaption,
  type ExportFormat,
  type ExportSettings,
  type EnlargeMethod,
  type ExportWatermark,
  type SharpenFor,
  type SizeMode,
  SIZE_MODES,
} from './types'

export const DEFAULT_WATERMARK: ExportWatermark = { kind: 'none', text: '© Your name', imagePath: '', anchor: 'bottomRight', size: 3, opacity: 70, margin: 2, colour: [255, 255, 255], shadow: true }
export const DEFAULT_CAPTION: ExportCaption = { show: false, camera: true, lens: true, focal: true, aperture: true, shutter: true, iso: true, date: false, note: '', layout: 'grouped', separator: 'dot', spacing: 2, weight: 'regular', size: 1.6 }
export const DEFAULT_BORDER: ExportBorder = { enabled: false, width: 4, colour: [255, 255, 255], caption: DEFAULT_CAPTION, captionColour: null }
export const DEFAULT_EXPORT: ExportSettings = { format: 'jpeg', quality: 85, longEdge: 2048, sizeMode: 'longEdge', width: 2048, height: 2048, percent: 50, megapixels: 4, dpi: 300, colourSpace: 'srgb', nameTemplate: '{name}', sharpen: 'none', watermark: DEFAULT_WATERMARK, border: DEFAULT_BORDER, enlarge: 'none', cameraInfo: true, metadata: 'none' }

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d)
const text = (v: unknown, d: string, max: number) => (typeof v === 'string' ? v.slice(0, max) : d)
const one = <T extends string>(v: unknown, allowed: readonly T[], d: T): T => (allowed.includes(v as T) ? (v as T) : d)
const colour = (v: unknown, d: [number, number, number]): [number, number, number] =>
  Array.isArray(v) && v.length === 3 && v.every((c) => typeof c === 'number' && Number.isFinite(c)) ? ([v[0], v[1], v[2]].map((c) => Math.round(Math.min(255, Math.max(0, c)))) as [number, number, number]) : [d[0], d[1], d[2]] // a copy: never the default's own array
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

/** Settings read from storage (or a file) made safe: anything missing or odd takes its default, numbers stay in range. */
export function normaliseSettings(raw: unknown): ExportSettings {
  const r = obj(raw)
  const w = obj(r.watermark)
  const b = obj(r.border)
  const c = obj(b.caption)
  const d = DEFAULT_EXPORT
  return {
    format: one<ExportFormat>(r.format, EXPORT_FORMATS.map((f) => f.id), d.format),
    quality: Math.round(num(r.quality, 10, 100, d.quality)),
    longEdge: Math.round(num(r.longEdge, 0, 20000, d.longEdge)),
    sizeMode: one<SizeMode>(r.sizeMode, SIZE_MODES.map((m) => m.id), d.sizeMode),
    width: Math.round(num(r.width, 0, 20000, d.width)),
    height: Math.round(num(r.height, 0, 20000, d.height)),
    percent: num(r.percent, 1, 1000, d.percent),
    megapixels: num(r.megapixels, 0.1, 500, d.megapixels),
    dpi: Math.round(num(r.dpi, 36, 2400, d.dpi)),
    colourSpace: one<ColourSpace>(r.colourSpace, COLOUR_SPACES.map((s) => s.id), d.colourSpace),
    nameTemplate: text(r.nameTemplate, d.nameTemplate, 120).trim() === '' ? d.nameTemplate : text(r.nameTemplate, d.nameTemplate, 120),
    sharpen: one<SharpenFor>(r.sharpen, ['none', 'screen', 'print'], d.sharpen),
    enlarge: one<EnlargeMethod>(r.enlarge, ['none', 'smooth', 'ai'], d.enlarge),
    cameraInfo: bool(r.cameraInfo, d.cameraInfo),
    metadata: one(r.metadata, ['none', 'copyright', 'all'] as const, d.metadata),
    watermark: {
      kind: one(w.kind, ['none', 'text', 'image'] as const, 'none'),
      text: text(w.text, DEFAULT_WATERMARK.text, 200),
      imagePath: text(w.imagePath, '', 1000),
      anchor: one<Anchor>(w.anchor, ANCHORS.map((a) => a.id), DEFAULT_WATERMARK.anchor),
      size: num(w.size, 0.5, 60, DEFAULT_WATERMARK.size),
      opacity: num(w.opacity, 0, 100, DEFAULT_WATERMARK.opacity),
      margin: num(w.margin, 0, 20, DEFAULT_WATERMARK.margin),
      colour: colour(w.colour, DEFAULT_WATERMARK.colour),
      shadow: bool(w.shadow, DEFAULT_WATERMARK.shadow),
    },
    border: {
      enabled: bool(b.enabled, false),
      width: num(b.width, 0, 30, DEFAULT_BORDER.width),
      colour: colour(b.colour, DEFAULT_BORDER.colour),
      caption: {
        show: bool(c.show, false),
        camera: bool(c.camera, true),
        lens: bool(c.lens, true),
        focal: bool(c.focal, true),
        aperture: bool(c.aperture, true),
        shutter: bool(c.shutter, true),
        iso: bool(c.iso, true),
        date: bool(c.date, false),
        note: text(c.note, '', 200),
        layout: one<CaptionLayout>(c.layout, ['grouped', 'single', 'items'], 'grouped'),
        separator: one<CaptionSeparator>(c.separator, ['dot', 'bar', 'slash', 'gap'], 'dot'),
        // the words of the earlier version become numbers
        spacing: c.spacing === 'tight' ? 1 : c.spacing === 'wide' ? 4 : Math.round(num(c.spacing, 0, 12, 2)),
        weight: one<CaptionWeight>(c.weight, ['light', 'regular', 'semibold', 'bold'], 'regular'),
        size: num(c.size, 0.8, 4, 1.6),
      },
      captionColour: b.captionColour === null || b.captionColour === undefined ? null : colour(b.captionColour, [0, 0, 0]),
    },
  }
}

/** Is the "longest side" box a whole number from 0 (keep the size) to 20000? An empty box is not 0. */
export const edgeIsValid = (t: string) => t.trim() !== '' && Number.isInteger(Number(t)) && Number(t) >= 0 && Number(t) <= 20000

export const sameSettings = (a: ExportSettings, b: ExportSettings) => JSON.stringify(a) === JSON.stringify(b)

/** What stops an export from starting, in words, or null when all is well. */
export function exportProblem(s: ExportSettings): string | null {
  if (s.watermark.kind === 'image' && s.watermark.imagePath.trim() === '') return 'Choose the image to use as a watermark, or switch the watermark off.'
  return null
}

/** Why a folder name cannot be used, in words, or null when it can (the same rules as the engine's). */
export function folderProblem(raw: string): string | null {
  const name = raw.trim().replace(/[. ]+$/, '')
  if (name === '') return 'Give the new folder a name.'
  if ([...name].length > 100) return 'The folder name is too long (100 letters at most).'
  const bad = [...name].find((c) => c.charCodeAt(0) < 32 || '<>:"/\\|?*'.includes(c))
  if (bad) return `A folder name cannot contain ${bad.charCodeAt(0) < 32 ? 'control characters' : `'${bad}'`}.`
  const stem = name.split('.')[0].toUpperCase()
  if (['CON', 'PRN', 'AUX', 'NUL'].includes(stem) || /^(COM|LPT)[1-9]$/.test(stem)) return `'${name}' is a name Windows keeps for itself. Pick another.`
  return null
}

/** A name to offer for the new folder: the day, so that one export does not mix with the next. */
export const suggestedFolderName = (d = new Date()) => `Lucent Raw export ${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

const FOLDER_KEY = 'penumbra.exportFolder'
/** Whether a new folder was asked for last time, and the name. */
export function loadFolderPref(): { on: boolean; name: string } {
  const r = read(FOLDER_KEY) as { on?: unknown; name?: unknown } | null
  return { on: r?.on === true, name: typeof r?.name === 'string' && r.name.trim() ? r.name.slice(0, 100) : suggestedFolderName() }
}
export const saveFolderPref = (p: { on: boolean; name: string }) => write(FOLDER_KEY, p)

export const hexOf = (c: [number, number, number]) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join('')
export function colourOf(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim())
  return m ? [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)] : [255, 255, 255]
}

// ---- presets ---------------------------------------------------------------------------------------

export interface ExportPreset {
  name: string
  settings: ExportSettings
}

const make = (name: string, patch: Partial<ExportSettings>): ExportPreset => ({ name, settings: normaliseSettings({ ...clone(DEFAULT_EXPORT), ...patch }) })

/** Settings for the usual jobs. */
export const BUILTIN_EXPORT_PRESETS: ExportPreset[] = [
  make('Web, 2048 px JPEG', { format: 'jpeg', quality: 85, longEdge: 2048, sharpen: 'screen' }),
  make('Social media, 1080 px with a border', { format: 'jpeg', quality: 90, longEdge: 1080, sharpen: 'screen', border: { ...clone(DEFAULT_BORDER), enabled: true, width: 3 } }),
  make('Portfolio with camera settings', { format: 'jpeg', quality: 90, longEdge: 2400, sharpen: 'screen', border: { ...clone(DEFAULT_BORDER), enabled: true, width: 4, caption: { ...DEFAULT_CAPTION, show: true } } }),
  make('Client proofs, watermarked', { format: 'jpeg', quality: 80, longEdge: 1600, sharpen: 'screen', watermark: { ...clone(DEFAULT_WATERMARK), kind: 'text', text: 'PROOF', anchor: 'centre', size: 12, opacity: 30, shadow: false } }),
  make('Print, full size TIFF (Adobe RGB)', { format: 'tiff', longEdge: 0, colourSpace: 'adobeRgb', sharpen: 'print' }),
  make('Archive, full size PNG', { format: 'png', longEdge: 0, colourSpace: 'srgb' }),
]

const LAST_KEY = 'penumbra.exportLast'
const PRESETS_KEY = 'penumbra.exportPresets'

const read = (key: string): unknown => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? 'null')
  } catch {
    return null // storage unavailable or corrupt: start from the defaults
  }
}
const write = (key: string, value: unknown) => {
  try {
    localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* private window or blocked storage: it just lasts for this session */
  }
}

/** The settings used last time, or the defaults. */
export const loadLastExport = (): ExportSettings => normaliseSettings(read(LAST_KEY))
export const saveLastExport = (s: ExportSettings) => write(LAST_KEY, s)

export function loadUserPresets(): ExportPreset[] {
  const raw = read(PRESETS_KEY)
  if (!Array.isArray(raw)) return []
  return raw.filter((p) => p && typeof p.name === 'string' && p.name.trim() !== '').map((p) => ({ name: String(p.name).slice(0, 60), settings: normaliseSettings(p.settings) }))
}

/** Save under a name (the same name replaces the old one). Returns the list as it is now. */
export function saveUserPreset(name: string, settings: ExportSettings): ExportPreset[] {
  const clean = name.trim().slice(0, 60)
  if (!clean) return loadUserPresets()
  const list = loadUserPresets().filter((p) => p.name.toLowerCase() !== clean.toLowerCase())
  list.push({ name: clean, settings: clone(settings) })
  write(PRESETS_KEY, list)
  return list
}

export function deleteUserPreset(name: string): ExportPreset[] {
  const list = loadUserPresets().filter((p) => p.name !== name)
  write(PRESETS_KEY, list)
  return list
}

/** The name of the preset (built in or yours) that these settings match exactly, if any. */
export function matchingPreset(s: ExportSettings, user: ExportPreset[]): string | null {
  return [...BUILTIN_EXPORT_PRESETS, ...user].find((p) => sameSettings(p.settings, s))?.name ?? null
}
