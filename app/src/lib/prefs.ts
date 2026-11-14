import { create } from 'zustand'
import { api } from './api'
import { setNumberLocale, setSizeUnits } from './format'
import type { WatchConfig } from './types'

const KEY = 'penumbra.backupReminderDays'
/** How often the Catalogs window says a backup is worth making; 0 means never. */
export const REMINDER_CHOICES = [7, 30, 90, 0] as const
export type ReminderDays = (typeof REMINDER_CHOICES)[number]

function load(): ReminderDays {
  try {
    const v = Number(localStorage.getItem(KEY))
    if ((REMINDER_CHOICES as readonly number[]).includes(v) && localStorage.getItem(KEY) !== null) return v as ReminderDays
  } catch {
    /* storage unavailable: the default */
  }
  return 30
}

const AI_KEY = 'lucent.hideAi'
function loadHideAi(): boolean {
  try {
    return localStorage.getItem(AI_KEY) === '1'
  } catch {
    return false
  }
}

/** The tools that use an AI model, for the switch that hides them (shown in Preferences so nothing is hidden without being named). */
export const AI_TOOLS = ['B BOT', 'Select subject and background (masks)', 'Fill in Spot removal', 'Enlarge with AI', 'Portrait retouch (finds faces)', 'The AI connection button'] as const

const THREADS_KEY = 'lucent.threads'
function loadThreads(): number {
  try {
    const v = Number(localStorage.getItem(THREADS_KEY))
    return Number.isInteger(v) && v >= 0 && v <= 32 ? v : 0
  } catch {
    return 0
  }
}

const LIMIT_GB_KEY = 'lucent.previewLimitGb'
const LIMIT_DAYS_KEY = 'lucent.previewMaxDays'
export const PREVIEW_LIMIT_GB = [0, 1, 2, 5, 10, 20, 50] as const
export const PREVIEW_MAX_DAYS = [0, 30, 90, 180, 365] as const
function loadChoice(key: string, allowed: readonly number[]): number {
  try {
    const v = Number(localStorage.getItem(key))
    return allowed.includes(v) ? v : 0
  } catch {
    return 0
  }
}

const UNITS_KEY = 'lucent.sizeUnits'
export type SizeUnits = 'decimal' | 'binary'
function loadUnits(): SizeUnits {
  try {
    return localStorage.getItem(UNITS_KEY) === 'binary' ? 'binary' : 'decimal'
  } catch {
    return 'decimal'
  }
}
setSizeUnits(loadUnits() === 'binary')

const NUMBERS_KEY = 'lucent.numberLocale'
export type NumberFormat = 'system' | 'en' | 'de' | 'fr'
function loadNumbers(): NumberFormat {
  try {
    const v = localStorage.getItem(NUMBERS_KEY)
    return v === 'en' || v === 'de' || v === 'fr' ? v : 'system'
  } catch {
    return 'system'
  }
}
setNumberLocale(loadNumbers() === 'system' ? null : loadNumbers())

const CARD_KEY = 'lucent.cardAction'
export type CardAction = 'nothing' | 'tell' | 'open'
function loadCard(): CardAction {
  try {
    const v = localStorage.getItem(CARD_KEY)
    return v === 'nothing' || v === 'open' ? v : 'tell'
  } catch {
    return 'tell'
  }
}

const AFTER_KEY = 'lucent.afterExport'
export type AfterExport = 'nothing' | 'folder'
function loadAfter(): AfterExport {
  try {
    return localStorage.getItem(AFTER_KEY) === 'folder' ? 'folder' : 'nothing'
  } catch {
    return 'nothing'
  }
}

const WATCH_KEY = 'lucent.watch'
function loadWatch(): WatchConfig | null {
  try {
    const v = JSON.parse(localStorage.getItem(WATCH_KEY) ?? 'null') as Partial<WatchConfig> | null
    if (!v || typeof v.folder !== 'string' || !v.folder) return null
    return { folder: v.folder, mode: v.mode === 'move' || v.mode === 'copy' ? v.mode : 'add', destination: typeof v.destination === 'string' ? v.destination : null }
  } catch {
    return null
  }
}

const SMART_KEY = 'lucent.smartOnImport'
const loadSmart = (): boolean => {
  try {
    return localStorage.getItem(SMART_KEY) === '1'
  } catch {
    return false
  }
}

