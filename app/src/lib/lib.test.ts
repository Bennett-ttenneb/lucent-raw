import { beforeEach, describe, expect, it } from 'vitest'
import { exposureLine, shutter } from './format'
import { nextRating, parseKey } from './keys'
import { createMockApi } from './mockApi'
import { setApi } from './api'
import { PAGE, useStore, DEFAULT_FILTERS } from './store'

describe('keys', () => {
  it('maps rating, flag, label and view keys', () => {
    expect(parseKey({ key: '4' })).toEqual({ type: 'rate', value: 4 })
    expect(parseKey({ key: '0' })).toEqual({ type: 'rate', value: 0 })
    expect(parseKey({ key: 'p' })).toEqual({ type: 'flag', value: 1 })
    expect(parseKey({ key: 'X' })).toEqual({ type: 'flag', value: -1 })
    expect(parseKey({ key: '7' })).toEqual({ type: 'label', value: 'yellow' })
    expect(parseKey({ key: 'e' })).toEqual({ type: 'view', value: 'loupe' })
    expect(parseKey({ key: 'ArrowDown' })).toEqual({ type: 'move', dx: 0, dy: 1 })
  })
  it('ignores unknown keys and Alt combos, handles select all', () => {
    expect(parseKey({ key: 'q' })).toBeNull()
    expect(parseKey({ key: '3', altKey: true })).toBeNull()
    expect(parseKey({ key: 'a', ctrlKey: true })).toEqual({ type: 'selectAll' })
    expect(parseKey({ key: '3', ctrlKey: true })).toBeNull()
  })
  it('pressing the current rating clears it', () => {
    expect(nextRating(3, 3)).toBe(0)
    expect(nextRating(3, 4)).toBe(4)
  })
})

describe('format', () => {
  it('formats shutter speeds', () => {
    expect(shutter(1 / 160)).toBe('1/160 s')
    expect(shutter(2)).toBe('2 s')
    expect(shutter(null)).toBe('')
  })
  it('skips missing exposure parts instead of printing null', () => {
    const line = exposureLine({ shutterS: null, aperture: null, iso: 800, focalMm: null })
    expect(line).toBe('ISO 800')
    expect(line).not.toMatch(/null|undefined|NaN/)
  })
})

