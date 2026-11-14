import { useProof } from '../lib/proof'
import type { ProofIntent } from '../lib/types'
import { Panel } from './Primitives'

const INTENTS: [ProofIntent, string][] = [
  ['relative', 'Relative colorimetric (the closest match)'],
  ['perceptual', 'Perceptual (keeps the look between colours)'],
  ['saturation', 'Saturation (keeps vivid colours vivid)'],
  ['absolute', 'Absolute colorimetric (the paper white is shown)'],
]

/** Soft proofing: choose the colour profile of a printer and paper (or another screen), and see the picture as it would look. */
export function SoftProofPanel() {
  const { name, on, gamut, intent, error } = useProof()
  return (
    <Panel title="Soft proofing" defaultOpen={false}>
      <p className="hint">See how the picture would look printed, judged on the screen. Choose the colour profile (.icc) of your printer and paper.</p>
      <div className="row">
        <button type="button" className="btn sm" onClick={() => void useProof.getState().choose()}>
          {name ? 'Choose another profile…' : 'Choose a profile…'}
        </button>
        {name && (
          <button type="button" className="btn sm" onClick={() => void useProof.getState().clear()}>
            Remove
          </button>
        )}
      </div>
      {name && <p role="status">Profile: {name}</p>}
      <label className="check">
        <input type="checkbox" checked={on} disabled={!name} onChange={(e) => useProof.getState().setOn(e.target.checked)} /> Show the proof
      </label>
      <label className="check">
        <input type="checkbox" checked={gamut} disabled={!name || !on} onChange={(e) => useProof.getState().setGamut(e.target.checked)} /> Mark colours the profile cannot reproduce
      </label>
      <div className="field-row">
        <label className="lbl" htmlFor="proof-intent">
          Rendering intent
        </label>
        <select id="proof-intent" className="field" value={intent} onChange={(e) => void useProof.getState().setIntent(e.target.value as ProofIntent)}>
          {INTENTS.map(([v, label]) => (
            <option key={v} value={v}>
              {label}
            </option>
          ))}
        </select>
      </div>
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      <p className="hint">The picture is made in sRGB, so what a profile wider than sRGB could hold is not shown.</p>
    </Panel>
  )
}
