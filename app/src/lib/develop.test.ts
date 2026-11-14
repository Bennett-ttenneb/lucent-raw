import { beforeEach, describe, expect, it } from 'vitest'
import { setApi } from './api'
import { useStore } from './store'
import { DEFAULT_RECIPE, GRAIN, LENS, TRANSFORM, VIGNETTE, geometryStep, lensIsDefault, transformIsDefault, clamp, clampCentre, cropKey, detailIsDefault, effectStep, effectsIsDefault, detailStep, isDefault, mixerIsDefault, mixerStep, recipesEqual, signed, stepForSlider, useDevelop, windowFor, withMixer } from './develop'
import { parseKey } from './keys'
import { createMockApi } from './mockApi'

const reset = (failWrites = false) => {
  setApi(createMockApi(5, { failWrites }))
  useDevelop.setState({ photoId: null, recipe: DEFAULT_RECIPE, saved: DEFAULT_RECIPE, history: [], loading: false, error: null, showOriginal: false, clipboard: null, version: 0 })
}

describe('formatting and comparison', () => {
  it('shows a sign for non-zero values and rounds to the slider precision', () => {
    expect(signed(12, 0)).toBe('+12')
    expect(signed(-0.349, 2)).toMatch(/^-0[.,]35$/)
    expect(signed(0, 0)).toBe('0')
    expect(signed(0.001, 0)).toBe('0') // rounds to zero, so no stray plus
  })
  it('clamps and survives NaN', () => {
    expect(clamp(150, -100, 100)).toBe(100)
    expect(clamp(NaN, -100, 100)).toBe(0)
  })
  it('compares recipes by value, including the crop', () => {
    expect(isDefault(DEFAULT_RECIPE)).toBe(true)
    expect(recipesEqual({ ...DEFAULT_RECIPE, exposure: 0.5 }, DEFAULT_RECIPE)).toBe(false)
    expect(recipesEqual({ ...DEFAULT_RECIPE, crop: { aspect: '1:1', angle: 0, rect: null } }, DEFAULT_RECIPE)).toBe(false)
  })
  it('describes a slider step with its delta and new value', () => {
    const s = stepForSlider('exposure', DEFAULT_RECIPE, { ...DEFAULT_RECIPE, exposure: 0.5 })
    expect(s.label).toBe('Exposure')
    expect(s.deltaText).toMatch(/^\+0[.,]50$/)
  })
  it('d opens Develop', () => {
    expect(parseKey({ key: 'd' })).toEqual({ type: 'develop' })
  })
})

