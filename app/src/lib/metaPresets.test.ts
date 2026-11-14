import { beforeEach, describe, expect, it } from 'vitest'
import { load, only, remove, save } from './metaPresets'

describe('detail presets', () => {
  beforeEach(() => localStorage.clear())

  it('keeps only the known fields that have text', () => {
    expect(only({ creator: 'Sam', city: '', title: 5, nonsense: 'x', country: 'Chile' })).toEqual({ creator: 'Sam', country: 'Chile' })
    expect(only({ caption: 'x'.repeat(3000) }).caption).toHaveLength(2000)
  })

  it('refuses an empty name or nothing to keep, replaces the same name whatever its case, sorts, and removes', () => {
    expect(save('  ', { creator: 'Sam' })).toEqual({ error: 'Give the preset a name.' })
    expect('error' in save('Empty', { title: '' })).toBe(true)
    save('Wedding', { creator: 'Sam', copyright: '2026 Sam' })
    save('Archive', { source: 'Card 1' })
    const r = save('wedding', { creator: 'Sam Two' })
    if ('error' in r) throw new Error(r.error)
    expect(r.list.map((p) => p.name)).toEqual(['Archive', 'wedding'])
    expect(load()[1].values).toEqual({ creator: 'Sam Two' })
    expect(remove('Archive').map((p) => p.name)).toEqual(['wedding'])
  })

  it('survives a damaged store', () => {
    localStorage.setItem('lucent.metaPresets', 'not json')
    expect(load()).toEqual([])
    localStorage.setItem('lucent.metaPresets', JSON.stringify([{ name: 'ok', values: { creator: 'A', bad: 1 } }, 7, { name: 3 }]))
    expect(load()).toEqual([{ name: 'ok', values: { creator: 'A' } }])
  })
})
