import { describe, expect, it } from 'vitest'
import { FILTER_KEYS, hasFilter } from './filters'
import type { Filters } from './types'

const base: Filters = { sort: 'capture', desc: false }

describe('is a filter on', () => {
  it('is not when only the sort order is set', () => {
    expect(hasFilter(base)).toBe(false)
    expect(hasFilter({ ...base, sort: 'rating', desc: true })).toBe(false)
  })
  it('is for every kind of filter, the metadata ones included', () => {
    const on: Partial<Filters>[] = [{ text: 'x' }, { minRating: 3 }, { flag: 'pick' }, { label: 'red' }, { edited: 'yes' }, { copies: 'no' }, { folderId: 2 }, { collectionId: 2 }, { keywordId: 2 }, { camera: 'Canon' }, { lens: 'EF' }, { minIso: 100 }, { maxIso: 800 }, { minFocal: 50 }, { maxFocal: 85 }, { minAperture: 1.8 }, { maxAperture: 8 }, { dateFrom: '2026-01-01' }, { dateTo: '2026-12-31' }]
    for (const f of on) expect(hasFilter({ ...base, ...f }), JSON.stringify(f)).toBe(true)
    // nothing was left out of the list the check goes through
    expect(new Set(on.flatMap((f) => Object.keys(f)))).toEqual(new Set(FILTER_KEYS))
  })
  it('an empty text or a zero rating is no filter', () => {
    expect(hasFilter({ ...base, text: '', minRating: 0 })).toBe(false)
  })
})
