import { useRef } from 'react'
import { DEFAULT_RECIPE, type Recipe } from '../lib/types'
import { useDevelop } from '../lib/develop'
import { Panel } from './Primitives'
import { SliderRow } from './SliderRow'

type Grading = Recipe['grading']
type WheelKey = 'shadows' | 'midtones' | 'highlights' | 'global'
type WheelValue = Grading['shadows']

const WHEELS: { key: WheelKey; name: string }[] = [
  { key: 'shadows', name: 'Shadows' },
  { key: 'midtones', name: 'Midtones' },
  { key: 'highlights', name: 'Highlights' },
  { key: 'global', name: 'Global' },
]

const store = () => useDevelop.getState()
const grading = (): Grading => store().recipe.grading ?? DEFAULT_RECIPE.grading
const isZero = (g: Grading) => (['shadows', 'midtones', 'highlights', 'global'] as WheelKey[]).every((k) => g[k].sat === 0 && g[k].lum === 0)

/** A point on the wheel: its angle is the hue and its distance from the middle is how much colour (0 at the middle, 100 at the rim). */
export function wheelPoint(hue: number, sat: number): [number, number] {
  const a = ((hue - 90) * Math.PI) / 180 // the hue starts at the top
  const r = (sat / 100) * 50
  return [50 + r * Math.cos(a), 50 + r * Math.sin(a)]
}

/** The hue and colour amount for a pointer at (x, y) on a 100 x 100 wheel. */
export function wheelValue(x: number, y: number): { hue: number; sat: number } {
  const dx = x - 50
  const dy = y - 50
  let hue = (Math.atan2(dy, dx) * 180) / Math.PI + 90
  if (hue < 0) hue += 360
  return { hue: Math.round(hue % 360), sat: Math.round(Math.min(100, (Math.hypot(dx, dy) / 50) * 100)) }
}

function ColourWheel({ k, name, value }: { k: WheelKey; name: string; value: WheelValue }) {
  const box = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)
  const set = (patch: Partial<WheelValue>) => store().live({ grading: { ...grading(), [k]: { ...grading()[k], ...patch } } })
  const commit = () => void store().commit({ label: `Colour grading: ${name.toLowerCase()}`, deltaText: null, valueText: `${Math.round(grading()[k].hue)}°, ${Math.round(grading()[k].sat)}` })
  const at = (e: React.PointerEvent) => {
    const r = box.current!.getBoundingClientRect()
    const v = wheelValue(((e.clientX - r.left) / r.width) * 100, ((e.clientY - r.top) / r.height) * 100)
    set(v)
  }
  const [px, py] = wheelPoint(value.hue, value.sat)
  return (
    <div
      ref={box}
      className="grade-wheel"
      role="group"
      aria-label={`${name} colour wheel. Drag the dot: the angle is the colour, the distance from the middle is how much.`}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        dragging.current = true
        e.currentTarget.setPointerCapture(e.pointerId)
        at(e)
      }}
      onPointerMove={(e) => dragging.current && at(e)}
      onPointerUp={() => {
        if (!dragging.current) return
        dragging.current = false
        commit()
      }}
      onDoubleClick={() => {
        set({ sat: 0 })
        commit()
      }}
    >
      <span className="grade-dot" style={{ left: `${px}%`, top: `${py}%` }} />
    </div>
  )
}

/**
 * Colour grading: a wheel for the shadows, midtones and highlights and one for the whole picture. Drag a wheel's dot to pick a colour; the Hue,
 * Saturation and Luminance sliders say the same in numbers. Blending and Balance share the tones between the regions.
 */
export function GradingPanel() {
  const g = useDevelop((s) => s.recipe.grading ?? DEFAULT_RECIPE.grading)
  const sliders = (k: WheelKey, name: string) => {
    const w = g[k]
    const row = (field: 'hue' | 'sat' | 'lum', label: string, min: number, max: number) => (
      <SliderRow
        key={`${k}-${field}`}
        id={`sl-grade-${k}-${field}`}
        label={`${name} ${label}`}
        value={w[field]}
        min={min}
        max={max}
        step={1}
        digits={0}
        onLive={(v) => store().live({ grading: { ...grading(), [k]: { ...grading()[k], [field]: v } } })}
        onCommit={() => void store().commit({ label: `Colour grading: ${name.toLowerCase()} ${label.toLowerCase()}`, deltaText: null, valueText: String(Math.round(grading()[k][field])) })}
        onReset={() => void store().setAndCommit({ grading: { ...grading(), [k]: { ...grading()[k], [field]: 0 } } }, { label: `Reset ${name.toLowerCase()} ${label.toLowerCase()}`, deltaText: null, valueText: null })}
      />
    )
    return (
      <fieldset className="sgroup" key={k}>
        <legend>{name}</legend>
        <ColourWheel k={k} name={name} value={w} />
        {row('hue', 'hue', 0, 360)}
        {row('sat', 'colour', 0, 100)}
        {row('lum', 'brightness', -100, 100)}
      </fieldset>
    )
  }
  const shared = (field: 'blending' | 'balance', label: string, min: number, max: number, neutral: number) => (
    <SliderRow
      key={field}
      id={`sl-grade-${field}`}
      label={label}
      value={g[field]}
      min={min}
      max={max}
      step={1}
      digits={0}
      neutral={neutral}
      onLive={(v) => store().live({ grading: { ...grading(), [field]: v } })}
      onCommit={() => void store().commit({ label: `Colour grading: ${label.toLowerCase()}`, deltaText: null, valueText: String(Math.round(grading()[field])) })}
      onReset={() => void store().setAndCommit({ grading: { ...grading(), [field]: neutral } }, { label: `Reset ${label.toLowerCase()}`, deltaText: null, valueText: null })}
    />
  )
  return (
    <Panel
      title="Colour grading"
      defaultOpen={false}
      action={
        <button type="button" className="btn sm ghost" disabled={isZero(g) && g.blending === 50 && g.balance === 0} onClick={() => void store().setAndCommit({ grading: DEFAULT_RECIPE.grading }, { label: 'Reset colour grading', deltaText: null, valueText: null })}>
          Reset
        </button>
      }
    >
      {WHEELS.map((w) => sliders(w.key, w.name))}
      {shared('blending', 'Blending', 0, 100, 50)}
      {shared('balance', 'Balance', -100, 100, 0)}
      <p className="hint">Drag a dot to tint that part of the tones. Double-click a wheel to take its colour away.</p>
    </Panel>
  )
}
