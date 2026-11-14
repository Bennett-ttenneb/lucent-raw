import { useEffect, useMemo, useRef, useState } from 'react'
import { usePrefs } from '../lib/prefs'
import { withPanelsOff } from '../lib/panelEyes'
import { SoftProofPanel } from './SoftProof'
import { ProfileRow } from './Profiles'
import { useProof } from '../lib/proof'
import { ToolStrip } from './ToolStrip'
import { GradingPanel } from './Grading'
import { CalibrationPanel } from './Calibration'
import { LicenceBanner } from './Licence'
import { api } from '../lib/api'
import { useSliderPrefs } from '../lib/sliderPrefs'
import { PARAMETRIC_KEYS, type ParametricKey, BANDS, BAND_COLOURS, BASIC_GROUPS, DEFAULT_RECIPE, GRAIN, LENS, TRANSFORM, geometryStep, lensIsDefault, transformIsDefault, type GeometryDef, MIXER_KINDS, MIXER_KIND_LABEL, NOISE_REDUCTION, SHARPENING, VIGNETTE, cropKey, detailIsDefault, detailStep, effectStep, effectsIsDefault, isDefault, mixerIsDefault, mixerStep, recipesEqual, stepForSlider, useDevelop, windowFor, withMixer, type DetailDef, type EffectDef, type MixerKind, type SliderDef, type ZoomState } from '../lib/develop'
import { anyPortraitActive } from '../lib/portraitedit'
import { addPoint, curveValues, isStraight, movePoint, type Point } from '../lib/curve'
import { num } from '../lib/format'
import { useStore } from '../lib/store'
import type { HistoryRow, Recipe } from '../lib/types'
import { rgbToHueSat } from '../lib/maskedit'
import { useTheme } from '../lib/theme'
import { pictureFraction, pixelAt, readoutText } from '../lib/readout'
import { turnRecipe, type TurnOp } from '../lib/localmap'
import { ClippingOverlay } from './Clipping'
import { SpotMap } from './SpotMap'
import { CropOverlay, CropPanel } from './Crop'
import { MaskOverlay, MasksPanel, type Box } from './Masks'
import { PortraitOverlay, PortraitPanels } from './Portrait'
import { EnlargePanel } from './Enlarge'
import { BBotPanel } from './BBot'
import { RedEyeOverlay, RedEyePanel } from './RedEye'
import { SpotOverlay, SpotsPanel } from './Spots'
import { CopyDialog, PresetsPanel, SnapshotsPanel, SyncDialog } from './Presets'
import { NavigatorPanel } from './Navigator'
import { Panel } from './Primitives'
import { SliderRow } from './SliderRow'

// Channel colours for the histogram. These identify red, green and blue in a chart, so they do not follow the theme.
const HIST = { r: 'rgb(230,70,70)', g: 'rgb(70,200,90)', b: 'rgb(80,120,240)' }

/** While a slider is being dragged the picture is rendered smaller, which is several times faster. */
const DRAG_EDGE = 1100
/** While a brush stroke is being drawn it is smaller still, so the picture keeps up with the hand. */
const PAINT_EDGE = 640
/** Lens and transform bend every pixel, so while one of them is dragged the picture is rendered smaller still. */
const GEOMETRY_EDGE = 800
/** Texture, Clarity and Dehaze look around every pixel, so while one of them is dragged the picture is drawn a little smaller. */
const PRESENCE_EDGE = 800

interface Shown {
  url: string
  img: HTMLImageElement
  /** the window of the full-size picture this shows, or null for the whole picture fitted to the screen */
  win: { x: number; y: number; w: number; h: number } | null
}

/**
 * Shows the rendered picture for the current recipe. One request at a time: while a render is
 * running only the newest wish is remembered, so dragging a slider or panning never builds a queue
 * of pictures nobody will see. The new picture replaces the old one only once it has loaded.
 * At 1:1 it asks for the window of the full-size picture that fills the stage.
 */
function useRendered(photoId: number | null, recipe: Recipe, saved: Recipe, showOriginal: boolean, version: number, zoom: ZoomState, hover: Recipe | null, overlayId: string | undefined, painting: boolean, framing: boolean, proof: { gamut: boolean; rev: number } | undefined) {
  const [shown, setShown] = useState<Shown | null>(null)
  const [failed, setFailed] = useState(false)
  const loop = useRef({ busy: false, want: null as { url: string; win: Shown['win'] } | null, epoch: 0 })
  // a preset under the pointer is shown as if applied (fitted view only), rendered small like a drag
  const previewing = !!hover && !zoom.on && !showOriginal
  const dragging = previewing || (!showOriginal && !recipesEqual(recipe, saved))
  const win = zoom.on ? windowFor(zoom.cx, zoom.cy, zoom.width, zoom.height, zoom.vw, zoom.vh) : null
  // "Before" at 1:1 keeps the crop, so the full-size picture prepared for it still fits
  // the frame tool shows the whole picture to frame, so the crop (and what is placed on the cropped picture) is left out
  const base = showOriginal ? (zoom.on ? { ...DEFAULT_RECIPE, crop: recipe.crop } : DEFAULT_RECIPE) : framing ? { ...recipe, crop: DEFAULT_RECIPE.crop, masks: [], spots: [], redEyes: [], portraits: [] } : previewing ? hover : recipe
  const url =
    photoId === null ? null : win ? api().regionUrl(photoId, base, win.x, win.y, win.w, win.h, version) : api().renderUrl(photoId, base, version, painting ? PAINT_EDGE : dragging ? (lensIsDefault(base) && transformIsDefault(base) && !anyPortraitActive(base.portraits) ? (base.texture !== 0 || base.clarity !== 0 || base.dehaze !== 0 ? PRESENCE_EDGE : DRAG_EDGE) : GEOMETRY_EDGE) : 0, previewing || showOriginal ? undefined : overlayId, showOriginal ? undefined : proof)

  useEffect(() => {
    const st = loop.current
    st.epoch++ // a different photo: drop anything still loading for the old one
    st.want = null
    setShown(null)
    setFailed(false)
  }, [photoId])

  useEffect(() => {
    const st = loop.current
    if (!url) return
    st.want = { url, win }
    const pump = () => {
      if (st.busy || !st.want) return
      const target = st.want
      const epoch = st.epoch
      st.want = null
      st.busy = true
      const img = new Image()
      img.crossOrigin = 'anonymous' // so the histogram can read the pixels
      const finish = (ok: boolean) => {
        st.busy = false
        if (epoch === st.epoch) {
          if (ok) setShown({ url: target.url, img, win: target.win })
          setFailed(!ok)
        }
        pump() // anything asked for while this one was loading
      }
      img.onload = () => finish(true)
      img.onerror = () => finish(false)
      img.src = target.url
    }
    pump()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url])
  return { shown, failed, win }
}

