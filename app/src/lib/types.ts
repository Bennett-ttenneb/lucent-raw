export type Flag = -1 | 0 | 1
export type Label = 'red' | 'yellow' | 'green' | 'blue' | 'purple'
export const LABELS: Label[] = ['red', 'yellow', 'green', 'blue', 'purple']

export interface Photo {
  id: number
  name: string
  path: string
  folder: string
  format: string
  rating: number
  flag: Flag
  label: Label | null
  captured: string | null
  width: number | null
  height: number | null
  missing: boolean
  camera: string | null
  lens: string | null
  iso: number | null
  aperture: number | null
  shutterS: number | null
  focalMm: number | null
  previewable: boolean
  /** The photo has develop edits. */
  edited: boolean
  /** "Copy 1" ... for a virtual copy (a photo of its own that shares another photo's file), otherwise null. */
  copyName: string | null
  /** the photo a virtual copy was made from */
  masterId: number | null
  /** the stack the photo is in (null: none), its place in it (0 shows when the stack is closed), the photos in the stack and whether it is closed */
  stackId: number | null
  stackPos: number
  stackCount: number
  stackCollapsed: boolean
}

/** A folder that is looked at for new photos, and what is done with them: leave them where they are, or move or copy them into the destination folder. */
export interface WatchConfig {
  folder: string
  mode: 'add' | 'move' | 'copy'
  destination: string | null
}

export interface WatchStatus {
  active: boolean
  /** photos brought in since the watch was switched on */
  imported: number
  error: string | null
}

/** The profiles Develop offers, with what each does. */
export const PROFILES = [
  { id: '', label: 'Standard', note: 'The picture as it is, before any look.' },
  { id: 'vivid', label: 'Vivid', note: 'Rich colour and punchy contrast.' },
  { id: 'landscape', label: 'Landscape', note: 'Strong colour, a touch cooler, firm contrast.' },
  { id: 'portrait', label: 'Portrait', note: 'Softer colour and contrast, a little warmer for skin.' },
  { id: 'neutral', label: 'Neutral', note: 'Quiet colour and gentle contrast: a base for your own edits.' },
  { id: 'flat', label: 'Flat', note: 'Very low contrast and colour, for grading later.' },
  { id: 'monochrome', label: 'Monochrome', note: 'Black and white with firm contrast.' },
] as const

export type ProofIntent = 'perceptual' | 'relative' | 'saturation' | 'absolute'

export interface TransferResult {
  photos: number
  skipped: number
  previews: number
  folder: string
}

export type SortKey = 'capture' | 'name' | 'rating'

export interface Query {
  sort: SortKey
  desc: boolean
  minRating?: number
  flag?: 'pick' | 'reject' | 'unflagged'
  label?: Label
  /** the photos that have edits (yes) or have none (no) */
  edited?: 'yes' | 'no'
  /** virtual copies: 'no' hides them, 'only' shows nothing else */
  copies?: 'no' | 'only'
  /** 'all' shows every photo of every stack (otherwise a closed stack shows only its top photo) */
  stacks?: 'all'
  text?: string
  folderId?: number
  collectionId?: number
  keywordId?: number
  /** the camera as the grid names it, and the lens */
  camera?: string
  lens?: string
  /** ranges, both ends included */
  minIso?: number
  maxIso?: number
  minFocal?: number
  maxFocal?: number
  minAperture?: number
  maxAperture?: number
  /** the day taken, YYYY-MM-DD */
  dateFrom?: string
  dateTo?: string
  offset: number
  limit: number
}

/** What the catalog holds, for the Metadata filter to offer. */
export interface MetadataValues {
  cameras: { name: string; count: number }[]
  lenses: { name: string; count: number }[]
  iso: [number, number] | null
  focal: [number, number] | null
  aperture: [number, number] | null
  days: [string, string] | null
}

export type Filters = Omit<Query, 'offset' | 'limit'>

export interface Page {
  total: number
  rows: Photo[]
}

export interface FolderRow {
  id: number
  root: string
  /** where the root is on the disk */
  rootPath: string
  relPath: string
  count: number
}

/** One test of a smart collection: a field, how it is tested, and the value (always text). */
export interface SmartRule {
  field: string
  op: string
  value: string
  /** "does not meet": the rule turned round */
  negate?: boolean
  /** for a rule whose field is "group": the rules inside it */
  group?: SmartRules
}

/** The rules of a smart collection, and whether a photo must meet all of them or any one. */
export interface SmartRules {
  mode: 'all' | 'any'
  rules: SmartRule[]
}

export interface CollectionRow {
  id: number
  name: string
  kind: 'collection' | 'quick' | 'smart' | 'set'
  isTarget: boolean
  count: number
  /** the collection set it is in, or null at the top */
  parentId: number | null
}

export interface KeywordRow {
  id: number
  name: string
  parentId: number | null
  count: number
  /** other words that mean the same, comma separated */
  synonyms: string
  /** written to sidecar files */
  includeOnExport: boolean
  /** stays in the catalog and is never written to a sidecar */
  isPrivate: boolean
}

export interface KeywordUse {
  keywordId: number
  /** how many of the asked-about photos carry it */
  count: number
}

export type MetaPatch = Partial<Record<'title' | 'caption' | 'creator' | 'copyright' | 'credit' | 'source' | 'sublocation' | 'city' | 'state' | 'country' | 'headline' | 'jobTitle' | 'instructions' | 'jobId' | 'usageTerms', string>>

/** One catalog on the list. */
/** The AI connection (MCP): whether it is on, where it listens, and the secret token. */
export interface McpStatus {
  enabled: boolean
  running: boolean
  port: number
  url: string
  token: string
  /** the line to give Claude Code, with this computer's address and token in it */
  command: string
  error: string | null
}

