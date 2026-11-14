import { beforeEach, describe, expect, it } from 'vitest'
import { setApi } from './api'
import { DEFAULT_RECIPE, recipesEqual, useDevelop } from './develop'
import { createMockApi } from './mockApi'
import { applyGroups, ALL_GROUPS } from './presets'
import { DEFAULT_EYES, DEFAULT_SKIN, DEFAULT_TEETH, MAX_PORTRAITS, MAX_RADIUS, MIN_RADIUS, REGIONS, anyPortraitActive, eyesIsDefault, handlePositions, insideFace, layoutFace, mergeDetected, moveEllipse, moveWhole, portraitIsActive, skinIsDefault, teethIsDefault, units } from './portraitedit'
import type { Portrait } from './types'

const near = (a: number, b: number, d = 1e-6) => expect(Math.abs(a - b)).toBeLessThan(d)

describe('laying out a face', () => {
  it('puts the eyes above the middle, the mouth below, and the face where it was clicked', () => {
    const p = layoutFace([0.4, 0.5], 1.5)
    expect([p.face.cx, p.face.cy]).toEqual([0.4, 0.5])
    expect(p.leftEye.cx).toBeLessThan(0.4)
    expect(p.rightEye.cx).toBeGreaterThan(0.4)
    expect(p.leftEye.cy).toBeLessThan(0.5)
    expect(p.rightEye.cy).toBeLessThan(0.5)
    expect(p.mouth.cy).toBeGreaterThan(0.5)
    near(p.mouth.cx, 0.4)
    near(p.leftEye.cy, p.rightEye.cy)
  })
  it('is symmetric about the face, in pixels, on a wide and on a tall picture', () => {
    for (const aspect of [1.5, 0.75, 1]) {
      const p = layoutFace([0.5, 0.5], aspect)
      near(0.5 - p.leftEye.cx, p.rightEye.cx - 0.5)
      // a face is taller than wide, and eyes are wider than tall, whatever the picture's shape
      expect(p.face.ry).toBeGreaterThan(p.face.rx)
      expect(p.leftEye.rx).toBeGreaterThan(p.leftEye.ry)
      expect(p.mouth.rx).toBeGreaterThan(p.mouth.ry)
    }
  })
  it('starts with no retouching at all, and a face laid out is not yet an edit', () => {
    const p = layoutFace([0.5, 0.5], 1.5)
    expect(p.skin).toEqual(DEFAULT_SKIN)
    expect(p.teeth).toEqual(DEFAULT_TEETH)
    expect(p.eyes).toEqual(DEFAULT_EYES)
    expect(portraitIsActive(p)).toBe(false)
    expect(portraitIsActive(null)).toBe(false)
  })
  it('keeps every region on the picture even when clicked at the very corner', () => {
    const p = layoutFace([0, 1], 1.5)
    for (const { key } of REGIONS) {
      expect(p[key].cx).toBeGreaterThanOrEqual(-0.5)
      expect(p[key].cy).toBeLessThanOrEqual(1.5)
    }
  })
})

