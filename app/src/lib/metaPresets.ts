import { META_FIELDS, type MetaField } from './logic'

/** A named set of details (creator, copyright, city …) to put on photos in one step. Kept in this window's storage, like saved filters. */
export interface MetaPreset {
  name: string
  values: Partial<Record<MetaField, string>>
}

const KEY = 'lucent.metaPresets'
const MAX = 30

export function load(): MetaPreset[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '[]') as unknown
    if (!Array.isArray(raw)) return []
    return raw
      .filter((r): r is MetaPreset => !!r && typeof (r as MetaPreset).name === 'string' && typeof (r as MetaPreset).values === 'object' && (r as MetaPreset).values !== null)
      .map((p) => ({ name: p.name, values: only(p.values) }))
      .slice(0, MAX)
  } catch {
    return []
  }
}

/** Only the known fields, only text, none longer than the catalog accepts. */
export function only(v: Record<string, unknown>): Partial<Record<MetaField, string>> {
  const out: Partial<Record<MetaField, string>> = {}
  for (const f of META_FIELDS) if (typeof v[f] === 'string' && (v[f] as string) !== '') out[f] = (v[f] as string).slice(0, 2000)
  return out
}

function store(list: MetaPreset[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* private window or blocked storage: the list lasts until the window closes */
  }
}

export function save(name: string, values: Record<string, unknown>): { list: MetaPreset[] } | { error: string } {
  const n = name.trim()
  if (!n) return { error: 'Give the preset a name.' }
  const v = only(values)
  if (Object.keys(v).length === 0) return { error: 'Fill in at least one detail first: there is nothing to keep.' }
  const rest = load().filter((p) => p.name.toLowerCase() !== n.toLowerCase())
  if (rest.length >= MAX) return { error: `You can keep ${MAX} presets. Delete one first.` }
  const list = [...rest, { name: n, values: v }].sort((a, b) => a.name.localeCompare(b.name))
  store(list)
  return { list }
}

export function remove(name: string): MetaPreset[] {
  const list = load().filter((p) => p.name !== name)
  store(list)
  return list
}
