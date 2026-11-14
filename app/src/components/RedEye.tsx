import { useEffect, useRef, useState } from 'react'
import { useDevelop } from '../lib/develop'
import { MAX_RED_EYES, moveRedEyeHandle, redEyeHandlePositions, type Pt, type RedEyeHandle } from '../lib/redeyeedit'
import type { RedEye } from '../lib/types'
import type { Box } from './Masks'
import { Panel } from './Primitives'
import { SliderRow } from './SliderRow'

const eyeName = (eyes: RedEye[], id: string) => `Red eye ${eyes.findIndex((e) => e.id === id) + 1}`
const store = () => useDevelop.getState()

// ---- the circles on the picture --------------------------------------------------------------

/**
 * With the red-eye tool on, a click on an eye adds a circle there. A selected circle can be moved, and its small
 * dot drags the size. The circle only says where to look: just the strongly red pixels inside it are changed.
 */
export function RedEyeOverlay({ box }: { box: Box }) {
  const eyes = useDevelop((s) => s.recipe.redEyes)
  const selected = useDevelop((s) => s.selectedRedEye)
  const tool = useDevelop((s) => s.redEyeTool)
  const defaults = useDevelop((s) => s.redEyeDefaults)
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<{ handle: RedEyeHandle; id: string; from: Pt; eye: RedEye } | null>(null)
  const click = useRef<{ x: number; y: number; moved: boolean } | null>(null)
  const pause = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [cursor, setCursor] = useState<Pt | null>(null)
  useEffect(() => () => clearTimeout(pause.current), [])
  if (!tool && !selected) return null

  const { w, h } = box
  const aspect = w / h
  const long = Math.max(w, h)
  const norm = (e: { clientX: number; clientY: number }): Pt => {
    const r = svg.current!.getBoundingClientRect()
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]
  }
  const commitSoon = (label: string) => {
    clearTimeout(pause.current)
    pause.current = setTimeout(() => void store().commitRedEyes(label), 600)
  }
  const grab = (eye: RedEye, handle: RedEyeHandle) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation() // a drag on a circle is not a click on the picture
    store().selectRedEye(eye.id)
    drag.current = { handle, id: eye.id, from: norm(e), eye }
    svg.current!.setPointerCapture(e.pointerId)
  }
  const nudge = (eye: RedEye, handle: RedEyeHandle) => (e: React.KeyboardEvent) => {
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation() // not the Library's remove-from-catalog shortcut
      return void store().deleteRedEye(eye.id)
    }
    const step = e.shiftKey ? 0.02 : 0.004
    const delta: Record<string, Pt> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    const d = delta[e.key]
    if (!d) return
    e.preventDefault()
    e.stopPropagation() // the arrow keys also step to the next photo; here they belong to the circle
    const cur = redEyeHandlePositions(eye, aspect)[handle]
    store().liveRedEye(eye.id, moveRedEyeHandle(eye, handle, cur, [cur[0] + d[0], cur[1] + d[1]], aspect))
    commitSoon(`${eyeName(store().recipe.redEyes, eye.id)}: ${handle === 'size' ? 'resize' : 'move'}`)
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
      store().liveRedEye(d.id, moveRedEyeHandle(d.eye, d.handle, d.from, p, aspect))
    } else if (click.current && Math.hypot(e.clientX - click.current.x, e.clientY - click.current.y) > 4) {
      click.current.moved = true
    }
  }
  const up = (e: React.PointerEvent<SVGSVGElement>) => {
    if (drag.current) {
      const d = drag.current
      drag.current = null
      void store().commitRedEyes(`${eyeName(store().recipe.redEyes, d.id)}: ${d.handle === 'size' ? 'resize' : 'move'}`)
    } else if (click.current) {
      const c = click.current
      click.current = null
      if (!c.moved) void store().addRedEyeAt(norm(e))
    }
  }

  const shown = tool ? eyes : eyes.filter((x) => x.id === selected)
  return (
    <svg
      ref={svg}
      className={`mask-layer spot-layer ${tool ? 'paint' : ''}`}
      style={{ left: box.left, top: box.top, width: w, height: h }}
      viewBox={`0 0 ${w} ${h}`}
      role="group"
      aria-label="Red-eye circles"
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={() => setCursor(null)}
    >
      {tool && <rect x={0} y={0} width={w} height={h} fill="transparent" style={{ pointerEvents: 'all' }} onPointerDown={backgroundDown} />}
      {shown.map((eye) => {
        const [cx, cy] = [eye.x * w, eye.y * h]
        const r = Math.max((eye.size * long) / 2, 4)
        if (eye.id !== selected) return <circle key={eye.id} className="spot-ring faint" cx={cx} cy={cy} r={r} onPointerDown={grab(eye, 'centre')} />
        const name = eyeName(eyes, eye.id)
        const sz = redEyeHandlePositions(eye, aspect).size
        return (
          <g key={eye.id}>
            <circle className="spot-ring" cx={cx} cy={cy} r={r} onPointerDown={grab(eye, 'centre')} />
            <circle className="mask-dot" cx={cx} cy={cy} r={5} tabIndex={0} role="button" aria-label={`${name}: position`} onPointerDown={grab(eye, 'centre')} onKeyDown={nudge(eye, 'centre')} />
            <circle className="mask-dot hollow" cx={sz[0] * w} cy={sz[1] * h} r={4} tabIndex={0} role="button" aria-label={`${name}: size`} onPointerDown={grab(eye, 'size')} onKeyDown={nudge(eye, 'size')} />
          </g>
        )
      })}
      {tool && cursor && <circle className="mask-brush" cx={cursor[0] * w} cy={cursor[1] * h} r={(defaults.size * long) / 2} />}
    </svg>
  )
}

