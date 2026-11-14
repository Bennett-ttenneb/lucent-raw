import { useEffect, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useBook, MAX_FRAMES, MAX_PAGES } from '../lib/book'
import { LAYOUTS, layoutOf } from '../lib/bookLayouts'
import { plural } from '../lib/format'
import { usePreviewKey, useStore } from '../lib/store'
import type { BookDoc, BookFrame, BookPage, BookPdfResult, Progress } from '../lib/types'
import { Dialog, Panel, ProgressBar } from './Primitives'
import { SliderRow } from './SliderRow'

/** The page sizes to pick from (millimetres, width then height). */
const SIZES: { id: string; name: string; w: number; h: number }[] = [
  { id: 'sq8', name: 'Square 8 x 8 in', w: 203.2, h: 203.2 },
  { id: 'sq12', name: 'Square 12 x 12 in', w: 304.8, h: 304.8 },
  { id: 'l11', name: 'Landscape 11 x 8.5 in', w: 279.4, h: 215.9 },
  { id: 'p8', name: 'Portrait 8 x 10 in', w: 203.2, h: 254 },
  { id: 'a4p', name: 'A4 portrait', w: 210, h: 297 },
  { id: 'a4l', name: 'A4 landscape', w: 297, h: 210 },
]
const sizeId = (b: BookDoc) => SIZES.find((s) => Math.abs(s.w - b.widthMm) < 0.2 && Math.abs(s.h - b.heightMm) < 0.2)?.id ?? 'custom'

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

/** A photo drawn the way it will be printed: filling the frame round its focus point, or whole with room round it. */
function FramePhoto({ f }: { f: BookFrame }) {
  const key = usePreviewKey(f.photoId ?? 0)
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [f.photoId, key])
  if (f.photoId === null) return <span className="bk-empty">Drop a photo here</span>
  if (failed) return <span className="bk-empty">Photo not available</span>
  return <img className="bk-img" alt="" draggable={false} src={api().previewUrl(f.photoId, 'standard', key)} style={{ objectFit: f.fit === 'fill' ? 'cover' : 'contain', objectPosition: `${f.focusX * 100}% ${f.focusY * 100}%` }} onError={() => setFailed(true)} />
}

