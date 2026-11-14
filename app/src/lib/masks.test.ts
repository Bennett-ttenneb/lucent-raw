import { beforeEach, describe, expect, it } from 'vitest'
import { setApi } from './api'
import { DEFAULT_RECIPE, MASK_ADJUSTMENTS, MAX_MASKS, MAX_PARTS, adjustStep, defaultOp, defaultShape, hasHandles, maskById, newMask, recipesEqual, targetShape, useDevelop, withAdjust, withMask, withTargetShape } from './develop'
import { addStrokePoint, handlePositions, moveHandle, rgbToHueSat } from './maskedit'
import { createMockApi } from './mockApi'
import { applyGroups, ALL_GROUPS } from './presets'
import type { MaskShape, Recipe } from './types'

const linear: MaskShape = { type: 'linear', x1: 0.5, y1: 0.2, x2: 0.5, y2: 0.6, feather: 0.5 }
const radial: MaskShape = { type: 'radial', cx: 0.5, cy: 0.5, rx: 0.2, ry: 0.1, angle: 0, feather: 0.5 }

describe('moving mask handles', () => {
  it('drags the start and end of a gradient, and the whole line', () => {
    expect(moveHandle(linear, 'start', [0.5, 0.2], [0.3, 0.1], 1.5)).toMatchObject({ x1: 0.3, y1: 0.1, x2: 0.5, y2: 0.6 })
    expect(moveHandle(linear, 'end', [0.5, 0.6], [0.8, 0.9], 1.5)).toMatchObject({ x1: 0.5, y1: 0.2, x2: 0.8, y2: 0.9 })
    const moved = moveHandle(linear, 'line', [0.5, 0.4], [0.6, 0.5], 1.5)
    expect(moved).toMatchObject({ x1: 0.6, x2: 0.6 })
    expect((moved as typeof linear).y1).toBeCloseTo(0.3)
    expect((moved as typeof linear).y2).toBeCloseTo(0.7)
  })
  it('lets a handle go a little past the picture but not far', () => {
    expect(moveHandle(linear, 'end', [0.5, 0.6], [9, -9], 1)).toMatchObject({ x2: 1.5, y2: -0.5 })
  })
  it('moves a radial mask and resizes it along its own axes', () => {
    const c = moveHandle(radial, 'centre', [0.5, 0.5], [0.6, 0.4], 1) as typeof radial
    expect([c.cx, c.cy]).toEqual([0.6, 0.4])
    expect((moveHandle(radial, 'radiusX', [0.7, 0.5], [0.8, 0.5], 1) as typeof radial).rx).toBeCloseTo(0.3)
    expect((moveHandle(radial, 'radiusY', [0.5, 0.6], [0.5, 0.75], 1) as typeof radial).ry).toBeCloseTo(0.25)
    // a turned ellipse: its "width" handle lies along the turned axis
    const turned: typeof radial = { ...radial, angle: 90 }
    expect((moveHandle(turned, 'radiusX', [0.5, 0.7], [0.5, 0.8], 1) as typeof radial).rx).toBeCloseTo(0.3)
  })
  it('radius is a fraction of the long edge, so a wide picture gives the same shape in pixels', () => {
    // 2:1 picture: dragging the width handle 0.2 of the picture to the right is 0.4 of the height, i.e. 0.2 of the long edge
    const r = moveHandle({ ...radial, rx: 0.1 }, 'radiusX', [0.55, 0.5], [0.7, 0.5], 2) as typeof radial
    expect(r.rx).toBeCloseTo(0.2)
    const [rx] = [handlePositions(r, 2).radiusX!]
    expect(rx[0]).toBeCloseTo(0.7)
  })
  it('never makes a radius smaller than a sliver, and ignores a handle the shape does not have', () => {
    expect((moveHandle(radial, 'radiusX', [0.7, 0.5], [0.5, 0.5], 1) as typeof radial).rx).toBe(0.01)
    expect(moveHandle(linear, 'centre', [0, 0], [1, 1], 1)).toEqual(linear)
    expect(moveHandle({ type: 'brush', strokes: [] }, 'start', [0, 0], [1, 1], 1)).toEqual({ type: 'brush', strokes: [] })
  })
  it('knows where the handles are', () => {
    expect(handlePositions(linear, 1)).toMatchObject({ start: [0.5, 0.2], end: [0.5, 0.6] })
    expect(Object.keys(handlePositions(radial, 1)).sort()).toEqual(['centre', 'radiusX', 'radiusY'])
    expect(handlePositions({ type: 'brush', strokes: [] }, 1)).toEqual({})
  })
  it('stroke points that are too close together are skipped, and wild ones are held near the picture', () => {
    expect(addStrokePoint([[0.5, 0.5]], [0.5005, 0.5])).toEqual([[0.5, 0.5]])
    expect(addStrokePoint([[0.5, 0.5]], [0.6, 0.5])).toHaveLength(2)
    expect(addStrokePoint([], [9, -9])).toEqual([[1.5, -0.5]])
  })
})

