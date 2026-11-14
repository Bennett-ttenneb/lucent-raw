// The crop frame: where it is, how it follows the mouse and the arrow keys. Pure functions, no screen in sight.
//
// A frame is a centre and a size, as fractions of the picture (lens corrections applied, nothing cropped). It is turned
// about its centre by the straighten angle. `w` and `h` are the picture's size in pixels, so the maths is the same
// for the small preview, the full-size picture and the export, and agrees with the core (`fit_crop_rect`).

import type { CropGrid } from './cropPrefs'
import type { Aspect, CropRect, Recipe } from './types'

export type CropHandle = 'tl' | 't' | 'tr' | 'r' | 'br' | 'b' | 'bl' | 'l'
export const CROP_HANDLES: CropHandle[] = ['tl', 't', 'tr', 'r', 'br', 'b', 'bl', 'l']
export type Pt = [number, number]

/** Which way each handle pulls: -1 the low edge, +1 the high edge, 0 not that way. */
const DIR: Record<CropHandle, [number, number]> = { tl: [-1, -1], t: [0, -1], tr: [1, -1], r: [1, 0], br: [1, 1], b: [0, 1], bl: [-1, 1], l: [-1, 0] }
/** The smallest frame side, as a fraction of the picture side. */
export const MIN_SIDE = 0.03

export const HANDLE_LABEL: Record<CropHandle, string> = {
  tl: 'top left corner',
  t: 'top edge',
  tr: 'top right corner',
  r: 'right edge',
  br: 'bottom right corner',
  b: 'bottom edge',
  bl: 'bottom left corner',
  l: 'left edge',
}

/** width / height a frame is locked to, or null for a free frame. A portrait picture gets a portrait frame (except 1:1). */
/** The width over the height of a ratio such as "7:5" or "2.35:1", or null when it is not one (both numbers 0.1 to 100). */
export function customRatio(s: string): number | null {
  const m = /^(\d{1,7}(?:\.\d+)?):(\d{1,7}(?:\.\d+)?)$/.exec(s)
  if (!m) return null
  const [a, b] = [Number(m[1]), Number(m[2])]
  return a >= 0.1 && a <= 100 && b >= 0.1 && b <= 100 ? a / b : null
}

export function aspectRatio(aspect: Aspect, w: number, h: number): number | null {
  if (aspect === 'free') return null
  const fixed: Record<string, number> = { '1:1': 1, '4:3': 4 / 3, '3:2': 3 / 2, '16:9': 16 / 9, '5:4': 5 / 4 }
  let r = fixed[aspect]
  if (r === undefined) {
    const custom = customRatio(aspect)
    if (!custom) return w / h // original
    r = custom
  }
  return h > w && aspect !== '1:1' ? 1 / r : r
}

const trig = (angle: number) => {
  const th = (angle * Math.PI) / 180
  return { c: Math.cos(th), s: Math.sin(th) }
}

/** Shrink a frame that cannot fit once turned, then slide it until no corner is outside. Same rule as the core. */
export function fitRect(r: CropRect, angle: number, w: number, h: number): CropRect {
  const { c, s } = trig(angle)
  const [ac, as] = [Math.abs(c), Math.abs(s)]
  let [hw, hh] = [(r.w * w) / 2, (r.h * h) / 2]
  const k = Math.min(w / 2 / (ac * hw + as * hh), h / 2 / (as * hw + ac * hh), 1)
  hw *= k
  hh *= k
  const [ex, ey] = [ac * hw + as * hh, as * hw + ac * hh]
  const within = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi))
  return { cx: within(r.cx * w, ex, w - ex) / w, cy: within(r.cy * h, ey, h - ey) / h, w: (2 * hw) / w, h: (2 * hh) / h }
}

