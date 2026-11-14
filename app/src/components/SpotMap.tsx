import { useEffect, useRef, useState } from 'react'
import { lumaOf, speckMap } from '../lib/spotmap'
import type { Box } from './Masks'

/**
 * The "show spots" view: the picture turned into a map of its small specks, black where all is smooth and bright where a
 * dust speck, a hair or a blemish stands out from what is round it. It is how dust on a sensor is found before it is removed.
 */
export function SpotMap({ box, img }: { box: Box; img: HTMLImageElement }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    const cv = canvas.current
    if (!cv || !img.naturalWidth) return
    try {
      // a copy of at most 1000 px is plenty to find specks, and quick to go through
      const k = Math.min(1, 1000 / Math.max(img.naturalWidth, img.naturalHeight))
      const [w, h] = [Math.max(1, Math.round(img.naturalWidth * k)), Math.max(1, Math.round(img.naturalHeight * k))]
      const plain = document.createElement('canvas')
      plain.width = w
      plain.height = h
      const pctx = plain.getContext('2d', { willReadFrequently: true })!
      pctx.drawImage(img, 0, 0, w, h)
      const soft = document.createElement('canvas')
      soft.width = w
      soft.height = h
      const sctx = soft.getContext('2d', { willReadFrequently: true })!
      sctx.filter = `blur(${Math.max(2, Math.round(Math.max(w, h) * 0.008))}px)`
      sctx.drawImage(img, 0, 0, w, h)
      const map = speckMap(lumaOf(pctx.getImageData(0, 0, w, h).data), lumaOf(sctx.getImageData(0, 0, w, h).data))
      cv.width = w
      cv.height = h
      cv.getContext('2d')!.putImageData(new ImageData(map, w, h), 0, 0)
      setFailed(false)
    } catch {
      setFailed(true) // a picture the browser will not let us read
    }
  }, [img])
  return (
    <>
      <canvas ref={canvas} className="spot-map" style={{ left: box.left, top: box.top, width: box.w, height: box.h }} aria-hidden />
      <span className="badge-before spot-badge" role="status">
        {failed ? 'The spots view cannot be shown for this picture' : 'Spots view: dust and small marks show as bright specks'}
      </span>
    </>
  )
}
