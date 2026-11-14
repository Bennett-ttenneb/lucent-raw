import { describe, expect, it } from 'vitest'
import { SHORTCUTS } from '../components/Help'
import { parseKey } from './keys'

describe('the shortcuts the help screen lists', () => {
  const key = (k: string, extra: object = {}) => parseKey({ key: k, ...extra })

  it('every Library and everywhere shortcut does what the help says', () => {
    expect(key('d')).toEqual({ type: 'develop' })
    expect(key('g')).toEqual({ type: 'view', value: 'grid' })
    expect(key('e')).toEqual({ type: 'view', value: 'loupe' })
    expect(key('ArrowLeft')).toMatchObject({ type: 'move', dx: -1 })
    expect(key('ArrowRight')).toMatchObject({ type: 'move', dx: 1 })
    for (let n = 0; n <= 5; n++) expect(key(String(n))).toEqual({ type: 'rate', value: n })
    expect(key('p')).toEqual({ type: 'flag', value: 1 })
    expect(key('x')).toEqual({ type: 'flag', value: -1 })
    expect(key('u')).toEqual({ type: 'flag', value: 0 })
    expect([6, 7, 8, 9].map((n) => key(String(n)))).toEqual([
      { type: 'label', value: 'red' },
      { type: 'label', value: 'yellow' },
      { type: 'label', value: 'green' },
      { type: 'label', value: 'blue' },
    ])
    expect(key('b')).toEqual({ type: 'quick' })
    expect(key('B', { shiftKey: true })).toEqual({ type: 'target' })
    expect(key('Delete')).toEqual({ type: 'remove' })
    expect(key('a', { ctrlKey: true })).toEqual({ type: 'selectAll' })
    expect(key('Home')).toEqual({ type: 'edge', to: 'first' })
    expect(key('End')).toEqual({ type: 'edge', to: 'last' })
  })

  it('lists each key once in its group, with something to say about it', () => {
    for (const g of SHORTCUTS) {
      const keys = g.items.map((s) => s.keys)
      expect(new Set(keys).size).toBe(keys.length)
      for (const s of g.items) expect(s.what.length).toBeGreaterThan(3)
    }
    expect(SHORTCUTS.map((g) => g.title)).toEqual(['Everywhere', 'Library', 'Develop'])
  })

  it('names the Develop keys the app really answers to', () => {
    const develop = SHORTCUTS.find((g) => g.title === 'Develop')!.items.map((s) => s.keys)
    for (const k of ['Ctrl+Z', 'Ctrl+Shift+Z or Ctrl+Y', 'Z', String.fromCharCode(92), 'J', 'C']) expect(develop).toContain(k)
  })
})