/** The page as it will print, scaled to fit; its frames can be picked, moved and resized, and take photos dropped on them. */
function PageView({ page, book, interactive = true }: { page: BookPage; book: BookDoc; interactive?: boolean }) {
  const frame = useBook((s) => s.frame)
  const ref = useRef<HTMLDivElement>(null)
  const widthPt = (book.widthMm / 25.4) * 72

  const drag = (e: React.PointerEvent, i: number, mode: 'move' | 'size') => {
    if (!interactive || e.button !== 0) return
    e.stopPropagation()
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    useBook.getState().selectFrame(i)
    const f = page.frames[i]
    const start = { x: e.clientX, y: e.clientY }
    let moved = false
    const onMove = (m: PointerEvent) => {
      const dx = (m.clientX - start.x) / r.width
      const dy = (m.clientY - start.y) / r.height
      if (!moved && Math.abs(dx) + Math.abs(dy) < 0.004) return
      moved = true
      if (mode === 'move') useBook.getState().patchFrame(i, { x: clamp(f.x + dx, 0, 1 - f.w), y: clamp(f.y + dy, 0, 1 - f.h) })
      else useBook.getState().patchFrame(i, { w: clamp(f.w + dx, 0.02, 1 - f.x), h: clamp(f.h + dy, 0.02, 1 - f.y) })
    }
    const up = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', up)
  }

  const key = (e: React.KeyboardEvent, i: number) => {
    const f = page.frames[i]
    const step = e.shiftKey ? 0.05 : 0.01
    const d = ({ ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] } as Record<string, [number, number]>)[e.key]
    if (d) {
      e.preventDefault()
      useBook.getState().patchFrame(i, { x: clamp(f.x + d[0], 0, 1 - f.w), y: clamp(f.y + d[1], 0, 1 - f.h) })
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      useBook.getState().deleteFrame(i)
    }
  }

  return (
    <div ref={ref} className="bk-page" data-testid={interactive ? 'book-page' : undefined} style={{ background: page.background, aspectRatio: `${book.widthMm} / ${book.heightMm}`, ['--bk-ratio' as string]: book.widthMm / book.heightMm }} onPointerDown={() => interactive && useBook.getState().selectFrame(null)}>
      {page.frames.map((f, i) => (
        <div
          key={i}
          role={interactive ? 'button' : undefined}
          tabIndex={interactive ? 0 : undefined}
          aria-label={interactive ? (f.kind === 'photo' ? `Photo frame ${i + 1}` : `Text frame ${i + 1}`) : undefined}
          aria-pressed={interactive ? frame === i : undefined}
          className={`bk-frame ${f.kind} ${frame === i && interactive ? 'sel' : ''}`}
          style={{ left: `${f.x * 100}%`, top: `${f.y * 100}%`, width: `${f.w * 100}%`, height: `${f.h * 100}%` }}
          onPointerDown={(e) => drag(e, i, 'move')}
          onKeyDown={(e) => interactive && key(e, i)}
          onDragOver={(e) => interactive && f.kind === 'photo' && e.dataTransfer.types.includes('application/x-lumora-photo') && e.preventDefault()}
          onDrop={(e) => {
            const id = Number(e.dataTransfer.getData('application/x-lumora-photo'))
            if (interactive && f.kind === 'photo' && id > 0) {
              e.preventDefault()
              useBook.getState().putPhoto(i, id)
            }
          }}
        >
          {f.kind === 'photo' ? (
            <FramePhoto f={f} />
          ) : (
            <div className="bk-text" style={{ fontSize: `${(f.sizePt / widthPt) * 100}cqw`, textAlign: f.align === 'centre' ? 'center' : f.align, fontWeight: f.bold ? 700 : 400, color: f.colour }}>
              {f.text}
            </div>
          )}
          {interactive && frame === i && <span className="bk-handle" aria-hidden onPointerDown={(e) => drag(e, i, 'size')} />}
        </div>
      ))}
    </div>
  )
}