/** The biggest frame of this proportion (width / height) that fits in the turned picture, centred. */
export function biggestRect(ratio: number, angle: number, w: number, h: number): CropRect {
  const { c, s } = trig(angle)
  const [ac, as] = [Math.abs(c), Math.abs(s)]
  const b = Math.min(w / 2 / (ratio * ac + as), h / 2 / (ratio * as + ac))
  return { cx: 0.5, cy: 0.5, w: (2 * ratio * b) / w, h: (2 * b) / h }
}

/** The frame as it is now: the placed one, made to fit, or else the biggest of the aspect. */
export function currentRect(crop: Recipe['crop'], w: number, h: number): CropRect {
  if (crop.rect) return fitRect(crop.rect, crop.angle, w, h)
  return biggestRect(aspectRatio(crop.aspect, w, h) ?? w / h, crop.angle, w, h)
}

/** The frame after picking an aspect: the biggest of that shape, around where the frame was. Free keeps it as it is. */
export function rectForAspect(cur: CropRect, aspect: Aspect, angle: number, w: number, h: number): CropRect {
  const ratio = aspectRatio(aspect, w, h)
  if (ratio === null) return cur
  const big = biggestRect(ratio, angle, w, h)
  return fitRect({ ...big, cx: cur.cx, cy: cur.cy }, angle, w, h)
}

/** Portrait becomes landscape and back: the same frame turned a quarter. */
export function swapRect(cur: CropRect, angle: number, w: number, h: number): CropRect {
  return fitRect({ cx: cur.cx, cy: cur.cy, w: (cur.h * h) / w, h: (cur.w * w) / h }, angle, w, h)
}

/** Slide the frame by this much (fractions of the picture), keeping it inside. */
export function moveRect(r: CropRect, dx: number, dy: number, angle: number, w: number, h: number): CropRect {
  return fitRect({ ...r, cx: r.cx + dx, cy: r.cy + dy }, angle, w, h)
}

/** Where a handle is on the picture, as fractions of it. */
export function handlePoint(r: CropRect, handle: CropHandle, angle: number, w: number, h: number): Pt {
  const { c, s } = trig(angle)
  const [sx, sy] = DIR[handle]
  const [lu, lv] = [(sx * r.w * w) / 2, (sy * r.h * h) / 2]
  return [(r.cx * w + lu * c - lv * s) / w, (r.cy * h + lu * s + lv * c) / h]
}

/**
 * Drag a handle to the point `p` (fractions of the picture). The opposite side stays where it is; with a locked
 * ratio a corner keeps the ratio and an edge grows the other side about the middle of the frame.
 */
export function dragHandle(start: CropRect, handle: CropHandle, p: Pt, angle: number, w: number, h: number, ratio: number | null): CropRect {
  const { c, s } = trig(angle)
  const [sx, sy] = DIR[handle]
  const [hw, hh] = [(start.w * w) / 2, (start.h * h) / 2]
  // the pointer in the frame's own axes, from its centre
  const [dx, dy] = [p[0] * w - start.cx * w, p[1] * h - start.cy * h]
  const [qu, qv] = [dx * c + dy * s, -dx * s + dy * c]
  const [minW, minH] = [MIN_SIDE * w, MIN_SIDE * h]
  let [left, right, top, bottom] = [-hw, hw, -hh, hh]
  if (sx === -1) left = Math.min(qu, right - minW)
  if (sx === 1) right = Math.max(qu, left + minW)
  if (sy === -1) top = Math.min(qv, bottom - minH)
  if (sy === 1) bottom = Math.max(qv, top + minH)
  let [fw, fh] = [right - left, bottom - top]
  if (ratio !== null) {
    if (sx !== 0 && sy !== 0) {
      fw = Math.max(fw, fh * ratio)
      fh = fw / ratio
      if (sx === 1) right = left + fw
      else left = right - fw
      if (sy === 1) bottom = top + fh
      else top = bottom - fh
    } else if (sx !== 0) {
      fh = fw / ratio
      const mid = (top + bottom) / 2
      ;[top, bottom] = [mid - fh / 2, mid + fh / 2]
    } else {
      fw = fh * ratio
      const mid = (left + right) / 2
      ;[left, right] = [mid - fw / 2, mid + fw / 2]
    }
  }
  const [lu, lv] = [(left + right) / 2, (top + bottom) / 2]
  const next: CropRect = { cx: (start.cx * w + lu * c - lv * s) / w, cy: (start.cy * h + lu * s + lv * c) / h, w: fw / w, h: fh / h }
  return fitRect(next, angle, w, h)
}

