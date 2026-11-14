import { useEffect, useId, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { useDevelop } from '../lib/develop'
import { PANEL_EYES } from '../lib/panelEyes'
import { neighbour, solo, usePanels } from '../lib/panels'
import { useStore } from '../lib/store'
import { LABELS, type Flag, type Label } from '../lib/types'

export function Panel({ title, children, defaultOpen = true, action }: { title: string; children: ReactNode; defaultOpen?: boolean; action?: ReactNode }) {
  // open or closed is remembered by title between launches (lib/panels.ts), and the number keys and Alt+click use the same state
  const open = usePanels((s) => s.open[title] ?? defaultOpen)
  const id = useId()
  // the Develop panels have an eye that switches their settings off for viewing
  const inDevelop = useStore((s) => s.module === 'develop')
  const eyeId = inDevelop ? PANEL_EYES[title] : undefined
  const eyeOff = useDevelop((s) => (eyeId ? s.panelsOff.includes(eyeId) : false))
  const onClick = (e: MouseEvent<HTMLButtonElement>) => {
    const section = e.currentTarget.closest('section.panel')
    const column = section?.closest('aside.side')
    if (e.altKey && column) {
      // Alt+click: this panel opens and every other one in its column closes
      const titles = Array.from(column.querySelectorAll<HTMLElement>('section.panel[data-title]')).map((p) => p.dataset.title!)
      usePanels.getState().setMany(solo(titles, title))
      return
    }
    if (usePanels.getState().soloMode && !open && column) {
      // solo mode: opening one closes the rest of its column
      const titles = Array.from(column.querySelectorAll<HTMLElement>('section.panel[data-title]')).map((p) => p.dataset.title!)
      usePanels.getState().setMany(solo(titles, title))
      return
    }
    usePanels.getState().set(title, !open)
  }
  const [menu, setMenu] = useState<{ x: number; y: number; titles: string[] } | null>(null)
  const onContextMenu = (e: MouseEvent<HTMLButtonElement>) => {
    const column = e.currentTarget.closest('aside.side')
    if (!column) return
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY, titles: Array.from(column.querySelectorAll<HTMLElement>('section.panel[data-title]')).map((p) => p.dataset.title!) })
  }
  useEffect(() => {
    if (!menu) return
    const off = () => setMenu(null)
    const esc = (e: globalThis.KeyboardEvent) => e.key === 'Escape' && off()
    window.addEventListener('click', off)
    window.addEventListener('blur', off)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('click', off)
      window.removeEventListener('blur', off)
      window.removeEventListener('keydown', esc)
    }
  }, [menu])
  const soloMode = usePanels((s) => s.soloMode)
  const onKeyDown = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return
    const column = e.currentTarget.closest('aside.side')
    if (!column) return
    const heads = Array.from(column.querySelectorAll<HTMLElement>('section.panel[data-title] .phead-btn'))
    const next = neighbour(heads, e.currentTarget, e.key)
    if (next) {
      e.preventDefault()
      e.stopPropagation()
      next.focus()
    }
  }
  return (
    <section className="panel" data-title={title}>
      <div className="phead">
        <button type="button" className="phead-btn" aria-expanded={open} aria-controls={id} onClick={onClick} onKeyDown={onKeyDown} onContextMenu={onContextMenu} title="Open or close. Alt+click: open only this one. Right-click for solo mode, open all and close all. Hold Alt to see the number keys.">
          <span className="tri" aria-hidden />
          <span className="grow">{title}</span>
        </button>
        {eyeId && (
          <button type="button" className="panel-eye" aria-pressed={!eyeOff} aria-label="Switch this panel's settings on or off" title={eyeOff ? `${title} is switched off (its settings are kept). Click to switch it on.` : `Switch ${title} off to see the picture without it. Its settings are kept.`} onClick={() => useDevelop.getState().togglePanel(eyeId)}>
            <svg viewBox="0 0 16 10" width="16" height="10" aria-hidden>
              <path d="M1 5C3 2 5.5 1 8 1s5 1 7 4c-2 3-4.500 4-7 4S3 8 1 5z" fill="none" stroke="currentColor" strokeWidth="1.2" />
              <circle cx="8" cy="5" r="1.800" fill="currentColor" />
              {eyeOff && <path d="M2 9L14 1" stroke="currentColor" strokeWidth="1.400" />}
            </svg>
          </button>
        )}
        {action}
      </div>
      {menu && (
        <div className="panel-menu" role="menu" aria-label={`${title} panel options`} style={{ left: menu.x, top: menu.y }}>
          <button type="button" role="menuitemcheckbox" aria-checked={soloMode} onClick={() => usePanels.getState().setSoloMode(!soloMode)}>
            Solo mode{soloMode ? ' ✓' : ''}
          </button>
          <button type="button" role="menuitem" onClick={() => usePanels.getState().setMany(Object.fromEntries(menu.titles.map((t) => [t, true])))}>
            Open all panels
          </button>
          <button type="button" role="menuitem" onClick={() => usePanels.getState().setMany(Object.fromEntries(menu.titles.map((t) => [t, false])))}>
            Close all panels
          </button>
        </div>
      )}
      <div id={id} className="pbody" hidden={!open}>
        {children}
      </div>
    </section>
  )
}

