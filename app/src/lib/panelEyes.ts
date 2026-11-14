import { LENS, TRANSFORM } from './develop'
import { applyGroups } from './presets'
import { DEFAULT_RECIPE, type Recipe } from './types'

/** The Develop panels that have an on and off switch, and what each switches: the picture is shown without that panel's settings, which are kept. */
export const PANEL_EYES: Record<string, string> = {
  Basic: 'basic',
  'Tone curve': 'curve',
  'Colour mixer': 'mixer',
  'Colour grading': 'grading',
  Detail: 'detail',
  'Lens corrections': 'lens',
  Transform: 'transform',
  Effects: 'effects',
  Calibration: 'calibration',
}

const GROUPS: Record<string, string[]> = {
  basic: ['whiteBalance', 'tone', 'presence'],
  curve: ['curve'],
  mixer: ['mixer'],
  grading: ['grading'],
  detail: ['sharpening', 'noise'],
  effects: ['effects'],
  calibration: ['calibration'],
}

/** The recipe as it looks with these panels switched off (their settings put back to neutral, for showing only). */
export function withPanelsOff(r: Recipe, off: readonly string[]): Recipe {
  if (off.length === 0) return r
  let out = r
  for (const id of off) {
    const groups = GROUPS[id]
    if (groups) out = applyGroups(out, DEFAULT_RECIPE, groups)
    else if (id === 'lens' || id === 'transform') {
      const keys = (id === 'lens' ? LENS : TRANSFORM).map((d) => d.key)
      const geometry = { ...out.geometry }
      for (const k of keys) (geometry as Record<string, unknown>)[k] = (DEFAULT_RECIPE.geometry as Record<string, unknown>)[k]
      out = { ...out, geometry }
    }
  }
  return out
}
