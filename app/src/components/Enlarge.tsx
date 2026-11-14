import { useEffect, useState } from 'react'
import { usePrefs } from '../lib/prefs'
import { api } from '../lib/api'
import { useDevelop } from '../lib/develop'
import { useStore } from '../lib/store'
import type { EnlargeMethod } from '../lib/types'
import { Panel } from './Primitives'

const FACTORS = [2, 3, 4]
const MAX_EDGE = 20000

/**
 * For a photo cropped in too far: how big it is now, how big to make it, and a look at what each way of enlarging does to the
 * middle of the picture before anything is written. The enlarging itself happens in the export (the Export dialog is opened
 * with the size and the way already chosen), so the file names, the format and the colour space are all there as usual.
 */
export function EnlargePanel() {
  const hideAi = usePrefs((s) => s.hideAi)
  const photoId = useDevelop((s) => s.photoId)
  const recipe = useDevelop((s) => s.recipe)
  const [size, setSize] = useState<{ width: number; height: number } | null>(null)
  const [sizeError, setSizeError] = useState<string | null>(null)
  const [chosen, setMethod] = useState<Exclude<EnlargeMethod, 'none'>>('smooth')
  const method = hideAi ? 'smooth' : chosen
  const [edge, setEdge] = useState('')
  const [shown, setShown] = useState<{ before: string; after: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // the size after the turn and crop, a moment after the frame stops moving
  const framing = JSON.stringify([recipe.crop, recipe.geometry.quarterTurns])
  useEffect(() => {
    if (photoId === null) return
    let alive = true
    const t = setTimeout(() => {
      api()
        .enlargeInfo(photoId, recipe)
        .then((s) => alive && (setSize(s), setSizeError(null), setShown(null)))
        .catch((e: Error) => alive && (setSize(null), setSizeError(e.message)))
    }, 250)
    return () => {
      alive = false
      clearTimeout(t)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [photoId, framing])

  const longest = size ? Math.max(size.width, size.height) : 0
  // start from twice the size the first time the size is known
  useEffect(() => {
    if (longest > 0) setEdge((e) => (e === '' ? String(Math.min(MAX_EDGE, longest * 2)) : e))
  }, [longest])

  const target = Number(edge)
  const valid = longest > 0 && Number.isInteger(target) && target > longest && target <= MAX_EDGE
  const factor = longest > 0 && Number.isFinite(target) && target > 0 ? target / longest : 0
  const problem = !size || edge.trim() === '' ? null : !Number.isInteger(target) ? 'Use a whole number of pixels.' : target <= longest ? `That is not bigger than the picture (${longest} px).` : target > MAX_EDGE ? `The largest size is ${MAX_EDGE} px.` : null

  const look = async () => {
    if (photoId === null) return
    setBusy(true)
    setError(null)
    try {
      setShown(await api().enlargePreview(photoId, recipe, method))
    } catch (e) {
      setShown(null)
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const exportIt = () => useStore.setState({ exportOpen: true, exportPatch: { longEdge: target, enlarge: method } })

  return (
    <Panel title="Enlarge" defaultOpen={false}>
      <p className="hint" role="status">
        {size ? `The picture is about ${size.width} × ${size.height} px after the crop.` : sizeError ?? 'Working out the size of the picture…'}
      </p>
      <div className="aspects tabs" role="group" aria-label="Enlarge by">
        {FACTORS.map((k) => (
          <button key={k} type="button" className="btn sm" disabled={!size} aria-pressed={longest > 0 && target === Math.round(longest * k)} onClick={() => setEdge(String(Math.min(MAX_EDGE, Math.round(longest * k))))}>
            {k}×
          </button>
        ))}
      </div>
      <label className="inline">
        Longest side (px)
        <input className="field narrow" type="text" inputMode="numeric" aria-label="Enlarge to (longest side in pixels)" value={edge} aria-invalid={!!problem} onChange={(e) => setEdge(e.target.value.replace(/[^0-9]/g, '').slice(0, 5))} />
      </label>
      {problem && (
        <p className="err" role="alert">
          {problem}
        </p>
      )}
      <div className="aspects tabs" role="radiogroup" aria-label="How to enlarge">
        <button type="button" role="radio" aria-checked={method === 'smooth'} className="btn sm" aria-pressed={method === 'smooth'} onClick={() => (setMethod('smooth'), setShown(null))}>
          Smooth
        </button>
        {!hideAi && (
        <button type="button" role="radio" aria-checked={method === 'ai'} className="btn sm" aria-pressed={method === 'ai'} onClick={() => (setMethod('ai'), setShown(null))}>
          AI
        </button>
        )}
      </div>
      <p className="hint">
        {method === 'smooth' ? 'Smooth: a good filter with light sharpening. Quick, and it never invents anything.' : 'AI: a model that draws in fine detail. Slower (seconds to a minute a photo), and what it adds is a good guess, not what was really there.'}
      </p>
      <button type="button" className="btn sm" disabled={!size || busy} aria-busy={busy} onClick={() => void look()}>
        {busy ? 'Looking…' : 'Show before and after'}
      </button>
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      {shown && (
        <div className="enlarge-compare">
          <figure>
            <img src={shown.before} alt="Before: the middle of the picture, its pixels simply made bigger" className="pixelated" />
            <figcaption className="hint">Before</figcaption>
          </figure>
          <figure>
            <img src={shown.after} alt={`After: the same part enlarged ${method === 'ai' ? 'by the AI' : 'smoothly'}`} />
            <figcaption className="hint">{method === 'ai' ? 'After (AI)' : 'After (smooth)'}</figcaption>
          </figure>
        </div>
      )}
      <button type="button" className="btn accent sm" disabled={!valid} onClick={exportIt} title="Open the Export dialog with this size and way of enlarging">
        {valid ? `Export enlarged ${factor.toFixed(1)}×…` : 'Export enlarged…'}
      </button>
    </Panel>
  )
}
