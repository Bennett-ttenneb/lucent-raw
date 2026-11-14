import { describe, expect, it } from 'vitest'
import { bytesText } from './format'
import { backupDue } from './prefs'

describe('backup reminder', () => {
  const now = new Date('2026-10-18T12:00:00').getTime()
  it('is due when there was never a backup, or the last one is older than the choice', () => {
    expect(backupDue(null, 30, now)).toBe(true)
    expect(backupDue('2026-10-10 09:00', 7, now)).toBe(true)
    expect(backupDue('2026-10-10 09:00', 30, now)).toBe(false)
    expect(backupDue('2026-06-01 09:00', 90, now)).toBe(true)
  })
  it('never nags when switched off, and a time it cannot read counts as due', () => {
    expect(backupDue(null, 0, now)).toBe(false)
    expect(backupDue('2020-01-01 00:00', 0, now)).toBe(false)
    expect(backupDue('not a time', 30, now)).toBe(true)
  })
})

describe('sizes in words', () => {
  it('uses bytes, KB, MB and GB', () => {
    expect(bytesText(0)).toBe('0 bytes')
    expect(bytesText(999)).toBe('999 bytes')
    expect(bytesText(12_000)).toMatch(/^12 KB$/)
    expect(bytesText(4_300_000)).toMatch(/^4[.,]3 MB$/)
    expect(bytesText(320_000_000)).toMatch(/^320 MB$/)
    expect(bytesText(1_930_000_000)).toMatch(/^1[.,]9 GB$/)
  })
})
