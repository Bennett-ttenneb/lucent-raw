import { create } from 'zustand'
import { api } from './api'
import { applyLayout, autoPages, newPhotoFrame, newTextFrame } from './bookLayouts'
import type { BookDoc, BookEntry, BookFrame, BookPage } from './types'

const SAVE_AFTER_MS = 500
export const MAX_PAGES = 200
export const MAX_FRAMES = 12

interface BookState {
  list: BookEntry[]
  bookId: number | null
  book: BookDoc | null
  page: number
  frame: number | null
  /** what is wrong, in words (a failed save or load) */
  error: string | null
  loaded: boolean
  /** how many steps can be undone and redone */
  undoable: number
  redoable: number

  load(): Promise<void>
  create(name?: string): Promise<void>
  open(id: number | null): Promise<void>
  remove(id: number): Promise<void>
  /** Change the book; it is saved a moment later. */
  edit(fn: (b: BookDoc) => BookDoc): void
  flush(): Promise<void>
  undo(): void
  redo(): void
  /** Another catalog is open: nothing here belongs to it (book numbers start again in every catalog). */
  reset(): void

  setPage(i: number): void
  selectFrame(i: number | null): void
  addPage(layoutId?: string): void
  duplicatePage(): void
  deletePage(): void
  movePage(by: -1 | 1): void
  layout(layoutId: string): void
  setPageBackground(colour: string): void
  patchFrame(i: number, patch: Partial<BookFrame>): void
  addText(): void
  deleteFrame(i: number): void
  /** Put a photo in a frame, or in the first empty photo frame of the page when `i` is null. */
  putPhoto(i: number | null, photoId: number): void
  /** Make pages from photos, `perPage` to a page, after the pages that are there. */
  fillFrom(photoIds: number[], perPage: number): void
}

let timer: ReturnType<typeof setTimeout> | undefined
let dirty = false

/** The books as they were before each step, and after the steps that were undone. Changes that follow each other quickly (a slider, a drag, typing) are one step. */
const STEPS = 100
const JOIN_MS = 700
let past: BookDoc[] = []
let future: BookDoc[] = []
let lastEdit = 0
const forget = () => {
  past = []
  future = []
  lastEdit = 0
}

