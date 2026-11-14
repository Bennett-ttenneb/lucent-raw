import { describe, expect, it } from 'vitest'
import { BLOWN, CRUSHED, findClipping, shareText } from './clipping'

/** A picture from a list of [r, g, b] pixels. */
const pic = (px: [number, number, number][]) => new Uint8ClampedArray(px.flatMap(([r, g, b]) => [r, g, b, 255]))
const at = (c: ReturnType<typeof findClipping>, i: number) => Array.from(c.overlay.slice(i * 4, i * 4 + 4))

describe('finding what has lost its detail', () => {
  it('marks a blown pixel red when any channel reaches the top, and a crushed one blue when every channel is at the bottom', () => {
    const c = findClipping(pic([[255, 255, 255], [255, 10, 10], [10, 10, 253], [0, 0, 0], [2, 2, 2], [128, 128, 128]]))
    expect(at(c, 0)).toEqual([255, 50, 50, 200])
    expect(at(c, 1)).toEqual([255, 50, 50, 200]) // one blown channel is enough
    expect(at(c, 2)).toEqual([255, 50, 50, 200])
    expect(at(c, 3)).toEqual([50, 120, 255, 200])
    expect(at(c, 4)).toEqual([50, 120, 255, 200])
    expect(at(c, 5)).toEqual([0, 0, 0, 0]) // untouched means clear
  })

  it('a single dark channel is not crushed, and just under the limits is fine', () => {
    const c = findClipping(pic([[0, 0, 40], [0, 3, 0], [BLOWN - 1, BLOWN - 1, BLOWN - 1], [CRUSHED + 1, CRUSHED + 1, CRUSHED + 1], [BLOWN, 0, 0]]))
    expect([0, 1, 2, 3].map((i) => at(c, i)[3])).toEqual([0, 0, 0, 0])
    expect(at(c, 4)[3]).toBe(200)
  })

  it('counts the shares of the picture', () => {
    const c = findClipping(pic([[255, 255, 255], [255, 255, 255], [0, 0, 0], [100, 100, 100], [100, 100, 100], [100, 100, 100], [100, 100, 100], [100, 100, 100], [100, 100, 100], [100, 100, 100]]))
    expect(c.blown).toBeCloseTo(20)
    expect(c.crushed).toBeCloseTo(10)
  })

  it('an empty picture and a picture with nothing wrong are not a problem', () => {
    expect(findClipping(new Uint8ClampedArray(0))).toMatchObject({ blown: 0, crushed: 0 })
    const fine = findClipping(pic([[100, 120, 140], [30, 40, 50]]))
    expect([fine.blown, fine.crushed]).toEqual([0, 0])
    expect(Array.from(fine.overlay).every((v) => v === 0)).toBe(true)
  })

  it('the limits can be moved', () => {
    const c = findClipping(pic([[240, 240, 240], [10, 10, 10]]), 235, 12)
    expect([at(c, 0)[3], at(c, 1)[3]]).toEqual([200, 200])
  })

  it('says the shares in words', () => {
    expect(shareText(0)).toBe('none')
    expect(shareText(0.04)).toBe('under 0.1%')
    expect(shareText(0.1)).toBe('0.1%')
    expect(shareText(12.345)).toBe('12.3%')
  })

  it('by channel, the colour says which channels clipped, and a shadow counts when any channel is low', () => {
    const c = findClipping(pic([[255, 10, 10], [10, 255, 10], [10, 10, 255], [255, 255, 10], [255, 255, 255], [0, 100, 100], [128, 128, 128]]), BLOWN, CRUSHED, true)
    const px = (i: number) => Array.from(c.overlay.slice(i * 4, i * 4 + 3))
    expect([px(0), px(1), px(2), px(3), px(4)]).toEqual([[255, 60, 60], [60, 255, 60], [60, 60, 255], [255, 255, 60], [255, 255, 255]])
    expect(px(5)).toEqual([255, 60, 60]) // only the red channel is crushed
    expect(Array.from(c.overlay.slice(6 * 4, 6 * 4 + 4))).toEqual([0, 0, 0, 0])
    expect(c.blown).toBeCloseTo((5 / 7) * 100)
    expect(c.crushed).toBeCloseTo((1 / 7) * 100)
  })
  it('the levels can be moved', () => {
    const p = pic([[240, 240, 240], [250, 250, 250], [20, 20, 20]])
    expect(findClipping(p, 240, 20).blown).toBeCloseTo((2 / 3) * 100)
    expect(findClipping(p, 240, 20).crushed).toBeCloseTo((1 / 3) * 100)
  })
})
