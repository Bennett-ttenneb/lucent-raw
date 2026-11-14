/** Paper sizes in millimetres, portrait (width, height). */
export const PAPERS: { id: string; name: string; w: number; h: number }[] = [
  { id: 'a4', name: 'A4 (210 × 297 mm)', w: 210, h: 297 },
  { id: 'a3', name: 'A3 (297 × 420 mm)', w: 297, h: 420 },
  { id: 'a5', name: 'A5 (148 × 210 mm)', w: 148, h: 210 },
  { id: 'letter', name: 'Letter (8.5 × 11 in)', w: 215.9, h: 279.4 },
  { id: 'legal', name: 'Legal (8.5 × 14 in)', w: 215.9, h: 355.6 },
  { id: '10x15', name: '10 × 15 cm (4 × 6 in)', w: 101.6, h: 152.4 },
  { id: '13x18', name: '13 × 18 cm (5 × 7 in)', w: 127, h: 177.8 },
  { id: '20x25', name: '20 × 25 cm (8 × 10 in)', w: 203.2, h: 254 },
]

export interface PrintSetup {
  paper: string
  landscape: boolean
  /** photos across and down on one page */
  cols: number
  rows: number
  margin: number
  gap: number
  /** fill the cell (cropping the edges) rather than fit the whole photo inside it */
  fill: boolean
  captions: boolean
  copies: number
}

export const DEFAULT_PRINT: PrintSetup = { paper: 'a4', landscape: false, cols: 1, rows: 1, margin: 10, gap: 4, fill: false, captions: false, copies: 1 }

/** The size of a sheet in mm, as printed. */
export const sheetSize = (s: PrintSetup): [number, number] => {
  const p = PAPERS.find((x) => x.id === s.paper) ?? PAPERS[0]
  return s.landscape ? [p.h, p.w] : [p.w, p.h]
}

/** Photos on the pages: each photo `copies` times, then cut into pages of cols x rows. */
export function paginate<T>(photos: T[], s: PrintSetup): T[][] {
  const per = Math.max(1, s.cols * s.rows)
  const all = photos.flatMap((p) => Array.from({ length: Math.max(1, s.copies) }, () => p))
  const pages: T[][] = []
  for (let i = 0; i < all.length; i += per) pages.push(all.slice(i, i + per))
  return pages
}

