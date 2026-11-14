import { flipHorizontal, flipVertical, rotateLeft, rotateRight } from './orient'
import type { Ellipse, Mask, MaskShape, Recipe } from './types'

/**
 * Keeping the edits that sit on the picture (masks, spots, red-eye circles, faces) on the same things in it when the picture is turned,
 * flipped or re-framed. They are stored as fractions of the cropped picture, so when that picture changes they have to be carried along.
 */

export type TurnOp = 'right' | 'left' | 'flipH' | 'flipV'
type Pt = [number, number]

/** Where a point of the picture (as fractions of it) goes when the picture is turned or flipped. */
const POINT: Record<TurnOp, (p: Pt) => Pt> = {
  right: ([x, y]) => [1 - y, x],
  left: ([x, y]) => [y, 1 - x],
  flipH: ([x, y]) => [1 - x, y],
  flipV: ([x, y]) => [x, 1 - y],
}

/** How an ellipse's turn, in degrees clockwise on the screen, changes. */
const ANGLE: Record<TurnOp, (a: number) => number> = {
  right: (a) => a + 90,
  left: (a) => a - 90,
  flipH: (a) => -a,
  flipV: (a) => -a,
}

const norm180 = (a: number) => {
  let v = a % 360
  if (v > 180) v -= 360
  if (v <= -180) v += 360
  return Math.round(v * 1000) / 1000
}

/** What changes for the things the edits are made of. `point` moves a position, `size` rescales a length (a fraction of the long edge), `angle` an ellipse's turn. */
interface Change {
  point(p: Pt): Pt
  size(s: number): number
  angle(a: number): number
  /** a quarter turn swaps the two radii of a face's ellipses (they are fractions of the long edge, which is the same, but the axes trade places) */
  swapAxes: boolean
}

const ellipse = (e: Ellipse, c: Change): Ellipse => {
  const [cx, cy] = c.point([e.cx, e.cy])
  return c.swapAxes ? { cx, cy, rx: c.size(e.ry), ry: c.size(e.rx) } : { cx, cy, rx: c.size(e.rx), ry: c.size(e.ry) }
}

function shape(s: MaskShape, c: Change): MaskShape {
  switch (s.type) {
    case 'linear': {
      const [x1, y1] = c.point([s.x1, s.y1])
      const [x2, y2] = c.point([s.x2, s.y2])
      return { ...s, x1, y1, x2, y2 }
    }
    case 'radial': {
      const [cx, cy] = c.point([s.cx, s.cy])
      return { ...s, cx, cy, rx: c.size(s.rx), ry: c.size(s.ry), angle: norm180(c.angle(s.angle)) }
    }
    case 'brush':
      return { ...s, strokes: s.strokes.map((k) => ({ ...k, size: c.size(k.size), points: k.points.map((p) => c.point(p)) })) }
    default:
      return s // where the brightness or the colour is, or a picture of the subject or the sky: nothing here to carry along
  }
}

const mask = (m: Mask, c: Change): Mask => ({ ...m, shape: shape(m.shape, c), parts: m.parts.map((p) => ({ ...p, shape: shape(p.shape, c) })) })

/** The recipe with its masks, spots, red-eye circles and faces carried through `c`. */
function carry(r: Recipe, c: Change): Recipe {
  return {
    ...r,
    masks: r.masks.map((m) => mask(m, c)),
    spots: r.spots.map((s) => {
      const [x, y] = c.point([s.x, s.y])
      const [sx, sy] = c.point([s.sx, s.sy])
      return { ...s, x, y, sx, sy, size: c.size(s.size) }
    }),
    redEyes: r.redEyes.map((e) => {
      const [x, y] = c.point([e.x, e.y])
      return { ...e, x, y, size: c.size(e.size) }
    }),
    portraits: r.portraits.map((p) => ({ ...p, face: ellipse(p.face, c), leftEye: ellipse(p.leftEye, c), rightEye: ellipse(p.rightEye, c), mouth: ellipse(p.mouth, c) })),
  }
}

/** Turn or flip the picture in the recipe, taking the edits on it and the crop frame along. */
export function turnRecipe(r: Recipe, op: TurnOp): Recipe {
  const o = { quarterTurns: r.geometry.quarterTurns, mirror: r.geometry.mirror }
  const next = { right: rotateRight, left: rotateLeft, flipH: flipHorizontal, flipV: flipVertical }[op](o)
  const quarter = op === 'right' || op === 'left'
  const c: Change = { point: POINT[op], size: (s) => s, angle: ANGLE[op], swapAxes: quarter }
  const carried = carry(r, c)
  let crop = r.crop
  if (crop.rect) {
    const [cx, cy] = POINT[op]([crop.rect.cx, crop.rect.cy])
    const rect = quarter ? { cx, cy, w: crop.rect.h, h: crop.rect.w } : { cx, cy, w: crop.rect.w, h: crop.rect.h }
    const ratio = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(crop.aspect)
    const aspect = (quarter && ratio ? `${ratio[2]}:${ratio[1]}` : crop.aspect) as Recipe['crop']['aspect']
    crop = { ...crop, rect, aspect, angle: quarter ? crop.angle : -crop.angle }
  } else if (!quarter) {
    crop = { ...crop, angle: -crop.angle }
  }
  return { ...carried, geometry: { ...r.geometry, ...next }, crop }
}

/** The frame a crop leaves, in pixels of the whole picture: its top-left corner and size. */
export interface Frame {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The crop frame moved or resized (not turned): carry the edits from the old frame to the new, so each stays on the same part of the picture.
 * The edits are fractions of the frame, so they are re-expressed against the new one. Positions that fall outside the new frame are kept (they
 * simply are not seen); lengths follow the change of the frame's long edge.
 */
export function reframeRecipe(r: Recipe, from: Frame, to: Frame): Recipe {
  const same = from.x === to.x && from.y === to.y && from.w === to.w && from.h === to.h
  if (same || from.w <= 0 || from.h <= 0 || to.w <= 0 || to.h <= 0) return r
  const longFrom = Math.max(from.w, from.h)
  const longTo = Math.max(to.w, to.h)
  const c: Change = {
    point: ([x, y]) => [(from.x + x * from.w - to.x) / to.w, (from.y + y * from.h - to.y) / to.h],
    size: (s) => (s * longFrom) / longTo,
    angle: (a) => a,
    swapAxes: false,
  }
  return carry(r, c)
}