describe('shaping regions', () => {
  const e = { cx: 0.5, cy: 0.5, rx: 0.1, ry: 0.15 }
  it('the middle handle moves the ellipse and cannot be dragged far off the picture', () => {
    const m = moveEllipse(e, 'centre', [0.5, 0.5], [0.6, 0.4], 1.5)
    near(m.cx, 0.6)
    near(m.cy, 0.4)
    const far = moveEllipse(e, 'centre', [0.5, 0.5], [99, -99], 1.5)
    expect([far.cx, far.cy]).toEqual([1.5, -0.5])
  })
  it('the radius handles set the radius from their distance to the middle, in long-edge units', () => {
    const { ux, uy } = units(2) // a 2:1 picture: the long edge is the width, so a unit of it is 1 wide and 2 tall
    expect([ux, uy]).toEqual([1, 2])
    near(moveEllipse(e, 'rx', [0.6, 0.5], [0.7, 0.5], 2).rx, 0.2)
    near(moveEllipse(e, 'ry', [0.5, 0.65], [0.5, 0.7], 2).ry, 0.1) // 0.2 of the height is 0.1 of the long edge
    const tall = units(0.5) // a tall picture: the height is the long edge
    expect([tall.ux, tall.uy]).toEqual([2, 1])
  })
  it('radii stay within their limits', () => {
    expect(moveEllipse(e, 'rx', [0.6, 0.5], [0.5, 0.5], 1).rx).toBe(MIN_RADIUS)
    expect(moveEllipse(e, 'rx', [0.6, 0.5], [9, 0.5], 1).rx).toBe(MAX_RADIUS)
    expect(moveEllipse(e, 'ry', [0.5, 0.65], [0.5, -9], 1).ry).toBe(MAX_RADIUS)
  })
  it('the handles sit on the ellipse: the middle, the right end and the bottom end', () => {
    const h = handlePositions(e, 1)
    expect(h.centre).toEqual([0.5, 0.5])
    near(h.rx[0], 0.6)
    near(h.ry[1], 0.65)
    // and dragging a handle to where it already is changes nothing
    const same = moveEllipse(e, 'rx', h.rx, h.rx, 1)
    near(same.rx, e.rx)
    near(moveEllipse(e, 'ry', h.ry, h.ry, 1).ry, e.ry)
  })
  it('moving the whole face takes every region along by the same amount', () => {
    const p = layoutFace([0.5, 0.5], 1.5)
    const m = moveWhole(p, 0.1, -0.05)
    for (const { key } of REGIONS) {
      near(m[key].cx - p[key].cx, 0.1)
      near(m[key].cy - p[key].cy, -0.05)
      expect([m[key].rx, m[key].ry]).toEqual([p[key].rx, p[key].ry])
    }
  })
})

describe('what counts as retouching', () => {
  const base = layoutFace([0.5, 0.5], 1.5)
  const edit = (f: (p: Portrait) => void): Portrait => {
    const p = JSON.parse(JSON.stringify(base)) as Portrait
    f(p)
    return p
  }
  it('any slider away from its neutral value makes it active, and the group helpers see it', () => {
    expect(portraitIsActive(edit((p) => (p.skin.evenAmount = 10)))).toBe(true)
    expect(portraitIsActive(edit((p) => (p.skin.contouring = -10)))).toBe(true)
    expect(portraitIsActive(edit((p) => (p.teeth.desaturation = 5)))).toBe(true)
    expect(portraitIsActive(edit((p) => (p.eyes.left.iris = -5)))).toBe(true)
    expect(skinIsDefault(edit((p) => (p.skin.blemishes = 1)))).toBe(false)
    expect(teethIsDefault(edit((p) => (p.teeth.brightness = 1)))).toBe(false)
    expect(eyesIsDefault(edit((p) => (p.eyes.right.sclera = 1)))).toBe(false)
  })
  it('impact and texture alone are not an edit: with impact at 0 the skin does nothing', () => {
    expect(portraitIsActive(edit((p) => (p.skin.evenTexture = 80)))).toBe(false)
    expect(portraitIsActive(edit((p) => { p.skin.impact = 0; p.skin.evenAmount = 100 }))).toBe(false)
    expect(skinIsDefault(edit((p) => (p.skin.impact = 40)))).toBe(false) // but it is not the default either
  })
})

