/** What the Import window remembers from the last import (kept in this window's storage): how, how the files are named and filed, and what is put on them. */
export interface ImportDefaults {
  mode: 'add' | 'copy' | 'copy_dng' | 'move'
  nameTemplate: string
  folderFormat: 'YYYY-MM-DD' | 'YYYY/MM/DD' | 'YYYY/YYYY-MM-DD' | 'YYYY-MM' | 'YYYY' | 'flat'
  skipSuspected: boolean
  devPreset: string
  metaPreset: string
  keywords: string
  /** also bring in the photos in the folders inside the chosen folder */
  subfolders: boolean
}

export const FOLDER_FORMATS: ImportDefaults['folderFormat'][] = ['YYYY-MM-DD', 'YYYY/MM/DD', 'YYYY/YYYY-MM-DD', 'YYYY-MM', 'YYYY', 'flat']
export const START: ImportDefaults = { mode: 'add', nameTemplate: '{name}', folderFormat: 'YYYY-MM-DD', skipSuspected: false, devPreset: '', metaPreset: '', keywords: '', subfolders: true }
const KEY = 'lucent.importDefaults'

export function loadImportDefaults(): ImportDefaults {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<ImportDefaults> | null
    if (!r || typeof r !== 'object') return START
    const text = (v: unknown, d: string, max: number) => (typeof v === 'string' ? v.slice(0, max) : d)
    return {
      mode: r.mode === 'copy' || r.mode === 'move' || r.mode === 'copy_dng' ? r.mode : 'add',
      nameTemplate: text(r.nameTemplate, START.nameTemplate, 120) || START.nameTemplate,
      folderFormat: FOLDER_FORMATS.includes(r.folderFormat as ImportDefaults['folderFormat']) ? (r.folderFormat as ImportDefaults['folderFormat']) : START.folderFormat,
      skipSuspected: r.skipSuspected === true,
      devPreset: text(r.devPreset, '', 100),
      metaPreset: text(r.metaPreset, '', 100),
      keywords: text(r.keywords, '', 500),
      subfolders: r.subfolders !== false,
    }
  } catch {
    return START
  }
}

export function saveImportDefaults(d: ImportDefaults) {
  try {
    localStorage.setItem(KEY, JSON.stringify(d))
  } catch {
    /* the choice lasts until the window closes */
  }
}