export function Histogram({ img }: { img: HTMLImageElement | null }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const theme = useTheme((s) => s.theme) // drawn again when the theme changes
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const ctx = cv.getContext('2d')
    if (!ctx) return
    ctx.clearRect(0, 0, cv.width, cv.height)
    if (!img) return
    try {
      const w = 160
      const h = Math.max(1, Math.round((img.naturalHeight / img.naturalWidth) * w))
      const off = document.createElement('canvas')
      off.width = w
      off.height = h
      const octx = off.getContext('2d', { willReadFrequently: true })!
      octx.drawImage(img, 0, 0, w, h)
      const px = octx.getImageData(0, 0, w, h).data
      const bins = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
      for (let i = 0; i < px.length; i += 4) {
        bins[0][px[i]]++
        bins[1][px[i + 1]]++
        bins[2][px[i + 2]]++
      }
      const peak = Math.max(1, ...bins.flatMap((b) => Array.from(b.slice(1, 255)))) // ignore the end bins so clipping does not flatten the rest
      // the three colours add up to white on a dark graph; on a light one they are laid over it instead
      ctx.globalCompositeOperation = document.documentElement.dataset.theme === 'light' ? 'source-over' : 'lighter'
      ;[HIST.r, HIST.g, HIST.b].forEach((colour, c) => {
        ctx.fillStyle = colour
        ctx.globalAlpha = 0.7
        for (let x = 0; x < 256; x++) {
          const v = Math.min(1, bins[c][x] / peak)
          ctx.fillRect(x, cv.height - v * cv.height, 1, v * cv.height)
        }
      })
    } catch {
      // a picture the browser will not let us read: leave the histogram empty
    }
  }, [img, theme])
  return <canvas ref={ref} className="hist" width={256} height={80} role="img" aria-label="Histogram of the edited photo" />
}

function Slider({ def }: { def: SliderDef }) {
  const value = useDevelop((s) => s.recipe[def.key])
  return (
    <SliderRow
      id={`sl-${def.key}`}
      label={def.label}
      value={value}
      min={def.min}
      max={def.max}
      step={def.step}
      digits={def.digits}
      gradient={def.gradient}
      onLive={(v) => useDevelop.getState().live({ [def.key]: v })}
      onCommit={() => void useDevelop.getState().commit(stepForSlider(def.key, useDevelop.getState().saved, useDevelop.getState().recipe))}
      onReset={() => void useDevelop.getState().resetSlider(def.key)}
    />
  )
}

function MixerRow({ kind, band }: { kind: MixerKind; band: number }) {
  const value = useDevelop((s) => s.recipe.hsl[kind][band])
  return (
    <SliderRow
      id={`sl-mix-${kind}-${band}`}
      label={BANDS[band]}
      swatch={BAND_COLOURS[band]}
      value={value}
      min={-100}
      max={100}
      step={1}
      digits={0}
      onLive={(v) => useDevelop.getState().live({ hsl: withMixer(useDevelop.getState().recipe, kind, band, v) })}
      onCommit={() => void useDevelop.getState().commit(mixerStep(kind, band, useDevelop.getState().saved, useDevelop.getState().recipe))}
      onReset={() => {
        const d = useDevelop.getState()
        if (d.recipe.hsl[kind][band] === 0) return
        d.live({ hsl: withMixer(d.recipe, kind, band, 0) })
        void d.commit({ label: `Reset ${BANDS[band].toLowerCase()} ${MIXER_KIND_LABEL[kind].toLowerCase()}`, deltaText: null, valueText: '0' })
      }}
    />
  )
}

function MixerPanel() {
  const [kind, setKind] = useState<MixerKind>('hue')
  const edited = useDevelop((s) => !mixerIsDefault(s.recipe))
  return (
    <Panel
      title="Colour mixer"
      action={
        <button
          type="button"
          className="btn sm ghost"
          disabled={!edited}
          onClick={() => void useDevelop.getState().setAndCommit({ hsl: DEFAULT_RECIPE.hsl }, { label: 'Reset colour mixer', deltaText: null, valueText: null })}
        >
          Reset
        </button>
      }
    >
      <div className="aspects tabs" role="group" aria-label="Colour mixer adjustment">
        {MIXER_KINDS.map((k) => (
          <button key={k} type="button" className="btn sm" aria-pressed={kind === k} onClick={() => setKind(k)}>
            {MIXER_KIND_LABEL[k]}
          </button>
        ))}
      </div>
      {BANDS.map((_, band) => (
        <MixerRow key={`${kind}-${band}`} kind={kind} band={band} />
      ))}
    </Panel>
  )
}

