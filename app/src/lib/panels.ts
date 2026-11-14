import { create } from 'zustand'

/**
 * Which panels in the side columns are open, remembered between launches, and the keys that move around them:
 *   Alt+1 to Alt+9      open or close the 1st to 9th panel of the right-hand column (Alt+Shift for the left-hand one) and move to it
 *   Alt+0               close every panel of the right-hand column (Alt+Shift+0 for the left-hand one)
 *   Alt+click a title   open that panel and close the others in its column
 *   Up, Down, Home, End on a panel title move between the titles of the column
 * Holding Alt shows the number beside each title.
 */
const KEY = 'lucent.panels'

function read(): Record<string, boolean> {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as unknown
    if (!raw || typeof raw !== 'object') return {}
    return Object.fromEntries(Object.entries(raw as Record<string, unknown>).filter(([, v]) => typeof v === 'boolean')) as Record<string, boolean>
  } catch {
    return {}
  }
}

function write(open: Record<string, boolean>) {
  try {
    localStorage.setItem(KEY, JSON.stringify(open))
  } catch {
    /* private window or blocked storage: the choice lasts until the window closes */
  }
}

const SOLO_KEY = 'lucent.panelsSolo'

function readSolo(): boolean {
  try {
    return localStorage.getItem(SOLO_KEY) === '1'
  } catch {
    return false
  }
}

export const usePanels = create<{
  open: Record<string, boolean>
  /** Solo mode: opening a panel closes the others in its column (also in the right-click menu on a panel title). */
  soloMode: boolean
  setSoloMode: (on: boolean) => void
  set: (title: string, on: boolean) => void
  setMany: (m: Record<string, boolean>) => void
}>((set, get) => ({
  open: read(),
  soloMode: readSolo(),
  setSoloMode: (on) => {
    try {
      localStorage.setItem(SOLO_KEY, on ? '1' : '0')
    } catch {
      /* the choice lasts until the window closes */
    }
    set({ soloMode: on })
  },
  set: (title, on) => {
    const open = { ...get().open, [title]: on }
    write(open)
    set({ open })
  },
  setMany: (m) => {
    const open = { ...get().open, ...m }
    write(open)
    set({ open })
  },
}))

/** 1 to 9 for the digit keys Digit1 to Digit9, 0 for Digit0, otherwise null. Uses the key's place, so Shift does not change it. */
export function digitOf(code: string): number | null {
  const m = /^Digit([0-9])$/.exec(code)
  return m ? Number(m[1]) : null
}

/** The titles to close so that only `keep` is open. */
export function solo(titles: string[], keep: string): Record<string, boolean> {
  return Object.fromEntries(titles.map((t) => [t, t === keep]))
}

/** The panels of one column, in the order they are on the screen. */
export function columnPanels(side: 'left' | 'right'): HTMLElement[] {
  const col = document.querySelector(`aside.side.${side}`)
  return col ? Array.from(col.querySelectorAll<HTMLElement>('section.panel[data-title]')) : []
}

/** What the digit keys do. Returns true when the key was used. */
export function panelKey(e: { code: string; altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }): boolean {
  if (!e.altKey || e.ctrlKey || e.metaKey) return false
  const n = digitOf(e.code)
  if (n === null) return false
  const panels = columnPanels(e.shiftKey ? 'left' : 'right')
  if (panels.length === 0) return false
  const st = usePanels.getState()
  if (n === 0) {
    st.setMany(Object.fromEntries(panels.map((p) => [p.dataset.title!, false])))
    return true
  }
  const target = panels[n - 1]
  if (!target) return true // the key is ours even when there is no such panel, so nothing else reacts to it
  const title = target.dataset.title!
  const isOpen = target.querySelector('.phead-btn')?.getAttribute('aria-expanded') === 'true'
  st.set(title, !isOpen)
  if (!isOpen) {
    // the body is shown after the next render; then bring the title into view and put the keyboard on it
    requestAnimationFrame(() => {
      const btn = target.querySelector<HTMLElement>('.phead-btn')
      btn?.focus({ preventScroll: true })
      target.scrollIntoView({ block: 'nearest' })
    })
  }
  return true
}

/** Up, Down, Home and End on a panel title: the title to move to, or null. */
export function neighbour(titles: HTMLElement[], from: HTMLElement, key: string): HTMLElement | null {
  const i = titles.indexOf(from)
  if (i < 0) return null
  if (key === 'ArrowDown') return titles[Math.min(titles.length - 1, i + 1)]
  if (key === 'ArrowUp') return titles[Math.max(0, i - 1)]
  if (key === 'Home') return titles[0]
  if (key === 'End') return titles[titles.length - 1]
  return null
}

/** Show or hide the numbers beside the titles (while Alt is held). */
export function showNumbers(on: boolean) {
  document.body.classList.toggle('panel-numbers', on)
  for (const side of ['left', 'right'] as const) {
    columnPanels(side).forEach((p, i) => {
      const b = p.querySelector<HTMLElement>('.phead-btn')
      if (!b) return
      if (on && i < 9) b.dataset.key = String(i + 1)
      else delete b.dataset.key
    })
  }
}
