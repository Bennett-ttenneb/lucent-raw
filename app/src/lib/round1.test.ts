import { describe, expect, it } from 'vitest'
import { parseKeywords } from '../components/Dialogs'
import { threadChoices } from '../components/Preferences'
import { nextLights } from './lights'
import { solo } from './panels'
import { moveText, nudged } from './quickdevelop'
import { DEFAULT_RECIPE } from './types'
import { straightenAngle } from './cropedit'
import { keyFor, parseKey, resetKeys, setKey } from './keys'

describe('round 1 helpers', () => {
  it('lights go on, dim, out, on', () => {
    expect([nextLights('on'), nextLights('dim'), nextLights('out')]).toEqual(['dim', 'out', 'on'])
  })
  it('keywords are split on commas, with > for a keyword inside another, and blanks dropped', () => {
    expect(parseKeywords('wedding, Places > Cape Town ,, ,>')).toEqual([['wedding'], ['Places', 'Cape Town']])
    expect(parseKeywords('')).toEqual([])
  })
  it('thread choices are the powers of two below the processors, then the processors', () => {
    expect(threadChoices(8)).toEqual([1, 2, 4, 8])
    expect(threadChoices(6)).toEqual([1, 2, 4, 6])
    expect(threadChoices(1)).toEqual([1])
    expect(threadChoices(64)).toEqual([1, 2, 4, 8, 16, 32])
  })
  it('solo leaves only the chosen panel open', () => {
    expect(solo(['A', 'B', 'C'], 'B')).toEqual({ A: false, B: true, C: false })
  })
  it('Quick Develop moves a slider by a step, stays inside its range and rounds to the digits shown', () => {
    expect(nudged(DEFAULT_RECIPE, 'exposure', 1 / 3).exposure).toBe(0.33)
    expect(nudged({ ...DEFAULT_RECIPE, exposure: 4.9 }, 'exposure', 1).exposure).toBe(5)
    expect(nudged({ ...DEFAULT_RECIPE, contrast: -95 }, 'contrast', -20).contrast).toBe(-100)
    expect(moveText('exposure', 1 / 3)).toBe('+0.33')
    expect(moveText('contrast', -5)).toBe('-5')
  })
  it('a shortcut letter can be changed, a taken or odd letter is refused, and Reset puts them back', () => {
    expect(setKey('pick', 'q')).toBeNull()
    expect(parseKey({ key: 'q' })).toEqual({ type: 'flag', value: 1 })
    expect(parseKey({ key: 'p' })).toBeNull()
    expect(setKey('reject', 'q')).toMatch(/already used/)
    expect(setKey('reject', '5')).toMatch(/one letter/)
    expect(setKey('quick', 'w')).toBeNull()
    expect(parseKey({ key: 'W', shiftKey: true })).toEqual({ type: 'target' })
    expect(keyFor('lights')).toBe('l')
    resetKeys()
    expect(parseKey({ key: 'p' })).toEqual({ type: 'flag', value: 1 })
  })
  it('the Straighten tool turns a drawn line into the angle that makes it level or upright', () => {
    expect(straightenAngle([0.1, 0.5], [0.9, 0.5], 1000, 1000)).toBe(0)
    expect(straightenAngle([0.1, 0.5], [0.9, 0.58], 1000, 1000)).toBe(5.7)
    expect(straightenAngle([0.9, 0.58], [0.1, 0.5], 1000, 1000)).toBe(5.7)
    expect(straightenAngle([0.5, 0.1], [0.5, 0.9], 1000, 1000)).toBe(0)
    expect(straightenAngle([0.5, 0.1], [0.46, 0.9], 1000, 1000)).toBe(2.9)
    expect(straightenAngle([0.1, 0.1], [0.1, 0.1], 1000, 1000)).toBeNull()
    expect(straightenAngle([0, 0], [0.005, 0.005], 1000, 1000)).toBeNull()
  })
})