function DetailRow({ def }: { def: DetailDef }) {
  const value = useDevelop((s) => s.recipe.detail[def.key])
  const neutral = DEFAULT_RECIPE.detail[def.key]
  const set = (v: number) => useDevelop.getState().live({ detail: { ...useDevelop.getState().recipe.detail, [def.key]: v } })
  return (
    <SliderRow
      id={`sl-detail-${def.key}`}
      label={def.label}
      value={value}
      min={def.min}
      max={def.max}
      step={def.step_}
      digits={def.digits}
      neutral={neutral}
      onLive={set}
      onCommit={() => void useDevelop.getState().commit(detailStep(def.key, useDevelop.getState().saved, useDevelop.getState().recipe))}
      onReset={() => {
        const d = useDevelop.getState()
        if (d.recipe.detail[def.key] === neutral) return
        set(neutral)
        void d.commit({ label: `Reset ${def.step.toLowerCase()}`, deltaText: null, valueText: num(neutral, def.digits) })
      }}
    />
  )
}

function DetailPanel() {
  const edited = useDevelop((s) => !detailIsDefault(s.recipe))
  return (
    <Panel
      title="Detail"
      action={
        <button
          type="button"
          className="btn sm ghost"
          disabled={!edited}
          onClick={() => void useDevelop.getState().setAndCommit({ detail: DEFAULT_RECIPE.detail }, { label: 'Reset detail', deltaText: null, valueText: null })}
        >
          Reset
        </button>
      }
    >
      <fieldset className="sgroup">
        <legend>Sharpening</legend>
        {SHARPENING.map((d) => (
          <DetailRow key={d.key} def={d} />
        ))}
      </fieldset>
      <fieldset className="sgroup">
        <legend>Noise reduction</legend>
        {NOISE_REDUCTION.map((d) => (
          <DetailRow key={d.key} def={d} />
        ))}
      </fieldset>
      <p className="hint">Sharpening and noise are easiest to judge up close. The picture is shown whole, so the effect looks subtle here and shows fully in an export.</p>
    </Panel>
  )
}

function GeometryRow({ def }: { def: GeometryDef }) {
  const value = useDevelop((s) => s.recipe.geometry[def.key])
  const set = (v: number) => useDevelop.getState().live({ geometry: { ...useDevelop.getState().recipe.geometry, [def.key]: v } })
  return (
    <SliderRow
      id={`sl-geo-${def.key}`}
      label={def.label}
      value={value}
      min={def.min}
      max={def.max}
      step={def.step}
      digits={def.digits}
      neutral={def.neutral}
      onLive={set}
      onCommit={() => void useDevelop.getState().commit(geometryStep(def, useDevelop.getState().saved, useDevelop.getState().recipe))}
      onReset={() => {
        const d = useDevelop.getState()
        if (d.recipe.geometry[def.key] === def.neutral) return
        set(def.neutral)
        void d.commit({ label: `Reset ${def.label.toLowerCase()}`, deltaText: null, valueText: num(def.neutral, def.digits) })
      }}
    />
  )
}

function LensPanel() {
  const edited = useDevelop((s) => !lensIsDefault(s.recipe))
  return (
    <Panel
      title="Lens corrections"
      action={
        <button
          type="button"
          className="btn sm ghost"
          disabled={!edited}
          onClick={() => {
            const d = useDevelop.getState()
            void d.setAndCommit({ geometry: { ...d.recipe.geometry, distortion: 0, caRed: 0, caBlue: 0 } }, { label: 'Reset lens corrections', deltaText: null, valueText: null })
          }}
        >
          Reset
        </button>
      }
    >
      {LENS.map((d) => (
        <GeometryRow key={d.key} def={d} />
      ))}
      <p className="hint">Set by eye: there is no lens database. Distortion above 0 pushes the edges outward (barrel), below 0 pulls them in (pincushion).</p>
    </Panel>
  )
}

function TransformPanel() {
  const edited = useDevelop((s) => !transformIsDefault(s.recipe))
  const constrain = useDevelop((s) => s.recipe.geometry.constrain)
  return (
    <Panel
      title="Transform"
      action={
        <button
          type="button"
          className="btn sm ghost"
          disabled={!edited}
          onClick={() => {
            const d = useDevelop.getState()
            const g = d.recipe.geometry
            void d.setAndCommit({ geometry: { ...DEFAULT_RECIPE.geometry, distortion: g.distortion, caRed: g.caRed, caBlue: g.caBlue } }, { label: 'Reset transform', deltaText: null, valueText: null })
          }}
        >
          Reset
        </button>
      }
    >
      <div className="row" role="group" aria-label="Turn and flip">
        {(
          [
            ['Rotate left', 'left', 'Turn the picture a quarter turn to the left'],
            ['Rotate right', 'right', 'Turn the picture a quarter turn to the right'],
            ['Flip horizontal', 'flipH', 'Swap left and right'],
            ['Flip vertical', 'flipV', 'Swap top and bottom'],
          ] as [string, TurnOp, string][]
        ).map(([label, op, title]) => (
          <button
            key={label}
            type="button"
            className="btn sm"
            title={title}
            onClick={() => {
              const d = useDevelop.getState()
              // the masks, spots, red-eye circles, faces and the crop frame are turned with the picture
              void d.setAndCommit(turnRecipe(d.recipe, op), { label, deltaText: null, valueText: null })
            }}
          >
            {label}
          </button>
        ))}      </div>
      {TRANSFORM.map((d) => (
        <GeometryRow key={d.key} def={d} />
      ))}
      <button
        type="button"
        className="btn sm"
        aria-pressed={constrain}
        title="Zoom in just enough that no empty corner shows"
        onClick={() => {
          const d = useDevelop.getState()
          void d.setAndCommit({ geometry: { ...d.recipe.geometry, constrain: !constrain } }, { label: `Constrain ${constrain ? 'off' : 'on'}`, deltaText: null, valueText: null })
        }}
      >
        Constrain to picture
      </button>
      <p className="hint">Vertical and Horizontal straighten buildings that lean. Constrain hides the empty corners by zooming in a little. Turn and flip first: masks, spots and faces you have already placed stay where they were on the frame, and the crop frame starts again.</p>
    </Panel>
  )
}

