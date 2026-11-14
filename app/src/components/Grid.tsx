import { useVirtualizer } from '@tanstack/react-virtual'
import { hasFilter } from '../lib/filters'
import { useEffect, useRef, useState } from 'react'
import { PAGE, useStore } from '../lib/store'
import { plural } from '../lib/format'
import type { Photo } from '../lib/types'
import { Thumb } from './Thumb'

/** "2026-10-19 · ISO 200 · f/2.8 · 1/250 s": what is known of the photo, for the cell's second row. */
export function cellDetail(p: Photo): string {
  const parts = [
    p.captured ? p.captured.slice(0, 10) : null,
    p.iso ? `ISO ${p.iso}` : null,
    p.aperture ? `f/${p.aperture}` : null,
    p.shutterS ? (p.shutterS >= 1 ? `${p.shutterS} s` : `1/${Math.round(1 / p.shutterS)} s`) : null,
  ]
  return parts.filter(Boolean).join(' · ')
}

export function Grid() {
  const total = useStore((s) => s.total)
  const thumbSize = useStore((s) => s.thumbSize)
  const active = useStore((s) => s.active)
  const selected = useStore((s) => s.selected)
  const pages = useStore((s) => s.pages)
  const loaded = useStore((s) => s.loaded)
  const filtered = useStore((s) => hasFilter(s.filters))
  const vo = useStore((s) => s.viewOptions)
  const hostRef = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(900)

  useEffect(() => {
    const el = hostRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  const cols = Math.max(1, Math.floor(width / thumbSize))
  const cell = width / cols
  const rowCount = Math.ceil(total / cols)
  useEffect(() => useStore.setState({ cols }), [cols])

  const v = useVirtualizer({ count: rowCount, getScrollElement: () => hostRef.current, estimateSize: () => cell, overscan: 3 })
  useEffect(() => v.measure(), [cell]) // eslint-disable-line react-hooks/exhaustive-deps

  const items = v.getVirtualItems()
  const first = items[0]?.index ?? 0
  const last = items[items.length - 1]?.index ?? 0
  useEffect(() => {
    const p0 = Math.floor((first * cols) / PAGE)
    const p1 = Math.floor(((last + 1) * cols) / PAGE)
    for (let p = p0; p <= p1; p++) void useStore.getState().ensurePage(p)
  }, [first, last, cols, total])

  useEffect(() => {
    if (active >= 0) v.scrollToIndex(Math.floor(active / cols), { align: 'auto' })
  }, [active, cols]) // eslint-disable-line react-hooks/exhaustive-deps

  if (loaded && total === 0) {
    return (
      <div className="empty" role="status">
        <h2>{filtered ? 'Nothing matches these filters' : 'Your library is empty'}</h2>
        <p>{filtered ? 'Loosen a filter or choose None to see every photo.' : 'Bring in a folder of photos to get started.'}</p>
        {!filtered && (
          <button className="btn accent" onClick={() => useStore.setState({ importOpen: true })}>
            Import photos…
          </button>
        )}
      </div>
    )
  }

  return (
    <div ref={hostRef} className="grid-host" data-hide-index={!vo.index || undefined} data-hide-badges={!vo.badges || undefined} data-hide-labels={!vo.labels || undefined} role="grid" aria-label={`Photo grid, ${plural(total, 'photo')}`} aria-rowcount={rowCount} aria-multiselectable>
      <div style={{ height: v.getTotalSize(), position: 'relative' }}>
        {items.map((row) => (
          <div key={row.key} role="row" className="grid-row" style={{ transform: `translateY(${row.start}px)`, height: cell }}>
            {Array.from({ length: cols }, (_, c) => {
              const i = row.index * cols + c
              if (i >= total) return null
              const p = pages[Math.floor(i / PAGE)]?.[i % PAGE]
              const sel = p ? selected.has(p.id) : false
              return (
                <button
                  key={i}
                  role="gridcell"
                  type="button"
                  tabIndex={i === Math.max(active, 0) ? 0 : -1}
                  aria-selected={sel}
                  data-active={i === active}
                  data-label={p?.label ?? undefined}
                  data-flag={p?.flag || undefined}
                  className="cell"
                  style={{ width: cell }}
                  aria-label={p ? `${p.name}, ${p.rating} stars${p.flag === 1 ? ', pick' : p.flag === -1 ? ', reject' : ''}${p.stackId !== null && p.stackCount > 1 ? `, stack of ${p.stackCount}${p.stackCollapsed ? ' (closed)' : ''}` : ''}` : 'Loading'}
                  onClick={(e) => useStore.getState().clickIndex(i, e.shiftKey ? 'range' : e.ctrlKey || e.metaKey ? 'toggle' : 'single')}
                  onDoubleClick={() => {
                    useStore.getState().clickIndex(i, 'single')
                    useStore.setState({ view: 'loupe' })
                  }}
                >
                  <span className="n" aria-hidden>
                    {i + 1}
                  </span>
                  {p ? <Thumb photo={p} className="cell-img" /> : <span className="ph ph-wait" aria-hidden />}
                  {p && (vo.names || vo.details) && (
                    <span className="cell-info" aria-hidden>
                      {vo.names && <span className="cell-name">{p.name}</span>}
                      {vo.details && <span className="cell-detail">{cellDetail(p)}</span>}
                    </span>
                  )}
                  {p && (
                    <span className="cell-meta" aria-hidden>
                      {p.flag === 1 && <b className="flag pick">P</b>}
                      {p.flag === -1 && <b className="flag rej">X</b>}
                      {p.rating > 0 && <span className="cell-stars">{'★'.repeat(p.rating)}</span>}
                      {p.missing && <b className="flag miss">! missing</b>}
                      {p.edited && <b className="flag edit">edited</b>}
                      {p.copyName && <b className="flag copy">{p.copyName}</b>}
                      {p.stackId !== null && p.stackCount > 1 && (
                        <b className="flag stack" title={p.stackCollapsed ? 'A closed stack: S opens it' : p.stackPos === 0 ? 'The top of an open stack: S closes it' : 'In an open stack'}>
                          {p.stackPos + 1}/{p.stackCount} stack
                        </b>
                      )}
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        ))}
      </div>
    </div>
  )
}
