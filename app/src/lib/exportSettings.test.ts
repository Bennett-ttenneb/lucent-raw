import { beforeEach, describe, expect, it } from 'vitest'
import { BUILTIN_EXPORT_PRESETS, DEFAULT_EXPORT, colourOf, deleteUserPreset, edgeIsValid, exportProblem, folderProblem, hexOf, loadFolderPref, saveFolderPref, suggestedFolderName, loadLastExport, loadUserPresets, matchingPreset, normaliseSettings, saveLastExport, saveUserPreset } from './exportSettings'

/** The same literal is in the core's tests (export.rs): the page and the core must agree on the starting settings. */
const CORE_DEFAULTS = {
  format: 'jpeg',
  quality: 85,
  longEdge: 2048,
  sizeMode: 'longEdge',
  width: 2048,
  height: 2048,
  percent: 50,
  megapixels: 4,
  dpi: 300,
  colourSpace: 'srgb',
  nameTemplate: '{name}',
  sharpen: 'none',
  enlarge: 'none',
  cameraInfo: true,
  metadata: 'none',
  watermark: { kind: 'none', text: '© Your name', imagePath: '', anchor: 'bottomRight', size: 3, opacity: 70, margin: 2, colour: [255, 255, 255], shadow: true },
  border: { enabled: false, width: 4, colour: [255, 255, 255], caption: { show: false, camera: true, lens: true, focal: true, aperture: true, shutter: true, iso: true, date: false, note: '', layout: 'grouped', separator: 'dot', spacing: 2, weight: 'regular', size: 1.6 }, captionColour: null },
}

describe('the starting settings', () => {
  it('are the ones the core starts with', () => {
    expect(DEFAULT_EXPORT).toEqual(CORE_DEFAULTS)
  })
})

describe('making stored settings safe', () => {
  it('nothing, rubbish and the wrong kinds of value all give the defaults', () => {
    for (const bad of [null, undefined, 5, 'text', [], { format: 7, quality: 'high', watermark: 'yes', border: [] }]) expect(normaliseSettings(bad)).toEqual(DEFAULT_EXPORT)
  })
  it('keeps what is good and fixes what is not, field by field', () => {
    const s = normaliseSettings({ format: 'tiff', quality: 500, longEdge: -20, colourSpace: 'cmyk', sharpen: 'print', nameTemplate: '   ', watermark: { kind: 'text', text: 'Mine', opacity: 900, anchor: 'nowhere', colour: [300, -4, 'x'] }, border: { enabled: true, width: 99, colour: [1, 2, 3], caption: { show: true, iso: false, note: 'hi' } } })
    expect(s).toMatchObject({ format: 'tiff', quality: 100, longEdge: 0, colourSpace: 'srgb', sharpen: 'print', nameTemplate: '{name}' })
    expect(s.watermark).toMatchObject({ kind: 'text', text: 'Mine', opacity: 100, anchor: 'bottomRight', colour: [255, 255, 255] })
    expect(s.border).toMatchObject({ enabled: true, width: 30, colour: [1, 2, 3] })
    expect(s.border.caption).toMatchObject({ show: true, iso: false, camera: true, note: 'hi' })
  })
  it('the enlarge choice is none, smooth or ai, and anything else is none', () => {
    expect(normaliseSettings({ enlarge: 'ai' }).enlarge).toBe('ai')
    expect(normaliseSettings({ enlarge: 'smooth' }).enlarge).toBe('smooth')
    for (const bad of ['magic', 3, null, undefined, {}]) expect(normaliseSettings({ enlarge: bad }).enlarge).toBe('none')
  })
  it('camera details are kept unless they are switched off, and anything that is not true or false is kept', () => {
    expect(normaliseSettings({}).cameraInfo).toBe(true)
    expect(normaliseSettings({ cameraInfo: false }).cameraInfo).toBe(false)
    for (const bad of ['no', 0, null, {}]) expect(normaliseSettings({ cameraInfo: bad }).cameraInfo).toBe(true)
  })
  it('colours are whole numbers from 0 to 255', () => {
    expect(normaliseSettings({ border: { colour: [10.6, 255, 0] } }).border.colour).toEqual([11, 255, 0])
    expect(normaliseSettings({ border: { captionColour: [0, 0, 0] } }).border.captionColour).toEqual([0, 0, 0])
    expect(normaliseSettings({ border: { captionColour: 'red' } }).border.captionColour).toEqual([0, 0, 0])
    expect(normaliseSettings({ border: { captionColour: null } }).border.captionColour).toBeNull()
  })
  it('does not share anything with the defaults, so changing one cannot change the other', () => {
    const s = normaliseSettings({})
    s.watermark.colour[0] = 1
    s.border.caption.note = 'x'
    expect(DEFAULT_EXPORT.watermark.colour[0]).toBe(255)
    expect(DEFAULT_EXPORT.border.caption.note).toBe('')
  })
})