function EffectRow({ def }: { def: EffectDef }) {
  const value = useDevelop((s) => s.recipe.effects[def.key])
  const neutral = DEFAULT_RECIPE.effects[def.key]
  const set = (v: number) => useDevelop.getState().live({ effects: { ...useDevelop.getState().recipe.effects, [def.key]: v } })
  return (
    <SliderRow
      id={`sl-fx-${def.key}`}
      label={def.label}
      value={value}
      min={def.min}
      max={def.max}
      step={1}
      digits={0}
      neutral={neutral}
      onLive={set}
      onCommit={() => void useDevelop.getState().commit(effectStep(def, useDevelop.getState().saved, useDevelop.getState().recipe))}
      onReset={() => {
        const d = useDevelop.getState()
        if (d.recipe.effects[def.key] === neutral) return
        set(neutral)
        void d.commit({ label: `Reset ${def.step.toLowerCase()}`, deltaText: null, valueText: num(neutral, 0) })
      }}
    />
  )
}

function EffectsPanel() {
  const edited = useDevelop((s) => !effectsIsDefault(s.recipe))
  return (
    <Panel
      title="Effects"
      action={
        <button
          type="button"
          className="btn sm ghost"
          disabled={!edited}
          onClick={() => void useDevelop.getState().setAndCommit({ effects: DEFAULT_RECIPE.effects }, { label: 'Reset effects', deltaText: null, valueText: null })}
        >
          Reset
        </button>
      }
    >
      <fieldset className="sgroup">
        <legend>Vignette</legend>
        {VIGNETTE.map((d) => (
          <EffectRow key={d.key} def={d} />
        ))}
      </fieldset>
      <fieldset className="sgroup">
        <legend>Grain</legend>
        {GRAIN.map((d) => (
          <EffectRow key={d.key} def={d} />
        ))}
      </fieldset>
    </Panel>
  )
}

function BasicPanel() {
  const edited = useDevelop((s) => BASIC_GROUPS.some((g) => g.sliders.some((d) => s.recipe[d.key] !== 0)))
  return (
    <Panel title="Basic">
      <div className="row basic-actions" role="group" aria-label="Basic tools">
        <button type="button" className="btn sm" onClick={() => void useDevelop.getState().autoTone()} title="Suggest exposure, contrast, highlights, shadows, whites and blacks">
          Auto tone
        </button>
        <button type="button" className="btn sm" onClick={() => void useDevelop.getState().autoWhiteBalance()} title="Suggest a temperature and tint that neutralise a colour cast">
          Auto WB
        </button>
        <button type="button" className="btn sm" disabled={!edited} onClick={() => void useDevelop.getState().resetAll()}>
          Reset
        </button>
      </div>
      <ProfileRow />
      {BASIC_GROUPS.map((g) => (
        <fieldset key={g.title} className="sgroup">
          <legend>{g.title}</legend>
          {g.sliders.map((d) => (
            <Slider key={d.key} def={d} />
          ))}
        </fieldset>
      ))}
    </Panel>
  )
}

type CurveChannel = 'curve' | 'curveRed' | 'curveGreen' | 'curveBlue'
const CHANNELS: { id: CurveChannel; label: string; name: string }[] = [
  { id: 'curve', label: 'RGB', name: 'Tone curve' },
  { id: 'curveRed', label: 'Red', name: 'Red curve' },
  { id: 'curveGreen', label: 'Green', name: 'Green curve' },
  { id: 'curveBlue', label: 'Blue', name: 'Blue curve' },
]

