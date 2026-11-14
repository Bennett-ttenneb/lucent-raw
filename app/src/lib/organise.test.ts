import { beforeEach, describe, expect, it } from 'vitest'
import { api, setApi } from './api'
import { parseKey } from './keys'
import { cleanCollectionName, fieldView, parseKeywords } from './logic'
import { createMockApi } from './mockApi'
import { DEFAULT_FILTERS, refreshCollections, useStore } from './store'

describe('parseKeywords', () => {
  it('splits, trims and removes duplicates ignoring case', () => {
    expect(parseKeywords('beach, Sunset > orange , BEACH;  ')).toEqual([['beach'], ['Sunset', 'orange']])
  })
  it('ignores empties and caps depth and length', () => {
    expect(parseKeywords(' , ;; > ')).toEqual([])
    expect(parseKeywords('a>b>c>d')).toEqual([['a', 'b', 'c']])
    expect(parseKeywords('x'.repeat(300))[0][0]).toHaveLength(100)
  })
  it('keeps accents, emoji and inner spacing sensible', () => {
    expect(parseKeywords('café   crème, 😀')).toEqual([['café crème'], ['😀']])
  })
  it('treats the same word under different parents as different', () => {
    expect(parseKeywords('a > x, b > x')).toEqual([['a', 'x'], ['b', 'x']])
  })
})

describe('fieldView and names', () => {
  it('reports shared, empty and mixed values', () => {
    expect(fieldView([])).toEqual({ value: '', mixed: false })
    expect(fieldView(['same'])).toEqual({ value: 'same', mixed: false })
    expect(fieldView(['a', 'b'])).toEqual({ value: '', mixed: true })
  })
  it('cleans collection names', () => {
    expect(cleanCollectionName('  Best   of ')).toBe('Best of')
    expect(cleanCollectionName('   ')).toBeNull()
    expect(cleanCollectionName('x'.repeat(101))).toBeNull()
  })
})

describe('new shortcuts', () => {
  it('B toggles the quick collection, Shift+B uses the target, Delete removes', () => {
    expect(parseKey({ key: 'b' })).toEqual({ type: 'quick' })
    expect(parseKey({ key: 'B', shiftKey: true })).toEqual({ type: 'target' })
    expect(parseKey({ key: 'Delete' })).toEqual({ type: 'remove' })
    expect(parseKey({ key: 'Backspace' })).toEqual({ type: 'remove' })
    expect(parseKey({ key: 'b', ctrlKey: true })).toBeNull()
  })
})

describe('organise on the mock core', () => {
  beforeEach(async () => {
    setApi(createMockApi(450))
    useStore.setState({ filters: DEFAULT_FILTERS, pages: {}, total: 0, active: -1, anchor: -1, selected: new Set(), gen: 0, view: 'grid', cols: 6, removeOpen: false })
    await useStore.getState().reload()
  })

  it('select all covers every photo, not just the pages loaded', async () => {
    expect(Object.keys(useStore.getState().pages)).toEqual(['0'])
    useStore.getState().perform({ type: 'selectAll' })
    await new Promise((r) => setTimeout(r, 20))
    expect(useStore.getState().selected.size).toBe(450)
  })

  it('B puts the selection in the Quick Collection and again takes it out', async () => {
    const s = useStore.getState()
    s.clickIndex(0, 'single')
    s.clickIndex(2, 'range')
    await useStore.getState().quick()
    expect(useStore.getState().collections.find((c) => c.kind === 'quick')!.count).toBe(3)
    await useStore.getState().quick()
    expect(useStore.getState().collections.find((c) => c.kind === 'quick')!.count).toBe(0)
  })

  it('viewing a collection shows only its photos, and sources are exclusive', async () => {
    const id = await api().collectionCreate('Picks')
    const ids = (await api().photoQuery({ ...DEFAULT_FILTERS, offset: 0, limit: 4 })).rows.map((r) => r.id)
    await api().collectionAdd(id, ids)
    await useStore.getState().setSource({ collectionId: id })
    expect(useStore.getState().total).toBe(4)
    await useStore.getState().setSource({ folderId: 1 })
    expect(useStore.getState().filters.collectionId).toBeUndefined()
    expect(useStore.getState().total).toBeGreaterThan(4)
  })

  it('keyword filter includes sub-keywords and counts them once', async () => {
    const [a, b] = (await api().photoQuery({ ...DEFAULT_FILTERS, offset: 0, limit: 2 })).rows.map((r) => r.id)
    await api().keywordAdd([a, b], ['Places', 'Beach'])
    await api().keywordAdd([a], ['Places'])
    await refreshCollections()
    const places = useStore.getState().keywords.find((k) => k.name === 'Places')!
    expect(places.count).toBe(2)
    await useStore.getState().setSource({ keywordId: places.id })
    expect(useStore.getState().total).toBe(2)
  })

  it('metadata is reported as mixed until every photo matches', async () => {
    const [a, b] = (await api().photoQuery({ ...DEFAULT_FILTERS, offset: 0, limit: 2 })).rows.map((r) => r.id)
    await api().metadataSet([a], { title: 'One' })
    expect((await api().metadataGet([a, b])).title).toHaveLength(2)
    await api().metadataSet([a, b], { title: 'One' })
    expect((await api().metadataGet([a, b])).title).toEqual(['One'])
    await expect(api().metadataSet([a], { caption: 'x'.repeat(2001) })).rejects.toThrow(/too long/)
  })

  it('removing from the catalog drops the photos and their links', async () => {
    const s = useStore.getState()
    s.clickIndex(0, 'single')
    s.clickIndex(1, 'range')
    await useStore.getState().quick()
    await useStore.getState().confirmRemove()
    expect(useStore.getState().total).toBe(448)
    expect(useStore.getState().collections.find((c) => c.kind === 'quick')!.count).toBe(0)
  })

  it('refuses to rename or delete the Quick Collection', async () => {
    await expect(api().collectionRename(1, 'Nope')).rejects.toThrow(/Quick/)
    await expect(api().collectionDelete(1)).rejects.toThrow(/Quick/)
  })
})
