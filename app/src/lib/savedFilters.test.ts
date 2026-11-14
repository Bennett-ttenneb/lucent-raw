import { beforeEach, describe, expect, it } from 'vitest'
import { cleared, load, partOf, remove, save, tabFor } from './savedFilters'

describe('saved filters', () => {
  beforeEach(() => localStorage.clear())

  it('keeps only what the filter bar is set to, not where you are looking or how it is sorted', () => {
    expect(partOf({ sort: 'capture', desc: false, minRating: 3, flag: 'pick', folderId: 4, collectionId: 2, keywordId: 9 })).toEqual({ minRating: 3, flag: 'pick' })
    expect(partOf({ sort: 'name', desc: true })).toEqual({})
    expect(partOf({ sort: 'capture', desc: false, minRating: 0, text: '' })).toEqual({})
  })

  it('chooses the tab that shows the filter', () => {
    expect(tabFor({ text: 'beach' })).toBe('text')
    expect(tabFor({ minRating: 4 })).toBe('attribute')
    expect(tabFor({ minRating: 4, camera: 'X100V' })).toBe('metadata')
    expect(tabFor({ dateFrom: '2026-01-01' })).toBe('metadata')
  })

  it('saves under a name, replaces the same name whatever its case, sorts by name and removes', () => {
    expect(save('  ', { minRating: 3 })).toEqual({ error: 'Give it a name.' })
    expect('error' in save('Empty', {})).toBe(true)
    expect(load()).toEqual([])
    save('Fives', { minRating: 5 })
    save('A picks', { flag: 'pick' })
    const r = save('fives', { minRating: 4, flag: 'pick' })
    if ('error' in r) throw new Error(r.error)
    expect(r.list.map((s) => s.name)).toEqual(['A picks', 'fives'])
    expect(load()[1].filter).toEqual({ minRating: 4, flag: 'pick' })
    expect(remove('A picks').map((s) => s.name)).toEqual(['fives'])
  })

  it('clears every part so a saved filter never leaves part of the old one behind', () => {
    const c = cleared()
    expect(Object.keys(c)).toContain('camera')
    expect(Object.values(c).every((v) => v === undefined)).toBe(true)
  })

  it('survives a damaged store', () => {
    localStorage.setItem('lucent.savedFilters', '{not json')
    expect(load()).toEqual([])
    localStorage.setItem('lucent.savedFilters', JSON.stringify([{ name: 'ok', filter: { minRating: 2 } }, 5, { name: 3 }]))
    expect(load().map((s) => s.name)).toEqual(['ok'])
  })
})
