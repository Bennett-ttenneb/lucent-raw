import type { BookFrame, BookPage } from './types'

/** A margin all round a page, as a fraction of its width. */
const M = 0.06
const G = 0.03

export type Rect = [x: number, y: number, w: number, h: number]

export interface BookLayout {
  id: string
  name: string
  /** the photo places, then the text places */
  photos: Rect[]
  texts: Rect[]
}

/** The page arrangements to pick from. Every number is a fraction of the page. */
export const LAYOUTS: BookLayout[] = [
  { id: 'blank', name: 'Blank', photos: [], texts: [] },
  { id: 'full', name: 'Full page', photos: [[0, 0, 1, 1]], texts: [] },
  { id: 'one', name: 'One photo', photos: [[M, M, 1 - 2 * M, 1 - 2 * M]], texts: [] },
  { id: 'caption', name: 'Photo and caption', photos: [[M, M, 1 - 2 * M, 0.72]], texts: [[M, 0.82, 1 - 2 * M, 0.12]] },
  { id: 'two-side', name: 'Two side by side', photos: [[M, 0.2, 0.5 - M - G / 2, 0.6], [0.5 + G / 2, 0.2, 0.5 - M - G / 2, 0.6]], texts: [] },
  { id: 'two-stack', name: 'Two stacked', photos: [[M, M, 1 - 2 * M, 0.5 - M - G / 2], [M, 0.5 + G / 2, 1 - 2 * M, 0.5 - M - G / 2]], texts: [] },
  { id: 'three', name: 'Three', photos: [[M, M, 1 - 2 * M, 0.5], [M, 0.5 + M + G / 2 - 0.03, 0.5 - M - G / 2, 0.5 - M - 0.03 - G / 2], [0.5 + G / 2, 0.5 + M + G / 2 - 0.03, 0.5 - M - G / 2, 0.5 - M - 0.03 - G / 2]], texts: [] },
  { id: 'four', name: 'Four', photos: grid(2, 2), texts: [] },
  { id: 'six', name: 'Six', photos: grid(2, 3), texts: [] },
  { id: 'text', name: 'Text only', photos: [], texts: [[M, 0.15, 1 - 2 * M, 0.7]] },
]

function grid(cols: number, rows: number): Rect[] {
  const w = (1 - 2 * M - G * (cols - 1)) / cols
  const h = (1 - 2 * M - G * (rows - 1)) / rows
  const out: Rect[] = []
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) out.push([M + c * (w + G), M + r * (h + G), w, h])
  return out
}

export function newPhotoFrame(r: Rect, photoId: number | null = null): BookFrame {
  return { kind: 'photo', x: r[0], y: r[1], w: r[2], h: r[3], photoId, fit: 'fill', focusX: 0.5, focusY: 0.5, text: '', sizePt: 12, align: 'left', bold: false, colour: '#222222' }
}

export function newTextFrame(r: Rect, text = ''): BookFrame {
  return { ...newPhotoFrame(r), kind: 'text', text, sizePt: 14, align: 'centre' }
}

/** The page with this arrangement. Photos already on the page move into the new places in order, and extra ones are dropped. */
export function applyLayout(page: BookPage, layoutId: string): BookPage {
  const layout = LAYOUTS.find((l) => l.id === layoutId)
  if (!layout) return page
  const photos = page.frames.filter((f) => f.kind === 'photo')
  const texts = page.frames.filter((f) => f.kind === 'text')
  const frames: BookFrame[] = [
    ...layout.photos.map((r, i) => ({ ...(photos[i] ?? newPhotoFrame(r)), x: r[0], y: r[1], w: r[2], h: r[3] })),
    ...layout.texts.map((r, i) => ({ ...(texts[i] ?? newTextFrame(r)), x: r[0], y: r[1], w: r[2], h: r[3] })),
  ]
  return { ...page, frames }
}

/** How many photos the arrangement holds. */
export function photoPlaces(layoutId: string): number {
  return LAYOUTS.find((l) => l.id === layoutId)?.photos.length ?? 0
}

/** Pages made from photos, in order, using the arrangement that holds `perPage` photos (1, 2, 3, 4 or 6). */
export function autoPages(photoIds: number[], perPage: number): BookPage[] {
  const id = ({ 1: 'one', 2: 'two-side', 3: 'three', 4: 'four', 6: 'six' } as Record<number, string>)[perPage] ?? 'one'
  const layout = LAYOUTS.find((l) => l.id === id)!
  const pages: BookPage[] = []
  for (let i = 0; i < photoIds.length; i += layout.photos.length) {
    const chunk = photoIds.slice(i, i + layout.photos.length)
    pages.push({ background: '#FFFFFF', frames: chunk.map((pid, k) => newPhotoFrame(layout.photos[k], pid)) })
  }
  return pages
}

/** Which arrangement a page is, if it is one of the plain ones (for showing it as chosen). */
export function layoutOf(page: BookPage): string | null {
  const photos = page.frames.filter((f) => f.kind === 'photo')
  const texts = page.frames.filter((f) => f.kind === 'text')
  const same = (f: BookFrame, r: Rect) => Math.abs(f.x - r[0]) < 1e-3 && Math.abs(f.y - r[1]) < 1e-3 && Math.abs(f.w - r[2]) < 1e-3 && Math.abs(f.h - r[3]) < 1e-3
  return LAYOUTS.find((l) => l.photos.length === photos.length && l.texts.length === texts.length && l.photos.every((r, i) => same(photos[i], r)) && l.texts.every((r, i) => same(texts[i], r)))?.id ?? null
}
