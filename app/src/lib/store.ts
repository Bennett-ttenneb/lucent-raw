import { create } from 'zustand'
import { api } from './api'
import { nextRating, type KeyAction } from './keys'
import { usePrefs } from './prefs'
import type { CatalogInfo, CollectionRow, Filters, Flag, FolderRow, KeywordRow, Label, Photo } from './types'

export const PAGE = 200

export type ModuleId = 'library' | 'develop' | 'retouch' | 'map' | 'book' | 'slideshow' | 'print' | 'web'
export type ViewMode = 'grid' | 'loupe' | 'compare' | 'survey'

export const DEFAULT_FILTERS: Filters = { sort: 'capture', desc: false }

export interface ViewOptions {
  index: boolean
  badges: boolean
  labels: boolean
  /** the file name along the bottom of each cell */
  names: boolean
  /** the capture date and the camera settings under the name */
  details: boolean
}
const VIEW_KEY = 'penumbra.viewOptions'
const DEFAULT_VIEW: ViewOptions = { index: true, badges: true, labels: true, names: false, details: false }

function loadViewOptions(): ViewOptions {
  try {
    const raw = JSON.parse(localStorage.getItem(VIEW_KEY) ?? 'null')
    if (raw && typeof raw === 'object') return { ...DEFAULT_VIEW, ...Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'boolean')) }
  } catch {
    /* storage unavailable or corrupt: use defaults */
  }
  return DEFAULT_VIEW
}

/** Where the grid is looking. Only one source at a time. */
export type Source = { folderId?: number; collectionId?: number; keywordId?: number }

interface State {
  filters: Filters
  total: number
  pages: Record<number, Photo[]>
  gen: number
  active: number
  anchor: number
  selected: Set<number>
  module: ModuleId
  view: ViewMode
  /** Compare view: the photo kept on the left (the Select); the one on the right is the open photo (the Candidate) */
  compareSelect: number | null
  thumbSize: number
  cols: number
  folders: FolderRow[]
  collections: CollectionRow[]
  keywords: KeywordRow[]
  viewOptions: ViewOptions
  removeOpen: boolean
  /** the Auto-stack by capture time window */
  autoStackOpen: boolean
  /** the Merge window: for an HDR (exposures) or a panorama (taken in turn) */
  mergeOpen: 'hdr' | 'pano' | 'denoise' | 'focus' | null
  /** the Remove window's tick box: also move the files to the Recycle Bin */
  removeDisk: boolean
  info: CatalogInfo | null
  previewVersion: number
  /** per photo: bumps when that photo's edited picture is ready, so only its thumbnail reloads */
  photoVersion: Record<number, number>
  toast: { id: number; text: string; error: boolean } | null
  importOpen: boolean
  /** a card that was just plugged in, for the Import window to start from */
  importCard: string | null
  exportOpen: boolean
  cullOpen: boolean
  catalogsOpen: boolean
  mcpOpen: boolean
  missingOpen: boolean
  sidecarsOpen: boolean
  preferencesOpen: boolean
  /** the smart collection rule builder: a new one (id null) or an existing one */
  smartDialog: { id: number | null } | null
  /** settings the Export dialog should start with the next time it opens (the Enlarge panel sets the size and the way) */
  exportPatch: Partial<import('./types').ExportSettings> | null
  helpOpen: boolean
  loaded: boolean

