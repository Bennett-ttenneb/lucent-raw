import { useStore } from '../lib/store'
import { exposureLine } from '../lib/format'
import { Thumb } from './Thumb'

export function Loupe() {
  const active = useStore((s) => s.active)
  const photo = useStore((s) => s.photoAt(s.active))
  const total = useStore((s) => s.total)
  useStore((s) => s.pages) // re-render when the page arrives
  if (!photo || active < 0) {
    return (
      <div className="empty" role="status">
        <h2>No photo selected</h2>
        <p>Pick one in the grid, then press E.</p>
      </div>
    )
  }
  return (
    <div className="loupe" onDoubleClick={() => useStore.setState({ view: 'grid' })}>
      <Thumb photo={photo} level="standard" className="loupe-img" />
      <div className="overlay" aria-hidden>
        {photo.name}
        <small>{exposureLine(photo)}</small>
      </div>
      <p className="sr">{`${photo.name}, ${active + 1} of ${total}`}</p>
    </div>
  )
}