export interface CatalogEntry {
  id: string
  name: string
  path: string
  /** how many photos it holds; null when its folder cannot be read */
  photos: number | null
  /** its folder is where it was left */
  exists: boolean
  current: boolean
}

export interface CatalogList {
  current: string
  items: CatalogEntry[]
}

/** What the check of a catalog found. */
/** A folder of the catalog with photos whose files are not there. */
/** Sidecar files (XMP): whether they are kept up to date by themselves, and how many photos are waiting. */
/** The previews kept on disk. */
export interface CacheInfo {
  files: number
  bytes: number
  baseBytes: number
  editedBytes: number
  photos: number
  withoutPreview: number
  editedWithout: number
}

export interface XmpStatus {
  auto: boolean
  changed: number
  lastError: string | null
}

export interface XmpWriteOut {
  written: number
  unchanged: number
  /** sidecars from another program (or unreadable) that were not replaced: their file names */
  leftAlone: string[]
  missing: number
  failed: string[]
}

export interface XmpReadOut {
  found: number
  differ: number
  applied: number
  /** per kind of difference (rating, label, title, keywords, edits ...), how many photos */
  kinds: Record<string, number>
  unreadable: string[]
}

export interface MissingGroup {
  rootId: number
  path: string
  /** the folder itself is there (single files are missing) or not (moved, renamed, drive not connected) */
  folderThere: boolean
  missing: number
  total: number
}

export interface MissingReport {
  checked: number
  missing: number
  groups: MissingGroup[]
}

export interface RelinkOutcome {
  relinked: number
  stillMissing: number
  /** how many of the relinked photos were found by what is inside the file, because it had been renamed */
  byContent: number
  ambiguous: number
  conflicts: number
}

export interface CatalogCheck {
  ok: boolean
  /** in words, at most 20 */
  problems: string[]
  photos: number
  books: number
  sizeBytes: number
}

export interface CatalogBackup {
  folder: string
  bytes: number
  when: string
}

export interface LicenceStatus {
  state: 'licensed' | 'trial' | 'expired'
  daysLeft: number
  trialDays: number
  name: string | null
  problem: string | null
}

export interface AutoBackup {
  file: string
  kind: 'auto' | 'before-upgrade' | 'before-restore'
  when: string
  bytes: number
  photos: number
}

export interface AutoBackupState {
  settings: { on: boolean; everyDays: number; keep: number }
  backups: AutoBackup[]
  folder: string
}

export interface CatalogInfo {
  /** the name the person gave the open catalog */
  name: string
  path: string
  count: number
}

/** A memory card (or drive with a DCIM folder) that is plugged in. */
export interface Card {
  /** the folder to import from */
  path: string
  /** "E:" */
  label: string
  removable: boolean
  hasDcim: boolean
}

/** The colour profile Windows uses for the main display. */
export interface DisplayProfile {
  name: string
  path: string
  /** sRGB, so pictures need no conversion for this screen */
  isSrgb: boolean
}

/** What the open catalog holds and the room it takes. */
export interface CatalogDetails {
  photos: number
  virtualCopies: number
  folders: number
  collections: number
  keywords: number
  edited: number
  catalogBytes: number
  previewsBytes: number
  created: string | null
  schemaVersion: string
}

/** What synchronising a folder would do. */
export interface SyncPreview {
  newFiles: string[]
  gone: { id: number; name: string }[]
  present: number
}

export interface SyncResult {
  imported: number
  duplicates: number
  failed: string[]
  markedMissing: number
  removed: number
}

export interface PerfState {
  threads: number
  cores: number
  automatic: number
}

export interface ImportResult {
  added: number
  duplicates: number
  failed: string[]
  unsupportedPreviews: number
  /** moved photos whose copy was checked but whose original could not be removed */
  leftBehind: string[]
  /** the photos that were added, so presets and keywords can be put on them */
  addedIds: number[]
}

/** How copied and moved photos are named and put into folders. */
export interface ImportOptions {
  /** {name}, {date}, {seq} and {camera} */
  nameTemplate: string
  folderFormat: 'YYYY-MM-DD' | 'YYYY/MM/DD' | 'YYYY/YYYY-MM-DD' | 'YYYY-MM' | 'YYYY' | 'flat'
  /** also skip a photo that is probably one already in the catalog (same name, moment and camera) */
  skipSuspected?: boolean
  /** the number {seq} starts at (1 when left out) */
  seqStart?: number
  /** with Copy as DNG: also keep the original RAW file inside each DNG */
  embedOriginal?: boolean
}

/** One thing B BOT would change: what, why, and the values the settings would then have. */
export interface Suggestion {
  id: string
  title: string
  why: string
  changes: { field: string; value: number }[]
}

export interface Advice {
  faces: number
  skin: { pixels: number; faces: number; lightness: number; hue: number; chroma: number; verdict: string } | null
  items: Suggestion[]
  /** how good the picture looks to most people, 1 to 10 (about 5 is ordinary); a rough guide */
  look?: number | null
}

/** What Cull found out about one photo's preview. */
export interface CullRow {
  id: number
  name: string
  /** how good it looks to most people, 1 to 10 (about 5 is ordinary), when it could be scored */
  look: number | null
  sharpness: number
  blown: number
  crushed: number
  /** the sharpest part of the photo is not sharp */
  soft: boolean
  exposure: 'too bright' | 'too dark' | null
  /** the burst or near-duplicate group it is in, if any */
  group: number | null
  best: boolean
  skipped: string | null
}

export interface CullReport {
  rows: CullRow[]
  groups: number
}

export interface ExportResult {
  written: number
  failed: string[]
  /** the folder the files went to (the new folder, when one was asked for) */
  folder: string
  /** the files that were written */
  files: string[]
}

export interface Progress {
  done: number
  total: number
}

export type PreviewLevel = 'thumb' | 'standard'

