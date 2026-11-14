/** Tone curve helpers. The pixel work is in Rust (develop.rs); this is the same curve for drawing it. */

export type Point = [number, number]
export const MAX_POINTS = 16

/** Finite, in range, sorted, one per input value (at least 1 apart), at most MAX_POINTS. */
export function cleanPoints(points: Point[]): Point[] {
  const pts = points
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map((p): Point => [Math.min(255, Math.max(0, p[0])), Math.min(255, Math.max(0, p[1]))])
    .sort((a, b) => a[0] - b[0])
  const out: Point[] = []
  for (const p of pts) if (out.length === 0 || p[0] - out[out.length - 1][0] >= 1) out.push(p)
  return out.slice(0, MAX_POINTS)
}

export const isStraight = (points: Point[]) => cleanPoints(points).every((p) => Math.abs(p[0] - p[1]) < 0.5)

/** Output (0..255) for every input 0..255, a monotone cubic through the points with (0,0) and (255,255) implied. */
export function curveValues(points: Point[]): number[] {
  const pts = cleanPoints(points)
  if (isStraight(pts)) return Array.from({ length: 256 }, (_, i) => i)
  const xs: number[] = []
  const ys: number[] = []
  if (!pts.length || pts[0][0] > 0) (xs.push(0), ys.push(0))
  for (const p of pts) (xs.push(p[0] / 255), ys.push(p[1] / 255))
  if (!pts.length || pts[pts.length - 1][0] < 255) (xs.push(1), ys.push(1))
  const n = xs.length
  const d = Array.from({ length: n - 1 }, (_, k) => (ys[k + 1] - ys[k]) / (xs[k + 1] - xs[k]))
  const m = new Array<number>(n).fill(0)
  m[0] = d[0]
  m[n - 1] = d[n - 2]
  for (let k = 1; k < n - 1; k++) m[k] = d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2
  for (let k = 0; k < n - 1; k++) {
    if (Math.abs(d[k]) < 1e-9) {
      m[k] = 0
      m[k + 1] = 0
    } else {
      const a = m[k] / d[k]
      const b = m[k + 1] / d[k]
      const h = Math.hypot(a, b)
      if (h > 3) {
        m[k] = ((3 * a) / h) * d[k]
        m[k + 1] = ((3 * b) / h) * d[k]
      }
    }
  }
  let seg = 0
  return Array.from({ length: 256 }, (_, i) => {
    const x = i / 255
    while (seg < n - 2 && x > xs[seg + 1]) seg++
    const h = xs[seg + 1] - xs[seg]
    const t = Math.min(1, Math.max(0, (x - xs[seg]) / h))
    const y =
      (2 * t ** 3 - 3 * t ** 2 + 1) * ys[seg] +
      (t ** 3 - 2 * t ** 2 + t) * h * m[seg] +
      (-2 * t ** 3 + 3 * t ** 2) * ys[seg + 1] +
      (t ** 3 - t ** 2) * h * m[seg + 1]
    return Math.min(255, Math.max(0, y * 255))
  })
}

/** Move one point, keeping it between its neighbours (1 apart at least) and inside 0..255. */
export function movePoint(points: Point[], index: number, to: Point): Point[] {
  const lo = index > 0 ? points[index - 1][0] + 1 : 0
  const hi = index < points.length - 1 ? points[index + 1][0] - 1 : 255
  const next = points.slice()
  next[index] = [Math.min(hi, Math.max(lo, to[0])), Math.min(255, Math.max(0, to[1]))]
  return next
}

/** Add a point at x on the current curve (so the line does not jump), or return the index of one already within `reach`. */
export function addPoint(points: Point[], x: number, y: number, reach = 6): { points: Point[]; index: number } {
  const near = points.findIndex((p) => Math.abs(p[0] - x) <= reach && Math.abs(p[1] - y) <= reach * 1.5)
  if (near >= 0) return { points, index: near }
  if (points.length >= MAX_POINTS) return { points, index: -1 }
  const next = cleanPoints([...points, [x, y]])
  return { points: next, index: next.findIndex((p) => p[0] === Math.min(255, Math.max(0, x))) }
}
