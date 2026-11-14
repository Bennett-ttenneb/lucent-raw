import { useEffect, useRef, useState } from 'react'
import { findClipping, shareText, useClipPrefs } from '../lib/clipping'
import type { Box } from './Masks'

/**
 * Over the fitted picture: red where the highlights are blown (no detail left) and blue where the shadows are crushed,
 * with how much of the picture each takes. It looks at the picture as it is on screen, so it follows every edit.
 * The levels that count as clipped, and colouring by channel, are set in the small panel beside the badge.
 */
export function ClippingOverlay({ box, img }: { box: Box; img: HTMLImageElement }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [stats, setStats] = useState<{ blown: number; crushed: number } | null>(null)
  const { byChannel, hi, lo } = useClipPrefs()
  useEffect(() => {
    const cv = canvas.current
    if (!cv || !img.naturalWidth) return
    try {
      // a small copy is enough to see where the trouble is, and quick to go through
      const k = Math.min(1, 700 / Math.max(img.naturalWidth, img.naturalHeight))
      const [w, h] = [Math.max(1, Math.round(img.naturalWidth * k)), Math.max(1, Math.round(img.naturalHeight * k))]
      const off = document.createElement('canvas')
      off.width = w
      off.height = h
      const octx = off.getContext('2d', { willReadFrequently: true })!
      octx.drawImage(img, 0, 0, w, h)
      const found = findClipping(octx.getImageData(0, 0, w, h).data, hi, lo, byChannel)
      cv.width = w
      cv.height = h
      cv.getContext('2d')!.putImageData(new ImageData(found.overlay, w, h), 0, 0)
      setStats({ blown: found.blown, crushed: found.crushed })
    } catch {
      setStats(null) // a picture the browser will not let us read
    }
  }, [img, byChannel, hi, lo])
  const set = useClipPrefs.getState().set
  return (
    <>
      <canvas ref={canvas} className="clip-layer" style={{ left: box.left, top: box.top, width: box.w, height: box.h }} aria-hidden />
      <span className="badge-before clip-badge" role="status" title="Red: highlights with no detail left. Blue: shadows with no detail left.">
        {stats ? `Blown highlights (${byChannel ? 'by colour' : 'red'}) ${shareText(stats.blown)} · Crushed shadows (${byChannel ? 'by colour' : 'blue'}) ${shareText(stats.crushed)}` : 'Clipping cannot be shown for this picture'}
      </span>
      <div className="clip-controls" role="group" aria-label="Clipping warning settings" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()} onDoubleClick={(e) => e.stopPropagation()}>
        <label className="inline">
          <input type="checkbox" checked={byChannel} onChange={(e) => set({ byChannel: e.target.checked })} /> By colour channel
        </label>
        <label className="inline">
          Blown from
          <input type="number" aria-label="Blown from level" min={200} max={255} value={hi} onChange={(e) => set({ hi: Math.min(255, Math.max(200, Math.round(Number(e.target.value) || 255))) })} />
        </label>
        <label className="inline">
          Crushed to
          <input type="number" aria-label="Crushed to level" min={0} max={55} value={lo} onChange={(e) => set({ lo: Math.min(55, Math.max(0, Math.round(Number(e.target.value) || 0))) })} />
        </label>
      </div>
    </>
  )
}