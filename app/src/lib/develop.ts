import { create } from 'zustand'
import { api } from './api'
import { useStore } from './store'
import { num } from './format'
import { applyGroups, BUILTIN_PRESETS, DEFAULT_COPY_GROUPS, type AdaptivePreset } from './presets'
import { moveText, nudged } from './quickdevelop'
import { turnRecipe, type TurnOp } from './localmap'
import { AUTO_RETOUCH, MAX_PORTRAITS, layoutFace, mergeDetected, type RegionKey } from './portraitedit'
import { DEFAULT_RED_EYE, MAX_RED_EYES, MAX_RED_EYE_SIZE, MIN_RED_EYE_SIZE, makeRedEye, newRedEyeId, type RedEyeDefaults } from './redeyeedit'
import { DEFAULT_SPOT, fallbackSource, makeSpot, newSpotId, type SpotDefaults } from './spotedit'
import { DEFAULT_RECIPE, type AutoSettings, type Portrait, type MaskOp, type MaskPart, type Spot, type LocalAdjust, type Mask, type MaskShape, type Stroke, type HistoryRow, type PresetRow, type Recipe, type SnapshotRow, type StepIn } from './types'

export { DEFAULT_RECIPE }

export type SliderKey = Exclude<keyof Recipe, 'profile' | 'profileAmount' | 'crop' | 'curve' | 'curveRed' | 'curveGreen' | 'curveBlue' | 'parametric' | 'grading' | 'calibration' | 'hsl' | 'detail' | 'effects' | 'masks' | 'spots' | 'redEyes' | 'portraits' | 'geometry'>

export interface SliderDef {
  key: SliderKey
  label: string
  min: number
  max: number
  step: number
  digits: number
  /** a CSS gradient for the slider line, for the sliders whose two ends are colours (Tint) */
  gradient?: string
}

/** Green at the far left, through a neutral middle, to magenta at the far right. */
export const TINT_GRADIENT = 'linear-gradient(to right, #1fd16a, #8a9a90 50%, #e23bd0)'

export const BASIC_GROUPS: { title: string; sliders: SliderDef[] }[] = [
  {
    title: 'White balance',
    sliders: [
      { key: 'temperature', label: 'Temperature', min: -100, max: 100, step: 1, digits: 0 },
      // far left is green, far right is magenta: the colour that is being added
      { key: 'tint', label: 'Tint', min: -100, max: 100, step: 1, digits: 0, gradient: TINT_GRADIENT },
    ],
  },
  {
    title: 'Tone',
    sliders: [
      { key: 'exposure', label: 'Exposure', min: -5, max: 5, step: 0.01, digits: 2 },
      { key: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1, digits: 0 },
      { key: 'highlights', label: 'Highlights', min: -100, max: 100, step: 1, digits: 0 },
      { key: 'shadows', label: 'Shadows', min: -100, max: 100, step: 1, digits: 0 },
      { key: 'whites', label: 'Whites', min: -100, max: 100, step: 1, digits: 0 },
      { key: 'blacks', label: 'Blacks', min: -100, max: 100, step: 1, digits: 0 },
    ],
  },
  {
    title: 'Presence',
    sliders: [
      { key: 'texture', label: 'Texture', min: -100, max: 100, step: 1, digits: 0 },
      { key: 'clarity', label: 'Clarity', min: -100, max: 100, step: 1, digits: 0 },
      { key: 'dehaze', label: 'Dehaze', min: -100, max: 100, step: 1, digits: 0 },
      { key: 'vibrance', label: 'Vibrance', min: -100, max: 100, step: 1, digits: 0 },
      { key: 'saturation', label: 'Saturation', min: -100, max: 100, step: 1, digits: 0 },
    ],
  },
]

export const SLIDERS: SliderDef[] = BASIC_GROUPS.flatMap((g) => g.sliders)
export const sliderDef = (key: SliderKey) => SLIDERS.find((s) => s.key === key)!

// ---- effects: vignette and grain -----------------------------------------------------------

export type EffectKey = keyof Recipe['effects']
export const EFFECT_KEYS: EffectKey[] = ['vignetteAmount', 'vignetteMidpoint', 'vignetteFeather', 'vignetteRoundness', 'grainAmount', 'grainSize', 'grainRoughness']

export interface EffectDef {
  key: EffectKey
  label: string
  step: string
  min: number
  max: number
}

export const VIGNETTE: EffectDef[] = [
  { key: 'vignetteAmount', label: 'Amount', step: 'Vignette amount', min: -100, max: 100 },
  { key: 'vignetteMidpoint', label: 'Midpoint', step: 'Vignette midpoint', min: 0, max: 100 },
  { key: 'vignetteFeather', label: 'Feather', step: 'Vignette feather', min: 0, max: 100 },
  { key: 'vignetteRoundness', label: 'Roundness', step: 'Vignette roundness', min: 0, max: 100 },
]
export const GRAIN: EffectDef[] = [
  { key: 'grainAmount', label: 'Amount', step: 'Grain amount', min: 0, max: 100 },
  { key: 'grainSize', label: 'Size', step: 'Grain size', min: 0, max: 100 },
  { key: 'grainRoughness', label: 'Roughness', step: 'Grain roughness', min: 0, max: 100 },
]
export const effectsIsDefault = (r: Recipe) => EFFECT_KEYS.every((k) => r.effects[k] === DEFAULT_RECIPE.effects[k])

export function effectStep(def: EffectDef, before: Recipe, after: Recipe): StepIn {
  return { label: def.step, deltaText: signed(after.effects[def.key] - before.effects[def.key], 0), valueText: num(after.effects[def.key], 0) }
}

// ---- lens corrections and transform --------------------------------------------------------

export type GeometryKey = Exclude<keyof Recipe['geometry'], 'constrain' | 'quarterTurns' | 'mirror'>
export const GEOMETRY_KEYS: (keyof Recipe['geometry'])[] = ['distortion', 'caRed', 'caBlue', 'vertical', 'horizontal', 'rotate', 'aspect', 'scale', 'xOffset', 'yOffset', 'constrain', 'quarterTurns', 'mirror']

export interface GeometryDef {
  key: GeometryKey
  label: string
  min: number
  max: number
  step: number
  digits: number
  neutral: number
}

export const LENS: GeometryDef[] = [
  { key: 'distortion', label: 'Distortion', min: -100, max: 100, step: 1, digits: 0, neutral: 0 },
  { key: 'caRed', label: 'Red/cyan fringe', min: -100, max: 100, step: 1, digits: 0, neutral: 0 },
  { key: 'caBlue', label: 'Blue/yellow fringe', min: -100, max: 100, step: 1, digits: 0, neutral: 0 },
]
export const TRANSFORM: GeometryDef[] = [
  { key: 'vertical', label: 'Vertical', min: -100, max: 100, step: 1, digits: 0, neutral: 0 },
  { key: 'horizontal', label: 'Horizontal', min: -100, max: 100, step: 1, digits: 0, neutral: 0 },
  { key: 'rotate', label: 'Rotate', min: -10, max: 10, step: 0.1, digits: 1, neutral: 0 },
  { key: 'aspect', label: 'Aspect', min: -100, max: 100, step: 1, digits: 0, neutral: 0 },
  { key: 'scale', label: 'Scale', min: 50, max: 200, step: 1, digits: 0, neutral: 100 },
  { key: 'xOffset', label: 'X offset', min: -100, max: 100, step: 1, digits: 0, neutral: 0 },
  { key: 'yOffset', label: 'Y offset', min: -100, max: 100, step: 1, digits: 0, neutral: 0 },
]
export const geometryDef = (key: GeometryKey) => [...LENS, ...TRANSFORM].find((d) => d.key === key)!
export const lensIsDefault = (r: Recipe) => LENS.every((d) => r.geometry[d.key] === d.neutral)
export const transformIsDefault = (r: Recipe) => TRANSFORM.every((d) => r.geometry[d.key] === d.neutral) && r.geometry.constrain === DEFAULT_RECIPE.geometry.constrain && r.geometry.quarterTurns === 0 && !r.geometry.mirror

export function geometryStep(def: GeometryDef, before: Recipe, after: Recipe): StepIn {
  const group = LENS.includes(def) ? 'Lens' : 'Transform'
  return { label: `${group}: ${def.label}`, deltaText: signed(after.geometry[def.key] - before.geometry[def.key], def.digits), valueText: num(after.geometry[def.key], def.digits) }
}

// ---- masks -----------------------------------------------------------------------------------

export const MAX_SPOTS = 50

export type MaskType = MaskShape['type']
export const MAX_MASKS = 10
/** The parts of a person the People masks can pick out. */
export type PersonPart = 'skin' | 'hair' | 'eyes' | 'lips' | 'brows' | 'neck' | 'teeth' | 'clothes'
export const PERSON_PARTS: { part: PersonPart; label: string }[] = [
  { part: 'skin', label: 'Face skin' },
  { part: 'hair', label: 'Hair' },
  { part: 'eyes', label: 'Eyes' },
  { part: 'brows', label: 'Eyebrows' },
  { part: 'lips', label: 'Lips' },
  { part: 'teeth', label: 'Teeth' },
  { part: 'neck', label: 'Neck' },
  { part: 'clothes', label: 'Clothes' },
]