export const ASPECTS = ['original', 'free', '1:1', '4:3', '3:2', '16:9', '5:4'] as const
/** A red-eye circle. Position is a fraction of the cropped picture, size a fraction of its long edge. */
export interface RedEye {
  id: string
  x: number
  y: number
  size: number
  darken: number
}

/** The colour space an export is saved in. Edits are made in sRGB; the others convert at the end and tag the file. */
export const COLOUR_SPACES = [
  { id: 'srgb', label: 'sRGB' },
  { id: 'displayP3', label: 'Display P3' },
  { id: 'adobeRgb', label: 'Adobe RGB (1998)' },
  { id: 'proPhoto', label: 'ProPhoto RGB' },
] as const
export type ColourSpace = (typeof COLOUR_SPACES)[number]['id']

/** An ellipse on the picture: its middle as fractions of the width and height, its radii as fractions of the long edge. */
export interface Ellipse {
  cx: number
  cy: number
  rx: number
  ry: number
}
export interface EyeAdjust {
  iris: number
  sclera: number
}
/** Skin, teeth and eye retouching on a face the person marked (a face, two eyes and a mouth). */
export interface Portrait {
  face: Ellipse
  leftEye: Ellipse
  rightEye: Ellipse
  mouth: Ellipse
  skin: { impact: number; blemishes: number; darkCircles: number; evenAmount: number; evenTexture: number; contouring: number; radius: number; body: number; tone: number; shine: number; colour: number; glow: number; crisp: number }
  teeth: { brightness: number; desaturation: number }
  eyes: { both: EyeAdjust; left: EyeAdjust; right: EyeAdjust }
  /** How the face is turned, in degrees, when it was found by Detect faces (0 when it was marked by hand): tipped clockwise, looking towards the right of the picture, nodding down. */
  roll: number
  yaw: number
  pitch: number
  /** Lips: -100 paler, 100 richer. Eyebrows: -100 lighter, 100 darker and fuller. Both need the face to have been found by the program. */
  lips: number
  brows: number
}

/** A photo found in the folder being imported from. */
export interface ImportItem {
  path: string
  name: string
  /** the subfolder it is in, relative to the chosen folder; empty for the folder itself */
  folder: string
  size: number
  raw: boolean
}

export const EXPORT_FORMATS = [
  { id: 'jpeg', label: 'JPEG' },
  { id: 'png', label: 'PNG' },
  { id: 'tiff', label: 'TIFF' },
  { id: 'webp', label: 'WebP (lossless)' },
  { id: 'original', label: 'Original file (copied as it is)' },
  { id: 'dng', label: 'DNG (a RAW photo in the open RAW format)' },
] as const
export type ExportFormat = (typeof EXPORT_FORMATS)[number]['id']
export type SharpenFor = 'none' | 'screen' | 'print'
/** What to do when the longest side asked for is more than the picture has. */
export type EnlargeMethod = 'none' | 'smooth' | 'ai'

export const ANCHORS = [
  { id: 'topLeft', label: 'Top left' },
  { id: 'top', label: 'Top' },
  { id: 'topRight', label: 'Top right' },
  { id: 'left', label: 'Left' },
  { id: 'centre', label: 'Centre' },
  { id: 'right', label: 'Right' },
  { id: 'bottomLeft', label: 'Bottom left' },
  { id: 'bottom', label: 'Bottom' },
  { id: 'bottomRight', label: 'Bottom right' },
] as const
export type Anchor = (typeof ANCHORS)[number]['id']

export interface ExportWatermark {
  kind: 'none' | 'text' | 'image'
  text: string
  /** a PNG, JPEG or WebP file with a logo */
  imagePath: string
  anchor: Anchor
  /** percent of the long edge: the height of the text, or the width of the logo */
  size: number
  opacity: number
  /** percent of the long edge, from the edge of the photo */
  margin: number
  colour: [number, number, number]
  shadow: boolean
}

/** Which camera settings the caption under the photo shows. */
export type CaptionLayout = 'grouped' | 'single' | 'items'
export type CaptionSeparator = 'dot' | 'bar' | 'slash' | 'gap'
export type CaptionWeight = 'light' | 'regular' | 'semibold' | 'bold'

export interface ExportCaption {
  show: boolean
  layout: CaptionLayout
  separator: CaptionSeparator
  /** spaces on each side of the separator, 0 to 12 */
  spacing: number
  weight: CaptionWeight
  /** the size of the letters as a share of the long edge, in percent (0.8 to 4) */
  size: number
  camera: boolean
  lens: boolean
  focal: boolean
  aperture: boolean
  shutter: boolean
  iso: boolean
  date: boolean
  note: string
}

export interface ExportBorder {
  enabled: boolean
  /** percent of the long edge, on every side */
  width: number
  colour: [number, number, number]
  caption: ExportCaption
  captionColour: [number, number, number] | null
}

export type SizeMode = 'longEdge' | 'dimensions' | 'percent' | 'megapixels'
export const SIZE_MODES: { id: SizeMode; name: string }[] = [
  { id: 'longEdge', name: 'Longest side' },
  { id: 'dimensions', name: 'Width and height' },
  { id: 'percent', name: 'Percentage' },
  { id: 'megapixels', name: 'Megapixels' },
]

/** Everything the Export dialog sets: the file format, the size, the colour space, the names, a watermark and a border. */
export interface ExportSettings {
  format: ExportFormat
  quality: number
  longEdge: number
  /** how the size is asked for */
  sizeMode: SizeMode
  /** SizeMode 'dimensions': the picture fits inside this box (0 leaves that direction free) */
  width: number
  height: number
  /** SizeMode 'percent': 100 keeps the size */
  percent: number
  /** SizeMode 'megapixels' */
  megapixels: number
  /** pixels to the inch written into the file (36 to 2400) */
  dpi: number
  colourSpace: ColourSpace
  nameTemplate: string
  sharpen: SharpenFor
  watermark: ExportWatermark
  border: ExportBorder
  enlarge: EnlargeMethod
  /** JPEG only: the camera, lens, exposure and date go in the file (never where it was taken) */
  cameraInfo: boolean
  /** the details of the photo written into the file (JPEG and PNG): none, the copyright details, or everything (also title, caption, place, keywords) */
  metadata: 'none' | 'copyright' | 'all'
}

