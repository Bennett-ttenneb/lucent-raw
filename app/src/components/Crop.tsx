import { useEffect, useRef, useState } from 'react'
import { reframeRecipe } from '../lib/localmap'
import { straightenAngle, customRatio, CROP_HANDLES, HANDLE_LABEL, guideLines, currentRect, dragHandle, handlePoint, moveRect, nudgeHandle, rectForAspect, swapRect, type CropHandle, type Pt } from '../lib/cropedit'
import { useCropPrefs, type CropGrid } from '../lib/cropPrefs'
import { cropIsDefault, cropLabel, useDevelop } from '../lib/develop'
import { num } from '../lib/format'
import { ASPECTS, type Aspect, type CropRect, type Recipe } from '../lib/types'
import type { Box } from './Masks'
import { Panel } from './Primitives'
import { SliderRow } from './SliderRow'

const CURSOR: Record<CropHandle, string> = { tl: 'nwse-resize', br: 'nwse-resize', tr: 'nesw-resize', bl: 'nesw-resize', t: 'ns-resize', b: 'ns-resize', l: 'ew-resize', r: 'ew-resize' }
const HANDLE_SIZE = 10

const store = () => useDevelop.getState()
const withRect = (rect: CropRect | null): Recipe['crop'] => ({ ...store().recipe.crop, rect })

/**
 * The crop frame on the whole (uncropped) picture: a dimmed surround, a grid, a body to move the frame by and eight points
 * to resize it. `box` is where the picture is drawn in screen pixels, `size` the picture's own size.
 */