export function Stars({ value, onChange, label = 'Rating' }: { value: number; onChange: (n: number) => void; label?: string }) {
  return (
    <div className="stars" role="radiogroup" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          role="radio"
          aria-checked={value === n}
          aria-label={`${n} ${n === 1 ? 'star' : 'stars'}`}
          className={n <= value ? 'on' : ''}
          onClick={() => onChange(n)}
        >
          ★
        </button>
      ))}
    </div>
  )
}

const LABEL_LETTER: Record<Label, string> = { red: 'R', yellow: 'Y', green: 'G', blue: 'B', purple: 'P' }

export function LabelChips({ value, onChange }: { value: Label | null; onChange: (l: Label | null) => void }) {
  return (
    <div className="chips" role="group" aria-label="Colour label">
      {LABELS.map((l) => (
        <button
          key={l}
          type="button"
          className="chip"
          style={{ background: `var(--color-label-${l})` }}
          aria-pressed={value === l}
          aria-label={`${l} label`}
          onClick={() => onChange(value === l ? null : l)}
        >
          {LABEL_LETTER[l]}
        </button>
      ))}
    </div>
  )
}

export function FlagButtons({ value, onChange }: { value: Flag; onChange: (f: Flag) => void }) {
  return (
    <div className="row" role="group" aria-label="Flag">
      <button type="button" className="btn sm" aria-pressed={value === 1} onClick={() => onChange(1)}>
        Pick
      </button>
      <button type="button" className="btn sm danger" aria-pressed={value === -1} onClick={() => onChange(-1)}>
        Reject
      </button>
    </div>
  )
}

/** Native <dialog>: focus trap, Esc to close and inert background come for free. */
export function Dialog({ open, onClose, title, children, busy = false, wide = false, xl = false }: { open: boolean; onClose: () => void; title: string; children: ReactNode; busy?: boolean; wide?: boolean; xl?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog
      ref={ref}
      className={xl ? 'dialog wide xl' : wide ? 'dialog wide' : 'dialog'}
      aria-labelledby={titleId}
      onCancel={(e) => {
        if (busy) e.preventDefault()
        else onClose()
      }}
      onClose={() => open && !busy && onClose()}
    >
      {open && (
        <div className="dialog-body">
          <h2 id={titleId}>{title}</h2>
          {children}
        </div>
      )}
    </dialog>
  )
}

export function ProgressBar({ done, total, label }: { done: number; total: number; label: string }) {
  const pct = total ? Math.round((done / total) * 100) : 0
  return (
    <div className="progress" role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
      <i style={{ width: `${pct}%` }} />
    </div>
  )
}
