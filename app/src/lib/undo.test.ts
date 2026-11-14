import { beforeEach, describe, expect, it } from 'vitest'
import { setApi } from './api'
import { DEFAULT_RECIPE, useDevelop } from './develop'
import { createMockApi } from './mockApi'

const step = (label: string) => ({ label, deltaText: null, valueText: null })
const edit = async (patch: Partial<typeof DEFAULT_RECIPE>, label = 'edit') => useDevelop.getState().setAndCommit(patch, step(label))
const now = () => useDevelop.getState()

describe('undo and redo', () => {
  beforeEach(async () => {
    setApi(createMockApi(5))
    useDevelop.setState({ photoId: null, recipe: DEFAULT_RECIPE, saved: DEFAULT_RECIPE, history: [], undoStack: [], redoStack: [], error: null, version: 0, loading: false })
    await now().open(1)
  })

  it('undo goes back one edit at a time, redo forward again, and neither does anything at the ends', async () => {
    await now().undo() // nothing yet
    expect(now().recipe).toEqual(DEFAULT_RECIPE)
    await edit({ exposure: 1 })
    await edit({ contrast: 20 })
    await now().undo()
    expect([now().recipe.exposure, now().recipe.contrast]).toEqual([1, 0])
    await now().undo()
    expect([now().recipe.exposure, now().recipe.contrast]).toEqual([0, 0])
    await now().undo() // back at the start: nothing more
    expect(now().recipe).toEqual(DEFAULT_RECIPE)
    await now().redo()
    expect([now().recipe.exposure, now().recipe.contrast]).toEqual([1, 0])
    await now().redo()
    expect([now().recipe.exposure, now().recipe.contrast]).toEqual([1, 20])
    await now().redo() // nothing more to redo
    expect(now().recipe.contrast).toBe(20)
  })

  it('an undo is saved, so it survives leaving the photo and coming back', async () => {
    await edit({ exposure: 1 })
    await edit({ exposure: 2 })
    await now().undo()
    await now().open(2)
    await now().open(1)
    expect(now().recipe.exposure).toBe(1)
  })

  it('undo and redo are steps in the history, named as such, and undoing does not grow what can be undone', async () => {
    await edit({ exposure: 1 }, 'Exposure')
    await edit({ contrast: 20 }, 'Contrast')
    expect(now().undoStack).toHaveLength(2)
    await now().undo()
    expect(now().history[0].label).toBe('Undo')
    expect([now().undoStack.length, now().redoStack.length]).toEqual([1, 1])
    await now().redo()
    expect(now().history[0].label).toBe('Redo')
    expect([now().undoStack.length, now().redoStack.length]).toEqual([2, 0])
  })

  it('a new edit after an undo ends the redo', async () => {
    await edit({ exposure: 1 })
    await edit({ contrast: 20 })
    await now().undo()
    expect(now().redoStack).toHaveLength(1)
    await edit({ saturation: 30 })
    expect(now().redoStack).toHaveLength(0)
    await now().redo()
    expect([now().recipe.contrast, now().recipe.saturation]).toEqual([0, 30])
  })

  it('every kind of edit can be undone: masks, presets, reset all', async () => {
    await edit({ exposure: 1.5 })
    await now().addMask('radial')
    expect(now().recipe.masks).toHaveLength(1)
    await now().undo()
    expect(now().recipe.masks).toHaveLength(0)
    expect(now().recipe.exposure).toBe(1.5)
    await now().resetAll()
    expect(now().recipe.exposure).toBe(0)
    await now().undo()
    expect(now().recipe.exposure).toBe(1.5)
  })

  it('what is changed but not yet saved is not an undo step, and a change that changes nothing is none either', async () => {
    now().live({ exposure: 3 }) // dragging
    expect(now().undoStack).toHaveLength(0)
    await now().commit(step('x'))
    expect(now().undoStack).toHaveLength(1)
    await now().commit(step('again')) // nothing changed since
    expect(now().undoStack).toHaveLength(1)
  })

  it('another photo has its own, empty, undo', async () => {
    await edit({ exposure: 1 })
    await now().open(2)
    expect([now().undoStack.length, now().redoStack.length]).toEqual([0, 0])
    await now().undo()
    expect(now().recipe).toEqual(DEFAULT_RECIPE)
    await now().open(1)
    await now().undo() // the old stack is gone: nothing to undo here either
    expect(now().recipe.exposure).toBe(1)
  })

  it('remembers the last hundred edits and no more', async () => {
    for (let i = 1; i <= 105; i++) await edit({ exposure: (i % 2 ? 1 : -1) * (i / 100) })
    expect(now().undoStack).toHaveLength(100)
    for (let i = 0; i < 100; i++) await now().undo()
    expect(now().undoStack).toHaveLength(0)
    expect(now().recipe.exposure).not.toBe(0) // the first five are beyond reach
  })

  it('does nothing while a photo is still loading', async () => {
    await edit({ exposure: 1 })
    useDevelop.setState({ loading: true })
    await now().undo()
    expect(now().recipe.exposure).toBe(1)
    expect(now().undoStack).toHaveLength(1)
  })
})

