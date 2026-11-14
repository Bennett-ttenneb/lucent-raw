import { useEffect, useRef, useState } from 'react'
import { usePrefs } from '../lib/prefs'
import {
  MASK_ADJUSTMENTS,
  MASK_OP_LABEL,
  MASK_TYPE_LABEL,
  PERSON_PARTS,
  MAX_MASKS,
  MAX_PARTS,
  adjustStep,
  hasHandles,
  maskById,
  targetShape,
  useDevelop,
  withAdjust,
  withMask,
  withTargetShape,
  type MaskType,
} from '../lib/develop'
import { BUILTIN_BRUSHES, forgetBrush, loadBrushes, saveBrush } from '../lib/brushPresets'
import { addStrokePoint, handlePositions, moveHandle, type Handle, type Pt } from '../lib/maskedit'
import type { Mask, MaskOp, MaskShape, Stroke } from '../lib/types'
import { Panel } from './Primitives'
import { SliderRow } from './SliderRow'

const TYPES: MaskType[] = ['linear', 'radial', 'brush', 'luminance', 'colour']
/** The button that starts a new mask. */
const NEW_BUTTON: Record<MaskType, string> = { linear: '+ Linear', radial: '+ Radial', brush: '+ Brush', luminance: '+ Luminance', colour: '+ Colour', subject: '+ Subject', sky: '+ Sky', depth: '+ Depth' }
/** The button that combines another shape with the selected mask (a different label, so the two never get confused). */
const COMBINE_BUTTON: Record<MaskType, string> = { linear: 'Linear', radial: 'Radial', brush: 'Brush', luminance: 'Luminance', colour: 'Colour', subject: 'Subject', sky: 'Sky', depth: 'Depth' }
const OPS: MaskOp[] = ['add', 'subtract', 'intersect']

// ---- the handles on the picture ------------------------------------------------------------

export interface Box {
  left: number
  top: number
  w: number
  h: number
}

/**
 * Draws the selected shape of the selected mask on the picture: the line and handles of a gradient, the
 * ellipse of a radial one, or a surface to paint on for a brush. (A range has nothing to place: it is
 * set with sliders.) `box` is where the picture is drawn, in screen pixels.
 */