  init(): Promise<void>
  reload(): Promise<void>
  ensurePage(p: number): Promise<void>
  photoAt(i: number): Photo | undefined
  setFilters(patch: Partial<Filters>): Promise<void>
  setSource(src: Source): Promise<void>
  setViewOptions(patch: Partial<ViewOptions>): void
  /** Mark a photo as edited or not in the loaded pages (Develop saved it). */
  setEdited(id: number, edited: boolean): void
  quick(): Promise<void>
  addToTarget(): Promise<void>
  confirmRemove(fromDisk?: boolean): Promise<void>
  clickIndex(i: number, mode: 'single' | 'toggle' | 'range'): void
  targetIds(): number[]
  rate(value: number): Promise<void>
  flag(value: Flag): Promise<void>
  label(value: Label | null): Promise<void>
  perform(a: KeyAction): void
  /** Stacks: group the selected photos (the first in the grid is the top), take them apart, take photos out, open or close the open photo's stack, open or close all, or make the open photo the top. */
  stackAction(op: 'group' | 'ungroup' | 'remove' | 'toggle' | 'openAll' | 'closeAll' | 'top'): Promise<void>
  /** Open the Compare view: the open photo becomes the Select and the next photo the Candidate. */
  openCompare(): void
  /** Compare view: the Candidate becomes the Select and the next photo is the new Candidate. */
  compareMakeSelect(): void
  /** Compare view: swap the Select and the Candidate. */
  compareSwap(): void
  /** The position of a photo in the loaded pages, or -1. */
  indexOfId(id: number): number
  /** Make a virtual copy of each selected photo (or the open one) and select the copies. */
  makeVirtualCopies(): Promise<void>
  /** Make an edited copy (a TIFF with the edits applied) beside the open photo and open it in the external editor. */
  editCopyInEditor(): Promise<void>
  /** Send the open photo's file to the external editor chosen in Preferences. */
  openInEditor(): Promise<void>
  say(text: string, error?: boolean): void
  set(patch: Partial<State>): void
}

const inflight = new Set<string>()
let toastId = 0

