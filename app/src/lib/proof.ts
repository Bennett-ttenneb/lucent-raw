import { create } from 'zustand'
import { api } from './api'
import type { ProofIntent } from './types'

const KEY = 'lucent.proof'

interface Saved {
  path: string | null
  intent: ProofIntent
}

function load(): Saved {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Saved> | null
    const intent = v?.intent === 'perceptual' || v?.intent === 'saturation' || v?.intent === 'absolute' ? v.intent : 'relative'
    return { path: typeof v?.path === 'string' ? v.path : null, intent }
  } catch {
    return { path: null, intent: 'relative' }
  }
}

const save = (s: Saved) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(s))
  } catch {
    /* the choice just lasts for this session */
  }
}

/** Soft proofing: the profile chosen, how it is applied, and whether Develop shows the proof. Showing the proof is never remembered. */
export const useProof = create<{
  path: string | null
  name: string | null
  intent: ProofIntent
  on: boolean
  gamut: boolean
  /** changes whenever the profile or the way it is applied does, so the picture is asked for again */
  rev: number
  error: string | null
  /** send the remembered profile to the core again (start-up) */
  restore(): Promise<void>
  choose(): Promise<void>
  setIntent(i: ProofIntent): Promise<void>
  setOn(on: boolean): void
  setGamut(on: boolean): void
  clear(): Promise<void>
}>((set, get) => ({
  ...load(),
  name: null,
  on: false,
  gamut: false,
  rev: 0,
  error: null,
  async restore() {
    const { path, intent } = get()
    if (!path) return
    try {
      const r = await api().proofSet(path, intent)
      set({ name: r?.name ?? null, error: null })
    } catch {
      set({ path: null, name: null })
      save({ path: null, intent })
    }
  },
  async choose() {
    try {
      const path = await api().pickProfile()
      if (!path) return
      const r = await api().proofSet(path, get().intent)
      set((s) => ({ path, name: r?.name ?? null, on: true, error: null, rev: s.rev + 1 }))
      save({ path, intent: get().intent })
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },
  async setIntent(intent) {
    set({ intent })
    const { path } = get()
    save({ path, intent })
    if (!path) return
    try {
      await api().proofSet(path, intent)
      set((s) => ({ error: null, rev: s.rev + 1 })) // the same profile, handled another way: the picture is asked for again
    } catch (e) {
      set({ error: (e as Error).message })
    }
  },
  setOn: (on) => set({ on: on && get().name !== null }),
  setGamut: (gamut) => set({ gamut }),
  async clear() {
    await api().proofSet(null, get().intent).catch(() => undefined)
    set({ path: null, name: null, on: false, gamut: false, error: null })
    save({ path: null, intent: get().intent })
  },
}))

/** What the render request asks for: nothing, or the proof (with the colours it cannot reproduce marked, when asked). */
export const proofMode = (s: { on: boolean; name: string | null; gamut: boolean; rev: number }): { gamut: boolean; rev: number } | undefined => (s.on && s.name ? { gamut: s.gamut, rev: s.rev } : undefined)
