import type { Spot } from './types'

export type SpotHandle = 'target' | 'source' | 'size'
export type Pt = [number, number]

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
/** A circle may be dragged a little past the picture, so a spot at the very edge can be placed. */
const pos = (v: number) => clamp(v, -0.5, 1.5)

export const MIN_SPOT_SIZE = 0.005
export const MAX_SPOT_SIZE = 0.3
export const DEFAULT_SPOT = { mode: 'heal' as Spot['mode'], size: 0.04, feather: 0.5, opacity: 1 }
export type SpotDefaults = typeof DEFAULT_SPOT

/**
 * The spot after dragging a handle from `from` to `to` (fractions of the picture). `aspect` is the picture's
 * width over its height. Dragging the spot itself takes its source along, so the patch keeps the same offset;
 * dragging the source moves only the source; dragging the size handle sets the diameter.
 */
export function moveSpotHandle(original: Spot, handle: SpotHandle, from: Pt, to: Pt, aspect: number): Spot {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  if (handle === 'target') return { ...original, x: pos(original.x + dx), y: pos(original.y + dy), sx: pos(original.sx + dx), sy: pos(original.sy + dy) }
  if (handle === 'source') return { ...original, sx: pos(original.sx + dx), sy: pos(original.sy + dy) }
  // size: work in picture units where the height is 1, so a distance is the same in every direction
  const long = Math.max(aspect, 1)
  const radius = Math.hypot((to[0] - original.x) * aspect, to[1] - original.y)
  return { ...original, size: clamp((2 * radius) / long, MIN_SPOT_SIZE, MAX_SPOT_SIZE) }
}

/** Where the handles sit, as fractions of the picture. The size handle is at the right of the target circle. */
export function spotHandlePositions(s: Spot, aspect: number): Record<SpotHandle, Pt> {
  const long = Math.max(aspect, 1)
  const radius = (s.size * long) / 2
  return { target: [s.x, s.y], source: [s.sx, s.sy], size: [s.x + radius / aspect, s.y] }
}

/** A new spot at (x, y) copying from (sx, sy). */
export function makeSpot(id: string, at: Pt, source: Pt, d: SpotDefaults): Spot {
  return { id, visible: true, mode: d.mode, x: pos(at[0]), y: pos(at[1]), sx: pos(source[0]), sy: pos(source[1]), size: clamp(d.size, MIN_SPOT_SIZE, MAX_SPOT_SIZE), feather: d.feather, opacity: d.opacity }
}

/** When no good source can be found, put it beside the spot, on the side with room. */
export function fallbackSource(at: Pt, size: number, aspect: number): Pt {
  const long = Math.max(aspect, 1)
  const gap = (size * long * 3) / aspect // three diameters, in fractions of the width
  return [at[0] + gap < 0.97 ? at[0] + gap : Math.max(0.03, at[0] - gap), at[1]]
}

let counter = 0
export const newSpotId = () => `s${Date.now().toString(36)}${(counter++).toString(36)}${Math.random().toString(36).slice(2, 6)}`
