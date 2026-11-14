import { create } from 'zustand'
import { api } from './api'
import { exposureLine } from './format'
import { useStore } from './store'

/** What the main window tells the second window to show. */
export interface SecondShow {
  id: number | null
  /** the photo's name and settings, written out */
  label: string
  /** changes when the photo's picture does, so the second window fetches it again */
  key: string
}

/** The second window (a second screen): open or not, and following the main window's open photo or locked on one. */
export const useSecond = create<{
  open: boolean
  /** the photo the second window is held on, when it is locked */
  lockedId: number | null
  openIt(): Promise<void>
  close(): Promise<void>
  /** hold the second window on the open photo (or let it follow again) */
  toggleLock(): void
}>((set, get) => ({
  open: false,
  lockedId: null,
  async openIt() {
    try {
      await api().secondOpen()
      set({ open: true })
      sendNow()
    } catch (e) {
      useStore.getState().say((e as Error).message, true)
    }
  },
  async close() {
    await api().secondClose().catch(() => undefined)
    set({ open: false, lockedId: null })
  },
  toggleLock() {
    const s = useStore.getState()
    const here = s.photoAt(s.active)?.id ?? null
    set({ lockedId: get().lockedId === null ? here : null })
    sendNow()
  },
}))

/** Send the photo to show to the second window. */
function sendNow() {
  const { open, lockedId } = useSecond.getState()
  if (!open) return
  const s = useStore.getState()
  const id = lockedId ?? s.photoAt(s.active)?.id ?? null
  const photo = id === null ? undefined : Object.values(s.pages).flat().find((p) => p.id === id)
  const show: SecondShow = photo
    ? { id: photo.id, label: [photo.name, exposureLine(photo)].filter(Boolean).join('   '), key: `${s.previewVersion}.${s.photoVersion[photo.id] ?? 0}` }
    : { id: null, label: '', key: '' }
  void api().secondShow(show).catch(() => undefined)
}

/** Keep the second window on the open photo; returns the way to stop. */
export function startSecondSync(): () => void {
  let last = ''
  const offStore = useStore.subscribe((s) => {
    const p = s.photoAt(s.active)
    const sig = `${p?.id ?? ''}|${s.previewVersion}|${p ? s.photoVersion[p.id] ?? 0 : ''}`
    if (sig !== last) {
      last = sig
      sendNow()
    }
  })
  const offSecond = useSecond.subscribe((s, prev) => s.lockedId !== prev.lockedId && sendNow())
  let offClosed = () => {}
  void api()
    .on<void>('second:closed', () => useSecond.setState({ open: false, lockedId: null }))
    .then((u) => (offClosed = u))
  return () => {
    offStore()
    offSecond()
    offClosed()
  }
}