describe('the develop store', () => {
  beforeEach(() => reset())

  it('opens an unedited photo with the default recipe and no history', async () => {
    await useDevelop.getState().open(1)
    const s = useDevelop.getState()
    expect(s.photoId).toBe(1)
    expect(isDefault(s.recipe)).toBe(true)
    expect(s.history).toEqual([])
  })

  it('a live change is shown but not saved, and a commit saves one history step', async () => {
    await useDevelop.getState().open(1)
    useDevelop.getState().live({ exposure: 0.8 })
    expect(useDevelop.getState().recipe.exposure).toBe(0.8)
    expect(useDevelop.getState().history).toHaveLength(0)
    await useDevelop.getState().commit({ label: 'Exposure', deltaText: '+0,80', valueText: '+0,80' })
    expect(useDevelop.getState().history.map((h) => h.label)).toEqual(['Exposure'])
    // reopen: the edit is still there
    await useDevelop.getState().open(1)
    expect(useDevelop.getState().recipe.exposure).toBe(0.8)
  })

  it('committing with no change adds nothing', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().commit({ label: 'Exposure', deltaText: null, valueText: null })
    expect(useDevelop.getState().history).toHaveLength(0)
  })

  it('edits belong to their own photo', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().setAndCommit({ contrast: 30 }, { label: 'Contrast', deltaText: null, valueText: null })
    await useDevelop.getState().open(2)
    expect(useDevelop.getState().recipe.contrast).toBe(0)
    expect(useDevelop.getState().history).toEqual([])
  })

  it('reset slider and reset all each record a step', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().setAndCommit({ contrast: 30, saturation: 20 }, { label: 'Two', deltaText: null, valueText: null })
    await useDevelop.getState().resetSlider('contrast')
    expect(useDevelop.getState().recipe.contrast).toBe(0)
    expect(useDevelop.getState().recipe.saturation).toBe(20)
    await useDevelop.getState().resetAll()
    expect(isDefault(useDevelop.getState().recipe)).toBe(true)
    expect(useDevelop.getState().history.map((h) => h.label)).toEqual(['Reset all', 'Reset Contrast', 'Two'])
  })

  it('going back to a history step restores that recipe and keeps the later steps', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().setAndCommit({ exposure: 1 }, { label: 'Exposure', deltaText: null, valueText: null })
    await useDevelop.getState().setAndCommit({ contrast: 40 }, { label: 'Contrast', deltaText: null, valueText: null })
    const first = useDevelop.getState().history.find((h) => h.label === 'Exposure')!
    await useDevelop.getState().goTo(first)
    expect(useDevelop.getState().recipe).toMatchObject({ exposure: 1, contrast: 0 })
    expect(useDevelop.getState().history).toHaveLength(3)
    expect(useDevelop.getState().history[0].label).toBe('Back to Exposure')
  })

  it('copy and paste move the settings to another photo, but by default not the crop', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().setAndCommit({ vibrance: 25, crop: { aspect: '3:2', angle: 2, rect: null } }, { label: 'Look', deltaText: null, valueText: null })
    useDevelop.getState().copy()
    await useDevelop.getState().open(2)
    await useDevelop.getState().paste()
    expect(useDevelop.getState().recipe.vibrance).toBe(25)
    expect(useDevelop.getState().recipe.crop).toEqual({ aspect: 'original', angle: 0, rect: null })
  })

  it('copying chosen groups pastes only those, crop included when asked', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().setAndCommit({ vibrance: 25, contrast: 40, crop: { aspect: '3:2', angle: 2, rect: null } }, { label: 'Look', deltaText: null, valueText: null })
    useDevelop.getState().copy(['presence', 'crop'])
    await useDevelop.getState().open(2)
    await useDevelop.getState().paste()
    expect(useDevelop.getState().recipe).toMatchObject({ vibrance: 25, contrast: 0, crop: { aspect: '3:2', angle: 2, rect: null } })
  })

  it('a failed save puts the screen back to what the catalog has and says why', async () => {
    reset(true)
    await useDevelop.getState().open(1)
    useDevelop.getState().live({ exposure: 2 })
    await useDevelop.getState().commit({ label: 'Exposure', deltaText: null, valueText: null })
    const s = useDevelop.getState()
    expect(s.recipe.exposure).toBe(0)
    expect(s.error).toMatch(/could not be saved/)
  })

  it('opening a photo that is gone shows an error, not a crash', async () => {
    await useDevelop.getState().open(999)
    expect(useDevelop.getState().error).toMatch(/no longer in the catalog/)
    expect(isDefault(useDevelop.getState().recipe)).toBe(true)
  })

  it('a slow load for the old photo cannot overwrite the new one', async () => {
    const first = useDevelop.getState().open(1)
    const second = useDevelop.getState().open(2)
    await Promise.all([first, second])
    expect(useDevelop.getState().photoId).toBe(2)
  })

  it('using a slider turns the original view off', async () => {
    await useDevelop.getState().open(1)
    useDevelop.getState().toggleOriginal()
    expect(useDevelop.getState().showOriginal).toBe(true)
    useDevelop.getState().live({ exposure: 0.1 })
    expect(useDevelop.getState().showOriginal).toBe(false)
  })
})

