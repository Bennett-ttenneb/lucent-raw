import type { Ellipse, Portrait } from './types'

export type Pt = [number, number]
export type RegionKey = 'face' | 'leftEye' | 'rightEye' | 'mouth'
export type EllipseHandle = 'centre' | 'rx' | 'ry'

export const REGIONS: { key: RegionKey; label: string }[] = [
  { key: 'face', label: 'Face' },
  { key: 'leftEye', label: 'Left eye' },
  { key: 'rightEye', label: 'Right eye' },
  { key: 'mouth', label: 'Mouth' },
]
export const regionLabel = (key: RegionKey) => REGIONS.find((r) => r.key === key)!.label

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
const pos = (v: number) => clamp(v, -0.5, 1.5)
export const MIN_RADIUS = 0.004
export const MAX_RADIUS = 0.5

/** How much of the picture's width (ux) and height (uy) one unit of its long edge is. Radii are in long-edge units. */
export const units = (aspect: number): { ux: number; uy: number } => ({ ux: Math.max(1, 1 / aspect), uy: Math.max(aspect, 1) })

/** What Auto retouch sets: a light, natural touch (smooth the blotches but keep the pores, a little brighter teeth and eyes). */
export const AUTO_RETOUCH = {
  skin: { impact: 100, blemishes: 85, darkCircles: 30, evenAmount: 45, evenTexture: 90, contouring: 0, radius: 40, body: 50, tone: 15, shine: 15, colour: 15, glow: 25, crisp: 20 },
  teeth: { brightness: 15, desaturation: 25 },
  eyes: { iris: 10, sclera: 15 },
  lips: 15,
  brows: 10,
}

export const DEFAULT_SKIN = { impact: 100, blemishes: 0, darkCircles: 0, evenAmount: 0, evenTexture: 50, contouring: 0, radius: 40, body: 0, tone: 0, shine: 0, colour: 0, glow: 0, crisp: 0 }
export const DEFAULT_TEETH = { brightness: 0, desaturation: 0 }
export const DEFAULT_EYE = { iris: 0, sclera: 0 }
export const DEFAULT_EYES = { both: { ...DEFAULT_EYE }, left: { ...DEFAULT_EYE }, right: { ...DEFAULT_EYE } }

/**
 * A face laid out around a click on its middle: an ellipse for the face, two eyes in the upper half and a mouth in
 * the lower, all sized from the face. The person then drags the regions into place. `aspect` is width over height.
 */
export function layoutFace(at: Pt, aspect: number, faceRadius = 0.1): Portrait {
  const { ux, uy } = units(aspect)
  const [rx, ry] = [faceRadius, faceRadius * 1.3]
  const place = (dx: number, dy: number, erx: number, ery: number): Ellipse => ({
    cx: pos(at[0] + dx * rx * ux),
    cy: pos(at[1] + dy * ry * uy),
    rx: clamp(erx * rx, MIN_RADIUS, MAX_RADIUS),
    ry: clamp(ery * rx, MIN_RADIUS, MAX_RADIUS),
  })
  return {
    face: { cx: pos(at[0]), cy: pos(at[1]), rx: clamp(rx, MIN_RADIUS, MAX_RADIUS), ry: clamp(ry, MIN_RADIUS, MAX_RADIUS) },
    leftEye: place(-0.42, -0.2, 0.26, 0.1),
    rightEye: place(0.42, -0.2, 0.26, 0.1),
    mouth: place(0, 0.52, 0.38, 0.14),
    skin: { ...DEFAULT_SKIN },
    teeth: { ...DEFAULT_TEETH },
    eyes: { both: { ...DEFAULT_EYE }, left: { ...DEFAULT_EYE }, right: { ...DEFAULT_EYE } },
    roll: 0,
    yaw: 0,
    pitch: 0,
    lips: 0,
    brows: 0,
  }
}

/** Where an ellipse's handles are, as fractions of the picture: the middle, the right end and the bottom end. */
export function handlePositions(e: Ellipse, aspect: number, roll = 0): Record<EllipseHandle, Pt> {
  const { uy } = units(aspect)
  // in units of the picture's height, where a turn is a turn; a radius is `r * uy` long there
  const [c, s] = [Math.cos((roll * Math.PI) / 180), Math.sin((roll * Math.PI) / 180)]
  const end = (x: number, y: number): Pt => [e.cx + (x * c - y * s) / aspect, e.cy + (x * s + y * c)]
  return { centre: [e.cx, e.cy], rx: end(e.rx * uy, 0), ry: end(0, e.ry * uy) }
}

