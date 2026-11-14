import { create } from 'zustand'

/** What the person chose: dark, light, or whatever the computer is set to. */
export type ThemeChoice = 'dark' | 'light' | 'system'
export type Theme = 'dark' | 'light'

const KEY = 'penumbra.theme'

function load(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'dark' || v === 'light' || v === 'system') return v
  } catch {
    /* storage unavailable: the default */
  }
  return 'dark'
}

const computerIsLight = () => typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: light)').matches

/** The theme that is shown for a choice. */
export const resolveTheme = (choice: ThemeChoice, systemLight: boolean = computerIsLight()): Theme => (choice === 'system' ? (systemLight ? 'light' : 'dark') : choice)

function show(theme: Theme) {
  if (typeof document !== 'undefined') document.documentElement.dataset.theme = theme
}

export const useTheme = create<{ choice: ThemeChoice; theme: Theme; setChoice(c: ThemeChoice): void; toggle(): void }>((set, get) => ({
  choice: load(),
  theme: resolveTheme(load()),
  setChoice(choice) {
    const theme = resolveTheme(choice)
    show(theme)
    set({ choice, theme })
    try {
      localStorage.setItem(KEY, choice)
    } catch {
      /* the choice just lasts for this session */
    }
  },
  /** The button in the title bar: the other of dark and light. */
  toggle() {
    get().setChoice(get().theme === 'dark' ? 'light' : 'dark')
  },
}))

/** Put the saved theme on the page before anything is drawn, and follow the computer when the choice is "system". */
export function initTheme() {
  show(useTheme.getState().theme)
  if (typeof matchMedia === 'function') {
    matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', (e) => {
      if (useTheme.getState().choice !== 'system') return
      const theme = resolveTheme('system', e.matches)
      show(theme)
      useTheme.setState({ theme })
    })
  }
}
