import { useRef } from 'react'
import { api } from '../lib/api'
import { useDevelop } from '../lib/develop'
import { Panel } from './Primitives'

/**
 * A small picture of the photo with a frame on the part shown at 100%. Click or drag on it to move the view; when the
 * picture is fitted, a click goes to 100% at that spot. The arrow keys move the view by a tenth of its size.
 */
export function NavigatorPanel() {
  const photoId = useDevelop((s) => s.photoId)
  const saved = useDevelop((s) => s.saved) // not the live recipe: the little picture stays still while a slider moves
  const version = useDevelop((s) => s.version)
  const zoom = useDevelop((s) => s.zoom)
  const dragging = useRef(false)
  const at = (e: React.PointerEvent<HTMLButtonElement>): [number, number] => {
    const r = e.currentTarget.getBoundingClientRect()
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))]
  }
  const view = zoom.on && zoom.width > 0 ? { left: ((zoom.cx - zoom.vw / 2) / zoom.width) * 100, top: ((zoom.cy - zoom.vh / 2) / zoom.height) * 100, width: Math.min(100, (zoom.vw / zoom.width) * 100), height: Math.min(100, (zoom.vh / zoom.height) * 100) } : null
  return (
    <Panel title="Navigator">
      {photoId === null ? (
        <p className="hint">No photo open.</p>
      ) : (
        <>
          <button
            type="button"
            className="navigator"
            aria-label="Picture map: click or drag to move the view, arrow keys to step"
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.currentTarget.setPointerCapture(e.pointerId)
              const [fx, fy] = at(e)
              if (zoom.on) {
                dragging.current = true
                useDevelop.getState().panTo(fx, fy)
              } else void useDevelop.getState().zoomIn(fx, fy)
            }}
            onPointerMove={(e) => dragging.current && useDevelop.getState().panTo(...at(e))}
            onPointerUp={() => (dragging.current = false)}
            onPointerCancel={() => (dragging.current = false)}
            onKeyDown={(e) => {
              const steps: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }
              const d = steps[e.key] ?? [0, 0]
              if (!zoom.on || (!d[0] && !d[1])) return
              e.preventDefault()
              e.stopPropagation() // the arrow keys also step to the next photo
              useDevelop.getState().panBy((d[0] * zoom.vw) / 10, (d[1] * zoom.vh) / 10)
            }}
          >
            <img src={api().renderUrl(photoId, saved, version, 240)} alt="" draggable={false} />
            {view && <span className="nav-view" style={{ left: `${view.left}%`, top: `${view.top}%`, width: `${view.width}%`, height: `${view.height}%` }} />}
          </button>
          <p className="hint">{zoom.on ? 'Drag the frame, or use the arrow keys, to move around.' : 'Click the picture to zoom in there.'}</p>
        </>
      )}
    </Panel>
  )
}