export function CropOverlay({ box, size }: { box: Box; size: { w: number; h: number } }) {
  const crop = useDevelop((s) => s.recipe.crop)
  const request = useDevelop((s) => s.cropRequest)
  const grid = useCropPrefs((s) => s.grid)
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<{ kind: 'move' | CropHandle; start: CropRect; from: Pt; offset: Pt } | null>(null)
  const pause = useRef<ReturnType<typeof setTimeout>>(undefined)
  const straighten = useDevelop((s) => s.straightenTool)
  /** the line being drawn with the Straighten tool, as fractions of the picture */
  const [line, setLine] = useState<{ a: Pt; b: Pt } | null>(null)
  const { w: W, h: H } = size
  const rect = currentRect(crop, W, H)
  const nudgeFrom = useRef<CropRect | null>(null)
  /** the pixels a frame takes of the whole picture */
  const frame = (r: CropRect) => ({ x: (r.cx - r.w / 2) * W, y: (r.cy - r.h / 2) * H, w: r.w * W, h: r.h * H })
  /** the masks, spots, red-eye circles and faces stay on the same part of the picture when the frame moves (not while the frame is tilted) */
  const carry = (from: CropRect) => {
    const s = store()
    const r = s.recipe
    if (r.crop.angle !== 0 || r.masks.length + r.spots.length + r.redEyes.length + r.portraits.length === 0) return
    const moved = reframeRecipe(r, frame(from), frame(currentRect(r.crop, W, H)))
    s.live({ masks: moved.masks, spots: moved.spots, redEyes: moved.redEyes, portraits: moved.portraits })
  }
  /** locked to the shape it has now, unless the aspect is Free */
  const ratio = crop.aspect === 'free' ? null : (rect.w * W) / (rect.h * H)
  useEffect(() => () => clearTimeout(pause.current), [])

  // an aspect or a swap picked in the panel: needs the picture's size, which only the frame knows
  useEffect(() => {
    if (!request) return
    const s = store()
    const cur = currentRect(s.recipe.crop, W, H)
    if (request.kind === 'aspect') {
      const next = rectForAspect(cur, request.aspect, s.recipe.crop.angle, W, H)
      s.live({ crop: { ...s.recipe.crop, aspect: request.aspect, rect: request.aspect === 'free' ? s.recipe.crop.rect : next } })
      carry(cur)
      void s.commit({ label: 'Crop', deltaText: null, valueText: cropLabel({ ...s.recipe.crop, aspect: request.aspect }) })
    } else {
      s.live({ crop: withRect(swapRect(cur, s.recipe.crop.angle, W, H)) })
      void s.commit({ label: 'Crop', deltaText: null, valueText: 'Turned' })
    }
    s.requestCrop(null)
  }, [request, W, H])

  const { w, h } = box
  const norm = (e: { clientX: number; clientY: number }): Pt => {
    const r = svg.current!.getBoundingClientRect()
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]
  }
  const live = (r: CropRect) => store().live({ crop: withRect(r) })
  const commit = () => void store().commit({ label: 'Crop frame', deltaText: null, valueText: null })
  const commitSoon = () => {
    clearTimeout(pause.current)
    pause.current = setTimeout(() => {
      if (nudgeFrom.current) carry(nudgeFrom.current)
      nudgeFrom.current = null
      commit()
    }, 600)
  }

  const grab = (kind: 'move' | CropHandle) => (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation() // not a click on the picture, which would zoom
    const from = norm(e)
    const at = kind === 'move' ? from : handlePoint(rect, kind, crop.angle, W, H)
    drag.current = { kind, start: rect, from, offset: [at[0] - from[0], at[1] - from[1]] }
    svg.current!.setPointerCapture(e.pointerId)
  }
  const finishLine = (e: React.PointerEvent) => {
    if (!line) return
    const deg = straightenAngle(line.a, norm(e), W, H)
    setLine(null)
    if (deg === null) return // too short: a click, not a line
    const d = store()
    d.live({ crop: { ...d.recipe.crop, angle: deg } })
    void d.commit({ label: 'Straighten', deltaText: null, valueText: `${num(deg, 1)}°` })
    d.setStraightenTool(false)
  }
  const move = (e: React.PointerEvent) => {
    if (line) return setLine({ a: line.a, b: norm(e) })
    const d = drag.current
    if (!d) return
    const p = norm(e)
    if (d.kind === 'move') live(moveRect(d.start, p[0] - d.from[0], p[1] - d.from[1], crop.angle, W, H))
    else live(dragHandle(d.start, d.kind, [p[0] + d.offset[0], p[1] + d.offset[1]], crop.angle, W, H, ratio))
  }
  const up = () => {
    if (!drag.current) return
    const from = drag.current.start
    drag.current = null
    carry(from)
    commit()
  }
  const arrow = (e: React.KeyboardEvent): Pt | null => {
    const step = e.shiftKey ? 0.02 : 0.004
    const delta: Record<string, Pt> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    return delta[e.key] ?? null
  }
  const keys = (kind: 'move' | CropHandle) => (e: React.KeyboardEvent) => {
    const d = arrow(e)
    if (!d) return
    e.preventDefault()
    e.stopPropagation() // the arrow keys also step to the next photo; here they belong to the frame
    nudgeFrom.current ??= rect
    live(kind === 'move' ? moveRect(rect, d[0], d[1], crop.angle, W, H) : nudgeHandle(rect, kind, d, crop.angle, W, H, ratio))
    commitSoon()
  }

  // everything is drawn in screen pixels, in the frame's own turned axes
  const [cx, cy, hw, hh] = [rect.cx * w, rect.cy * h, (rect.w * w) / 2, (rect.h * h) / 2]
  const corners = (['tl', 'tr', 'br', 'bl'] as CropHandle[]).map((c) => handlePoint(rect, c, crop.angle, W, H))
  const hole = corners.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0] * w} ${p[1] * h}`).join(' ') + 'Z'
  const guides = guideLines(grid, hw, hh)
  return (
    <svg
      ref={svg}
      className="crop-layer"
      style={{ left: box.left, top: box.top, width: w, height: h }}
      viewBox={`0 0 ${w} ${h}`}
      role="group"
      aria-label="Crop frame"
      onPointerMove={move}
      onPointerUp={(e) => (line ? finishLine(e) : up())}
      onPointerCancel={() => (setLine(null), up())}
    >
      <path className="crop-dim" fillRule="evenodd" d={`M0 0H${w}V${h}H0Z ${hole}`} />
      <g transform={`translate(${cx} ${cy}) rotate(${crop.angle})`}>
        <rect className="crop-body" x={-hw} y={-hh} width={hw * 2} height={hh * 2} tabIndex={0} role="button" aria-label="Crop frame: drag to move, arrow keys nudge" onPointerDown={grab('move')} onKeyDown={keys('move')} />
        {guides.map((group, i) => (
          <g key={i} className="crop-grid" aria-hidden>
            {group.map(([x1, y1, x2, y2], k) => (
              <line key={k} x1={x1} y1={y1} x2={x2} y2={y2} />
            ))}
          </g>
        ))}
        {CROP_HANDLES.map((handle) => {
          const [dx, dy] = { tl: [-1, -1], t: [0, -1], tr: [1, -1], r: [1, 0], br: [1, 1], b: [0, 1], bl: [-1, 1], l: [-1, 0] }[handle]
          return (
            <rect
              key={handle}
              className={`crop-handle ${dx !== 0 && dy !== 0 ? 'corner' : ''}`}
              x={dx * hw - HANDLE_SIZE / 2}
              y={dy * hh - HANDLE_SIZE / 2}
              width={HANDLE_SIZE}
              height={HANDLE_SIZE}
              style={{ cursor: CURSOR[handle] }}
              tabIndex={0}
              role="button"
              aria-label={`Crop ${HANDLE_LABEL[handle]}`}
              onPointerDown={grab(handle)}
              onKeyDown={keys(handle)}
            />
          )
        })}
      </g>
      {straighten && (
        <g>
          <rect
            className="straighten-catch"
            x={0}
            y={0}
            width={w}
            height={h}
            fill="transparent"
            style={{ cursor: 'crosshair' }}
            role="application"
            aria-label="Straighten: drag a line along something that should be level or upright"
            onPointerDown={(e) => {
              if (e.button !== 0) return
              e.stopPropagation()
              const p = norm(e)
              setLine({ a: p, b: p })
              svg.current!.setPointerCapture(e.pointerId)
            }}
          />
          {line && <line className="straighten-line" x1={line.a[0] * w} y1={line.a[1] * h} x2={line.b[0] * w} y2={line.b[1] * h} stroke="#ffd34d" strokeWidth={2} strokeDasharray="6 4" pointerEvents="none" />}
        </g>
      )}
    </svg>
  )
}

const ASPECT_LABEL: Record<Aspect, string> = { original: 'Original', free: 'Free', '1:1': '1:1', '4:3': '4:3', '3:2': '3:2', '16:9': '16:9', '5:4': '5:4' }
const GRID_LABEL: Record<CropGrid, string> = { thirds: 'Thirds', golden: 'Golden ratio', diagonal: 'Diagonals', triangle: 'Triangles', fine: 'Fine', off: 'None' }

export function CropPanel() {
  const crop = useDevelop((s) => s.recipe.crop)
  const editing = useDevelop((s) => s.cropEdit)
  const straightenTool = useDevelop((s) => s.straightenTool)
  const grid = useCropPrefs((s) => s.grid)
  const set = (patch: Partial<Recipe['crop']>, label: string, valueText: string) => {
    const d = store()
    d.live({ crop: { ...d.recipe.crop, ...patch } })
    return d.commit({ label, deltaText: null, valueText })
  }
  // a ratio of your own: two numbers, such as 7 and 5, or 2.35 and 1
  const [ratioW, setRatioW] = useState('')
  const [ratioH, setRatioH] = useState('')
  const customAspect = `${ratioW}:${ratioH}`
  const customOk = customRatio(customAspect) !== null
  const pick = (a: Aspect) => {
    if (crop.rect && a !== 'original' && a !== 'free') return store().requestCrop({ kind: 'aspect', aspect: a }) // keeps the frame about where it is
    // with no placed frame (or going back to the picture's own shape) the core draws the biggest centred frame itself
    void set({ aspect: a, rect: a === 'original' ? null : crop.rect }, 'Crop', cropLabel({ ...crop, aspect: a }))
  }
  return (
    <Panel
      title="Crop and straighten"
      action={
        <button type="button" className="btn sm" aria-pressed={editing} title="Show the whole picture with the crop frame on it (C)" onClick={() => store().setCropEdit(!editing)}>
          {editing ? 'Done' : 'Frame tool'}
        </button>
      }
    >
      <div className="aspects" role="group" aria-label="Aspect ratio">
        {ASPECTS.map((a: Aspect) => (
          <button key={a} type="button" className="btn sm" aria-pressed={crop.aspect === a} onClick={() => pick(a)}>
            {ASPECT_LABEL[a]}
          </button>
        ))}
        <button type="button" className="btn sm" title="Turn the frame from landscape to portrait and back" onClick={() => store().requestCrop({ kind: 'swap' })}>
          Turn frame
        </button>
      </div>
      <div className="row custom-ratio" role="group" aria-label="Ratio of your own">
        <span className="muted">Your ratio</span>
        <input className="field narrow" type="text" inputMode="decimal" aria-label="Ratio width" placeholder="7" value={ratioW} onChange={(e) => setRatioW(e.target.value.replace(/[^0-9.]/g, '').slice(0, 6))} />
        <span aria-hidden>:</span>
        <input className="field narrow" type="text" inputMode="decimal" aria-label="Ratio height" placeholder="5" value={ratioH} onChange={(e) => setRatioH(e.target.value.replace(/[^0-9.]/g, '').slice(0, 6))} />
        <button type="button" className="btn sm" disabled={!customOk} aria-pressed={crop.aspect === customAspect} onClick={() => pick(customAspect as Aspect)}>
          Use
        </button>
        {ratioW !== '' && ratioH !== '' && !customOk && (
          <span className="err" role="alert">
            Use numbers from 0.1 to 100.
          </span>
        )}
      </div>
      <button type="button" className="btn sm" aria-pressed={straightenTool} title="Drag a line along the horizon or an upright edge: the frame turns to make it level" onClick={() => store().setStraightenTool(!straightenTool)}>
        Straighten tool
      </button>
      <SliderRow
        id="sl-angle"
        label="Angle"
        value={crop.angle}
        min={-45}
        max={45}
        step={0.1}
        digits={1}
        onLive={(v) => store().live({ crop: { ...store().recipe.crop, angle: v } })}
        onCommit={() => void store().commit({ label: 'Straighten', deltaText: null, valueText: `${num(store().recipe.crop.angle, 1)}°` })}
        onReset={() => void set({ angle: 0 }, 'Reset angle', '0°')}
      />
      <div className="aspects grid3" role="group" aria-label="Grid">
        <span className="muted grid-label">Grid</span>
        {(Object.keys(GRID_LABEL) as CropGrid[]).map((g) => (
          <button key={g} type="button" className="btn sm" aria-pressed={grid === g} onClick={() => useCropPrefs.getState().setGrid(g)}>
            {GRID_LABEL[g]}
          </button>
        ))}
      </div>
      <button type="button" className="btn sm" disabled={cropIsDefault(crop)} onClick={() => void set({ aspect: 'original', angle: 0, rect: null }, 'Reset crop', 'Original')}>
        Reset crop
      </button>
      <p className="hint">Frame tool: drag inside the frame to move it, drag a corner or edge to resize it. Arrow keys nudge a focused point (Shift for more). The angle turns the frame over the picture. Straighten tool: drag a line along the horizon or an upright edge.</p>
    </Panel>
  )
}
