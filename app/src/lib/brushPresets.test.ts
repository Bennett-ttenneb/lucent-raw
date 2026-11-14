import { beforeEach, describe, expect, it } from 'vitest'
import { BUILTIN_BRUSHES, forgetBrush, loadBrushes, saveBrush } from './brushPresets'

describe('brush presets', () => {
  beforeEach(() => localStorage.clear())
  it('four come with the program, in range', () => {
    expect(BUILTIN_BRUSHES.map((b) => b.name)).toEqual(['Soft', 'Hard edge', 'Detail', 'Broad'])
    for (const b of BUILTIN_BRUSHES) expect(b.size >= 0.01 && b.size <= 0.5 && b.feather >= 0 && b.feather <= 1 && b.flow >= 0.01 && b.flow <= 1).toBe(true)
  })
  it('keeps your own, tidied and in order, replaces a name used before, and forgets', () => {
    expect('list' in saveBrush('  Skin   touch ', { size: 0.9, feather: -1, flow: 0 })).toBe(true)
    expect(loadBrushes()).toEqual([{ name: 'Skin touch', size: 0.5, feather: 0, flow: 0.01 }])
    saveBrush('a', { size: 0.1, feather: 0.2, flow: 0.3 })
    saveBrush('SKIN TOUCH', { size: 0.1, feather: 0.2, flow: 0.3 })
    expect(loadBrushes().map((b) => b.name)).toEqual(['a', 'SKIN TOUCH'])
    expect(forgetBrush('a').map((b) => b.name)).toEqual(['SKIN TOUCH'])
  })
  it('refuses an empty name, a built-in name and too many', () => {
    expect(saveBrush('  ', { size: 0.1, feather: 0, flow: 1 })).toEqual({ error: 'Give the brush a name.' })
    expect('error' in saveBrush('soft', { size: 0.1, feather: 0, flow: 1 })).toBe(true)
    for (let i = 0; i < 20; i++) saveBrush(`b${i}`, { size: 0.1, feather: 0, flow: 1 })
    expect('error' in saveBrush('one more', { size: 0.1, feather: 0, flow: 1 })).toBe(true)
  })
  it('a bad stored list is ignored', () => {
    localStorage.setItem('lucent.brushPresets', '{"not":"a list"}')
    expect(loadBrushes()).toEqual([])
    localStorage.setItem('lucent.brushPresets', JSON.stringify([{ name: 'ok', size: 'x' }, { size: 1 }, 5]))
    expect(loadBrushes()).toEqual([{ name: 'ok', size: 0.08, feather: 0.5, flow: 1 }])
  })
})