/** The page being worked on, with the strip of all the pages beneath it. */
export function BookStage() {
  const book = useBook((s) => s.book)
  const page = useBook((s) => s.page)
  const error = useBook((s) => s.error)
  if (!book) {
    return (
      <div className="bk-none">
        <h2>Photo books</h2>
        <p>Make a book from the panel on the left, then put photos on its pages. Drag photos from the strip below, or choose them in the Library first and press “Make pages from photos”.</p>
        <button type="button" className="btn accent" onClick={() => void useBook.getState().create()}>
          New book
        </button>
        {error && <p className="err" role="alert">{error}</p>}
      </div>
    )
  }
  const current = book.pages[page] ?? book.pages[0]
  return (
    <div className="bk-stage">
      <div className="bk-canvas">
        <div className="bk-sheet">
          <PageView page={current} book={book} />
        </div>
      </div>
      {error && <p className="err bk-err" role="alert">Could not save the book: {error}</p>}
      <div className="bk-strip" role="listbox" aria-label="Pages" aria-orientation="horizontal">
        {book.pages.map((p, i) => (
          <button key={i} type="button" role="option" aria-selected={i === page} aria-label={`Page ${i + 1}`} className="bk-thumb" data-active={i === page} onClick={() => useBook.getState().setPage(i)}>
            <span className="bk-mini">
              <PageView page={p} book={book} interactive={false} />
            </span>
            <span className="n">{i + 1}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/** The books, the book's own settings, and making pages from photos. */
export function BookLeft() {
  const { list, bookId, book, loaded } = useBook()
  const selected = useStore((s) => s.selected)
  const [perPage, setPerPage] = useState(2)
  const [confirm, setConfirm] = useState<number | null>(null)
  const [exporting, setExporting] = useState(false)
  useEffect(() => {
    void useBook.getState().load()
    return () => void useBook.getState().flush()
  }, [])
  const fromSelected = () => {
    const s = useStore.getState()
    const ids = [...s.selected]
    if (ids.length) useBook.getState().fillFrom(ids, perPage)
  }
  return (
    <aside className="side left" aria-label="Book panels">
      <div className="side-scroll">
        <Panel title="Books">
          {loaded && list.length === 0 && <p className="hint">No books yet.</p>}
          <ul className="bk-list" aria-label="Your books">
            {list.map((e) => (
              <li key={e.id} data-current={e.id === bookId}>
                <button type="button" className="bk-pick" aria-current={e.id === bookId} onClick={() => void useBook.getState().open(e.id)}>
                  <span>{e.name}</span>
                  <small>{plural(e.pages, 'page')}</small>
                </button>
                {confirm === e.id ? (
                  <>
                    <button type="button" className="btn sm danger" aria-label={`Confirm: delete ${e.name}`} onClick={() => (setConfirm(null), void useBook.getState().remove(e.id))}>
                      Delete
                    </button>
                    <button type="button" className="btn sm" onClick={() => setConfirm(null)}>
                      Keep
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn sm" aria-label={`Delete ${e.name}`} onClick={() => setConfirm(e.id)}>
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
          <button type="button" className="btn accent" onClick={() => void useBook.getState().create()}>
            New book
          </button>
        </Panel>
        {book && (
          <>
            <Panel title="Book">
              <div className="stackl">
                <label className="lbl" htmlFor="bk-name">
                  Name
                </label>
                <input id="bk-name" className="field" maxLength={100} value={book.name} onChange={(e) => useBook.getState().edit((b) => ({ ...b, name: e.target.value }))} />
                <label className="lbl" htmlFor="bk-size">
                  Page size
                </label>
                <select
                  id="bk-size"
                  className="field"
                  value={sizeId(book)}
                  onChange={(e) => {
                    const s = SIZES.find((x) => x.id === e.target.value)
                    if (s) useBook.getState().edit((b) => ({ ...b, widthMm: s.w, heightMm: s.h }))
                  }}
                >
                  {sizeId(book) === 'custom' && <option value="custom">{`${Math.round(book.widthMm)} x ${Math.round(book.heightMm)} mm`}</option>}
                  {SIZES.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
                <label className="check">
                  <input type="checkbox" checked={book.pageNumbers} onChange={(e) => useBook.getState().edit((b) => ({ ...b, pageNumbers: e.target.checked }))} /> Page numbers
                </label>
              </div>
            </Panel>
            <Panel title="Make pages from photos">
              <p className="hint">Uses the photos chosen in the Library (or on the strip below), in order, after the pages already there.</p>
              <div className="field-row">
                <label className="lbl" htmlFor="bk-per">
                  Photos to a page
                </label>
                <select id="bk-per" className="field" value={perPage} onChange={(e) => setPerPage(Number(e.target.value))}>
                  {[1, 2, 3, 4, 6].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </div>
              <button type="button" className="btn" disabled={selected.size === 0 || book.pages.length >= MAX_PAGES} onClick={fromSelected}>
                Make pages from {plural(selected.size, 'selected photo')}
              </button>
            </Panel>
          </>
        )}
      </div>
      {book && (
        <div className="side-foot">
          <button type="button" className="btn accent" onClick={() => void useBook.getState().flush().then(() => setExporting(true))}>
            Make PDF…
          </button>
        </div>
      )}
      <PdfDialog open={exporting} onClose={() => setExporting(false)} />
    </aside>
  )
}

/** The page: its arrangement and colour, and adding, copying, moving and removing pages. */
export function BookRight() {
  const book = useBook((s) => s.book)
  const page = useBook((s) => s.page)
  const frame = useBook((s) => s.frame)
  const undoable = useBook((s) => s.undoable)
  const redoable = useBook((s) => s.redoable)
  if (!book) return <aside className="side right" aria-label="Book controls" />
  const cur = book.pages[page]
  if (!cur) return <aside className="side right" aria-label="Book controls" />
  const chosen = layoutOf(cur)
  const b = useBook.getState()
  return (
    <aside className="side right" aria-label="Book controls">
      <div className="side-scroll">
        <Panel title={`Page ${page + 1} of ${book.pages.length}`}>
          <div className="row">
            <button type="button" className="btn sm" disabled={undoable === 0} title="Undo (Ctrl+Z)" onClick={() => b.undo()}>
              Undo
            </button>
            <button type="button" className="btn sm" disabled={redoable === 0} title="Redo (Ctrl+Y)" onClick={() => b.redo()}>
              Redo
            </button>
          </div>
          <div className="row">
            <button type="button" className="btn sm" disabled={book.pages.length >= MAX_PAGES} onClick={() => b.addPage()}>
              Add page
            </button>
            <button type="button" className="btn sm" disabled={book.pages.length >= MAX_PAGES} onClick={() => b.duplicatePage()}>
              Copy page
            </button>
            <button type="button" className="btn sm" disabled={book.pages.length <= 1} onClick={() => b.deletePage()}>
              Delete page
            </button>
          </div>
          <div className="row">
            <button type="button" className="btn sm" disabled={page === 0} onClick={() => b.movePage(-1)}>
              Move earlier
            </button>
            <button type="button" className="btn sm" disabled={page >= book.pages.length - 1} onClick={() => b.movePage(1)}>
              Move later
            </button>
          </div>
          <div className="field-row">
            <label className="lbl" htmlFor="bk-bg">
              Page colour
            </label>
            <input id="bk-bg" type="color" className="bk-colour" value={cur.background.toLowerCase()} onChange={(e) => b.setPageBackground(e.target.value.toUpperCase())} />
          </div>
        </Panel>
        <Panel title="Arrangement">
          <div className="bk-layouts" role="group" aria-label="Page arrangements">
            {LAYOUTS.map((l) => (
              <button key={l.id} type="button" className="bk-layout" aria-pressed={chosen === l.id} aria-label={l.name} title={l.name} onClick={() => b.layout(l.id)}>
                <svg viewBox="0 0 40 40" width="40" height="40" aria-hidden focusable="false">
                  <rect x="0.5" y="0.5" width="39" height="39" rx="4" fill="none" stroke="currentColor" opacity="0.4" />
                  {l.photos.map((r, i) => (
                    <rect key={`p${i}`} x={r[0] * 40} y={r[1] * 40} width={r[2] * 40} height={r[3] * 40} fill="currentColor" opacity="0.75" />
                  ))}
                  {l.texts.map((r, i) => (
                    <rect key={`t${i}`} x={r[0] * 40} y={r[1] * 40 + r[3] * 16} width={r[2] * 40} height={Math.max(r[3] * 6, 1.5)} fill="currentColor" opacity="0.4" />
                  ))}
                </svg>
              </button>
            ))}
          </div>
          <button type="button" className="btn sm" disabled={cur.frames.length >= MAX_FRAMES} onClick={() => b.addText()}>
            Add text
          </button>
        </Panel>
        {frame !== null && cur.frames[frame] && <FramePanel f={cur.frames[frame]} i={frame} />}
      </div>
    </aside>
  )
}

function FramePanel({ f, i }: { f: BookFrame; i: number }) {
  const photo = useStore((s) => s.photoAt(s.active))
  const patch = (p: Partial<BookFrame>) => useBook.getState().patchFrame(i, p)
  return (
    <Panel title={f.kind === 'photo' ? 'Photo frame' : 'Text frame'}>
      {f.kind === 'photo' ? (
        <div className="stackl">
          <button type="button" className="btn sm" disabled={!photo} onClick={() => photo && useBook.getState().putPhoto(i, photo.id)}>
            Use the selected photo
          </button>
          <div className="row" role="group" aria-label="How the photo sits in the frame">
            <button type="button" className="btn sm" aria-pressed={f.fit === 'fill'} onClick={() => patch({ fit: 'fill' })}>
              Fill frame
            </button>
            <button type="button" className="btn sm" aria-pressed={f.fit === 'fit'} onClick={() => patch({ fit: 'fit' })}>
              Show whole photo
            </button>
          </div>
          {f.fit === 'fill' && (
            <>
              <SliderRow id={`bk-fx-${i}`} label="Keep more of the left or right" value={Math.round(f.focusX * 100)} min={0} max={100} step={1} digits={0} neutral={50} onLive={(v) => patch({ focusX: v / 100 })} onCommit={() => {}} onReset={() => patch({ focusX: 0.5 })} />
              <SliderRow id={`bk-fy-${i}`} label="Keep more of the top or bottom" value={Math.round(f.focusY * 100)} min={0} max={100} step={1} digits={0} neutral={50} onLive={(v) => patch({ focusY: v / 100 })} onCommit={() => {}} onReset={() => patch({ focusY: 0.5 })} />
            </>
          )}
          <button type="button" className="btn sm" disabled={f.photoId === null} onClick={() => patch({ photoId: null })}>
            Take the photo out
          </button>
        </div>
      ) : (
        <div className="stackl">
          <label className="lbl" htmlFor={`bk-t-${i}`}>
            Text
          </label>
          <textarea id={`bk-t-${i}`} className="field bk-textarea" rows={4} maxLength={2000} value={f.text} onChange={(e) => patch({ text: e.target.value })} />
          <SliderRow id={`bk-s-${i}`} label="Size (points)" value={f.sizePt} min={6} max={120} step={1} digits={0} neutral={12} onLive={(v) => patch({ sizePt: v })} onCommit={() => {}} onReset={() => patch({ sizePt: 14 })} />
          <div className="row" role="group" aria-label="Alignment">
            {(['left', 'centre', 'right'] as const).map((a) => (
              <button key={a} type="button" className="btn sm" aria-pressed={f.align === a} onClick={() => patch({ align: a })}>
                {a[0].toUpperCase() + a.slice(1)}
              </button>
            ))}
            <button type="button" className="btn sm" aria-pressed={f.bold} onClick={() => patch({ bold: !f.bold })}>
              Bold
            </button>
          </div>
          <div className="field-row">
            <label className="lbl" htmlFor={`bk-c-${i}`}>
              Text colour
            </label>
            <input id={`bk-c-${i}`} type="color" className="bk-colour" value={f.colour.toLowerCase()} onChange={(e) => patch({ colour: e.target.value.toUpperCase() })} />
          </div>
        </div>
      )}
      <button type="button" className="btn sm danger" onClick={() => useBook.getState().deleteFrame(i)}>
        Delete frame
      </button>
    </Panel>
  )
}

/** Making the PDF: where it goes, then what happened (and any photo that could not be used). */
function PdfDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const bookId = useBook((s) => s.bookId)
  const [dest, setDest] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<BookPdfResult | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  useEffect(() => {
    let off = () => {}
    void api().on<Progress>('book:progress', setProgress).then((u) => (off = u))
    return () => off()
  }, [])
  useEffect(() => {
    if (open) {
      setProgress(null)
      setError(null)
      setResult(null)
    }
  }, [open])
  const make = async () => {
    if (bookId === null || !dest) return
    setBusy(true)
    setError(null)
    try {
      setResult(await api().bookExportPdf(bookId, dest))
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="Make a PDF of the book" busy={busy}>
      <div className="form">
        <p>The book is made as a PDF with the photos as they are edited, prepared for 300 dots to the inch. A file that is already there is never replaced.</p>
        <div className="field-row">
          <span className="lbl">Save in</span>
          <button type="button" className="btn sm" disabled={busy} onClick={async () => setDest((await api().pickFolder('Choose the destination folder')) ?? dest)}>
            Choose folder…
          </button>
          <span className="path" title={dest ?? ''}>
            {dest ?? 'No folder chosen'}
          </span>
        </div>
        {busy && progress && progress.total > 0 && <ProgressBar done={progress.done} total={progress.total} label="Making the PDF" />}
        {result && (
          <div role="status">
            <p>
              Made {plural(result.pages, 'page')}: <span className="path">{result.file}</span>
            </p>
            {result.warnings.length > 0 && (
              <ul className="plain-list">
                {result.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="dialog-foot">
        <button type="button" className="btn" disabled={busy} onClick={onClose}>
          {result ? 'Close' : 'Cancel'}
        </button>
        {!result && (
          <button type="button" className="btn accent" disabled={busy || !dest} onClick={() => void make()}>
            {busy ? 'Making…' : 'Make PDF'}
          </button>
        )}
      </div>
    </Dialog>
  )
}