describe('what the dialog checks', () => {
  it('the size box takes whole numbers from 0 to 20000 and nothing else, an empty box included', () => {
    for (const ok of ['0', '1', '2048', '20000', ' 800 ']) expect(edgeIsValid(ok)).toBe(true)
    for (const bad of ['', '  ', '-5', '20001', '1.5', 'abc', '1e3x']) expect(edgeIsValid(bad)).toBe(false)
  })
  it('a logo watermark needs a logo; every other combination is fine', () => {
    expect(exportProblem(DEFAULT_EXPORT)).toBeNull()
    expect(exportProblem({ ...DEFAULT_EXPORT, watermark: { ...DEFAULT_EXPORT.watermark, kind: 'image' } })).toMatch(/Choose the image/)
    expect(exportProblem({ ...DEFAULT_EXPORT, watermark: { ...DEFAULT_EXPORT.watermark, kind: 'image', imagePath: 'C:/logo.png' } })).toBeNull()
    expect(exportProblem({ ...DEFAULT_EXPORT, watermark: { ...DEFAULT_EXPORT.watermark, kind: 'text', text: '' } })).toBeNull()
  })
  it('colours go to and from the colour box', () => {
    expect(hexOf([255, 0, 128])).toBe('#ff0080')
    expect(colourOf('#ff0080')).toEqual([255, 0, 128])
    expect(colourOf('00ff00')).toEqual([0, 255, 0])
    expect(colourOf('nonsense')).toEqual([255, 255, 255])
    expect(colourOf(hexOf([12, 34, 56]))).toEqual([12, 34, 56])
  })
})