describe('colour mixer helpers', () => {
  it('changes one band of one kind and leaves the rest alone', () => {
    const hsl = withMixer(DEFAULT_RECIPE, 'sat', 3, -40)
    expect(hsl.sat[3]).toBe(-40)
    expect(hsl.sat.filter((v) => v !== 0)).toHaveLength(1)
    expect(hsl.hue).toEqual(DEFAULT_RECIPE.hsl.hue)
    expect(DEFAULT_RECIPE.hsl.sat[3]).toBe(0) // the default is not mutated
  })
  it('knows when the mixer is untouched and compares it in recipesEqual', () => {
    expect(mixerIsDefault(DEFAULT_RECIPE)).toBe(true)
    const edited = { ...DEFAULT_RECIPE, hsl: withMixer(DEFAULT_RECIPE, 'lum', 7, 10) }
    expect(mixerIsDefault(edited)).toBe(false)
    expect(recipesEqual(edited, DEFAULT_RECIPE)).toBe(false)
    expect(recipesEqual(edited, { ...DEFAULT_RECIPE, hsl: withMixer(DEFAULT_RECIPE, 'lum', 7, 10) })).toBe(true)
  })
  it('describes a step with the band and the kind', () => {
    const after = { ...DEFAULT_RECIPE, hsl: withMixer(DEFAULT_RECIPE, 'hue', 0, 25) }
    expect(mixerStep('hue', 0, DEFAULT_RECIPE, after)).toEqual({ label: 'Red hue', deltaText: '+25', valueText: '+25' })
  })
  it('a mixer edit is saved and comes back', async () => {
    reset()
    await useDevelop.getState().open(1)
    useDevelop.getState().live({ hsl: withMixer(useDevelop.getState().recipe, 'sat', 1, -30) })
    await useDevelop.getState().commit(mixerStep('sat', 1, useDevelop.getState().saved, useDevelop.getState().recipe))
    await useDevelop.getState().open(1)
    expect(useDevelop.getState().recipe.hsl.sat[1]).toBe(-30)
    expect(useDevelop.getState().history[0].label).toBe('Orange saturation')
  })
})

describe('detail helpers', () => {
  it('knows when detail is untouched; radius 1.0 is the untouched radius', () => {
    expect(detailIsDefault(DEFAULT_RECIPE)).toBe(true)
    expect(DEFAULT_RECIPE.detail.sharpRadius).toBe(1)
    expect(detailIsDefault({ ...DEFAULT_RECIPE, detail: { ...DEFAULT_RECIPE.detail, sharpRadius: 1.5 } })).toBe(false)
  })
  it('detail is part of recipe equality', () => {
    const a = { ...DEFAULT_RECIPE, detail: { ...DEFAULT_RECIPE.detail, nrLuma: 30 } }
    expect(recipesEqual(a, DEFAULT_RECIPE)).toBe(false)
    expect(recipesEqual(a, { ...DEFAULT_RECIPE, detail: { ...DEFAULT_RECIPE.detail, nrLuma: 30 } })).toBe(true)
  })
  it('describes a step with its name, change and new value', () => {
    const after = { ...DEFAULT_RECIPE, detail: { ...DEFAULT_RECIPE.detail, sharpAmount: 40 } }
    expect(detailStep('sharpAmount', DEFAULT_RECIPE, after)).toEqual({ label: 'Sharpening amount', deltaText: '+40', valueText: '40' })
    expect(detailStep('nrColour', DEFAULT_RECIPE, { ...DEFAULT_RECIPE, detail: { ...DEFAULT_RECIPE.detail, nrColour: 25 } }).label).toBe('Colour noise reduction')
  })
  it('a detail edit is saved and comes back', async () => {
    reset()
    await useDevelop.getState().open(1)
    useDevelop.getState().live({ detail: { ...useDevelop.getState().recipe.detail, sharpAmount: 55 } })
    await useDevelop.getState().commit(detailStep('sharpAmount', useDevelop.getState().saved, useDevelop.getState().recipe))
    await useDevelop.getState().open(1)
    expect(useDevelop.getState().recipe.detail.sharpAmount).toBe(55)
    expect(useDevelop.getState().recipe.detail.sharpRadius).toBe(1)
  })
})