describe('mask helpers', () => {
  it('a new mask has a name, a unique id, a sensible shape and no adjustment', () => {
    const a = newMask('linear', [])
    const b = newMask('linear', [a])
    expect(a.id).not.toBe(b.id)
    expect([a.name, b.name]).toEqual(['Linear gradient 1', 'Linear gradient 2'])
    expect(newMask('radial', []).shape.type).toBe('radial')
    expect(newMask('brush', []).shape).toEqual({ type: 'brush', strokes: [] })
    expect(Object.values(a.adjust).every((v) => v === 0)).toBe(true)
    expect(a.visible && !a.invert).toBe(true)
  })
  it('changes one mask or one adjustment and leaves the others and the original alone', () => {
    const [a, b] = [newMask('linear', []), newMask('radial', [])]
    const r: Recipe = { ...DEFAULT_RECIPE, masks: [a, b] }
    expect(withMask(r, a.id, { invert: true }).map((m) => m.invert)).toEqual([true, false])
    expect(withAdjust(r, b.id, 'exposure', 1.5).map((m) => m.adjust.exposure)).toEqual([0, 1.5])
    expect(r.masks[1].adjust.exposure).toBe(0)
    expect(maskById(r, b.id)).toBe(b)
    expect(maskById(r, 'nope')).toBeUndefined()
    expect(maskById(r, null)).toBeUndefined()
  })
  it('masks are part of recipe equality, and eight adjustments are offered', () => {
    const m = newMask('linear', [])
    expect(recipesEqual({ ...DEFAULT_RECIPE, masks: [m] }, DEFAULT_RECIPE)).toBe(false)
    expect(recipesEqual({ ...DEFAULT_RECIPE, masks: [m] }, { ...DEFAULT_RECIPE, masks: [{ ...m }] })).toBe(true)
    expect(MASK_ADJUSTMENTS.map((d) => d.key)).toEqual(['exposure', 'contrast', 'highlights', 'shadows', 'saturation', 'temperature', 'sharpness', 'noise', 'blur'])
  })
  it('describes a mask slider step with the mask name', () => {
    const m = newMask('radial', [])
    const after = { ...m, adjust: { ...m.adjust, exposure: 0.5 } }
    expect(adjustStep(after, MASK_ADJUSTMENTS[0], m)).toEqual({ label: 'Radial gradient 1: Exposure', deltaText: '+0.50', valueText: '+0.50' })
  })
  it('presets and copies leave a photo\'s masks alone', () => {
    const m = newMask('linear', [])
    const base: Recipe = { ...DEFAULT_RECIPE, masks: [m] }
    const out = applyGroups(base, { ...DEFAULT_RECIPE, exposure: 1 }, ALL_GROUPS)
    expect(out.masks).toEqual([m])
    expect(out.masks[0]).not.toBe(m) // a copy, so editing one cannot change the other
  })
})

