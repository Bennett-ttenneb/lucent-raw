import { useEffect, useState } from 'react'
import { usePrefs } from '../lib/prefs'
import { LicenceChip } from './Licence'
import { SavedFilters } from './SavedFilters'
import { fillStyle } from './SliderRow'
import { api } from '../lib/api'
import { Monogram, Wordmark } from './Logo'
import { useStore, type ModuleId } from '../lib/store'
import { useTheme } from '../lib/theme'
import { LABELS, type Filters, type Label, type MetadataValues } from '../lib/types'

/** The drawing of a tab: 24 x 24, round line ends, the colour of the text. */
function TabIcon({ id }: { id: ModuleId }) {
  const common = { viewBox: '0 0 24 24', width: 18, height: 18, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, 'aria-hidden': true, focusable: false }
  if (id === 'library')
    return (
      <svg {...common}>
        <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
        <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
        <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
        <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
      </svg>
    )
  if (id === 'develop')
    return (
      <svg {...common}>
        <path d="M4 7h9M17 7h3M4 17h3M11 17h9M4 12h13M21 12h-0.5" />
        <circle cx="15" cy="7" r="2" />
        <circle cx="9" cy="17" r="2" />
        <circle cx="19" cy="12" r="1.2" />
      </svg>
    )
  if (id === 'book')
    return (
      <svg {...common}>
        <path d="M12 6.5C10 5 7 4.5 4 5v13c3-.5 6 0 8 1.5 2-1.5 5-2 8-1.5V5c-3-.5-6 0-8 1.5zM12 6.5v13" />
      </svg>
    )
  return (
    <svg {...common}>
      <path d="M12 3.5l1.9 5.1 5.1 1.9-5.1 1.9L12 17.5l-1.9-5.1L5 10.5l5.1-1.9z" />
      <path d="M18.5 16.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7z" />
    </svg>
  )
}

/** The modules that exist. (Map, Slideshow and Web are not part of the app.) */
const MODULES: { id: ModuleId; name: string }[] = [
  { id: 'library', name: 'Library' },
  { id: 'develop', name: 'Develop' },
  { id: 'retouch', name: 'Retouch' },
  { id: 'book', name: 'Book' },
  { id: 'print', name: 'Print' },
]

/** Dark or light in one press (the full choice, including "match my computer", is in Preferences). */
function ThemeButton() {
  const theme = useTheme((s) => s.theme)
  const next = theme === 'dark' ? 'light' : 'dark'
  return (
    <button type="button" className="help-btn ai-btn" aria-label={`Switch to ${next} mode`} title={`Switch to ${next} mode`} onClick={() => useTheme.getState().toggle()}>
      {theme === 'dark' ? (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
          <circle cx="12" cy="12" r="4" />
          <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6L17 7M7 17l-1.4 1.4" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
          <path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z" />
        </svg>
      )}
    </button>
  )
}

export function ModuleBar() {
  const hideAi = usePrefs((s) => s.hideAi)
  const module = useStore((s) => s.module)
  return (
    <header className="modbar">
      <h1 className="sr">Lucent Raw</h1>
      <div className="identity">
        <Monogram height={30} />
        <Wordmark />
      </div>
      <nav className="modules" role="tablist" aria-label="Modules">
        {MODULES.map((m) => (
          <button key={m.id} role="tab" aria-selected={module === m.id} onClick={() => useStore.setState({ module: m.id })}>
            <TabIcon id={m.id} />
            <span>{m.name}</span>
          </button>
        ))}
      </nav>
      <div className="modbar-end">
        <LicenceChip />
        <ThemeButton />
        <button type="button" className="help-btn ai-btn" aria-label="Preferences" title="Preferences" onClick={() => useStore.setState({ preferencesOpen: true })}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
            <path d="M4 7h10M18 7h2M4 17h2M10 17h10M4 12h4M12 12h8" />
            <circle cx="16" cy="7" r="2" />
            <circle cx="8" cy="17" r="2" />
            <circle cx="10" cy="12" r="2" />
          </svg>
        </button>
        {!hideAi && (
        <button type="button" className="help-btn ai-btn" aria-label="AI connection" title="Let an AI assistant on this computer use Lucent Raw" onClick={() => useStore.setState({ mcpOpen: true })}>
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
            <path d="M9 7V3M15 7V3M7 7h10v4a5 5 0 0 1-10 0zM12 16v5" />
          </svg>
        </button>
        )}
      <button type="button" className="help-btn" aria-label="Help and shortcuts" title="Help and shortcuts (?)" onClick={() => useStore.setState({ helpOpen: true })}>
        ?
      </button>
      </div>
    </header>
  )
}

