import { DEFAULT_RECIPE, type PresetRow, type Recipe } from './types'

/** The groups of settings a preset or a copy can include. The core validates the same ids. */
export const SETTING_GROUPS = [
  { id: 'whiteBalance', label: 'White balance' },
  { id: 'profile', label: 'Profile' },
  { id: 'tone', label: 'Tone' },
  { id: 'presence', label: 'Presence' },
  { id: 'curve', label: 'Tone curve' },
  { id: 'mixer', label: 'Colour mixer' },
  { id: 'grading', label: 'Colour grading' },
  { id: 'calibration', label: 'Calibration' },
  { id: 'sharpening', label: 'Sharpening' },
  { id: 'noise', label: 'Noise reduction' },
  { id: 'effects', label: 'Effects' },
  { id: 'geometry', label: 'Lens and transform' },
  { id: 'crop', label: 'Crop and straighten' },
] as const
export type GroupId = (typeof SETTING_GROUPS)[number]['id']
export const ALL_GROUPS: GroupId[] = SETTING_GROUPS.map((g) => g.id)
/** What a copy starts with ticked: everything except the crop and the transform, which belong to one photo's framing. */
export const DEFAULT_COPY_GROUPS: GroupId[] = ALL_GROUPS.filter((g) => g !== 'crop' && g !== 'geometry')

const clone = (r: Recipe): Recipe => ({
  ...r,
  curve: r.curve.map((p) => [p[0], p[1]] as [number, number]),
  curveRed: (r.curveRed ?? []).map((p) => [p[0], p[1]] as [number, number]),
  curveGreen: (r.curveGreen ?? []).map((p) => [p[0], p[1]] as [number, number]),
  curveBlue: (r.curveBlue ?? []).map((p) => [p[0], p[1]] as [number, number]),
  parametric: { ...DEFAULT_RECIPE.parametric, ...(r.parametric ?? {}) },
  grading: JSON.parse(JSON.stringify(r.grading ?? DEFAULT_RECIPE.grading)) as Recipe['grading'],
  calibration: { ...DEFAULT_RECIPE.calibration, ...(r.calibration ?? {}) },
  hsl: { hue: [...r.hsl.hue], sat: [...r.hsl.sat], lum: [...r.hsl.lum] },
  detail: { ...r.detail },
  effects: { ...r.effects },
  geometry: { ...r.geometry },
  masks: JSON.parse(JSON.stringify(r.masks)) as Recipe['masks'],
  spots: JSON.parse(JSON.stringify(r.spots)) as Recipe['spots'],
  redEyes: JSON.parse(JSON.stringify(r.redEyes)) as Recipe['redEyes'],
  portraits: JSON.parse(JSON.stringify(r.portraits)) as Recipe['portraits'],
  crop: { ...r.crop, rect: r.crop.rect ? { ...r.crop.rect } : null },
})

/** Copy the settings in these groups from `source` onto `base`; everything else in `base` stays. */
export function applyGroups(base: Recipe, source: Recipe, groups: readonly string[]): Recipe {
  const out = clone(base)
  const from = clone(source)
  for (const g of groups) {
    switch (g) {
      case 'whiteBalance':
        out.temperature = from.temperature
        out.tint = from.tint
        break
      case 'profile':
        out.profile = from.profile
        out.profileAmount = from.profileAmount
        break
      case 'tone':
        out.exposure = from.exposure
        out.contrast = from.contrast
        out.highlights = from.highlights
        out.shadows = from.shadows
        out.whites = from.whites
        out.blacks = from.blacks
        break
      case 'presence':
        out.texture = from.texture
        out.clarity = from.clarity
        out.dehaze = from.dehaze
        out.vibrance = from.vibrance
        out.saturation = from.saturation
        break
      case 'curve':
        out.curve = from.curve
        out.curveRed = from.curveRed
        out.curveGreen = from.curveGreen
        out.curveBlue = from.curveBlue
        out.parametric = from.parametric
        break
      case 'mixer':
        out.hsl = from.hsl
        break
      case 'grading':
        out.grading = from.grading
        break
      case 'calibration':
        out.calibration = from.calibration
        break
      case 'sharpening':
        out.detail.sharpAmount = from.detail.sharpAmount
        out.detail.sharpRadius = from.detail.sharpRadius
        out.detail.sharpMasking = from.detail.sharpMasking
        out.detail.sharpDetail = from.detail.sharpDetail
        break
      case 'noise':
        out.detail.nrLuma = from.detail.nrLuma
        out.detail.nrColour = from.detail.nrColour
        out.detail.nrLumaDetail = from.detail.nrLumaDetail
        out.detail.nrLumaContrast = from.detail.nrLumaContrast
        out.detail.nrColourSmooth = from.detail.nrColourSmooth
        break
      case 'effects':
        out.effects = from.effects
        break
      case 'geometry':
        out.geometry = from.geometry
        break
      case 'crop':
        out.crop = from.crop
        break
    }
  }
  return out
}

/** The groups in which this recipe differs from an untouched photo. */
export function changedGroups(r: Recipe): GroupId[] {
  return ALL_GROUPS.filter((g) => JSON.stringify(applyGroups(DEFAULT_RECIPE, r, [g])) !== JSON.stringify(DEFAULT_RECIPE))
}

export const sameRecipe = (a: Recipe, b: Recipe) => JSON.stringify(a) === JSON.stringify(b)

const make = (name: string, groups: GroupId[], patch: Omit<Partial<Recipe>, 'detail' | 'effects'> & { detail?: Partial<Recipe['detail']>; effects?: Partial<Recipe['effects']> }, id: number, group = 'Lucent Raw'): PresetRow => ({
  id,
  name,
  group,
  groups,
  recipe: clone({ ...DEFAULT_RECIPE, ...patch, detail: { ...DEFAULT_RECIPE.detail, ...patch.detail }, effects: { ...DEFAULT_RECIPE.effects, ...patch.effects } }),
})