export function MaskOverlay({ box }: { box: Box }) {
  const mask = useDevelop((s) => maskById(s.recipe, s.selectedMask))
  const part = useDevelop((s) => s.selectedPart)
  const brush = useDevelop((s) => s.brush)
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<{ handle: Handle; from: Pt; shape: MaskShape } | null>(null)
  const painting = useRef<{ base: Stroke[]; current: Stroke } | null>(null)
  const pause = useRef<ReturnType<typeof setTimeout>>(undefined)
  const [cursor, setCursor] = useState<Pt | null>(null)
  /** the stroke being drawn, shown at once; the real picture follows a moment later */
  const [trail, setTrail] = useState<{ points: Pt[]; erase: boolean } | null>(null)
  useEffect(() => () => clearTimeout(pause.current), [])
  if (!mask) return null
  const target = targetShape(mask, part)
  if (!hasHandles(target)) return null

  const { w, h } = box
  const aspect = w / h
  const long = Math.max(w, h)
  const norm = (e: { clientX: number; clientY: number }): Pt => {
    const r = svg.current!.getBoundingClientRect()
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]
  }
  const store = () => useDevelop.getState()
  /** put a new shape in as the one being edited */
  const liveShape = (shape: MaskShape) => store().liveMask(mask.id, withTargetShape(mask, part, shape))
  const commitSoon = (label: string) => {
    clearTimeout(pause.current)
    pause.current = setTimeout(() => void store().commitMasks(label), 600)
  }

  const grab = (handle: Handle) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation() // not a click on the picture, which would zoom
    drag.current = { handle, from: norm(e), shape: target }
    svg.current!.setPointerCapture(e.pointerId)
  }
  const nudge = (handle: Handle) => (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.05 : 0.01
    const delta: Record<string, Pt> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    const d = delta[e.key]
    const cur = handlePositions(target, aspect)[handle]
    if (!d || !cur) return
    e.preventDefault()
    e.stopPropagation() // the arrow keys also step to the next photo; here they belong to the handle
    liveShape(moveHandle(target, handle, cur, [cur[0] + d[0], cur[1] + d[1]], aspect))
    commitSoon(`${mask.name}: move`)
  }

  const down = (e: React.PointerEvent<SVGSVGElement>) => {
    if (target.type !== 'brush' || e.button !== 0) return
    e.stopPropagation()
    const p = norm(e)
    const current: Stroke = { erase: brush.erase || e.altKey, size: brush.size, feather: brush.feather, flow: brush.flow, points: [p] }
    painting.current = { base: target.strokes, current }
    setTrail({ points: [p], erase: current.erase })
    store().setPainting(true)
    liveShape({ type: 'brush', strokes: [...target.strokes, current] })
    svg.current!.setPointerCapture(e.pointerId)
  }
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    const p = norm(e)
    setCursor(p)
    if (drag.current) {
      const d = drag.current
      liveShape(moveHandle(d.shape, d.handle, d.from, p, aspect))
    } else if (painting.current) {
      const st = painting.current
      const points = addStrokePoint(st.current.points, p)
      if (points === st.current.points) return
      st.current = { ...st.current, points }
      setTrail({ points, erase: st.current.erase })
      liveShape({ type: 'brush', strokes: [...st.base, st.current] })
    }
  }
  const up = () => {
    if (drag.current) {
      drag.current = null
      void store().commitMasks(`${mask.name}: move`)
    } else if (painting.current) {
      const erase = painting.current.current.erase
      painting.current = null
      setTrail(null)
      store().setPainting(false) // the full-quality picture is asked for now
      void store().commitMasks(`${mask.name}: ${erase ? 'erase' : 'brush'} stroke`)
    }
  }

  const px = (p: Pt): Pt => [p[0] * w, p[1] * h]
  const handles = handlePositions(target, aspect)
  const dot = (handle: Handle, label: string, hollow = false) => {
    const at = handles[handle]
    if (!at) return null
    const [x, y] = px(at)
    return (
      <circle
        key={handle}
        className={`mask-dot ${hollow ? 'hollow' : ''}`}
        cx={x}
        cy={y}
        r={7}
        tabIndex={0}
        role="button"
        aria-label={label}
        onPointerDown={grab(handle)}
        onKeyDown={nudge(handle)}
      />
    )
  }

  let drawn: React.ReactNode = null
  if (target.type === 'linear') {
    const [a, b] = [px([target.x1, target.y1]), px([target.x2, target.y2])]
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]]
    const len = Math.hypot(dx, dy) || 1
    const [nx, ny] = [(-dy / len) * 40, (dx / len) * 40] // across the line
    drawn = (
      <>
        <line className="mask-line" x1={a[0] - nx} y1={a[1] - ny} x2={a[0] + nx} y2={a[1] + ny} />
        <line className="mask-line" x1={b[0] - nx} y1={b[1] - ny} x2={b[0] + nx} y2={b[1] + ny} />
        <line className="mask-line grab" x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} onPointerDown={grab('line')} />
        {dot('start', 'Gradient start: full effect here')}
        {dot('end', 'Gradient end: no effect here', true)}
      </>
    )
  } else if (target.type === 'radial') {
    const [c, s] = [px([target.cx, target.cy]), target]
    drawn = (
      <>
        <ellipse className="mask-line grab" cx={c[0]} cy={c[1]} rx={s.rx * long} ry={s.ry * long} transform={`rotate(${s.angle} ${c[0]} ${c[1]})`} fill="none" onPointerDown={grab('centre')} />
        {dot('centre', 'Radial centre')}
        {dot('radiusX', 'Radial width', true)}
        {dot('radiusY', 'Radial height', true)}
      </>
    )
  } else {
    drawn = (
      <>
        {trail && (
          <polyline
            className={`mask-trail ${trail.erase ? 'erase' : ''}`}
            // a polyline needs two points to draw anything: the first press is drawn as a dot (the same point twice)
            points={(trail.points.length === 1 ? [trail.points[0], trail.points[0]] : trail.points).map((p) => `${p[0] * w},${p[1] * h}`).join(' ')}
            strokeWidth={brush.size * long}
          />
        )}
        {cursor && <circle className="mask-brush" cx={cursor[0] * w} cy={cursor[1] * h} r={(brush.size * long) / 2} />}
      </>
    )
  }

  return (
    <svg
      ref={svg}
      className={`mask-layer ${target.type === 'brush' ? 'paint' : ''}`}
      style={{ left: box.left, top: box.top, width: w, height: h }}
      viewBox={`0 0 ${w} ${h}`}
      role="group"
      aria-label={`Mask handles for ${mask.name}`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onPointerLeave={() => setCursor(null)}
    >
      {drawn}
    </svg>
  )
}

