import { create } from 'zustand'

/** Like Lightroom's L key: everything round the photo is on, dimmed, or out. Not saved: it always starts on. */
export type Lights = 'on' | 'dim' | 'out'

export const nextLights = (l: Lights): Lights => (l === 'on' ? 'dim' : l === 'dim' ? 'out' : 'on')

function show(l: Lights) {
  if (typeof document !== 'undefined') {
    if (l === 'on') delete document.documentElement.dataset.lights
    else document.documentElement.dataset.lights = l
  }
}

/** From the Library: open the photo in Develop at 100% (waits for Develop to have the photo, then zooms in). */
export async function zoomFromLibrary(go: () => void, ready: () => boolean, zoomIn: () => void) {
  go()
  for (let i = 0; i < 100; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (ready()) return zoomIn()
  }
}

export const useLights = create<{ lights: Lights; set(l: Lights): void; cycle(): void }>((set, get) => ({
  lights: 'on',
  set(lights) {
    show(lights)
    set({ lights })
  },
  cycle() {
    get().set(nextLights(get().lights))
  },
}))
