import { beforeEach, describe, expect, it } from 'vitest'
import { digitOf, neighbour, solo, usePanels } from './panels'

describe('panel shortcuts', () => {
  beforeEach(() => {
    localStorage.clear()
    usePanels.setState({ open: {} })
  })

  it('reads the digit keys by their place, so Shift does not change them', () => {
    expect(digitOf('Digit1')).toBe(1)
    expect(digitOf('Digit9')).toBe(9)
    expect(digitOf('Digit0')).toBe(0)
    expect(digitOf('KeyA')).toBeNull()
    expect(digitOf('Numpad1')).toBeNull()
  })

  it('solo keeps one open and closes the rest', () => {
    expect(solo(['A', 'B', 'C'], 'B')).toEqual({ A: false, B: true, C: false })
  })

  it('remembers what was opened or closed between launches', () => {
    usePanels.getState().set('Detail', true)
    usePanels.getState().setMany({ Basic: false, Masks: true })
    expect(JSON.parse(localStorage.getItem('lucent.panels')!)).toEqual({ Detail: true, Basic: false, Masks: true })
  })

  it('moves between the titles with Up, Down, Home and End and stops at the ends', () => {
    const mk = () => document.createElement('button')
    const t = [mk(), mk(), mk()]
    expect(neighbour(t, t[0], 'ArrowDown')).toBe(t[1])
    expect(neighbour(t, t[2], 'ArrowDown')).toBe(t[2])
    expect(neighbour(t, t[0], 'ArrowUp')).toBe(t[0])
    expect(neighbour(t, t[1], 'Home')).toBe(t[0])
    expect(neighbour(t, t[1], 'End')).toBe(t[2])
    expect(neighbour(t, t[1], 'x')).toBeNull()
    expect(neighbour(t, mk(), 'ArrowDown')).toBeNull()
  })
})
