import { create } from 'zustand'

export type CropGrid = 'thirds' | 'golden' | 'diagonal' | 'triangle' | 'fine' | 'off'
const KEY = 'penumbra.cropGrid'

function load(): CropGrid {
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'thirds' || v === 'golden' || v === 'diagonal' || v === 'triangle' || v === 'fine' || v === 'off') return v
  } catch {
    /* storage unavailable: the default */
  }
  return 'thirds'
}

/** Which grid is drawn inside the crop frame. Remembered. */
export const useCropPrefs = create<{ grid: CropGrid; setGrid(g: CropGrid): void }>((set) => ({
  grid: load(),
  setGrid(grid) {
    set({ grid })
    try {
      localStorage.setItem(KEY, grid)
    } catch {
      /* the choice just lasts for this session */
    }
  },
}))