/** One of the named ratios, or a ratio of your own written as two numbers with a colon, such as 7:5 or 2.35:1. */
export type Aspect = (typeof ASPECTS)[number] | `${number}:${number}`

/** A crop frame placed by hand: centre and size as fractions of the lens-corrected picture, turned by the angle about its centre. */
export interface CropRect {
  cx: number
  cy: number
  w: number
  h: number
}

export interface Recipe {
  /** the look the photo starts from before the sliders: '' (plain), 'vivid', 'landscape', 'portrait', 'neutral', 'flat' or 'monochrome' */
  profile: string
  /** 0 to 200, 100 as designed */
  profileAmount: number
  temperature: number
  tint: number
  exposure: number
  contrast: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
  vibrance: number
  saturation: number
  /** Presence: fine detail, medium detail, haze (-100 to 100). */
  texture: number
  clarity: number
  dehaze: number
  /** Tone curve control points [input, output], 0 to 255. Empty is a straight line. */
  curve: [number, number][]
  /** The same for one colour channel alone, applied after the combined curve. */
  curveRed: [number, number][]
  curveGreen: [number, number][]
  curveBlue: [number, number][]
  /** The parametric curve: each slider moves one region of the tones, -100 to 100. */
  parametric: { shadows: number; darks: number; lights: number; highlights: number }
  /** Colour grading: a wheel for the shadows, midtones, highlights and the whole picture. */
  grading: {
    shadows: { hue: number; sat: number; lum: number }
    midtones: { hue: number; sat: number; lum: number }
    highlights: { hue: number; sat: number; lum: number }
    global: { hue: number; sat: number; lum: number }
    blending: number
    balance: number
  }
  /** Calibration: how the three primaries are rendered (-100 to 100). */
  calibration: { shadowsTint: number; redHue: number; redSat: number; greenHue: number; greenSat: number; blueHue: number; blueSat: number }
  /** Colour mixer: eight bands, each a change from -100 to 100. */
  hsl: { hue: number[]; sat: number[]; lum: number[] }
  /** Sharpening and noise reduction. Radius is in pixels of a 2048 px wide picture. */
  detail: { sharpAmount: number; sharpRadius: number; sharpMasking: number; nrLuma: number; nrColour: number; sharpDetail: number; nrLumaDetail: number; nrLumaContrast: number; nrColourSmooth: number }
  /** Vignette and grain. */
  effects: { vignetteAmount: number; vignetteMidpoint: number; vignetteFeather: number; vignetteRoundness: number; grainAmount: number; grainSize: number; grainRoughness: number }
  /** Local adjustments, each limited to a shape. */
  masks: Mask[]
  /** Spot removal, applied before everything else. */
  spots: Spot[]
  /** Red-eye circles: where to look for red pupils, and how much darker to make them. */
  redEyes: RedEye[]
  /** Portrait retouching, one entry per face the person marked or the detector found. */
  portraits: Portrait[]
  /** Lens corrections and transform, applied before the crop. */
  geometry: {
    distortion: number
    caRed: number
    caBlue: number
    vertical: number
    horizontal: number
    rotate: number
    aspect: number
    scale: number
    xOffset: number
    yOffset: number
    constrain: boolean
    /** turned clockwise this many quarter turns (0 to 3), after being mirrored left to right if `mirror` is set */
    quarterTurns: number
    mirror: boolean
  }
  crop: { aspect: Aspect; angle: number; rect: CropRect | null }
}

export const DEFAULT_RECIPE: Recipe = {
  profile: '',
  profileAmount: 100,
  temperature: 0,
  tint: 0,
  exposure: 0,
  contrast: 0,
  highlights: 0,
  shadows: 0,
  whites: 0,
  blacks: 0,
  vibrance: 0,
  saturation: 0,
  texture: 0,
  clarity: 0,
  dehaze: 0,
  curve: [],
  curveRed: [],
  curveGreen: [],
  curveBlue: [],
  parametric: { shadows: 0, darks: 0, lights: 0, highlights: 0 },
  grading: { shadows: { hue: 0, sat: 0, lum: 0 }, midtones: { hue: 0, sat: 0, lum: 0 }, highlights: { hue: 0, sat: 0, lum: 0 }, global: { hue: 0, sat: 0, lum: 0 }, blending: 50, balance: 0 },
  calibration: { shadowsTint: 0, redHue: 0, redSat: 0, greenHue: 0, greenSat: 0, blueHue: 0, blueSat: 0 },
  hsl: { hue: [0, 0, 0, 0, 0, 0, 0, 0], sat: [0, 0, 0, 0, 0, 0, 0, 0], lum: [0, 0, 0, 0, 0, 0, 0, 0] },
  detail: { sharpAmount: 0, sharpRadius: 1, sharpMasking: 0, nrLuma: 0, nrColour: 0, sharpDetail: 0, nrLumaDetail: 50, nrLumaContrast: 0, nrColourSmooth: 50 },
  effects: { vignetteAmount: 0, vignetteMidpoint: 50, vignetteFeather: 50, vignetteRoundness: 50, grainAmount: 0, grainSize: 25, grainRoughness: 50 },
  masks: [],
  spots: [],
  redEyes: [],
  portraits: [],
  geometry: { distortion: 0, caRed: 0, caBlue: 0, vertical: 0, horizontal: 0, rotate: 0, aspect: 0, scale: 100, xOffset: 0, yOffset: 0, constrain: true, quarterTurns: 0, mirror: false },
  crop: { aspect: 'original', angle: 0, rect: null },
}