// ---- the panel ---------------------------------------------------------------------------------

export function RedEyePanel() {
  const eyes = useDevelop((s) => s.recipe.redEyes)
  const selected = useDevelop((s) => s.selectedRedEye)
  const tool = useDevelop((s) => s.redEyeTool)
  const defaults = useDevelop((s) => s.redEyeDefaults)
  const zoomed = useDevelop((s) => s.zoom.on)
  const current = eyes.find((e) => e.id === selected)
  const full = eyes.length >= MAX_RED_EYES
  const [finding, setFinding] = useState(false)
  const [eyeNote, setEyeNote] = useState<string | null>(null)
  const findEyes = async () => {
    setFinding(true)
    setEyeNote(null)
    try {
      const n = await store().findRedEyes()
      setEyeNote(n === 0 ? 'No new eyes were found.' : `Put a red-eye circle on ${n === 1 ? '1 eye' : `${n} eyes`}. Only strongly red pixels inside them change.`)
    } catch (e) {
      setEyeNote((e as Error).message)
    } finally {
      setFinding(false)
    }
  }
  const value = (k: 'size' | 'darken') => (current ? current[k] : defaults[k])
  const set = (patch: Partial<RedEye>) => (current ? store().liveRedEye(current.id, patch) : store().setRedEyeDefaults(patch))
  const commit = (label: string) => {
    if (current) void store().commitRedEyes(`${eyeName(store().recipe.redEyes, current.id)}: ${label}`)
  }
  const slider = (key: 'size' | 'darken', label: string, min: number, max: number, neutral: number) => (
    <SliderRow
      id={`sl-redeye-${key}`}
      label={label}
      value={Math.round(value(key) * 100)}
      min={min}
      max={max}
      step={1}
      digits={0}
      neutral={neutral}
      onLive={(v) => set({ [key]: v / 100 })}
      onCommit={() => commit(label.toLowerCase())}
      onReset={() => {
        set({ [key]: neutral / 100 })
        commit(label.toLowerCase())
      }}
    />
  )
  return (
    <Panel title="Red eye">
      <button type="button" className="btn sm" aria-pressed={tool} disabled={full && !tool} onClick={() => store().setRedEyeTool(!tool)} title="Click an eye on the picture to fix its red pupil">
        Red eye tool
      </button>
      <button type="button" className="btn sm" disabled={finding} onClick={() => void findEyes()} title="Find the eyes in the picture and put a red-eye circle on each">
        {finding ? 'Looking…' : 'Find eyes'}
      </button>
      {eyeNote && <p role="status">{eyeNote}</p>}
      {tool && <p className="hint">Click the middle of a red pupil. Only the strongly red pixels inside the circle change, so it does not have to be exact; drag the small dot to resize it.</p>}
      {zoomed && <p className="hint">Red eye is edited with the whole picture in view. Press Z to fit it.</p>}
      <fieldset className="sgroup">
        <legend>{current ? eyeName(eyes, current.id) : 'New circles'}</legend>
        {slider('size', 'Size', 1, 20, 4)}
        {slider('darken', 'Darken', 0, 100, 50)}
      </fieldset>
      {eyes.length === 0 ? (
        <p className="hint">No red-eye fixes yet.</p>
      ) : (
        <>
          <ul className="mask-list" aria-label="Red-eye fixes">
            {eyes.map((e, i) => (
              <li key={e.id} className={e.id === selected ? 'sel' : ''}>
                <button type="button" className="mask-name" aria-pressed={e.id === selected} onClick={() => store().selectRedEye(e.id === selected ? null : e.id)}>
                  <span className="trunc">Red eye {i + 1}</span>
                </button>
                <button type="button" className="x" aria-label={`Delete red eye ${i + 1}`} onClick={() => void store().deleteRedEye(e.id)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          <button type="button" className="btn sm" onClick={() => void store().deleteAllRedEyes()}>
            Delete all red-eye fixes
          </button>
        </>
      )}
    </Panel>
  )
}
