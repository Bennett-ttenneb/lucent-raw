import type { ReactNode } from 'react'
import { BASIC_GROUPS, cropIsDefault, detailIsDefault, effectsIsDefault, lensIsDefault, mixerIsDefault, transformIsDefault, useDevelop } from '../lib/develop'
import { solo, usePanels } from '../lib/panels'
import { DEFAULT_RECIPE, type Recipe } from '../lib/types'

interface Tool {
  title: string // the panel it goes to
  label: string
  icon: ReactNode
  /** whether the photo has edits in this panel's settings (the dot under the icon) */
  edited: (r: Recipe) => boolean
}

const svg = (children: ReactNode) => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
    {children}
  </svg>
)

const TOOLS: Tool[] = [
  { title: 'Masks', label: 'Masks', icon: svg(<><circle cx="12" cy="12" r="8" strokeDasharray="2.5 3" /><circle cx="12" cy="12" r="3.2" /></>), edited: (r) => r.masks.length > 0 },
  { title: 'Basic', label: 'Basic', icon: svg(<><path d="M4 7h9M17 7h3M4 17h3M11 17h9M4 12h13M21 12h-0.5" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="17" r="2" /></>), edited: (r) => BASIC_GROUPS.some((g) => g.sliders.some((d) => r[d.key] !== 0)) },
  { title: 'Tone curve', label: 'Tone curve', icon: svg(<path d="M4 20 C9 20 8 6 20 4" />), edited: (r) => r.curve.length > 0 },
  { title: 'Colour mixer', label: 'Colour mixer', icon: svg(<><circle cx="9" cy="10" r="5" /><circle cx="15" cy="10" r="5" /><circle cx="12" cy="15" r="5" /></>), edited: (r) => !mixerIsDefault(r) },
  { title: 'Colour grading', label: 'Colour grading', icon: svg(<><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="8" r="1.6" fill="currentColor" /><circle cx="8" cy="14.5" r="1.6" fill="currentColor" /><circle cx="16" cy="14.5" r="1.6" fill="currentColor" /></>), edited: (r) => JSON.stringify(r.grading ?? null) !== JSON.stringify(DEFAULT_RECIPE.grading) },
  { title: 'Detail', label: 'Detail', icon: svg(<path d="M12 3 L21 20 H3 Z M12 9 L16 17 H8 Z" />), edited: (r) => !detailIsDefault(r) },
  { title: 'Effects', label: 'Effects', icon: svg(<><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="4" /></>), edited: (r) => !effectsIsDefault(r) },
  { title: 'Lens corrections', label: 'Lens corrections', icon: svg(<><circle cx="12" cy="12" r="8.5" /><circle cx="12" cy="12" r="3" /><path d="M12 3.5v3M12 17.5v3M3.5 12h3M17.5 12h3" /></>), edited: (r) => !lensIsDefault(r) },
  { title: 'Transform', label: 'Transform', icon: svg(<path d="M5 6h14l2 12H3Z" />), edited: (r) => !transformIsDefault(r) },
  { title: 'Crop and straighten', label: 'Crop and straighten', icon: svg(<><path d="M7 3v14h14" /><path d="M3 7h14v14" /></>), edited: (r) => !cropIsDefault(r.crop) },
  { title: 'Enlarge', label: 'Enlarge', icon: svg(<><path d="M4 14v6h6M20 10V4h-6M4 20 11 13M20 4l-7 7" /></>), edited: () => false },
]

/**
 * A row of icons at the top of the Develop column, one for each panel below it. Pressing one opens that panel, closes the others
 * and moves the view to it; Shift-click opens it and leaves the others as they are. A dot under an icon means the photo has
 * changes in that panel, and an icon that is lit means its panel is open.
 */
export function ToolStrip() {
  const recipe = useDevelop((s) => s.recipe)
  const open = usePanels((s) => s.open)
  const go = (title: string, keepOthers: boolean) => {
    const col = document.querySelector('aside.side.right')
    const titles = col ? Array.from(col.querySelectorAll<HTMLElement>('section.panel[data-title]')).map((p) => p.dataset.title!) : []
    if (keepOthers) usePanels.getState().set(title, true)
    else usePanels.getState().setMany(solo(titles, title))
    requestAnimationFrame(() => {
      const section = col?.querySelector<HTMLElement>(`section.panel[data-title="${CSS.escape(title)}"]`)
      section?.scrollIntoView({ block: 'start' })
      section?.querySelector<HTMLElement>('.phead-btn')?.focus({ preventScroll: true })
    })
  }
  return (
    <div className="tool-strip" role="toolbar" aria-label="Go to a panel">
      {TOOLS.map((t) => {
        const isOpen = open[t.title] ?? (t.title !== 'Enlarge')
        const dot = t.edited(recipe)
        return (
          <button key={t.title} type="button" className="tool-btn" aria-label={`Go to ${t.label}`} aria-pressed={isOpen} data-edited={dot || undefined} title={`${t.label}${dot ? ' (changed)' : ''}. Shift-click keeps the other panels open.`} onClick={(e) => go(t.title, e.shiftKey)}>
            {t.icon}
          </button>
        )
      })}
    </div>
  )
}
