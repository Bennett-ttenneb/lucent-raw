import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { SecondShow } from '../lib/second'

/** The second window: the main window's open photo, big and plain, for a second screen. It asks for nothing and changes nothing. */
export function SecondWindow() {
  const [show, setShow] = useState<SecondShow | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    document.title = 'Lucent Raw: second window'
    let off = () => {}
    void api()
      .on<SecondShow>('second:show', (s) => (setShow(s), setFailed(false)))
      .then((u) => (off = u))
    return () => off()
  }, [])
  return (
    <main className="second" aria-label="Second window">
      {show?.id != null && !failed ? (
        <img className="second-img" src={api().previewUrl(show.id, 'standard', show.key)} alt={show.label} onError={() => setFailed(true)} draggable={false} />
      ) : (
        <p className="second-note" role="status">
          {failed ? 'This photo has no picture yet.' : 'Open a photo in the main window and it appears here.'}
        </p>
      )}
      {show?.id != null && (
        <div className="second-label" aria-hidden>
          {show.label}
        </div>
      )}
    </main>
  )
}