// ---- the panel -------------------------------------------------------------------------------

/** The brushes that come with the program and the ones you keep: pick one to set the size, feather and flow in one go. */
function BrushPresets() {
  const brush = useDevelop((s) => s.brush)
  const [mine, setMine] = useState(loadBrushes)
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const all = [...BUILTIN_BRUSHES, ...mine]
  const pick = (n: string) => {
    const p = all.find((b) => b.name === n)
    if (p) useDevelop.getState().setBrush({ size: p.size, feather: p.feather, flow: p.flow })
  }
  const keep = () => {
    const r = saveBrush(name, brush)
    if ('error' in r) return setError(r.error)
    setMine(r.list)
    setNaming(false)
    setName('')
    setError(null)
  }
  const current = all.find((b) => Math.abs(b.size - brush.size) < 1e-6 && Math.abs(b.feather - brush.feather) < 1e-6 && Math.abs(b.flow - brush.flow) < 1e-6)
  return (
    <div className="stack">
      <div className="row">
        <label className="inline">
          Brush
          <select className="field" aria-label="Brush preset" value={current?.name ?? ''} onChange={(e) => pick(e.target.value)}>
            <option value="" disabled>
              Your own settings
            </option>
            {BUILTIN_BRUSHES.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
            {mine.length > 0 && (
              <optgroup label="Yours">
                {mine.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}
                  </option>
                ))}
              </optgroup>
            )}
          </select>
        </label>
        {naming ? (
          <>
            <input className="field" aria-label="Brush name" maxLength={40} value={name} placeholder="Name this brush" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && keep()} />
            <button type="button" className="btn sm" onClick={keep}>
              Keep
            </button>
            <button type="button" className="btn sm" onClick={() => (setNaming(false), setError(null))}>
              Cancel
            </button>
          </>
        ) : (
          <>
            <button type="button" className="btn sm" onClick={() => setNaming(true)}>
              Keep this brush…
            </button>
            {current && mine.some((b) => b.name === current.name) && (
              <button type="button" className="btn sm" onClick={() => setMine(forgetBrush(current.name))}>
                Forget it
              </button>
            )}
          </>
        )}
      </div>
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** The controls of the selected shape: a gradient's feather, a brush, or the limits of a range. */
function ShapeSettings({ mask, part }: { mask: Mask; part: number | null }) {
  const brush = useDevelop((s) => s.brush)
  const picking = useDevelop((s) => s.picking)
  const zoomed = useDevelop((s) => s.zoom.on)
  const store = () => useDevelop.getState()
  const s = targetShape(mask, part)
  const where = part === null ? 'base' : `p${part}`
  const set = (shape: MaskShape) => store().liveMask(mask.id, withTargetShape(maskById(store().recipe, mask.id) ?? mask, part, shape))
  const slider = (key: string, label: string, value: number, min: number, max: number, make: (v: number) => MaskShape, neutral: number, unit = '') => (
    <SliderRow
      key={key}
      id={`sl-mask-${mask.id}-${where}-${key}`}
      label={label}
      value={Math.round(value)}
      min={min}
      max={max}
      step={1}
      digits={0}
      neutral={neutral}
      onLive={(v) => set(make(v))}
      onCommit={() => void store().commitMasks(`${mask.name}: ${label.toLowerCase()}${unit}`)}
      onReset={() => {
        set(make(neutral))
        void store().commitMasks(`${mask.name}: ${label.toLowerCase()}`)
      }}
    />
  )
  return (
    <fieldset className="sgroup">
      <legend>{part === null ? 'Shape' : `Shape ${part + 2}`}</legend>
      {s.type === 'linear' && slider('feather', 'Feather', s.feather * 100, 0, 100, (v) => ({ ...s, feather: v / 100 }), 60)}
      {s.type === 'radial' && (
        <>
          {slider('feather', 'Feather', s.feather * 100, 0, 100, (v) => ({ ...s, feather: v / 100 }), 50)}
          {slider('angle', 'Angle', s.angle, -180, 180, (v) => ({ ...s, angle: v }), 0)}
        </>
      )}
      {s.type === 'brush' && (
        <>
          <BrushPresets />
          <SliderRow id="sl-brush-size" label="Size" value={Math.round(brush.size * 100)} min={1} max={50} step={1} digits={0} neutral={8} onLive={(v) => store().setBrush({ size: v / 100 })} onCommit={() => undefined} onReset={() => store().setBrush({ size: 0.08 })} />
          <SliderRow id="sl-brush-feather" label="Feather" value={Math.round(brush.feather * 100)} min={0} max={100} step={1} digits={0} neutral={50} onLive={(v) => store().setBrush({ feather: v / 100 })} onCommit={() => undefined} onReset={() => store().setBrush({ feather: 0.5 })} />
          <SliderRow id="sl-brush-flow" label="Flow" value={Math.round(brush.flow * 100)} min={1} max={100} step={1} digits={0} neutral={100} onLive={(v) => store().setBrush({ flow: v / 100 })} onCommit={() => undefined} onReset={() => store().setBrush({ flow: 1 })} />
          <div className="row">
            <button type="button" className="btn sm" aria-pressed={brush.erase} onClick={() => store().setBrush({ erase: !brush.erase })} title="Hold Alt while painting to erase">
              Erase
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={s.strokes.length === 0}
              onClick={() => {
                set({ type: 'brush', strokes: [] })
                void store().commitMasks(`${mask.name}: clear strokes`)
              }}
            >
              Clear strokes
            </button>
            <button
              type="button"
              className="btn sm"
              disabled={s.strokes.length === 0}
              title="Take back the last stroke"
              onClick={() => {
                set({ type: 'brush', strokes: s.strokes.slice(0, -1) })
                void store().commitMasks(`${mask.name}: undo stroke`)
              }}
            >
              Undo last stroke
            </button>
          </div>
          <p className="hint">Paint on the picture. {s.strokes.length === 0 ? 'Nothing is painted yet.' : `${s.strokes.length} stroke${s.strokes.length === 1 ? '' : 's'}.`}</p>
        </>
      )}
      {s.type === 'sky' && (
        <>
          {slider('sensitivity', 'Sensitivity', s.sensitivity * 100, 0, 100, (v) => ({ ...s, sensitivity: v / 100 }), 50)}
          <p className="hint">Takes in the blue sky and bright cloud near the top of the picture. Raise the sensitivity to take in more.</p>
        </>
      )}
      {s.type === 'depth' && (
        <>
          {slider('near', 'Nearest', s.near * 100, 0, 100, (v) => ({ ...s, near: v / 100, far: Math.max(s.far, v / 100) }), 60)}
          {slider('far', 'Farthest', s.far * 100, 0, 100, (v) => ({ ...s, far: v / 100, near: Math.min(s.near, v / 100) }), 100)}
          {slider('smooth', 'Smoothness', s.smooth * 100, 0, 100, (v) => ({ ...s, smooth: v / 100 }), 30)}
          <p className="hint">Found automatically from how near each part of the picture looks. 100 is the nearest thing in the picture and 0 the farthest. Put some Lens blur on it to blur what is far away.</p>
        </>
      )}
      {s.type === 'subject' && <p className="hint">Found automatically. Turn on Invert to adjust the background instead. Combine it with a brush to put right anything it missed.</p>}
      {s.type === 'luminance' && (
        <>
          {slider('lo', 'Darkest', s.lo * 100, 0, 100, (v) => ({ ...s, lo: v / 100, hi: Math.max(s.hi, v / 100) }), 60)}
          {slider('hi', 'Brightest', s.hi * 100, 0, 100, (v) => ({ ...s, hi: v / 100, lo: Math.min(s.lo, v / 100) }), 100)}
          {slider('smooth', 'Smoothness', s.smooth * 100, 0, 100, (v) => ({ ...s, smooth: v / 100 }), 30)}
          <p className="hint">Covers the parts of the picture between these two brightnesses.</p>
        </>
      )}
      {s.type === 'colour' && (
        <>
          {slider('hue', 'Hue', s.hue, 0, 360, (v) => ({ ...s, hue: v }), 0)}
          {slider('range', 'Range', s.range, 1, 180, (v) => ({ ...s, range: v }), 30)}
          {slider('sat', 'Min colour', s.sat * 100, 0, 100, (v) => ({ ...s, sat: v / 100 }), 20)}
          {slider('smooth', 'Smoothness', s.smooth * 100, 0, 100, (v) => ({ ...s, smooth: v / 100 }), 40)}
          <button type="button" className="btn sm" aria-pressed={picking} disabled={zoomed} onClick={() => store().setPicking(!picking)} title="Then click a colour on the picture">
            Pick colour from the picture
          </button>
          {picking && <p className="hint">Click a colour on the picture.</p>}
          {zoomed && <p className="hint">Press Z to fit the whole picture first, then pick.</p>}
        </>
      )}
    </fieldset>
  )
}

