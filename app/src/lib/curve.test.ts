import { describe, expect, it } from 'vitest'
import { MAX_POINTS, addPoint, cleanPoints, curveValues, isStraight, movePoint, type Point } from './curve'

describe('tone curve maths', () => {
  it('no points, or points on the line, is a straight line', () => {
    expect(isStraight([])).toBe(true)
    expect(isStraight([[64, 64], [192, 192]])).toBe(true)
    expect(curveValues([])[100]).toBe(100)
    expect(isStraight([[128, 150]])).toBe(false)
  })
  it('passes through its points and keeps the ends', () => {
    const v = curveValues([[128, 180]])
    expect(v[0]).toBe(0)
    expect(v[255]).toBe(255)
    expect(Math.abs(v[128] - 180)).toBeLessThan(1.5)
  })
  it('never goes down, even for a steep S', () => {
    const v = curveValues([[40, 10], [100, 120], [110, 200], [200, 250]])
    for (let i = 1; i < 256; i++) expect(v[i]).toBeGreaterThanOrEqual(v[i - 1] - 1e-9)
    expect(Math.min(...v)).toBeGreaterThanOrEqual(0)
    expect(Math.max(...v)).toBeLessThanOrEqual(255)
  })
  it('cleans points: sorted, clamped, one per input, no NaN, capped', () => {
    expect(cleanPoints([[200, 210], [50, 40], [50.4, 99], [NaN, 1], [-20, 300]])).toEqual([[0, 255], [50, 40], [200, 210]])
    const many: Point[] = Array.from({ length: 40 }, (_, i) => [i * 6, i * 6])
    expect(cleanPoints(many)).toHaveLength(MAX_POINTS)
  })
  it('a moved point stays between its neighbours', () => {
    const pts: Point[] = [[50, 50], [100, 100], [150, 150]]
    expect(movePoint(pts, 1, [10, 100])[1][0]).toBe(51)
    expect(movePoint(pts, 1, [250, 100])[1][0]).toBe(149)
    expect(movePoint(pts, 1, [100, 999])[1][1]).toBe(255)
    expect(movePoint(pts, 0, [-5, 50])[0][0]).toBe(0)
  })
  it('clicking near a point picks it, clicking elsewhere adds one, and the count is capped', () => {
    const base: Point[] = [[100, 100]]
    expect(addPoint(base, 103, 102).index).toBe(0)
    const added = addPoint(base, 200, 190)
    expect(added.points).toHaveLength(2)
    expect(added.points[added.index]).toEqual([200, 190])
    const full = Array.from({ length: MAX_POINTS }, (_, i): Point => [i * 15 + 1, i * 15 + 1])
    expect(addPoint(full, 250, 100, 2).index).toBe(-1)
  })
})
