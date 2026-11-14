import { useEffect, useRef, useState } from 'react'
import { usePrefs } from '../lib/prefs'
import { MAX_SPOTS, useDevelop } from '../lib/develop'
import { moveSpotHandle, spotHandlePositions, type Pt, type SpotHandle } from '../lib/spotedit'
import type { Spot } from '../lib/types'
import type { Box } from './Masks'
import { Panel } from './Primitives'
import { SliderRow } from './SliderRow'

const spotName = (spots: Spot[], id: string) => `Spot ${spots.findIndex((s) => s.id === id) + 1}`

// ---- the circles on the picture --------------------------------------------------------------

/**
 * With the spot tool on, a click on the picture adds a spot there. A selected spot shows two circles:
 * the one that is repaired and the one that is copied from, joined by a line. Drag the first to move
 * both, the second to choose a different source, and the small dot to change the size.
 */
export function SpotOverlay({ box }: { box: Box }) {
  const spots = useDevelop((s) => s.recipe.spots)
  const selected = useDevelop((s) => s.selectedSpot)
  const tool = useDevelop((s) => s.spotTool)
  const defaults = useDevelop((s) => s.spotDefaults)
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<{ handle: SpotHandle; id: string; from: Pt; spot: Spot } | null>(null)
  const click = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const pause = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [cursor, setCursor] = useState<Pt | null>(null)
  useEffect(() => () => clearTimeout(pause.current), [])
  if (!tool && !selected) return null

  const { w, h } = box
  const aspect = w / h
  const long = Math.max(w, h)
  const store = () => useDevelop.getState()
  const norm = (e: { clientX: number; clientY: number }): Pt => {
    const r = svg.current!.getBoundingClientRect()
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]
  }
  const px = (p: Pt): Pt => [p[0] * w, p[1] * h]
  const commitSoon = (label: string) => {
    clearTimeout(pause.current)
    pause.current = setTimeout(() => void store().commitSpots(label), 600)
  }

  const grab = (spot: Spot, handle: SpotHandle) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation() // a drag on a circle is not a click on the picture
    store().selectSpot(spot.id)
    drag.current = { handle, id: spot.id, from: norm(e), spot }
    svg.current!.setPointerCapture(e.pointerId)
  }
  const nudge = (spot: Spot, handle: SpotHandle) => (e: React.KeyboardEvent) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation() // not the Library's remove-from-catalog shortcut
      return void store().deleteSpot(spot.id)
    }
    const step = e.shiftKey ? 0.05 : 0.01
    const delta: Record<string, Pt> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    const d = delta[e.key]
    if (!d) return
    e.preventDefault()
    e.stopPropagation() // the arrow keys also step to the next photo; here they belong to the circle
    const cur = spotHandlePositions(spot, aspect)[handle]
    store().liveSpot(spot.id, moveSpotHandle(spot, handle, cur, [cur[0] + d[0], cur[1] + d[1]], aspect))
    commitSoon(`${spotName(store().recipe.spots, spot.id)}: ${handle === 'size' ? 'resize' : 'move'}`)
  }

  const backgroundDown = (e: React.PointerEvent) => {
    if (!tool || e.button !== 0) return
    e.stopPropagation()
    click.current = { x: e.clientX, y: e.clientY, moved: false }
    svg.current!.setPointerCapture(e.pointerId)
  }
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = norm(e)
    setCursor(p)
    if (drag.current) {
      const d = drag.current
      store().liveSpot(d.id, moveSpotHandle(d.spot, d.handle, d.from, p, aspect))
    } else if (click.current && Math.hypot(e.clientX - click.current.x, e.clientY - click.current.y) > 4) {
      click.current.moved = true
    }
  }
  const up = (e: React.PointerEvent<SVGSVGElement>) => {
    if (drag.current) {
      const d = drag.current
      drag.current = null
      void store().commitSpots(`${spotName(store().recipe.spots, d.id)}: ${d.handle === 'size' ? 'resize' : d.handle === 'source' ? 'move source' : 'move'}`)
    } else if (click.current) {
      const c = click.current
      click.current = null
      if (!c.moved) void store().addSpotAt(norm(e), aspect)
    }
  }

  const shown = tool ? spots.filter((s) => s.visible) : spots.filter((s) => s.id === selected)
  return (
    <svg
      ref={svg}
      className={`mask-layer spot-layer ${tool ? 'paint' : ''}`}
      style={{ left: box.left, top: box.top, width: w, height: h }}
      viewBox={`0 0 ${w} ${h}`}
      role="group"
      aria-label="Spot removal circles"
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={() => setCursor(null)}
    >
      {tool && <rect x={0} y={0} width={w} height={h} fill="transparent" style={{ pointerEvents: 'all' }} onPointerDown={backgroundDown} />}
      {shown.map((s) => {
        const isSel = s.id === selected
        const [tx, ty] = px([s.x, s.y])
        const [sx, sy] = px([s.sx, s.sy])
        const r = (s.size * long) / 2
        const hp = spotHandlePositions(s, aspect)
        const name = spotName(spots, s.id)
        if (!isSel) {
          return <circle key={s.id} className="spot-ring faint" cx={tx} cy={ty} r={Math.max(r, 4)} onPointerDown={grab(s, 'target')} />
        }
        return (
          <g key={s.id}>
            {s.mode !== 'fill' && <line className="mask-line" x1={tx} y1={ty} x2={sx} y2={sy} />}
            {s.mode !== 'fill' && <circle className="spot-ring source" cx={sx} cy={sy} r={Math.max(r, 4)} onPointerDown={grab(s, 'source')} />}
            <circle className="spot-ring" cx={tx} cy={ty} r={Math.max(r, 4)} onPointerDown={grab(s, 'target')} />
            <circle className="mask-dot" cx={tx} cy={ty} r={5} tabIndex={0} role="button" aria-label={`${name}: the spot to remove`} onPointerDown={grab(s, 'target')} onKeyDown={nudge(s, 'target')} />
            {s.mode !== 'fill' && <circle className="mask-dot hollow" cx={sx} cy={sy} r={5} tabIndex={0} role="button" aria-label={`${name}: where it is copied from`} onPointerDown={grab(s, 'source')} onKeyDown={nudge(s, 'source')} />}
            <circle className="mask-dot hollow" cx={px(hp.size)[0]} cy={px(hp.size)[1]} r={4} tabIndex={0} role="button" aria-label={`${name}: size`} onPointerDown={grab(s, 'size')} onKeyDown={nudge(s, 'size')} />
          </g>
        )
      })}
      {tool && cursor && <circle className="mask-brush" cx={cursor[0] * w} cy={cursor[1] * h} r={(defaults.size * long) / 2} />}
    </svg>
  )
}

