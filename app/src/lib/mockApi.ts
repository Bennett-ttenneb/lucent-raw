import { folderProblem } from './exportSettings'
import type { AutoBackup, AutoBackupState, MetadataValues } from './types'
import type { Api, SmartRule, SmartRules, BookDoc, CollectionRow, PresetRow, SnapshotRow, ExportResult, Flag, FolderRow, HistoryRow, ImportItem, ImportResult, KeywordRow, Label, MetaPatch, Page, Photo, Query, Recipe } from './types'
import { DEFAULT_RECIPE } from './types'
import { layoutFace } from './portraitedit'

/**
 * In-memory stand-in for the Rust core, same signatures. Used in a plain browser (design review,
 * tests). Seeded with generated gradients, no real photos.
 */
type Listener = (p: never) => void

export interface MockOptions {
  /** Path the folder picker returns, to try error cases. */
  pick?: string
  longNames?: boolean
  /** Make rating, flag and label writes fail, to test rollback. */
  failWrites?: boolean
  /** Make the face detector find nothing. */
  noFaces?: boolean
  /** a newer version that the update check finds (none by default) */
  newerVersion?: string
  /** the donation button is shown (it is hidden by default so the other tests see the plain page) */
  donate?: boolean
  /** switching the AI connection on fails (the browser tests use ?mcpfail=1) */
  mcpFail?: boolean
  /** making a book PDF fails (the browser tests use ?bookfail=1) */
  bookFail?: boolean
  /** the catalog check finds a problem (the browser tests use ?corrupt=1) */
  corrupt?: boolean
  /** sidecars from another program are in the way, and one cannot be read (?xmpforeign=1) */
  xmpForeign?: boolean
  /** writing sidecars fails (?xmpfail=1) */
  xmpFail?: boolean
  /** some photos are missing (the browser tests use ?missing=1) */
  missing?: boolean
  /** the backup fails (the browser tests use ?backupfail=1) */
  backupFail?: boolean
  /** where the licence stands (the browser tests use ?licence=trial, expired or licensed) */
  licence?: 'licensed' | 'trial' | 'expired' | 'free'
  /** more catalogs on the list from the start (the browser tests use ?catalogs=2) */
  extraCatalogs?: { id: string; name: string; path: string }[]
  /** Make the export preview fail. */
  failPreview?: boolean
  /** What the image picker returns (a watermark logo). */
  pickImagePath?: string
  /** a memory card is plugged in */
  card?: boolean
  /** a memory card is plugged in after the program has started (the second time it is looked for) */
  cardLate?: boolean
  /** the display has a wide-gamut profile */
  wideDisplay?: boolean
}

/** The photos a demo card holds: twelve photos (two of them in a subfolder) and three RAW files, like importScan says. */
function demoList(source: string): ImportItem[] {
  return Array.from({ length: 15 }, (_, i) => {
    const n = String(i + 1).padStart(4, '0')
    const name = i >= 12 ? `RAW_${n}.CR2` : `IMG_${n}.jpg`
    const folder = i >= 10 && i < 12 ? 'Day 2' : ''
    return { path: `${source}/${folder ? folder + '/' : ''}${name}`, name, folder, size: 2_000_000 + i * 1000, raw: i >= 12 }
  })
}

