import { beforeEach, describe, expect, it } from 'vitest'
import { setApi } from './api'
import { DEFAULT_RECIPE, isDefault, recipesEqual, useDevelop } from './develop'
import { createMockApi } from './mockApi'
import { ALL_GROUPS, BUILTIN_PRESETS, DEFAULT_COPY_GROUPS, SETTING_GROUPS, applyGroups, changedGroups, isBuiltin } from './presets'
import type { Recipe } from './types'

const look: Recipe = {
  ...DEFAULT_RECIPE,
  temperature: 20,
  exposure: 0.5,
  vibrance: 30,
  curve: [[128, 150]],
  hsl: { ...DEFAULT_RECIPE.hsl, sat: [-20, 0, 0, 0, 0, 0, 0, 0] },
  detail: { ...DEFAULT_RECIPE.detail, sharpAmount: 40, nrLuma: 20 },
  effects: { ...DEFAULT_RECIPE.effects, vignetteAmount: -30, grainAmount: 20 },
  crop: { aspect: '3:2', angle: 1, rect: null },
}

describe('setting groups', () => {
  it('applying all groups gives the source, applying none changes nothing', () => {
    expect(recipesEqual(applyGroups(DEFAULT_RECIPE, look, ALL_GROUPS), look)).toBe(true)
    expect(recipesEqual(applyGroups(look, DEFAULT_RECIPE, []), look)).toBe(true)
  })
  it('applies only the named groups and leaves the rest of the photo alone', () => {
    const base: Recipe = { ...DEFAULT_RECIPE, contrast: 55, saturation: -10 }
    const out = applyGroups(base, look, ['tone'])
    expect(out.exposure).toBe(0.5)
    expect(out.contrast).toBe(0) // tone is replaced as a whole, so the old contrast goes
    expect(out.saturation).toBe(-10) // presence was not asked for
    expect(out.vibrance).toBe(0)
    expect(out.crop).toEqual(DEFAULT_RECIPE.crop)
  })
  it('sharpening and noise reduction are separate groups of the detail panel', () => {
    const sharp = applyGroups(DEFAULT_RECIPE, look, ['sharpening'])
    expect([sharp.detail.sharpAmount, sharp.detail.nrLuma]).toEqual([40, 0])
    const noise = applyGroups(DEFAULT_RECIPE, look, ['noise'])
    expect([noise.detail.sharpAmount, noise.detail.nrLuma]).toEqual([0, 20])
  })
  it('effects are one group and a preset can carry them', () => {
    const out = applyGroups(DEFAULT_RECIPE, look, ['effects'])
    expect([out.effects.vignetteAmount, out.effects.grainAmount, out.effects.vignetteMidpoint]).toEqual([-30, 20, 50])
    expect(out.detail.sharpAmount).toBe(0)
    const old = BUILTIN_PRESETS.find((p) => p.name === 'Old print')!
    expect(old.groups).toContain('effects')
    expect(old.recipe.effects.vignetteAmount).toBeLessThan(0)
  })
  it('never shares arrays with the source, so a later edit cannot change a preset', () => {
    const out = applyGroups(DEFAULT_RECIPE, look, ['curve', 'mixer'])
    out.curve.push([10, 10])
    out.hsl.sat[0] = 99
    expect(look.curve).toHaveLength(1)
    expect(look.hsl.sat[0]).toBe(-20)
  })
  it('reports which groups a recipe has changed', () => {
    expect(changedGroups(DEFAULT_RECIPE)).toEqual([])
    expect(changedGroups(look)).toEqual(['whiteBalance', 'tone', 'presence', 'curve', 'mixer', 'sharpening', 'noise', 'effects', 'crop'])
    expect(changedGroups({ ...DEFAULT_RECIPE, saturation: 5 })).toEqual(['presence'])
  })
  it('the group ids match what the core accepts', () => {
    expect(SETTING_GROUPS.map((g) => g.id)).toEqual(['whiteBalance', 'profile', 'tone', 'presence', 'curve', 'mixer', 'grading', 'calibration', 'sharpening', 'noise', 'effects', 'geometry', 'crop'])
  })
  it('lens and transform are a group of their own, left out of a copy by default like the crop', () => {
    expect(DEFAULT_COPY_GROUPS).not.toContain('geometry')
    expect(DEFAULT_COPY_GROUPS).not.toContain('crop')
    const g = { ...DEFAULT_RECIPE, geometry: { ...DEFAULT_RECIPE.geometry, rotate: 2.5, vertical: 30 } }
    expect(applyGroups(DEFAULT_RECIPE, g, ['geometry']).geometry).toEqual(g.geometry)
    expect(applyGroups(DEFAULT_RECIPE, g, ['tone']).geometry).toEqual(DEFAULT_RECIPE.geometry)
    expect(changedGroups(g)).toEqual(['geometry'])
  })
})

