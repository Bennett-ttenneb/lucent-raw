import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import { useDevelop } from '../lib/develop'
import { menusFor, type MenuItem } from '../lib/menus'
import { useStore } from '../lib/store'

/**
 * The menu bar under the module tabs. Which items it offers depends on the module (Develop adds Undo, Before and Show clipping;
 * Book has its own Undo). Click a title to open it, then move with the arrow keys; Escape closes it.
 */
export function MenuBar() {
  const module = useStore((s) => s.module)
  const hasPhoto = useStore((s) => s.photoAt(s.active) !== undefined)
  const hasCopied = useDevelop((s) => s.clipboard !== null)
  const [openAt, setOpenAt] = useState<number | null>(null)
  const bar = useRef<HTMLDivElement>(null)
  const menus = menusFor(module, hasPhoto, hasCopied)

  useEffect(() => {
    if (openAt === null) return
    const away = (e: MouseEvent) => {
      if (!bar.current?.contains(e.target as Node)) setOpenAt(null)
    }
    const esc = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenAt(null)
        bar.current?.querySelectorAll<HTMLElement>('[role=menuitem][aria-haspopup]')[openAt]?.focus()
      }
    }
    window.addEventListener('mousedown', away)
    window.addEventListener('keydown', esc)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('keydown', esc)
    }
  }, [openAt])

  const titles = () => Array.from(bar.current?.querySelectorAll<HTMLElement>('[role=menuitem][aria-haspopup]') ?? [])
  const focusFirstItem = (i: number) => requestAnimationFrame(() => bar.current?.querySelectorAll<HTMLElement>(`[data-menu="${i}"] .menu-list [role=menuitem]:not([aria-disabled=true])`)[0]?.focus())

  const onTitleKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const n = menus.length
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const to = (i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n
      titles()[to]?.focus()
      if (openAt !== null) setOpenAt(to)
    } else if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setOpenAt(i)
      focusFirstItem(i)
    }
  }
  const onItemKey = (e: KeyboardEvent<HTMLElement>, i: number) => {
    const items = Array.from(bar.current?.querySelectorAll<HTMLElement>(`[data-menu="${i}"] .menu-list [role=menuitem]:not([aria-disabled=true])`) ?? [])
    const at = items.indexOf(e.currentTarget)
    if (e.key === 'ArrowDown') (e.preventDefault(), items[(at + 1) % items.length]?.focus())
    else if (e.key === 'ArrowUp') (e.preventDefault(), items[(at + items.length - 1) % items.length]?.focus())
    else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault()
      const to = (i + (e.key === 'ArrowRight' ? 1 : menus.length - 1)) % menus.length
      setOpenAt(to)
      focusFirstItem(to)
    }
  }
  const choose = (item: MenuItem) => {
    if (item.disabled) return
    setOpenAt(null)
    item.run()
  }

  return (
    <nav className="menubar" aria-label="Menus">
    <div className="menubar-in" role="menubar" aria-label="Menu" ref={bar}>
      {menus.map((m, i) => (
        <div className="menu" key={m.title} data-menu={i}>
          <button
            type="button"
            role="menuitem"
            aria-haspopup="menu"
            aria-expanded={openAt === i}
            className={openAt === i ? 'on' : ''}
            onClick={() => setOpenAt(openAt === i ? null : i)}
            onMouseEnter={() => openAt !== null && setOpenAt(i)}
            onKeyDown={(e) => onTitleKey(e, i)}
          >
            {m.title}
          </button>
          {openAt === i && (
            <div className="menu-list" role="menu" aria-label={m.title}>
              {m.items.map((it, k) =>
                it === 'line' ? (
                  <hr key={k} role="separator" />
                ) : (
                  <button
                    key={it.label}
                    type="button"
                    role="menuitem"
                    aria-disabled={it.disabled ? true : undefined}
                    title={it.disabled}
                    onClick={() => choose(it)}
                    onKeyDown={(e) => onItemKey(e, i)}
                  >
                    <span>{it.label}</span>
                    {it.keys && <kbd>{it.keys}</kbd>}
                  </button>
                ),
              )}
            </div>
          )}
        </div>
      ))}
    </div>
    </nav>
  )
}