export const MASK_TYPE_LABEL: Record<MaskType, string> = { linear: 'Linear gradient', radial: 'Radial gradient', brush: 'Brush', luminance: 'Luminance range', colour: 'Colour range', subject: 'Subject', sky: 'Sky', depth: 'Depth range' }
export const MASK_OP_LABEL: Record<MaskOp, string> = { add: 'Add', subtract: 'Subtract', intersect: 'Intersect' }
/** The most shapes combined with a mask's first (the core keeps six). */
export const MAX_PARTS = 6

export interface AdjustDef {
  key: keyof LocalAdjust
  label: string
  min: number
  max: number
  step: number
  digits: number
}

export const MASK_ADJUSTMENTS: AdjustDef[] = [
  { key: 'exposure', label: 'Exposure', min: -5, max: 5, step: 0.01, digits: 2 },
  { key: 'contrast', label: 'Contrast', min: -100, max: 100, step: 1, digits: 0 },
  { key: 'highlights', label: 'Highlights', min: -100, max: 100, step: 1, digits: 0 },
  { key: 'shadows', label: 'Shadows', min: -100, max: 100, step: 1, digits: 0 },
  { key: 'saturation', label: 'Saturation', min: -100, max: 100, step: 1, digits: 0 },
  { key: 'temperature', label: 'Temperature', min: -100, max: 100, step: 1, digits: 0 },
  { key: 'sharpness', label: 'Sharpness', min: 0, max: 100, step: 1, digits: 0 },
  { key: 'noise', label: 'Noise reduction', min: 0, max: 100, step: 1, digits: 0 },
  { key: 'blur', label: 'Lens blur', min: 0, max: 100, step: 1, digits: 0 },
]

export const NO_ADJUST: LocalAdjust = { exposure: 0, contrast: 0, highlights: 0, shadows: 0, saturation: 0, temperature: 0, sharpness: 0, noise: 0, blur: 0 }

let maskCounter = 0
export const newMaskId = () => `m${Date.now().toString(36)}${(maskCounter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`

/** A fresh shape of one kind: visible, easy to move, and a sensible starting range. */
export function defaultShape(type: MaskType): MaskShape {
  switch (type) {
    case 'linear':
      return { type, x1: 0.5, y1: 0.15, x2: 0.5, y2: 0.55, feather: 0.6 }
    case 'radial':
      return { type, cx: 0.5, cy: 0.5, rx: 0.22, ry: 0.16, angle: 0, feather: 0.5 }
    case 'brush':
      return { type, strokes: [] }
    case 'luminance':
      return { type, lo: 0.6, hi: 1, smooth: 0.3 }
    case 'colour':
      return { type, hue: 0, range: 30, sat: 0.2, smooth: 0.4 }
    case 'subject':
      return { type, map: '' }
    case 'sky':
      return { type, sensitivity: 0.5 }
    case 'depth':
      return { type, map: '', near: 0.6, far: 1, smooth: 0.3 }
  }
}

/** A fresh mask of one kind. */
export function newMask(type: MaskType, existing: Mask[]): Mask {
  const n = existing.filter((m) => m.shape.type === type).length + 1
  return { id: newMaskId(), name: `${MASK_TYPE_LABEL[type]} ${n}`, visible: true, invert: false, shape: defaultShape(type), parts: [], adjust: { ...NO_ADJUST } }
}

/** The shape being edited: the mask's first, or one of its combined parts. */
export const targetShape = (m: Mask, part: number | null): MaskShape => (part === null ? m.shape : (m.parts[part]?.shape ?? m.shape))

/** The change to a mask that puts `shape` in as the edited shape. */
export function withTargetShape(m: Mask, part: number | null, shape: MaskShape): Partial<Mask> {
  return part === null || !m.parts[part] ? { shape } : { parts: m.parts.map((p, i) => (i === part ? { ...p, shape } : p)) }
}

/** What a new combined shape starts as: ranges narrow what is there, shapes add to it. */
export const defaultOp = (type: MaskType): MaskOp => (type === 'luminance' || type === 'colour' ? 'intersect' : 'add')

/** Is this the kind of shape you place on the picture with handles or a brush? */
export const hasHandles = (s: MaskShape) => s.type === 'linear' || s.type === 'radial' || s.type === 'brush'

export const maskById = (r: Recipe, id: string | null) => (id ? r.masks.find((m) => m.id === id) : undefined)

/** Replace one mask, leaving the others. */
export function withMask(r: Recipe, id: string, patch: Partial<Mask>): Mask[] {
  return r.masks.map((m) => (m.id === id ? { ...m, ...patch } : m))
}

export function withAdjust(r: Recipe, id: string, key: keyof LocalAdjust, value: number): Mask[] {
  return r.masks.map((m) => (m.id === id ? { ...m, adjust: { ...m.adjust, [key]: value } } : m))
}

export const adjustStep = (m: Mask, def: AdjustDef, before: Mask | undefined): StepIn => ({
  label: `${m.name}: ${def.label}`,
  deltaText: signed(m.adjust[def.key] - (before?.adjust[def.key] ?? 0), def.digits),
  valueText: signed(m.adjust[def.key], def.digits),
})

export const DEFAULT_BRUSH = { size: 0.08, feather: 0.5, flow: 1, erase: false }
export type BrushSettings = typeof DEFAULT_BRUSH

// ---- 1:1 zoom ------------------------------------------------------------------------------

/** What the full-size picture is prepared for: the crop and the lens and transform settings. If these change, 1:1 starts over. */
export const cropKey = (c: Recipe['crop'], g: Recipe['geometry'] = DEFAULT_RECIPE.geometry) => `${c.aspect}:${c.angle.toFixed(3)}:${JSON.stringify(c.rect)}|${JSON.stringify(g)}`

/** The window of the full-size picture (W by H) that fills a viewport (vw by vh) centred as near (cx, cy) as the edges allow. */
export function windowFor(cx: number, cy: number, W: number, H: number, vw: number, vh: number) {
  const w = Math.max(1, Math.min(vw, W))
  const h = Math.max(1, Math.min(vh, H))
  return {
    x: Math.round(Math.min(W - w, Math.max(0, cx - w / 2))),
    y: Math.round(Math.min(H - h, Math.max(0, cy - h / 2))),
    w,
    h,
  }
}

/** Keep the centre where the window can actually be: a picture smaller than the viewport stays centred. */
export function clampCentre(cx: number, cy: number, W: number, H: number, vw: number, vh: number): [number, number] {
  const fit = (c: number, size: number, view: number) => (size <= view ? size / 2 : Math.min(size - view / 2, Math.max(view / 2, c)))
  return [fit(cx, W, vw), fit(cy, H, vh)]
}

export interface ZoomState {
  on: boolean
  loading: boolean
  /** size of the full picture after the crop */
  width: number
  height: number
  /** the centre of the view, in full-size pixels */
  cx: number
  cy: number
  /** the crop the full picture was prepared for; if the recipe's crop moves away from it, zoom ends */
  crop: string | null
  /** size of the viewport in device pixels */
  vw: number
  vh: number
}

export const NO_ZOOM: ZoomState = { on: false, loading: false, width: 0, height: 0, cx: 0, cy: 0, crop: null, vw: 800, vh: 600 }

// ---- detail: sharpening and noise reduction -----------------------------------------------

export type DetailKey = keyof Recipe['detail']
export const DETAIL_KEYS: DetailKey[] = ['sharpAmount', 'sharpRadius', 'sharpMasking', 'sharpDetail', 'nrLuma', 'nrLumaDetail', 'nrLumaContrast', 'nrColour', 'nrColourSmooth']

export interface DetailDef {
  key: DetailKey
  label: string
  /** the step name in History */
  step: string
  min: number
  max: number
  step_: number
  digits: number
}

export const SHARPENING: DetailDef[] = [
  { key: 'sharpAmount', label: 'Amount', step: 'Sharpening amount', min: 0, max: 150, step_: 1, digits: 0 },
  { key: 'sharpRadius', label: 'Radius', step: 'Sharpening radius', min: 0.5, max: 3, step_: 0.1, digits: 1 },
  { key: 'sharpDetail', label: 'Detail', step: 'Sharpening detail', min: 0, max: 100, step_: 1, digits: 0 },
  { key: 'sharpMasking', label: 'Masking', step: 'Sharpening masking', min: 0, max: 100, step_: 1, digits: 0 },
]
export const NOISE_REDUCTION: DetailDef[] = [
  { key: 'nrLuma', label: 'Luminance', step: 'Luminance noise reduction', min: 0, max: 100, step_: 1, digits: 0 },
  { key: 'nrLumaDetail', label: 'Luminance detail', step: 'Luminance noise reduction detail', min: 0, max: 100, step_: 1, digits: 0 },
  { key: 'nrLumaContrast', label: 'Luminance contrast', step: 'Luminance noise reduction contrast', min: 0, max: 100, step_: 1, digits: 0 },
  { key: 'nrColour', label: 'Colour', step: 'Colour noise reduction', min: 0, max: 100, step_: 1, digits: 0 },
  { key: 'nrColourSmooth', label: 'Colour smoothness', step: 'Colour noise reduction smoothness', min: 0, max: 100, step_: 1, digits: 0 },
]
export const detailDef = (key: DetailKey) => [...SHARPENING, ...NOISE_REDUCTION].find((d) => d.key === key)!
export const detailIsDefault = (r: Recipe) => DETAIL_KEYS.every((k) => r.detail[k] === DEFAULT_RECIPE.detail[k])

export function detailStep(key: DetailKey, before: Recipe, after: Recipe): StepIn {
  const d = detailDef(key)
  return { label: d.step, deltaText: signed(after.detail[key] - before.detail[key], d.digits), valueText: num(after.detail[key], d.digits) }
}