describe('built-in presets', () => {
  it('have unique names and negative ids, and every change sits inside the groups they claim', () => {
    expect(new Set(BUILTIN_PRESETS.map((p) => p.name)).size).toBe(BUILTIN_PRESETS.length)
    for (const p of BUILTIN_PRESETS) {
      expect(isBuiltin(p)).toBe(true)
      expect(p.groups.length).toBeGreaterThan(0)
      expect(isDefault(p.recipe)).toBe(false)
      const inside = changedGroups(p.recipe).every((g) => p.groups.includes(g))
      expect(inside, p.name).toBe(true)
    }
  })
})

describe('presets and snapshots in the store', () => {
  beforeEach(() => {
    setApi(createMockApi(5))
    useDevelop.setState({ photoId: null, recipe: DEFAULT_RECIPE, saved: DEFAULT_RECIPE, history: [], presets: [], snapshots: [], hover: null, clipboard: null, error: null, version: 0 })
  })

  it('lists the built-in presets first and applying one is one history step', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().loadPresets()
    expect(useDevelop.getState().presets.length).toBe(BUILTIN_PRESETS.length)
    const bw = useDevelop.getState().presets.find((p) => p.name === 'Black and white')!
    await useDevelop.getState().applyPreset(bw)
    expect(useDevelop.getState().recipe.saturation).toBe(-100)
    expect(useDevelop.getState().history[0].label).toBe('Preset: Black and white')
  })

  it('a preset leaves settings outside its groups alone', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().setAndCommit({ tint: 12 }, { label: 'Tint', deltaText: null, valueText: null })
    const cool = BUILTIN_PRESETS.find((p) => p.name === 'Open shadows')!
    await useDevelop.getState().applyPreset(cool)
    expect(useDevelop.getState().recipe).toMatchObject({ tint: 12, shadows: 60 })
  })

  it('hovering a preset previews it without saving, and leaving clears it', async () => {
    await useDevelop.getState().open(1)
    const p = BUILTIN_PRESETS[0]
    useDevelop.getState().previewPreset(p)
    expect(useDevelop.getState().hover?.contrast).toBe(25)
    expect(isDefault(useDevelop.getState().recipe)).toBe(true)
    expect(useDevelop.getState().history).toHaveLength(0)
    useDevelop.getState().previewPreset(null)
    expect(useDevelop.getState().hover).toBeNull()
  })

  it('creates, lists and deletes the user\'s own preset, and refuses a repeat name', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().setAndCommit({ exposure: 0.6, saturation: 15 }, { label: 'Look', deltaText: null, valueText: null })
    await useDevelop.getState().createPreset('My look', null, ['tone', 'presence'])
    let mine = useDevelop.getState().presets.filter((p) => !isBuiltin(p))
    expect(mine.map((p) => [p.name, p.group])).toEqual([['My look', 'User Presets']])
    await expect(useDevelop.getState().createPreset('my LOOK', null, ['tone'])).rejects.toThrow(/already exists/)
    await expect(useDevelop.getState().createPreset('x', null, [])).rejects.toThrow(/at least one/)
    await useDevelop.getState().deletePreset(mine[0].id)
    mine = useDevelop.getState().presets.filter((p) => !isBuiltin(p))
    expect(mine).toHaveLength(0)
  })

  it('snapshots belong to the photo, apply as a history step, and can be deleted', async () => {
    await useDevelop.getState().open(1)
    await useDevelop.getState().setAndCommit({ contrast: 35 }, { label: 'Contrast', deltaText: null, valueText: null })
    await useDevelop.getState().createSnapshot('Before colour')
    await useDevelop.getState().setAndCommit({ contrast: 0, saturation: 40 }, { label: 'Other', deltaText: null, valueText: null })
    const [snap] = useDevelop.getState().snapshots
    expect(snap.name).toBe('Before colour')
    await useDevelop.getState().applySnapshot(snap)
    expect(useDevelop.getState().recipe).toMatchObject({ contrast: 35, saturation: 0 })
    expect(useDevelop.getState().history[0].label).toBe('Snapshot: Before colour')
    await useDevelop.getState().open(2)
    expect(useDevelop.getState().snapshots).toEqual([])
    await useDevelop.getState().open(1)
    expect(useDevelop.getState().snapshots).toHaveLength(1)
    await useDevelop.getState().deleteSnapshot(snap.id)
    expect(useDevelop.getState().snapshots).toEqual([])
  })

  it('an empty snapshot name is refused', async () => {
    await useDevelop.getState().open(1)
    await expect(useDevelop.getState().createSnapshot('   ')).rejects.toThrow(/name of 1 to 100/)
  })
})

