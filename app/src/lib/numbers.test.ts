import { afterEach, describe, expect, it } from 'vitest'
import { num, parseNum, setNumberLocale } from './format'

afterEach(() => setNumberLocale(null))

describe('reading and writing numbers the way a language does', () => {
  it('English: a point is the fraction, a comma groups thousands', () => {
    setNumberLocale('en')
    expect(num(1234.5, 1)).toBe('1,234.5')
    expect(parseNum('1.5')).toBe(1.5)
    expect(parseNum('1,5')).toBe(1.5) // a comma with one digit after it is plainly not thousands
    expect(parseNum('1,234')).toBe(1234)
    expect(parseNum('1,234.5')).toBe(1234.5)
    expect(parseNum('-0.35')).toBe(-0.35)
  })
  it('German: a comma is the fraction, a point groups thousands, and both spellings of one and a half are understood', () => {
    setNumberLocale('de')
    expect(num(1234.5, 1)).toBe('1.234,5')
    expect(parseNum('1,5')).toBe(1.5)
    expect(parseNum('1.5')).toBe(1.5)
    expect(parseNum('1.234')).toBe(1234)
    expect(parseNum('1.234,5')).toBe(1234.5)
    expect(parseNum('−2,25')).toBe(-2.25)
  })
  it('French: a space groups thousands and a comma is the fraction', () => {
    setNumberLocale('fr')
    expect(parseNum('1 234,5')).toBe(1234.5)
    expect(parseNum('1\u202f234,5')).toBe(1234.5)
    expect(parseNum('0,35')).toBe(0.35)
  })
  it('text that is not a number is refused', () => {
    expect(parseNum('')).toBeNull()
    expect(parseNum('abc')).toBeNull()
    expect(parseNum('1,2,3x')).toBeNull()
  })
})