// ---- colour mixer ----------------------------------------------------------------------

export const MIXER_KINDS = ['hue', 'sat', 'lum'] as const
export type MixerKind = (typeof MIXER_KINDS)[number]
export const MIXER_KIND_LABEL: Record<MixerKind, string> = { hue: 'Hue', sat: 'Saturation', lum: 'Luminance' }
export const BANDS = ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta'] as const
// Identify each band in the mixer, like the histogram channels. They do not follow the theme.
export const BAND_COLOURS = ['#e0413a', '#f08a2c', '#e0c53a', '#3fae4f', '#2fb5b0', '#3b6fe0', '#8a4fd0', '#d04fa8']

export const mixerIsDefault = (r: Recipe) => MIXER_KINDS.every((k) => r.hsl[k].every((v) => v === 0))

export function withMixer(r: Recipe, kind: MixerKind, band: number, value: number): Recipe['hsl'] {
  return { ...r.hsl, [kind]: r.hsl[kind].map((v, i) => (i === band ? value : v)) }
}

export function mixerStep(kind: MixerKind, band: number, before: Recipe, after: Recipe): StepIn {
  return {
    label: `${BANDS[band]} ${MIXER_KIND_LABEL[kind].toLowerCase()}`,
    deltaText: signed(after.hsl[kind][band] - before.hsl[kind][band], 0),
    valueText: signed(after.hsl[kind][band], 0),
  }
}

export const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0)

/** "+0,35" style, with the sign always shown for non-zero values. Locale decimal comma kept. */
export function signed(v: number, digits: number): string {
  const r = Number(v.toFixed(digits))
  return `${r > 0 ? '+' : ''}${num(r, digits)}`
}

export const isDefault = (r: Recipe) => recipesEqual(r, DEFAULT_RECIPE)

export const PARAMETRIC_KEYS = ['highlights', 'lights', 'darks', 'shadows'] as const
export type ParametricKey = (typeof PARAMETRIC_KEYS)[number]

export function recipesEqual(a: Recipe, b: Recipe): boolean {
  return (
    SLIDERS.every((s) => a[s.key] === b[s.key]) &&
    a.crop.aspect === b.crop.aspect &&
    a.crop.angle === b.crop.angle &&
    JSON.stringify(a.crop.rect) === JSON.stringify(b.crop.rect) &&
    MIXER_KINDS.every((k) => a.hsl[k].every((v, i) => v === b.hsl[k][i])) &&
    DETAIL_KEYS.every((k) => a.detail[k] === b.detail[k]) &&
    EFFECT_KEYS.every((k) => a.effects[k] === b.effects[k]) &&
    JSON.stringify(a.masks) === JSON.stringify(b.masks) &&
    JSON.stringify(a.spots) === JSON.stringify(b.spots) &&
    JSON.stringify(a.redEyes) === JSON.stringify(b.redEyes) &&
    JSON.stringify(a.portraits) === JSON.stringify(b.portraits) &&
    GEOMETRY_KEYS.every((k) => a.geometry[k] === b.geometry[k]) &&
    (['curve', 'curveRed', 'curveGreen', 'curveBlue'] as const).every((k) => JSON.stringify(a[k] ?? []) === JSON.stringify(b[k] ?? [])) &&
    PARAMETRIC_KEYS.every((k) => (a.parametric?.[k] ?? 0) === (b.parametric?.[k] ?? 0)) &&
    JSON.stringify(a.grading ?? DEFAULT_RECIPE.grading) === JSON.stringify(b.grading ?? DEFAULT_RECIPE.grading) &&
    JSON.stringify(a.calibration ?? DEFAULT_RECIPE.calibration) === JSON.stringify(b.calibration ?? DEFAULT_RECIPE.calibration) &&
    (a.profile ?? '') === (b.profile ?? '') &&
    (a.profileAmount ?? 100) === (b.profileAmount ?? 100)
  )
}

export function stepForSlider(key: SliderKey, before: Recipe, after: Recipe): StepIn {
  const d = sliderDef(key)
  return { label: d.label, deltaText: signed(after[key] - before[key], d.digits), valueText: signed(after[key], d.digits) }
}

export const cropLabel = (c: Recipe['crop']) => (c.aspect === 'original' ? 'Original ratio' : c.aspect === 'free' ? 'Freeform' : c.aspect)

/** Is the crop and straighten untouched? */
export const cropIsDefault = (c: Recipe['crop']) => c.aspect === 'original' && c.angle === 0 && c.rect === null

/** What the crop panel asks the picture to do once it knows the picture's size. */
export type CropRequest = { kind: 'aspect'; aspect: Recipe['crop']['aspect'] } | { kind: 'swap' }

// ---- the Develop store ---------------------------------------------------------------

interface DevelopStore {
  photoId: number | null
  /** What the screen shows right now, including a slider that is still being dragged. */
  recipe: Recipe
  /** The last recipe that reached the catalog. */
  saved: Recipe
  /** the settings the photo had when it was opened in Develop (for Previous) */
  opened: Recipe
  history: HistoryRow[]
  loading: boolean
  error: string | null
  showOriginal: boolean
  /** Before and after: the picture alone, the two side by side, or one picture split down the middle (Y steps through them) */
  compareView: 'off' | 'side' | 'split'
  setCompareView(v: 'off' | 'side' | 'split'): void
  /** Develop panels switched off with their eye: the picture is shown without their settings, which are kept. */
  panelsOff: string[]
  togglePanel(id: string): void
  /** Copied settings: the recipe and which groups of it to paste. */
  clipboard: { recipe: Recipe; groups: string[] } | null
  presets: PresetRow[]
  snapshots: SnapshotRow[]
  /** A preset being previewed while the pointer is over it. Not saved. */
  hover: Recipe | null
  /** bumps when an edit lands, so the picture reloads */
  version: number
  zoom: ZoomState
  /** the mask being edited, shown with handles on the picture */
  selectedMask: string | null
  brush: BrushSettings
  /** which of the mask's combined shapes is being edited; null is its first */
  selectedPart: number | null
  /** the next click on the picture picks a colour for the selected colour range */
  picking: boolean
  /** tint the selected mask red on the picture */
  showMask: boolean
  /** the spot being edited, shown with its two circles on the picture */
  selectedSpot: string | null
  /** the spot tool is on: a click on the picture adds a spot there */
  spotTool: boolean
  /** what a new spot starts with; the sliders of the Spots panel change these when no spot is selected */
  spotDefaults: SpotDefaults
  /** a brush stroke is being drawn right now: the picture is rendered smaller so it keeps up */
  painting: boolean
  /** the portrait tool is on: a click on a face marks it */
  portraitTool: boolean
  /** the marked region being shaped (face, an eye or the mouth) */
  selectedRegion: RegionKey | null
  /** which face the portrait sliders and regions belong to (an index into the recipe's faces) */
  selectedFace: number
  /** every marked face is selected: the Skin, Teeth and Eyes sliders change all of them together */
  allFaces: boolean
  /** the detector is looking for faces */
  detecting: boolean
  /** what the last search for faces found, in words */
  faceNote: string | null
  /** show blown highlights in red and crushed shadows in blue over the picture (a view setting, kept while moving between photos) */
  clipping: boolean
  toggleClipping(): void
  /** show the picture as a map of its small specks, to find dust (a view setting too) */
  spotView: boolean
  toggleSpotView(): void
  /** the saved states before each edit, newest last: what Undo goes back to */
  undoStack: Recipe[]
  /** the states that were undone, newest last: what Redo goes forward to */
  redoStack: Recipe[]
  /** the red-eye circle being edited */
  selectedRedEye: string | null
  /** the red-eye tool is on: a click on an eye adds a circle there */
  redEyeTool: boolean
  /** what a new circle starts with; the sliders of the Red eye panel change these when no circle is selected */
  redEyeDefaults: RedEyeDefaults
  /** the frame tool is on: the whole picture is shown with the crop frame on it, ready to be moved and resized */
  cropEdit: boolean
  /** an aspect or swap picked in the panel, waiting for the frame on the picture to carry it out */
  cropRequest: CropRequest | null
  /** the Straighten tool: draw a line along something that should be level or upright */
  straightenTool: boolean
  setStraightenTool(on: boolean): void