describe('1:1 window maths', () => {
  it('centres the window on the point and keeps it inside the picture', () => {
    expect(windowFor(2000, 1500, 4000, 3000, 800, 600)).toEqual({ x: 1600, y: 1200, w: 800, h: 600 })
    expect(windowFor(0, 0, 4000, 3000, 800, 600)).toEqual({ x: 0, y: 0, w: 800, h: 600 })
    expect(windowFor(4000, 3000, 4000, 3000, 800, 600)).toEqual({ x: 3200, y: 2400, w: 800, h: 600 })
  })
  it('a picture smaller than the viewport gives a window of the whole picture', () => {
    expect(windowFor(100, 50, 300, 200, 800, 600)).toEqual({ x: 0, y: 0, w: 300, h: 200 })
    expect(clampCentre(10, 10, 300, 200, 800, 600)).toEqual([150, 100])
  })
  it('the centre cannot leave the range where a full window exists', () => {
    expect(clampCentre(-50, 99999, 4000, 3000, 800, 600)).toEqual([400, 2700])
    expect(clampCentre(2000, 1500, 4000, 3000, 800, 600)).toEqual([2000, 1500])
  })
  it('the crop key tells crops apart', () => {
    expect(cropKey({ aspect: 'original', angle: 0, rect: null })).toBe(cropKey({ aspect: 'original', angle: 0, rect: null }))
    expect(cropKey({ aspect: '3:2', angle: 0, rect: null })).not.toBe(cropKey({ aspect: 'original', angle: 0, rect: null }))
    expect(cropKey({ aspect: 'original', angle: 1.5, rect: null })).not.toBe(cropKey({ aspect: 'original', angle: 0, rect: null }))
  })
})

describe('1:1 in the store', () => {
  it('zooming in centres on the asked fraction, panning moves it and stops at the edges, zooming out leaves it', async () => {
    reset()
    await useDevelop.getState().open(1)
    useDevelop.getState().setViewport(800, 600)
    await useDevelop.getState().zoomIn(0.25, 0.5)
    let z = useDevelop.getState().zoom
    expect(z.on).toBe(true)
    expect([z.width, z.height]).toEqual([4000, 2667])
    expect([z.cx, z.cy]).toEqual([1000, 1333.5])
    useDevelop.getState().panBy(300, -100)
    z = useDevelop.getState().zoom
    expect([z.cx, z.cy]).toEqual([1300, 1233.5])
    useDevelop.getState().panBy(-99999, 99999)
    z = useDevelop.getState().zoom
    expect([z.cx, z.cy]).toEqual([400, 2367])
    useDevelop.getState().zoomOut()
    expect(useDevelop.getState().zoom.on).toBe(false)
  })
  it('panning does nothing when not zoomed, and a new photo starts fitted', async () => {
    reset()
    await useDevelop.getState().open(1)
    useDevelop.getState().panBy(100, 100)
    expect(useDevelop.getState().zoom.cx).toBe(0)
    await useDevelop.getState().zoomIn()
    expect(useDevelop.getState().zoom.on).toBe(true)
    await useDevelop.getState().open(2)
    expect(useDevelop.getState().zoom.on).toBe(false)
  })
  it('a photo that is gone does not zoom and says why', async () => {
    reset()
    await useDevelop.getState().open(999)
    await useDevelop.getState().zoomIn()
    expect(useDevelop.getState().zoom.on).toBe(false)
    expect(useDevelop.getState().error).toMatch(/no longer in the catalog/)
  })
  it('a resize keeps the view inside the picture', async () => {
    reset()
    await useDevelop.getState().open(1)
    useDevelop.getState().setViewport(800, 600)
    await useDevelop.getState().zoomIn(1, 1)
    useDevelop.getState().setViewport(1600, 1200)
    const z = useDevelop.getState().zoom
    expect([z.cx, z.cy]).toEqual([3200, 2067]) // 4000-1600/2 and 2667-1200/2
  })
})

