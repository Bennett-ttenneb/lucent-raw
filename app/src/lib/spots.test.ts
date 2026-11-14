import { beforeEach, describe, expect, it } from 'vitest'
import { setApi } from './api'
import { DEFAULT_RECIPE, MAX_SPOTS, recipesEqual, useDevelop } from './develop'
import { createMockApi } from './mockApi'
import { DEFAULT_SPOT, MAX_SPOT_SIZE, MIN_SPOT_SIZE, fallbackSource, makeSpot, moveSpotHandle, spotHandlePositions } from './spotedit'
import { applyGroups, ALL_GROUPS } from './presets'
import type { Spot } from './types'

const spot: Spot = { id: 's1', visible: true, mode: 'heal', x: 0.4, y: 0.5, sx: 0.7, sy: 0.3, size: 0.1, feather: 0.5, opacity: 1 }

describe('moving a spot\'s circles', () => {
  it('dragging the spot takes its source along, so the patch keeps its offset', () => {
    const m = moveSpotHandle(spot, 'target', [0.4, 0.5], [0.5, 0.6], 1.5)
    expect([m.x, m.y]).toEqual([0.5, 0.6])
    expect(m.sx).toBeCloseTo(0.8)
    expect(m.sy).toBeCloseTo(0.4)
  })
  it('dragging the source moves only the source', () => {
    const m = moveSpotHandle(spot, 'source', [0.7, 0.3], [0.2, 0.9], 1.5)
    expect([m.x, m.y, m.sx]).toEqual([0.4, 0.5, 0.2])
    expect(m.sy).toBeCloseTo(0.9)
  })
  it('the size handle sets the diameter from its distance to the centre, the same in every direction', () => {
    // a square picture: a handle 0.06 to the right gives a radius of 0.06, a diameter of 0.12
    expect(moveSpotHandle(spot, 'size', [0.45, 0.5], [0.46, 0.5], 1).size).toBeCloseTo(0.12)
    expect(moveSpotHandle(spot, 'size', [0.45, 0.5], [0.4, 0.56], 1).size).toBeCloseTo(0.12)
    // a 2:1 picture: 0.06 of the width is 0.12 of the height, i.e. 0.06 of the long edge as a radius
    expect(moveSpotHandle(spot, 'size', [0.45, 0.5], [0.46, 0.5], 2).size).toBeCloseTo(0.12)
    expect(moveSpotHandle(spot, 'size', [0.45, 0.5], [0.4, 0.56], 2).size).toBeCloseTo(0.06)
  })
  it('the size stays within its limits and a circle cannot be dragged far off the picture', () => {
    expect(moveSpotHandle(spot, 'size', [0.45, 0.5], [0.4, 0.5], 1).size).toBe(MIN_SPOT_SIZE)
    expect(moveSpotHandle(spot, 'size', [0.45, 0.5], [9, 9], 1).size).toBe(MAX_SPOT_SIZE)
    const far = moveSpotHandle(spot, 'source', [0.7, 0.3], [99, -99], 1)
    expect([far.sx, far.sy]).toEqual([1.5, -0.5])
  })
  it('knows where the handles are, and the size handle is on the right edge of the circle', () => {
    const h = spotHandlePositions(spot, 1)
    expect(h.target).toEqual([0.4, 0.5])
    expect(h.source).toEqual([0.7, 0.3])
    expect(h.size[0]).toBeCloseTo(0.45)
    expect(h.size[1]).toBe(0.5)
    // on a wide picture the long edge is the width, so the radius (half of 0.1 of it) is 0.05 of the width again
    expect(spotHandlePositions(spot, 2).size[0]).toBeCloseTo(0.45)
    // on a tall picture the long edge is the height: 0.05 of the height is 0.05 * (1 / 0.5) = 0.1 of the width
    expect(spotHandlePositions(spot, 0.5).size[0]).toBeCloseTo(0.5)
  })
})

describe('making a spot', () => {
  it('uses the defaults and clamps what it is given', () => {
    const s = makeSpot('a', [0.3, 0.4], [0.6, 0.4], { ...DEFAULT_SPOT, mode: 'clone', size: 99 })
    expect(s).toMatchObject({ id: 'a', visible: true, mode: 'clone', x: 0.3, y: 0.4, sx: 0.6, sy: 0.4, size: MAX_SPOT_SIZE, opacity: 1 })
    expect(makeSpot('b', [9, 9], [-9, -9], DEFAULT_SPOT)).toMatchObject({ x: 1.5, y: 1.5, sx: -0.5, sy: -0.5 })
  })
  it('puts a fallback source beside the spot, on the side with room', () => {
    const left = fallbackSource([0.2, 0.5], 0.05, 1.5)
    expect(left[0]).toBeGreaterThan(0.2)
    expect(left[1]).toBe(0.5)
    const right = fallbackSource([0.95, 0.5], 0.05, 1.5)
    expect(right[0]).toBeLessThan(0.95)
    expect(right[0]).toBeGreaterThanOrEqual(0.03)
  })
})

describe('spots in the recipe', () => {
  it('are part of recipe equality, and presets and copies leave them alone', () => {
    const r = { ...DEFAULT_RECIPE, spots: [spot] }
    expect(recipesEqual(r, DEFAULT_RECIPE)).toBe(false)
    expect(recipesEqual(r, { ...DEFAULT_RECIPE, spots: [{ ...spot }] })).toBe(true)
    const out = applyGroups(r, { ...DEFAULT_RECIPE, exposure: 1 }, ALL_GROUPS)
    expect(out.spots).toEqual([spot])
    expect(out.spots[0]).not.toBe(spot)
  })
})

