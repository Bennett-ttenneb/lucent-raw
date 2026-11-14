import { useVirtualizer } from '@tanstack/react-virtual'
import { useEffect, useRef } from 'react'
import { PAGE, useStore } from '../lib/store'
import { plural } from '../lib/format'
import { Stars } from './Primitives'
import { Thumb } from './Thumb'

const SIZE = 112

export function FilmstripBar() {
  const total = useStore((s) => s.total)
  const photo = useStore((s) => s.photoAt(s.active))
  const selectedCount = useStore((s) => s.selected.size)
  const source = useStore((s) => {
    const f = s.filters
    if (f.folderId !== undefined) return s.folders.find((x) => x.id === f.folderId)?.relPath
    if (f.collectionId !== undefined) return s.collections.find((x) => x.id === f.collectionId)?.name
    if (f.keywordId !== undefined) return `Keyword: ${s.keywords.find((x) => x.id === f.keywordId)?.name ?? ''}`
    return undefined
  })
  return (
    <div className="fbar">
      <span className="fsrc" title={photo?.path}>
        {source || 'All photographs'} · {plural(total, 'photo')}
        {selectedCount > 1 ? ` · ${selectedCount} selected` : ''}
        {photo ? ` · ${photo.name}` : ''}
      </span>
      <span className="grow" />
      <Stars value={photo?.rating ?? 0} onChange={(n) => void useStore.getState().rate(n)} label="Rating of current photo" />
    </div>
  )
}

export function Filmstrip() {
  const total = useStore((s) => s.total)
  const active = useStore((s) => s.active)
  const selected = useStore((s) => s.selected)
  const pages = useStore((s) => s.pages)
  const ref = useRef<HTMLDivElement>(null)
  const v = useVirtualizer({ count: total, horizontal: true, getScrollElement: () => ref.current, estimateSize: () => SIZE, overscan: 6 })
  const items = v.getVirtualItems()
  const first = items[0]?.index ?? 0
  const last = items[items.length - 1]?.index ?? 0
  useEffect(() => {
    for (let p = Math.floor(first / PAGE); p <= Math.floor(last / PAGE); p++) void useStore.getState().ensurePage(p)
  }, [first, last, total])
  useEffect(() => {
    if (active >= 0) v.scrollToIndex(active, { align: 'center' })
  }, [active]) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div ref={ref} className="filmstrip" role="listbox" aria-label="Filmstrip" aria-orientation="horizontal">
      <div style={{ width: v.getTotalSize(), height: '100%', position: 'relative' }}>
        {items.map((it) => {
          const p = pages[Math.floor(it.index / PAGE)]?.[it.index % PAGE]
          return (
            <button
              key={it.key}
              role="option"
              type="button"
              tabIndex={it.index === Math.max(active, 0) ? 0 : -1}
              aria-selected={p ? selected.has(p.id) || it.index === active : false}
              data-active={it.index === active}
              className="fcell"
              draggable={!!p}
              onDragStart={(e) => p && e.dataTransfer.setData('application/x-lumora-photo', String(p.id))}
              style={{ transform: `translateX(${it.start}px)`, width: SIZE }}
              aria-label={p ? p.name : 'Loading'}
              onClick={() => useStore.getState().clickIndex(it.index, 'single')}
            >
              <span className="n" aria-hidden>
                {it.index + 1}
              </span>
              {p ? <Thumb photo={p} className="cell-img" /> : <span className="ph ph-wait" aria-hidden />}
            </button>
          )
        })}
      </div>
    </div>
  )
}