function CurvePanel() {
  const [channel, setChannel] = useState<CurveChannel>('curve')
  const chan = CHANNELS.find((c) => c.id === channel)!
  const curve = useDevelop((s) => s.recipe[channel] ?? [])
  const svg = useRef<SVGSVGElement>(null)
  const dragging = useRef<number | null>(null)
  const pause = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(pause.current), [])
  const straight = isStraight(curve)

  const at = (e: { clientX: number; clientY: number }): Point => {
    const r = svg.current!.getBoundingClientRect()
    return [((e.clientX - r.left) / r.width) * 255, 255 - ((e.clientY - r.top) / r.height) * 255]
  }
  const points = () => useDevelop.getState().recipe[channel] ?? []
  const commit = () => {
    clearTimeout(pause.current)
    const n = points().length
    void useDevelop.getState().commit({ label: chan.name, deltaText: null, valueText: n === 1 ? '1 point' : `${n} points` })
  }
  const commitSoon = () => {
    clearTimeout(pause.current)
    pause.current = setTimeout(commit, 600)
  }
  const set = (next: Point[]) => useDevelop.getState().live({ [channel]: next })

  const down = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return
    const [x, y] = at(e)
    const { points: next, index } = addPoint(points(), x, y)
    if (index < 0) return
    set(next)
    dragging.current = index
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: React.PointerEvent<SVGSVGElement>) => {
    if (dragging.current !== null) set(movePoint(points(), dragging.current, at(e)))
  }
  const up = () => {
    if (dragging.current === null) return
    dragging.current = null
    commit()
  }
  const remove = (i: number) => {
    set(points().filter((_, k) => k !== i))
    commit()
  }
  // The pointer is captured by the whole curve while a point is pressed, so a double-click lands on the
  // curve, not on the point: find the point under the pointer here.
  const doubleClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const [x, y] = at(e)
    const i = points().findIndex((p) => Math.abs(p[0] - x) <= 8 && Math.abs(p[1] - y) <= 10)
    if (i >= 0) remove(i)
  }
  const key = (e: React.KeyboardEvent, i: number) => {
    const step = e.shiftKey ? 10 : 1
    const p = points()[i]
    const moves: Record<string, Point> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault()
      e.stopPropagation() // Delete also removes photos from the catalog in the Library shortcuts
      return remove(i)
    }
    const m = moves[e.key]
    if (!m) return
    e.preventDefault()
    e.stopPropagation() // the arrow keys also step to the next photo; here they belong to the curve point
    set(movePoint(points(), i, [p[0] + m[0], p[1] + m[1]]))
    commitSoon()
  }

  const line = curveValues(curve)
    .map((y, x) => `${x === 0 ? 'M' : 'L'}${x},${255 - y}`)
    .join(' ')
  return (
    <Panel
      title="Tone curve"
      action={
        <button type="button" className="btn sm ghost" disabled={straight && curve.length === 0} onClick={() => void useDevelop.getState().setAndCommit({ [channel]: [] }, { label: `Reset ${chan.name.toLowerCase()}`, deltaText: null, valueText: null })}>
          Reset
        </button>
      }
    >
      <div className="aspects" role="group" aria-label="Curve channel">
        {CHANNELS.map((c) => (
          <button key={c.id} type="button" className="btn sm" aria-pressed={channel === c.id} onClick={() => setChannel(c.id)}>
            {c.label}
          </button>
        ))}
      </div>
      <svg ref={svg} className="curve" viewBox="-6 -6 267 267" role="group" aria-label="Tone curve. Click to add a point, drag to move it, double-click to remove it." onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up} onDoubleClick={doubleClick}>
        {[64, 128, 192].map((g) => (
          <g key={g} className="curve-grid">
            <line x1={g} y1={0} x2={g} y2={255} />
            <line x1={0} y1={g} x2={255} y2={g} />
          </g>
        ))}
        <line className="curve-diag" x1={0} y1={255} x2={255} y2={0} />
        <path className={`curve-line ch-${channel}`} d={line} />
        {curve.map((p, i) => (
          <circle
            key={i}
            className="curve-pt"
            cx={p[0]}
            cy={255 - p[1]}
            r={5}
            tabIndex={0}
            role="slider"
            aria-label={`Curve point ${i + 1}`}
            aria-orientation="vertical"
            aria-valuemin={0}
            aria-valuemax={255}
            aria-valuenow={Math.round(p[1])}
            aria-valuetext={`input ${Math.round(p[0])}, output ${Math.round(p[1])}`}
            onKeyDown={(e) => key(e, i)}
            onBlur={commit}
          />
        ))}
      </svg>
      <p className="hint">Click the line to add a point. Arrow keys move a focused point, Delete removes it. Red, Green and Blue curves change one colour alone, after the RGB curve.</p>
      <ParametricCurve />
    </Panel>
  )
}

/** The parametric curve: four sliders, each moving one region of the tones, under the point curve. */
function ParametricCurve() {
  const p = useDevelop((s) => s.recipe.parametric ?? DEFAULT_RECIPE.parametric)
  const store = useDevelop.getState
  const names: Record<ParametricKey, string> = { highlights: 'Curve highlights', lights: 'Curve lights', darks: 'Curve darks', shadows: 'Curve shadows' }
  return (
    <div className="stack" role="group" aria-label="Parametric curve">
      {PARAMETRIC_KEYS.map((k) => (
        <SliderRow
          key={k}
          id={`sl-param-${k}`}
          label={names[k]}
          value={p[k]}
          min={-100}
          max={100}
          step={1}
          digits={0}
          onLive={(v) => store().live({ parametric: { ...(store().recipe.parametric ?? DEFAULT_RECIPE.parametric), [k]: v } })}
          onCommit={() => void store().commit({ label: names[k], deltaText: null, valueText: String(store().recipe.parametric?.[k] ?? 0) })}
          onReset={() => void store().setAndCommit({ parametric: { ...(store().recipe.parametric ?? DEFAULT_RECIPE.parametric), [k]: 0 } }, { label: `Reset ${names[k].toLowerCase()}`, deltaText: null, valueText: null })}
        />
      ))}
    </div>
  )
}

export function DevelopRight({ img }: { img: HTMLImageElement | null }) {
  const hideAi = usePrefs((s) => s.hideAi)
  // busy until a photo is open and its own settings have arrived; edits made before that are ignored
  const ready = useDevelop((s) => s.photoId !== null && !s.loading)
  return (
    <aside className="side right" aria-label="Develop controls" aria-busy={!ready || undefined}>
      <LicenceBanner />
      <ToolStrip />
      <div className="side-scroll">
        <Panel title="Histogram">
          <Histogram img={img} />
        </Panel>
        {!hideAi && <BBotPanel />}
        <MasksPanel />
        <BasicPanel />
        <CurvePanel />
        <MixerPanel />
        <GradingPanel />
        <CalibrationPanel />
        <DetailPanel />
        <EffectsPanel />
        <LensPanel />
        <TransformPanel />
        <CropPanel />
        <EnlargePanel />
        <SoftProofPanel />
      </div>
    </aside>
  )
}

/** The Retouch module's controls: dust and blemish spots, red eye, and the faces. */
export function RetouchRight() {
  const hideAi = usePrefs((s) => s.hideAi)
  const ready = useDevelop((s) => s.photoId !== null && !s.loading)
  return (
    <aside className="side right" aria-label="Retouch controls" aria-busy={!ready || undefined}>
      <div className="side-scroll">
        {!hideAi && <BBotPanel skinFirst />}
        {!hideAi && <PortraitPanels />}
        <SpotsPanel />
        <RedEyePanel />
      </div>
    </aside>
  )
}