describe('masks in the store', () => {
  beforeEach(() => {
    setApi(createMockApi(5))
    useDevelop.setState({ photoId: null, recipe: DEFAULT_RECIPE, saved: DEFAULT_RECIPE, history: [], selectedMask: null, showMask: false, error: null, version: 0 })
  })

  it('adding a mask selects it, saves it and is one history step', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().addMask('radial')
    const s = useDevelop.getState()
    expect(s.recipe.masks).toHaveLength(1)
    expect(s.selectedMask).toBe(s.recipe.masks[0].id)
    expect(s.history[0].label).toBe('Add radial gradient')
    await useDevelop.getState().open(1) // comes back after a reload
    expect(useDevelop.getState().recipe.masks).toHaveLength(1)
    expect(useDevelop.getState().selectedMask).toBeNull()
  })

  it('a handle drag is live until committed, then one step', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().addMask('linear')
    const m = useDevelop.getState().recipe.masks[0]
    useDevelop.getState().liveMask(m.id, { shape: moveHandle(m.shape, 'start', [0, 0], [0.2, 0.2], 1) })
    expect(useDevelop.getState().history).toHaveLength(1)
    await useDevelop.getState().commitMasks(m.name + ': move')
    expect(useDevelop.getState().history).toHaveLength(2)
    expect(useDevelop.getState().history[0].label).toBe('Linear gradient 1: move')
  })

  it('a brush stroke is added to its brush mask only', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().addMask('brush')
    await useDevelop.getState().addMask('linear')
    const [brush, lin] = useDevelop.getState().recipe.masks
    const stroke = { erase: false, size: 0.1, feather: 0.5, flow: 1, points: [[0.2, 0.2], [0.4, 0.4]] as [number, number][] }
    await useDevelop.getState().addStroke(lin.id, stroke) // not a brush: nothing happens
    expect(useDevelop.getState().recipe.masks[1].shape.type).toBe('linear')
    await useDevelop.getState().addStroke(brush.id, stroke)
    const shape = useDevelop.getState().recipe.masks[0].shape
    expect(shape.type === 'brush' && shape.strokes).toHaveLength(1)
    expect(useDevelop.getState().history[0].label).toBe('Brush 1: brush stroke')
  })

  it('deleting a mask removes it, clears the selection and can be undone from history', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().addMask('linear')
    const id = useDevelop.getState().recipe.masks[0].id
    await useDevelop.getState().deleteMask(id)
    expect(useDevelop.getState().recipe.masks).toEqual([])
    expect(useDevelop.getState().selectedMask).toBeNull()
    const before = useDevelop.getState().history.find((h) => h.label === 'Add linear gradient')!
    await useDevelop.getState().goTo(before)
    expect(useDevelop.getState().recipe.masks).toHaveLength(1)
  })

  it('there is a limit on masks, and it says so', async () => {
    await useDevelop.getState().open(1)
    for (let i = 0; i < MAX_MASKS; i++) await useDevelop.getState().addMask('linear')
    expect(useDevelop.getState().recipe.masks).toHaveLength(MAX_MASKS)
    await useDevelop.getState().addMask('radial')
    expect(useDevelop.getState().recipe.masks).toHaveLength(MAX_MASKS)
    expect(useDevelop.getState().error).toMatch(/at most/)
  })

  it('an edit made while the photo is still loading is ignored, not lost to the late arrival', async () => {
    // all three calls happen before the (instant, in the mock) answer for the photo's settings can be handled
    const opening = useDevelop.getState().open(1)
    const adding = useDevelop.getState().addMask('radial')
    useDevelop.getState().live({ exposure: 1 })
    await Promise.all([opening, adding])
    expect(useDevelop.getState().recipe.masks).toEqual([])
    expect(useDevelop.getState().recipe.exposure).toBe(0)
    // once loaded, edits work and what is on screen is what was saved
    await useDevelop.getState().addMask('radial')
    expect(useDevelop.getState().recipe.masks).toHaveLength(1)
    await useDevelop.getState().open(1)
    expect(useDevelop.getState().recipe.masks).toHaveLength(1)
  })

  it('the painting flag is on only while a stroke is being drawn', async () => {
    await useDevelop.getState().open(1)
    expect(useDevelop.getState().painting).toBe(false)
    useDevelop.getState().setPainting(true)
    expect(useDevelop.getState().painting).toBe(true)
    useDevelop.getState().setPainting(false)
    expect(useDevelop.getState().painting).toBe(false)
  })

  it('another photo starts with nothing selected', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().addMask('linear')
    await useDevelop.getState().open(2)
    expect(useDevelop.getState().selectedMask).toBeNull()
    expect(useDevelop.getState().recipe.masks).toEqual([])
  })
})

