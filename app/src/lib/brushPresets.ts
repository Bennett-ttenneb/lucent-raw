/** Brush presets: a size, feather and flow kept under a name. Four come with the program; your own are kept in this window's storage, like the other presets. */
export interface BrushPreset {
  name: string
  /** fractions: size of the long edge (0.01 to 0.5), feather and flow (0 to 1; flow at least 0.01) */
  size: number
  feather: number
  flow: number
}

export const BUILTIN_BRUSHES: BrushPreset[] = [
  { name: 'Soft', size: 0.12, feather: 0.8, flow: 0.6 },
  { name: 'Hard edge', size: 0.06, feather: 0, flow: 1 },
  { name: 'Detail', size: 0.03, feather: 0.3, flow: 1 },
  { name: 'Broad', size: 0.3, feather: 0.7, flow: 0.8 },
]

const KEY = 'lucent.brushPresets'
const MAX = 20

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d)

/** Your own brushes, tidied (a bad stored value is dropped or brought into range). */
export function loadBrushes(): BrushPreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown
    if (!Array.isArray(raw)) return []
    return raw
      .filter((r): r is Record<string, unknown> => !!r && typeof (r as Record<string, unknown>).name === 'string')
      .map((r) => ({ name: String(r.name).trim().slice(0, 40), size: clamp(r.size, 0.01, 0.5, 0.08), feather: clamp(r.feather, 0, 1, 0.5), flow: clamp(r.flow, 0.01, 1, 1) }))
      .filter((r) => r.name !== '')
      .slice(0, MAX)
  } catch {
    return []
  }
}

function store(list: BrushPreset[]): BrushPreset[] {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* the list lasts until the window closes */
  }
  return list
}

/** Keep a brush under a name (a name used before is replaced). Returns the list, or a sentence saying why not. */
export function saveBrush(name: string, b: { size: number; feather: number; flow: number }): { list: BrushPreset[] } | { error: string } {
  const n = name.split(/\s+/).filter(Boolean).join(' ').slice(0, 40)
  if (!n) return { error: 'Give the brush a name.' }
  if (BUILTIN_BRUSHES.some((x) => x.name.toLowerCase() === n.toLowerCase())) return { error: 'That name belongs to a brush that comes with the program.' }
  const rest = loadBrushes().filter((x) => x.name.toLowerCase() !== n.toLowerCase())
  if (rest.length >= MAX) return { error: `You can keep ${MAX} brushes. Forget one first.` }
  return { list: store([...rest, { name: n, size: clamp(b.size, 0.01, 0.5, 0.08), feather: clamp(b.feather, 0, 1, 0.5), flow: clamp(b.flow, 0.01, 1, 1) }].sort((a, b2) => a.name.localeCompare(b2.name))) }
}

export const forgetBrush = (name: string): BrushPreset[] => store(loadBrushes().filter((x) => x.name !== name))