/** Presets that ship with the app. Negative ids tell them apart from the user's; they cannot be deleted. */
export const BUILTIN_PRESETS: PresetRow[] = [
  make('Punchy', ['tone', 'presence', 'sharpening'], { contrast: 25, highlights: -15, shadows: 15, vibrance: 30, saturation: 10, detail: { sharpAmount: 40 } }, -1),
  make('Faded film', ['tone', 'presence', 'curve'], { contrast: -10, saturation: -15, curve: [[0, 28], [255, 235]] }, -2),
  make('Black and white', ['tone', 'presence'], { contrast: 20, saturation: -100 }, -3),
  make('Warm glow', ['whiteBalance', 'tone'], { temperature: 25, tint: 5, exposure: 0.15, highlights: -10 }, -4),
  make('Cool shade', ['whiteBalance'], { temperature: -25, tint: -5 }, -5),
  make('Soft portrait', ['tone', 'presence', 'noise'], { contrast: -15, highlights: -20, shadows: 20, vibrance: -10, detail: { nrLuma: 25 } }, -6),
  make('Open shadows', ['tone'], { shadows: 60, blacks: 10, highlights: -25 }, -7),
  make('Old print', ['tone', 'presence', 'effects'], { contrast: -5, saturation: -25, effects: { vignetteAmount: -35, grainAmount: 35, grainSize: 30 } }, -8),
  // black and white
  make('High contrast', ['tone', 'presence', 'sharpening'], { contrast: 45, saturation: -100, whites: 10, blacks: -15, shadows: -10, detail: { sharpAmount: 35 } }, -9, 'Black and white'),
  make('Soft and airy', ['tone', 'presence'], { contrast: -10, saturation: -100, highlights: -15, shadows: 25, exposure: 0.2 }, -10, 'Black and white'),
  make('Film grain', ['tone', 'presence', 'effects'], { contrast: 25, saturation: -100, effects: { grainAmount: 40, grainSize: 35, vignetteAmount: -20 } }, -11, 'Black and white'),
  // people
  make('Warm portrait', ['whiteBalance', 'tone', 'presence'], { temperature: 12, tint: 4, exposure: 0.1, contrast: -5, highlights: -15, shadows: 15, vibrance: 10 }, -12, 'People'),
  make('Bright and airy', ['tone', 'presence'], { exposure: 0.5, contrast: -15, highlights: -30, shadows: 40, whites: 15, vibrance: 5, saturation: -8 }, -13, 'People'),
  // landscapes
  make('Golden hour', ['whiteBalance', 'tone', 'presence'], { temperature: 35, exposure: 0.1, highlights: -20, shadows: 20, vibrance: 20, saturation: 5 }, -14, 'Landscape'),
  make('Cool landscape', ['whiteBalance', 'tone', 'presence'], { temperature: -12, contrast: 18, highlights: -25, shadows: 20, vibrance: 30 }, -15, 'Landscape'),
  make('Crisp detail', ['sharpening', 'noise'], { detail: { sharpAmount: 60, sharpRadius: 1.2, sharpMasking: 30, nrLuma: 10 } }, -16, 'Landscape'),
  // mood
  make('Moody', ['tone', 'presence', 'effects'], { exposure: -0.25, contrast: 30, highlights: -25, shadows: -10, saturation: -15, effects: { vignetteAmount: -30 } }, -17, 'Mood'),
  make('Cinematic', ['whiteBalance', 'tone', 'mixer'], { temperature: 5, contrast: 15, hsl: { hue: [0, 0, 0, 0, 0, 0, 0, 0], sat: [0, 25, 0, -20, 25, 15, 0, 0], lum: [0, 0, 0, 0, 0, 0, 0, 0] } }, -18, 'Mood'),
]

export const isBuiltin = (p: PresetRow) => p.id < 0

/** A preset that finds something in the picture first and adjusts only that: it follows the photo, so it fits any photo. */
export interface AdaptivePreset {
  name: string
  /** what is found: the sky (from colour and position), the main subject, or everything but the subject (those two use the subject model) */
  needs: 'sky' | 'subject' | 'background' | 'near' | 'far'
  /** the local adjustments put on what is found */
  adjust: Partial<import('./types').LocalAdjust>
}

export const ADAPTIVE_PRESETS: AdaptivePreset[] = [
  { name: 'Sky: deeper', needs: 'sky', adjust: { exposure: -0.35, contrast: 20, saturation: 25, highlights: -25 } },
  { name: 'Sky: warm sunset', needs: 'sky', adjust: { exposure: -0.15, temperature: 30, saturation: 20 } },
  { name: 'Sky: soft and pale', needs: 'sky', adjust: { exposure: 0.1, contrast: -20, saturation: -25 } },
  { name: 'Subject: pop', needs: 'subject', adjust: { exposure: 0.25, contrast: 15, sharpness: 25, shadows: 20 } },
  { name: 'Subject: soft glow', needs: 'subject', adjust: { exposure: 0.15, contrast: -15, sharpness: -10 } },
  { name: 'Background: darker', needs: 'background', adjust: { exposure: -0.5, saturation: -15 } },
  { name: 'Lens blur: far away', needs: 'far', adjust: { blur: 60, saturation: -10 } },
  { name: 'Lens blur: strong', needs: 'far', adjust: { blur: 100, exposure: -0.15, saturation: -15 } },
  { name: 'Lens blur: near', needs: 'near', adjust: { blur: 60 } },
  { name: 'Background: calm', needs: 'background', adjust: { contrast: -25, saturation: -30, sharpness: -20 } },
]