/** The shapes of one mask: its first and the ones combined with it, each with how it combines. */
function Shapes({ mask }: { mask: Mask }) {
  const part = useDevelop((s) => s.selectedPart)
  const store = () => useDevelop.getState()
  const full = mask.parts.length >= MAX_PARTS
  return (
    <fieldset className="sgroup">
      <legend>Combine shapes</legend>
      <ul className="mask-list" aria-label="Shapes of this mask">
        <li className={part === null ? 'sel' : ''}>
          <button type="button" className="mask-name" aria-pressed={part === null} onClick={() => store().selectPart(null)}>
            <span className="trunc">Base</span>
            <small className="muted">{MASK_TYPE_LABEL[mask.shape.type]}</small>
          </button>
        </li>
        {mask.parts.map((p, i) => (
          <li key={i} className={part === i ? 'sel' : ''}>
            <button type="button" className="mask-name" aria-pressed={part === i} onClick={() => store().selectPart(i)}>
              <span className="trunc">{MASK_TYPE_LABEL[p.shape.type]}</span>
            </button>
            <select className="field op" aria-label={`How shape ${i + 2} combines`} value={p.op} onChange={(e) => void store().setPartOp(mask.id, i, e.target.value as MaskOp)}>
              {OPS.map((o) => (
                <option key={o} value={o}>
                  {MASK_OP_LABEL[o]}
                </option>
              ))}
            </select>
            <button type="button" className="x" aria-label={`Remove shape ${i + 2}`} onClick={() => void store().removePart(mask.id, i)}>
              ×
            </button>
          </li>
        ))}
      </ul>
      <div className="row" role="group" aria-label="Combine with another shape">
        {TYPES.map((t) => (
          <button key={t} type="button" className="btn sm" disabled={full} title={`Combine with a ${MASK_TYPE_LABEL[t].toLowerCase()}`} onClick={() => void store().addPart(mask.id, t)}>
            {COMBINE_BUTTON[t]}
          </button>
        ))}
      </div>
      <p className="hint">Ranges narrow what is covered; other shapes add to it. Change a shape's effect with the list above.</p>
    </fieldset>
  )
}