  open(id: number | null): Promise<void>
  setCropEdit(on: boolean): void
  requestCrop(req: CropRequest | null): void
  /** A change that is still in progress (dragging). Not saved, no history. */
  live(patch: Partial<Recipe>): void
  /** Save the current recipe as one history step. A no-op if nothing changed. `track` false keeps it out of undo (undo and redo themselves). */
  commit(step: StepIn, track?: boolean): Promise<void>
  /** Go back to how the photo was before the last edit (this session; Ctrl+Z). */
  undo(): Promise<void>
  /** Do again what was undone (Ctrl+Shift+Z). */
  redo(): Promise<void>
  /** Paste the copied settings onto several photos (the Library's Paste settings): only the copied groups change, nothing else of theirs. */
  pasteToMany(ids: number[], label?: string): Promise<{ done: number; same: number; failed: string[] }>
  /** Turn or flip each photo (from the Library), as a History step; the crop frame starts again. */
  turnMany(ids: number[], label: string, op: TurnOp): Promise<{ done: number; failed: string[] }>
  /** Quick Develop: move one slider by `delta` on each photo (kept inside the slider's range). */
  nudgeMany(ids: number[], key: SliderKey, delta: number): Promise<{ done: number; failed: string[] }>
  /** Quick Develop: Auto tone or Auto white balance on each photo (the named sliders only). */
  autoMany(ids: number[], label: string, keys: (keyof AutoSettings)[]): Promise<{ done: number; failed: string[] }>
  /** Quick Develop: put every photo back to no edits. */
  resetMany(ids: number[]): Promise<{ done: number; failed: string[] }>
  /** Put a preset on photos that are not open (the ones just imported). */
  applyPresetToMany(ids: number[], p: PresetRow): Promise<{ done: number; failed: string[] }>
  /** Give the other photos selected in the Library this photo's settings (only the ticked groups). Each one is a history step on that photo. */
  syncToSelection(groups: string[]): Promise<void>
  /** Paste the copied settings onto the photos selected in the Library, and say what happened. */
  pasteToSelection(): Promise<void>
  setAndCommit(patch: Partial<Recipe>, step: StepIn): Promise<void>
  resetSlider(key: SliderKey): Promise<void>
  resetAll(): Promise<void>
  /** Go back to how the photo was when it was opened in Develop (Previous). One history step; undoable. */
  previous(): Promise<void>
  goTo(row: HistoryRow): Promise<void>
  /** Copy the current settings. Without groups, every group except the crop. */
  copy(groups?: string[]): void
  paste(): Promise<void>
  loadPresets(): Promise<void>
  applyPreset(p: PresetRow): Promise<void>
  /** Find what the preset needs (the sky, the subject, the background), make a mask of it and put the preset's adjustments on it. */
  applyAdaptive(p: AdaptivePreset): Promise<void>
  previewPreset(p: PresetRow | null): void
  createPreset(name: string, group: string | null, groups: string[]): Promise<void>
  deletePreset(id: number): Promise<void>
  createSnapshot(name: string): Promise<void>
  applySnapshot(s: SnapshotRow): Promise<void>
  deleteSnapshot(id: number): Promise<void>
  toggleOriginal(): void
  addMask(type: MaskType): Promise<void>
  /** Subject and Background find the main subject (a moment's work for the model); Sky is found from the colours. */
  addAutoMask(kind: 'subject' | 'background' | 'sky' | 'near' | 'far'): Promise<void>
  /** A part of the people in the picture (their skin, hair, eyes, lips, brows, neck, teeth or clothes), found by the face parser, as a mask. */
  addPersonMask(part: PersonPart): Promise<void>
  /** Pointing at an object makes a mask of it: the next click on the picture finds the object under it. */
  objectTool: boolean
  setObjectTool(on: boolean): void
  addObjectMask(x: number, y: number): Promise<void>
  /** Make a mask of the near or the far part of the picture, found by the depth model. */
  addDepthMask(kind: 'near' | 'far'): Promise<void>
  /** The subject model is at work. */
  selecting: boolean
  selectMask(id: string | null): void
  /** A change to a mask that is still in progress (dragging a handle or slider). Not saved. */
  liveMask(id: string, patch: Partial<Mask>): void
  /** Save the current masks as one history step. */
  commitMasks(label: string): Promise<void>
  deleteMask(id: string): Promise<void>
  /** Add a finished brush stroke to a brush mask. */
  addStroke(id: string, stroke: Stroke): Promise<void>
  setBrush(patch: Partial<BrushSettings>): void
  selectPart(part: number | null): void
  /** Combine another shape with a mask. */
  addPart(maskId: string, type: MaskType): Promise<void>
  removePart(maskId: string, index: number): Promise<void>
  setPartOp(maskId: string, index: number, op: MaskOp): Promise<void>
  setPicking(on: boolean): void
  /** Set the selected colour range to a colour picked from the picture (hue in degrees, saturation 0 to 1). */
  pickColour(hue: number, sat: number): Promise<void>
  toggleShowMask(): void
  setPainting(on: boolean): void
  setSpotTool(on: boolean): void
  setRedEyeTool(on: boolean): void
  setPortraitTool(on: boolean): void
  /** Add a face where the picture was clicked (fractions of it). */
  markFace(at: [number, number], aspect: number): Promise<void>
  /** Look for faces and add the ones not already marked. */
  detectFaces(): Promise<void>
  selectFace(index: number): void
  /** Select every marked face (or go back to one). The Skin, Teeth and Eyes sliders then change all of them. */
  setAllFaces(on: boolean): void
  selectRegion(key: RegionKey | null): void
  /** A change to the selected face that is still in progress. Not saved, no history. */
  livePortrait(change: (p: Portrait) => Portrait): void
  /** Same, for the Skin, Teeth and Eyes sliders: it is made to every face when all faces are selected. */
  liveFaceSliders(change: (p: Portrait) => Portrait): void
  commitPortrait(label: string): Promise<void>
  deleteFace(index: number): Promise<void>
  /** Give every face the skin, teeth and eye settings of the selected one. */
  copyToAllFaces(): Promise<void>
  autoRetouch(): Promise<void>
  clearPortraits(): Promise<void>
  addRedEyeAt(at: [number, number]): Promise<void>
  /** Find the eyes with the face finder and put a red-eye circle on each (as one step). Returns how many were added. */
  findRedEyes(): Promise<number>
  selectRedEye(id: string | null): void
  liveRedEye(id: string, patch: Partial<Recipe['redEyes'][number]>): void
  commitRedEyes(label: string): Promise<void>
  deleteRedEye(id: string): Promise<void>
  deleteAllRedEyes(): Promise<void>
  setRedEyeDefaults(patch: Partial<RedEyeDefaults>): void
  /** Add a spot where the picture was clicked (fractions of it); the source is found by the core. */
  addSpotAt(at: [number, number], aspect: number): Promise<void>
  /** Look for dust and sensor specks and add a healing spot on each (as one step). Returns how many were added. */
  findDust(): Promise<number>
  selectSpot(id: string | null): void
  liveSpot(id: string, patch: Partial<Spot>): void
  commitSpots(label: string): Promise<void>
  deleteSpot(id: string): Promise<void>
  deleteAllSpots(): Promise<void>
  setSpotDefaults(patch: Partial<SpotDefaults>): void
  /** Let the core suggest tone settings (exposure to blacks) for this photo. */
  autoTone(): Promise<void>
  /** Let the core suggest a white balance (temperature and tint). */
  autoWhiteBalance(): Promise<void>
  /** Go to 1:1, centred on a point of the picture given as fractions (0 to 1). */
  zoomIn(fx?: number, fy?: number): Promise<void>
  zoomOut(): void
  toggleZoom(): void
  /** Move the view by this many full-size pixels. */
  panBy(dx: number, dy: number): void
  /** Move the 1:1 view so its middle is at this place on the picture, as fractions of it. */
  panTo(fx: number, fy: number): void
  setViewport(vw: number, vh: number): void
}

let opening = 0

/** Ask the core for suggestions and apply the named sliders as one history step. */
async function applyAuto(label: string, keys: (keyof AutoSettings)[]) {
  const { photoId } = useDevelop.getState()
  if (photoId === null) return
  try {
    const auto = await api().developAuto(photoId)
    if (useDevelop.getState().photoId !== photoId) return // moved on while it was thinking
    const patch = Object.fromEntries(keys.map((k) => [k, auto[k]]))
    await useDevelop.getState().setAndCommit(patch, { label, deltaText: null, valueText: null })
  } catch (e) {
    if (useDevelop.getState().photoId === photoId) useDevelop.setState({ error: (e as Error).message })
  }
}