export function createMockApi(seedCount = 96, opts: MockOptions = {}): Api {
  const listeners = new Map<string, Set<Listener>>()
  const emit = (e: string, p: unknown) => listeners.get(e)?.forEach((l) => (l as (x: unknown) => void)(p))
  ;(window as unknown as { __emit?: unknown }).__emit = emit // the browser tests send the events the core would
  const folders = ['2026-10-03', '2026-10-04', 'Studio']
  /** taking photos out of the demo catalog: a photo's virtual copies go with it */
  function removePhotos(ids: number[]): number {
    ids = [...ids, ...db.filter((p) => p.masterId !== null && ids.includes(p.masterId)).map((p) => p.id)]
    const gone = new Set(ids)
    let n = 0
    for (let i = db.length - 1; i >= 0; i--) if (gone.has(db[i].id)) (db.splice(i, 1), n++)
    cols.forEach((c) => ids.forEach((id) => c.members.delete(id)))
    ids.forEach((id) => (photoKw.delete(id), meta.delete(id)))
    return n
  }  /** the demo catalog's folders and photos follow a folder that was renamed or moved */
  const retarget = (from: string, to: string) => {
    if (from === to) return
    if (folders.includes(to)) throw new Error(`There is already something called "${to}" there.`)
    folders.forEach((f, i) => {
      if (f === from || f.startsWith(from + '/')) folders[i] = to + f.slice(from.length)
    })
    for (const p of db) {
      if (p.folder === from || p.folder.startsWith(from + '/')) {
        const folder = to + p.folder.slice(from.length)
        p.path = p.path.replace(`/${p.folder}/`, `/${folder}/`)
        p.folder = folder
      }
    }
  }
  let nextId = 1

  const makePhoto = (folder: string): Photo => {
    const id = nextId++
    const portrait = id % 3 === 0
    const day = 3 + (id % 2)
    return {
      id,
      name: opts.longNames ? `${'A very long descriptive file name '.repeat(3)}${1000 + id}.jpg` : `IMG_${String(1000 + id).padStart(4, '0')}.jpg`,
      path: `C:/Demo/${folder}/IMG_${1000 + id}.jpg`,
      folder,
      format: 'jpeg',
      rating: id % 7 === 0 ? 3 : 0,
      flag: 0,
      label: null,
      captured: `2026-10-0${day}T${String(8 + (id % 10)).padStart(2, '0')}:${String(id % 60).padStart(2, '0')}:00`,
      width: portrait ? 4000 : 6000,
      height: portrait ? 6000 : 4000,
      missing: !!opts.missing && id === 1, // with ?missing=1 the first photo's file is gone
      camera: id % 2 ? 'Canon EOS 800D' : 'Nikon Z6',
      lens: id % 2 ? 'EF50mm f/1.8 II' : 'NIKKOR Z 24-70mm f/4 S',
      iso: [100, 200, 400, 800, 1600][id % 5],
      aperture: [1.8, 2.8, 4, 5.6][id % 4],
      shutterS: 1 / [60, 125, 250, 500][id % 4],
      focalMm: [24, 35, 50, 70][id % 4],
      previewable: true,
      edited: false,
      copyName: null,
      masterId: null,
      stackId: null,
      stackPos: 0,
      stackCount: 0,
      stackCollapsed: false,
    }
  }
  const db: Photo[] = Array.from({ length: seedCount }, (_, i) => makePhoto(folders[i % folders.length]))

  // collections: id 1 is always the Quick Collection
  const cols: { id: number; name: string; kind: 'collection' | 'quick' | 'smart' | 'set'; isTarget: boolean; members: Set<number>; rules?: SmartRules; parentId?: number | null }[] = [
    { id: 1, name: 'Quick Collection', kind: 'quick', isTarget: false, members: new Set() },
  ]
  let nextCol = 2
  const kws: { id: number; name: string; parentId: number | null; synonyms?: string; includeOnExport?: boolean; isPrivate?: boolean }[] = []
  let nextKw = 1
  const photoKw = new Map<number, Set<number>>()
  const meta = new Map<number, MetaPatch>()
  const edits = new Map<number, { recipe: Recipe; history: HistoryRow[] }>()
  let nextStep = 1
  const presets: PresetRow[] = []
  let nextPreset = 1
  const snaps = new Map<number, SnapshotRow[]>()
  let nextSnap = 1
  const label = (s: string, what: string) => {
    const n = s.split(/\s+/).filter(Boolean).join(' ')
    if (!n || n.length > 100) throw new Error(`Give the ${what} a name of 1 to 100 characters.`)
    return n
  }
  const kwWithChildren = (id: number): Set<number> => {
    const out = new Set<number>([id])
    for (let grew = true; grew; ) {
      grew = false
      for (const k of kws) if (k.parentId !== null && out.has(k.parentId) && !out.has(k.id)) (out.add(k.id), (grew = true))
    }
    return out
  }
  // a smart collection holds whatever meets its rules (the mock knows most of the fields)
  const ruleHolds = (p: Photo, r: SmartRule): boolean => {
    const v = r.value.trim().toLowerCase()
    const cmp = (a: number | null, b: number) => (a === null ? false : r.op === '>=' ? a >= b : r.op === '<=' ? a <= b : Math.abs(a - b) < 0.5)
    const day = (p.captured ?? '').slice(0, 10)
    const m = meta.get(p.id)
    switch (r.field) {
      case 'rating':
        return cmp(p.rating, Number(v))
      case 'iso':
        return cmp(p.iso, Number(v))
      case 'focal':
        return cmp(p.focalMm, Number(v))
      case 'aperture':
        return cmp(p.aperture, Number(v))
      case 'flag':
        return v === 'pick' ? p.flag === 1 : v === 'reject' ? p.flag === -1 : p.flag === 0
      case 'label':
        return v === 'none' ? p.label === null : p.label === v
      case 'camera':
        return (p.camera ?? '').toLowerCase().includes(v)
      case 'lens':
        return (p.lens ?? '').toLowerCase().includes(v)
      case 'text':
        return [p.name, m?.title, m?.caption, m?.creator, m?.copyright].some((t) => (t ?? '').toLowerCase().includes(v))
      case 'format':
        return p.format.toLowerCase() === v
      case 'edited':
        return p.edited === (v === 'yes')
      case 'copy':
        return (p.masterId !== null) === (v === 'yes')
      case 'missing':
        return p.missing === (v === 'yes')
      case 'date':
        return r.op === 'after' ? day > v : r.op === 'before' ? day < v : r.op === 'on' ? day === v : day >= new Date(Date.now() - Number(v) * 86400000).toISOString().slice(0, 10)
      case 'keyword': {
        const have = [...(photoKw.get(p.id) ?? [])]
        return r.op === 'is' ? have.some((k) => [...kwWithChildren(k)].length >= 0 && kws.some((x) => x.name.toLowerCase() === v && kwWithChildren(x.id).has(k))) : have.some((k) => (kws.find((x) => x.id === k)?.name ?? '').toLowerCase().includes(v))
      }
      case 'collection':
        return cols.find((c) => c.id === Number(v))?.members.has(p.id) ?? false
      default:
        return false
    }
  }
  const ruleMet = (p: Photo, r: SmartRule): boolean => {
    const met = r.field === 'group' && r.group ? smartHolds(r.group, p) : ruleHolds(p, r)
    return r.negate ? !met : met
  }
  const smartHolds = (rules: SmartRules, p: Photo): boolean => (rules.mode === 'any' ? rules.rules.some((r) => ruleMet(p, r)) : rules.rules.every((r) => ruleMet(p, r)))
  const inCollection = (c: (typeof cols)[number] | undefined, p: Photo) => (c?.kind === 'smart' && c.rules ? smartHolds(c.rules, p) : c?.members.has(p.id) ?? false)
  const checkRules = (rules: SmartRules) => {
    if (rules.rules.length === 0) throw new Error('Add at least one rule.')
    rules.rules.forEach((r, i) => {
      if (r.field === 'group') return checkRules(r.group ?? { mode: 'all', rules: [] })
      if (r.field === 'rating' && !(Number(r.value) >= 0 && Number(r.value) <= 5)) throw new Error(`Rule ${i + 1}: The value for rating must be a number from 0 to 5.`)
      if (['keyword', 'camera', 'lens', 'text'].includes(r.field) && !r.value.trim()) throw new Error(`Rule ${i + 1}: The value for ${r.field} must be some text.`)
    })
  }
  const colById = (id: number) => {
    const c = cols.find((x) => x.id === id)
    if (!c) throw new Error('That collection no longer exists.')
    return c
  }

  const svg = (id: number, w: number, h: number) => {
    const hue = (id * 47) % 360
    const s = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,35%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},55%,65%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/></svg>`
    return 'data:image/svg+xml;utf8,' + encodeURIComponent(s)
  }

  /** stacks: id -> closed */
  const stackClosed = new Map<number, boolean>()
  let nextStack = 1
  const tidyStacks = () => {
    for (const id of [...stackClosed.keys()]) {
      const members = db.filter((p) => p.stackId === id).sort((a, b) => a.stackPos - b.stackPos)
      if (members.length < 2) (members.forEach((m) => ((m.stackId = null), (m.stackPos = 0))), stackClosed.delete(id))
      else members.forEach((m, i) => (m.stackPos = i))
    }
  }
  const sortVal = (p: Photo, k: Query['sort']) => (k === 'name' ? p.name.toLowerCase() : k === 'rating' ? p.rating : p.captured ?? '')

  const run = (q: Query): Page => {
    let rows = db.filter((p) => {
      if (q.minRating !== undefined && p.rating < q.minRating) return false
      if (q.flag === 'pick' && p.flag !== 1) return false
      if (q.flag === 'reject' && p.flag !== -1) return false
      if (q.flag === 'unflagged' && p.flag !== 0) return false
      if (q.label && p.label !== q.label) return false
      if (q.edited && p.edited !== (q.edited === 'yes')) return false
      if (q.copies && (p.masterId !== null) !== (q.copies === 'only')) return false
      if (q.stacks !== 'all' && p.stackId !== null && p.stackPos > 0 && stackClosed.get(p.stackId)) return false
      if (q.text && !`${p.name} ${p.camera} ${p.lens}`.toLowerCase().includes(q.text.toLowerCase())) return false
      if (q.camera && p.camera !== q.camera) return false
      if (q.lens && p.lens !== q.lens) return false
      const within = (v: number | null, lo?: number, hi?: number) => (lo === undefined && hi === undefined) || (v !== null && (lo === undefined || v >= lo - 0.0005) && (hi === undefined || v <= hi + 0.0005))
      if (!within(p.iso, q.minIso, q.maxIso) || !within(p.focalMm, q.minFocal, q.maxFocal) || !within(p.aperture, q.minAperture, q.maxAperture)) return false
      const day = (p.captured ?? '').slice(0, 10)
      if (/^\d{4}-\d{2}-\d{2}$/.test(q.dateFrom ?? '') && day < q.dateFrom!) return false
      if (/^\d{4}-\d{2}-\d{2}$/.test(q.dateTo ?? '') && day > q.dateTo!) return false
      if (q.folderId !== undefined && folders[q.folderId - 1] !== p.folder) return false
      if (q.collectionId !== undefined && !inCollection(cols.find((c) => c.id === q.collectionId), p)) return false
      if (q.keywordId !== undefined) {
        const want = kwWithChildren(q.keywordId)
        const have = photoKw.get(p.id)
        if (!have || ![...have].some((k) => want.has(k))) return false
      }
      return true
    })
    rows = [...rows].sort((a, b) => {
      const x = sortVal(a, q.sort)
      const y = sortVal(b, q.sort)
      const c = x < y ? -1 : x > y ? 1 : a.id - b.id
      return q.desc ? -c : c
    })
    return { total: rows.length, rows: rows.slice(q.offset, q.offset + q.limit).map((r) => ({ ...r, stackCount: r.stackId === null ? 0 : db.filter((o) => o.stackId === r.stackId).length, stackCollapsed: r.stackId !== null && !!stackClosed.get(r.stackId) })) }
  }

  const tick = (ms: number) => new Promise((r) => setTimeout(r, ms))
  let perfThreads = 0
  let cardCalls = 0
  /** folders the demo has already been synchronised */
  const syncNew = new Set<string>()
  const syncGone = new Set<string>()
  const opened: { path: string; editor: string | null }[] = []
  ;(window as unknown as { __opened?: unknown }).__opened = opened

  // ---- photos whose files are not there (the browser tests use ?missing=1)
  let lost: { rootId: number; path: string; folderThere: boolean; missing: number; total: number }[] = opts.missing
    ? [
        { rootId: 1, path: 'E:/Photos 2024', folderThere: false, missing: 120, total: 120 },
        { rootId: 2, path: 'C:/Photos/Trips', folderThere: true, missing: 2, total: 40 },
      ]
    : []
  const smartIds = new Set<number>()
  let watching: { folder: string; mode: string; destination: string | null } | null = null
  const missingReport = () => ({ checked: 298, missing: lost.reduce((n, g) => n + g.missing, 0), groups: lost.map((g) => ({ ...g })) })

  // ---- the previews kept on disk
  const cache = { withoutPreview: 0, cleared: false }
  const cacheInfo = () => ({
    files: cache.cleared ? 0 : 596,
    bytes: cache.cleared ? 0 : 1_930_000_000,
    baseBytes: cache.cleared ? 0 : 1_700_000_000,
    editedBytes: cache.cleared ? 0 : 230_000_000,
    photos: 298,
    withoutPreview: cache.withoutPreview,
    editedWithout: 0,
  })

  // ---- sidecar files
  const xmp = { auto: false, changed: 12, readDiffer: 3 }

  // ---- looking after the catalog
  let lastBackup: string | null = null
  const backups: string[] = []
  let licenceState: 'licensed' | 'trial' | 'expired' | 'free' = opts.licence ?? 'licensed'
  const licenceNow = (): import('./types').LicenceStatus => ({ state: licenceState, daysLeft: licenceState === 'trial' ? 12 : 0, trialDays: 30, name: licenceState === 'licensed' ? 'Ada Example' : null, problem: null })
  const auto = { settings: { on: true, everyDays: 1, keep: 7 }, list: [] as AutoBackup[] }
  const autoState = (): AutoBackupState => ({ settings: { ...auto.settings }, backups: [...auto.list], folder: 'C:/Lucent Raw/catalog/backups' })
  ;(window as unknown as { __restored?: string[] }).__restored = []
  ;(window as unknown as { __backups?: unknown }).__backups = backups

  // ---- books: kept in memory
  const books = new Map<number, BookDoc>()
  let nextBook = 1
  const exportedBooks: { id: number; destination: string }[] = []
  ;(window as unknown as { __books?: unknown }).__books = exportedBooks

  // ---- the AI connection: only its settings are pretended
  const mcp = { enabled: false, token: 'a'.repeat(64), version: 1 }
  const mcpStatus = () => ({
    enabled: mcp.enabled,
    running: mcp.enabled,
    port: 47321,
    url: 'http://127.0.0.1:47321/mcp',
    token: mcp.token,
    command: `claude mcp add --transport http lucent-raw http://127.0.0.1:47321/mcp --header "Authorization: Bearer ${mcp.token}"`,
    error: null as string | null,
  })

  // ---- catalogs: the photos, collections, keywords and edits belong to the open one; the others are kept aside
  const cats: { id: string; name: string; path: string }[] = [
    { id: 'main', name: 'Main catalog', path: 'memory://demo' },
    ...(opts.extraCatalogs ?? []),
  ]
  let currentCat = 'main'
  let nextCat = 1
  type Contents = { db: Photo[]; cols: typeof cols; kws: typeof kws; photoKw: Map<number, Set<number>>; meta: Map<number, MetaPatch>; edits: typeof edits; presets: PresetRow[]; snaps: Map<number, SnapshotRow[]> }
  const saved = new Map<string, Contents>()
  const takeContents = (): Contents => ({ db: [...db], cols: cols.map((c) => ({ ...c, members: new Set(c.members) })), kws: [...kws], photoKw: new Map(photoKw), meta: new Map(meta), edits: new Map(edits), presets: [...presets], snaps: new Map(snaps) })
  const putContents = (c: Contents) => {
    db.splice(0, db.length, ...c.db)
    cols.splice(0, cols.length, ...c.cols)
    kws.splice(0, kws.length, ...c.kws)
    presets.splice(0, presets.length, ...c.presets)
    for (const [m, from] of [[photoKw, c.photoKw], [meta, c.meta], [edits, c.edits], [snaps, c.snaps]] as const) {
      ;(m as Map<unknown, unknown>).clear()
      from.forEach((v, k) => (m as Map<unknown, unknown>).set(k, v))
    }
  }
  const emptyContents = (): Contents => ({ db: [], cols: [{ id: 1, name: 'Quick Collection', kind: 'quick', isTarget: false, members: new Set() }], kws: [], photoKw: new Map(), meta: new Map(), edits: new Map(), presets: [], snaps: new Map() })
  const switchTo = (id: string) => {
    if (id === currentCat) return
    saved.set(currentCat, takeContents())
    putContents(saved.get(id) ?? emptyContents())
    saved.delete(id)
    currentCat = id
  }
  const catalogName = (raw: string) => {
    const n = raw.split(/\s+/).filter(Boolean).join(' ')
    if (!n) throw new Error('Give the catalog a name.')
    if (n.length > 60) throw new Error('The catalog name is too long (60 letters at most).')
    return n
  }
  const catalogList = () => ({
    current: currentCat,
    items: cats.map((c) => ({ id: c.id, name: c.name, path: c.path, photos: c.id === currentCat ? db.length : /gone/i.test(c.path) ? null : (saved.get(c.id)?.db.length ?? 0), exists: !/gone/i.test(c.path), current: c.id === currentCat })),
  })
  const apply = (ids: number[], fn: (p: Photo) => void) => db.filter((p) => ids.includes(p.id)).forEach(fn)

  return {
    isMock: true,
    catalogInfo: async () => ({ path: cats.find((c) => c.id === currentCat)?.path ?? 'memory://demo', count: db.length, name: cats.find((c) => c.id === currentCat)?.name ?? 'Catalog' }),
    bookList: async () => [...books.entries()].map(([id, b]) => ({ id, name: b.name, pages: b.pages.length, updated: id })).reverse(),
    bookCreate: async (name) => {
      const id = nextBook++
      books.set(id, { name: name?.trim() || 'Untitled book', widthMm: 203.2, heightMm: 203.2, pageNumbers: false, pages: [{ background: '#FFFFFF', frames: [] }] })
      return id
    },
    bookGet: async (id) => {
      const b = books.get(id)
      if (!b) throw new Error('That book is not in this catalog.')
      return structuredClone(b)
    },
    bookSave: async (id, book) => {
      if (!books.has(id)) throw new Error('That book is not in this catalog.')
      const b = structuredClone(book)
      b.name = b.name.trim() || 'Untitled book'
      books.set(id, b)
      return structuredClone(b)
    },
    bookDelete: async (id) => void books.delete(id),
    bookExportPdf: async (id, destination) => {
      if (opts.bookFail) throw new Error('The PDF could not be saved: the disk is full.')
      const b = books.get(id)
      if (!b) throw new Error('That book is not in this catalog.')
      exportedBooks.push({ id, destination })
      return { file: destination + '/' + b.name + '.pdf', pages: b.pages.length, warnings: b.pages.some((p) => p.frames.some((f) => f.kind === 'photo' && f.photoId === 0)) ? ['Page 1: a photo could not be used'] : [] }
    },
    catalogCheck: async () => ({
      ok: !opts.corrupt,
      problems: opts.corrupt ? ['a row in "develop_settings" (number 3) belongs to something in "photo" that is not there'] : [],
      photos: 298,
      books: books.size,
      sizeBytes: 4_300_000,
    }),
    catalogBackup: async (destination) => {
      if (opts.backupFail) throw new Error('The backup could not be written: disk I/O error')
      lastBackup = '2026-10-18 15:30'
      backups.push(destination)
      return { folder: destination + '/Main catalog backup 2026-10-18 153000', bytes: 4_300_000, when: lastBackup }
    },
    catalogLastBackup: async () => lastBackup,
    licenceStatus: async () => licenceNow(),
    appVersion: async () => '0.1.0-beta1',
    updateCheck: async () => (opts.newerVersion ? { current: '0.1.0-beta1', latest: opts.newerVersion, url: `https://github.com/Bennett-ttenneb/lucent-raw/releases/tag/v${opts.newerVersion}` } : { current: '0.1.0-beta1', latest: null, url: null }),
    updateOpen: async () => undefined,
    donateUrl: async () => (opts.donate ? 'https://www.paypal.com/donate/?business=example' : null),
    donateOpen: async () => undefined,
    perfGet: async () => ({ threads: perfThreads, cores: 8, automatic: 8 }),
    perfSet: async (threads) => {
      perfThreads = Math.max(0, Math.min(32, Math.round(threads)))
      ;(window as unknown as { __perf?: number }).__perf = perfThreads
      return { threads: perfThreads, cores: 8, automatic: 8 }
    },
    openInEditor: async (path, editor) => {
      if (editor && editor.endsWith('missing.exe')) throw new Error(`The editing program is not there: ${editor}. Choose it again in Preferences.`)
      opened.push({ path, editor })
    },
    catalogOptimize: async () => {
      if (opts.backupFail) throw new Error('The catalog could not be compacted: disk I/O error')
      return { before: 52_428_800, after: 41_943_040 }
    },
    volumeSpace: async (path) => (path.startsWith('C:/Demo') ? { free: 120_000_000_000, total: 500_000_000_000 } : null),
    licenceEnter: async (key) => {
      if (!/^LRAW1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(key.trim())) throw new Error('That is not a Lucent Raw licence key. Check that all of it was copied, with nothing added.')
      if (key.trim().endsWith('.bad')) throw new Error('That key was not made by Lucent Raw, or it has been changed.')
      licenceState = 'licensed'
      return licenceNow()
    },
    backupAutoState: async () => autoState(),
    backupAutoSettingsSet: async (on, everyDays, keep) => {
      auto.settings = { on, everyDays: Math.min(90, Math.max(1, everyDays)), keep: Math.min(30, Math.max(1, keep)) }
      let seen = 0
      auto.list = auto.list.filter((x) => x.kind !== 'auto' || ++seen <= auto.settings.keep)
      return autoState()
    },
    backupAutoNow: async () => {
      const n = auto.list.length + 1
      auto.list.unshift({ file: 'C:/Lucent Raw/catalog/backups/auto-' + n + '.db', kind: 'auto', when: '2026-10-19 1' + (n % 10) + ':00', bytes: 4_300_000, photos: 96 })
      return autoState()
    },
    backupRestore: async (file) => {
      ;(window as unknown as { __restored: string[] }).__restored.push(file)
      auto.list.unshift({ file: 'C:/Lucent Raw/catalog/backups/before-restore-' + auto.list.length + '.db', kind: 'before-restore', when: '2026-10-19 12:00', bytes: 4_300_000, photos: 96 })
      return autoState()
    },
    cacheInfo: async () => cacheInfo(),
    cacheRebuild: async () => {
      const n = cache.withoutPreview
      cache.withoutPreview = 0
      cache.cleared = false
      return n
    },
    cacheClear: async () => {
      cache.withoutPreview = 298
      cache.cleared = true
      return cacheInfo()
    },
    xmpStatus: async () => ({ auto: xmp.auto, changed: xmp.changed, lastError: opts.xmpFail && xmp.auto ? 'Access is denied.' : null }),
    xmpSetAuto: async (on) => {
      xmp.auto = on
      return { auto: xmp.auto, changed: xmp.changed, lastError: null }
    },
    xmpWriteNow: async (scope, ids) => {
      const n = scope === 'changed' ? xmp.changed : scope === 'selected' ? ids.length : 298
      if (opts.xmpFail) return { written: 0, unchanged: 0, leftAlone: [], missing: 0, failed: ['IMG_0002.jpg: Access is denied. (os error 5)'] }
      if (scope === 'changed') xmp.changed = 0
      const left = opts.xmpForeign ? ['IMG_0001.xmp', 'IMG_0007.xmp'] : []
      return { written: n - left.length, unchanged: scope === 'all' ? 3 : 0, leftAlone: left, missing: 0, failed: [] }
    },
    xmpReadNow: async (scope, ids, apply) => {
      const found = scope === 'selected' ? Math.min(ids.length, 2) : 40
      const differ = xmp.readDiffer
      if (apply) xmp.readDiffer = 0
      return { found, differ, applied: apply ? differ : 0, kinds: (differ ? { rating: 2, keywords: 1 } : {}) as Record<string, number>, unreadable: opts.xmpForeign ? ['IMG_0009.jpg.xmp: it is not readable as XMP (syntax error)'] : [] }
    },
    missingScan: async () => missingReport(),
    pickPhotoFile: async () => opts.pick ?? 'C:/Demo/found/IMG_0001.jpg',
    cacheTrim: async (maxBytes, maxAgeDays) => {
      ;(globalThis as { __trims?: unknown[] }).__trims = [...((globalThis as { __trims?: unknown[] }).__trims ?? []), { maxBytes, maxAgeDays }]
      return { removed: maxBytes > 0 || maxAgeDays > 0 ? 12 : 0, freed: maxBytes > 0 || maxAgeDays > 0 ? 3_000_000 : 0 }
    },
    photoAiDenoise: async (id, amount, iso) => {
      const first = db.find((p) => p.id === id)
      if (!first) throw new Error('That photo is no longer in the catalog.')
      ;(globalThis as { __denoise?: unknown[] }).__denoise = [...((globalThis as { __denoise?: unknown[] }).__denoise ?? []), { id, amount, iso }]
      for (let i = 0; i <= 4; i++) emit('merge:progress', { done: i, total: 4 })
      const p = makePhoto(first.folder)
      p.name = first.name.replace(/\.jpg$/i, '') + '-Denoise.jpg'
      p.path = p.path.replace(/\.jpg$/i, '-Denoise.jpg')
      p.captured = first.captured
      db.push(p)
      return { id: p.id, path: p.path, shots: 1 }
    },
    photoMergeFocus: async (ids, align) => {
      if (ids.length < 2) throw new Error('Choose two or more photos of the same subject taken at different focus distances.')
      if (ids.length > 40) throw new Error('Stack up to 40 photos at a time.')
      ;(globalThis as { __stacks?: unknown[] }).__stacks = [...((globalThis as { __stacks?: unknown[] }).__stacks ?? []), { ids, align }]
      const first = db.find((p) => p.id === ids[0])!
      const p = makePhoto(first.folder)
      p.name = first.name.replace(/\.jpg$/i, '') + '-Stack.jpg'
      p.path = p.path.replace(/\.jpg$/i, '-Stack.jpg')
      p.captured = first.captured
      db.push(p)
      return { id: p.id, path: p.path, shots: ids.length }
    },
    photoEditCopy: async (id) => {
      const first = db.find((p) => p.id === id)
      if (!first) throw new Error('That photo is no longer in the catalog.')
      const p = makePhoto(first.folder)
      p.name = first.name.replace(/\.jpg$/i, '') + '-Edit.tif'
      p.path = p.path.replace(/\.jpg$/i, '-Edit.tif')
      p.captured = first.captured
      db.push(p)
      return { id: p.id, path: p.path, shots: 1 }
    },
    photoMergePano: async (ids) => {
      if (ids.length < 2) throw new Error('Choose two or more photos taken in turn, each overlapping the next, to make a panorama.')
      if (ids.length > 12) throw new Error('Merge up to 12 photos at a time.')
      ;(globalThis as { __panos?: unknown[] }).__panos = [...((globalThis as { __panos?: unknown[] }).__panos ?? []), { ids }]
      const first = db.find((p) => p.id === ids[0])!
      const p = makePhoto(first.folder)
      p.name = first.name.replace(/\.jpg$/i, '') + '-Pano.jpg'
      p.path = p.path.replace(/\.jpg$/i, '-Pano.jpg')
      p.captured = first.captured
      db.push(p)
      return { id: p.id, path: p.path, shots: ids.length }
    },
    photoMergeHdr: async (ids, align) => {
      if (ids.length < 2) throw new Error('Choose two or more photos of the same scene to merge.')
      if (ids.length > 9) throw new Error('Merge up to 9 photos at a time.')
      ;(globalThis as { __merges?: unknown[] }).__merges = [...((globalThis as { __merges?: unknown[] }).__merges ?? []), { ids, align }]
      for (let i = 0; i <= ids.length + 1; i++) emit('merge:progress', { done: i, total: ids.length + 1 })
      const first = db.find((p) => p.id === ids[0])!
      const p = makePhoto(first.folder)
      p.name = first.name.replace(/\.jpg$/i, '') + '-HDR.jpg'
      p.path = p.path.replace(/\.jpg$/i, '-HDR.jpg')
      p.captured = first.captured
      db.push(p)
      return { id: p.id, path: p.path, shots: ids.length }
    },
    secondOpen: async () => {
      const g = globalThis as { __second?: unknown[] }
      g.__second = [...(g.__second ?? []), 'open']
      return true
    },
    secondClose: async () => {
      const g = globalThis as { __second?: unknown[] }
      g.__second = [...(g.__second ?? []), 'close']
    },
    secondShow: async (show) => {
      const g = globalThis as { __second?: unknown[] }
      g.__second = [...(g.__second ?? []), show]
    },
    watchSet: async (config) => {
      if (config && config.mode !== 'add' && !config.destination) throw new Error('Choose the folder the photos are to be filed in.')
      ;(globalThis as { __watch?: unknown[] }).__watch = [...((globalThis as { __watch?: unknown[] }).__watch ?? []), config]
      watching = config
      return { active: !!config, imported: 0, error: null }
    },
    watchStatus: async () => ({ active: !!watching, imported: watching ? 5 : 0, error: null }),
    catalogExportPhotos: async (ids, destination, name, withPreviews) => {
      if (!ids.length) throw new Error('Select the photos to export first.')
      ;(globalThis as { __exports?: unknown[] }).__exports = [...((globalThis as { __exports?: unknown[] }).__exports ?? []), { ids, destination, name, withPreviews }]
      return { photos: ids.length, skipped: 0, previews: withPreviews ? ids.length : 0, folder: destination + '/' + name }
    },
    catalogImportFrom: async (path, withPreviews) => {
      if (path.includes('notacatalog')) throw new Error('That folder does not hold a catalog (there is no catalog.db in it).')
      ;(globalThis as { __imports?: unknown[] }).__imports = [...((globalThis as { __imports?: unknown[] }).__imports ?? []), { path, withPreviews }]
      return { photos: 12, skipped: 3, previews: withPreviews ? 12 : 0, folder: path }
    },
    stackGroup: async (ids) => {
      if (ids.length < 2) throw new Error('Pick two or more photos to put into a stack.')
      const order = [...ids]
      for (const id of ids) {
        const sid = db.find((p) => p.id === id)?.stackId ?? null
        if (sid !== null) db.filter((p) => p.stackId === sid).sort((a, b) => a.stackPos - b.stackPos).forEach((p) => !order.includes(p.id) && order.push(p.id))
      }
      const stack = nextStack++
      order.forEach((id, i) => {
        const p = db.find((x) => x.id === id)
        if (p) (p.stackId = stack, p.stackPos = i)
      })
      stackClosed.set(stack, true)
      tidyStacks()
      return stack
    },
    stackAuto: async (ids, gapSeconds) => {
      const dated = db.filter((p) => ids.includes(p.id) && p.masterId === null && p.stackId === null && p.captured).sort((a, b) => (a.captured! < b.captured! ? -1 : 1))
      const secs = (p: Photo) => Date.parse(p.captured! + 'Z') / 1000
      let stacks = 0
      let photos = 0
      let run: Photo[] = []
      const flush = () => {
        if (run.length >= 2) {
          const stack = nextStack++
          run.forEach((p, i) => ((p.stackId = stack), (p.stackPos = i)))
          stackClosed.set(stack, true)
          stacks++
          photos += run.length
        }
        run = []
      }
      for (const p of dated) {
        if (run.length && secs(p) - secs(run[run.length - 1]) > gapSeconds) flush()
        run.push(p)
      }
      flush()
      return [stacks, photos]
    },
    // the demo has no pictures to compare: it calls every seventh photo a look-alike of the others
    stackSimilar: async (ids) => {
      const alike = db.filter((p) => ids.includes(p.id) && p.masterId === null && p.stackId === null && p.id % 7 === 0)
      if (alike.length < 2) return [0, 0]
      const stack = nextStack++
      alike.forEach((p, i) => ((p.stackId = stack), (p.stackPos = i)))
      stackClosed.set(stack, true)
      return [1, alike.length]
    },
    stackUngroup: async (ids) => {
      const stacks = new Set(db.filter((p) => ids.includes(p.id) && p.stackId !== null).map((p) => p.stackId as number))
      db.forEach((p) => p.stackId !== null && stacks.has(p.stackId) && ((p.stackId = null), (p.stackPos = 0)))
      stacks.forEach((s) => stackClosed.delete(s))
      return stacks.size
    },
    stackRemove: async (ids) => {
      const had = db.filter((p) => ids.includes(p.id) && p.stackId !== null)
      had.forEach((p) => ((p.stackId = null), (p.stackPos = 0)))
      tidyStacks()
      return had.length
    },
    stackCollapse: async (stackId, collapsed) => {
      if (stackId === null) [...stackClosed.keys()].forEach((k) => stackClosed.set(k, collapsed))
      else stackClosed.set(stackId, collapsed)
    },
    stackMakeTop: async (id) => {
      const p = db.find((x) => x.id === id)
      if (!p || p.stackId === null) throw new Error('That photo is not in a stack.')
      db.filter((o) => o.stackId === p.stackId && o.stackPos < p.stackPos).forEach((o) => o.stackPos++)
      p.stackPos = 0
    },
    smartInfo: async (ids) => {
      const scope = ids.length ? ids : db.map((p) => p.id)
      const built = scope.filter((id) => smartIds.has(id)).length
      return { built, total: scope.length, bytes: built * 1_500_000 }
    },
    smartBuild: async (ids) => {
      const scope = (ids.length ? db.filter((p) => ids.includes(p.id)) : db)
      let made = 0
      let skipped = 0
      for (const p of scope) {
        if (smartIds.has(p.id) || p.missing) skipped++
        else (smartIds.add(p.id), made++)
      }
      return { made, skipped, failed: [] }
    },
    catalogDetails: async () => ({ photos: db.filter((p) => p.masterId === null).length, virtualCopies: db.filter((p) => p.masterId !== null).length, folders: folders.length, collections: cols.filter((c) => c.kind !== 'quick').length, keywords: kws.length, edited: edits.size, catalogBytes: 52_428_800, previewsBytes: 230_000_000, created: null, schemaVersion: '1' }),
    displayProfile: async () => (opts.wideDisplay ? { name: 'DELL U2723QE (wide gamut)', path: 'C:/Windows/System32/spool/drivers/color/DELL.icm', isSrgb: false } : { name: 'sRGB IEC61966-2.1', path: 'C:/Windows/System32/spool/drivers/color/sRGB Color Space Profile.icm', isSrgb: true }),
    folderSyncPreview: async (folderId) => {
      const name = folders[folderId - 1]
      if (name === undefined) throw new Error('That folder is not in the catalog.')
      const here = db.filter((p) => p.folder === name)
      return { newFiles: syncNew.has(name) ? [] : [`C:/Demo/${name}/NEW_0001.jpg`, `C:/Demo/${name}/NEW_0002.jpg`], gone: syncGone.has(name) ? [] : here.slice(0, 1).map((p) => ({ id: p.id, name: p.name })), present: here.length }
    },
    folderSyncRun: async (folderId, importNew, removeGone) => {
      const name = folders[folderId - 1]
      if (name === undefined) throw new Error('That folder is not in the catalog.')
      const out = { imported: 0, duplicates: 0, failed: [] as string[], markedMissing: 0, removed: 0 }
      if (importNew && !syncNew.has(name)) {
        for (let i = 1; i <= 2; i++) {
          const p = makePhoto(name)
          p.name = `NEW_000${i}.jpg`
          db.push(p)
        }
        syncNew.add(name)
        out.imported = 2
      }
      const gone = db.filter((p) => p.folder === name && !syncGone.has(name)).slice(0, 1)
      if (gone.length) {
        if (removeGone) out.removed = removePhotos(gone.map((p) => p.id))
        else (gone.forEach((p) => (p.missing = true)), (out.markedMissing = gone.length))
        syncGone.add(name)
      }
      return out
    },
    importCards: async () => (opts.card || (opts.cardLate && ++cardCalls > 1) ? [{ path: 'E:/DCIM', label: 'E:', removable: true, hasDcim: true }] : []),
    openFolder: async (path) => {
      ;(globalThis as { __folders?: string[] }).__folders = [...((globalThis as { __folders?: string[] }).__folders ?? []), path]
    },
    photoRenameCopy: async (id, name) => {
      const p = db.find((x) => x.id === id)
      if (!p || p.masterId === null) throw new Error('Only a virtual copy can be named. Make a virtual copy first.')
      const n = name.split(/\s+/).filter(Boolean).join(' ')
      if (!n || n.length > 40) throw new Error('Give the copy a name of 1 to 40 characters.')
      if (db.some((x) => x.masterId === p.masterId && x.id !== id && x.copyName?.toLowerCase() === n.toLowerCase())) throw new Error('Another copy of this photo already has that name.')
      p.copyName = n
    },
    photoRelink: async (id, file) => {
      const p = db.find((x) => x.id === id)
      if (!p) throw new Error('That photo is not in the catalog.')
      if (!/\.(jpe?g|png|tiff?|webp|cr2|nef|dng|arw)$/i.test(file)) throw new Error('That is not a photo file this program can open.')
      p.missing = false
      p.path = file
      p.name = file.slice(file.lastIndexOf('/') + 1)
      ;(globalThis as { __relinked?: unknown[] }).__relinked = [...((globalThis as { __relinked?: unknown[] }).__relinked ?? []), { id, file }]
    },
    relinkPreview: async (rootId, newFolder) => {
      const g = lost.find((x) => x.rootId === rootId)
      if (!g) throw new Error('That folder is not in the catalog.')
      return { found: newFolder.toLowerCase().includes('empty') ? 0 : g.total, total: g.total }
    },
    relinkRoot: async (rootId, newFolder) => {
      const g = lost.find((x) => x.rootId === rootId)
      if (!g) throw new Error('That folder is not in the catalog.')
      if (newFolder.toLowerCase().includes('empty')) throw new Error("None of this folder's photos are in the folder you chose, so nothing was changed.")
      lost = lost.filter((x) => x.rootId !== rootId)
      return missingReport()
    },
    relinkSearch: async () => {
      const before = lost.reduce((n, g) => n + g.missing, 0)
      // the single files that were moved are found; a whole folder that is gone is not in this folder
      const found = lost.filter((g) => g.folderThere).reduce((n, g) => n + g.missing, 0)
      lost = lost.filter((g) => !g.folderThere)
      return { outcome: { relinked: found, stillMissing: before - found, byContent: 0, ambiguous: 0, conflicts: 0 }, report: missingReport() }
    },
    mcpStatus: async () => mcpStatus(),
    mcpSetEnabled: async (enabled) => {
      if (enabled && opts.mcpFail) return { ...mcpStatus(), enabled: false, running: false, error: 'Port 47321 could not be used: the address is already in use.' }
      mcp.enabled = enabled
      return mcpStatus()
    },
    mcpNewToken: async () => {
      mcp.token = 'f'.repeat(32) + mcp.version.toString(16).padStart(32, '0')
      mcp.version += 1
      return mcpStatus()
    },
    catalogList: async () => catalogList(),
    catalogCreate: async (name, location) => {
      const n = catalogName(name)
      let path = `${location?.trim() || 'memory://catalogs'}/${n}`
      for (let i = 2; cats.some((c) => c.path === path); i++) path = `${location?.trim() || 'memory://catalogs'}/${n} ${i}`
      const c = { id: `cat${nextCat++}`, name: n, path }
      cats.push(c)
      switchTo(c.id)
      return catalogList()
    },
    catalogOpen: async (path) => {
      if (/nocatalog/i.test(path)) throw new Error('That folder does not hold a catalog. A catalog folder has a file called catalog.db in it.')
      const existing = cats.find((c) => c.path === path)
      if (existing) {
        switchTo(existing.id)
        return catalogList()
      }
      const c = { id: `cat${nextCat++}`, name: path.split(/[\\/]/).filter(Boolean).pop() ?? 'Catalog', path }
      cats.push(c)
      switchTo(c.id)
      return catalogList()
    },
    catalogSwitch: async (id) => {
      const c = cats.find((x) => x.id === id)
      if (!c) throw new Error('That catalog is not on the list.')
      if (/gone/i.test(c.path)) throw new Error(`The folder of "${c.name}" is not there any more. It may have been moved, or its drive is not connected.`)
      switchTo(id)
      return catalogList()
    },
    catalogRename: async (id, name) => {
      const c = cats.find((x) => x.id === id)
      if (!c) throw new Error('That catalog is not on the list.')
      c.name = catalogName(name)
      return catalogList()
    },
    catalogRemove: async (id) => {
      if (id === currentCat) throw new Error('Switch to another catalog first: the one that is open cannot be taken off the list.')
      const i = cats.findIndex((x) => x.id === id)
      if (i < 0) throw new Error('That catalog is not on the list.')
      cats.splice(i, 1)
      saved.delete(id)
      return catalogList()
    },
    pickFolder: async (title) => opts.pick ?? (title.toLowerCase().includes('destination') ? 'C:/Demo/Library' : 'C:/Demo/Card'),
    importScan: async (source) => {
      if (source.includes('Missing')) throw new Error('That folder does not exist.')
      return { images: 12, raw: 3 }
    },
    metadataValues: async (): Promise<MetadataValues> => {
      const counted = (pick: (p: Photo) => string | null) => {
        const m = new Map<string, number>()
        for (const p of db) {
          const k = pick(p)
          if (k) m.set(k, (m.get(k) ?? 0) + 1)
        }
        return [...m].map(([name, count]) => ({ name, count })).sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
      }
      const span = (pick: (p: Photo) => number | null): [number, number] | null => {
        const v = db.map(pick).filter((x): x is number => x !== null)
        return v.length ? [Math.min(...v), Math.max(...v)] : null
      }
      const days = db.map((p) => (p.captured ?? '').slice(0, 10)).filter(Boolean).sort()
      return { cameras: counted((p) => p.camera), lenses: counted((p) => p.lens), iso: span((p) => p.iso), focal: span((p) => p.focalMm), aperture: span((p) => p.aperture), days: days.length ? [days[0], days[days.length - 1]] : null }
    },
    importList: async (source, subfolders = true): Promise<ImportItem[]> => {
      if (source.includes('Missing')) throw new Error('That folder does not exist.')
      return demoList(source).filter((i) => subfolders || i.folder === '')
    },
    portraitDetect: async () => ({
      // three faces in a row, unless the test switched detection off
      faces: opts.noFaces ? [] : [layoutFace([0.28, 0.45], 1.5, 0.06), layoutFace([0.5, 0.4], 1.5, 0.06), layoutFace([0.74, 0.46], 1.5, 0.06)],
      aspect: 1.5,
    }),
    exportPreview: async (id, settings) => {
      if (opts.failPreview) throw new Error('This photo has no preview yet.')
      // a stand-in picture that says what the settings are, so a test can see them change
      const w = settings.watermark.kind === 'none' ? 'no watermark' : settings.watermark.kind === 'text' ? `watermark: ${settings.watermark.text}` : 'logo watermark'
      const b = !settings.border.enabled ? 'no border' : settings.border.caption.show ? 'border and caption' : 'border'
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="267"><rect width="100%" height="100%" fill="hsl(${(id * 47) % 360},40%,40%)"/><text x="10" y="30" fill="white">${settings.format} ${settings.longEdge} ${w} ${b}</text></svg>`
      await tick(30)
      return 'data:image/svg+xml;utf8,' + encodeURIComponent(svg)
    },
    cullScan: async (ids) => {
      if (opts.failPreview) throw new Error('This photo has no preview yet.')
      for (let i = 0; i <= ids.length; i++) emit('cull:progress', { done: i, total: ids.length })
      await tick(30)
      // a stand-in: every seventh photo is soft, every eleventh is too bright, and the photos go in threes (the middle one is best)
      const rows = ids.map((id, i) => {
        const p = db.find((x) => x.id === id)
        const inGroup = i < 9
        return { id, name: p?.name ?? `Photo ${id}`, look: id % 5 === 0 ? 3.6 : 5.4, sharpness: id % 7 === 0 ? 8 : 240, blown: 0, crushed: 0, soft: id % 7 === 0, exposure: id % 11 === 0 ? ('too bright' as const) : null, group: inGroup ? Math.floor(i / 3) : null, best: inGroup && i % 3 === 1, skipped: null }
      })
      return { rows, groups: Math.min(3, Math.floor(ids.length / 3)) }
    },
    maskObject: async (_id, _recipe, x, y) => {
      if (opts.failPreview) throw new Error('This photo has no preview yet.')
      ;(globalThis as { __objects?: unknown[] }).__objects = [...((globalThis as { __objects?: unknown[] }).__objects ?? []), { x, y }]
      await tick(30)
      return { map: 'bW9jayBvYmplY3Q=', confidence: 0.9 }
    },
    maskDepth: async () => {
      if (opts.failPreview) throw new Error('This photo has no preview yet.')
      await tick(30)
      return { map: 'bW9jayBkZXB0aA==' }
    },
    maskPerson: async () => {
      if (opts.failPreview) throw new Error('This photo has no preview yet.')
      await tick(30)
      return { map: 'bW9jayBwZXJzb24=' }
    },
    maskSubject: async () => {
      if (opts.failPreview) throw new Error('This photo has no preview yet.')
      await tick(30)
      return { map: 'bW9jayBtYXA=' }
    },
    advisePhoto: async (_id, recipe) => {
      if (opts.failPreview) throw new Error('This photo has no preview yet.')
      await tick(30)
      if (opts.noFaces) return { faces: 0, skin: null, items: [{ id: 'exposure', title: 'Brighten the picture', why: 'The middle tone of the picture is 70 out of 255, so it is on the dark side.', changes: [{ field: 'exposure', value: Math.round((recipe.exposure + 0.6) * 10) / 10 }] }] }
      return {
        faces: 2,
        skin: { pixels: 4000, faces: 2, lightness: 60, hue: 30, chroma: 28, verdict: 'The skin looks a little too red.' },
        items: [
          { id: 'skin-cast', title: 'Take the red out of the skin', why: 'The skin measures too red or pink: its hue is 30 degrees, and healthy skin sits between 36 and 64.', changes: [{ field: 'temperature', value: recipe.temperature + 10 }, { field: 'tint', value: recipe.tint - 8 }] },
          { id: 'contrast', title: 'Add some contrast', why: 'Nearly all the picture lies between 70 and 170 out of 255, which looks flat.', changes: [{ field: 'contrast', value: recipe.contrast + 20 }] },
        ],
      }
    },
    enlargeInfo: async (id, recipe) => {
      const p = db.find((x) => x.id === id)
      const [w, h] = [p?.width ?? 3000, p?.height ?? 2000]
      const f = recipe.crop.rect ? Math.max(0.05, Math.min(1, recipe.crop.rect.w)) : 1
      return { width: Math.max(1, Math.round(w * f)), height: Math.max(1, Math.round((recipe.crop.rect ? h * recipe.crop.rect.h : h))) }
    },
    enlargePreview: async (_id, _recipe, method) => {
      if (opts.failPreview) throw new Error('This photo has no preview yet.')
      const pic = (label: string, hue: number) => 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="480" height="320"><rect width="100%" height="100%" fill="hsl(${hue},40%,40%)"/><text x="10" y="30" fill="white">${label}</text></svg>`)
      await tick(30)
      return { before: pic('pixels repeated', 200), after: pic('enlarged: ' + method, 120) }
    },
    pickImage: async () => opts.pickImagePath ?? 'C:/Demo/logo.png',
    importThumbUrl: (path) => {
      const hue = [...path].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 360, 7)
      return 'data:image/svg+xml;utf8,' + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="160" height="107"><rect width="100%" height="100%" fill="hsl(${hue},45%,45%)"/></svg>`)
    },
    importRun: async (_source, mode, destination, files, options): Promise<ImportResult> => {
      if (mode !== 'add' && !destination) throw new Error(`Choose a destination folder to ${mode} into.`)
      ;(globalThis as { __imports?: unknown[] }).__imports = [...((globalThis as { __imports?: unknown[] }).__imports ?? []), { mode, destination, options }]
      let chosen = files ?? demoList(_source).map((i) => i.path)
      if (chosen.length === 0) throw new Error('None of the chosen photos could be found.')
      // "skip suspected duplicates": the demo pretends the first photo is one the catalog already has
      const suspected = options?.skipSuspected && chosen.length > 1 ? 1 : 0
      chosen = chosen.slice(suspected)
      const added = chosen.map((path) => {
        const p = makePhoto('Card import')
        if (/\.CR2$/i.test(path)) Object.assign(p, { name: p.name.replace('.jpg', '.CR2'), format: 'raw', previewable: false })
        return p
      })
      const raws = added.filter((a) => a.format === 'raw').length
      const step = Math.max(1, Math.ceil(added.length / 3))
      for (let i = 0; i <= added.length; i += step) {
        emit('import:progress', { done: i, total: added.length })
        await tick(120)
      }
      db.push(...added)
      if (!folders.includes('Card import')) folders.push('Card import')
      emit('preview:ready', added.map((a) => a.id))
      return { added: added.length, duplicates: suspected, failed: [], unsupportedPreviews: raws, leftBehind: [], addedIds: added.map((a) => a.id) }
    },
    photoQuery: async (q) => run(q),
    folderList: async (): Promise<FolderRow[]> =>
      folders.map((f, i) => ({ id: i + 1, root: 'Demo', rootPath: 'C:/Demo', relPath: f, count: db.filter((p) => p.folder === f).length })),
    folderRename: async (folderId, newName) => {
      const old = folders[folderId - 1]
      if (old === undefined) throw new Error('That folder is not in the catalog.')
      const name = newName.trim()
      if (!name || /[\\/:*?"<>|]/.test(name)) throw new Error('A folder name cannot be empty, end with a dot, or contain any of \\ / : * ? " < > |')
      const parent = old.includes('/') ? old.slice(0, old.lastIndexOf('/') + 1) : ''
      retarget(old, parent + name)
    },
    folderMove: async (folderId, destination) => {
      const old = folders[folderId - 1]
      if (old === undefined) throw new Error('That folder is not in the catalog.')
      const dest = destination === null ? '' : folders[destination - 1]
      if (dest === undefined) throw new Error('That folder is not in the catalog.')
      if (dest === old || dest.startsWith(old + '/')) throw new Error('A folder cannot be moved into itself.')
      const leaf = old.slice(old.lastIndexOf('/') + 1)
      retarget(old, dest ? `${dest}/${leaf}` : leaf)
    },
    setRating: async (ids, rating) => {
      if (opts.failWrites) throw new Error('The catalog could not be saved.')
      if (rating < 0 || rating > 5) throw new Error('Rating must be 0 to 5.')
      apply(ids, (p) => (p.rating = rating))
    },
    setFlag: async (ids, flag: Flag) => {
      if (opts.failWrites) throw new Error('The catalog could not be saved.')
      apply(ids, (p) => (p.flag = flag))
    },
    setLabel: async (ids, label: Label | null) => {
      if (opts.failWrites) throw new Error('The catalog could not be saved.')
      apply(ids, (p) => (p.label = label))
    },
    exportRun: async (ids, destination, settings, newFolder): Promise<ExportResult> => {
      if (!destination) throw new Error('Pick a destination folder that exists.')
      const problem = newFolder ? folderProblem(newFolder) : null
      if (problem) throw new Error(problem)
      // what the page asked for, so the browser tests can check it was sent
      const log = ((globalThis as { __exports?: unknown[] }).__exports ??= [])
      log.push({ ids, destination, settings, newFolder: newFolder ?? null })
      for (let i = 0; i <= ids.length; i++) emit('export:progress', { done: i, total: ids.length })
      const folder = newFolder?.trim() ? `${destination}/${newFolder.trim()}` : destination
      return { written: ids.length, failed: [], folder, files: ids.map((id) => `${folder}/IMG_${1000 + id}.jpg`) }
    },
    photoIds: async (q) => run({ ...q, offset: 0, limit: Number.MAX_SAFE_INTEGER }).rows.map((r) => r.id),
    photoVirtualCopy: async (ids) => {
      if (ids.length > 200) throw new Error('Make virtual copies of 200 photos at most at a time.')
      const made: number[] = []
      for (const id of ids) {
        const from = db.find((p) => p.id === id)
        if (!from) throw new Error('One of the selected photos is no longer in the catalog.')
        const master = from.masterId ?? from.id
        const n = Math.max(0, ...db.filter((p) => p.masterId === master).map((p) => Number(p.copyName?.replace('Copy ', '')) || 0)) + 1
        const copy: Photo = { ...from, id: Math.max(...db.map((p) => p.id)) + 1, copyName: `Copy ${n}`, masterId: master }
        db.splice(db.indexOf(from) + 1, 0, copy)
        if (photoKw.has(id)) photoKw.set(copy.id, new Set(photoKw.get(id)))
        if (meta.has(id)) meta.set(copy.id, { ...meta.get(id) })
        const e = edits.get(id)
        if (e) edits.set(copy.id, { recipe: structuredClone(e.recipe), history: [] })
        cols.forEach((c) => c.members.has(id) && c.members.add(copy.id))
        made.push(copy.id)
      }
      return made
    },
    photoDeletePreview: async (ids) => db.filter((p) => ids.includes(p.id) && p.masterId === null).map((p) => p.path),
    photoDeleteFromDisk: async (ids) => {
      if (opts.failWrites) throw new Error('The files could not be moved to the Recycle Bin, so nothing was deleted: access denied')
      ;(globalThis as { __deleted?: string[] }).__deleted = [...((globalThis as { __deleted?: string[] }).__deleted ?? []), ...db.filter((p) => ids.includes(p.id) && p.masterId === null).map((p) => p.path)]
      return removePhotos(ids)
    },
    photoRemove: async (ids) => removePhotos(ids),

    collectionList: async (): Promise<CollectionRow[]> =>
      cols
        .map((c) => ({ id: c.id, name: c.name, kind: c.kind, isTarget: c.isTarget, parentId: c.parentId ?? null, count: c.kind === 'smart' ? db.filter((p) => inCollection(c, p)).length : c.members.size }))
        .sort((a, b) => (a.kind === 'quick' ? -1 : b.kind === 'quick' ? 1 : a.name.localeCompare(b.name))),
    collectionCreate: async (name) => {
      const n = name.replace(/\s+/g, ' ').trim()
      if (!n || n.length > 100) throw new Error('Give the collection a name of 1 to 100 characters.')
      cols.push({ id: nextCol, name: n, kind: 'collection', isTarget: false, members: new Set() })
      return nextCol++
    },
    collectionSetCreate: async (name, parent) => {
      const n = name.replace(/\s+/g, ' ').trim()
      if (!n || n.length > 100) throw new Error('Give the collection a name of 1 to 100 characters.')
      if (parent !== null && colById(parent).kind !== 'set') throw new Error('A collection can only be put inside a collection set.')
      cols.push({ id: nextCol, name: n, kind: 'set', isTarget: false, members: new Set(), parentId: parent })
      return nextCol++
    },
    collectionMove: async (id, parent) => {
      const c = colById(id)
      if (c.kind === 'quick') throw new Error('The Quick Collection cannot be moved.')
      if (parent !== null) {
        if (colById(parent).kind !== 'set') throw new Error('A collection can only be put inside a collection set.')
        for (let at: number | null | undefined = parent; at; at = colById(at).parentId) if (at === id) throw new Error('A set cannot be put inside itself.')
      }
      c.parentId = parent
    },
    collectionRename: async (id, name) => {
      const c = colById(id)
      const n = name.replace(/\s+/g, ' ').trim()
      if (c.kind === 'quick') throw new Error('The Quick Collection cannot be renamed.')
      if (!n || n.length > 100) throw new Error('Give the collection a name of 1 to 100 characters.')
      c.name = n
    },
    collectionDelete: async (id) => {
      const c = colById(id)
      if (c.kind === 'quick') throw new Error('The Quick Collection cannot be deleted.')
      if (c.kind === 'set') cols.forEach((x) => x.parentId === id && (x.parentId = c.parentId ?? null))
      cols.splice(cols.indexOf(c), 1)
    },
    smartCreate: async (name, rules) => {
      const n = name.replace(/\s+/g, ' ').trim()
      if (!n || n.length > 100) throw new Error('Give the collection a name of 1 to 100 characters.')
      checkRules(rules)
      cols.push({ id: nextCol, name: n, kind: 'smart', isTarget: false, members: new Set(), rules: structuredClone(rules) })
      return nextCol++
    },
    smartUpdate: async (id, name, rules) => {
      const c = colById(id)
      if (c.kind !== 'smart') throw new Error('That is not a smart collection.')
      checkRules(rules)
      c.name = name.replace(/\s+/g, ' ').trim() || c.name
      c.rules = structuredClone(rules)
    },
    smartRules: async (id) => {
      const c = colById(id)
      if (c.kind !== 'smart' || !c.rules) throw new Error('That is not a smart collection.')
      return structuredClone(c.rules)
    },
    smartCount: async (rules) => {
      checkRules(rules)
      return db.filter((p) => smartHolds(rules, p)).length
    },
    collectionAdd: async (id, photoIds) => {
      if (colById(id).kind === 'smart') throw new Error('A smart collection fills itself from its rules. Photos cannot be added to it or taken out by hand; change its rules instead.')
      photoIds.forEach((p) => colById(id).members.add(p))
    },
    collectionRemove: async (id, photoIds) => {
      if (colById(id).kind === 'smart') throw new Error('A smart collection fills itself from its rules. Photos cannot be added to it or taken out by hand; change its rules instead.')
      photoIds.forEach((p) => colById(id).members.delete(p))
    },
    collectionSetTarget: async (id) => {
      cols.forEach((c) => (c.isTarget = c.id === id))
    },
    quickToggle: async (photoIds) => {
      const q = cols[0].members
      const allIn = photoIds.length > 0 && photoIds.every((p) => q.has(p))
      photoIds.forEach((p) => (allIn ? q.delete(p) : q.add(p)))
      return !allIn
    },
    keywordList: async (): Promise<KeywordRow[]> =>
      kws.map((k) => {
        const ids = kwWithChildren(k.id)
        let count = 0
        for (const have of photoKw.values()) if ([...have].some((x) => ids.has(x))) count++
        return { id: k.id, name: k.name, parentId: k.parentId, count, synonyms: k.synonyms ?? '', includeOnExport: k.includeOnExport ?? true, isPrivate: k.isPrivate ?? false }
      }),
    keywordSetOptions: async (id, synonyms, includeOnExport, isPrivate) => {
      const k = kws.find((x) => x.id === id)
      if (!k) throw new Error('That keyword is not in the catalog.')
      const seen: string[] = []
      for (const s of synonyms.split(',').map((x) => x.trim().replace(/\s+/g, ' ')).filter(Boolean)) if (!seen.some((x) => x.toLowerCase() === s.toLowerCase())) seen.push(s)
      if (seen.length > 20) throw new Error('A keyword can have up to 20 synonyms.')
      Object.assign(k, { synonyms: seen.join(', '), includeOnExport, isPrivate })
    },
    keywordAdd: async (photoIds, path) => {
      if (!path.length || path.some((p) => !p.trim())) throw new Error('A keyword cannot be empty.')
      let parent: number | null = null
      for (const name of path) {
        let k = kws.find((x) => x.parentId === parent && x.name.toLowerCase() === name.toLowerCase())
        if (!k) (k = { id: nextKw++, name, parentId: parent }, kws.push(k))
        parent = k.id
      }
      photoIds.forEach((p) => (photoKw.get(p) ?? photoKw.set(p, new Set()).get(p)!).add(parent!))
      return parent!
    },
    keywordRemove: async (photoIds, keywordId) => photoIds.forEach((p) => photoKw.get(p)?.delete(keywordId)),
    keywordsFor: async (photoIds) => {
      const counts = new Map<number, number>()
      photoIds.forEach((p) => photoKw.get(p)?.forEach((k) => counts.set(k, (counts.get(k) ?? 0) + 1)))
      return [...counts].map(([keywordId, count]) => ({ keywordId, count }))
    },
    metadataGet: async (photoIds) => {
      const out = { title: [] as string[], caption: [] as string[], creator: [] as string[], copyright: [] as string[], credit: [] as string[], source: [] as string[], sublocation: [] as string[], city: [] as string[], state: [] as string[], country: [] as string[], headline: [] as string[], jobTitle: [] as string[], instructions: [] as string[], jobId: [] as string[], usageTerms: [] as string[] }
      for (const f of Object.keys(out) as (keyof typeof out)[]) {
        const seen = new Set<string>()
        for (const id of photoIds) {
          seen.add(meta.get(id)?.[f] ?? '')
          if (seen.size > 1) break
        }
        out[f] = [...seen]
      }
      return out
    },
    metadataSet: async (photoIds, patch) => {
      if (opts.failWrites) throw new Error('The catalog could not be saved.')
      for (const v of Object.values(patch)) if ((v ?? '').length > 2000) throw new Error('That text is too long (2000 characters at most).')
      photoIds.forEach((id) => meta.set(id, { ...meta.get(id), ...patch }))
    },
    developGet: async (id) => {
      if (!db.some((p) => p.id === id)) throw new Error('That photo is no longer in the catalog.')
      const e = edits.get(id)
      return { recipe: e?.recipe ?? DEFAULT_RECIPE, history: [...(e?.history ?? [])].reverse() }
    },
    developSave: async (id, recipe, step) => {
      if (opts.failWrites) throw new Error('The catalog could not be saved.')
      const e = edits.get(id) ?? { recipe, history: [] }
      e.recipe = recipe
      if (step) e.history.push({ id: nextStep, seq: nextStep++, ...step, createdAt: new Date().toISOString(), recipe })
      edits.set(id, e)
      const photo = db.find((p) => p.id === id)
      if (photo) photo.edited = JSON.stringify(recipe) !== JSON.stringify(DEFAULT_RECIPE)
      emit('preview:edited', [id])
    },
    // The real core renders pixels. The mock approximates exposure and saturation with an SVG filter so the browser build shows a change.
    proofSet: async (path, intent) => {
      if (path && !/\.(icc|icm)$/i.test(path)) throw new Error('That is not a colour profile this program can read: the file is not an ICC profile.')
      ;(globalThis as { __proof?: unknown[] }).__proof = [...((globalThis as { __proof?: unknown[] }).__proof ?? []), { path, intent }]
      return path ? { name: path.split('/').pop()!.replace(/\.[^.]+$/, '') } : null
    },
    pickProfile: async () => opts.pick ?? 'C:/Profiles/Glossy Paper.icc',
    renderUrl: (id, r, _version, edge = 0, _overlay, proof) => {
      const hue = (id * 47) % 360
      const slope = 2 ** r.exposure
      // a proofed picture shows what the paper cannot hold: the demo just takes the colour down, and marks the gamut warning
      const profileSat = ({ vivid: 1.3, landscape: 1.15, portrait: 0.9, neutral: 0.88, flat: 0.8, monochrome: 0 } as Record<string, number>)[r.profile] ?? 1
      const sat = Math.max(0, 1 + r.saturation / 100) * (proof ? 0.6 : 1) * (1 + (profileSat - 1) * ((r.profileAmount ?? 100) / 100))
      const warm = r.temperature / 400
      const f = `<filter id="f"><feColorMatrix type="saturate" values="${sat}"/><feComponentTransfer><feFuncR type="linear" slope="${(slope * (1 + warm)).toFixed(3)}"/><feFuncG type="linear" slope="${slope.toFixed(3)}"/><feFuncB type="linear" slope="${(slope * (1 - warm)).toFixed(3)}"/></feComponentTransfer></filter>`
      const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1067">${f}<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="hsl(${hue},45%,35%)"/><stop offset="1" stop-color="hsl(${(hue + 60) % 360},55%,65%)"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)" filter="url(#f)"/></svg>`
      return 'data:image/svg+xml;utf8,' + encodeURIComponent(svgText) + encodeURIComponent(`<!--edge${edge}${r.profile ? `profile-${r.profile}` : ''}${proof ? `proof-${proof.gamut ? 'gamut' : 'on'}` : ''}-->`)
    },
    developFindDust: async (id) => {
      if (!db.some((p) => p.id === id)) throw new Error('That photo is no longer in the catalog.')
      // the demo finds three specks
      return [{ x: 0.2, y: 0.15, sx: 0.28, sy: 0.15, size: 0.012 }, { x: 0.55, y: 0.3, sx: 0.63, sy: 0.3, size: 0.01 }, { x: 0.8, y: 0.1, sx: 0.72, sy: 0.1, size: 0.014 }]
    },
    developSpotSource: async (id, x, y) => {
      if (!db.some((p) => p.id === id)) throw new Error('That photo is no longer in the catalog.')
      return [x < 0.6 ? x + 0.2 : x - 0.2, y]
    },
    developAuto: async (id) => {
      if (!db.some((p) => p.id === id)) throw new Error('That photo is no longer in the catalog.')
      return { temperature: 12, tint: -4, exposure: 0.4, contrast: 10, highlights: -20, shadows: 25, whites: 5, blacks: -8, vibrance: 15, saturation: 4 }
    },
    presetList: async () => [...presets].sort((a, b) => a.group.localeCompare(b.group) || a.name.localeCompare(b.name)),
    presetCreate: async (name, group, groups, recipe) => {
      const n = label(name, 'preset')
      const g = group && group.trim() ? label(group, 'group') : 'User Presets'
      if (!groups.length) throw new Error('Pick at least one group of settings for the preset.')
      if (presets.some((p) => p.group === g && p.name.toLowerCase() === n.toLowerCase())) throw new Error('A preset with that name already exists in this group.')
      const id = nextPreset++
      presets.push({ id, name: n, group: g, groups, recipe })
      return id
    },
    presetRename: async (id, name) => {
      const p = presets.find((x) => x.id === id)
      if (!p) throw new Error('That preset no longer exists.')
      const n = label(name, 'preset')
      if (presets.some((x) => x.id !== id && x.group === p.group && x.name.toLowerCase() === n.toLowerCase())) throw new Error('A preset with that name already exists in this group.')
      p.name = n
    },
    presetDelete: async (id) => {
      const i = presets.findIndex((p) => p.id === id)
      if (i >= 0) presets.splice(i, 1)
    },
    snapshotList: async (photoId) => [...(snaps.get(photoId) ?? [])].reverse(),
    snapshotCreate: async (photoId, name, recipe) => {
      if (opts.failWrites) throw new Error('The catalog could not be saved.')
      const n = label(name, 'snapshot')
      const id = nextSnap++
      snaps.set(photoId, [...(snaps.get(photoId) ?? []), { id, name: n, createdAt: new Date().toISOString(), recipe }])
      return id
    },
    snapshotDelete: async (id) => {
      for (const [k, v] of snaps) snaps.set(k, v.filter((s) => s.id !== id))
    },
    zoomOpen: async (id) => {
      if (!db.some((p) => p.id === id)) throw new Error('That photo is no longer in the catalog.')
      return { width: 4000, height: 2667 }
    },
    zoomClose: async () => undefined,
    // A checkerboard that moves with x and y, so panning is visible in the browser build.
    regionUrl: (id, r, x, y, w, h) => {
      const hue = (id * 47) % 360
      const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" data-exposure="${r.exposure}"><defs><pattern id="p" width="200" height="200" patternUnits="userSpaceOnUse" patternTransform="translate(${-x} ${-y})"><rect width="100" height="100" fill="hsl(${hue},40%,40%)"/><rect x="100" y="100" width="100" height="100" fill="hsl(${hue},40%,40%)"/><rect x="100" width="100" height="100" fill="hsl(${hue},50%,70%)"/><rect y="100" width="100" height="100" fill="hsl(${hue},50%,70%)"/></pattern></defs><rect width="100%" height="100%" fill="url(#p)"/></svg>`
      return 'data:image/svg+xml;utf8,' + encodeURIComponent(svgText)
    },
    previewUrl: (id, level, version) => svg(id, level === 'thumb' ? 360 : 1600, level === 'thumb' ? 240 : 1067) + encodeURIComponent(`<!--${version}-->`),
    on: async (event, cb) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(cb as Listener)
      return () => listeners.get(event)?.delete(cb as Listener)
    },
  }
}