export const useBook = create<BookState>((set, get) => {
  const saveNow = async () => {
    clearTimeout(timer)
    const { bookId, book } = get()
    if (!dirty || bookId === null || !book) return
    dirty = false
    try {
      await api().bookSave(bookId, book)
      set((s) => ({ error: null, list: s.list.map((e) => (e.id === bookId ? { ...e, name: book.name.trim() || 'Untitled book', pages: book.pages.length } : e)) }))
    } catch (e) {
      dirty = true
      set({ error: (e as Error).message })
    }
  }
  const edit = (fn: (b: BookDoc) => BookDoc) => {
    const b = get().book
    if (!b) return
    const next = fn(b)
    const now = Date.now()
    if (now - lastEdit > JOIN_MS || past.length === 0) {
      past.push(b)
      if (past.length > STEPS) past.shift()
    }
    lastEdit = now
    future = []
    const page = Math.min(get().page, Math.max(next.pages.length - 1, 0))
    set({ book: next, page, frame: get().page === page ? get().frame : null, undoable: past.length, redoable: 0 })
    dirty = true
    clearTimeout(timer)
    timer = setTimeout(() => void saveNow(), SAVE_AFTER_MS)
  }
  const editPage = (fn: (p: BookPage) => BookPage) =>
    edit((b) => ({ ...b, pages: b.pages.map((p, i) => (i === get().page ? fn(p) : p)) }))

  return {
    list: [],
    bookId: null,
    book: null,
    page: 0,
    frame: null,
    error: null,
    loaded: false,
    undoable: 0,
    redoable: 0,

    async load() {
      try {
        set({ list: await api().bookList(), loaded: true, error: null })
      } catch (e) {
        set({ error: (e as Error).message, loaded: true })
      }
    },
    async create(name) {
      await saveNow()
      try {
        const id = await api().bookCreate(name)
        await get().load()
        await get().open(id)
      } catch (e) {
        set({ error: (e as Error).message })
      }
    },
    async open(id) {
      await saveNow()
      forget()
      if (id === null) return void set({ bookId: null, book: null, page: 0, frame: null, undoable: 0, redoable: 0 })
      try {
        const book = await api().bookGet(id)
        dirty = false
        set({ bookId: id, book, page: 0, frame: null, error: null, undoable: 0, redoable: 0 })
      } catch (e) {
        set({ error: (e as Error).message })
      }
    },
    async remove(id) {
      try {
        await api().bookDelete(id)
        if (get().bookId === id) {
          dirty = false
          forget()
          set({ bookId: null, book: null, page: 0, frame: null, undoable: 0, redoable: 0 })
        }
        await get().load()
      } catch (e) {
        set({ error: (e as Error).message })
      }
    },
    edit,
    flush: saveNow,
    reset() {
      clearTimeout(timer)
      dirty = false
      forget()
      set({ list: [], bookId: null, book: null, page: 0, frame: null, error: null, loaded: false, undoable: 0, redoable: 0 })
    },
    undo() {
      const b = get().book
      const back = past.pop()
      if (!b || !back) return
      future.push(b)
      lastEdit = 0
      set({ book: back, page: Math.min(get().page, back.pages.length - 1), frame: null, undoable: past.length, redoable: future.length })
      dirty = true
      clearTimeout(timer)
      timer = setTimeout(() => void saveNow(), SAVE_AFTER_MS)
    },
    redo() {
      const b = get().book
      const ahead = future.pop()
      if (!b || !ahead) return
      past.push(b)
      lastEdit = 0
      set({ book: ahead, page: Math.min(get().page, ahead.pages.length - 1), frame: null, undoable: past.length, redoable: future.length })
      dirty = true
      clearTimeout(timer)
      timer = setTimeout(() => void saveNow(), SAVE_AFTER_MS)
    },

    setPage: (i) => set((s) => ({ page: Math.min(Math.max(i, 0), Math.max((s.book?.pages.length ?? 1) - 1, 0)), frame: null })),
    selectFrame: (i) => set({ frame: i }),
    addPage(layoutId = 'blank') {
      const b = get().book
      if (!b || b.pages.length >= MAX_PAGES) return
      const at = get().page + 1
      const page = applyLayout({ background: b.pages[get().page]?.background ?? '#FFFFFF', frames: [] }, layoutId)
      edit((x) => ({ ...x, pages: [...x.pages.slice(0, at), page, ...x.pages.slice(at)] }))
      set({ page: at, frame: null })
    },
    duplicatePage() {
      const b = get().book
      if (!b || b.pages.length >= MAX_PAGES) return
      const at = get().page + 1
      edit((x) => ({ ...x, pages: [...x.pages.slice(0, at), structuredClone(x.pages[get().page]), ...x.pages.slice(at)] }))
      set({ page: at, frame: null })
    },
    deletePage() {
      const b = get().book
      if (!b || b.pages.length <= 1) return
      const at = get().page
      edit((x) => ({ ...x, pages: x.pages.filter((_, i) => i !== at) }))
      set({ frame: null })
    },
    movePage(by) {
      const b = get().book
      const from = get().page
      const to = from + by
      if (!b || to < 0 || to >= b.pages.length) return
      edit((x) => {
        const pages = [...x.pages]
        ;[pages[from], pages[to]] = [pages[to], pages[from]]
        return { ...x, pages }
      })
      set({ page: to })
    },
    layout: (id) => {
      editPage((p) => applyLayout(p, id))
      set({ frame: null })
    },
    setPageBackground: (colour) => editPage((p) => ({ ...p, background: colour })),
    patchFrame: (i, patch) => editPage((p) => ({ ...p, frames: p.frames.map((f, k) => (k === i ? { ...f, ...patch } : f)) })),
    addText() {
      const p = get().book?.pages[get().page]
      if (!p || p.frames.length >= MAX_FRAMES) return
      editPage((x) => ({ ...x, frames: [...x.frames, newTextFrame([0.1, 0.8, 0.8, 0.1], 'Your text')] }))
      set({ frame: p.frames.length })
    },
    deleteFrame(i) {
      editPage((p) => ({ ...p, frames: p.frames.filter((_, k) => k !== i) }))
      set({ frame: null })
    },
    putPhoto(i, photoId) {
      const p = get().book?.pages[get().page]
      if (!p) return
      let at = i
      if (at === null) at = p.frames.findIndex((f) => f.kind === 'photo' && f.photoId === null)
      if (at === -1 || at === null) {
        // no empty place: a new frame on the page, if there is room for one
        if (p.frames.length >= MAX_FRAMES) return
        editPage((x) => ({ ...x, frames: [...x.frames, newPhotoFrame([0.1, 0.1, 0.8, 0.8], photoId)] }))
        return void set({ frame: p.frames.length })
      }
      if (p.frames[at]?.kind !== 'photo') return
      get().patchFrame(at, { photoId, focusX: 0.5, focusY: 0.5 })
      set({ frame: at })
    },
    fillFrom(photoIds, perPage) {
      const b = get().book
      if (!b || !photoIds.length) return
      const made = autoPages(photoIds, perPage).slice(0, MAX_PAGES - b.pages.length)
      if (!made.length) return
      // a book that is still one empty page starts with the new pages
      const empty = b.pages.length === 1 && b.pages[0].frames.length === 0
      const first = empty ? 0 : b.pages.length
      edit((x) => ({ ...x, pages: empty ? made : [...x.pages, ...made] }))
      set({ page: first, frame: null })
    },
  }
})

// an edit still waiting for its half second is sent when the window is closed or hidden (best effort)
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => void useBook.getState().flush())
  document.addEventListener('visibilitychange', () => document.visibilityState === 'hidden' && void useBook.getState().flush())
}