type Tab = 'text' | 'attribute' | 'metadata' | 'none'

const META_KEYS = ['camera', 'lens', 'minIso', 'maxIso', 'minFocal', 'maxFocal', 'minAperture', 'maxAperture', 'dateFrom', 'dateTo'] as const
const NO_META = Object.fromEntries(META_KEYS.map((k) => [k, undefined])) as Partial<Filters>

const toNumber = (t: string): number | undefined => {
  const n = Number(t.trim().replace(',', '.'))
  return t.trim() !== '' && Number.isFinite(n) ? n : undefined
}

/** From and To boxes for a number; a moment after typing stops, the range is applied. An empty box is no limit. */
function NumberRange({ label, lo, hi, step, hint, onChange }: { label: string; lo: number | undefined; hi: number | undefined; step: number; hint: string; onChange(lo: number | undefined, hi: number | undefined): void }) {
  const [a, setA] = useState(lo === undefined ? '' : String(lo))
  const [b, setB] = useState(hi === undefined ? '' : String(hi))
  useEffect(() => {
    const t = setTimeout(() => {
      const [x, y] = [toNumber(a), toNumber(b)]
      if (x !== lo || y !== hi) onChange(x, y)
    }, 350)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [a, b])
  return (
    <fieldset className="range">
      <legend>{label}</legend>
      <input className="field narrow" type="number" step={step} aria-label={`${label} from`} placeholder={hint.split(' to ')[0]} value={a} onChange={(e) => setA(e.target.value)} />
      <span aria-hidden>to</span>
      <input className="field narrow" type="number" step={step} aria-label={`${label} to`} placeholder={hint.split(' to ')[1]} value={b} onChange={(e) => setB(e.target.value)} />
    </fieldset>
  )
}

const rangeHint = (r: [number, number] | null | undefined, digits = 0) => (r ? `${r[0].toFixed(digits)} to ${r[1].toFixed(digits)}` : 'any to any')

export function FilterBar() {
  const filters = useStore((s) => s.filters)
  const setFilters = useStore((s) => s.setFilters)
  const [tab, setTab] = useState<Tab>('none')
  const [text, setText] = useState(filters.text ?? '')
  const [meta, setMeta] = useState<MetadataValues | null>(null)

  useEffect(() => {
    if (tab !== 'text') return
    const t = setTimeout(() => void setFilters({ text: text.trim() || undefined }), 250)
    return () => clearTimeout(t)
  }, [text, tab]) // eslint-disable-line react-hooks/exhaustive-deps

  // what the catalog holds, each time the Metadata tab is opened
  useEffect(() => {
    if (tab !== 'metadata') return
    let alive = true
    api().metadataValues().then((v) => alive && setMeta(v)).catch(() => alive && setMeta(null))
    return () => {
      alive = false
    }
  }, [tab])

  const choose = (t: Tab) => {
    setTab(t)
    if (t === 'none') {
      setText('')
      void setFilters({ text: undefined, minRating: undefined, flag: undefined, label: undefined, edited: undefined, copies: undefined, ...NO_META })
    } else if (t === 'text') {
      void setFilters({ minRating: undefined, flag: undefined, label: undefined, edited: undefined, copies: undefined, ...NO_META })
    } else if (t === 'metadata') {
      setText('')
      void setFilters({ text: undefined, minRating: undefined, flag: undefined, label: undefined, edited: undefined, copies: undefined })
    } else {
      setText('')
      void setFilters({ text: undefined, ...NO_META })
    }
  }

  return (
    <div className="filter" role="search">
      <span className="muted">Filter</span>
      <div role="tablist" aria-label="Filter type" className="ftabs">
        {(['text', 'attribute', 'metadata', 'none'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => choose(t)}>
            {t === 'text' ? 'Text' : t === 'attribute' ? 'Attribute' : t === 'metadata' ? 'Metadata' : 'None'}
          </button>
        ))}
      </div>
      <SavedFilters
        onApplied={(t, txt) => {
          setTab(t)
          setText(txt)
        }}
      />
      {tab === 'text' && (
        <input className="field" aria-label="Search file names, cameras and lenses" placeholder="File name, camera or lens" value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      )}
      {tab === 'metadata' && (
        <div className="row metafilter">
          <label className="inline">
            Camera
            <select className="field" value={filters.camera ?? ''} onChange={(e) => void setFilters({ camera: e.target.value || undefined })}>
              <option value="">Any camera</option>
              {meta?.cameras.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} ({c.count})
                </option>
              ))}
            </select>
          </label>
          <label className="inline">
            Lens
            <select className="field" value={filters.lens ?? ''} onChange={(e) => void setFilters({ lens: e.target.value || undefined })}>
              <option value="">Any lens</option>
              {meta?.lenses.map((l) => (
                <option key={l.name} value={l.name}>
                  {l.name} ({l.count})
                </option>
              ))}
            </select>
          </label>
          <NumberRange label="ISO" lo={filters.minIso} hi={filters.maxIso} step={100} hint={rangeHint(meta?.iso)} onChange={(lo, hi) => void setFilters({ minIso: lo, maxIso: hi })} />
          <NumberRange label="Focal length (mm)" lo={filters.minFocal} hi={filters.maxFocal} step={1} hint={rangeHint(meta?.focal)} onChange={(lo, hi) => void setFilters({ minFocal: lo, maxFocal: hi })} />
          <NumberRange label="Aperture (f)" lo={filters.minAperture} hi={filters.maxAperture} step={0.1} hint={rangeHint(meta?.aperture, 1)} onChange={(lo, hi) => void setFilters({ minAperture: lo, maxAperture: hi })} />
          <fieldset className="range">
            <legend>Date taken</legend>
            <input className="field" type="date" aria-label="Taken from" min={meta?.days?.[0]} max={meta?.days?.[1]} value={filters.dateFrom ?? ''} onChange={(e) => void setFilters({ dateFrom: e.target.value || undefined })} />
            <span aria-hidden>to</span>
            <input className="field" type="date" aria-label="Taken to" min={meta?.days?.[0]} max={meta?.days?.[1]} value={filters.dateTo ?? ''} onChange={(e) => void setFilters({ dateTo: e.target.value || undefined })} />
          </fieldset>
        </div>
      )}
      {tab === 'attribute' && (
        <div className="row">
          <label className="inline">
            Rating at least
            <select className="field" value={filters.minRating ?? 0} onChange={(e) => void setFilters({ minRating: Number(e.target.value) || undefined })}>
              {[0, 1, 2, 3, 4, 5].map((n) => (
                <option key={n} value={n}>
                  {n === 0 ? 'Any' : `${n} ★`}
                </option>
              ))}
            </select>
          </label>
          <label className="inline">
            Flag
            <select className="field" value={filters.flag ?? ''} onChange={(e) => void setFilters({ flag: (e.target.value || undefined) as Filters['flag'] })}>
              <option value="">Any</option>
              <option value="pick">Picks</option>
              <option value="reject">Rejects</option>
              <option value="unflagged">Unflagged</option>
            </select>
          </label>
          <label className="inline">
            Edits
            <select className="field" value={filters.edited ?? ''} onChange={(e) => void setFilters({ edited: (e.target.value || undefined) as Filters['edited'] })}>
              <option value="">Any</option>
              <option value="yes">Edited</option>
              <option value="no">Not edited</option>
            </select>
          </label>
          <label className="inline">
            Virtual copies
            <select className="field" value={filters.copies ?? ''} onChange={(e) => void setFilters({ copies: (e.target.value || undefined) as Filters['copies'] })}>
              <option value="">Show</option>
              <option value="no">Hide</option>
              <option value="only">Only copies</option>
            </select>
          </label>
          <label className="inline">
            Label
            <select className="field" value={filters.label ?? ''} onChange={(e) => void setFilters({ label: (e.target.value || undefined) as Label | undefined })}>
              <option value="">Any</option>
              {LABELS.map((l) => (
                <option key={l} value={l}>
                  {l[0].toUpperCase() + l.slice(1)}
                </option>
              ))}
            </select>
          </label>
        </div>
      )}
    </div>
  )
}

