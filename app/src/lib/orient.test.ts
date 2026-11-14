import { describe, expect, it } from 'vitest'
import { NOT_TURNED, flipHorizontal, flipVertical, isNotTurned, orientRows, rotateLeft, rotateRight, type Orientation } from './orient'

const SOURCE = ['ABC', 'DEF']
const reverseEach = (rows: string[]) => rows.map((r) => [...r].reverse().join(''))
const turnClockwise = (rows: string[]) => orientRows(rows, { quarterTurns: 1, mirror: false })
const all: Orientation[] = [0, 1, 2, 3].flatMap((quarterTurns) => [false, true].map((mirror) => ({ quarterTurns, mirror })))

describe('turning a picture the way the core does', () => {
  it('gives the table worked out by hand, the same one as in the core (geometry.rs)', () => {
    const table: [number, boolean, string][] = [
      [0, false, 'ABC/DEF'],
      [1, false, 'DA/EB/FC'],
      [2, false, 'FED/CBA'],
      [3, false, 'CF/BE/AD'],
      [0, true, 'CBA/FED'],
      [1, true, 'FC/EB/DA'],
      [2, true, 'DEF/ABC'],
      [3, true, 'AD/BE/CF'],
    ]
    for (const [quarterTurns, mirror, want] of table) expect(orientRows(SOURCE, { quarterTurns, mirror }).join('/'), `${quarterTurns} turns, mirrored ${mirror}`).toBe(want)
  })
})

describe('the buttons mean what the screen shows', () => {
  it('turning right or left turns what is on screen a quarter, from every starting point', () => {
    for (const o of all) {
      const now = orientRows(SOURCE, o)
      expect(orientRows(SOURCE, rotateRight(o)), JSON.stringify(o)).toEqual(turnClockwise(now))
      expect(orientRows(SOURCE, rotateLeft(o)), JSON.stringify(o)).toEqual(turnClockwise(turnClockwise(turnClockwise(now))))
    }
  })
  it('flipping horizontally swaps left and right on the screen, from every starting point', () => {
    for (const o of all) expect(orientRows(SOURCE, flipHorizontal(o)), JSON.stringify(o)).toEqual(reverseEach(orientRows(SOURCE, o)))
  })
  it('flipping vertically swaps top and bottom on the screen, from every starting point', () => {
    for (const o of all) expect(orientRows(SOURCE, flipVertical(o)), JSON.stringify(o)).toEqual([...orientRows(SOURCE, o)].reverse())
  })
  it('every button undoes itself when pressed enough times', () => {
    for (const o of all) {
      expect(rotateRight(rotateRight(rotateRight(rotateRight(o))))).toEqual(o)
      expect(rotateLeft(rotateRight(o))).toEqual(o)
      expect(flipHorizontal(flipHorizontal(o))).toEqual(o)
      expect(flipVertical(flipVertical(o))).toEqual(o)
    }
  })
  it('flipping both ways is a half turn', () => {
    expect(flipVertical(flipHorizontal(NOT_TURNED))).toEqual({ quarterTurns: 2, mirror: false })
    for (const o of all) expect(orientRows(SOURCE, flipVertical(flipHorizontal(o)))).toEqual(orientRows(SOURCE, rotateRight(rotateRight(o))))
  })
  it('the starting state and the states that come back to it are "not turned"', () => {
    expect(isNotTurned(NOT_TURNED)).toBe(true)
    expect(isNotTurned({ quarterTurns: 4, mirror: false })).toBe(true)
    expect(isNotTurned({ quarterTurns: 0, mirror: true })).toBe(false)
    expect(isNotTurned(rotateRight(NOT_TURNED))).toBe(false)
  })
  it('keeps its numbers within 0 to 3', () => {
    for (const o of all) for (const f of [rotateRight, rotateLeft, flipHorizontal, flipVertical]) expect([0, 1, 2, 3]).toContain(f(o).quarterTurns)
  })
})

import { DEFAULT_RECIPE } from './types'
import { recipesEqual, transformIsDefault } from './develop'

describe('turning in the recipe', () => {
  const turned = { ...DEFAULT_RECIPE, geometry: { ...DEFAULT_RECIPE.geometry, quarterTurns: 1 } }
  it('is a change to the transform: it is not the default, differs from an untouched photo, and mirror counts too', () => {
    expect(DEFAULT_RECIPE.geometry).toMatchObject({ quarterTurns: 0, mirror: false })
    expect(transformIsDefault(DEFAULT_RECIPE)).toBe(true)
    expect(transformIsDefault(turned)).toBe(false)
    expect(transformIsDefault({ ...DEFAULT_RECIPE, geometry: { ...DEFAULT_RECIPE.geometry, mirror: true } })).toBe(false)
    expect(recipesEqual(turned, DEFAULT_RECIPE)).toBe(false)
    expect(recipesEqual(turned, { ...DEFAULT_RECIPE, geometry: { ...DEFAULT_RECIPE.geometry, quarterTurns: 1 } })).toBe(true)
    expect(recipesEqual(turned, { ...DEFAULT_RECIPE, geometry: { ...DEFAULT_RECIPE.geometry, quarterTurns: 1, mirror: true } })).toBe(false)
  })
})