const TETHER_KEY = 'lucent.tetherShow'
const loadTether = (): boolean => {
  try {
    return localStorage.getItem(TETHER_KEY) === '1'
  } catch {
    return false
  }
}

const OPEN_KEY = 'lucent.afterExportOpen'
export type AfterExportOpen = 'no' | 'editor' | 'viewer'
function loadOpen(): AfterExportOpen {
  try {
    const v = localStorage.getItem(OPEN_KEY)
    return v === 'editor' || v === 'viewer' ? v : 'no'
  } catch {
    return 'no'
  }
}

const CHECK_KEY = 'lucent.checkMissing'
function loadCheck(): boolean {
  try {
    return localStorage.getItem(CHECK_KEY) !== '0'
  } catch {
    return true
  }
}

const EDITOR_KEY = 'lucent.externalEditor'
function loadEditor(): string {
  try {
    return localStorage.getItem(EDITOR_KEY) ?? ''
  } catch {
    return ''
  }
}

export const usePrefs = create<{
  reminderDays: ReminderDays
  setReminderDays(d: ReminderDays): void
  hideAi: boolean
  setHideAi(on: boolean): void
  /** The program "Open in external editor" uses: the full path of its .exe, or empty for Windows' own choice. */
  externalEditor: string
  setExternalEditor(path: string): void
  /** Look for photos whose files are gone each time the program starts (on by default). */
  checkMissing: boolean
  setCheckMissing(on: boolean): void
  /** What the Export window does when it has finished. */
  afterExport: AfterExport
  setAfterExport(a: AfterExport): void
  /** Build a smart preview for every photo an import adds (for editing and exporting when the file is offline). */
  smartOnImport: boolean
  setSmartOnImport(on: boolean): void
  /** Show each photo that arrives in the watched folder, big, as it comes (shooting with the camera tethered through a program that saves into the folder). */
  tetherShow: boolean
  setTetherShow(on: boolean): void
  /** The folder that is watched for new photos (null: none). Sent to the core at start-up. */
  watch: WatchConfig | null
  setWatch(w: WatchConfig | null): void
  /** After an export, open the pictures (at most ten) in the external editor or in the program Windows uses for pictures. */
  afterExportOpen: AfterExportOpen
  setAfterExportOpen(a: AfterExportOpen): void
  /** What happens when a memory card is plugged in. */
  cardAction: CardAction
  setCardAction(a: CardAction): void
  /** How file sizes are written: GB (a thousand million bytes) or GiB (1024 x 1024 x 1024). */
  sizeUnits: SizeUnits
  setSizeUnits(u: SizeUnits): void
  /** How numbers are written and read: as the computer does, or as English (1,234.5), German (1.234,5) or French (1 234,5) does. */
  numberFormat: NumberFormat
  setNumberFormat(f: NumberFormat): void
  /** The most room the previews may take, in GB (0 = no limit), and how old one may get, in days (0 = never discarded). */
  previewLimitGb: number
  previewMaxDays: number
  setPreviewLimits(gb: number, days: number): void
  /** The most worker threads heavy work may use; 0 lets the program decide. Sent to the core at start-up and when it changes. */
  threads: number
  setThreads(n: number): void
}>((set) => ({
  previewLimitGb: loadChoice(LIMIT_GB_KEY, PREVIEW_LIMIT_GB),
  previewMaxDays: loadChoice(LIMIT_DAYS_KEY, PREVIEW_MAX_DAYS),
  setPreviewLimits(gb, days) {
    set({ previewLimitGb: gb, previewMaxDays: days })
    try {
      localStorage.setItem(LIMIT_GB_KEY, String(gb))
      localStorage.setItem(LIMIT_DAYS_KEY, String(days))
    } catch {
      /* the choice just lasts for this session */
    }
  },
  sizeUnits: loadUnits(),
  setSizeUnits(u) {
    setSizeUnits(u === 'binary')
    set({ sizeUnits: u })
    try {
      localStorage.setItem(UNITS_KEY, u)
    } catch {
      /* the choice just lasts for this session */
    }
  },
  numberFormat: loadNumbers(),
  setNumberFormat(f) {
    setNumberLocale(f === 'system' ? null : f)
    set({ numberFormat: f })
    try {
      localStorage.setItem(NUMBERS_KEY, f)
    } catch {
      /* the choice just lasts for this session */
    }
  },
  cardAction: loadCard(),
  setCardAction(a) {
    set({ cardAction: a })
    try {
      localStorage.setItem(CARD_KEY, a)
    } catch {
      /* the choice just lasts for this session */
    }
  },
  afterExport: loadAfter(),
  tetherShow: loadTether(),
  setTetherShow(on) {
    set({ tetherShow: on })
    try {
      localStorage.setItem(TETHER_KEY, on ? '1' : '0')
    } catch {
      /* the choice just lasts for this session */
    }
  },
  smartOnImport: loadSmart(),
  setSmartOnImport(on) {
    set({ smartOnImport: on })
    try {
      localStorage.setItem(SMART_KEY, on ? '1' : '0')
    } catch {
      /* the choice just lasts for this session */
    }
  },
  watch: loadWatch(),
  setWatch(w) {
    set({ watch: w })
    try {
      if (w) localStorage.setItem(WATCH_KEY, JSON.stringify(w))
      else localStorage.removeItem(WATCH_KEY)
    } catch {
      /* the choice just lasts for this session */
    }
  },
  afterExportOpen: loadOpen(),
  setAfterExportOpen(a) {
    set({ afterExportOpen: a })
    try {
      localStorage.setItem(OPEN_KEY, a)
    } catch {
      /* the choice just lasts for this session */
    }
  },
  setAfterExport(a) {
    set({ afterExport: a })
    try {
      localStorage.setItem(AFTER_KEY, a)
    } catch {
      /* the choice just lasts for this session */
    }
  },
  checkMissing: loadCheck(),
  setCheckMissing(on) {
    set({ checkMissing: on })
    try {
      localStorage.setItem(CHECK_KEY, on ? '1' : '0')
    } catch {
      /* the choice just lasts for this session */
    }
  },
  threads: loadThreads(),
  setThreads(n) {
    const threads = Math.max(0, Math.min(32, Math.round(n)))
    set({ threads })
    try {
      localStorage.setItem(THREADS_KEY, String(threads))
    } catch {
      /* the choice just lasts for this session */
    }
    void api().perfSet(threads).catch(() => undefined)
  },
  externalEditor: loadEditor(),
  setExternalEditor(path) {
    set({ externalEditor: path })
    try {
      localStorage.setItem(EDITOR_KEY, path)
    } catch {
      /* the choice just lasts for this session */
    }
  },
  reminderDays: load(),
  hideAi: loadHideAi(),
  setHideAi(on) {
    set({ hideAi: on })
    try {
      localStorage.setItem(AI_KEY, on ? '1' : '0')
    } catch {
      /* the choice just lasts for this session */
    }
  },
  setReminderDays(d) {
    set({ reminderDays: d })
    try {
      localStorage.setItem(KEY, String(d))
    } catch {
      /* the choice just lasts for this session */
    }
  },
}))