function MaskEditor({ mask }: { mask: Mask }) {
  const showMask = useDevelop((s) => s.showMask)
  const part = useDevelop((s) => s.selectedPart)
  const [name, setName] = useState(mask.name)
  useEffect(() => setName(mask.name), [mask.id, mask.name])
  const store = () => useDevelop.getState()
  const before = () => maskById(store().saved, mask.id)

  const rename = () => {
    const n = name.split(/\s+/).filter(Boolean).join(' ').slice(0, 100)
    if (!n || n === mask.name) return setName(mask.name)
    store().liveMask(mask.id, { name: n })
    void store().commit({ label: `Rename ${mask.name}`, deltaText: null, valueText: n })
  }

  return (
    <div className="mask-editor">
      <label className="stack">
        Name
        <input className="field" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} onBlur={rename} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
      </label>
      <div className="row">
        <button type="button" className="btn sm" aria-pressed={mask.invert} onClick={() => void store().setAndCommit({ masks: withMask(store().recipe, mask.id, { invert: !mask.invert }) }, { label: `${mask.name}: invert`, deltaText: null, valueText: null })}>
          Invert
        </button>
        <button type="button" className="btn sm" aria-pressed={showMask} onClick={() => store().toggleShowMask()} title="Tint the mask red on the picture">
          Show mask
        </button>
      </div>

      <Shapes mask={mask} />
      <ShapeSettings mask={mask} part={part} />

      <fieldset className="sgroup">
        <legend>Adjustments</legend>
        {MASK_ADJUSTMENTS.map((d) => (
          <SliderRow
            key={d.key}
            id={`sl-mask-${mask.id}-${d.key}`}
            label={d.label}
            value={mask.adjust[d.key]}
            min={d.min}
            max={d.max}
            step={d.step}
            digits={d.digits}
            onLive={(v) => store().live({ masks: withAdjust(store().recipe, mask.id, d.key, v) })}
            onCommit={() => {
              const now = maskById(store().recipe, mask.id)
              if (now) void store().commit(adjustStep(now, d, before()))
            }}
            onReset={() => {
              store().live({ masks: withAdjust(store().recipe, mask.id, d.key, 0) })
              const now = maskById(store().recipe, mask.id)
              if (now) void store().commit(adjustStep(now, d, before()))
            }}
          />
        ))}
      </fieldset>
    </div>
  )
}