/** What a mask changes inside its shape. */
export interface LocalAdjust {
  exposure: number
  contrast: number
  highlights: number
  shadows: number
  saturation: number
  temperature: number
  sharpness: number
  noise: number
  /** 0 to 100: how much of the part under the mask is blurred (a lens blur) */
  blur: number
}

export interface Stroke {
  erase: boolean
  /** a fraction of the picture's long edge */
  size: number
  feather: number
  flow: number
  /** fractions of the picture */
  points: [number, number][]
}

/** Positions are fractions (0 to 1) of the cropped picture, so a mask means the same at any size. */
export type MaskShape =
  | { type: 'linear'; x1: number; y1: number; x2: number; y2: number; feather: number }
  | { type: 'radial'; cx: number; cy: number; rx: number; ry: number; angle: number; feather: number }
  | { type: 'brush'; strokes: Stroke[] }
  /** Where the brightness (0 to 1) is between lo and hi, fading over `smooth` (0 to 1) outside. */
  | { type: 'luminance'; lo: number; hi: number; smooth: number }
  /** Where the colour is within `range` degrees of `hue` and has at least `sat` (0 to 1) colour in it. */
  | { type: 'colour'; hue: number; range: number; sat: number; smooth: number }
  /** The main subject, found by the subject model when the mask was made: its answer as a small grey picture (text). Invert for the background. */
  | { type: 'subject'; map: string }
  /** The sky, found from colour and position. Higher sensitivity (0 to 1) takes in more. */
  | { type: 'sky'; sensitivity: number }
  /** Where the picture is between two distances (0 far to 1 near), found by the depth model when the mask was made: its answer as a small grey picture (text). */
  | { type: 'depth'; map: string; near: number; far: number; smooth: number }

/** How a further shape is combined with what the mask covers so far. */
export type MaskOp = 'add' | 'subtract' | 'intersect'

export interface MaskPart {
  op: MaskOp
  shape: MaskShape
}

export interface Mask {
  id: string
  name: string
  visible: boolean
  invert: boolean
  shape: MaskShape
  /** More shapes combined with the first, one after another. */
  parts: MaskPart[]
  adjust: LocalAdjust
}

/** Spot removal: a round patch copied from (sx, sy) onto (x, y). Positions are fractions of the cropped picture. */
export interface Spot {
  id: string
  visible: boolean
  /** fill: painted by the filling model from what is round the spot (the source is not used) */
  mode: 'heal' | 'clone' | 'fill'
  x: number
  y: number
  sx: number
  sy: number
  /** diameter, as a fraction of the picture's long edge */
  size: number
  feather: number
  opacity: number
}

export interface HistoryRow {
  id: number
  seq: number
  label: string
  deltaText: string | null
  valueText: string | null
  createdAt: string
  /** The whole recipe after this step. */
  recipe: Recipe
}

export interface DevelopState {
  recipe: Recipe
  /** Newest first. */
  history: HistoryRow[]
}

export interface PresetRow {
  /** Negative for the presets that ship with the app. */
  id: number
  name: string
  group: string
  /** Which groups of settings the preset applies. */
  groups: string[]
  recipe: Recipe
}

export interface SnapshotRow {
  id: number
  name: string
  createdAt: string
  recipe: Recipe
}

/** What Auto suggests for a photo. */
export interface AutoSettings {
  temperature: number
  tint: number
  exposure: number
  contrast: number
  highlights: number
  shadows: number
  whites: number
  blacks: number
  vibrance: number
  saturation: number
}

export interface StepIn {
  label: string
  deltaText: string | null
  valueText: string | null
}