/** Is a backup due? `last` is "2026-10-18 15:30" (or null for never), `days` the reminder choice (0 = never remind). */
export function backupDue(last: string | null, days: ReminderDays, now = Date.now()): boolean {
  if (days === 0) return false
  if (last === null) return true
  const t = new Date(last.replace(' ', 'T')).getTime()
  return Number.isNaN(t) || now - t > days * 24 * 3600 * 1000
}

/** The main parts this app is built from and their licences (the full list is in the licences folder, with the texts). */
export const COMPONENTS: { name: string; use: string; licence: string }[] = [
  { name: 'YuNet', use: 'finding faces', licence: 'MIT' },
  { name: 'Real-ESRGAN', use: 'enlarging with AI', licence: 'BSD-3-Clause' },
  { name: 'U2-Net', use: 'choosing the subject and background', licence: 'Apache-2.0' },
  { name: 'MI-GAN', use: 'removing distractions', licence: 'MIT' },
  { name: 'Montserrat', use: 'the lettering', licence: 'SIL Open Font Licence 1.1' },
  { name: 'rawler', use: 'reading RAW files', licence: 'LGPL-2.1 (see THIRD_PARTY.md)' },
  { name: 'Tauri, React, SQLite and many other libraries', use: 'the window and the catalog', licence: 'mostly MIT or Apache-2.0' },
]
