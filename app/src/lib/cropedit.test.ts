import { describe, expect, it } from 'vitest'
import { aspectRatio, customRatio, biggestRect, currentRect, dragHandle, fitRect, guideLines, handlePoint, moveRect, nudgeHandle, rectForAspect, swapRect } from './cropedit'
import { cropIsDefault, cropKey, recipesEqual } from './develop'
import { DEFAULT_RECIPE, type CropRect } from './types'

const near = (a: number, b: number, d = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(d)
const sq = (r: CropRect, w: number, h: number) => ({ left: (r.cx - r.w / 2) * w, right: (r.cx + r.w / 2) * w, top: (r.cy - r.h / 2) * h, bottom: (r.cy + r.h / 2) * h })

describe('aspect ratios', () => {
  it('free has no lock, original is the picture, and portrait pictures keep portrait frames except 1:1', () => {
    expect(aspectRatio('free', 800, 400)).toBeNull()
    expect(aspectRatio('original', 800, 400)).toBe(2)
    expect(aspectRatio('3:2', 600, 400)).toBeCloseTo(1.5)
    expect(aspectRatio('3:2', 400, 600)).toBeCloseTo(2 / 3)
    expect(aspectRatio('1:1', 400, 600)).toBe(1)
  })
})

describe('fitting a frame (the same rule as the core)', () => {
  it('moves a frame that sticks out back in, keeping its size', () => {
    const r = fitRect({ cx: 0.95, cy: 0.02, w: 0.4, h: 0.4 }, 0, 400, 200)
    near(r.w, 0.4)
    near(r.h, 0.4)
    near(r.cx, 0.8)
    near(r.cy, 0.2) // the same numbers as the core's test
  })
  it('shrinks a turned frame that cannot fit, keeping its proportions, and every corner is inside', () => {
    const r = fitRect({ cx: 0.5, cy: 0.5, w: 1, h: 1 }, 10, 400, 200)
    expect(r.w).toBeLessThan(1)
    near((r.w * 400) / (r.h * 200), 2, 1e-4)
    for (const h of ['tl', 'tr', 'br', 'bl'] as const) {
      const [x, y] = handlePoint(r, h, 10, 400, 200)
      expect(x).toBeGreaterThan(-1e-4)
      expect(x).toBeLessThan(1 + 1e-4)
      expect(y).toBeGreaterThan(-1e-4)
      expect(y).toBeLessThan(1 + 1e-4)
    }
  })
  it('leaves a frame that fits alone', () => {
    const r = { cx: 0.5, cy: 0.5, w: 0.5, h: 0.5 }
    expect(fitRect(r, 0, 300, 300)).toEqual(r)
  })
})

describe('the biggest frame of an aspect', () => {
  it('is the whole picture for its own shape and a full-height or full-width cut for others', () => {
    expect(biggestRect(2, 0, 800, 400)).toEqual({ cx: 0.5, cy: 0.5, w: 1, h: 1 })
    const square = biggestRect(1, 0, 800, 400)
    near(square.w, 0.5)
    near(square.h, 1)
  })
  it('without a placed frame the frame shown is the biggest of the aspect, turned by the angle', () => {
    const r = currentRect({ aspect: 'original', angle: 12, rect: null }, 600, 400)
    expect(r.w).toBeLessThan(1)
    near((r.w * 600) / (r.h * 400), 1.5, 1e-4)
  })
  it('picking an aspect keeps the frame about where it was', () => {
    const cur = { cx: 0.7, cy: 0.5, w: 0.3, h: 0.3 }
    const next = rectForAspect(cur, '1:1', 0, 800, 400)
    near(next.w * 800, next.h * 400, 1e-4)
    expect(next.cx).toBeGreaterThan(0.5) // pulled inside but not recentred more than it must be
    expect(rectForAspect(cur, 'free', 0, 800, 400)).toEqual(cur)
  })
  it('turning the frame swaps its width and height in pixels', () => {
    const r = swapRect({ cx: 0.5, cy: 0.5, w: 0.5, h: 0.25 }, 0, 800, 400) // 400 x 100 px
    near(r.w * 800, 100)
    near(r.h * 400, 400)
  })
})

describe('moving and resizing', () => {
  const start: CropRect = { cx: 0.5, cy: 0.5, w: 0.5, h: 0.5 }
  it('moves, and stops at the edge of the picture', () => {
    const m = moveRect(start, 0.1, -0.1, 0, 100, 100)
    near(m.cx, 0.6)
    near(m.cy, 0.4)
    const far = moveRect(start, 5, 5, 0, 100, 100)
    near(far.cx, 0.75)
    near(far.cy, 0.75)
  })
  it('a free corner follows the pointer and the opposite corner stays put', () => {
    const r = dragHandle(start, 'br', [0.9, 0.8], 0, 100, 100, null)
    const s = sq(r, 100, 100)
    near(s.right, 90)
    near(s.bottom, 80)
    near(s.left, 25)
    near(s.top, 25)
  })
  it('a free edge changes one side only', () => {
    const r = dragHandle(start, 'l', [0.1, 0.9], 0, 100, 100, null)
    const s = sq(r, 100, 100)
    near(s.left, 10)
    near(s.right, 75)
    near(s.top, 25)
    near(s.bottom, 75)
  })
  it('a locked corner keeps the shape and the opposite corner', () => {
    const r = dragHandle({ cx: 0.5, cy: 0.5, w: 0.4, h: 0.2 }, 'br', [0.9, 0.5], 0, 100, 100, 2)
    near((r.w * 100) / (r.h * 100), 2, 1e-6)
    const s = sq(r, 100, 100)
    near(s.left, 30)
    near(s.top, 40)
  })
  it('a locked edge grows the other side about the middle of the frame', () => {
    const r = dragHandle({ cx: 0.5, cy: 0.5, w: 0.4, h: 0.2 }, 'r', [0.8, 0.5], 0, 100, 100, 2)
    near((r.w * 100) / (r.h * 100), 2, 1e-6)
    near(r.cy, 0.5)
    near(sq(r, 100, 100).left, 30)
  })
  it('cannot be made smaller than a few percent, or turned inside out', () => {
    const r = dragHandle(start, 'br', [0, 0], 0, 100, 100, null)
    near(r.w, 0.03)
    near(r.h, 0.03)
    near(sq(r, 100, 100).left, 25)
  })
  it('a turned frame is dragged along its own axes: the far edge stays put', () => {
    const rect: CropRect = { cx: 0.5, cy: 0.5, w: 0.4, h: 0.3 }
    const angle = 20
    const [lx, ly] = handlePoint(rect, 'l', angle, 400, 400)
    const [rx, ry] = handlePoint(rect, 'r', angle, 400, 400)
    const th = (angle * Math.PI) / 180
    const out = dragHandle(rect, 'r', [rx + 0.05 * Math.cos(th), ry + 0.05 * Math.sin(th)], angle, 400, 400, null)
    const [lx2, ly2] = handlePoint(out, 'l', angle, 400, 400)
    near(lx2, lx, 1e-6)
    near(ly2, ly, 1e-6)
    near(out.w, rect.w + 0.05, 1e-6)
    near(out.h, rect.h, 1e-6)
  })
  it('the arrow keys move a handle by the step', () => {
    const r = nudgeHandle(start, 'r', [0.04, 0], 0, 100, 100, null)
    near(sq(r, 100, 100).right, 79)
    const up = nudgeHandle(start, 't', [0, -0.04], 0, 100, 100, null)
    near(sq(up, 100, 100).top, 21)
  })
})

describe('the frame in the recipe', () => {
  it('is part of recipe equality, the crop key and "is the crop untouched"', () => {
    const a = { ...DEFAULT_RECIPE, crop: { aspect: 'free' as const, angle: 0, rect: { cx: 0.5, cy: 0.5, w: 0.5, h: 0.5 } } }
    expect(recipesEqual(a, DEFAULT_RECIPE)).toBe(false)
    expect(recipesEqual(a, { ...a, crop: { ...a.crop, rect: { ...a.crop.rect!, cx: 0.51 } } })).toBe(false)
    expect(cropKey(a.crop)).not.toBe(cropKey(DEFAULT_RECIPE.crop))
    expect(cropIsDefault(a.crop)).toBe(false)
    expect(cropIsDefault(DEFAULT_RECIPE.crop)).toBe(true)
    expect(cropIsDefault({ aspect: 'free', angle: 0, rect: null })).toBe(false) // a chosen mode, even if it cuts nothing yet
  })
})

describe('composition guides', () => {
  const cross = (g: ReturnType<typeof guideLines>[number]) => ({ x: g[0][0], y: g[1][1] })
  it('thirds put two lines each way a third of the way across, keeping each vertical and horizontal line in a pair', () => {
    const g = guideLines('thirds', 150, 90)
    expect(g).toHaveLength(2)
    near(cross(g[0]).x, -50)
    near(cross(g[1]).x, 50)
    near(cross(g[0]).y, -30)
    near(cross(g[1]).y, 30)
    expect(g[0][0]).toEqual([g[0][0][0], -90, g[0][0][0], 90]) // a vertical line spans the frame's height
    expect(g[0][1]).toEqual([-150, g[0][1][1], 150, g[0][1][3]])
  })
  it('the golden ratio puts the lines at 0.382 and 0.618 of the way across, mirror images of each other', () => {
    const g = guideLines('golden', 100, 100)
    expect(g).toHaveLength(2)
    near(cross(g[0]).x, -100 + 200 * 0.381966)
    near(cross(g[1]).x, -100 + 200 * 0.618034)
    near(cross(g[0]).x, -cross(g[1]).x)
    // the larger part to the smaller is the golden ratio
    near((200 - (cross(g[0]).x + 100)) / (cross(g[0]).x + 100), 1.618, 0.001)
  })
  it('diagonals are the two corner to corner lines, in one group', () => {
    expect(guideLines('diagonal', 120, 80)).toEqual([[[-120, -80, 120, 80], [-120, 80, 120, -80]]])
  })
  it('triangles are the diagonal and a line from each other corner that meets it at a right angle, inside the frame', () => {
    const [group] = guideLines('triangle', 120, 80)
    expect(group).toHaveLength(3)
    const [d, a, b] = group
    const dir = [d[2] - d[0], d[3] - d[1]]
    for (const l of [a, b]) {
      expect(Math.abs((l[2] - l[0]) * dir[0] + (l[3] - l[1]) * dir[1])).toBeLessThan(1e-6)
      expect(Math.abs(l[2]) <= 120 && Math.abs(l[3]) <= 80).toBe(true)
    }
  })
  it('fine is seven lines each way, and off is nothing', () => {
    expect(guideLines('fine', 100, 100)).toHaveLength(7)
    expect(guideLines('off', 100, 100)).toEqual([])
  })
  it('every line stays inside the frame', () => {
    for (const grid of ['thirds', 'golden', 'diagonal', 'triangle', 'fine'] as const) {
      for (const group of guideLines(grid, 130, 70)) for (const [x1, y1, x2, y2] of group) for (const [x, y] of [[x1, y1], [x2, y2]]) expect(Math.abs(x) <= 130 + 1e-9 && Math.abs(y) <= 70 + 1e-9).toBe(true)
    }
  })
})

describe('a ratio of your own', () => {
  it('reads two numbers with a colon and nothing else', () => {
    expect(customRatio('7:5')).toBeCloseTo(1.4)
    expect(customRatio('2.35:1')).toBeCloseTo(2.35)
    for (const bad of ['', '7', '7:', ':5', 'a:b', '0:5', '5:0', '1000:2', '7:5:3', '-3:2']) expect(customRatio(bad)).toBeNull()
  })

  it('gives a frame of that shape in the photo\'s own orientation', () => {
    expect(aspectRatio('7:5', 800, 400)).toBeCloseTo(1.4)
    expect(aspectRatio('7:5', 400, 800)).toBeCloseTo(1 / 1.4)
    expect(aspectRatio('nonsense' as never, 800, 400)).toBeCloseTo(2) // not a ratio: the picture's own
  })
})