describe('merging detected faces with the ones already there', () => {
  const aspect = 1.5
  const a = layoutFace([0.3, 0.5], aspect, 0.06)
  const b = layoutFace([0.7, 0.5], aspect, 0.06)
  it('a point inside a face is inside it, and one outside is not', () => {
    expect(insideFace(a, [0.3, 0.5], aspect)).toBe(true)
    expect(insideFace(a, [0.3, 0.9], aspect)).toBe(false)
    expect(insideFace(a, [0.9, 0.5], aspect)).toBe(false)
  })
  it('adds the faces that are new and leaves the existing ones exactly as they are', () => {
    const tuned = { ...a, skin: { ...a.skin, evenAmount: 60 } }
    const { merged, added } = mergeDetected([tuned], [layoutFace([0.3, 0.5], aspect, 0.06), b], aspect)
    expect(added).toBe(1)
    expect(merged).toHaveLength(2)
    expect(merged[0]).toBe(tuned) // the same object: nothing about it was touched
    expect(merged[1]).toBe(b)
  })
  it('a detected face that overlaps an existing one, even only by its middle, is not added again', () => {
    const slightlyOff = layoutFace([0.32, 0.51], aspect, 0.06)
    expect(mergeDetected([a], [slightlyOff], aspect).added).toBe(0)
    const bigAroundSmall = layoutFace([0.3, 0.5], aspect, 0.15)
    expect(mergeDetected([a], [bigAroundSmall], aspect).added).toBe(0)
  })
  it('nothing found, or everything already marked, adds nothing', () => {
    expect(mergeDetected([a, b], [], aspect)).toEqual({ merged: [a, b], added: 0 })
    expect(mergeDetected([a, b], [a, b], aspect).added).toBe(0)
  })
  it('faces found in one go are added each once, and a photo holds no more than its limit', () => {
    const row = Array.from({ length: 30 }, (_, i) => layoutFace([0.02 + (i % 15) * 0.065, i < 15 ? 0.3 : 0.7], aspect, 0.02))
    const { merged, added } = mergeDetected([], row, aspect)
    expect(merged.length).toBe(MAX_PORTRAITS)
    expect(added).toBe(MAX_PORTRAITS)
  })
  it('counts as retouching when any face has some', () => {
    const edited = { ...b, teeth: { ...b.teeth, brightness: 20 } }
    expect(anyPortraitActive([a, edited])).toBe(true)
    expect(anyPortraitActive([a, b])).toBe(false)
    expect(anyPortraitActive([])).toBe(false)
  })
})