describe('presets', () => {
  beforeEach(() => localStorage.clear())

  it('the built-in ones have their own names, are safe as they stand and do what they say', () => {
    const names = BUILTIN_EXPORT_PRESETS.map((p) => p.name)
    expect(new Set(names).size).toBe(names.length)
    for (const p of BUILTIN_EXPORT_PRESETS) expect(normaliseSettings(p.settings)).toEqual(p.settings)
    const by = (n: string) => BUILTIN_EXPORT_PRESETS.find((p) => p.name.startsWith(n))!.settings
    expect(by('Print')).toMatchObject({ format: 'tiff', longEdge: 0, colourSpace: 'adobeRgb', sharpen: 'print' })
    expect(by('Archive')).toMatchObject({ format: 'png', longEdge: 0 })
    expect(by('Client proofs').watermark).toMatchObject({ kind: 'text', text: 'PROOF', anchor: 'centre', opacity: 30 })
    expect(by('Portfolio').border).toMatchObject({ enabled: true })
    expect(by('Portfolio').border.caption.show).toBe(true)
    expect(by('Social media')).toMatchObject({ longEdge: 1080 })
    expect(by('Social media').border.enabled).toBe(true)
    expect(by('Web')).toMatchObject({ format: 'jpeg', longEdge: 2048, sharpen: 'screen' })
  })

  it('the last settings come back, and a damaged store gives the defaults', () => {
    expect(loadLastExport()).toEqual(DEFAULT_EXPORT)
    const mine = normaliseSettings({ format: 'webp', longEdge: 1200, watermark: { kind: 'text', text: 'Hi' } })
    saveLastExport(mine)
    expect(loadLastExport()).toEqual(mine)
    localStorage.setItem('penumbra.exportLast', '{not json')
    expect(loadLastExport()).toEqual(DEFAULT_EXPORT)
  })

  it('your own presets are saved by name, replaced by the same name (any case), and deleted', () => {
    expect(loadUserPresets()).toEqual([])
    const a = normaliseSettings({ format: 'png' })
    const b = normaliseSettings({ format: 'tiff' })
    saveUserPreset('  Weddings  ', a)
    expect(loadUserPresets().map((p) => p.name)).toEqual(['Weddings'])
    saveUserPreset('weddings', b)
    expect(loadUserPresets()).toHaveLength(1)
    expect(loadUserPresets()[0].settings.format).toBe('tiff')
    saveUserPreset('Street', a)
    expect(loadUserPresets().map((p) => p.name)).toEqual(['weddings', 'Street'])
    saveUserPreset('   ', a) // no name, nothing saved
    expect(loadUserPresets()).toHaveLength(2)
    expect(deleteUserPreset('Street').map((p) => p.name)).toEqual(['weddings'])
    expect(deleteUserPreset('not there')).toHaveLength(1)
  })

  it('a preset in storage that is damaged is dropped or repaired, never a crash', () => {
    localStorage.setItem('penumbra.exportPresets', JSON.stringify([{ name: 'Good', settings: { format: 'png' } }, { name: '', settings: {} }, { settings: {} }, 7, null, { name: 'Odd', settings: 'text' }]))
    const list = loadUserPresets()
    expect(list.map((p) => p.name)).toEqual(['Good', 'Odd'])
    expect(list[0].settings.format).toBe('png')
    expect(list[1].settings).toEqual(DEFAULT_EXPORT)
    localStorage.setItem('penumbra.exportPresets', 'garbage')
    expect(loadUserPresets()).toEqual([])
  })

  it('knows which preset the settings are, and none when they have been changed', () => {
    const web = BUILTIN_EXPORT_PRESETS[0].settings
    expect(matchingPreset(web, [])).toBe(BUILTIN_EXPORT_PRESETS[0].name)
    expect(matchingPreset({ ...web, quality: 84 }, [])).toBeNull()
    const mine = saveUserPreset('Mine', { ...web, quality: 70 })
    expect(matchingPreset({ ...web, quality: 70 }, mine)).toBe('Mine')
  })

  it('a new folder name is checked by the same rules as the core, and the choice is remembered', () => {
    expect(folderProblem('Wedding 2026')).toBeNull()
    expect(folderProblem('  Day 1. ')).toBeNull()
    for (const bad of ['', '   ', '..', 'a/b', 'a' + String.fromCharCode(92) + 'b', 'C:x', 'x*', 'a?b', 'a|b', 'q"', '<a>', 'CON', 'nul.txt', 'com1', 'LPT9']) expect(folderProblem(bad), bad).not.toBeNull()
    expect(folderProblem('COM10')).toBeNull()
    expect(folderProblem('a'.repeat(101))).not.toBeNull()
    expect(folderProblem('a'.repeat(100))).toBeNull()
    expect(suggestedFolderName(new Date(2026, 4, 7))).toBe('Lucent Raw export 2026-05-07')
    expect(loadFolderPref()).toEqual({ on: false, name: suggestedFolderName() })
    saveFolderPref({ on: true, name: 'Proofs' })
    expect(loadFolderPref()).toEqual({ on: true, name: 'Proofs' })
    localStorage.setItem('penumbra.exportFolder', '{no')
    expect(loadFolderPref().on).toBe(false)
  })
})
