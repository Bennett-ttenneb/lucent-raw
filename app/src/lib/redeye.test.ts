import { beforeEach, describe, expect, it } from 'vitest'
import { setApi } from './api'
import { DEFAULT_RECIPE, recipesEqual, useDevelop } from './develop'
import { createMockApi } from './mockApi'
import { applyGroups, ALL_GROUPS } from './presets'
import { DEFAULT_RED_EYE, MAX_RED_EYES, MAX_RED_EYE_SIZE, MIN_RED_EYE_SIZE, makeRedEye, moveRedEyeHandle, redEyeHandlePositions } from './redeyeedit'
import type { RedEye } from './types'

const eye: RedEye = { id: 'r1', x: 0.4, y: 0.5, size: 0.1, darken: 0.5 }

describe('moving a red-eye circle', () => {
  it('the centre handle moves it, and it cannot be dragged far off the picture', () => {
    const m = moveRedEyeHandle(eye, 'centre', [0.4, 0.5], [0.5, 0.6], 1.5)
    expect([m.x, m.y].map((v) => Number(v.toFixed(6)))).toEqual([0.5, 0.6])
    const far = moveRedEyeHandle(eye, 'centre', [0.4, 0.5], [99, -99], 1.5)
    expect([far.x, far.y]).toEqual([1.5, -0.5])
  })
  it('the size handle sets the diameter from its distance to the centre, the same in every direction', () => {
    expect(moveRedEyeHandle(eye, 'size', [0.45, 0.5], [0.46, 0.5], 1).size).toBeCloseTo(0.12)
    expect(moveRedEyeHandle(eye, 'size', [0.45, 0.5], [0.4, 0.56], 1).size).toBeCloseTo(0.12)
    expect(moveRedEyeHandle(eye, 'size', [0.45, 0.5], [0.46, 0.5], 2).size).toBeCloseTo(0.12) // 2:1 picture: width counts double
    expect(moveRedEyeHandle(eye, 'size', [0.45, 0.5], [0.4, 0.56], 2).size).toBeCloseTo(0.06)
  })
  it('the size stays within its limits', () => {
    expect(moveRedEyeHandle(eye, 'size', [0.45, 0.5], [0.4, 0.5], 1).size).toBe(MIN_RED_EYE_SIZE)
    expect(moveRedEyeHandle(eye, 'size', [0.45, 0.5], [9, 9], 1).size).toBe(MAX_RED_EYE_SIZE)
  })
  it('the size handle sits on the right edge of the circle', () => {
    const h = redEyeHandlePositions(eye, 1)
    expect(h.centre).toEqual([0.4, 0.5])
    expect(h.size[0]).toBeCloseTo(0.45)
    // the diameter is 0.1 of the long edge: half of it, as a share of the width, is 0.05 on a square picture and on a 2:1 one alike
    expect(redEyeHandlePositions(eye, 2).size[0]).toBeCloseTo(0.45)
  })
  it('a new circle starts from the defaults, clamped', () => {
    expect(makeRedEye('x', [0.2, 0.3], DEFAULT_RED_EYE)).toEqual({ id: 'x', x: 0.2, y: 0.3, size: DEFAULT_RED_EYE.size, darken: DEFAULT_RED_EYE.darken })
    expect(makeRedEye('x', [9, -9], { size: 5, darken: -1 })).toMatchObject({ x: 1.5, y: -0.5, size: MAX_RED_EYE_SIZE, darken: 0 })
  })
})