export const useStore = create<State>((set, get) => ({
  filters: DEFAULT_FILTERS,
  total: 0,
  pages: {},
  gen: 0,
  active: -1,
  anchor: -1,
  selected: new Set(),
  module: 'library',
  view: 'grid',
  compareSelect: null,
  thumbSize: 180,
  cols: 6,
  folders: [],
  collections: [],
  keywords: [],
  viewOptions: loadViewOptions(),
  removeOpen: false,
  autoStackOpen: false,
  mergeOpen: null,
  removeDisk: false,
  info: null,
  previewVersion: 0,
  photoVersion: {},
  toast: null,
  importOpen: false,
  importCard: null,
  exportOpen: false,
  cullOpen: false,
  catalogsOpen: false,
  mcpOpen: false,
  missingOpen: false,
  sidecarsOpen: false,
  preferencesOpen: false,
  smartDialog: null,
  exportPatch: null,
  helpOpen: false,
  loaded: false,

  set: (patch) => set(patch),

  say(text, error = false) {
    const id = ++toastId
    set({ toast: { id, text, error } })
    setTimeout(() => get().toast?.id === id && set({ toast: null }), error ? 5000 : 1800)
  },

  async init() {
    const a = api()
    await a.on<number>('watch:imported', (n) => {
      get().say(n === 1 ? '1 new photo was imported from the watched folder.' : n + ' new photos were imported from the watched folder.')
      void get().reload()
    })
    await a.on<number | null>('watch:newest', (id) => {
      if (id === null || !usePrefs.getState().tetherShow) return
      void get().reload().then(() => {
        const at = get().indexOfId(id)
        if (at >= 0) {
          get().clickIndex(at, 'single')
          set({ view: 'loupe' })
        }
      })
    })
    await a.on<number[]>('preview:ready', () => set((s) => ({ previewVersion: s.previewVersion + 1 })))
    await a.on<number[]>('preview:edited', (ids) =>
      set((s) => ({ photoVersion: { ...s.photoVersion, ...Object.fromEntries(ids.map((id) => [id, (s.photoVersion[id] ?? 0) + 1])) } })),
    )
    try {
      set({ info: await a.catalogInfo() })
    } catch (e) {
      get().say((e as Error).message, true)
    }
    await get().reload()
    set({ loaded: true })
    // a memory card that is plugged in while the program is open: say so, or open the Import window on it (the cards already there at start-up are not news)
    let knownCards: string[] | null = null
    const watchCards = async () => {
      try {
        const now = (await a.importCards()).map((c) => c.path)
        if (knownCards !== null) {
          const fresh = now.filter((p) => !knownCards!.includes(p))
          const action = usePrefs.getState().cardAction
          if (fresh.length > 0 && action !== 'nothing') {
            if (action === 'open') set({ importOpen: true, importCard: fresh[0] })
            else get().say(`A memory card is plugged in (${fresh[0].replace(/\/DCIM$/, '')}). Import… brings its photos in.`)
          }
        }
        knownCards = now
      } catch {
        /* no card list on this computer */
      }
    }
    void watchCards()
    setInterval(() => void watchCards(), 4000)
    // keep the previews within the limits chosen in Preferences
    const pl = usePrefs.getState()
    if (pl.previewLimitGb > 0 || pl.previewMaxDays > 0) void a.cacheTrim(pl.previewLimitGb * 1_000_000_000, pl.previewMaxDays).catch(() => undefined)
    // look for photos whose files have gone, so the person hears about it before opening one
    if (usePrefs.getState().checkMissing) {
      void a
        .missingScan()
        .then(async (r) => {
          if (r.missing > 0) {
            await get().reload()
            const n = r.missing
            get().say(`${n === 1 ? '1 photo cannot be found' : `${n} photos cannot be found`} on the disk. Catalogs > Find missing photos can reconnect ${n === 1 ? 'it' : 'them'}.`)
          }
        })
        .catch(() => undefined)
    }
  },

  async reload() {
    const gen = get().gen + 1
    inflight.clear()
    set({ gen })
    try {
      const [page, folders, info, collections, keywords] = await Promise.all([
        api().photoQuery({ ...get().filters, offset: 0, limit: PAGE }),
        api().folderList(),
        api().catalogInfo(),
        api().collectionList(),
        api().keywordList(),
      ])
      if (get().gen !== gen) return
      set((s) => {
        const active = page.total === 0 ? -1 : Math.min(Math.max(s.active, 0), page.total - 1)
        return { pages: { 0: page.rows }, total: page.total, folders, collections, keywords, info, active, anchor: active, selected: new Set() }
      })
    } catch (e) {
      get().say((e as Error).message, true)
    }
  },

  async ensurePage(p) {
    const s = get()
    const key = `${s.gen}:${p}`
    if (p < 0 || p * PAGE >= s.total || s.pages[p] || inflight.has(key)) return
    inflight.add(key)
    try {
      const page = await api().photoQuery({ ...s.filters, offset: p * PAGE, limit: PAGE })
      if (get().gen === s.gen) set((st) => ({ pages: { ...st.pages, [p]: page.rows } }))
    } catch (e) {
      get().say((e as Error).message, true)
    } finally {
      inflight.delete(key)
    }
  },

  photoAt(i) {
    if (i < 0) return undefined
    return get().pages[Math.floor(i / PAGE)]?.[i % PAGE]
  },

  async setFilters(patch) {
    set((s) => ({ filters: { ...s.filters, ...patch } }))
    await get().reload()
  },

  async setSource(src) {
    await get().setFilters({ folderId: src.folderId, collectionId: src.collectionId, keywordId: src.keywordId })
  },

  setEdited(id, edited) {
    patch([id], { edited })
  },

  setViewOptions(patch) {
    const next = { ...get().viewOptions, ...patch }
    set({ viewOptions: next })
    try {
      localStorage.setItem(VIEW_KEY, JSON.stringify(next))
    } catch {
      /* private window or blocked storage: the choice just lasts for this session */
    }
  },

  async quick() {
    const ids = get().targetIds()
    if (!ids.length) return
    try {
      const quick = get().collections.find((c) => c.kind === 'quick')
      const added = await api().quickToggle(ids)
      get().say(added ? 'Added to the Quick Collection' : 'Removed from the Quick Collection')
      await refreshCollections()
      if (get().filters.collectionId === quick?.id) await get().reload()
    } catch (e) {
      get().say((e as Error).message, true)
    }
  },

  async addToTarget() {
    const ids = get().targetIds()
    const target = get().collections.find((c) => c.isTarget)
    if (!ids.length) return
    if (!target) return get().say('No target collection yet. Choose one in the Collections panel.', true)
    try {
      await api().collectionAdd(target.id, ids)
      get().say(`Added to ${target.name}`)
      await refreshCollections()
    } catch (e) {
      get().say((e as Error).message, true)
    }
  },

  async stackAction(op) {
    const s = get()
    const here = s.photoAt(s.active)
    const ids = s.targetIds()
    try {
      let focus: number | null = here?.id ?? null
      let say = ''
      if (op === 'group') {
        if (ids.length < 2) return s.say('Select two or more photos to put into a stack.', true)
        const sorted = [...ids].sort((a, b) => s.indexOfId(a) - s.indexOfId(b))
        await api().stackGroup(sorted)
        focus = sorted[0]
        say = `Stacked ${sorted.length} photos.`
      } else if (op === 'ungroup' || op === 'remove') {
        const n = op === 'ungroup' ? await api().stackUngroup(ids) : await api().stackRemove(ids)
        if (n === 0) return s.say('The photo is not in a stack.', true)
        say = op === 'ungroup' ? `Unstacked.` : `Taken out of the stack.`
      } else if (op === 'toggle') {
        if (!here || here.stackId === null) return s.say('The photo is not in a stack.', true)
        await api().stackCollapse(here.stackId, !here.stackCollapsed)
      } else if (op === 'top') {
        if (!here || here.stackId === null) return s.say('The photo is not in a stack.', true)
        await api().stackMakeTop(here.id)
        say = `Made the top of its stack.`
      } else {
        await api().stackCollapse(null, op === 'closeAll')
        say = op === 'closeAll' ? 'Every stack is closed.' : 'Every stack is open.'
      }
      await get().reload()
      if (focus !== null) {
        const at = get().indexOfId(focus)
        if (at >= 0) get().clickIndex(at, 'single')
      }
      if (say) get().say(say)
    } catch (e) {
      get().say((e as Error).message, true)
    }
  },

  async confirmRemove(fromDisk = false) {
    const ids = get().targetIds()
    set({ removeOpen: false })
    if (!ids.length) return
    try {
      const n = fromDisk ? await api().photoDeleteFromDisk(ids) : await api().photoRemove(ids)
      get().say(fromDisk ? `${n} removed from the catalog and their files moved to the Recycle Bin.` : `${n} removed from the catalog. The files were not touched.`)
      await get().reload()
    } catch (e) {
      get().say((e as Error).message, true)
    }
  },

  clickIndex(i, mode) {
    const s = get()
    if (i < 0 || i >= s.total) return
    const p = s.photoAt(i)
    if (mode === 'range' && s.anchor >= 0) {
      const [lo, hi] = [Math.min(s.anchor, i), Math.max(s.anchor, i)]
      const ids = new Set<number>()
      for (let k = lo; k <= hi; k++) {
        const ph = s.photoAt(k)
        if (ph) ids.add(ph.id)
      }
      set({ active: i, selected: ids })
    } else if (mode === 'toggle' && p) {
      const next = new Set(s.selected)
      if (next.size === 0) {
        const cur = s.photoAt(s.active)
        if (cur) next.add(cur.id)
      }
      next.has(p.id) ? next.delete(p.id) : next.add(p.id)
      set({ active: i, anchor: i, selected: next })
    } else {
      set({ active: i, anchor: i, selected: p ? new Set([p.id]) : new Set() })
    }
    void get().ensurePage(Math.floor(i / PAGE))
  },

  targetIds() {
    const s = get()
    if (s.selected.size) return [...s.selected]
    const p = s.photoAt(s.active)
    return p ? [p.id] : []
  },

  async rate(value) {
    const ids = get().targetIds()
    if (!ids.length) return
    const photos = ids.map((id) => findPhoto(id)).filter(Boolean) as Photo[]
    const v = photos.length && photos.every((p) => p.rating === value) ? nextRating(value, value) : value
    const before = Object.fromEntries(photos.map((p) => [p.id, p.rating]))
    patch(ids, { rating: v })
    try {
      await api().setRating(ids, v)
      recordMarks('Rating', ids, before, v, (i, x) => api().setRating(i, x as number), 'rating')
      get().say(v === 0 ? 'Rating cleared' : `Rating set to ${v}`)
    } catch (e) {
      get().say((e as Error).message, true)
      void get().reload()
    }
  },

  async flag(value) {
    const ids = get().targetIds()
    if (!ids.length) return
    const photos = ids.map((id) => findPhoto(id)).filter(Boolean) as Photo[]
    const v: Flag = value !== 0 && photos.length && photos.every((p) => p.flag === value) ? 0 : value
    const before = Object.fromEntries(photos.map((p) => [p.id, p.flag]))
    patch(ids, { flag: v })
    try {
      await api().setFlag(ids, v)
      recordMarks('Flag', ids, before, v, (i, x) => api().setFlag(i, x as Flag), 'flag')
      get().say(v === 1 ? 'Marked as pick' : v === -1 ? 'Marked as reject' : 'Flag cleared')
    } catch (e) {
      get().say((e as Error).message, true)
      void get().reload()
    }
  },

  async label(value) {
    const ids = get().targetIds()
    if (!ids.length) return
    const photos = ids.map((id) => findPhoto(id)).filter(Boolean) as Photo[]
    const v = value && photos.length && photos.every((p) => p.label === value) ? null : value
    const before = Object.fromEntries(photos.map((p) => [p.id, p.label]))
    patch(ids, { label: v })
    try {
      await api().setLabel(ids, v)
      recordMarks('Colour label', ids, before, v, (i, x) => api().setLabel(i, x as Label | null), 'label')
      get().say(v ? `Label: ${v}` : 'Label cleared')
    } catch (e) {
      get().say((e as Error).message, true)
      void get().reload()
    }
  },

  async editCopyInEditor() {
    const s = get()
    const photo = s.photoAt(s.active)
    if (!photo) return
    try {
      s.say('Making an edited copy…')
      const r = await api().photoEditCopy(photo.id)
      await get().reload()
      await api().openInEditor(r.path, usePrefs.getState().externalEditor.trim() || null)
      get().say(`Made ${r.path.split('/').pop()} and opened it.`)
    } catch (e) {
      get().say((e as Error).message, true)
    }
  },

  async openInEditor() {
    const target = get().photoAt(get().active)
    if (!target) return
    try {
      await api().openInEditor(target.path, usePrefs.getState().externalEditor.trim() || null)
      get().say(`Sent ${target.name} to the editing program.`)
    } catch (e) {
      get().say((e as Error).message, true)
    }
  },
  async makeVirtualCopies() {
    const ids = get().targetIds()
    if (ids.length === 0) return
    try {
      const made = await api().photoVirtualCopy(ids)
      await get().reload()
      set({ selected: new Set(made) })
      get().say(made.length === 1 ? "Made a virtual copy. It shares the photo's file and has settings of its own." : `Made ${made.length} virtual copies. They share the photos' files and have settings of their own.`)
    } catch (e) {
      get().say((e as Error).message, true)
    }
  },
  openCompare() {
    const s = get()
    const here = s.photoAt(s.active)
    if (!here || s.total < 2) {
      s.say('Compare needs at least two photos in the grid.')
      return
    }
    const next = s.active + 1 < s.total ? s.active + 1 : s.active - 1
    set({ view: 'compare', compareSelect: here.id })
    s.clickIndex(next, 'single')
  },
  compareMakeSelect() {
    const s = get()
    const cand = s.photoAt(s.active)
    if (!cand) return
    const next = s.active + 1 < s.total ? s.active + 1 : s.active - 1
    set({ compareSelect: cand.id })
    if (next >= 0) s.clickIndex(next, 'single')
  },
  compareSwap() {
    const s = get()
    const cand = s.photoAt(s.active)
    const was = s.compareSelect !== null ? s.indexOfId(s.compareSelect) : -1
    if (!cand || was < 0) return
    set({ compareSelect: cand.id })
    s.clickIndex(was, 'single')
  },
  indexOfId(id) {
    for (const [page, rows] of Object.entries(get().pages)) {
      const at = rows.findIndex((r) => r.id === id)
      if (at >= 0) return Number(page) * PAGE + at
    }
    return -1
  },
  perform(a) {
    const s = get()
    switch (a.type) {
      case 'rate':
        return void s.rate(a.value)
      case 'flag':
        return void s.flag(a.value)
      case 'label':
        return void s.label(a.value)
      case 'view':
        if (a.value === 'compare') return s.openCompare()
        return set({ view: a.value })
      case 'selectAll': {
        // Ask the core for every id in the current result, not just the pages loaded so far.
        const gen = s.gen
        void api()
          .photoIds(s.filters)
          .then((ids) => get().gen === gen && set({ selected: new Set(ids) }))
          .catch((e) => get().say((e as Error).message, true))
        return
      }
      case 'quick':
        return void s.quick()
      case 'target':
        return void s.addToTarget()
      case 'remove':
        return s.targetIds().length ? set({ removeOpen: true }) : undefined
      case 'develop':
        return s.active >= 0 ? set({ module: 'develop' }) : undefined
      case 'edge':
        return s.clickIndex(a.to === 'first' ? 0 : s.total - 1, 'single')
      case 'move': {
        const step = s.view === 'grid' ? a.dx + a.dy * s.cols : a.dx || a.dy
        const to = Math.min(Math.max((s.active < 0 ? 0 : s.active) + step, 0), s.total - 1)
        return s.clickIndex(to, 'single')
      }
    }
  },
}))