describe('store with mock core', () => {
  beforeEach(async () => {
    setApi(createMockApi(450))
    useStore.setState({ filters: DEFAULT_FILTERS, pages: {}, total: 0, active: -1, anchor: -1, selected: new Set(), gen: 0, view: 'grid', cols: 6 })
    await useStore.getState().reload()
  })

  it('loads the first page and pulls others on demand', async () => {
    const s = useStore.getState()
    expect(s.total).toBe(450)
    expect(s.photoAt(0)).toBeDefined()
    expect(s.photoAt(PAGE + 5)).toBeUndefined()
    await s.ensurePage(1)
    expect(useStore.getState().photoAt(PAGE + 5)).toBeDefined()
  })

  it('rates the active photo and toggles off on the same key', async () => {
    const s = useStore.getState()
    s.clickIndex(2, 'single')
    await s.rate(4)
    expect(useStore.getState().photoAt(2)!.rating).toBe(4)
    await useStore.getState().rate(4)
    expect(useStore.getState().photoAt(2)!.rating).toBe(0)
  })

  it('applies marks to the whole selection', async () => {
    const s = useStore.getState()
    s.clickIndex(0, 'single')
    s.clickIndex(3, 'range')
    expect(useStore.getState().selected.size).toBe(4)
    await useStore.getState().flag(1)
    for (let i = 0; i < 4; i++) expect(useStore.getState().photoAt(i)!.flag).toBe(1)
    expect(useStore.getState().photoAt(4)!.flag).toBe(0)
  })

  it('filters, resets the page cache and keeps active in range', async () => {
    const s = useStore.getState()
    s.clickIndex(400, 'single')
    await useStore.getState().setFilters({ minRating: 3 })
    const after = useStore.getState()
    expect(after.total).toBeGreaterThan(0)
    expect(after.total).toBeLessThan(450)
    expect(after.active).toBeLessThan(after.total)
    expect(after.photoAt(0)!.rating).toBeGreaterThanOrEqual(3)
  })

  it('moves by a row in the grid and by one in the loupe, clamped at the ends', () => {
    const s = useStore.getState()
    s.clickIndex(0, 'single')
    s.perform({ type: 'move', dx: 0, dy: 1 })
    expect(useStore.getState().active).toBe(6)
    s.perform({ type: 'move', dx: -1, dy: 0 })
    s.perform({ type: 'move', dx: -1, dy: 0 })
    expect(useStore.getState().active).toBe(4)
    useStore.setState({ view: 'loupe' })
    s.perform({ type: 'move', dx: 1, dy: 0 })
    expect(useStore.getState().active).toBe(5)
    s.perform({ type: 'edge', to: 'first' })
    s.perform({ type: 'move', dx: -1, dy: 0 })
    expect(useStore.getState().active).toBe(0)
  })

  it('imports through the mock and shows the new photos', async () => {
    const r = await (await import('./api')).api().importRun('C:/Demo/Card', 'add', null)
    expect(r.added).toBe(15)
    expect(r.unsupportedPreviews).toBe(3)
    await useStore.getState().reload()
    expect(useStore.getState().total).toBe(465)
    await expect((await import('./api')).api().importRun('C:/x', 'copy', null)).rejects.toThrow(/destination/i)
  })

  it('lists the photos of a folder and imports only the ones asked for', async () => {
    const api = (await import('./api')).api()
    const list = await api.importList('C:/Demo/Card')
    expect(list).toHaveLength(15)
    expect(list.filter((i) => i.raw)).toHaveLength(3)
    expect(list.find((i) => i.folder === 'Day 2')?.path).toContain('/Day 2/')
    await expect(api.importList('C:/Missing')).rejects.toThrow(/does not exist/)
    const before = useStore.getState().total
    const r = await api.importRun('C:/Demo/Card', 'add', null, [list[0].path, list[13].path])
    expect([r.added, r.unsupportedPreviews]).toEqual([2, 1])
    await useStore.getState().reload()
    expect(useStore.getState().total).toBe(before + 2)
    await expect(api.importRun('C:/Demo/Card', 'add', null, [])).rejects.toThrow(/None of the chosen/)
    expect(api.importThumbUrl(list[0].path)).toMatch(/^data:image\/svg/)
  })
})

describe('the metadata filters in the mock', () => {
  it('offers the cameras and lenses with counts and the ranges, and filters by them', async () => {
    const api = (await import('./api')).api()
    const v = await api.metadataValues()
    expect(v.cameras.map((c) => c.name)).toEqual(['Canon EOS 800D', 'Nikon Z6'])
    expect(v.cameras.reduce((n, c) => n + c.count, 0)).toBeGreaterThan(0)
    expect(v.iso).toEqual([100, 1600])
    expect(v.focal).toEqual([24, 70])
    expect(v.aperture![0]).toBe(1.8)
    expect(v.days).not.toBeNull()
    const q = { sort: 'name' as const, desc: false, offset: 0, limit: 500 }
    const all = (await api.photoQuery(q)).total
    const canon = (await api.photoQuery({ ...q, camera: 'Canon EOS 800D' })).total
    const nikon = (await api.photoQuery({ ...q, camera: 'Nikon Z6' })).total
    expect(canon + nikon).toBe(all)
    expect((await api.photoQuery({ ...q, minIso: 800 })).rows.every((r) => (r.iso ?? 0) >= 800)).toBe(true)
    expect((await api.photoQuery({ ...q, minIso: 5000 })).total).toBe(0)
    expect((await api.photoQuery({ ...q, dateFrom: '2099-01-01' })).total).toBe(0)
    expect((await api.photoQuery({ ...q, dateFrom: 'not a date' })).total).toBe(all) // ignored
    expect((await api.photoQuery({ ...q, camera: 'Canon EOS 800D', minIso: 800 })).total).toBeLessThan(canon)
  })
})