describe('red eye in the store', () => {
  beforeEach(() => {
    setApi(createMockApi(5))
    useDevelop.setState({ photoId: null, recipe: DEFAULT_RECIPE, saved: DEFAULT_RECIPE, history: [], selectedRedEye: null, redEyeTool: false, selectedSpot: null, spotTool: false, selectedMask: null, redEyeDefaults: DEFAULT_RED_EYE, error: null, version: 0 })
  })

  it('adding a circle selects it and is one history step, and it comes back after leaving the photo', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().addRedEyeAt([0.3, 0.5])
    const s = useDevelop.getState()
    expect(s.recipe.redEyes).toHaveLength(1)
    expect(s.recipe.redEyes[0]).toMatchObject({ x: 0.3, y: 0.5, size: DEFAULT_RED_EYE.size, darken: DEFAULT_RED_EYE.darken })
    expect(s.selectedRedEye).toBe(s.recipe.redEyes[0].id)
    expect(s.history[0].label).toBe('Add red-eye fix')
    await useDevelop.getState().open(1)
    expect(useDevelop.getState().recipe.redEyes).toHaveLength(1)
  })
  it('editing the selected circle changes it; with none selected the sliders change what the next one starts with', async () => {
    await useDevelop.getState().open(1)
    useDevelop.getState().setRedEyeDefaults({ size: 0.08 })
    await useDevelop.getState().addRedEyeAt([0.5, 0.5])
    expect(useDevelop.getState().recipe.redEyes[0].size).toBe(0.08)
    const id = useDevelop.getState().recipe.redEyes[0].id
    useDevelop.getState().liveRedEye(id, { darken: 0.9 })
    await useDevelop.getState().commitRedEyes('Red eye 1: darken')
    expect(useDevelop.getState().recipe.redEyes[0].darken).toBe(0.9)
    expect(useDevelop.getState().history[0].label).toBe('Red eye 1: darken')
  })
  it('deleting one and deleting all are history steps', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().addRedEyeAt([0.2, 0.5])
    await useDevelop.getState().addRedEyeAt([0.6, 0.5])
    const first = useDevelop.getState().recipe.redEyes[0].id
    await useDevelop.getState().deleteRedEye(first)
    expect(useDevelop.getState().recipe.redEyes).toHaveLength(1)
    expect(useDevelop.getState().history[0].label).toBe('Delete red eye 1')
    await useDevelop.getState().deleteAllRedEyes()
    expect(useDevelop.getState().recipe.redEyes).toHaveLength(0)
    expect(useDevelop.getState().selectedRedEye).toBeNull()
  })
  it('stops at the limit and says so', async () => {
    await useDevelop.getState().open(1)
    for (let i = 0; i < MAX_RED_EYES; i++) await useDevelop.getState().addRedEyeAt([0.05 + (i % 10) * 0.09, 0.2 + Math.floor(i / 10) * 0.3])
    await useDevelop.getState().addRedEyeAt([0.5, 0.5])
    expect(useDevelop.getState().recipe.redEyes).toHaveLength(MAX_RED_EYES)
    expect(useDevelop.getState().error).toMatch(/at most/)
  })
  it('the red-eye tool and the other local tools do not run at the same time', async () => {
    await useDevelop.getState().open(1)
    useDevelop.getState().setSpotTool(true)
    useDevelop.getState().setRedEyeTool(true)
    expect(useDevelop.getState()).toMatchObject({ redEyeTool: true, spotTool: false })
    useDevelop.getState().setSpotTool(true)
    expect(useDevelop.getState()).toMatchObject({ redEyeTool: false, spotTool: true })
    useDevelop.getState().setRedEyeTool(true)
    await useDevelop.getState().addMask('radial')
    expect(useDevelop.getState()).toMatchObject({ redEyeTool: false, selectedRedEye: null })
    useDevelop.getState().setRedEyeTool(true)
    useDevelop.getState().setCropEdit(true)
    expect(useDevelop.getState().redEyeTool).toBe(false)
  })
  it('red-eye circles count as an edit, and are not part of the settings groups', () => {
    const r = { ...DEFAULT_RECIPE, redEyes: [eye] }
    expect(recipesEqual(r, DEFAULT_RECIPE)).toBe(false)
    expect(recipesEqual(r, { ...DEFAULT_RECIPE, redEyes: [{ ...eye }] })).toBe(true)
    expect(recipesEqual(r, { ...DEFAULT_RECIPE, redEyes: [{ ...eye, size: 0.2 }] })).toBe(false)
    // like masks and spots, they belong to one photo and are not carried by a copy or a preset
    expect(applyGroups(DEFAULT_RECIPE, r, ALL_GROUPS).redEyes).toEqual([])
  })
})