/** Everything the UI needs from the core. Tauri implements it for real; a mock implements it in a browser. */
export interface Api {
  readonly isMock: boolean
  catalogInfo(): Promise<CatalogInfo>
  /** Make a virtual copy of each photo (it shares the file, and has its own rating, keywords and edits); returns the new copies. */
  photoVirtualCopy(ids: number[]): Promise<number[]>
  /** Look for problems in the open catalog (it changes nothing). */
  catalogCheck(): Promise<CatalogCheck>
  cacheInfo(): Promise<CacheInfo>
  /** Make the missing previews, or all of them, in the background; returns how many photos are being worked on. */
  cacheRebuild(which: 'missing' | 'all'): Promise<number>
  /** Delete every preview (they are made again when asked for). */
  cacheClear(which: 'all'): Promise<CacheInfo>
  xmpStatus(): Promise<XmpStatus>
  xmpSetAuto(on: boolean): Promise<XmpStatus>
  /** Write sidecar files for the changed photos, all photos or the given ones (scope "changed", "all", "selected"). */
  xmpWriteNow(scope: 'changed' | 'all' | 'selected', ids: number[]): Promise<XmpWriteOut>
  /** Look at the sidecars (apply false) or make the catalog agree with them (apply true). */
  xmpReadNow(scope: 'all' | 'selected', ids: number[], apply: boolean): Promise<XmpReadOut>
  /** Look for every photo's file; marks the missing ones and says where they were. Moves nothing. */
  missingScan(): Promise<MissingReport>
  /** How many of a folder's photos are in a new place (the folder moved there as it was). */
  relinkPreview(rootId: number, newFolder: string): Promise<{ found: number; total: number }>
  /** Point a folder of the catalog at its new place, then look again. */
  relinkRoot(rootId: number, newFolder: string): Promise<MissingReport>
  /** Search a folder for the missing photos' files (name and size) and reconnect what is found. */
  relinkSearch(folder: string): Promise<{ outcome: RelinkOutcome; report: MissingReport }>
  /** Keep the preview folder within a size (bytes, 0 = no limit) and an age (days, 0 = no limit); what is deleted is made again when asked for. */
  cacheTrim(maxBytes: number, maxAgeDays: number): Promise<{ removed: number; freed: number }>
  /** Merge photos of one scene at different exposures into one picture (exposure fusion); the result is added to the catalog beside the first photo. */
  photoMergeHdr(ids: number[], align: boolean): Promise<{ id: number; path: string; shots: number }>
  /** Join photos taken in turn, each overlapping the next, into a panorama (shifted into place and blended; the photos are taken in the order given). */
  photoMergePano(ids: number[]): Promise<{ id: number; path: string; shots: number }>
  /** AI denoise: a denoised copy of the photo is made beside it (a JPEG named <name>-Denoise) and added to the catalog. amount 0 to 100; iso null uses the photo's own. */
  photoAiDenoise(id: number, amount: number, iso: number | null): Promise<{ id: number; path: string; shots: number }>
  /** Focus stacking (macro): shots at different focus distances blended so each part is from the shot where it is sharpest; up to 40. */
  photoMergeFocus(ids: number[], align: boolean): Promise<{ id: number; path: string; shots: number }>
  /** A full-size TIFF of the photo with its edits applied, made beside it and added to the catalog (for an editing program). */
  photoEditCopy(id: number): Promise<{ id: number; path: string; shots: number }>
  /** Open the second window (a second screen). */
  secondOpen(): Promise<boolean>
  secondClose(): Promise<void>
  /** Tell the second window which photo to show. */
  secondShow(show: { id: number | null; label: string; key: string }): Promise<void>
  /** Start or stop (null) watching a folder for new photos, which are imported as they appear. */
  watchSet(config: WatchConfig | null): Promise<WatchStatus>
  watchStatus(): Promise<WatchStatus>
  /** Put the chosen photos into a new catalog of their own (a folder of that name inside the destination). The files are not copied. */
  catalogExportPhotos(ids: number[], destination: string, name: string, withPreviews: boolean): Promise<TransferResult>
  /** Add the photos of another catalog (its folder) to this one. A backup is made first; photos this catalog has already are skipped. */
  catalogImportFrom(path: string, withPreviews: boolean): Promise<TransferResult>
  /** Put the photos into one stack (the first is the top). Returns the stack. */
  stackGroup(ids: number[]): Promise<number>
  /** Stack the photos taken within the given seconds of each other. Returns [stacks made, photos stacked]. */
  stackAuto(ids: number[], gapSeconds: number): Promise<[number, number]>
  /** Stack photos that look alike (a fingerprint of each small preview; at most this many of 64 bits apart). Returns [stacks made, photos stacked]. */
  stackSimilar(ids: number[], maxDistance: number): Promise<[number, number]>
  /** Take apart the stacks these photos are in. Returns how many ended. */
  stackUngroup(ids: number[]): Promise<number>
  /** Take these photos out of their stacks. Returns how many were in one. */
  stackRemove(ids: number[]): Promise<number>
  /** Open or close one stack, or every stack when no id is given. */
  stackCollapse(stackId: number | null, collapsed: boolean): Promise<void>
  /** Make a photo the top of its stack. */
  stackMakeTop(id: number): Promise<void>
  /** How many of these photos (all when none are given) have a smart preview, and the room they take. */
  smartInfo(ids: number[]): Promise<{ built: number; total: number; bytes: number }>
  /** Make smart previews (2560 px, for editing and exporting when the original is offline) for these photos, or all. Skips photos that have one or whose file is gone. */
  smartBuild(ids: number[]): Promise<{ made: number; skipped: number; failed: string[] }>
  /** What the open catalog holds and the room it takes. */
  catalogDetails(): Promise<CatalogDetails>
  /** The profile of the main display, or null when Windows does not say. */
  displayProfile(): Promise<DisplayProfile | null>
  /** The files on the disk in a folder the catalog does not have, and the photos whose files are gone. */
  folderSyncPreview(folderId: number): Promise<SyncPreview>
  /** Bring the catalog in step with the folder: import the new files, and remove or mark missing the photos whose files are gone. */
  folderSyncRun(folderId: number, importNew: boolean, removeGone: boolean): Promise<SyncResult>
  /** The memory cards plugged in now. */
  importCards(): Promise<Card[]>
  /** Show a folder in the file manager. */
  openFolder(path: string): Promise<void>
  /** Give a virtual copy a name of its own. */
  photoRenameCopy(id: number, name: string): Promise<void>
  /** Reconnect one photo to a file chosen by hand. */
  photoRelink(id: number, file: string): Promise<void>
  /** Ask for any photo file (RAW included), or null if the window is closed. */
  pickPhotoFile(title: string): Promise<string | null>
  /** Copy the open catalog into a new folder inside the chosen one; the folder opens as a catalog. */
  catalogBackup(destination: string): Promise<CatalogBackup>
  /** The limit on worker threads for heavy work (0 = the program decides), the computer's processors, and what automatic means here. */
  perfGet(): Promise<PerfState>
  perfSet(threads: number): Promise<PerfState>
  /** Open a photo's file in another program (the one named, or Windows' choice when none is). */
  openInEditor(path: string, editor: string | null): Promise<void>
  /** When the open catalog was last backed up ("2026-10-18 15:30"), or null if never. */
  catalogLastBackup(): Promise<string | null>
  licenceStatus(): Promise<LicenceStatus>
  /** Compact the catalog; the file size before and after, in bytes. */
  catalogOptimize(): Promise<{ before: number; after: number }>
  /** Free and total bytes on the disk that holds a folder, or null when that cannot be found out. */
  volumeSpace(path: string): Promise<{ free: number; total: number } | null>
  licenceEnter(key: string): Promise<LicenceStatus>
  backupAutoState(): Promise<AutoBackupState>
  backupAutoSettingsSet(on: boolean, everyDays: number, keep: number): Promise<AutoBackupState>
  backupAutoNow(): Promise<AutoBackupState>
  backupRestore(file: string): Promise<AutoBackupState>
  /** Books (Book module): kept in the catalog, saved as they are changed. */
  bookList(): Promise<BookEntry[]>
  bookCreate(name?: string): Promise<number>
  bookGet(id: number): Promise<BookDoc>
  bookSave(id: number, book: BookDoc): Promise<BookDoc>
  bookDelete(id: number): Promise<void>
  /** Make the book a PDF in the folder (never replacing a file that is there). */
  bookExportPdf(id: number, destination: string): Promise<BookPdfResult>
  /** The AI connection: its state, switching it on or off, and making a new secret token (the old one stops working). */
  mcpStatus(): Promise<McpStatus>
  mcpSetEnabled(enabled: boolean): Promise<McpStatus>
  mcpNewToken(): Promise<McpStatus>
  /** The catalogs kept, and which is open. */
  catalogList(): Promise<CatalogList>
  /** Make a new, empty catalog (in `location`, or in the program's own folder) and open it. */
  catalogCreate(name: string, location?: string | null): Promise<CatalogList>
  /** Add a catalog folder that exists (it holds a catalog.db) and open it. */
  catalogOpen(path: string): Promise<CatalogList>
  catalogSwitch(id: string): Promise<CatalogList>
  catalogRename(id: string, name: string): Promise<CatalogList>
  /** Forget a catalog. Its folder and photos are not touched. The open one cannot be removed. */
  catalogRemove(id: string): Promise<CatalogList>
  pickFolder(title: string): Promise<string | null>
  importScan(source: string): Promise<{ images: number; raw: number }>
  /** Every supported photo under a folder, for choosing which to import. */
  importList(source: string): Promise<ImportItem[]>
  /** A small picture of one of those photos. */
  importThumbUrl(path: string): string
  /** The cameras, lenses and ranges in the catalog, for the Metadata filter. */
  metadataValues(): Promise<MetadataValues>
  /** Find the faces in a photo (after its lens corrections and crop), as portraits with every slider at its starting value. */
  portraitDetect(id: number, recipe: Recipe): Promise<{ faces: Portrait[]; aspect: number }>
  /** Import the photos in `files` (all of the folder when not given). */
  importRun(source: string, mode: 'add' | 'copy' | 'copy_dng' | 'move', destination: string | null, files?: string[], options?: ImportOptions): Promise<ImportResult>
  photoQuery(q: Query): Promise<Page>
  folderList(): Promise<FolderRow[]>
  /** Rename a folder on the disk and in the catalog (the folders inside it follow). */
  folderRename(folderId: number, newName: string): Promise<void>
  /** Move a folder into another folder of the same place, or to the top of the place when no destination is given. */
  folderMove(folderId: number, destination: number | null): Promise<void>
  setRating(ids: number[], rating: number): Promise<void>
  setFlag(ids: number[], flag: Flag): Promise<void>
  setLabel(ids: number[], label: Label | null): Promise<void>
  /** newFolder: a name; the files then go into a folder of that name made inside the destination */
  exportRun(ids: number[], destination: string, settings: ExportSettings, newFolder?: string | null): Promise<ExportResult>
  /** How an export of this photo would look with these settings, as a small picture (a data URL). */
  exportPreview(id: number, settings: ExportSettings): Promise<string>
  /** Look at these photos' previews for culling: how sharp, how well exposed, and which are bursts or near-duplicates. Changes nothing. */
  cullScan(ids: number[]): Promise<CullReport>
  /** The main subject of the picture as it is framed now, as the text of a small grey picture to keep in a Subject mask. */
  maskSubject(id: number, recipe: Recipe): Promise<{ map: string }>
  /** One part of every person in the picture: skin, neck, eyes, brows, lips, teeth, hair or clothes. */
  maskPerson(id: number, recipe: Recipe, part: string): Promise<{ map: string }>
  /** How near each part of the photo is (as the recipe crops it), as a small grey picture kept as text: white near, black far. */
  maskDepth(id: number, recipe: Recipe): Promise<{ map: string }>
  /** The object under the point (x, y) (fractions of the photo as the recipe crops it), found by the object model: a small grey picture kept as text. The first point on a photo takes several seconds. */
  maskObject(id: number, recipe: Recipe, x: number, y: number): Promise<{ map: string; confidence: number }>
  /** B BOT: looks at the photo as the recipe draws it and suggests changes (skin tone, light, colour). */
  advisePhoto(id: number, recipe: Recipe): Promise<Advice>
  /** About how big the photo is after its turn and crop. */
  enlargeInfo(id: number, recipe: Recipe): Promise<{ width: number; height: number }>
  /** The middle of the edited picture at 100% (pixels repeated) and enlarged four times by the method, as picture links. */
  enlargePreview(id: number, recipe: Recipe, method: EnlargeMethod): Promise<{ before: string; after: string }>
  /** Ask for an image file (for a watermark); null when the person cancels. */
  pickImage(title: string): Promise<string | null>
  photoIds(q: Omit<Query, 'offset' | 'limit'>): Promise<number[]>
  photoRemove(ids: number[]): Promise<number>
  /** The files (photos and their sidecars) that deleting these photos from the disk would move to the Recycle Bin. */
  photoDeletePreview(ids: number[]): Promise<string[]>
  /** Move the photos' files to the Recycle Bin and take the photos out of the catalog; if the files cannot be moved nothing is removed. */
  photoDeleteFromDisk(ids: number[]): Promise<number>
  collectionList(): Promise<CollectionRow[]>
  /** A collection set: a folder of collections (and of other sets). */
  collectionSetCreate(name: string, parent: number | null): Promise<number>
  /** Put a collection, smart collection or set inside a set, or back at the top (null). */
  collectionMove(id: number, parent: number | null): Promise<void>
  collectionCreate(name: string): Promise<number>
  /** Smart collections fill themselves from rules. */
  smartCreate(name: string, rules: SmartRules): Promise<number>
  smartUpdate(id: number, name: string, rules: SmartRules): Promise<void>
  smartRules(id: number): Promise<SmartRules>
  /** How many photos meet the rules now; refuses rules that are not valid, in words. */
  smartCount(rules: SmartRules): Promise<number>
  collectionRename(id: number, name: string): Promise<void>
  collectionDelete(id: number): Promise<void>
  collectionAdd(id: number, photoIds: number[]): Promise<void>
  collectionRemove(id: number, photoIds: number[]): Promise<void>
  collectionSetTarget(id: number | null): Promise<void>
  /** B key. Returns true when photos were added, false when removed. */
  quickToggle(photoIds: number[]): Promise<boolean>
  keywordList(): Promise<KeywordRow[]>
  /** Adds one keyword path ("Parent > Child") to the photos, creating it if needed. Returns the leaf id. */
  keywordAdd(photoIds: number[], path: string[]): Promise<number>
  keywordRemove(photoIds: number[], keywordId: number): Promise<void>
  /** A keyword's synonyms (comma separated), whether it goes into sidecar files, and whether it is private. */
  keywordSetOptions(id: number, synonyms: string, includeOnExport: boolean, isPrivate: boolean): Promise<void>
  keywordsFor(photoIds: number[]): Promise<KeywordUse[]>
  /** Up to two distinct values per field, '' for empty: enough to tell "same" from "mixed". */
  metadataGet(photoIds: number[]): Promise<Record<'title' | 'caption' | 'creator' | 'copyright' | 'credit' | 'source' | 'sublocation' | 'city' | 'state' | 'country' | 'headline' | 'jobTitle' | 'instructions' | 'jobId' | 'usageTerms', string[]>>
  metadataSet(photoIds: number[], patch: MetaPatch): Promise<void>
  previewUrl(id: number, level: PreviewLevel, version: number | string): string
  developGet(id: number): Promise<DevelopState>
  /** Stores the recipe. With a step it also adds a history entry. */
  developSave(id: number, recipe: Recipe, step: StepIn | null): Promise<void>
  /** The standard preview with the recipe applied. */
  /** `edge` asks for a smaller picture (long side in pixels) while a slider is being dragged. 0 is full size. */
  renderUrl(id: number, recipe: Recipe, version: number, edge?: number, overlay?: string, proof?: { gamut: boolean; rev: number }): string
  /** Look for dust and sensor specks in the photo as the recipe crops it; each comes with a source to heal from. Nothing is changed. */
  developFindDust(id: number, recipe: Recipe): Promise<{ x: number; y: number; sx: number; sy: number; size: number }[]>
  /** Choose the colour profile to proof with (a file), or none to stop. "intent" is how colours the profile cannot hold are handled. Returns its name. */
  proofSet(path: string | null, intent: ProofIntent): Promise<{ name: string } | null>
  /** Let the person choose a colour profile file (.icc or .icm). */
  pickProfile(): Promise<string | null>
  /** Suggested tone and white balance, worked out from the photo. */
  developAuto(id: number): Promise<AutoSettings>
  /** A good place to copy from for a new spot at (x, y) of this size (fractions of the picture). */
  developSpotSource(id: number, x: number, y: number, size: number): Promise<[number, number]>
  presetList(): Promise<PresetRow[]>
  presetCreate(name: string, group: string | null, groups: string[], recipe: Recipe): Promise<number>
  presetRename(id: number, name: string): Promise<void>
  presetDelete(id: number): Promise<void>
  snapshotList(photoId: number): Promise<SnapshotRow[]>
  snapshotCreate(photoId: number, name: string, recipe: Recipe): Promise<number>
  snapshotDelete(id: number): Promise<void>
  /** Decode the photo at full size and crop it by the recipe, for the 1:1 view. Returns the size of that picture. */
  zoomOpen(id: number, recipe: Recipe): Promise<{ width: number; height: number }>
  /** Let go of the full-size picture. */
  zoomClose(): Promise<void>
  /** A window (x, y, w, h in full-size pixels) of the full-size picture with the recipe applied. */
  regionUrl(id: number, recipe: Recipe, x: number, y: number, w: number, h: number, version: number): string
  on<T>(event: 'import:progress' | 'preview:ready' | 'preview:edited' | 'preview:progress' | 'export:progress' | 'enlarge:progress' | 'cull:progress' | 'book:progress' | 'missing:progress' | 'xmp:progress' | 'smart:progress' | 'merge:progress' | 'watch:imported' | 'watch:newest' | 'second:show' | 'second:closed' | 'catalog:changed', cb: (p: T) => void): Promise<() => void>
}

// ---- Book ------------------------------------------------------------------------

export type FrameKind = 'photo' | 'text'
export type FrameFit = 'fill' | 'fit'
export type FrameAlign = 'left' | 'centre' | 'right'

/** A photo or some text on a page. Its place is a rectangle in fractions of the page (0 to 1). */
export interface BookFrame {
  kind: FrameKind
  x: number
  y: number
  w: number
  h: number
  photoId: number | null
  fit: FrameFit
  /** which part of the picture stays when it is cropped, 0 to 1 across and down */
  focusX: number
  focusY: number
  text: string
  sizePt: number
  align: FrameAlign
  bold: boolean
  colour: string
}

export interface BookPage {
  background: string
  frames: BookFrame[]
}

export interface BookDoc {
  name: string
  widthMm: number
  heightMm: number
  pageNumbers: boolean
  pages: BookPage[]
}

export interface BookEntry {
  id: number
  name: string
  pages: number
  updated: number
}

export interface BookPdfResult {
  file: string
  pages: number
  warnings: string[]
}
