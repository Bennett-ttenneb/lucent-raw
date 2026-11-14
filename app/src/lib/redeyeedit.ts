import type { RedEye } from './types'

export type RedEyeHandle = 'centre' | 'size'
export type Pt = [number, number]

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
/** A circle may be dragged a little past the picture, so an eye at the very edge can be reached. */
const pos = (v: number) => clamp(v, -0.5, 1.5)

export const MIN_RED_EYE_SIZE = 0.005
export const MAX_RED_EYE_SIZE = 0.2
export const MAX_RED_EYES = 20
export const DEFAULT_RED_EYE = { size: 0.04, darken: 0.5 }
export type RedEyeDefaults = typeof DEFAULT_RED_EYE

/**
 * The circle after dragging a handle from `from` to `to` (fractions of the picture). `aspect` is the picture's
 * width over its height. The centre handle moves the circle; the size handle sets its diameter.
 */
export function moveRedEyeHandle(original: RedEye, handle: RedEyeHandle, from: Pt, to: Pt, aspect: number): RedEye {
  if (handle === 'centre') return { ...original, x: pos(original.x + to[0] - from[0]), y: pos(original.y + to[1] - from[1]) }
  // size: work in picture units where the height is 1, so a distance is the same in every direction
  const long = Math.max(aspect, 1)
  const radius = Math.hypot((to[0] - original.x) * aspect, to[1] - original.y)
  return { ...original, size: clamp((2 * radius) / long, MIN_RED_EYE_SIZE, MAX_RED_EYE_SIZE) }
}

/** Where the handles sit, as fractions of the picture. The size handle is at the right of the circle. */
export function redEyeHandlePositions(e: RedEye, aspect: number): Record<RedEyeHandle, Pt> {
  const long = Math.max(aspect, 1)
  const radius = (e.size * long) / 2
  return { centre: [e.x, e.y], size: [e.x + radius / aspect, e.y] }
}

/** A new circle at (x, y). */
export function makeRedEye(id: string, at: Pt, d: RedEyeDefaults): RedEye {
  return { id, x: pos(at[0]), y: pos(at[1]), size: clamp(d.size, MIN_RED_EYE_SIZE, MAX_RED_EYE_SIZE), darken: clamp(d.darken, 0, 1) }
}

let counter = 0
export const newRedEyeId = () => `r${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`