describe('edited photos in the Library', () => {
  const edited = (id: number) => useStore.getState().photoAt(useStore.getState().pages[0].findIndex((p) => p.id === id))?.edited

  it('saving an edit marks the photo, and putting everything back unmarks it', async () => {
    setApi(createMockApi(5))
    await useStore.getState().reload()
    const id = useStore.getState().pages[0][0].id
    expect(edited(id)).toBe(false)
    await useDevelop.getState().open(id)
    await useDevelop.getState().setAndCommit({ exposure: 0.5 }, { label: 'Exposure', deltaText: null, valueText: null })
    expect(edited(id)).toBe(true)
    // other photos are not marked
    expect(useStore.getState().pages[0].filter((p) => p.edited)).toHaveLength(1)
    await useDevelop.getState().resetAll()
    expect(edited(id)).toBe(false)
    // the core's own list agrees
    const page = await (await import('./api')).api().photoQuery({ sort: 'name', desc: false, offset: 0, limit: 10 })
    expect(page.rows.some((p) => p.edited)).toBe(false)
  })

  it('an edit announces its photo, and only that photo gets a new picture key', async () => {
    setApi(createMockApi(5))
    useStore.setState({ photoVersion: {}, previewVersion: 0 })
    await useStore.getState().init()
    await useStore.getState().reload()
    const [a, b] = useStore.getState().pages[0]
    await useDevelop.getState().open(a.id)
    await useDevelop.getState().setAndCommit({ exposure: 1 }, { label: 'Exposure', deltaText: null, valueText: null })
    expect(useStore.getState().photoVersion[a.id]).toBe(1)
    expect(useStore.getState().photoVersion[b.id]).toBeUndefined()
    expect(useStore.getState().previewVersion).toBe(0)
  })
})

describe('effects helpers', () => {
  it('knows when effects are untouched, and neutral values are the core\'s defaults', () => {
    expect(effectsIsDefault(DEFAULT_RECIPE)).toBe(true)
    expect(DEFAULT_RECIPE.effects).toMatchObject({ vignetteAmount: 0, vignetteMidpoint: 50, vignetteFeather: 50, vignetteRoundness: 50, grainAmount: 0, grainSize: 25, grainRoughness: 50 })
    expect(effectsIsDefault({ ...DEFAULT_RECIPE, effects: { ...DEFAULT_RECIPE.effects, grainSize: 40 } })).toBe(false)
  })
  it('effects are part of recipe equality', () => {
    const a = { ...DEFAULT_RECIPE, effects: { ...DEFAULT_RECIPE.effects, vignetteAmount: -20 } }
    expect(recipesEqual(a, DEFAULT_RECIPE)).toBe(false)
    expect(recipesEqual(a, { ...DEFAULT_RECIPE, effects: { ...DEFAULT_RECIPE.effects, vignetteAmount: -20 } })).toBe(true)
  })
  it('describes a step with its name, change and new value', () => {
    const after = { ...DEFAULT_RECIPE, effects: { ...DEFAULT_RECIPE.effects, vignetteAmount: -30 } }
    expect(effectStep(VIGNETTE[0], DEFAULT_RECIPE, after)).toEqual({ label: 'Vignette amount', deltaText: '-30', valueText: '-30' })
    expect(GRAIN.map((d) => d.label)).toEqual(['Amount', 'Size', 'Roughness'])
  })
  it('an effects edit is saved and comes back', async () => {
    reset()
    await useDevelop.getState().open(1)
    useDevelop.getState().live({ effects: { ...useDevelop.getState().recipe.effects, grainAmount: 45 } })
    await useDevelop.getState().commit(effectStep(GRAIN[0], useDevelop.getState().saved, useDevelop.getState().recipe))
    await useDevelop.getState().open(1)
    expect(useDevelop.getState().recipe.effects.grainAmount).toBe(45)
    expect(useDevelop.getState().recipe.effects.grainSize).toBe(25)
  })
})

describe('auto tone and auto white balance', () => {
  it('auto tone sets the tone and presence sliders but not the white balance, as one history step', async () => {
    reset()
    await useDevelop.getState().open(1)
    await useDevelop.getState().setAndCommit({ saturation: 20, temperature: 7 }, { label: 'Look', deltaText: null, valueText: null })
    await useDevelop.getState().autoTone()
    expect(useDevelop.getState().recipe).toMatchObject({ exposure: 0.4, contrast: 10, highlights: -20, shadows: 25, whites: 5, blacks: -8, vibrance: 15, saturation: 4, temperature: 7 })
    expect(useDevelop.getState().history[0].label).toBe('Auto tone')
  })
  it('auto white balance sets only temperature and tint', async () => {
    reset()
    await useDevelop.getState().open(1)
    await useDevelop.getState().setAndCommit({ exposure: 0.9 }, { label: 'Exposure', deltaText: null, valueText: null })
    await useDevelop.getState().autoWhiteBalance()
    expect(useDevelop.getState().recipe).toMatchObject({ temperature: 12, tint: -4, exposure: 0.9 })
    expect(useDevelop.getState().history[0].label).toBe('Auto white balance')
  })
  it('a photo that is gone says so and changes nothing', async () => {
    reset()
    await useDevelop.getState().open(999)
    await useDevelop.getState().autoTone()
    expect(isDefault(useDevelop.getState().recipe)).toBe(true)
    expect(useDevelop.getState().error).toMatch(/no longer in the catalog/)
  })
})

