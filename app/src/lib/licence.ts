import { create } from 'zustand'
import { api } from './api'
import type { LicenceStatus } from './types'

/** Where the licence stands: licensed, in the 30 day trial, or expired. Loaded when the window opens. */
export const useLicence = create<{ status: LicenceStatus | null; refresh: () => Promise<void>; enter: (key: string) => Promise<LicenceStatus> }>((set) => ({
  status: null,
  refresh: async () => {
    try {
      set({ status: await api().licenceStatus() })
    } catch {
      /* the chip simply stays hidden */
    }
  },
  enter: async (key) => {
    const s = await api().licenceEnter(key)
    set({ status: s })
    return s
  },
}))