/** The ellipse after dragging a handle from `from` to `to` (fractions of the picture). */
export function moveEllipse(e: Ellipse, handle: EllipseHandle, from: Pt, to: Pt, aspect: number, roll = 0): Ellipse {
  const { uy } = units(aspect)
  if (handle === 'centre') return { ...e, cx: pos(e.cx + to[0] - from[0]), cy: pos(e.cy + to[1] - from[1]) }
  // the pointer's place along the ellipse's own axes (turned back by `roll`), in units of the picture's height
  const [dx, dy] = [(to[0] - e.cx) * aspect, to[1] - e.cy]
  const [c, s] = [Math.cos((roll * Math.PI) / 180), Math.sin((roll * Math.PI) / 180)]
  const [lx, ly] = [dx * c + dy * s, -dx * s + dy * c]
  if (handle === 'rx') return { ...e, rx: clamp(Math.abs(lx) / uy, MIN_RADIUS, MAX_RADIUS) }
  return { ...e, ry: clamp(Math.abs(ly) / uy, MIN_RADIUS, MAX_RADIUS) }
}

/** How a found face is turned, in words, or nothing when it faces the camera upright. */
export function orientationText(p: Portrait): string {
  const parts: string[] = []
  const roll = Math.round(p.roll ?? 0)
  if (Math.abs(roll) >= 150) parts.push('upside down')
  else if (Math.abs(roll) >= 15) parts.push(`tilted ${Math.abs(roll)}° ${roll > 0 ? 'clockwise' : 'anticlockwise'}`)
  const yaw = Math.round(p.yaw ?? 0)
  if (Math.abs(yaw) >= 25) parts.push(Math.abs(yaw) >= 55 ? `in profile, looking ${yaw > 0 ? 'right' : 'left'}` : `turned ${Math.abs(yaw)}° ${yaw > 0 ? 'right' : 'left'}`)
  const pitch = Math.round(p.pitch ?? 0)
  if (Math.abs(pitch) >= 20) parts.push(pitch > 0 ? 'looking down' : 'looking up')
  return parts.join(', ')
}

/** Move the whole face: every region goes along by the same amount. */
export function moveWhole(p: Portrait, dx: number, dy: number): Portrait {
  const m = (e: Ellipse): Ellipse => ({ ...e, cx: pos(e.cx + dx), cy: pos(e.cy + dy) })
  return { ...p, face: m(p.face), leftEye: m(p.leftEye), rightEye: m(p.rightEye), mouth: m(p.mouth) }
}

/** How many faces one photo can carry (the same as the core). */
export const MAX_PORTRAITS = 24

/** Is this point (fractions of the picture) inside the face ellipse? `aspect` is the picture's width over height. */
export function insideFace(p: Portrait, at: Pt, aspect: number): boolean {
  const { ux, uy } = units(aspect)
  const [dx, dy] = [(at[0] - p.face.cx) / (p.face.rx * ux), (at[1] - p.face.cy) / (p.face.ry * uy)]
  return dx * dx + dy * dy < 1
}

/**
 * The faces after a detection: the ones already there stay exactly as they are (with their sliders and any shaping), and
 * a detected face is added only if it is not on top of one of them. `added` says how many were added.
 */
export function mergeDetected(existing: Portrait[], found: Portrait[], aspect: number): { merged: Portrait[]; added: number } {
  const merged = [...existing]
  let added = 0
  for (const f of found) {
    const centre: Pt = [f.face.cx, f.face.cy]
    const same = merged.some((e) => insideFace(e, centre, aspect) || insideFace(f, [e.face.cx, e.face.cy], aspect))
    if (!same && merged.length < MAX_PORTRAITS) {
      merged.push(f)
      added++
    }
  }
  return { merged, added }
}

export const skinIsDefault = (p: Portrait) => (Object.keys(DEFAULT_SKIN) as (keyof typeof DEFAULT_SKIN)[]).every((k) => p.skin[k] === DEFAULT_SKIN[k])
export const teethIsDefault = (p: Portrait) => p.teeth.brightness === 0 && p.teeth.desaturation === 0
export const eyesIsDefault = (p: Portrait) => (['both', 'left', 'right'] as const).every((s) => p.eyes[s].iris === 0 && p.eyes[s].sclera === 0)

/** Does any face have retouching to show? */
export const anyPortraitActive = (faces: Portrait[]) => faces.some((p) => portraitIsActive(p))

/** Does the retouch change the picture? Marking the regions alone does not. */
export function portraitIsActive(p: Portrait | null): boolean {
  if (!p) return false
  const s = p.skin
  return (s.impact > 0 && (s.blemishes > 0 || s.darkCircles > 0 || s.evenAmount > 0 || s.contouring !== 0 || s.tone > 0 || s.shine > 0 || s.colour > 0 || s.glow > 0 || s.crisp > 0)) || p.teeth.brightness !== 0 || p.teeth.desaturation > 0 || !eyesIsDefault(p) || (p.lips ?? 0) !== 0 || (p.brows ?? 0) !== 0
}
