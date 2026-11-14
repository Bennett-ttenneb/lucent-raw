import { describe, expect, it } from 'vitest'
import { reframeRecipe, turnRecipe, type TurnOp } from './localmap'
import { wheelPoint, wheelValue } from '../components/Grading'
import { DEFAULT_RECIPE, type Mask, type Portrait, type Recipe } from './types'

const adjust = {} as Mask['adjust']
const mask = (shape: Mask['shape']): Mask => ({ id: 'm', name: 'M', visible: true, invert: false, shape, parts: [], adjust })
const face = { cx: 0.3, cy: 0.4, rx: 0.1, ry: 0.15 }
const eye = { iris: 0, sclera: 0 }
const person: Portrait = { face, leftEye: face, rightEye: face, mouth: face, skin: { impact: 0, blemishes: 0, darkCircles: 0, evenAmount: 0, evenTexture: 0, contouring: 0, radius: 40, body: 0, tone: 0, shine: 0, colour: 0, glow: 0, crisp: 0 }, teeth: { brightness: 0, desaturation: 0 }, eyes: { both: eye, left: eye, right: eye }, roll: 0, yaw: 0, pitch: 0, lips: 0, brows: 0 }

const recipe = (): Recipe => ({
  ...DEFAULT_RECIPE,
  masks: [
    mask({ type: 'linear', x1: 0.1, y1: 0.2, x2: 0.7, y2: 0.4, feather: 0.5 }),
    mask({ type: 'radial', cx: 0.25, cy: 0.75, rx: 0.2, ry: 0.1, angle: 30, feather: 0.4 }),
    mask({ type: 'brush', strokes: [{ erase: false, size: 0.05, feather: 0.5, flow: 1, points: [[0.1, 0.1], [0.9, 0.5]] }] }),
    mask({ type: 'luminance', lo: 0.6, hi: 1, smooth: 0.3 }),
  ],
  spots: [{ id: 's', visible: true, mode: 'heal', x: 0.2, y: 0.3, sx: 0.4, sy: 0.35, size: 0.04, feather: 0.5, opacity: 1 }],
  redEyes: [{ id: 'r', x: 0.6, y: 0.2, size: 0.03, darken: 0.5 }],
  portraits: [person],
})

const close = (a: unknown, b: unknown) => expect(JSON.parse(JSON.stringify(a), (_k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v))).toEqual(JSON.parse(JSON.stringify(b), (_k, v) => (typeof v === 'number' ? Math.round(v * 1e6) / 1e6 : v)))