export function Toolbar() {
  const view = useStore((s) => s.view)
  const thumbSize = useStore((s) => s.thumbSize)
  const filters = useStore((s) => s.filters)
  const setFilters = useStore((s) => s.setFilters)
  const vo = useStore((s) => s.viewOptions)
  const setViewOptions = useStore((s) => s.setViewOptions)
  return (
    <div className="toolbar">
      <div className="seg" role="group" aria-label="View">
        <button aria-pressed={view === 'grid'} onClick={() => useStore.setState({ view: 'grid' })} title="Grid (G)">
          Grid
        </button>
        <button aria-pressed={view === 'loupe'} onClick={() => useStore.setState({ view: 'loupe' })} title="Loupe (E)">
          Loupe
        </button>
        <button aria-pressed={view === 'compare'} onClick={() => useStore.getState().perform({ type: 'view', value: 'compare' })} title="Compare (C)">
          Compare
        </button>
        <button aria-pressed={view === 'survey'} onClick={() => useStore.setState({ view: 'survey' })} title="Survey (N)">
          Survey
        </button>
      </div>
      <label className="inline">
        Sort
        <select className="field" value={filters.sort} onChange={(e) => void setFilters({ sort: e.target.value as Filters['sort'] })}>
          <option value="capture">Capture time</option>
          <option value="name">File name</option>
          <option value="rating">Rating</option>
        </select>
      </label>
      <button className="btn sm" aria-pressed={filters.desc} onClick={() => void setFilters({ desc: !filters.desc })} title="Reverse the order">
        {filters.desc ? 'Newest first' : 'Oldest first'}
      </button>
      <span className="grow" />
      {view === 'grid' && (
        <details className="popover">
          <summary>View options</summary>
          <div className="popover-body" role="group" aria-label="Grid view options">
            <label>
              <input type="checkbox" checked={vo.index} onChange={(e) => setViewOptions({ index: e.target.checked })} /> Index numbers
            </label>
            <label>
              <input type="checkbox" checked={vo.badges} onChange={(e) => setViewOptions({ badges: e.target.checked })} /> Rating and flag badges
            </label>
            <label>
              <input type="checkbox" checked={vo.labels} onChange={(e) => setViewOptions({ labels: e.target.checked })} /> Colour label bars
            </label>
            <label>
              <input type="checkbox" checked={vo.names} onChange={(e) => setViewOptions({ names: e.target.checked })} /> File names
            </label>
            <label>
              <input type="checkbox" checked={vo.details} onChange={(e) => setViewOptions({ details: e.target.checked })} /> Date and camera settings
            </label>
          </div>
        </details>
      )}
      {view === 'grid' && (
        <label className="inline">
          Size
          <input type="range" min={90} max={360} step={10} value={thumbSize} style={fillStyle(thumbSize, 90, 360)} aria-label="Thumbnail size" onChange={(e) => useStore.setState({ thumbSize: Number(e.target.value) })} />
        </label>
      )}
    </div>
  )
}