describe('spots in the store', () => {
  beforeEach(() => {
    setApi(createMockApi(5))
    useDevelop.setState({ photoId: null, recipe: DEFAULT_RECIPE, saved: DEFAULT_RECIPE, history: [], selectedSpot: null, spotTool: false, selectedMask: null, spotDefaults: DEFAULT_SPOT, error: null, version: 0 })
  })

  it('adding a spot asks the core for a source, selects the spot and is one history step', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().addSpotAt([0.3, 0.5], 1.5)
    const s = useDevelop.getState()
    expect(s.recipe.spots).toHaveLength(1)
    expect(s.recipe.spots[0]).toMatchObject({ mode: 'heal', x: 0.3, y: 0.5 })
    expect(s.recipe.spots[0].sx).toBeCloseTo(0.5) // the mock core answers "0.2 to the right" for a spot on the left
    expect(s.selectedSpot).toBe(s.recipe.spots[0].id)
    expect(s.history[0].label).toBe('Add heal spot')
    await useDevelop.getState().open(1)
    expect(useDevelop.getState().recipe.spots).toHaveLength(1) // saved
  })

  it('a new spot starts with the chosen mode and size', async () => {
    await useDevelop.getState().open(1)
    useDevelop.getState().setSpotDefaults({ mode: 'clone', size: 0.1, opacity: 0.6 })
    await useDevelop.getState().addSpotAt([0.7, 0.5], 1.5)
    expect(useDevelop.getState().recipe.spots[0]).toMatchObject({ mode: 'clone', size: 0.1, opacity: 0.6 })
    expect(useDevelop.getState().history[0].label).toBe('Add clone spot')
  })

  it('a failure to find a source still adds the spot, beside the target', async () => {
    await useDevelop.getState().open(1)
    setApi({ ...createMockApi(5), developSpotSource: async () => { throw new Error('no preview') } } as never)
    await useDevelop.getState().addSpotAt([0.3, 0.5], 1.5)
    expect(useDevelop.getState().recipe.spots).toHaveLength(1)
    expect(useDevelop.getState().recipe.spots[0].sx).toBeGreaterThan(0.3)
  })

  it('moving, hiding and deleting spots are history steps, and delete all clears them', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().addSpotAt([0.3, 0.5], 1.5)
    await useDevelop.getState().addSpotAt([0.6, 0.4], 1.5)
    const [a, b] = useDevelop.getState().recipe.spots
    useDevelop.getState().liveSpot(a.id, { x: 0.35 })
    await useDevelop.getState().commitSpots('Spot 1: move')
    expect(useDevelop.getState().recipe.spots[0].x).toBe(0.35)
    expect(useDevelop.getState().history[0].label).toBe('Spot 1: move')
    await useDevelop.getState().deleteSpot(b.id)
    expect(useDevelop.getState().recipe.spots).toHaveLength(1)
    expect(useDevelop.getState().history[0].label).toBe('Delete spot 2')
    await useDevelop.getState().addSpotAt([0.1, 0.1], 1.5)
    await useDevelop.getState().deleteAllSpots()
    expect(useDevelop.getState().recipe.spots).toEqual([])
    expect(useDevelop.getState().selectedSpot).toBeNull()
    expect(useDevelop.getState().history[0].label).toBe('Delete all spots')
  })

  it('there is a limit on spots, and it says so', async () => {
    await useDevelop.getState().open(1)
    for (let i = 0; i < MAX_SPOTS; i++) await useDevelop.getState().addSpotAt([0.1 + (i % 10) * 0.08, 0.1 + Math.floor(i / 10) * 0.15], 1.5)
    expect(useDevelop.getState().recipe.spots).toHaveLength(MAX_SPOTS)
    await useDevelop.getState().addSpotAt([0.5, 0.5], 1.5)
    expect(useDevelop.getState().recipe.spots).toHaveLength(MAX_SPOTS)
    expect(useDevelop.getState().error).toMatch(/at most/)
  })

  it('the spot tool and masks do not both hold the picture', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().addMask('linear')
    expect(useDevelop.getState().selectedMask).not.toBeNull()
    useDevelop.getState().setSpotTool(true)
    expect(useDevelop.getState().selectedMask).toBeNull()
    expect(useDevelop.getState().spotTool).toBe(true)
    await useDevelop.getState().addMask('radial') // picking a mask turns the tool off
    expect(useDevelop.getState().spotTool).toBe(false)
    expect(useDevelop.getState().selectedSpot).toBeNull()
    await useDevelop.getState().addSpotAt([0.3, 0.3], 1.5)
    expect(useDevelop.getState().selectedMask).toBeNull()
  })

  it('a click while the photo is still loading is ignored, and another photo starts with no spot selected', async () => {
    const opening = useDevelop.getState().open(1)
    const adding = useDevelop.getState().addSpotAt([0.3, 0.5], 1.5)
    await Promise.all([opening, adding])
    expect(useDevelop.getState().recipe.spots).toEqual([])
    await useDevelop.getState().addSpotAt([0.3, 0.5], 1.5)
    await useDevelop.getState().open(2)
    expect(useDevelop.getState().selectedSpot).toBeNull()
    expect(useDevelop.getState().spotTool).toBe(false)
    expect(useDevelop.getState().recipe.spots).toEqual([])
  })
})
