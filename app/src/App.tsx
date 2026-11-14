import { useCallback, useEffect, useState } from 'react'
import { FilterBar, ModuleBar, Toolbar } from './components/Bars'
import { CatalogsDialog } from './components/Catalogs'
import { MenuBar } from './components/MenuBar'
import { MissingDialog } from './components/Missing'
import { SidecarsDialog } from './components/Sidecars'
import { PreferencesDialog } from './components/Preferences'
import { SmartDialog } from './components/Smart'
import { AiConnectionDialog } from './components/Mcp'
import { CullDialog } from './components/Cull'
import { ExportDialog, ImportDialog, RemoveDialog } from './components/Dialogs'
import { HelpDialog } from './components/Help'
import { Filmstrip, FilmstripBar } from './components/Filmstrip'
import { Grid } from './components/Grid'
import { DevelopLeft, DevelopRight, DevelopStage, RetouchRight } from './components/Develop'
import { BookLeft, BookRight, BookStage } from './components/Book'
import { useBook } from './lib/book'
import { Loupe } from './components/Loupe'
import { LeftPanels, RightPanels } from './components/Panels'
import { api } from './lib/api'
import { AutoStackDialog } from './components/AutoStack'
import { MergeHdrDialog } from './components/MergeHdr'
import { Compare } from './components/Compare'
import { PrintModule } from './components/Print'
import { Survey } from './components/Survey'
import { useDevelop } from './lib/develop'
import { keyFor, parseKey } from './lib/keys'
import { zoomToHundred } from './lib/menus'
import { useLights } from './lib/lights'
import { panelKey, showNumbers } from './lib/panels'
import { usePrefs } from './lib/prefs'
import { useProof } from './lib/proof'
import { startSecondSync } from './lib/second'
import { libraryRedo, libraryUndo, useStore, type ModuleId } from './lib/store'

/** The Library view to put back when Develop is left: Develop steps through photos, so it shows one at a time. */
let viewBeforeDevelop: 'grid' | null = null

const NEXT: Record<Exclude<ModuleId, 'library' | 'develop' | 'retouch' | 'book' | 'print'>, { title: string; text: string }> = {
  map: { title: 'Map', text: 'Placing photos on a map is planned for a later milestone.' },
  slideshow: { title: 'Slideshow', text: 'Slideshow templates, music and export are planned for a later milestone.' },
  web: { title: 'Web', text: 'Web gallery templates and export are planned for a later milestone.' },
}

function useShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (document.querySelector('dialog[open]')) return
      const s = useStore.getState()
      if (panelKey(e)) {
        e.preventDefault()
        return
      }
      if (e.key.toLowerCase() === keyFor('lights') && !e.ctrlKey && !e.metaKey && !e.altKey && (s.module === 'library' || s.module === 'develop' || s.module === 'retouch')) {
        e.preventDefault()
        return useLights.getState().cycle()
      }
      if (s.module === 'library' && e.key.toLowerCase() === keyFor('zoom') && !e.ctrlKey && !e.metaKey && !e.altKey && s.view === 'loupe' && s.photoAt(s.active)) {
        e.preventDefault()
        return zoomToHundred()
      }
      if (e.key === 'Escape' && useLights.getState().lights !== 'on') {
        e.preventDefault()
        return useLights.getState().set('on')
      }
      if (e.key === '?') {
        e.preventDefault()
        return useStore.setState({ helpOpen: true })
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key === "'" && (s.module === 'library' || s.module === 'develop' || s.module === 'retouch')) {
        e.preventDefault()
        return void s.makeVirtualCopies()
      }
      if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'p') {
        e.preventDefault()
        if (s.module === 'print') return window.print()
        return s.photoAt(s.active) ? useStore.setState({ module: 'print' }) : s.say('Select a photo to print first.', true)
      }
      if (s.module === 'library' && !e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        return void s.stackAction('toggle')
      }
      if (s.module === 'library' && (e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key.toLowerCase()
        if (k === 'g') {
          e.preventDefault()
          return void s.stackAction(e.shiftKey ? 'ungroup' : 'group')
        }
        if (k === 'z' && !e.shiftKey) {
          e.preventDefault()
          return void libraryUndo()
        }
        if ((k === 'z' && e.shiftKey) || k === 'y') {
          e.preventDefault()
          return void libraryRedo()
        }
        if (e.key === '[' || e.key === ']') {
          e.preventDefault()
          return void useDevelop.getState().turnMany(s.targetIds(), e.key === '[' ? 'Rotate left' : 'Rotate right', e.key === '[' ? 'left' : 'right').then((r) => r.done > 0 && s.say(e.key === '[' ? 'Turned left.' : 'Turned right.'))
        }
      }
      if (s.module === 'book' && (e.ctrlKey || e.metaKey) && !e.altKey) {
        const k = e.key.toLowerCase()
        if (k === 'z' && !e.shiftKey) {
          e.preventDefault()
          return useBook.getState().undo()
        }
        if ((k === 'z' && e.shiftKey) || k === 'y') {
          e.preventDefault()
          return useBook.getState().redo()
        }
      }
      if (s.module === 'develop' || s.module === 'retouch') {
        if (e.key === '\\') {
          e.preventDefault()
          return useDevelop.getState().toggleOriginal()
        }
        const d = useDevelop.getState()
        if ((e.ctrlKey || e.metaKey) && !e.altKey) {
          const k = e.key.toLowerCase()
          if (k === 'z' && !e.shiftKey) {
            e.preventDefault()
            return void d.undo()
          }
          if ((k === 'z' && e.shiftKey) || k === 'y') {
            e.preventDefault()
            return void d.redo()
          }
        }
        if (e.key.toLowerCase() === keyFor('clipping') &&!e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault()
          return d.toggleClipping()
        }
        if (e.key.toLowerCase() === keyFor('crop') &&!e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault()
          return d.setCropEdit(!d.cropEdit)
        }
        if (d.cropEdit && (e.key === 'Escape' || e.key === 'Enter')) {
          e.preventDefault()
          return d.setCropEdit(false)
        }
        if (e.key.toLowerCase() === 'y' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && s.module === 'develop') {
          e.preventDefault()
          return d.setCompareView(d.compareView === 'off' ? 'side' : d.compareView === 'side' ? 'split' : 'off')
        }
        if (e.key.toLowerCase() === 's' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey && s.module === 'develop') {
          e.preventDefault()
          const p = useProof.getState()
          return p.name ? p.setOn(!p.on) : s.say('Choose a colour profile in the Soft proofing panel first.', true)
        }
        if (e.key.toLowerCase() === keyFor('zoom') && !e.ctrlKey && !e.metaKey && !e.altKey) {
          e.preventDefault()
          if (d.cropEdit) return // the frame is being placed on the whole picture
          return d.toggleZoom()
        }
        const a = parseKey(e)
        if (!a) return
        // Develop keeps the filmstrip keys (rate, flag, label, step to the next photo) and the way back to the grid
        if (a.type === 'view') {
          viewBeforeDevelop = null // the user chose a view: keep it
          return void useStore.setState({ module: 'library', view: a.value })
        }
        if (a.type === 'rate' || a.type === 'flag' || a.type === 'label' || a.type === 'quick' || (a.type === 'move' && a.dx !== 0)) {
          e.preventDefault()
          s.perform(a)
        }
        return
      }
      if (s.module !== 'library') return
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && e.key.toLowerCase() === 'v') {
        e.preventDefault()
        return void useDevelop.getState().pasteToSelection()
      }
      const a = parseKey(e)
      if (!a) return
      e.preventDefault()
      s.perform(a)
    }
    // while Alt is held the number of each panel title is shown, so the Alt+number keys can be found without a list
    const altDown = (e: KeyboardEvent) => e.key === 'Alt' && showNumbers(true)
    const altUp = (e: KeyboardEvent) => e.key === 'Alt' && showNumbers(false)
    const altOff = () => showNumbers(false)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keydown', altDown)
    window.addEventListener('keyup', altUp)
    window.addEventListener('blur', altOff)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keydown', altDown)
      window.removeEventListener('keyup', altUp)
      window.removeEventListener('blur', altOff)
    }
  }, [])
}

