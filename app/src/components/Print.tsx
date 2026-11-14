import { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { api } from '../lib/api'
import { plural } from '../lib/format'
import { usePreviewKey, useStore } from '../lib/store'
import { DEFAULT_PRINT, PAPERS, paginate, sheetSize, type PrintSetup } from '../lib/printlayout'
import type { Photo } from '../lib/types'

const KEY = 'lucent.print'
const loadSetup = (): PrintSetup => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<PrintSetup> | null
    return { ...DEFAULT_PRINT, ...(v ?? {}) }
  } catch {
    return DEFAULT_PRINT
  }
}

function Cell({ photo, setup }: { photo: Photo; setup: PrintSetup }) {
  const key = usePreviewKey(photo.id)
  return (
    <figure className="print-cell">
      {photo.previewable && <img src={api().previewUrl(photo.id, 'standard', key)} alt="" style={{ objectFit: setup.fill ? 'cover' : 'contain' }} />}
      {setup.captions && <figcaption>{photo.name}</figcaption>}
    </figure>
  )
}

function Sheets({ pages, setup }: { pages: Photo[][]; setup: PrintSetup }) {
  const [w, h] = sheetSize(setup)
  return (
    <>
      {pages.map((page, i) => (
        <section key={i} className="print-sheet" aria-label={`Page ${i + 1}`} style={{ width: `${w}mm`, height: `${h}mm`, padding: `${setup.margin}mm`, gap: `${setup.gap}mm`, gridTemplateColumns: `repeat(${setup.cols}, 1fr)`, gridTemplateRows: `repeat(${setup.rows}, 1fr)` }}>
          {page.map((p, j) => (
            <Cell key={j} photo={p} setup={setup} />
          ))}
        </section>
      ))}
    </>
  )
}

/** Print: the selected photos laid out on pages (one to a page, or several), previewed, then sent to the printer or to a PDF printer. */
export function PrintModule() {
  const [setup, setSetup] = useState<PrintSetup>(loadSetup)
  const selected = useStore((s) => s.selected)
  const activeId = useStore((s) => s.photoAt(s.active)?.id)
  const pages = useStore((s) => s.pages)
  const total = useStore((s) => s.total)
  const set = (patch: Partial<PrintSetup>) => {
    const next = { ...setup, ...patch }
    setSetup(next)
    try {
      localStorage.setItem(KEY, JSON.stringify(next))
    } catch {
      /* the choice lasts for this session */
    }
  }
  const photos = useMemo(() => {
    const all = Object.keys(pages).map(Number).sort((a, b) => a - b).flatMap((k) => pages[k])
    const ids = selected.size ? selected : activeId !== undefined ? new Set([activeId]) : new Set<number>()
    return all.filter((p) => ids.has(p.id))
  }, [pages, selected, activeId])
  const sheets = useMemo(() => paginate(photos, setup), [photos, setup])
  const [w, h] = sheetSize(setup)
  // the page size for the printer, and a root outside the window that only the printer sees
  useEffect(() => {
    const style = document.createElement('style')
    style.id = 'print-page-size'
    style.textContent = `@page { size: ${w}mm ${h}mm; margin: 0 }`
    document.head.appendChild(style)
    return () => style.remove()
  }, [w, h])
  // fit the page to the pane: one page shows whole, several fit by width and scroll
  const pane = useRef<HTMLElement>(null)
  const [room, setRoom] = useState({ w: 520, h: 600 })
  useEffect(() => {
    const el = pane.current
    if (!el) return
    const look = () => setRoom({ w: el.clientWidth - 24, h: el.clientHeight - 56 })
    look()
    const ro = new ResizeObserver(look)
    ro.observe(el)
    return () => ro.disconnect()
  }, [photos.length])
  const pageW = w * 3.78
  const pageH = h * 3.78
  const scale = Math.max(0.1, Math.min(1, room.w / pageW, sheets.length === 1 ? room.h / pageH : 1))
  const num = (label: string, id: string, value: number, min: number, max: number, key: keyof PrintSetup, step = 1) => (
    <div className="field-row">
      <label className="lbl" htmlFor={id}>
        {label}
      </label>
      <input id={id} className="field narrow" type="number" min={min} max={max} step={step} value={value} onChange={(e) => set({ [key]: Math.min(max, Math.max(min, Number(e.target.value) || min)) } as Partial<PrintSetup>)} />
    </div>
  )
  return (
    <main className="main print-module">
      <aside className="side" aria-label="Print settings">
        <div className="side-scroll">
          <fieldset className="export-group">
            <legend>Paper</legend>
            <div className="field-row">
              <label className="lbl" htmlFor="print-paper">
                Size
              </label>
              <select id="print-paper" className="field" value={setup.paper} onChange={(e) => set({ paper: e.target.value })}>
                {PAPERS.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <div className="seg" role="group" aria-label="Orientation">
              <button type="button" aria-pressed={!setup.landscape} onClick={() => set({ landscape: false })}>
                Portrait
              </button>
              <button type="button" aria-pressed={setup.landscape} onClick={() => set({ landscape: true })}>
                Landscape
              </button>
            </div>
            {num('Margin (mm)', 'print-margin', setup.margin, 0, 50, 'margin')}
          </fieldset>
          <fieldset className="export-group">
            <legend>Layout</legend>
            {num('Photos across', 'print-cols', setup.cols, 1, 8, 'cols')}
            {num('Photos down', 'print-rows', setup.rows, 1, 10, 'rows')}
            {num('Space between (mm)', 'print-gap', setup.gap, 0, 30, 'gap')}
            {num('Copies of each', 'print-copies', setup.copies, 1, 50, 'copies')}
            <label className="check">
              <input type="checkbox" checked={setup.fill} onChange={(e) => set({ fill: e.target.checked })} /> Fill the space (the edges may be cut off)
            </label>
            <label className="check">
              <input type="checkbox" checked={setup.captions} onChange={(e) => set({ captions: e.target.checked })} /> Print the file name under each photo
            </label>
          </fieldset>
          <p className="hint">One photo to a page is 1 across and 1 down; 4 across and 5 down makes a contact sheet. Photos print from their edited previews (up to 2048 pixels on the long side), which suits sizes up to about A4. The print window offers your printers and Microsoft Print to PDF.</p>
          <button type="button" className="btn accent" disabled={sheets.length === 0} onClick={() => window.print()}>
            Print…
          </button>
        </div>
      </aside>
      <section ref={pane} className="center print-preview" aria-label="Print preview">
        {photos.length === 0 ? (
          <div className="empty" role="status">
            <h2>No photos to print</h2>
            <p>Select photos in the Library, then open Print.</p>
          </div>
        ) : (
          <>
            <p role="status" className="hint">
              {plural(photos.length, 'photo')} on {plural(sheets.length, 'page')}
              {total > 0 && photos.length === 1 ? '' : ''}
            </p>
            <div className="print-scroll">
              <div style={{ height: (pageH + 12) * sheets.length * scale }}>
              <div style={{ transform: `scale(${scale})`, transformOrigin: 'top left', width: `${w}mm` }}>
                <Sheets pages={sheets} setup={setup} />
              </div>
              </div>
            </div>
          </>
        )}
      </section>
      {createPortal(
        <div id="print-root" aria-hidden>
          <Sheets pages={sheets} setup={setup} />
        </div>,
        document.body,
      )}
    </main>
  )
}
