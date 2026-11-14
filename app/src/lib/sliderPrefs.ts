import { create } from 'zustand'

const KEY = 'penumbra.sliderArrows'

function load(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false // storage unavailable: arrows off
  }
}

/** Whether every adjustment shows up/down arrows beside its number for fine tuning. Off by default; remembered. */
export const useSliderPrefs = create<{ arrows: boolean; setArrows(on: boolean): void }>((set) => ({
  arrows: load(),
  setArrows(on) {
    set({ arrows: on })
    try {
      localStorage.setItem(KEY, on ? '1' : '0')
    } catch {
      /* the choice just lasts for this session */
    }
  },
}))