function findPhoto(id: number): Photo | undefined {
  for (const rows of Object.values(useStore.getState().pages)) {
    const p = rows.find((r) => r.id === id)
    if (p) return p
  }
}

// ---- undo and redo for ratings, flags and colour labels in the Library ------------------------------

interface LibraryStep {
  label: string
  undo(): Promise<void>
  redo(): Promise<void>
}
const libUndo: LibraryStep[] = []
const libRedo: LibraryStep[] = []

/** What Ctrl+Z would take back in the Library right now (for the menu), or null. */
export const libraryUndoLabel = () => libUndo.at(-1)?.label ?? null
export const libraryRedoLabel = () => libRedo.at(-1)?.label ?? null

/** Keep what a rating, flag or label change replaced, so it can be taken back (the last 100 changes, this session). */
function recordMarks(label: string, ids: number[], before: Record<number, unknown>, after: unknown, send: (ids: number[], v: unknown) => Promise<void>, key: 'rating' | 'flag' | 'label') {
  const groups = new Map<unknown, number[]>()
  for (const id of ids) {
    if (!(id in before)) continue
    groups.set(before[id], [...(groups.get(before[id]) ?? []), id])
  }
  if (groups.size === 0 || (groups.size === 1 && groups.has(after))) return // nothing changed
  const apply = async (assign: [number[], unknown][]) => {
    for (const [i, v] of assign) {
      patch(i, { [key]: v } as Partial<Photo>)
      await send(i, v)
    }
  }
  libUndo.push({ label, undo: () => apply([...groups].map(([v, i]) => [i, v])), redo: () => apply([[ids, after]]) })
  if (libUndo.length > 100) libUndo.shift()
  libRedo.length = 0
}

