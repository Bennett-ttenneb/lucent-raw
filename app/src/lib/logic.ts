/** Pure helpers with no UI or core calls, so they are easy to test. */

/**
 * Turn what a user typed into keyword paths.
 *   "beach, Sunset > orange , beach"  ->  [["beach"], ["Sunset", "orange"]]
 * Splits on commas and semicolons, trims, drops empties, ignores case when removing
 * duplicates (first spelling wins), and allows "Parent > Child" up to three levels.
 */
export function parseKeywords(input: string): string[][] {
  const seen = new Set<string>()
  const out: string[][] = []
  for (const raw of input.split(/[,;\n]/)) {
    const path = raw
      .split('>')
      .map((p) => p.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .slice(0, 3)
      .map((p) => p.slice(0, 100))
    if (!path.length) continue
    const key = path.map((p) => p.toLowerCase()).join('>')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(path)
  }
  return out
}

export type MetaField = 'title' | 'caption' | 'creator' | 'copyright' | 'credit' | 'source' | 'sublocation' | 'city' | 'state' | 'country' | 'headline' | 'jobTitle' | 'instructions' | 'jobId' | 'usageTerms'
export const META_FIELDS: MetaField[] = ['title', 'caption', 'creator', 'copyright', 'credit', 'source', 'sublocation', 'city', 'state', 'country', 'headline', 'jobTitle', 'instructions', 'jobId', 'usageTerms']
/** The four everyone uses are always shown; the rest sit under "More details". */
export const META_MAIN: MetaField[] = ['title', 'caption', 'creator', 'copyright']
export const META_MORE: MetaField[] = ['credit', 'source', 'sublocation', 'city', 'state', 'country', 'headline', 'jobTitle', 'instructions', 'jobId', 'usageTerms']
export type MetaValues = Record<MetaField, string[]>

export interface FieldView {
  value: string
  mixed: boolean
}

/** One field over a selection: the shared value, or "mixed" when photos differ. */
export function fieldView(distinct: string[]): FieldView {
  if (distinct.length > 1) return { value: '', mixed: true }
  return { value: distinct[0] ?? '', mixed: false }
}

/** Names for collections: trimmed, single spaces, 1 to 100 characters. Returns null when unusable. */
export function cleanCollectionName(name: string): string | null {
  const n = name.replace(/\s+/g, ' ').trim()
  return n.length >= 1 && n.length <= 100 ? n : null
}