export const useDevelop = create<DevelopStore>((set, get) => ({
  photoId: null,
  recipe: DEFAULT_RECIPE,
  saved: DEFAULT_RECIPE,
  opened: DEFAULT_RECIPE,
  history: [],
  loading: false,
  error: null,
  selecting: false,
  showOriginal: false,
  objectTool: false,
  setObjectTool(on) {
    set(on ? { objectTool: true, picking: false, spotTool: false, redEyeTool: false, portraitTool: false, cropEdit: false } : { objectTool: false })
  },
  async addObjectMask(x, y) {
    const { recipe, photoId } = get()
    if (photoId === null || get().loading || get().selecting) return
    if (recipe.masks.length >= MAX_MASKS) return set({ error: `A photo can have ${MAX_MASKS} masks at most.` })
    set({ selecting: true, error: null })
    try {
      const { map } = await api().maskObject(photoId, recipe, x, y)
      if (get().photoId !== photoId) return
      const now = get().recipe
      if (now.masks.length >= MAX_MASKS) return
      const n = now.masks.filter((m) => m.name.startsWith('Object')).length + 1
      const mask: Mask = { id: newMaskId(), name: `Object ${n}`, visible: true, invert: false, shape: { type: 'subject', map }, parts: [], adjust: { ...NO_ADJUST } }
      set({ selectedMask: mask.id, selectedPart: null, picking: false, showMask: true, selectedSpot: null, spotTool: false, redEyeTool: false, selectedRedEye: null, portraitTool: false, selectedRegion: null, objectTool: false })
      get().live({ masks: [...now.masks, mask] })
      await get().commit({ label: 'Add object', deltaText: null, valueText: mask.name })
    } catch (e) {
      set({ error: (e as Error).message, objectTool: false })
    } finally {
      set({ selecting: false })
    }
  },
  compareView: 'off',
  setCompareView(v) {
    set({ compareView: v, ...(v !== 'off' ? { showOriginal: false } : {}) })
  },
  panelsOff: [],
  togglePanel(id) {
    set((s) => ({ panelsOff: s.panelsOff.includes(id) ? s.panelsOff.filter((x) => x !== id) : [...s.panelsOff, id], showOriginal: false }))
  },
  clipboard: null,
  presets: [],
  snapshots: [],
  hover: null,
  version: 0,
  zoom: NO_ZOOM,
  selectedMask: null,
  brush: DEFAULT_BRUSH,
  showMask: false,
  selectedPart: null,
  picking: false,
  painting: false,
  cropEdit: false,
  cropRequest: null,
  straightenTool: false,
  setStraightenTool(on) {
    set(on ? { straightenTool: true, cropEdit: true, picking: false, spotTool: false, redEyeTool: false, selectedRedEye: null, portraitTool: false, selectedRegion: null, showMask: false, showOriginal: false, selectedSpot: null } : { straightenTool: false })
  },
  selectedRedEye: null,
  redEyeTool: false,
  portraitTool: false,
  selectedRegion: null,
  selectedFace: 0,
  allFaces: false,
  detecting: false,
  faceNote: null,
  undoStack: [],
  redoStack: [],
  clipping: false,
  spotView: false,
  redEyeDefaults: DEFAULT_RED_EYE,
  selectedSpot: null,
  spotTool: false,
  spotDefaults: DEFAULT_SPOT,

  setCropEdit(on) {
    if (on && (get().zoom.on || get().zoom.loading)) get().zoomOut()
    // the frame and the other tools do not share the picture
    set(on ? { cropEdit: true, picking: false, spotTool: false, redEyeTool: false, selectedRedEye: null, portraitTool: false, selectedRegion: null, showMask: false, showOriginal: false, selectedSpot: null } : { cropEdit: false, cropRequest: null, straightenTool: false })
  },
  requestCrop(req) {
    set(req ? { cropRequest: req, cropEdit: true, picking: false, spotTool: false, redEyeTool: false, selectedRedEye: null, portraitTool: false, selectedRegion: null, showMask: false, showOriginal: false, selectedSpot: null } : { cropRequest: null })
  },

  async open(id) {
    const token = ++opening
    // a new photo starts fitted, and the big picture of the old one is let go
    if (get().zoom.on || get().zoom.loading) void api().zoomClose().catch(() => undefined)
    set((s) => ({ zoom: { ...NO_ZOOM, vw: s.zoom.vw, vh: s.zoom.vh } }))
    if (id === null) return set({ photoId: null, recipe: DEFAULT_RECIPE, saved: DEFAULT_RECIPE, history: [], loading: false, error: null, undoStack: [], redoStack: [] })
    set({ photoId: id, loading: true, error: null, showOriginal: false, panelsOff: [], hover: null, snapshots: [], selectedMask: null, showMask: false, selectedSpot: null, spotTool: false, selectedPart: null, picking: false, cropEdit: false, cropRequest: null, straightenTool: false, selectedRedEye: null, redEyeTool: false, portraitTool: false, selectedRegion: null, selectedFace: 0, allFaces: false, detecting: false, faceNote: null, undoStack: [], redoStack: [] })
    void api().snapshotList(id).then((snapshots) => get().photoId === id && set({ snapshots })).catch(() => undefined)
    try {
      const st = await api().developGet(id)
      if (token !== opening) return // the user moved on to another photo
      set({ recipe: st.recipe, saved: st.recipe, opened: st.recipe, history: st.history, loading: false })
    } catch (e) {
      if (token !== opening) return
      set({ loading: false, error: (e as Error).message, recipe: DEFAULT_RECIPE, saved: DEFAULT_RECIPE, history: [] })
    }
  },

  live(patch) {
    // while a photo's own recipe is still being fetched, an edit would be overwritten by it when it arrives
    if (get().loading) return
    set((s) => ({ recipe: { ...s.recipe, ...patch }, showOriginal: false }))
  },

  async commit(step, track = true) {
    const { photoId, recipe, saved } = get()
    if (photoId === null || recipesEqual(recipe, saved)) return
    try {
      await api().developSave(photoId, recipe, step)
      if (get().photoId !== photoId) return
      const st = await api().developGet(photoId)
      if (get().photoId !== photoId) return
      // an edit is remembered for undo (the last hundred), and anything that was undone can no longer be redone
      set((s) => ({ saved: recipe, history: st.history, version: s.version + 1, error: null, ...(track ? { undoStack: [...s.undoStack, saved].slice(-100), redoStack: [] } : {}) }))
      useStore.getState().setEdited(photoId, !isDefault(recipe))
    } catch (e) {
      // the screen must not show an edit the catalog does not have
      if (get().photoId === photoId) set({ recipe: saved, error: (e as Error).message })
    }
  },

  toggleClipping() {
    set((s) => ({ clipping: !s.clipping }))
  },

  toggleSpotView() {
    set((s) => ({ spotView: !s.spotView }))
  },

  async undo() {
    const { photoId, loading, undoStack, saved } = get()
    if (photoId === null || loading || undoStack.length === 0) return
    const previous = undoStack[undoStack.length - 1]
    get().live(previous)
    await get().commit({ label: 'Undo', deltaText: null, valueText: null }, false)
    if (get().photoId === photoId && recipesEqual(get().saved, previous)) set((s) => ({ undoStack: s.undoStack.slice(0, -1), redoStack: [...s.redoStack, saved] }))
  },

  async redo() {
    const { photoId, loading, redoStack, saved } = get()
    if (photoId === null || loading || redoStack.length === 0) return
    const next = redoStack[redoStack.length - 1]
    get().live(next)
    await get().commit({ label: 'Redo', deltaText: null, valueText: null }, false)
    if (get().photoId === photoId && recipesEqual(get().saved, next)) set((s) => ({ redoStack: s.redoStack.slice(0, -1), undoStack: [...s.undoStack, saved] }))
  },

  async pasteToMany(ids, label = 'Paste settings') {
    const clip = get().clipboard
    const out = { done: 0, same: 0, failed: [] as string[] }
    if (!clip) return out
    for (const id of ids) {
      try {
        const st = await api().developGet(id)
        const merged = applyGroups(st.recipe, clip.recipe, clip.groups)
        if (recipesEqual(merged, st.recipe)) {
          out.same++ // it already looks like that
          continue
        }
        await api().developSave(id, merged, { label, deltaText: null, valueText: null })
        useStore.getState().setEdited(id, !isDefault(merged))
        out.done++
      } catch (e) {
        out.failed.push((e as Error).message)
      }
    }
    return out
  },

  async turnMany(ids, label, op) {
    const out = { done: 0, failed: [] as string[] }
    for (const id of ids) {
      try {
        const st = await api().developGet(id)
        // the edits on the picture and the crop frame are turned with it
        const merged = turnRecipe(st.recipe, op)

        await api().developSave(id, merged, { label, deltaText: null, valueText: null })
        useStore.getState().setEdited(id, !isDefault(merged))
        out.done++
      } catch (e) {
        out.failed.push((e as Error).message)
      }
    }
    return out
  },

  async nudgeMany(ids, key, delta) {
    const out = { done: 0, failed: [] as string[] }
    for (const id of ids) {
      try {
        const st = await api().developGet(id)
        const merged = nudged(st.recipe, key, delta)
        if (recipesEqual(merged, st.recipe)) continue // already at the end of the slider
        await api().developSave(id, merged, { label: `Quick Develop: ${sliderDef(key).label}`, deltaText: moveText(key, delta), valueText: String(merged[key]) })
        useStore.getState().setEdited(id, !isDefault(merged))
        out.done++
      } catch (e) {
        out.failed.push((e as Error).message)
      }
    }
    return out
  },

  async autoMany(ids, label, keys) {
    const out = { done: 0, failed: [] as string[] }
    for (const id of ids) {
      try {
        const auto = await api().developAuto(id)
        const st = await api().developGet(id)
        const merged = { ...st.recipe, ...Object.fromEntries(keys.map((k) => [k, auto[k]])) } as Recipe
        if (recipesEqual(merged, st.recipe)) continue
        await api().developSave(id, merged, { label, deltaText: null, valueText: null })
        useStore.getState().setEdited(id, !isDefault(merged))
        out.done++
      } catch (e) {
        out.failed.push((e as Error).message)
      }
    }
    return out
  },

  async resetMany(ids) {
    const out = { done: 0, failed: [] as string[] }
    for (const id of ids) {
      try {
        const st = await api().developGet(id)
        if (isDefault(st.recipe)) continue
        await api().developSave(id, DEFAULT_RECIPE, { label: 'Reset all', deltaText: null, valueText: null })
        useStore.getState().setEdited(id, false)
        out.done++
      } catch (e) {
        out.failed.push((e as Error).message)
      }
    }
    return out
  },

  async applyPresetToMany(ids, p) {
    const out = { done: 0, failed: [] as string[] }
    for (const id of ids) {
      try {
        const st = await api().developGet(id)
        const merged = applyGroups(st.recipe, p.recipe, p.groups)
        if (recipesEqual(merged, st.recipe)) continue
        await api().developSave(id, merged, { label: `Preset: ${p.name}`, deltaText: null, valueText: null })
        useStore.getState().setEdited(id, !isDefault(merged))
        out.done++
      } catch (e) {
        out.failed.push((e as Error).message)
      }
    }
    return out
  },

  async syncToSelection(groups) {
    const ui = useStore.getState()
    const { photoId, recipe } = get()
    if (photoId === null) return
    const ids = ui.targetIds().filter((id) => id !== photoId)
    if (ids.length === 0) return ui.say('Select the other photos first (Ctrl-click in the Library), then sync.', true)
    set({ clipboard: { recipe, groups } })
    const r = await get().pasteToMany(ids, 'Sync settings')
    const n = (k: number) => (k === 1 ? '1 photo' : `${k} photos`)
    if (r.failed.length) ui.say(`${n(r.failed.length)} could not be changed: ${r.failed[0]}`, true)
    else if (r.done === 0) ui.say('Those photos already match.')
    else ui.say(`Settings synced to ${n(r.done)}${r.same ? ` (${r.same} already matched)` : ''}`)
  },

  async pasteToSelection() {
    const ui = useStore.getState()
    if (!get().clipboard) return ui.say('Copy settings in Develop first, then select photos here and paste.', true)
    const ids = ui.targetIds()
    if (ids.length === 0) return ui.say('Select the photos to paste onto first.', true)
    const r = await get().pasteToMany(ids)
    const n = (k: number) => (k === 1 ? '1 photo' : `${k} photos`)
    if (r.failed.length) ui.say(`${n(r.failed.length)} could not be changed: ${r.failed[0]}`, true)
    else if (r.done === 0) ui.say(r.same === 1 ? 'That photo already has these settings.' : 'Those photos already have these settings.')
    else ui.say(`Settings pasted onto ${n(r.done)}${r.same ? ` (${r.same} already matched)` : ''}`)
  },

  async setAndCommit(patch, step) {
    get().live(patch)
    await get().commit(step)
  },

  async resetSlider(key) {
    const before = get().recipe
    if (before[key] === DEFAULT_RECIPE[key]) return
    get().live({ [key]: DEFAULT_RECIPE[key] })
    await get().commit({ label: `Reset ${sliderDef(key).label}`, deltaText: null, valueText: signed(DEFAULT_RECIPE[key], sliderDef(key).digits) })
  },

  async resetAll() {
    if (isDefault(get().recipe)) return
    await get().setAndCommit(DEFAULT_RECIPE, { label: 'Reset all', deltaText: null, valueText: null })
  },

  async previous() {
    const { opened, recipe } = get()
    if (recipesEqual(recipe, opened)) return
    await get().setAndCommit(opened, { label: 'Previous: back to how it was opened', deltaText: null, valueText: null })
  },

  async goTo(row) {
    await get().setAndCommit(row.recipe, { label: `Back to ${row.label}`, deltaText: null, valueText: null })
  },

  copy(groups = DEFAULT_COPY_GROUPS) {
    set((s) => ({ clipboard: { recipe: s.recipe, groups } }))
  },

  async paste() {
    const { clipboard: clip, recipe } = get()
    if (clip) await get().setAndCommit(applyGroups(recipe, clip.recipe, clip.groups), { label: 'Paste settings', deltaText: null, valueText: null })
  },

  async loadPresets() {
    try {
      const user = await api().presetList()
      set({ presets: [...BUILTIN_PRESETS, ...user] })
    } catch (e) {
      set({ presets: BUILTIN_PRESETS, error: (e as Error).message })
    }
  },

  async applyPreset(p) {
    set({ hover: null })
    await get().setAndCommit(applyGroups(get().recipe, p.recipe, p.groups), { label: `Preset: ${p.name}`, deltaText: null, valueText: null })
  },

  previewPreset(p) {
    set((s) => ({ hover: p ? applyGroups(s.recipe, p.recipe, p.groups) : null }))
  },

  async createPreset(name, group, groups) {
    await api().presetCreate(name, group, groups, get().recipe) // a refusal is shown by the dialog that asked
    await get().loadPresets()
  },

  async deletePreset(id) {
    try {
      await api().presetDelete(id)
      await get().loadPresets()
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  async createSnapshot(name) {
    const { photoId, recipe } = get()
    if (photoId === null) return
    await api().snapshotCreate(photoId, name, recipe) // a refusal is shown by the form that asked
    const snapshots = await api().snapshotList(photoId)
    if (get().photoId === photoId) set({ snapshots })
  },

  async applySnapshot(s) {
    await get().setAndCommit(s.recipe, { label: `Snapshot: ${s.name}`, deltaText: null, valueText: null })
  },

  async deleteSnapshot(id) {
    const photoId = get().photoId
    if (photoId === null) return
    try {
      await api().snapshotDelete(id)
      const snapshots = await api().snapshotList(photoId)
      if (get().photoId === photoId) set({ snapshots })
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },

  toggleOriginal() {
    set((s) => ({ showOriginal: !s.showOriginal }))
  },

  async addMask(type) {
    const { recipe } = get()
    if (recipe.masks.length >= MAX_MASKS) return set({ error: `A photo can have ${MAX_MASKS} masks at most.` })
    if (get().loading) return
    const mask = newMask(type, recipe.masks)
    set({ selectedMask: mask.id, selectedPart: null, picking: false, showMask: false, selectedSpot: null, spotTool: false, redEyeTool: false, selectedRedEye: null, portraitTool: false, selectedRegion: null })
    get().live({ masks: [...recipe.masks, mask] })
    await get().commit({ label: `Add ${MASK_TYPE_LABEL[type].toLowerCase()}`, deltaText: null, valueText: mask.name })
  },

  async applyAdaptive(p) {
    const before = get().recipe.masks.length
    await get().addAutoMask(p.needs)
    const masks = get().recipe.masks
    if (masks.length <= before) return // nothing was found: the reason is in "error"
    const found = masks[masks.length - 1]
    get().liveMask(found.id, { name: p.name, adjust: { ...found.adjust, ...p.adjust } })
    await get().commitMasks(`Adaptive preset: ${p.name}`)
  },

  async addDepthMask(kind) {
    const { recipe, photoId } = get()
    if (photoId === null || get().loading || get().selecting) return
    if (recipe.masks.length >= MAX_MASKS) return set({ error: `A photo can have ${MAX_MASKS} masks at most.` })
    set({ selecting: true, error: null })
    try {
      const { map } = await api().maskDepth(photoId, recipe)
      if (get().photoId !== photoId) return
      const now = get().recipe
      if (now.masks.length >= MAX_MASKS) return
      const label = kind === 'near' ? 'Near' : 'Far'
      const n = now.masks.filter((m) => m.name.startsWith(label)).length + 1
      const mask: Mask = { id: newMaskId(), name: `${label} ${n}`, visible: true, invert: false, shape: { type: 'depth', map, near: kind === 'near' ? 0.6 : 0, far: kind === 'near' ? 1 : 0.4, smooth: 0.3 }, parts: [], adjust: { ...NO_ADJUST } }
      set({ selectedMask: mask.id, selectedPart: null, picking: false, showMask: true, selectedSpot: null, spotTool: false, redEyeTool: false, selectedRedEye: null, portraitTool: false, selectedRegion: null })
      get().live({ masks: [...now.masks, mask] })
      await get().commit({ label: `Add ${label.toLowerCase()} part`, deltaText: null, valueText: mask.name })
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ selecting: false })
    }
  },

  async addAutoMask(kind) {
    if (kind === 'sky') return get().addMask('sky')
    if (kind === 'near' || kind === 'far') return get().addDepthMask(kind)
    const { recipe, photoId } = get()
    if (photoId === null || get().loading || get().selecting) return
    if (recipe.masks.length >= MAX_MASKS) return set({ error: `A photo can have ${MAX_MASKS} masks at most.` })
    set({ selecting: true, error: null })
    try {
      const { map } = await api().maskSubject(photoId, recipe)
      if (get().photoId !== photoId) return // moved on while the model was looking
      const now = get().recipe
      if (now.masks.length >= MAX_MASKS) return
      const label = kind === 'subject' ? 'Subject' : 'Background'
      const n = now.masks.filter((m) => m.name.startsWith(label)).length + 1
      const mask: Mask = { id: newMaskId(), name: `${label} ${n}`, visible: true, invert: kind === 'background', shape: { type: 'subject', map }, parts: [], adjust: { ...NO_ADJUST } }
      set({ selectedMask: mask.id, selectedPart: null, picking: false, showMask: true, selectedSpot: null, spotTool: false, redEyeTool: false, selectedRedEye: null, portraitTool: false, selectedRegion: null })
      get().live({ masks: [...now.masks, mask] })
      await get().commit({ label: `Add ${label.toLowerCase()}`, deltaText: null, valueText: mask.name })
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ selecting: false })
    }
  },

  async addPersonMask(part) {
    const { recipe, photoId } = get()
    if (photoId === null || get().loading || get().selecting) return
    if (recipe.masks.length >= MAX_MASKS) return set({ error: `A photo can have ${MAX_MASKS} masks at most.` })
    set({ selecting: true, error: null })
    try {
      const { map } = await api().maskPerson(photoId, recipe, part)
      if (get().photoId !== photoId) return // moved on while the model was looking
      const now = get().recipe
      if (now.masks.length >= MAX_MASKS) return
      const label = PERSON_PARTS.find((p) => p.part === part)?.label ?? 'Person'
      const n = now.masks.filter((m) => m.name.startsWith(label)).length + 1
      const mask: Mask = { id: newMaskId(), name: `${label} ${n}`, visible: true, invert: false, shape: { type: 'subject', map }, parts: [], adjust: { ...NO_ADJUST } }
      set({ selectedMask: mask.id, selectedPart: null, picking: false, showMask: true, selectedSpot: null, spotTool: false, redEyeTool: false, selectedRedEye: null, portraitTool: false, selectedRegion: null })
      get().live({ masks: [...now.masks, mask] })
      await get().commit({ label: `Add ${label.toLowerCase()}`, deltaText: null, valueText: mask.name })
    } catch (e) {
      set({ error: (e as Error).message })
    } finally {
      set({ selecting: false })
    }
  },

  selectMask(id) {
    set({ selectedMask: id, selectedPart: null, picking: false, showMask: id === null ? false : get().showMask, ...(id ? { selectedSpot: null, spotTool: false, redEyeTool: false, selectedRedEye: null, portraitTool: false, selectedRegion: null } : {}) })
  },

  liveMask(id, patch) {
    get().live({ masks: withMask(get().recipe, id, patch) })
  },

  async commitMasks(label) {
    await get().commit({ label, deltaText: null, valueText: null })
  },

  async deleteMask(id) {
    const m = maskById(get().recipe, id)
    if (!m) return
    if (get().selectedMask === id) set({ selectedMask: null, selectedPart: null, picking: false, showMask: false })
    get().live({ masks: get().recipe.masks.filter((x) => x.id !== id) })
    await get().commit({ label: `Delete ${m.name}`, deltaText: null, valueText: null })
  },

  async addStroke(id, stroke) {
    const m = maskById(get().recipe, id)
    if (!m || m.shape.type !== 'brush') return
    get().liveMask(id, { shape: { type: 'brush', strokes: [...m.shape.strokes, stroke] } })
    await get().commitMasks(`${m.name}: ${stroke.erase ? 'erase' : 'brush'} stroke`)
  },

  setBrush(patch) {
    set((s) => ({ brush: { ...s.brush, ...patch } }))
  },

  selectPart(part) {
    set({ selectedPart: part, picking: false })
  },

  async addPart(maskId, type) {
    const m = maskById(get().recipe, maskId)
    if (!m || get().loading) return
    if (m.parts.length >= MAX_PARTS) return set({ error: `A mask can combine ${MAX_PARTS} more shapes at most.` })
    const part: MaskPart = { op: defaultOp(type), shape: defaultShape(type) }
    get().liveMask(maskId, { parts: [...m.parts, part] })
    set({ selectedPart: m.parts.length, picking: false })
    await get().commitMasks(`${m.name}: ${part.op === 'subtract' ? 'subtract' : part.op === 'intersect' ? 'intersect' : 'add'} ${MASK_TYPE_LABEL[type].toLowerCase()}`)
  },

  async removePart(maskId, index) {
    const m = maskById(get().recipe, maskId)
    if (!m || !m.parts[index]) return
    const sel = get().selectedPart
    set({ selectedPart: sel === null || sel === index ? null : sel > index ? sel - 1 : sel, picking: false })
    get().liveMask(maskId, { parts: m.parts.filter((_, i) => i !== index) })
    await get().commitMasks(`${m.name}: remove ${MASK_TYPE_LABEL[m.parts[index].shape.type].toLowerCase()}`)
  },

  async setPartOp(maskId, index, op) {
    const m = maskById(get().recipe, maskId)
    if (!m || !m.parts[index] || m.parts[index].op === op) return
    get().liveMask(maskId, { parts: m.parts.map((p, i) => (i === index ? { ...p, op } : p)) })
    await get().commitMasks(`${m.name}: ${MASK_OP_LABEL[op].toLowerCase()} ${MASK_TYPE_LABEL[m.parts[index].shape.type].toLowerCase()}`)
  },

  setPicking(on) {
    set({ picking: on })
  },

  async pickColour(hue, sat) {
    set({ picking: false })
    const m = maskById(get().recipe, get().selectedMask)
    const part = get().selectedPart
    const target = m ? targetShape(m, part) : undefined
    if (!m || !target || target.type !== 'colour') return
    // a grey spot has no colour to pick, and the range would then take in anything
    if (sat < 0.05) return set({ error: 'That spot has no colour to pick. Click a coloured part of the picture.' })
    // ask for half the colour that was clicked, so the range takes in the paler and darker versions of it too
    const minColour = Math.min(0.6, Math.max(0.05, Math.round(sat * 50) / 100))
    get().liveMask(m.id, withTargetShape(m, part, { ...target, hue: Math.round(hue) % 360, sat: minColour }))
    await get().commitMasks(`${m.name}: pick colour`)
  },

  toggleShowMask() {
    set((s) => ({ showMask: !s.showMask }))
  },

  setPainting(on) {
    set({ painting: on })
  },

  setSpotTool(on) {
    set({ spotTool: on, ...(on ? { selectedMask: null, showMask: false, redEyeTool: false, selectedRedEye: null, portraitTool: false, selectedRegion: null } : {}) })
  },

  setRedEyeTool(on) {
    set({ redEyeTool: on, ...(on ? { selectedMask: null, showMask: false, spotTool: false, selectedSpot: null, portraitTool: false, selectedRegion: null } : {}) })
  },

  setPortraitTool(on) {
    set({ portraitTool: on, ...(on ? { selectedMask: null, showMask: false, spotTool: false, selectedSpot: null, redEyeTool: false, selectedRedEye: null } : {}) })
  },

  async markFace(at, aspect) {
    const { photoId, recipe, loading } = get()
    if (photoId === null || loading) return
    if (recipe.portraits.length >= MAX_PORTRAITS) return set({ error: `A photo can have ${MAX_PORTRAITS} faces at most.` })
    const index = recipe.portraits.length
    get().live({ portraits: [...recipe.portraits, layoutFace(at, aspect)] })
    set({ portraitTool: false, selectedFace: index, selectedRegion: 'face', faceNote: null })
    await get().commit({ label: 'Mark face', deltaText: null, valueText: `Face ${index + 1}` })
  },

  async detectFaces() {
    const { photoId, recipe, loading, detecting } = get()
    if (photoId === null || loading || detecting) return
    set({ detecting: true, faceNote: null })
    try {
      const { faces, aspect } = await api().portraitDetect(photoId, recipe)
      if (get().photoId !== photoId) return // moved on while it was looking
      const before = get().recipe.portraits
      const { merged, added } = mergeDetected(before, faces, aspect)
      if (added === 0) {
        set({ faceNote: faces.length === 0 ? 'No faces found. Use Mark face for a face that is turned away.' : 'No new faces: the faces found are already marked.' })
        return
      }
      get().live({ portraits: merged })
      set({ selectedFace: before.length, selectedRegion: 'face', faceNote: `${added === 1 ? '1 face' : `${added} faces`} found.`, selectedMask: null, showMask: false, selectedSpot: null, spotTool: false, redEyeTool: false, selectedRedEye: null, portraitTool: false })
      await get().commit({ label: 'Detect faces', deltaText: null, valueText: `${added} found` })
    } catch (e) {
      if (get().photoId === photoId) set({ faceNote: (e as Error).message })
    } finally {
      set({ detecting: false })
    }
  },

  selectFace(index) {
    if (index < 0 || index >= get().recipe.portraits.length) return
    set({ selectedFace: index, allFaces: false, selectedRegion: 'face', selectedMask: null, showMask: false, selectedSpot: null, spotTool: false, redEyeTool: false, selectedRedEye: null, portraitTool: false })
  },

  setAllFaces(on) {
    if (on && get().recipe.portraits.length < 2) return
    set({ allFaces: on, ...(on ? { selectedRegion: null, portraitTool: false } : {}) })
  },

  liveFaceSliders(change) {
    const { recipe, selectedFace, allFaces } = get()
    if (allFaces && recipe.portraits.length > 1) return get().live({ portraits: recipe.portraits.map(change) })
    const i = Math.min(selectedFace, recipe.portraits.length - 1)
    if (i >= 0) get().live({ portraits: recipe.portraits.map((p, k) => (k === i ? change(p) : p)) })
  },

  selectRegion(key) {
    set({ selectedRegion: key, ...(key ? { selectedMask: null, showMask: false, selectedSpot: null, spotTool: false, redEyeTool: false, selectedRedEye: null, portraitTool: false } : {}) })
  },

  livePortrait(change) {
    const { recipe, selectedFace } = get()
    const i = Math.min(selectedFace, recipe.portraits.length - 1)
    if (i >= 0) get().live({ portraits: recipe.portraits.map((p, k) => (k === i ? change(p) : p)) })
  },

  async commitPortrait(label) {
    await get().commit({ label, deltaText: null, valueText: null })
  },

  async deleteFace(index) {
    const { recipe } = get()
    if (index < 0 || index >= recipe.portraits.length) return
    const left = recipe.portraits.length - 1
    set({ selectedFace: Math.max(0, Math.min(get().selectedFace, left - 1)), selectedRegion: left === 0 ? null : get().selectedRegion })
    get().live({ portraits: recipe.portraits.filter((_, k) => k !== index) })
    await get().commit({ label: `Delete face ${index + 1}`, deltaText: null, valueText: null })
  },

  async autoRetouch() {
    if (get().recipe.portraits.length === 0) await get().detectFaces()
    const { recipe } = get()
    if (recipe.portraits.length === 0) return
    const a = AUTO_RETOUCH
    get().live({
      portraits: recipe.portraits.map((p) => ({ ...p, skin: { ...a.skin }, teeth: { ...a.teeth }, eyes: { ...p.eyes, both: { ...a.eyes } }, lips: a.lips, brows: a.brows })),
    })
    await get().commit({ label: 'Auto retouch', deltaText: null, valueText: null })
  },

  async copyToAllFaces() {
    const { recipe, selectedFace } = get()
    const from = recipe.portraits[Math.min(selectedFace, recipe.portraits.length - 1)]
    if (!from || recipe.portraits.length < 2) return
    get().live({ portraits: recipe.portraits.map((p) => ({ ...p, skin: { ...from.skin }, teeth: { ...from.teeth }, eyes: JSON.parse(JSON.stringify(from.eyes)) as Portrait['eyes'] })) })
    await get().commit({ label: 'Copy retouch to all faces', deltaText: null, valueText: null })
  },

  async clearPortraits() {
    if (get().recipe.portraits.length === 0) return
    set({ selectedFace: 0, selectedRegion: null, portraitTool: false, faceNote: null })
    get().live({ portraits: [] })
    await get().commit({ label: 'Clear faces', deltaText: null, valueText: null })
  },

  async addRedEyeAt(at) {
    const { photoId, recipe, redEyeDefaults, loading } = get()
    if (photoId === null || loading) return
    if (recipe.redEyes.length >= MAX_RED_EYES) return set({ error: `A photo can have ${MAX_RED_EYES} red-eye circles at most.` })
    const eye = makeRedEye(newRedEyeId(), at, redEyeDefaults)
    set({ selectedRedEye: eye.id })
    get().live({ redEyes: [...recipe.redEyes, eye] })
    await get().commit({ label: 'Add red-eye fix', deltaText: null, valueText: `Red eye ${get().recipe.redEyes.length}` })
  },

  async findRedEyes() {
    const { photoId, recipe, loading } = get()
    if (photoId === null || loading) return 0
    const room = MAX_RED_EYES - recipe.redEyes.length
    if (room <= 0) {
      set({ error: `A photo can have ${MAX_RED_EYES} red-eye circles at most.` })
      return 0
    }
    const { faces, aspect } = await api().portraitDetect(photoId, recipe)
    if (get().photoId !== photoId) return 0
    const long = Math.max(aspect, 1)
    const found = faces.flatMap((f) => [f.leftEye, f.rightEye]).map((e) => ({ x: e.cx, y: e.cy, size: Math.min(MAX_RED_EYE_SIZE, Math.max(MIN_RED_EYE_SIZE, (2 * Math.max(e.rx * aspect, e.ry) * 1.4) / long)) }))
    const fresh = found.filter((e) => !get().recipe.redEyes.some((r) => Math.hypot((r.x - e.x) * aspect, r.y - e.y) < 0.02)).slice(0, room)
    if (fresh.length === 0) return 0
    const eyes = fresh.map((e) => makeRedEye(newRedEyeId(), [e.x, e.y], { ...get().redEyeDefaults, size: e.size }))
    get().live({ redEyes: [...get().recipe.redEyes, ...eyes] })
    await get().commit({ label: 'Find eyes', deltaText: null, valueText: `${eyes.length} circles` })
    return eyes.length
  },

  selectRedEye(id) {
    set({ selectedRedEye: id, ...(id ? { selectedMask: null, showMask: false, selectedSpot: null, spotTool: false, portraitTool: false, selectedRegion: null } : {}) })
  },

  liveRedEye(id, patch) {
    get().live({ redEyes: get().recipe.redEyes.map((e) => (e.id === id ? { ...e, ...patch } : e)) })
  },

  async commitRedEyes(label) {
    await get().commit({ label, deltaText: null, valueText: null })
  },

  async deleteRedEye(id) {
    const index = get().recipe.redEyes.findIndex((e) => e.id === id)
    if (index < 0) return
    if (get().selectedRedEye === id) set({ selectedRedEye: null })
    get().live({ redEyes: get().recipe.redEyes.filter((e) => e.id !== id) })
    await get().commit({ label: `Delete red eye ${index + 1}`, deltaText: null, valueText: null })
  },

  async deleteAllRedEyes() {
    if (get().recipe.redEyes.length === 0) return
    set({ selectedRedEye: null })
    get().live({ redEyes: [] })
    await get().commit({ label: 'Delete all red-eye fixes', deltaText: null, valueText: null })
  },

  setRedEyeDefaults(patch) {
    set((s) => ({ redEyeDefaults: { ...s.redEyeDefaults, ...patch } }))
  },

  async addSpotAt(at, aspect) {
    const { photoId, recipe, spotDefaults, loading } = get()
    if (photoId === null || loading) return
    if (recipe.spots.length >= MAX_SPOTS) return set({ error: `A photo can have ${MAX_SPOTS} spots at most.` })
    let source = fallbackSource(at, spotDefaults.size, aspect)
    if (spotDefaults.mode === 'fill') {
      source = at // a fill has no source to find: the model paints from what is round it
    } else {
      try {
        const found = await api().developSpotSource(photoId, at[0], at[1], spotDefaults.size)
        if (get().photoId !== photoId) return // moved on while the core was looking
        source = [found[0], found[1]]
      } catch {
        // keep the spot beside the target: the user can drag the source
      }
    }
    const spot = makeSpot(newSpotId(), at, source, spotDefaults)
    set({ selectedSpot: spot.id, selectedMask: null, showMask: false })
    get().live({ spots: [...get().recipe.spots, spot] })
    await get().commit({ label: `Add ${spot.mode} spot`, deltaText: null, valueText: `Spot ${get().recipe.spots.length}` })
  },

  async findDust() {
    const { photoId, recipe, loading } = get()
    if (photoId === null || loading) return 0
    const room = MAX_SPOTS - recipe.spots.length
    if (room <= 0) {
      set({ error: `A photo can have ${MAX_SPOTS} spots at most.` })
      return 0
    }
    const found = await api().developFindDust(photoId, recipe)
    if (get().photoId !== photoId) return 0 // moved on while the core was looking
    // the ones that already have a spot on them are not added again
    const fresh = found.filter((d) => !get().recipe.spots.some((s) => Math.hypot(s.x - d.x, s.y - d.y) < Math.max(s.size, d.size))).slice(0, room)
    if (fresh.length === 0) return 0
    const defaults = get().spotDefaults
    const spots = fresh.map((d) => makeSpot(newSpotId(), [d.x, d.y], [d.sx, d.sy], { ...defaults, mode: 'heal', size: d.size }))
    get().live({ spots: [...get().recipe.spots, ...spots] })
    await get().commit({ label: 'Find dust', deltaText: null, valueText: `${spots.length} spots` })
    return spots.length
  },

  selectSpot(id) {
    set({ selectedSpot: id, ...(id ? { selectedMask: null, showMask: false, redEyeTool: false, selectedRedEye: null, portraitTool: false, selectedRegion: null } : {}) })
  },

  liveSpot(id, patch) {
    get().live({ spots: get().recipe.spots.map((s) => (s.id === id ? { ...s, ...patch } : s)) })
  },

  async commitSpots(label) {
    await get().commit({ label, deltaText: null, valueText: null })
  },

  async deleteSpot(id) {
    const index = get().recipe.spots.findIndex((s) => s.id === id)
    if (index < 0) return
    if (get().selectedSpot === id) set({ selectedSpot: null })
    get().live({ spots: get().recipe.spots.filter((s) => s.id !== id) })
    await get().commit({ label: `Delete spot ${index + 1}`, deltaText: null, valueText: null })
  },

  async deleteAllSpots() {
    if (get().recipe.spots.length === 0) return
    set({ selectedSpot: null })
    get().live({ spots: [] })
    await get().commit({ label: 'Delete all spots', deltaText: null, valueText: null })
  },

  setSpotDefaults(patch) {
    set((s) => ({ spotDefaults: { ...s.spotDefaults, ...patch } }))
  },

  async autoTone() {
    await applyAuto('Auto tone', ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'vibrance', 'saturation'])
  },

  async autoWhiteBalance() {
    await applyAuto('Auto white balance', ['temperature', 'tint'])
  },

  async zoomIn(fx = 0.5, fy = 0.5) {
    const { photoId, recipe, zoom } = get()
    if (photoId === null || zoom.loading) return
    set({ zoom: { ...zoom, loading: true }, error: null })
    try {
      const size = await api().zoomOpen(photoId, recipe)
      if (get().photoId !== photoId) return // moved on while the big picture was loading
      const [cx, cy] = clampCentre(fx * size.width, fy * size.height, size.width, size.height, get().zoom.vw, get().zoom.vh)
      set((s) => ({ zoom: { ...s.zoom, on: true, loading: false, width: size.width, height: size.height, cx, cy, crop: cropKey(recipe.crop, recipe.geometry) } }))
    } catch (e) {
      if (get().photoId === photoId) set((s) => ({ zoom: { ...s.zoom, loading: false }, error: (e as Error).message }))
    }
  },

  zoomOut() {
    set((s) => ({ zoom: { ...s.zoom, on: false, loading: false } }))
  },

  toggleZoom() {
    if (get().zoom.on) get().zoomOut()
    else void get().zoomIn()
  },

  panBy(dx, dy) {
    set((s) => {
      const z = s.zoom
      if (!z.on) return {}
      const [cx, cy] = clampCentre(z.cx + dx, z.cy + dy, z.width, z.height, z.vw, z.vh)
      return { zoom: { ...z, cx, cy } }
    })
  },

  panTo(fx, fy) {
    set((s) => {
      const z = s.zoom
      if (!z.on) return {}
      const [cx, cy] = clampCentre(fx * z.width, fy * z.height, z.width, z.height, z.vw, z.vh)
      return { zoom: { ...z, cx, cy } }
    })
  },

  setViewport(vw, vh) {
    set((s) => {
      if (s.zoom.vw === vw && s.zoom.vh === vh) return {}
      const z = { ...s.zoom, vw, vh }
      if (z.on) [z.cx, z.cy] = clampCentre(z.cx, z.cy, z.width, z.height, vw, vh)
      return { zoom: z }
    })
  },
}))
