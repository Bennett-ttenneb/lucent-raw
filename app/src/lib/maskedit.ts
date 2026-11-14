import type { MaskShape } from './types'

/** The handles a gradient shows on the picture. */
export type Handle = 'start' | 'end' | 'line' | 'centre' | 'radiusX' | 'radiusY'
export type Pt = [number, number]

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))
/** Handles may be dragged a little past the picture, so a gradient can start or end just outside it. */
const pos = (v: number) => clamp(v, -0.5, 1.5)

/**
 * The shape after dragging a handle from `from` to `to`. Points are fractions of the picture, and
 * `aspect` is its width over its height, so a radius (a fraction of the long edge) comes out right on
 * a wide or a tall picture. Always computed from the shape as it was when the drag began, so there is no drift.
 */
export function moveHandle(original: MaskShape, handle: Handle, from: Pt, to: Pt, aspect: number): MaskShape {
  const dx = to[0] - from[0]
  const dy = to[1] - from[1]
  if (original.type === 'linear') {
    if (handle === 'start') return { ...original, x1: pos(to[0]), y1: pos(to[1]) }
    if (handle === 'end') return { ...original, x2: pos(to[0]), y2: pos(to[1]) }
    if (handle === 'line') return { ...original, x1: pos(original.x1 + dx), y1: pos(original.y1 + dy), x2: pos(original.x2 + dx), y2: pos(original.y2 + dy) }
  }
  if (original.type === 'radial') {
    if (handle === 'centre') return { ...original, cx: pos(original.cx + dx), cy: pos(original.cy + dy) }
    // work in picture units where the height is 1, so distances are true
    const long = Math.max(aspect, 1)
    const px = (to[0] - original.cx) * aspect
    const py = to[1] - original.cy
    const angle = (original.angle * Math.PI) / 180
    if (handle === 'radiusX') return { ...original, rx: clamp((px * Math.cos(angle) + py * Math.sin(angle)) / long, 0.01, 2) }
    if (handle === 'radiusY') return { ...original, ry: clamp((-px * Math.sin(angle) + py * Math.cos(angle)) / long, 0.01, 2) }
  }
  return original
}

/** Where the handles of a shape sit, as fractions of the picture. */
export function handlePositions(shape: MaskShape, aspect: number): Partial<Record<Handle, Pt>> {
  if (shape.type === 'linear') return { start: [shape.x1, shape.y1], end: [shape.x2, shape.y2], line: [(shape.x1 + shape.x2) / 2, (shape.y1 + shape.y2) / 2] }
  if (shape.type === 'radial') {
    const long = Math.max(aspect, 1)
    const a = (shape.angle * Math.PI) / 180
    const [rx, ry] = [shape.rx * long, shape.ry * long]
    return {
      centre: [shape.cx, shape.cy],
      radiusX: [shape.cx + (rx * Math.cos(a)) / aspect, shape.cy + rx * Math.sin(a)],
      radiusY: [shape.cx + (-ry * Math.sin(a)) / aspect, shape.cy + ry * Math.cos(a)],
    }
  }
  return {}
}

/** Hue (degrees, 0 to 360) and saturation (0 to 1) of an RGB colour, for picking a colour range from the picture. */
export function rgbToHueSat(r: number, g: number, b: number): { hue: number; sat: number } {
  const [R, G, B] = [r / 255, g / 255, b / 255]
  const max = Math.max(R, G, B)
  const min = Math.min(R, G, B)
  const d = max - min
  const l = (max + min) / 2
  if (d < 1e-6) return { hue: 0, sat: 0 }
  const sat = d / Math.max(1e-6, 1 - Math.abs(2 * l - 1))
  const h = max === R ? (((G - B) / d) % 6 + 6) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4
  return { hue: h * 60, sat: Math.min(1, sat) }
}

/** Add a point to a stroke unless it is too close to the last one (fractions of the picture). */
export function addStrokePoint(points: Pt[], p: Pt, minDistance = 0.003): Pt[] {
  const last = points[points.length - 1]
  if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < minDistance) return points
  return [...points, [clamp(p[0], -0.5, 1.5), clamp(p[1], -0.5, 1.5)]]
}
