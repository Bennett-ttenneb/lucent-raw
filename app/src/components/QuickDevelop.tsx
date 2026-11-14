import { useEffect, useState } from 'react'
import { sliderDef, useDevelop } from '../lib/develop'
import { plural } from '../lib/format'
import { QUICK_ROWS } from '../lib/quickdevelop'
import { useStore } from '../lib/store'
import { Panel } from './Primitives'

/**
 * Quick Develop, in the Library: move the main sliders by single or double arrow steps, put a preset on, or take every edit off,
 * for all the selected photos at once without opening Develop. Each press is one step in each photo's History.
 */
export function QuickDevelopPanel() {
  const count = useStore((s) => s.targetIds().length)
  const presets = useDevelop((s) => s.presets)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    void useDevelop.getState().loadPresets()
  }, [])

  const run = async (job: (ids: number[]) => Promise<{ done: number; failed: string[] }>, said: (done: number) => string) => {
    const ids = useStore.getState().targetIds()
    if (ids.length === 0 || busy) return
    setBusy(true)
    try {
      const r = await job(ids)
      const ui = useStore.getState()
      if (r.failed.length) ui.say(`${plural(r.failed.length, 'photo')} could not be changed: ${r.failed[0]}`, true)
      else if (r.done > 0) ui.say(said(r.done))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel title="Quick Develop" defaultOpen={false}>
      {count === 0 ? (
        <p className="hint">Select photos to change them here.</p>
      ) : (
        <div className="stack quick-develop">
          <p className="hint">Changes the {plural(count, 'photo')} you picked. Single arrows are small steps, double arrows are big ones.</p>
          <div className="field-row">
            <label className="lbl" htmlFor="qd-preset">
              Preset
            </label>
            <select
              id="qd-preset"
              className="field"
              value=""
              disabled={busy}
              onChange={(e) => {
                const p = presets.find((x) => `${x.id}-${x.name}` === e.target.value)
                if (p) void run((ids) => useDevelop.getState().applyPresetToMany(ids, p), (n) => `Preset "${p.name}" put on ${plural(n, 'photo')}.`)
              }}
            >
              <option value="">Choose a preset…</option>
              {presets.map((p) => (
                <option key={`${p.id}-${p.name}`} value={`${p.id}-${p.name}`}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          {QUICK_ROWS.map((r) => {
            const d = sliderDef(r.key)
            const move = (delta: number) => void run((ids) => useDevelop.getState().nudgeMany(ids, r.key, delta), (n) => `${d.label} changed on ${plural(n, 'photo')}.`)
            const show = (v: number) => (d.digits ? v.toFixed(2) : String(v))
            return (
              <div className="quick-row" key={r.key} role="group" aria-label={`Quick ${d.label}`}>
                <span className="quick-name">{d.label}</span>
                <button type="button" className="btn sm" disabled={busy} aria-label={`${d.label}: much less`} title={`${d.label} −${show(r.big)}`} onClick={() => move(-r.big)}>
                  «
                </button>
                <button type="button" className="btn sm" disabled={busy} aria-label={`${d.label}: less`} title={`${d.label} −${show(r.small)}`} onClick={() => move(-r.small)}>
                  ‹
                </button>
                <button type="button" className="btn sm" disabled={busy} aria-label={`${d.label}: more`} title={`${d.label} +${show(r.small)}`} onClick={() => move(r.small)}>
                  ›
                </button>
                <button type="button" className="btn sm" disabled={busy} aria-label={`${d.label}: much more`} title={`${d.label} +${show(r.big)}`} onClick={() => move(r.big)}>
                  »
                </button>
              </div>
            )
          })}
          <div className="row">
            <button type="button" className="btn sm" disabled={busy} onClick={() => void run((ids) => useDevelop.getState().autoMany(ids, 'Auto tone', ['exposure', 'contrast', 'highlights', 'shadows', 'whites', 'blacks', 'vibrance', 'saturation']), (n) => `Auto tone done on ${plural(n, 'photo')}.`)}>
              Auto tone
            </button>
            <button type="button" className="btn sm" disabled={busy} onClick={() => void run((ids) => useDevelop.getState().autoMany(ids, 'Auto white balance', ['temperature', 'tint']), (n) => `Auto white balance done on ${plural(n, 'photo')}.`)}>
              Auto WB
            </button>
          </div>
          <button type="button" className="btn sm" disabled={busy} onClick={() => void run((ids) => useDevelop.getState().resetMany(ids), (n) => `Edits taken off ${plural(n, 'photo')}.`)}>
            Reset all
          </button>
        </div>
      )}
    </Panel>
  )
}
