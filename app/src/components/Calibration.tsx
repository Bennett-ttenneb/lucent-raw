import { DEFAULT_RECIPE, type Recipe } from '../lib/types'
import { useDevelop } from '../lib/develop'
import { Panel } from './Primitives'
import { SliderRow } from './SliderRow'

type Calibration = Recipe['calibration']
const store = () => useDevelop.getState()
const current = (): Calibration => store().recipe.calibration ?? DEFAULT_RECIPE.calibration

const ROWS: { key: keyof Calibration; label: string }[] = [
  { key: 'shadowsTint', label: 'Calibration shadows tint' },
  { key: 'redHue', label: 'Red primary hue' },
  { key: 'redSat', label: 'Red primary saturation' },
  { key: 'greenHue', label: 'Green primary hue' },
  { key: 'greenSat', label: 'Green primary saturation' },
  { key: 'blueHue', label: 'Blue primary hue' },
  { key: 'blueSat', label: 'Blue primary saturation' },
]

/** Calibration: how the three primary colours are rendered (turned in hue, made more or less saturated) and a tint in the shadows. */
export function CalibrationPanel() {
  const c = useDevelop((s) => s.recipe.calibration ?? DEFAULT_RECIPE.calibration)
  const untouched = ROWS.every((r) => c[r.key] === 0)
  return (
    <Panel
      title="Calibration"
      defaultOpen={false}
      action={
        <button type="button" className="btn sm ghost" disabled={untouched} onClick={() => void store().setAndCommit({ calibration: DEFAULT_RECIPE.calibration }, { label: 'Reset calibration', deltaText: null, valueText: null })}>
          Reset
        </button>
      }
    >
      {ROWS.map((r) => (
        <SliderRow
          key={r.key}
          id={`sl-calib-${r.key}`}
          label={r.label}
          value={c[r.key]}
          min={-100}
          max={100}
          step={1}
          digits={0}
          onLive={(v) => store().live({ calibration: { ...current(), [r.key]: v } })}
          onCommit={() => void store().commit({ label: r.label, deltaText: null, valueText: String(Math.round(current()[r.key])) })}
          onReset={() => void store().setAndCommit({ calibration: { ...current(), [r.key]: 0 } }, { label: `Reset ${r.label.toLowerCase()}`, deltaText: null, valueText: null })}
        />
      ))}
      <p className="hint">Each primary can be turned towards its neighbour in colour or made stronger or weaker. Greys stay grey. Use it to put right the way a camera renders its colours; the mixer above is for taste.</p>
    </Panel>
  )
}