export function MasksPanel() {
  const hideAi = usePrefs((s) => s.hideAi)
  const masks = useDevelop((s) => s.recipe.masks)
  const selected = useDevelop((s) => s.selectedMask)
  const zoomed = useDevelop((s) => s.zoom.on)
  const current = masks.find((m) => m.id === selected)
  const full = masks.length >= MAX_MASKS
  const selecting = useDevelop((s) => s.selecting)
  const objectTool = useDevelop((s) => s.objectTool)
  return (
    <Panel title="Masks">
      <div className="row" role="group" aria-label="Add a mask">
        {TYPES.map((t) => (
          <button key={t} type="button" className="btn sm" disabled={full} title={`Add a ${MASK_TYPE_LABEL[t].toLowerCase()} mask`} onClick={() => void useDevelop.getState().addMask(t)}>
            {NEW_BUTTON[t]}
          </button>
        ))}
      </div>
      <div className="row" role="group" aria-label="Select automatically">
        {!hideAi && (
        <>
        <button type="button" className="btn sm" disabled={full || selecting} aria-busy={selecting} title="Find the main subject and mask it" onClick={() => void useDevelop.getState().addAutoMask('subject')}>
          + Subject
        </button>
        <button type="button" className="btn sm" disabled={full || selecting} aria-busy={selecting} title="Find the main subject and mask everything else" onClick={() => void useDevelop.getState().addAutoMask('background')}>
          + Background
        </button>
        <button type="button" className="btn sm" disabled={full || selecting} aria-busy={selecting} title="Measure how far away each part is and mask the near part" onClick={() => void useDevelop.getState().addAutoMask('near')}>
          + Near
        </button>
        <button type="button" className="btn sm" disabled={full || selecting} aria-pressed={objectTool} title="Click an object in the picture to mask it. The first time on a photo it takes several seconds." onClick={() => useDevelop.getState().setObjectTool(!objectTool)}>
          + Object
        </button>
        <button type="button" className="btn sm" disabled={full || selecting} aria-busy={selecting} title="Measure how far away each part is and mask the far part" onClick={() => void useDevelop.getState().addAutoMask('far')}>
          + Far
        </button>
        </>
        )}
        <button type="button" className="btn sm" disabled={full} title="Find the sky and mask it" onClick={() => void useDevelop.getState().addAutoMask('sky')}>
          + Sky
        </button>
      </div>
      {!hideAi && (
        <div className="row" role="group" aria-label="Select a part of a person">
          {PERSON_PARTS.map(({ part, label }) => (
            <button key={part} type="button" className="btn sm" disabled={full || selecting} aria-busy={selecting} title={`Find the faces and mask their ${label.toLowerCase()}`} onClick={() => void useDevelop.getState().addPersonMask(part)}>
              + {label}
            </button>
          ))}
        </div>
      )}
      {objectTool && <p className="hint">Click the object you want on the picture.</p>}
      {selecting && (
        <p className="hint" role="status">
          Looking for the subject…
        </p>
      )}
      {zoomed && <p className="hint">Masks are edited with the whole picture in view. Press Z to fit it.</p>}
      {masks.length === 0 ? (
        <p className="hint">A mask limits adjustments to one part of the picture. Add one to begin.</p>
      ) : (
        <ul className="mask-list" aria-label="Masks">
          {masks.map((m) => (
            <li key={m.id} className={m.id === selected ? 'sel' : ''}>
              <button type="button" className="mask-name" aria-pressed={m.id === selected} onClick={() => useDevelop.getState().selectMask(m.id === selected ? null : m.id)}>
                <span className="trunc">{m.name}</span>
                <small className="muted">
                  {MASK_TYPE_LABEL[m.shape.type]}
                  {m.parts.length ? ` +${m.parts.length}` : ''}
                </small>
              </button>
              <button
                type="button"
                className="x"
                aria-pressed={m.visible}
                aria-label={m.visible ? `Hide ${m.name}` : `Show ${m.name}`}
                title={m.visible ? 'Hide this mask' : 'Show this mask'}
                onClick={() => void useDevelop.getState().setAndCommit({ masks: withMask(useDevelop.getState().recipe, m.id, { visible: !m.visible }) }, { label: `${m.visible ? 'Hide' : 'Show'} ${m.name}`, deltaText: null, valueText: null })}
              >
                {m.visible ? 'On' : 'Off'}
              </button>
              <button type="button" className="x" aria-label={`Delete ${m.name}`} onClick={() => void useDevelop.getState().deleteMask(m.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      {current && <MaskEditor mask={current} />}
      {masks.length > 0 && !current && <p className="hint">Pick a mask to edit it.</p>}
    </Panel>
  )
}