export async function libraryUndo() {
  const s = libUndo.pop()
  if (!s) return useStore.getState().say('Nothing to undo.')
  try {
    await s.undo()
    libRedo.push(s)
    useStore.getState().say(`Undid: ${s.label}`)
  } catch (e) {
    useStore.getState().say((e as Error).message, true)
    void useStore.getState().reload()
  }
}

export async function libraryRedo() {
  const s = libRedo.pop()
  if (!s) return useStore.getState().say('Nothing to redo.')
  try {
    await s.redo()
    libUndo.push(s)
    useStore.getState().say(`Redid: ${s.label}`)
  } catch (e) {
    useStore.getState().say((e as Error).message, true)
    void useStore.getState().reload()
  }
}

function patch(ids: number[], change: Partial<Photo>) {
  const set = new Set(ids)
  useStore.setState((s) => ({
    pages: Object.fromEntries(
      Object.entries(s.pages).map(([k, rows]) => [k, rows.map((r) => (set.has(r.id) ? { ...r, ...change } : r))]),
    ),
  }))
}

export async function refreshCollections() {
  try {
    const [collections, keywords] = await Promise.all([api().collectionList(), api().keywordList()])
    useStore.setState({ collections, keywords })
  } catch (e) {
    useStore.getState().say((e as Error).message, true)
  }
}

/** The cache-busting key for a photo's pictures: any import or edit that changes them changes the key. */
export const usePreviewKey = (id: number) => useStore((s) => `${s.previewVersion}.${s.photoVersion[id] ?? 0}`)
