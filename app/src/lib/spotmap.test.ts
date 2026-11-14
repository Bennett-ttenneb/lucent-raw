import { describe, expect, it } from 'vitest'
import { lumaOf, speckMap } from './spotmap'

const grey = (m: Uint8ClampedArray, i: number) => m[i * 4]

describe('the map of small specks', () => {
  it('is black where the picture and its blur agree and white-ish where a speck stands out', () => {
    const luma = [100, 100, 100, 100, 20, 100, 100, 100, 100]
    const blurred = [100, 100, 100, 100, 92, 100, 100, 100, 100]
    const m = speckMap(luma, blurred)
    expect(m.length).toBe(36)
    for (const i of [0, 1, 2, 3, 5, 6, 7, 8]) expect(grey(m, i)).toBe(0)
    expect(grey(m, 4)).toBeGreaterThan(200) // 72 levels off, times the gain
    expect(m[4 * 4 + 3]).toBe(255)
  })

  it('a bright speck shows as much as a dark one, and a bigger difference is brighter', () => {
    const dark = speckMap([80], [100])
    const bright = speckMap([120], [100])
    expect(grey(dark, 0)).toBe(grey(bright, 0))
    const small = grey(speckMap([95], [100]), 0)
    const large = grey(speckMap([70], [100]), 0)
    expect(small).toBeGreaterThan(0)
    expect(large).toBeGreaterThan(small)
  })

  it('stays within 0 to 255 for any difference, and the gain makes faint things easier to see', () => {
    expect(grey(speckMap([0], [255], 100), 0)).toBe(255)
    expect(grey(speckMap([255], [0], 1000), 0)).toBe(255)
    expect(grey(speckMap([100], [100]), 0)).toBe(0)
    expect(grey(speckMap([98], [100], 12), 0)).toBeGreaterThan(grey(speckMap([98], [100], 3), 0))
  })

  it('handles pictures of different lengths and empty ones without a fuss', () => {
    expect(speckMap([1, 2, 3], [1, 2]).length).toBe(8)
    expect(speckMap([], []).length).toBe(0)
  })

  it('works out brightness from RGBA with green counting most', () => {
    const l = lumaOf([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255])
    expect(l[0]).toBeCloseTo(76.2, 0)
    expect(l[1]).toBeCloseTo(149.7, 0)
    expect(l[2]).toBeCloseTo(29.1, 0)
    expect(l[3]).toBeCloseTo(255, 0)
    expect(lumaOf([]).length).toBe(0)
  })
})