describe('range masks and combined shapes: helpers', () => {
  it('every kind of shape has a sensible starting point, and only some have handles', () => {
    expect(defaultShape('luminance')).toEqual({ type: 'luminance', lo: 0.6, hi: 1, smooth: 0.3 })
    expect(defaultShape('colour')).toMatchObject({ type: 'colour', hue: 0, range: 30 })
    expect(['linear', 'radial', 'brush'].every((k) => hasHandles(defaultShape(k as never)))).toBe(true)
    expect(hasHandles(defaultShape('luminance')) || hasHandles(defaultShape('colour'))).toBe(false)
    expect(newMask('colour', []).name).toBe('Colour range 1')
    expect(newMask('luminance', []).parts).toEqual([])
  })
  it('a range starts by narrowing, a shape by adding', () => {
    expect(defaultOp('luminance')).toBe('intersect')
    expect(defaultOp('colour')).toBe('intersect')
    expect(defaultOp('radial')).toBe('add')
    expect(defaultOp('brush')).toBe('add')
  })
  it('edits the first shape or a chosen part, and never touches the rest', () => {
    const m = { ...newMask('radial', []), parts: [{ op: 'add' as const, shape: defaultShape('linear') }, { op: 'intersect' as const, shape: defaultShape('luminance') }] }
    expect(targetShape(m, null)).toBe(m.shape)
    expect(targetShape(m, 1)).toBe(m.parts[1].shape)
    expect(targetShape(m, 9)).toBe(m.shape) // a part that is not there falls back to the first shape
    const base = withTargetShape(m, null, { type: 'brush', strokes: [] })
    expect(base).toEqual({ shape: { type: 'brush', strokes: [] } })
    const part = withTargetShape(m, 1, { type: 'luminance', lo: 0.1, hi: 0.2, smooth: 0 })
    expect(part.parts?.[1].shape).toEqual({ type: 'luminance', lo: 0.1, hi: 0.2, smooth: 0 })
    expect(part.parts?.[0]).toBe(m.parts[0])
    expect(part.parts?.[1].op).toBe('intersect')
    expect(m.parts[1].shape).toEqual(defaultShape('luminance')) // the original is not changed
  })
  it('gives the hue and saturation of a picked colour', () => {
    expect(rgbToHueSat(255, 0, 0)).toEqual({ hue: 0, sat: 1 })
    expect(rgbToHueSat(0, 255, 0).hue).toBeCloseTo(120)
    expect(rgbToHueSat(0, 0, 255).hue).toBeCloseTo(240)
    expect(rgbToHueSat(255, 255, 0).hue).toBeCloseTo(60)
    expect(rgbToHueSat(255, 0, 255).hue).toBeCloseTo(300)
    expect(rgbToHueSat(255, 128, 0).hue).toBeCloseTo(30, 0)
    expect(rgbToHueSat(128, 128, 128)).toEqual({ hue: 0, sat: 0 })
    expect(rgbToHueSat(0, 0, 0).sat).toBe(0)
    const pale = rgbToHueSat(200, 170, 170)
    expect(pale.hue).toBeCloseTo(0)
    expect(pale.sat).toBeGreaterThan(0.1)
    expect(pale.sat).toBeLessThan(0.5)
    expect(rgbToHueSat(255, 0, 10).hue).toBeGreaterThan(300) // just below red, round the wheel
  })
})