describe('the added built-in presets', () => {
  const by = (name: string) => BUILTIN_PRESETS.find((p) => p.name === name)!

  it('come in their own groups, with the others still under Lucent Raw', () => {
    const groups = (g: string) => BUILTIN_PRESETS.filter((p) => p.group === g).map((p) => p.name)
    expect(groups('Black and white')).toEqual(['High contrast', 'Soft and airy', 'Film grain'])
    expect(groups('People')).toEqual(['Warm portrait', 'Bright and airy'])
    expect(groups('Landscape')).toEqual(['Golden hour', 'Cool landscape', 'Crisp detail'])
    expect(groups('Mood')).toEqual(['Moody', 'Cinematic'])
    expect(groups('Lucent Raw')).toHaveLength(8)
    expect(BUILTIN_PRESETS).toHaveLength(18)
    expect(new Set(BUILTIN_PRESETS.map((p) => p.id)).size).toBe(18)
  })

  it('the black and white ones remove all colour, and the others keep some', () => {
    for (const n of ['High contrast', 'Soft and airy', 'Film grain']) expect(by(n).recipe.saturation, n).toBe(-100)
    for (const n of ['Warm portrait', 'Golden hour', 'Cool landscape', 'Cinematic']) expect(by(n).recipe.saturation, n).toBeGreaterThanOrEqual(0)
  })

  it('do what their names say', () => {
    expect(by('Warm portrait').recipe.temperature).toBeGreaterThan(0)
    expect(by('Golden hour').recipe.temperature).toBeGreaterThan(by('Warm portrait').recipe.temperature)
    expect(by('Cool landscape').recipe.temperature).toBeLessThan(0)
    expect(by('Bright and airy').recipe.exposure).toBeGreaterThan(0)
    expect(by('Moody').recipe.exposure).toBeLessThan(0)
    expect(by('Moody').recipe.effects.vignetteAmount).toBeLessThan(0)
    expect(by('Film grain').recipe.effects.grainAmount).toBeGreaterThan(0)
    expect(by('Crisp detail').recipe.detail.sharpAmount).toBeGreaterThan(by('Punchy').recipe.detail.sharpAmount)
    expect(by('Cinematic').recipe.hsl.sat[1]).toBeGreaterThan(0) // oranges richer
    expect(by('Cinematic').recipe.hsl.sat[3]).toBeLessThan(0) // greens quieter
  })

  it('apply only their own groups: a colour look leaves the sharpening and the crop of the photo alone', () => {
    const photo = { ...DEFAULT_RECIPE, detail: { ...DEFAULT_RECIPE.detail, sharpAmount: 70 }, crop: { aspect: '1:1' as const, angle: 2, rect: null } }
    const p = by('Golden hour')
    const out = applyGroups(photo, p.recipe, p.groups)
    expect(out.detail.sharpAmount).toBe(70)
    expect(out.crop).toEqual(photo.crop)
    expect(out.temperature).toBe(p.recipe.temperature)
  })
})
