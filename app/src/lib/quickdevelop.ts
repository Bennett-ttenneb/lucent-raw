import { sliderDef, type SliderKey } from './develop'
import type { Recipe } from './types'

/** One row of Quick Develop: a name and how far the single arrows and the double arrows move it (as Lightroom's Quick Develop does). */
export interface QuickRow {
  key: SliderKey
  small: number
  big: number
}

export const QUICK_ROWS: QuickRow[] = [
  { key: 'temperature', small: 5, big: 20 },
  { key: 'tint', small: 5, big: 20 },
  { key: 'exposure', small: 1 / 3, big: 1 },
  { key: 'contrast', small: 5, big: 20 },
  { key: 'highlights', small: 5, big: 20 },
  { key: 'shadows', small: 5, big: 20 },
  { key: 'whites', small: 5, big: 20 },
  { key: 'blacks', small: 5, big: 20 },
  { key: 'texture', small: 5, big: 20 },
  { key: 'clarity', small: 5, big: 20 },
  { key: 'dehaze', small: 5, big: 20 },
  { key: 'vibrance', small: 5, big: 20 },
  { key: 'saturation', small: 5, big: 20 },
]

/** The recipe after moving one slider by `delta`, kept inside the slider's range and to the digits it shows. */
export function nudged(recipe: Recipe, key: SliderKey, delta: number): Recipe {
  const d = sliderDef(key)
  const f = 10 ** d.digits
  const next = Math.min(d.max, Math.max(d.min, Math.round((((recipe[key] as number) ?? 0) + delta) * f) / f))
  return { ...recipe, [key]: next }
}

/** "+0.33", "-5", "+1.00": what a move is called in the History. */
export function moveText(key: SliderKey, delta: number): string {
  const d = sliderDef(key)
  const v = delta.toFixed(d.digits)
  return delta > 0 ? `+${v}` : v
}