function HistoryItem({ row, current }: { row: HistoryRow; current: boolean }) {
  return (
    <li>
      <button type="button" className="hist-row" aria-current={current ? 'true' : undefined} onClick={() => void useDevelop.getState().goTo(row)} title="Go back to this state">
        <span className="trunc">{row.label}</span>
        {(row.deltaText || row.valueText) && <small className="muted">{[row.deltaText, row.valueText].filter(Boolean).join('  ')}</small>}
      </button>
    </li>
  )
}

export function DevelopLeft({ retouch = false }: { retouch?: boolean }) {
  const history = useDevelop((s) => s.history)
  const saved = useDevelop((s) => s.saved) // not the live recipe: the list stays still while a slider moves
  return (
    <aside className="side left" aria-label={retouch ? 'Retouch history' : 'Develop history'}>
      <div className="side-scroll">
        {!retouch && <PresetsPanel />}
        <NavigatorPanel />
        {!retouch && <SnapshotsPanel />}
        <Panel title="History">
          {history.length === 0 ? (
            <p className="hint">No edits yet. Move a slider and every change is listed here.</p>
          ) : (
            <ol className="hist-list" aria-label="Edit history, newest first">
              {history.map((h, i) => (
                <HistoryItem key={h.id} row={h} current={i === 0 && recipesEqual(h.recipe, saved)} />
              ))}
            </ol>
          )}
        </Panel>
      </div>
    </aside>
  )
}