/** Move a handle by a step, for the arrow keys. */
export function nudgeHandle(r: CropRect, handle: CropHandle, d: Pt, angle: number, w: number, h: number, ratio: number | null): CropRect {
  const at = handlePoint(r, handle, angle, w, h)
  return dragHandle(r, handle, [at[0] + d[0], at[1] + d[1]], angle, w, h, ratio)
}

/** One line of a guide: from (x1, y1) to (x2, y2). */
export type Line = [number, number, number, number]

/** Where along a side the lines of a grid fall, as shares of it: thirds, the golden ratio (0.382 and 0.618), or finer. */
const SPLITS: Record<'thirds' | 'golden' | 'fine', number[]> = { thirds: [1 / 3, 2 / 3], golden: [0.381966, 0.618034], fine: [1, 2, 3, 4, 5, 6, 7].map((i) => i / 8) }

/**
 * The lines of a composition guide inside a frame whose half width and half height are `hw` and `hh`, centred on (0, 0).
 * They come in groups that belong together: a vertical and a horizontal line at each split, or the two diagonals.
 */
export function guideLines(guide: CropGrid, hw: number, hh: number): Line[][] {
  if (guide === 'off') return []
  if (guide === 'diagonal') {
    return [[[-hw, -hh, hw, hh], [-hw, hh, hw, -hh]]]
  }
  if (guide === 'triangle') {
    // the diagonal from the top left to the bottom right, and a line from each of the other two corners meeting it at a right angle
    const [dx, dy] = [2 * hw, 2 * hh]
    const len2 = dx * dx + dy * dy
    const foot = (px: number, py: number): [number, number] => {
      const k = ((px + hw) * dx + (py + hh) * dy) / len2
      return [-hw + k * dx, -hh + k * dy]
    }
    const [ax, ay] = foot(hw, -hh)
    const [bx, by] = foot(-hw, hh)
    return [[[-hw, -hh, hw, hh], [hw, -hh, ax, ay], [-hw, hh, bx, by]]]
  }
  return SPLITS[guide].map((t) => [[-hw + 2 * hw * t, -hh, -hw + 2 * hw * t, hh] as Line, [-hw, -hh + 2 * hh * t, hw, -hh + 2 * hh * t] as Line])
}

/** The frame in whole pixels of a picture, for showing "1200 × 800". */
export const rectPixels = (r: CropRect, w: number, h: number): [number, number] => [Math.round(r.w * w), Math.round(r.h * h)]

/**
 * The Straighten tool: the angle that makes a line drawn from `a` to `b` (both as fractions of the picture) level, so the
 * frame is turned to lie along it. A line that is nearer upright than level straightens to upright. Null for a line too short
 * to mean anything (under 12 pixels) or an angle outside what the angle slider holds (45 degrees either way).
 */
export function straightenAngle(a: Pt, b: Pt, W: number, H: number): number | null {
  const dx = (b[0] - a[0]) * W
  const dy = (b[1] - a[1]) * H
  if (Math.hypot(dx, dy) < 12) return null
  let deg = (Math.atan2(dy, dx) * 180) / Math.PI // -180 .. 180, clockwise on screen
  if (deg > 90) deg -= 180
  if (deg <= -90) deg += 180 // a line has no direction: -90 .. 90
  if (deg > 45) deg -= 90 // nearer upright than level
  if (deg < -45) deg += 90
  return Math.round(deg * 10) / 10
}
