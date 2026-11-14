import type { Flag, Label } from './types'

export type KeyAction =
  | { type: 'rate'; value: number }
  | { type: 'flag'; value: Flag }
  | { type: 'label'; value: Label | null }
  | { type: 'move'; dx: number; dy: number }
  | { type: 'edge'; to: 'first' | 'last' }
  | { type: 'view'; value: 'grid' | 'loupe' | 'compare' | 'survey' }
  | { type: 'selectAll' }
  | { type: 'quick' }
  | { type: 'target' }
  | { type: 'remove' }
  | { type: 'develop' }

/** The shortcuts that are single letters and can be given another letter in Preferences. Numbers, arrows, Delete and Ctrl keys stay as they are. */
export const REMAPPABLE = [
  { id: 'develop', label: 'Open in Develop', key: 'd' },
  { id: 'grid', label: 'Grid view', key: 'g' },
  { id: 'loupe', label: 'Loupe view (one photo large)', key: 'e' },
  { id: 'compare', label: 'Compare view (the Select and a Candidate)', key: 'c' },
  { id: 'survey', label: 'Survey view (the selected photos together)', key: 'n' },
  { id: 'pick', label: 'Flag as picked', key: 'p' },
  { id: 'reject', label: 'Flag as rejected', key: 'x' },
  { id: 'unflag', label: 'Remove the flag', key: 'u' },
  { id: 'quick', label: 'Quick collection (Shift plus the key: target collection)', key: 'b' },
  { id: 'lights', label: 'Lights dim, out, on', key: 'l' },
  { id: 'clipping', label: 'Show clipping (Develop)', key: 'j' },
  { id: 'crop', label: 'Crop (Develop)', key: 'c' },
  { id: 'zoom', label: 'Zoom to 100% (Develop)', key: 'z' },
] as const
export type KeyId = (typeof REMAPPABLE)[number]['id']

const ACTION_OF: Partial<Record<KeyId, KeyAction>> = {
  develop: { type: 'develop' },
  grid: { type: 'view', value: 'grid' },
  loupe: { type: 'view', value: 'loupe' },
  compare: { type: 'view', value: 'compare' },
  survey: { type: 'view', value: 'survey' },
  pick: { type: 'flag', value: 1 },
  reject: { type: 'flag', value: -1 },
  unflag: { type: 'flag', value: 0 },
  quick: { type: 'quick' },
}

const KEYMAP_KEY = 'lucent.keymap'
let overrides: Partial<Record<KeyId, string>> = (() => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEYMAP_KEY) ?? '{}') as Record<string, unknown>
    const ids = new Set<string>(REMAPPABLE.map((r) => r.id))
    return Object.fromEntries(Object.entries(raw).filter(([k, v]) => ids.has(k) && typeof v === 'string' && /^[a-z]$/.test(v)))
  } catch {
    return {}
  }
})()

/** The letter an action answers to now. */
export const keyFor = (id: KeyId): string => overrides[id] ?? REMAPPABLE.find((r) => r.id === id)!.key
const idOfKey = (k: string): KeyId | null => REMAPPABLE.find((r) => keyFor(r.id) === k)?.id ?? null

/** Give an action another letter. Returns a sentence saying why not, or null when it worked. */
export function setKey(id: KeyId, letter: string): string | null {
  const l = letter.toLowerCase()
  if (!/^[a-z]$/.test(l)) return 'Use one letter, a to z.'
  const clash = REMAPPABLE.find((r) => r.id !== id && keyFor(r.id) === l)
  if (clash) return `${l.toUpperCase()} is already used for "${clash.label}". Change that one first.`
  overrides = { ...overrides, [id]: l }
  saveKeymap()
  return null
}

/** Back to the letters the program came with. */
export function resetKeys() {
  overrides = {}
  saveKeymap()
}

function saveKeymap() {
  try {
    localStorage.setItem(KEYMAP_KEY, JSON.stringify(overrides))
  } catch {
    /* the choice lasts until the window closes */
  }
}

/** Pure mapping from a key press to an action, so the shortcuts are testable without a DOM. */
export function parseKey(e: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean }): KeyAction | null {
  if (e.altKey) return null
  const mod = !!(e.ctrlKey || e.metaKey)
  const k = e.key
  if (mod) return k.toLowerCase() === 'a' ? { type: 'selectAll' } : null
  if (/^[0-5]$/.test(k)) return { type: 'rate', value: Number(k) }
  if (k.length === 1 && k === k.toUpperCase() && k !== k.toLowerCase() && k.toLowerCase() === keyFor('quick')) return { type: 'target' } // Shift plus the quick-collection key
  if (k === 'Delete' || k === 'Backspace') return { type: 'remove' }
  const own = idOfKey(k.toLowerCase())
  if (own) {
    const a = ACTION_OF[own]
    if (a) return a
  }
  switch (k.toLowerCase()) {
    case '6':
      return { type: 'label', value: 'red' }
    case '7':
      return { type: 'label', value: 'yellow' }
    case '8':
      return { type: 'label', value: 'green' }
    case '9':
      return { type: 'label', value: 'blue' }
  }
  switch (k) {
    case 'ArrowLeft':
      return { type: 'move', dx: -1, dy: 0 }
    case 'ArrowRight':
      return { type: 'move', dx: 1, dy: 0 }
    case 'ArrowUp':
      return { type: 'move', dx: 0, dy: -1 }
    case 'ArrowDown':
      return { type: 'move', dx: 0, dy: 1 }
    case 'Home':
      return { type: 'edge', to: 'first' }
    case 'End':
      return { type: 'edge', to: 'last' }
  }
  return null
}

/** Pressing the rating already set clears it (same as the star control). */
export const nextRating = (current: number, pressed: number) => (current === pressed ? 0 : pressed)
