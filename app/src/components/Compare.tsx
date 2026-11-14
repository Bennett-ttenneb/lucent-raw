import { useStore } from '../lib/store'
import { exposureLine } from '../lib/format'
import { Thumb } from './Thumb'

/** Compare: the Select on the left stays, the Candidate on the right is the open photo; the arrow keys and the filmstrip change the Candidate. */
export function Compare() {
  const select = useStore((s) => s.compareSelect)
  const cand = useStore((s) => s.photoAt(s.active))
  const active = useStore((s) => s.active)
  const total = useStore((s) => s.total)
  const pages = useStore((s) => s.pages)
  const picked = select === null ? undefined : Object.values(pages).flat().find((p) => p.id === select)
  if (!picked || !cand) {
    return (
      <div className="empty" role="status">
        <h2>Nothing to compare</h2>
        <p>Open a photo, then press C: it becomes the Select, and the next photo is the Candidate.</p>
      </div>
    )
  }
  const pane = (role: 'Select' | 'Candidate', p: typeof cand) => (
    <figure className={`compare-pane ${role === 'Select' ? 'is-select' : 'is-candidate'}`} aria-label={`${role}: ${p.name}`}>
      <Thumb photo={p} level="standard" className="loupe-img" />
      <figcaption className="overlay" aria-hidden>
        {role}: {p.name}
        <small>{exposureLine(p)}</small>
      </figcaption>
    </figure>
  )
  return (
    <div className="compare" role="group" aria-label="Compare">
      <div className="compare-panes">
        {pane('Select', picked)}
        {pane('Candidate', cand)}
      </div>
      <div className="compare-bar">
        <button className="btn sm" onClick={() => useStore.getState().compareSwap()} title="Swap the Select and the Candidate">
          Swap
        </button>
        <button className="btn sm" onClick={() => useStore.getState().compareMakeSelect()} title="Keep the Candidate as the Select and look at the next photo">
          Make Candidate the Select
        </button>
        <button
          className="btn sm accent"
          onClick={() => {
            const at = useStore.getState().indexOfId(picked.id)
            if (at >= 0) useStore.getState().clickIndex(at, 'single')
            useStore.setState({ view: 'loupe' })
          }}
        >
          Done
        </button>
        <span className="sr">{`Candidate ${active + 1} of ${total}`}</span>
      </div>
    </div>
  )
}
