import { useStore } from '../lib/store'
import { exposureLine } from '../lib/format'
import { Thumb } from './Thumb'

const LIMIT_WITHOUT_SELECTION = 6

/** Survey: the selected photos side by side (or, with fewer than two selected, the open photo and the ones after it). */
export function Survey() {
  const selected = useStore((s) => s.selected)
  const active = useStore((s) => s.active)
  const total = useStore((s) => s.total)
  const pages = useStore((s) => s.pages)
  const all = Object.keys(pages)
    .map(Number)
    .sort((a, b) => a - b)
    .flatMap((k) => pages[k])
  const chosen = selected.size >= 2 ? all.filter((p) => selected.has(p.id)) : useStore.getState().photoAt(active) ? all.slice(Math.max(active, 0), Math.max(active, 0) + LIMIT_WITHOUT_SELECTION) : []
  if (chosen.length === 0) {
    return (
      <div className="empty" role="status">
        <h2>No photos to survey</h2>
        <p>Select two or more photos in the grid, then press N.</p>
      </div>
    )
  }
  const cols = chosen.length <= 2 ? chosen.length : Math.ceil(Math.sqrt(chosen.length * 1.6))
  const activeId = useStore.getState().photoAt(active)?.id
  return (
    <div className="survey" role="group" aria-label="Survey" style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}>
      {chosen.map((p) => (
        <figure key={p.id} className={`survey-cell${p.id === activeId ? ' on' : ''}`} aria-label={p.name} onClick={() => useStore.getState().clickIndex(useStore.getState().indexOfId(p.id), 'single')}>
          <Thumb photo={p} level="standard" className="loupe-img" />
          <figcaption className="overlay" aria-hidden>
            {p.name}
            <small>{exposureLine(p)}</small>
          </figcaption>
          {selected.size >= 2 && (
            <button
              className="btn sm survey-x"
              aria-label={`Remove ${p.name} from the survey`}
              onClick={(e) => {
                e.stopPropagation()
                const next = new Set(selected)
                next.delete(p.id)
                useStore.setState({ selected: next })
              }}
            >
              ✕
            </button>
          )}
        </figure>
      ))}
      <p className="sr">{`${chosen.length} photos shown, ${total} in the grid`}</p>
    </div>
  )
}