export function DevelopStage({ onImage }: { onImage: (img: HTMLImageElement | null) => void }) {
  const photo = useStore((s) => s.photoAt(s.active))
  const { photoId, recipe, saved, showOriginal, version, loading, error, clipboard, zoom, hover, selectedMask, showMask, painting, selectedSpot, spotTool, picking, cropEdit, selectedRedEye, redEyeTool, portraitTool, selectedRegion, undoStack, redoStack, clipping, spotView } = useDevelop()
  const panelsOff = useDevelop((s) => s.panelsOff)
  const proofOn = useProof((s) => s.on && s.name !== null)
  const proofGamut = useProof((s) => s.gamut)
  const proofRev = useProof((s) => s.rev)
  const proof = useMemo(() => (proofOn ? { gamut: proofGamut, rev: proofRev } : undefined), [proofOn, proofGamut, proofRev])
  const { shown, failed } = useRendered(photoId, withPanelsOff(recipe, panelsOff), withPanelsOff(saved, panelsOff), showOriginal, version, zoom, hover && withPanelsOff(hover, panelsOff), showMask ? (selectedMask ?? undefined) : undefined, painting, cropEdit, proof)
  const compareView = useDevelop((s) => s.compareView)
  const objectTool = useDevelop((s) => s.objectTool)
  const comparing = compareView !== 'off' && !zoom.on && !cropEdit
  const before = useRendered(comparing ? photoId : null, DEFAULT_RECIPE, DEFAULT_RECIPE, true, version, zoom, null, undefined, false, false, undefined).shown
  const [splitAt, setSplitAt] = useState(50)
  const arrowsOn = useSliderPrefs((s) => s.arrows)
  const [copyOpen, setCopyOpen] = useState(false)
  const [syncOpen, setSyncOpen] = useState(false)
  const otherSelected = useStore((s) => s.selected.size > 1)
  const stage = useRef<HTMLDivElement>(null)
  const drag = useRef<{ x: number; y: number; moved: number } | null>(null)
  const dpr = typeof window === 'undefined' ? 1 : window.devicePixelRatio || 1
  /** the colour under the pointer, as text, while it is over the fitted picture */
  const [probe, setProbe] = useState<string | null>(null)
  const sampler = useRef<{ img: HTMLImageElement; ctx: CanvasRenderingContext2D } | null>(null)
  const probeAt = (e: React.PointerEvent<HTMLDivElement>) => {
    const pic = shown?.img
    const el = e.currentTarget.querySelector('img.dev-img') as HTMLImageElement | null
    if (!pic || shown.win || cropEdit || !el || !pic.naturalWidth) return setProbe(null)
    const f = pictureFraction(el.getBoundingClientRect(), pic.naturalWidth, pic.naturalHeight, e.clientX, e.clientY)
    if (!f) return setProbe(null)
    try {
      if (sampler.current?.img !== pic) {
        const cv = document.createElement('canvas')
        cv.width = pic.naturalWidth
        cv.height = pic.naturalHeight
        const ctx = cv.getContext('2d', { willReadFrequently: true })!
        ctx.drawImage(pic, 0, 0)
        sampler.current = { img: pic, ctx }
      }
      const [x, y] = pixelAt(f, pic.naturalWidth, pic.naturalHeight)
      const [r, g, b] = sampler.current.ctx.getImageData(x, y, 1, 1).data
      setProbe(readoutText(r, g, b))
    } catch {
      setProbe(null) // a picture the browser will not let us read
    }
  }

  // the histogram follows the whole picture, not the piece shown at 1:1
  useEffect(() => {
    if (!shown) onImage(null)
    else if (!shown.win) onImage(shown.img)
  }, [shown, onImage])

  // tell the store how big the stage is, in device pixels: that is the window asked of the full-size picture
  useEffect(() => {
    const el = stage.current
    if (!el) return
    const measure = () => useDevelop.getState().setViewport(Math.max(1, Math.round(el.clientWidth * dpr)), Math.max(1, Math.round(el.clientHeight * dpr)))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [dpr, photo])

  // changing the crop changes the full-size picture: go back to fitted rather than redo 18 million pixels per tick
  useEffect(() => {
    if (zoom.on && zoom.crop !== cropKey(recipe.crop, recipe.geometry)) useDevelop.getState().zoomOut()
  }, [zoom.on, zoom.crop, recipe.crop, recipe.geometry])

  if (!photo) {
    return (
      <div className="stage">
        <div className="empty" role="status">
          <h2>No photo selected</h2>
          <p>Pick a photo in the Library, then open Develop or Retouch.</p>
          <button className="btn" onClick={() => useStore.setState({ module: 'library' })}>
            Back to Library
          </button>
        </div>
      </div>
    )
  }
  const edited = !isDefault(recipe)
  const changedSinceOpened = useDevelop((s) => !recipesEqual(s.recipe, s.opened))
  const alt = `${photo.name}${showOriginal ? ', original' : edited ? ', edited' : ''}${shown?.win ? ', 100%' : ''}`
  const zoomed = zoom.on && !!shown?.win
  // where the fitted picture is drawn inside the stage, so the mask handles can sit on it
  const fitBox: Box | null = (() => {
    if (!shown || shown.win || !shown.img.naturalWidth) return null
    const [sw, sh] = [zoom.vw / dpr, zoom.vh / dpr]
    const pad = 16
    const k = Math.min((sw - 2 * pad) / shown.img.naturalWidth, (sh - 2 * pad) / shown.img.naturalHeight)
    const [w, h] = [shown.img.naturalWidth * k, shown.img.naturalHeight * k]
    return { left: (sw - w) / 2, top: (sh - h) / 2, w, h }
  })()
  const maskBox: Box | null = cropEdit || selectedMask || selectedSpot || spotTool || selectedRedEye || redEyeTool || portraitTool || selectedRegion ? fitBox : null

  const down = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 || !shown || cropEdit) return
    drag.current = { x: e.clientX, y: e.clientY, moved: 0 }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (!d) return
    const dx = e.clientX - d.x
    const dy = e.clientY - d.y
    d.x = e.clientX
    d.y = e.clientY
    d.moved += Math.abs(dx) + Math.abs(dy)
    if (zoom.on && d.moved > 3) useDevelop.getState().panBy(-dx * dpr, -dy * dpr)
  }
  // the wheel and a two-finger swipe move the 1:1 view
  const wheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (zoom.on) useDevelop.getState().panBy(e.deltaX * dpr, e.deltaY * dpr)
  }
  const up = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    drag.current = null
    if (!d || d.moved > 3) return // it was a drag: panning, not a click
    if (zoom.on) return useDevelop.getState().zoomOut()
    // where on the fitted picture the click was, as fractions of it
    const img = e.currentTarget.querySelector('img.dev-img') as HTMLImageElement | null
    if (!img || !img.naturalWidth) return void useDevelop.getState().zoomIn()
    const box = img.getBoundingClientRect()
    const scale = Math.min(box.width / img.naturalWidth, box.height / img.naturalHeight)
    const [dw, dh] = [img.naturalWidth * scale, img.naturalHeight * scale]
    const fx = Math.min(1, Math.max(0, (e.clientX - (box.left + (box.width - dw) / 2)) / dw))
    const fy = Math.min(1, Math.max(0, (e.clientY - (box.top + (box.height - dh) / 2)) / dh))
    if (useDevelop.getState().objectTool) {
      void useDevelop.getState().addObjectMask(fx, fy) // the object under the click
      return
    }
    if (useDevelop.getState().picking) {
      // the colour picker: read the colour under the click (a small patch, averaged) from the picture on screen
      const src = shown?.img
      if (!src || !src.naturalWidth) return
      try {
        const cv = document.createElement('canvas')
        cv.width = 1
        cv.height = 1
        const ctx = cv.getContext('2d', { willReadFrequently: true })!
        const [px, py] = [Math.round(fx * (src.naturalWidth - 1)), Math.round(fy * (src.naturalHeight - 1))]
        ctx.drawImage(src, Math.max(0, px - 2), Math.max(0, py - 2), 5, 5, 0, 0, 1, 1)
        const [r, g, b] = ctx.getImageData(0, 0, 1, 1).data
        const { hue, sat } = rgbToHueSat(r, g, b)
        void useDevelop.getState().pickColour(hue, sat)
      } catch {
        useDevelop.getState().setPicking(false) // a picture the browser will not let us read
      }
      return
    }
    // a click on the fitted picture: go to 1:1 at the spot that was clicked
    void useDevelop.getState().zoomIn(fx, fy)
  }

  let picture: React.ReactNode
  if (zoomed && shown?.win) {
    // between asking for a new window and receiving it, the old one is slid into place so panning never lags
    const { x, y, w, h } = shown.win
    const off = { x: (x + w / 2 - zoom.cx) / dpr, y: (y + h / 2 - zoom.cy) / dpr }
    picture = (
      <img
        className="loupe-img dev-img zoom-img"
        src={shown.url}
        alt={alt}
        draggable={false}
        data-x={x}
        data-y={y}
        style={{ width: w / dpr, height: h / dpr, transform: `translate(-50%, -50%) translate(${off.x}px, ${off.y}px)` }}
      />
    )
  } else if (shown && comparing && before && compareView === 'side') {
    picture = (
      <div className="cmp-side">
        <figure>
          <img className="loupe-img" src={before.url} alt={`, before`} draggable={false} />
          <figcaption>Before</figcaption>
        </figure>
        <figure>
          <img className="loupe-img dev-img" src={shown.url} alt={alt} draggable={false} />
          <figcaption>After</figcaption>
        </figure>
      </div>
    )
  } else if (shown && comparing && before && compareView === 'split') {
    picture = (
      <div className="cmp-split">
        <img className="loupe-img dev-img" src={shown.url} alt={alt} draggable={false} />
        <img className="loupe-img cmp-before" src={before.url} alt={`, before`} draggable={false} style={{ clipPath: `inset(0 ${100 - splitAt}% 0 0)` }} />
        <span className="badge-before cmp-b" aria-hidden>
          Before
        </span>
        <span className="badge-before cmp-a" aria-hidden>
          After
        </span>
        <input type="range" className="cmp-slider" min={2} max={98} value={splitAt} aria-label="Split position" onChange={(e) => setSplitAt(Number(e.target.value))} onPointerDown={(e) => e.stopPropagation()} onPointerUp={(e) => e.stopPropagation()} />
      </div>
    )
  } else if (shown) {
    picture = <img className="loupe-img dev-img" src={shown.url} alt={alt} draggable={false} />
  } else {
    picture = <div className="empty" role="status">{loading ? 'Loading…' : failed ? 'This photo has no preview to edit yet.' : ''}</div>
  }

  return (
    <>
      <div
        ref={stage}
        className={`stage ${cropEdit ? 'framing' : picking || objectTool ? 'picking' : zoom.on ? 'zoomed' : shown ? 'can-zoom' : ''}`}
        onPointerDown={down}
        onPointerMove={(e) => {
          move(e)
          probeAt(e)
        }}
        onPointerLeave={() => setProbe(null)}
        onPointerUp={up}
        onPointerCancel={() => (drag.current = null)}
        onWheel={wheel}
      >
        {picture}
        {clipping && fitBox && shown && !cropEdit && !zoom.on && !showOriginal && <ClippingOverlay box={fitBox} img={shown.img} />}
        {spotView && fitBox && shown && !cropEdit && !zoom.on && !showOriginal && <SpotMap box={fitBox} img={shown.img} />}
        {maskBox && cropEdit && shown && !zoom.on && <CropOverlay box={maskBox} size={{ w: shown.img.naturalWidth, h: shown.img.naturalHeight }} />}
        {maskBox && !cropEdit && !zoom.on && !showOriginal && <MaskOverlay box={maskBox} />}
        {maskBox && !cropEdit && !zoom.on && !showOriginal && <SpotOverlay box={maskBox} />}
        {maskBox && !cropEdit && !zoom.on && !showOriginal && <RedEyeOverlay box={maskBox} />}
        {maskBox && !cropEdit && !zoom.on && !showOriginal && <PortraitOverlay box={maskBox} />}
        {showOriginal && <span className="badge-before">Before</span>}
        {zoom.loading && (
          <span className="badge-before wait" role="status">
            Loading full size…
          </span>
        )}
        {zoomed && <span className="badge-before zoom-badge">100%</span>}
        {failed && shown && <span className="badge-before bad">Could not update the picture</span>}
      </div>
      <div className="toolbar dev-toolbar" role="toolbar" aria-label="Develop tools">
        <div className="row" role="group" aria-label="Zoom">
          <button type="button" className="btn sm" aria-pressed={!zoom.on} onClick={() => useDevelop.getState().zoomOut()} title="Fit the whole picture (Z)">
            Fit
          </button>
          <button type="button" className="btn sm" aria-pressed={zoom.on} disabled={zoom.loading || !shown} onClick={() => void useDevelop.getState().zoomIn()} title="Actual size (Z)">
            100%
          </button>
        </div>
        <div className="row" role="group" aria-label="Undo">
          <button type="button" className="btn sm" disabled={undoStack.length === 0 || loading} onClick={() => void useDevelop.getState().undo()} title="Undo the last edit (Ctrl+Z)">
            Undo
          </button>
          <button type="button" className="btn sm" disabled={redoStack.length === 0 || loading} onClick={() => void useDevelop.getState().redo()} title="Do again what was undone (Ctrl+Shift+Z)">
            Redo
          </button>
        </div>
        <div className="row" role="group" aria-label="Before and after">
          {(['off', 'side', 'split'] as const).map((v) => (
            <button key={v} type="button" className="btn sm" aria-pressed={compareView === v} onClick={() => useDevelop.getState().setCompareView(v)} title="Before and after (Y)">
              {v === 'off' ? 'After only' : v === 'side' ? 'Side by side' : 'Split'}
            </button>
          ))}
        </div>
        <button type="button" className="btn sm" aria-pressed={arrowsOn} onClick={() => useSliderPrefs.getState().setArrows(!arrowsOn)} title="Show up and down arrows beside each adjustment for fine tuning">
          Fine-tune arrows
        </button>
        <button type="button" className="btn sm" aria-pressed={clipping} onClick={() => useDevelop.getState().toggleClipping()} title="Show blown highlights in red and crushed shadows in blue (J)">
          Clipping
        </button>
        <button type="button" className="btn sm" aria-pressed={showOriginal} onClick={() => useDevelop.getState().toggleOriginal()} title="Show the original (\)">
          Before
        </button>
        <button type="button" className="btn sm" onClick={() => setCopyOpen(true)} disabled={!edited}>
          Copy settings…
        </button>
        <button type="button" className="btn sm" onClick={() => void useDevelop.getState().paste()} disabled={!clipboard}>
          Paste settings
        </button>
        <button type="button" className="btn sm" onClick={() => setSyncOpen(true)} disabled={!otherSelected || !edited} title="Give the other photos selected in the Library these settings (Ctrl-click photos in the Library first)">
          Sync…
        </button>
        <button type="button" className="btn sm" onClick={() => void useDevelop.getState().previous()} disabled={!changedSinceOpened} title="Go back to how this photo was when you opened it in Develop">
          Previous
        </button>
        <button type="button" className="btn sm" onClick={() => void useDevelop.getState().resetAll()} disabled={!edited}>
          Reset all
        </button>
        <span className="grow" />
        {error && (
          <span className="err" role="alert">
            {error}
          </span>
        )}
        {probe && (
          <span className="muted readout" aria-hidden>
            {probe}
          </span>
        )}
        <span className="muted trunc">{photo.name}</span>
      </div>
      <CopyDialog open={copyOpen} onClose={() => setCopyOpen(false)} />
      <SyncDialog open={syncOpen} onClose={() => setSyncOpen(false)} />
    </>
  )
}