// ---- the panel ---------------------------------------------------------------------------------

export function SpotsPanel() {
  const hideAi = usePrefs((s) => s.hideAi)
  const spots = useDevelop((s) => s.recipe.spots)
  const selected = useDevelop((s) => s.selectedSpot)
  const tool = useDevelop((s) => s.spotTool)
  const defaults = useDevelop((s) => s.spotDefaults)
  const zoomed = useDevelop((s) => s.zoom.on)
  const spotView = useDevelop((s) => s.spotView)
  const [finding, setFinding] = useState(false)
  const [dustNote, setDustNote] = useState<string | null>(null)
  const findDust = async () => {
    setFinding(true)
    setDustNote(null)
    try {
      const n = await store().findDust()
      setDustNote(n === 0 ? 'No new dust specks were found.' : n === 1 ? 'Found 1 speck and put a healing spot on it.' : `Found ${n} specks and put a healing spot on each.`)
    } catch (e) {
      setDustNote((e as Error).message)
    } finally {
      setFinding(false)
    }
  }
  const current = spots.find((s) => s.id === selected)
  const store = () => useDevelop.getState()
  const full = spots.length >= MAX_SPOTS
  // the controls edit the selected spot, or the starting values for the next one
  const value = (k: 'size' | 'feather' | 'opacity') => (current ? current[k] : defaults[k])
  const mode = current ? current.mode : defaults.mode
  const set = (patch: Partial<Spot>, label: string) => {
    if (current) store().liveSpot(current.id, patch)
    else store().setSpotDefaults(patch)
    return label
  }
  const commit = (label: string) => {
    if (current) void store().commitSpots(`${spotName(store().recipe.spots, current.id)}: ${label}`)
  }
  const slider = (key: 'size' | 'feather' | 'opacity', label: string, min: number, max: number, neutral: number) => (
    <SliderRow
      id={`sl-spot-${key}`}
      label={label}
      value={Math.round(value(key) * 100)}
      min={min}
      max={max}
      step={1}
      digits={0}
      neutral={neutral}
      onLive={(v) => set({ [key]: v / 100 }, label)}
      onCommit={() => commit(label.toLowerCase())}
      onReset={() => {
        set({ [key]: neutral / 100 }, label)
        commit(label.toLowerCase())
      }}
    />
  )
  return (
    <Panel title="Spot removal">
      <button type="button" className="btn sm" aria-pressed={tool} disabled={full && !tool} onClick={() => store().setSpotTool(!tool)} title="Click a spot on the picture to remove it">
        Spot removal tool
      </button>
      <button type="button" className="btn sm" aria-pressed={spotView} onClick={() => store().toggleSpotView()} title="Show the picture as a map of its small specks, to find dust">
        Show spots
      </button>
      <button type="button" className="btn sm" disabled={finding} onClick={() => void findDust()} title="Look for small dark specks on smooth parts of the picture (dust on the sensor) and put a healing spot on each">
        {finding ? 'Looking…' : 'Find dust'}
      </button>
      {dustNote && <p role="status">{dustNote}</p>}
      {tool && <p className="hint">Click a dust speck or blemish on the picture. The app finds a clean place to copy from; drag the second circle to choose another.</p>}
      {mode === 'fill' && <p className="hint">Fill removes something bigger: make the circle cover it, with a little room round it. The first time it takes a moment while the app paints what belongs there.</p>}
      {zoomed && <p className="hint">Spots are edited with the whole picture in view. Press Z to fit it.</p>}
      <div className="row" role="group" aria-label="Spot mode">
        <button type="button" className="btn sm" aria-pressed={mode === 'heal'} title="Match the patch to its surroundings" onClick={() => (current ? void store().setAndCommit({ spots: spots.map((s) => (s.id === current.id ? { ...s, mode: 'heal' } : s)) }, { label: `${spotName(spots, current.id)}: heal`, deltaText: null, valueText: null }) : store().setSpotDefaults({ mode: 'heal' }))}>
          Heal
        </button>
        {!hideAi && (
        <button type="button" className="btn sm" aria-pressed={mode === 'fill'} title="Remove a bigger thing: the app paints what belongs there (a person, a sign, a bin)" onClick={() => (current ? void store().setAndCommit({ spots: spots.map((s) => (s.id === current.id ? { ...s, mode: 'fill' } : s)) }, { label: `${spotName(spots, current.id)}: fill`, deltaText: null, valueText: null }) : store().setSpotDefaults({ mode: 'fill' }))}>
          Fill
        </button>
        )}
        <button type="button" className="btn sm" aria-pressed={mode === 'clone'} title="Copy the patch exactly" onClick={() => (current ? void store().setAndCommit({ spots: spots.map((s) => (s.id === current.id ? { ...s, mode: 'clone' } : s)) }, { label: `${spotName(spots, current.id)}: clone`, deltaText: null, valueText: null }) : store().setSpotDefaults({ mode: 'clone' }))}>
          Clone
        </button>
      </div>
      <fieldset className="sgroup">
        <legend>{current ? spotName(spots, current.id) : 'New spots'}</legend>
        {slider('size', 'Size', 1, 30, 4)}
        {slider('feather', 'Feather', 0, 100, 50)}
        {slider('opacity', 'Opacity', 0, 100, 100)}
      </fieldset>
      {spots.length === 0 ? (
        <p className="hint">No spots yet.</p>
      ) : (
        <>
          <ul className="mask-list" aria-label="Spots">
            {spots.map((s, i) => (
              <li key={s.id} className={s.id === selected ? 'sel' : ''}>
                <button type="button" className="mask-name" aria-pressed={s.id === selected} onClick={() => store().selectSpot(s.id === selected ? null : s.id)}>
                  <span className="trunc">Spot {i + 1}</span>
                  <small className="muted">{s.mode === 'heal' ? 'Heal' : s.mode === 'fill' ? 'Fill' : 'Clone'}</small>
                </button>
                <button
                  type="button"
                  className="x"
                  aria-pressed={s.visible}
                  aria-label={s.visible ? `Hide spot ${i + 1}` : `Show spot ${i + 1}`}
                  onClick={() => void store().setAndCommit({ spots: spots.map((x) => (x.id === s.id ? { ...x, visible: !x.visible } : x)) }, { label: `${s.visible ? 'Hide' : 'Show'} spot ${i + 1}`, deltaText: null, valueText: null })}
                >
                  {s.visible ? 'On' : 'Off'}
                </button>
                <button type="button" className="x" aria-label={`Delete spot ${i + 1}`} onClick={() => void store().deleteSpot(s.id)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="btn sm" onClick={() => void store().deleteAllSpots()}>
            Delete all spots
          </button>
        </>
      )}
    </Panel>
  )
}