describe('range masks and combined shapes in the store', () => {
  beforeEach(() => {
    setApi(createMockApi(5))
    useDevelop.setState({ photoId: null, recipe: DEFAULT_RECIPE, saved: DEFAULT_RECIPE, history: [], selectedMask: null, selectedPart: null, picking: false, error: null, version: 0 })
  })

  it('a range can be a mask on its own, and is saved like any mask', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().addMask('luminance')
    const m = useDevelop.getState().recipe.masks[0]
    expect(m.shape.type).toBe('luminance')
    expect(useDevelop.getState().history[0].label).toBe('Add luminance range')
    await useDevelop.getState().open(1)
    expect(useDevelop.getState().recipe.masks[0].shape.type).toBe('luminance')
  })

  it('combining adds a part, selects it, and ranges start as intersect and shapes as add', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().addMask('radial')
    const id = useDevelop.getState().recipe.masks[0].id
    await useDevelop.getState().addPart(id, 'luminance')
    await useDevelop.getState().addPart(id, 'linear')
    const m = useDevelop.getState().recipe.masks[0]
    expect(m.parts.map((p) => [p.shape.type, p.op])).toEqual([['luminance', 'intersect'], ['linear', 'add']])
    expect(useDevelop.getState().selectedPart).toBe(1)
    expect(useDevelop.getState().history[0].label).toBe('Radial gradient 1: add linear gradient')
    expect(useDevelop.getState().history[1].label).toBe('Radial gradient 1: intersect luminance range')
  })

  it('changing how a part combines is a history step, and a no-op change is not', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().addMask('radial')
    const id = useDevelop.getState().recipe.masks[0].id
    await useDevelop.getState().addPart(id, 'brush')
    const steps = useDevelop.getState().history.length
    await useDevelop.getState().setPartOp(id, 0, 'add')
    expect(useDevelop.getState().history).toHaveLength(steps)
    await useDevelop.getState().setPartOp(id, 0, 'subtract')
    expect(useDevelop.getState().recipe.masks[0].parts[0].op).toBe('subtract')
    expect(useDevelop.getState().history[0].label).toBe('Radial gradient 1: subtract brush')
  })

  it('removing a part keeps the selection pointing at the right one', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().addMask('radial')
    const id = useDevelop.getState().recipe.masks[0].id
    for (const t of ['linear', 'brush', 'luminance'] as const) await useDevelop.getState().addPart(id, t)
    useDevelop.getState().selectPart(2) // the luminance range
    await useDevelop.getState().removePart(id, 0)
    expect(useDevelop.getState().selectedPart).toBe(1) // still the luminance range, now second
    expect(targetShape(useDevelop.getState().recipe.masks[0], useDevelop.getState().selectedPart).type).toBe('luminance')
    await useDevelop.getState().removePart(id, 1)
    expect(useDevelop.getState().selectedPart).toBeNull() // the selected one went: back to the first shape
    expect(useDevelop.getState().recipe.masks[0].parts.map((p) => p.shape.type)).toEqual(['brush'])
  })

  it('a mask can combine only so many shapes, and says so', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().addMask('radial')
    const id = useDevelop.getState().recipe.masks[0].id
    for (let i = 0; i < MAX_PARTS; i++) await useDevelop.getState().addPart(id, 'linear')
    expect(useDevelop.getState().recipe.masks[0].parts).toHaveLength(MAX_PARTS)
    await useDevelop.getState().addPart(id, 'brush')
    expect(useDevelop.getState().recipe.masks[0].parts).toHaveLength(MAX_PARTS)
    expect(useDevelop.getState().error).toMatch(/at most/)
  })

  it('choosing another mask goes back to its first shape and stops picking', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().addMask('radial')
    const [a] = useDevelop.getState().recipe.masks
    await useDevelop.getState().addPart(a.id, 'luminance')
    useDevelop.getState().setPicking(true)
    await useDevelop.getState().addMask('linear')
    expect(useDevelop.getState().selectedPart).toBeNull()
    useDevelop.getState().selectMask(a.id)
    expect(useDevelop.getState().selectedPart).toBeNull()
    expect(useDevelop.getState().picking).toBe(false)
  })

  it('picking a colour sets the hue and a modest colour floor on the selected colour range', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().addMask('colour')
    await useDevelop.getState().pickColour(212.4, 0.6)
    const shape = useDevelop.getState().recipe.masks[0].shape
    expect(shape).toMatchObject({ type: 'colour', hue: 212, sat: 0.3 })
    expect(useDevelop.getState().history[0].label).toBe('Colour range 1: pick colour')
    // a part works too
    await useDevelop.getState().addMask('radial')
    const radial = useDevelop.getState().recipe.masks[1]
    await useDevelop.getState().addPart(radial.id, 'colour')
    await useDevelop.getState().pickColour(10, 1)
    expect(useDevelop.getState().recipe.masks[1].parts[0].shape).toMatchObject({ type: 'colour', hue: 10, sat: 0.5 })
  })

  it('picking grey is refused with a message, and picking on something that is not a colour range does nothing', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().addMask('colour')
    const before = useDevelop.getState().recipe.masks[0].shape
    await useDevelop.getState().pickColour(0, 0.02)
    expect(useDevelop.getState().recipe.masks[0].shape).toEqual(before)
    expect(useDevelop.getState().error).toMatch(/no colour to pick/)
    useDevelop.setState({ error: null })
    await useDevelop.getState().addMask('radial')
    await useDevelop.getState().pickColour(100, 0.8)
    expect(useDevelop.getState().recipe.masks[1].shape.type).toBe('radial')
    expect(useDevelop.getState().error).toBeNull()
  })
})