describe('faces in the store', () => {
  beforeEach(() => {
    setApi(createMockApi(5))
    useDevelop.setState({ photoId: null, recipe: DEFAULT_RECIPE, saved: DEFAULT_RECIPE, history: [], portraitTool: false, selectedRegion: null, selectedFace: 0, detecting: false, faceNote: null, redEyeTool: false, spotTool: false, selectedMask: null, error: null, version: 0 })
  })

  it('marking a face adds it, selects it, ends the tool and is one history step; it survives leaving the photo', async () => {
    await useDevelop.getState().open(1)
    useDevelop.getState().setPortraitTool(true)
    await useDevelop.getState().markFace([0.5, 0.5], 1.5)
    const s = useDevelop.getState()
    expect(s.recipe.portraits).toHaveLength(1)
    expect(s.recipe.portraits[0].face).toMatchObject({ cx: 0.5, cy: 0.5 })
    expect([s.selectedFace, s.selectedRegion, s.portraitTool]).toEqual([0, 'face', false])
    expect(s.history[0].label).toBe('Mark face')
    await useDevelop.getState().open(1)
    expect(useDevelop.getState().recipe.portraits).toHaveLength(1)
    expect(useDevelop.getState().selectedRegion).toBeNull()
  })

  it('marking again adds a second face and selects it, leaving the first alone', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().markFace([0.3, 0.5], 1.5)
    useDevelop.getState().livePortrait((p) => ({ ...p, skin: { ...p.skin, evenAmount: 70 } }))
    await useDevelop.getState().commitPortrait('Skin: amount')
    await useDevelop.getState().markFace([0.7, 0.5], 1.5)
    const s = useDevelop.getState()
    expect(s.recipe.portraits).toHaveLength(2)
    expect(s.selectedFace).toBe(1)
    expect(s.recipe.portraits[0].skin.evenAmount).toBe(70)
    expect(s.recipe.portraits[1].skin.evenAmount).toBe(0)
  })

  it('sliders edit the selected face only, as named history steps; with no face they do nothing', async () => {
    await useDevelop.getState().open(1)
    useDevelop.getState().livePortrait((p) => ({ ...p, skin: { ...p.skin, blemishes: 90 } }))
    expect(useDevelop.getState().recipe.portraits).toHaveLength(0)
    await useDevelop.getState().markFace([0.3, 0.5], 1.5)
    await useDevelop.getState().markFace([0.7, 0.5], 1.5)
    useDevelop.getState().selectFace(0)
    useDevelop.getState().livePortrait((p) => ({ ...p, skin: { ...p.skin, blemishes: 90 } }))
    await useDevelop.getState().commitPortrait('Skin (face 1): blemishes')
    const { portraits } = useDevelop.getState().recipe
    expect([portraits[0].skin.blemishes, portraits[1].skin.blemishes]).toEqual([90, 0])
    expect(useDevelop.getState().history[0].label).toBe('Skin (face 1): blemishes')
  })

  it('selecting a face selects its face region, ignores an index that is not there, and keeps the region on a normal select', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().markFace([0.3, 0.5], 1.5)
    await useDevelop.getState().markFace([0.7, 0.5], 1.5)
    useDevelop.getState().selectRegion('mouth')
    useDevelop.getState().selectFace(0)
    expect(useDevelop.getState()).toMatchObject({ selectedFace: 0, selectedRegion: 'face' })
    useDevelop.getState().selectFace(5)
    useDevelop.getState().selectFace(-1)
    expect(useDevelop.getState().selectedFace).toBe(0)
    useDevelop.getState().selectRegion('leftEye')
    expect(useDevelop.getState()).toMatchObject({ selectedFace: 0, selectedRegion: 'leftEye' })
  })

  it('detecting faces adds each one found, selects the first new one and is one history step', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().detectFaces()
    const s = useDevelop.getState()
    expect(s.recipe.portraits).toHaveLength(3)
    expect([s.selectedFace, s.selectedRegion, s.detecting]).toEqual([0, 'face', false])
    expect(s.faceNote).toBe('3 faces found.')
    expect(s.history[0]).toMatchObject({ label: 'Detect faces', valueText: '3 found' })
    for (const p of s.recipe.portraits) expect(portraitIsActive(p)).toBe(false) // found, not retouched
  })

  it('auto retouch finds the faces, gives each a light retouch and is one history step', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().autoRetouch()
    const s = useDevelop.getState()
    expect(s.recipe.portraits).toHaveLength(3)
    for (const p of s.recipe.portraits) {
      expect(portraitIsActive(p)).toBe(true)
      expect(p.skin.evenAmount).toBe(45)
      expect(p.skin.blemishes).toBe(85)
    }
    expect(s.history[0]).toMatchObject({ label: 'Auto retouch' })
  })

  it('detecting again keeps the faces and their sliders, and says nothing new was found', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().detectFaces()
    useDevelop.getState().selectFace(1)
    useDevelop.getState().livePortrait((p) => ({ ...p, teeth: { ...p.teeth, brightness: 40 } }))
    await useDevelop.getState().commitPortrait('Teeth (face 2): brightness')
    const before = useDevelop.getState().history.length
    await useDevelop.getState().detectFaces()
    const s = useDevelop.getState()
    expect(s.recipe.portraits).toHaveLength(3)
    expect(s.recipe.portraits[1].teeth.brightness).toBe(40)
    expect(s.faceNote).toBe('No new faces: the faces found are already marked.')
    expect(s.history.length).toBe(before) // no step for nothing
  })

  it('a hand-marked face is not duplicated by a detection, and a detection adds around it', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().markFace([0.5, 0.4], 1.5) // where the second detected face is
    await useDevelop.getState().detectFaces()
    const s = useDevelop.getState()
    expect(s.recipe.portraits).toHaveLength(3) // the marked one plus the two others
    expect(s.faceNote).toBe('2 faces found.')
  })

  it('a photo with no faces says so and changes nothing', async () => {
    setApi(createMockApi(5, { noFaces: true })) // a detector that finds nothing
    await useDevelop.getState().open(1)
    await useDevelop.getState().detectFaces()
    const s = useDevelop.getState()
    expect(s.recipe.portraits).toHaveLength(0)
    expect(s.faceNote).toMatch(/No faces found/)
    expect(s.history).toHaveLength(0)
  })

  it('a failed search says why and is not an edit', async () => {
    await useDevelop.getState().open(1)
    const api = (await import('./api')).api()
    const original = api.portraitDetect
    api.portraitDetect = async () => {
      throw new Error('This photo has no preview to look at yet.')
    }
    await useDevelop.getState().detectFaces()
    api.portraitDetect = original
    expect(useDevelop.getState().faceNote).toBe('This photo has no preview to look at yet.')
    expect(useDevelop.getState().detecting).toBe(false)
    expect(useDevelop.getState().recipe.portraits).toHaveLength(0)
  })

  it('deleting a face keeps the others, moves the selection sensibly and is a history step', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().detectFaces()
    useDevelop.getState().selectFace(2)
    await useDevelop.getState().deleteFace(2)
    expect(useDevelop.getState().recipe.portraits).toHaveLength(2)
    expect(useDevelop.getState().selectedFace).toBe(1) // not left pointing past the end
    expect(useDevelop.getState().history[0].label).toBe('Delete face 3')
    await useDevelop.getState().deleteFace(0)
    await useDevelop.getState().deleteFace(0)
    expect(useDevelop.getState().recipe.portraits).toHaveLength(0)
    expect(useDevelop.getState().selectedRegion).toBeNull()
    await useDevelop.getState().deleteFace(0) // nothing there: nothing happens
    expect(useDevelop.getState().recipe.portraits).toHaveLength(0)
  })

  it('copy to all faces gives every face the settings of the selected one and keeps their regions', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().detectFaces()
    useDevelop.getState().selectFace(1)
    useDevelop.getState().livePortrait((p) => ({ ...p, skin: { ...p.skin, evenAmount: 55, impact: 80 }, teeth: { brightness: 25, desaturation: 10 }, eyes: { ...p.eyes, left: { iris: 30, sclera: 20 } } }))
    await useDevelop.getState().commitPortrait('settings')
    const regions = useDevelop.getState().recipe.portraits.map((p) => p.face)
    await useDevelop.getState().copyToAllFaces()
    const after = useDevelop.getState().recipe.portraits
    for (const p of after) {
      expect(p.skin).toMatchObject({ evenAmount: 55, impact: 80 })
      expect(p.teeth).toEqual({ brightness: 25, desaturation: 10 })
      expect(p.eyes.left).toEqual({ iris: 30, sclera: 20 })
    }
    expect(after.map((p) => p.face)).toEqual(regions)
    expect(after[0].eyes).not.toBe(after[1].eyes) // each face has its own copy
    expect(useDevelop.getState().history[0].label).toBe('Copy retouch to all faces')
  })

  it('clearing removes every face', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().detectFaces()
    await useDevelop.getState().clearPortraits()
    expect(useDevelop.getState().recipe.portraits).toHaveLength(0)
    expect(useDevelop.getState()).toMatchObject({ selectedRegion: null, selectedFace: 0 })
    expect(useDevelop.getState().history[0].label).toBe('Clear faces')
  })

  it('the portrait tool takes turns with the other local tools, and framing', async () => {
    await useDevelop.getState().open(1)
    useDevelop.getState().setSpotTool(true)
    useDevelop.getState().setPortraitTool(true)
    expect(useDevelop.getState()).toMatchObject({ portraitTool: true, spotTool: false })
    useDevelop.getState().setRedEyeTool(true)
    expect(useDevelop.getState()).toMatchObject({ portraitTool: false, redEyeTool: true })
    useDevelop.getState().setPortraitTool(true)
    expect(useDevelop.getState().redEyeTool).toBe(false)
    useDevelop.getState().setSpotTool(true)
    expect(useDevelop.getState().portraitTool).toBe(false)
    useDevelop.getState().setPortraitTool(true)
    await useDevelop.getState().addMask('radial')
    expect(useDevelop.getState().portraitTool).toBe(false)
    useDevelop.getState().setPortraitTool(true)
    useDevelop.getState().setCropEdit(true)
    expect(useDevelop.getState().portraitTool).toBe(false)
  })

  it('faces are an edit, belong to one photo, and are not carried by a copy or a preset', async () => {
    const p = layoutFace([0.5, 0.5], 1.5)
    const r = { ...DEFAULT_RECIPE, portraits: [p] }
    expect(recipesEqual(r, DEFAULT_RECIPE)).toBe(false)
    expect(recipesEqual(r, { ...DEFAULT_RECIPE, portraits: [JSON.parse(JSON.stringify(p))] })).toBe(true)
    expect(recipesEqual(r, { ...DEFAULT_RECIPE, portraits: [{ ...p, skin: { ...p.skin, evenAmount: 1 } }] })).toBe(false)
    expect(recipesEqual(r, { ...DEFAULT_RECIPE, portraits: [p, p] })).toBe(false)
    expect(applyGroups(DEFAULT_RECIPE, r, ALL_GROUPS).portraits).toEqual([])
  })

  it('opening another photo forgets which face was selected and any search note', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().detectFaces()
    useDevelop.getState().selectFace(2)
    await useDevelop.getState().open(2)
    expect(useDevelop.getState()).toMatchObject({ selectedFace: 0, faceNote: null, selectedRegion: null })
  })
})