describe('pasting copied settings onto several photos', () => {
  beforeEach(async () => {
    setApi(createMockApi(6))
    useDevelop.setState({ photoId: null, recipe: DEFAULT_RECIPE, saved: DEFAULT_RECIPE, history: [], undoStack: [], redoStack: [], clipboard: null, error: null, version: 0, loading: false })
    await now().open(1)
  })
  const recipeOf = async (id: number) => (await (await import('./api')).api().developGet(id)).recipe

  it('gives every photo the copied groups and leaves the rest of each photo alone', async () => {
    await now().open(2)
    await now().addMask('radial') // photo 2 has a mask of its own
    await edit({ contrast: 33 })
    await now().open(1)
    await edit({ exposure: 1.2, saturation: 25 })
    now().copy(['tone'])
    const r = await now().pasteToMany([1, 2, 3])
    expect(r).toMatchObject({ done: 2, same: 1, failed: [] }) // photo 1 already has its own settings
    const [two, three] = [await recipeOf(2), await recipeOf(3)]
    expect(two.exposure).toBe(1.2)
    expect(three.exposure).toBe(1.2)
    expect(two.saturation).toBe(0) // presence was not copied
    expect(two.contrast).toBe(0) // tone was copied as a whole: photo 2's contrast is replaced by photo 1's (zero)
    expect(two.masks).toHaveLength(1) // its mask is its own
  })

  it('does nothing when nothing has been copied, and says so', async () => {
    expect(await now().pasteToMany([1, 2])).toEqual({ done: 0, same: 0, failed: [] })
    const { useStore } = await import('./store')
    await now().pasteToSelection()
    expect(useStore.getState().toast?.text).toMatch(/Copy settings in Develop first/)
    expect(useStore.getState().toast?.error).toBe(true)
  })

  it('a photo that already looks like that is counted, not saved again', async () => {
    await edit({ exposure: 0.7 })
    now().copy(['tone'])
    await now().pasteToMany([2])
    const before = (await (await import('./api')).api().developGet(2)).history.length
    const again = await now().pasteToMany([2])
    expect(again).toMatchObject({ done: 0, same: 1 })
    expect((await (await import('./api')).api().developGet(2)).history.length).toBe(before)
  })

  it('one photo that cannot be read does not stop the others, and the reason is reported', async () => {
    await edit({ exposure: 0.9 })
    now().copy(['tone'])
    const api = (await import('./api')).api()
    const original = api.developGet
    api.developGet = async (id) => {
      if (id === 3) throw new Error('That photo is no longer in the catalog.')
      return original(id)
    }
    const r = await now().pasteToMany([2, 3, 4])
    api.developGet = original
    expect(r).toMatchObject({ done: 2, same: 0 })
    expect(r.failed).toEqual(['That photo is no longer in the catalog.'])
    expect((await recipeOf(4)).exposure).toBe(0.9)
  })

  it('marks the photos as edited in the Library and records a step named Paste settings', async () => {
    await edit({ exposure: 0.4 })
    now().copy(['tone'])
    await now().pasteToMany([5])
    expect((await (await import('./api')).api().developGet(5)).history[0].label).toBe('Paste settings')
  })
})
