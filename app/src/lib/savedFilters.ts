import type { Filters } from './types'

/** The parts of the filter bar that can be kept under a name. A folder, collection or keyword is not one of them: those are where you are looking, not how. */
export const FILTER_KEYS = ['text', 'minRating', 'flag', 'label', 'edited', 'copies', 'camera', 'lens', 'minIso', 'maxIso', 'minFocal', 'maxFocal', 'minAperture', 'maxAperture', 'dateFrom', 'dateTo'] as const
export type FilterKey = (typeof FILTER_KEYS)[number]
export type FilterPart = Partial<Pick<Filters, FilterKey>>

export interface SavedFilter {
  name: string
  filter: FilterPart
}

const KEY = 'lucent.savedFilters'
const MAX = 30

/** What the filter bar is set to now, without the empty parts. */
export function partOf(f: Filters): FilterPart {
  const out: Record<string, unknown> = {}
  for (const k of FILTER_KEYS) {
    const v = f[k]
    if (v !== undefined && v !== null && v !== '' && v !== 0) out[k] = v
  }
  return out as FilterPart
}

/** Which tab of the filter bar shows these (the first one that has something in it). */
export function tabFor(p: FilterPart): 'text' | 'attribute' | 'metadata' {
  if (p.camera || p.lens || p.minIso || p.maxIso || p.minFocal || p.maxFocal || p.minAperture || p.maxAperture || p.dateFrom || p.dateTo) return 'metadata'
  if (p.minRating || p.flag || p.label || p.edited || p.copies) return 'attribute'
  return 'text'
}

/** Every filter part cleared, so applying a saved filter never leaves part of the old one behind. */
export function cleared(): Record<FilterKey, undefined> {
  return Object.fromEntries(FILTER_KEYS.map((k) => [k, undefined])) as Record<FilterKey, undefined>
}

export function load(): SavedFilter[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown
    if (!Array.isArray(raw)) return []
    return raw
      .filter((r): r is SavedFilter => !!r && typeof (r as SavedFilter).name === 'string' && typeof (r as SavedFilter).filter === 'object' && (r as SavedFilter).filter !== null)
      .slice(0, MAX)
  } catch {
    return []
  }
}

function store(list: SavedFilter[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* private window or blocked storage: the list lasts until the window closes */
  }
}

/** Keep the filter under a name. The same name (ignoring case) is replaced. Returns the new list, or says why not. */
export function save(name: string, filter: FilterPart): { list: SavedFilter[] } | { error: string } {
  const n = name.trim()
  if (!n) return { error: 'Give it a name.' }
  if (Object.keys(filter).length === 0) return { error: 'Set a filter first: there is nothing to keep.' }
  const rest = load().filter((s) => s.name.toLowerCase() !== n.toLowerCase())
  if (rest.length >= MAX) return { error: `You can keep ${MAX} saved filters. Delete one first.` }
  const list = [...rest, { name: n, filter }].sort((a, b) => a.name.localeCompare(b.name))
  store(list)
  return { list }
}

export function remove(name: string): SavedFilter[] {
  const list = load().filter((s) => s.name !== name)
  store(list)
  return list
}