export default function App() {
  const module = useStore((s) => s.module)
  const view = useStore((s) => s.view)
  const toast = useStore((s) => s.toast)
  const [devImg, setDevImg] = useState<HTMLImageElement | null>(null)
  const onDevImage = useCallback((i: HTMLImageElement | null) => setDevImg(i), [])
  const activePhotoId = useStore((s) => s.photoAt(s.active)?.id ?? null)
  useShortcuts()
  useEffect(() => startSecondSync(), [])
  // an AI assistant changed something through the AI connection: show it, and re-read the photo that is open in Develop
  useEffect(() => {
    let off = () => {}
    let timer: ReturnType<typeof setTimeout> | undefined
    const pending = new Set<number>()
    void api()
      .on<number[]>('catalog:changed', (ids) => {
        ids.forEach((id) => pending.add(id))
        clearTimeout(timer)
        timer = setTimeout(() => {
          void useStore.getState().reload()
          const d = useDevelop.getState()
          if (d.photoId !== null && pending.has(d.photoId)) void d.open(d.photoId)
          pending.clear()
        }, 250)
      })
      .then((u) => (off = u))
    return () => {
      off()
      clearTimeout(timer)
    }
  }, [])
  useEffect(() => {
    void useStore.getState().init()
    const threads = usePrefs.getState().threads
    if (threads > 0) void api().perfSet(threads).catch(() => undefined) // the chosen limit on worker threads goes to the core
    void useProof.getState().restore() // the profile for soft proofing goes to the core again
    const watch = usePrefs.getState().watch
    if (watch) void api().watchSet(watch).catch(() => undefined) // the watched folder is looked at again
  }, [])
  useEffect(() => {
    if (module !== 'develop' && module !== 'retouch') return
    void useDevelop.getState().open(activePhotoId)
  }, [module, activePhotoId])
  useEffect(() => {
    // a tool left on in one module would draw its handles in the other, where there is no panel to turn it off
    const d = useDevelop.getState()
    d.setSpotTool(false)
    d.setRedEyeTool(false)
    d.setPortraitTool(false)
    useDevelop.setState({ selectedMask: null, showMask: false, selectedSpot: null, selectedRedEye: null, selectedRegion: null, picking: false, painting: false })
  }, [module])
  useEffect(() => {
    if (module !== 'develop' && module !== 'retouch') return
    if (useStore.getState().view === 'grid') {
      viewBeforeDevelop = 'grid'
      useStore.setState({ view: 'loupe' }) // the filmstrip keys step through photos
    }
    return () => {
      if (viewBeforeDevelop) useStore.setState({ view: viewBeforeDevelop })
      viewBeforeDevelop = null
    }
  }, [module])

  return (
    <div className="app">
      <ModuleBar />
      <MenuBar />
      {module === 'library' || module === 'develop' || module === 'retouch' || module === 'book' || module === 'print' ? (
        <>
          {module === 'print' ? (
            <PrintModule />
          ) : module === 'book' ? (
            <main className="main">
              <BookLeft />
              <section className="center" aria-label="Book">
                <BookStage />
              </section>
              <BookRight />
            </main>
          ) : module === 'develop' || module === 'retouch' ? (
            <main className="main">
              <DevelopLeft retouch={module === 'retouch'} />
              <section className="center" aria-label="Edit">
                <DevelopStage onImage={onDevImage} />
              </section>
              {module === 'retouch' ? <RetouchRight /> : <DevelopRight img={devImg} />}
            </main>
          ) : (
            <main className="main">
              <LeftPanels />
              <section className="center" aria-label="Photos">
                <FilterBar />
                <div className="stage">{view === 'grid' ? <Grid /> : view === 'loupe' ? <Loupe /> : view === 'compare' ? <Compare /> : <Survey />}</div>
                <Toolbar />
              </section>
              <RightPanels />
            </main>
          )}
          <footer className="foot" aria-label="Filmstrip">
            <FilmstripBar />
            <Filmstrip />
          </footer>
        </>
      ) : (
        <main className="stub">
          <h2>{NEXT[module as keyof typeof NEXT].title}</h2>
          <p>{NEXT[module as keyof typeof NEXT].text}</p>
          <button className="btn" onClick={() => useStore.setState({ module: 'library' })}>
            Back to Library
          </button>
        </main>
      )}
      <ImportDialog />
      <ExportDialog />
      <CullDialog />
      <AutoStackDialog />
      <MergeHdrDialog />
      <CatalogsDialog />
      <MissingDialog />
      <SidecarsDialog />
      <PreferencesDialog />
      <SmartDialog />
      <AiConnectionDialog />
      <HelpDialog />
      <RemoveDialog />
      <div className="toast-host" aria-live="polite" role="status">
        {toast && <div className={`toast ${toast.error ? 'bad' : ''}`}>{toast.text}</div>}
      </div>
    </div>
  )
}