describe('carrying the edits along when the picture is turned or flipped', () => {
  const base: Recipe = { ...recipe(), portraits: [] }

  it('moves each point to where it is after a quarter turn', () => {
    const r = turnRecipe(base, 'right')
    expect(r.geometry.quarterTurns).toBe(1)
    expect([r.spots[0].x, r.spots[0].y]).toEqual([0.7, 0.2]) // (x, y) goes to (1 - y, x)
    expect([r.spots[0].sx, r.spots[0].sy]).toEqual([0.65, 0.4])
    expect([r.redEyes[0].x, r.redEyes[0].y]).toEqual([0.8, 0.6])
    const lin = r.masks[0].shape as Extract<Mask['shape'], { type: 'linear' }>
    expect([lin.x1, lin.y1, lin.x2, lin.y2]).toEqual([0.8, 0.1, 0.6, 0.7])
    const rad = r.masks[1].shape as Extract<Mask['shape'], { type: 'radial' }>
    expect([rad.cx, rad.cy, rad.angle, rad.rx, rad.ry]).toEqual([0.25, 0.25, 120, 0.2, 0.1])
    const brush = r.masks[2].shape as Extract<Mask['shape'], { type: 'brush' }>
    expect(brush.strokes[0].points).toEqual([[0.9, 0.1], [0.5, 0.9]])
    expect(r.masks[3].shape).toEqual(base.masks[3].shape) // a brightness mask has no place to carry
    expect(r.spots[0].size).toBe(0.04)
  })

  it('left undoes right, and four turns or two flips bring everything back', () => {
    const ops: TurnOp[][] = [['right', 'left'], ['left', 'right'], ['right', 'right', 'right', 'right'], ['flipH', 'flipH'], ['flipV', 'flipV'], ['right', 'flipH', 'flipH', 'left']]
    for (const seq of ops) {
      const out = seq.reduce((r, op) => turnRecipe(r, op), base)
      close({ ...out, geometry: base.geometry }, base)
    }
  })

  it('flips mirror the positions and the angles', () => {
    const h = turnRecipe(base, 'flipH')
    expect(h.geometry.mirror).toBe(true)
    expect([h.spots[0].x, h.spots[0].y]).toEqual([0.8, 0.3])
    expect((h.masks[1].shape as { angle: number }).angle).toBe(-30)
    const v = turnRecipe(base, 'flipV')
    expect([v.spots[0].x, v.spots[0].y]).toEqual([0.2, 0.7])
  })

  it('turns the crop frame with the picture instead of throwing it away, and swaps a fixed ratio', () => {
    const framed: Recipe = { ...base, crop: { aspect: '3:2', angle: 5, rect: { cx: 0.3, cy: 0.5, w: 0.5, h: 0.4 } } }
    const r = turnRecipe(framed, 'right')
    expect(r.crop.rect).toEqual({ cx: 0.5, cy: 0.3, w: 0.4, h: 0.5 })
    expect(r.crop.aspect).toBe('2:3')
    expect(r.crop.angle).toBe(5)
    expect(turnRecipe(framed, 'flipH').crop.angle).toBe(-5)
    expect(turnRecipe(framed, 'flipH').crop.aspect).toBe('3:2')
  })

  it('swaps the two radii of a face, and carries it', () => {
    const withFace: Recipe = { ...recipe() }
    const r = turnRecipe(withFace, 'right')
    expect(r.portraits[0].face).toEqual({ cx: 0.6, cy: 0.3, rx: 0.15, ry: 0.1 })
    expect(turnRecipe(withFace, 'flipH').portraits[0].face).toEqual({ cx: 0.7, cy: 0.4, rx: 0.1, ry: 0.15 })
  })
})

describe('carrying the edits along when the crop frame changes', () => {
  it('keeps each edit on the same part of the picture', () => {
    const r: Recipe = { ...recipe(), portraits: [] }
    // the whole 1000 x 800 picture, then a frame 500 x 400 whose corner is at 500, 400
    const out = reframeRecipe(r, { x: 0, y: 0, w: 1000, h: 800 }, { x: 500, y: 400, w: 500, h: 400 })
    expect(out.spots[0].x).toBeCloseTo((0.2 * 1000 - 500) / 500) // -0.6: outside the new frame, kept
    expect(out.spots[0].y).toBeCloseTo((0.3 * 800 - 400) / 400)
    expect(out.spots[0].size).toBeCloseTo(0.04 * 2) // the frame's long edge halved
    // and back again
    const back = reframeRecipe(out, { x: 500, y: 400, w: 500, h: 400 }, { x: 0, y: 0, w: 1000, h: 800 })
    expect(back.spots[0].x).toBeCloseTo(0.2)
    expect(back.spots[0].size).toBeCloseTo(0.04)
    // nothing changed: the very same recipe
    expect(reframeRecipe(r, { x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 0, w: 10, h: 10 })).toBe(r)
  })
})

describe('the colour wheel', () => {
  it('maps a hue and an amount to a point and back', () => {
    expect(wheelPoint(0, 100)).toEqual([50, 0]) // red is at the top, at the rim
    expect(wheelPoint(90, 100)[0]).toBeCloseTo(100)
    expect(wheelPoint(180, 100)[1]).toBeCloseTo(100)
    expect(wheelPoint(123, 0)).toEqual([50, 50])
    for (const [hue, sat] of [[0, 100], [45, 60], [200, 30], [330, 90]]) {
      const [x, y] = wheelPoint(hue, sat)
      expect(wheelValue(x, y)).toEqual({ hue, sat })
    }
    expect(wheelValue(50, 50).sat).toBe(0)
    expect(wheelValue(500, 50).sat).toBe(100) // out past the rim is the rim
  })
})