describe('lens corrections and transform', () => {
  it('knows when each panel is untouched; scale 100 and constrain on are the untouched values', () => {
    expect(DEFAULT_RECIPE.geometry).toMatchObject({ scale: 100, constrain: true, rotate: 0 })
    expect(lensIsDefault(DEFAULT_RECIPE) && transformIsDefault(DEFAULT_RECIPE)).toBe(true)
    const g = (patch: Partial<typeof DEFAULT_RECIPE.geometry>) => ({ ...DEFAULT_RECIPE, geometry: { ...DEFAULT_RECIPE.geometry, ...patch } })
    expect(lensIsDefault(g({ distortion: 10 }))).toBe(false)
    expect(transformIsDefault(g({ distortion: 10 }))).toBe(true) // the two panels are separate
    expect(transformIsDefault(g({ scale: 120 }))).toBe(false)
    expect(transformIsDefault(g({ constrain: false }))).toBe(false)
  })
  it('offers three lens sliders and seven transform sliders with the core\'s ranges', () => {
    expect(LENS.map((d) => d.key)).toEqual(['distortion', 'caRed', 'caBlue'])
    expect(TRANSFORM.map((d) => d.key)).toEqual(['vertical', 'horizontal', 'rotate', 'aspect', 'scale', 'xOffset', 'yOffset'])
    const rotate = TRANSFORM.find((d) => d.key === 'rotate')!
    expect([rotate.min, rotate.max, rotate.step, rotate.digits]).toEqual([-10, 10, 0.1, 1])
    expect(TRANSFORM.find((d) => d.key === 'scale')).toMatchObject({ min: 50, max: 200, neutral: 100 })
  })
  it('describes a step with its panel, the change and the new value', () => {
    const after = { ...DEFAULT_RECIPE, geometry: { ...DEFAULT_RECIPE.geometry, vertical: 25 } }
    expect(geometryStep(TRANSFORM[0], DEFAULT_RECIPE, after)).toEqual({ label: 'Transform: Vertical', deltaText: '+25', valueText: '25' })
    expect(geometryStep(LENS[0], DEFAULT_RECIPE, { ...DEFAULT_RECIPE, geometry: { ...DEFAULT_RECIPE.geometry, distortion: -10 } }).label).toBe('Lens: Distortion')
  })
  it('geometry is part of recipe equality and of what 1:1 is prepared for', () => {
    const a = { ...DEFAULT_RECIPE, geometry: { ...DEFAULT_RECIPE.geometry, rotate: 2 } }
    expect(recipesEqual(a, DEFAULT_RECIPE)).toBe(false)
    expect(recipesEqual(a, { ...DEFAULT_RECIPE, geometry: { ...DEFAULT_RECIPE.geometry, rotate: 2 } })).toBe(true)
    expect(cropKey(a.crop, a.geometry)).not.toBe(cropKey(DEFAULT_RECIPE.crop, DEFAULT_RECIPE.geometry))
    expect(cropKey(a.crop, a.geometry)).toBe(cropKey({ ...a.crop }, { ...a.geometry }))
  })
  it('a geometry edit is saved and comes back, and changing it ends a 1:1 view', async () => {
    reset()
    await useDevelop.getState().open(1)
    useDevelop.getState().live({ geometry: { ...useDevelop.getState().recipe.geometry, vertical: 30 } })
    await useDevelop.getState().commit(geometryStep(TRANSFORM[0], useDevelop.getState().saved, useDevelop.getState().recipe))
    await useDevelop.getState().open(1)
    expect(useDevelop.getState().recipe.geometry.vertical).toBe(30)
    expect(useDevelop.getState().recipe.geometry.scale).toBe(100)
    expect(useDevelop.getState().history[0].label).toBe('Transform: Vertical')
  })
})
