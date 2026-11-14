import { useState } from 'react'
import { api } from '../lib/api'
import { plural } from '../lib/format'
import { useStore } from '../lib/store'
import { Dialog } from './Primitives'

const GAPS: [number, string][] = [
  [1, '1 second'],
  [2, '2 seconds'],
  [5, '5 seconds'],
  [10, '10 seconds'],
  [30, '30 seconds'],
  [60, '1 minute'],
  [300, '5 minutes'],
]

/** Stack the photos that were taken one after the other: those no more than the chosen time apart go into one stack. */
export function AutoStackDialog() {
  const open = useStore((s) => s.autoStackOpen)
  const selected = useStore((s) => s.selected)
  const [gap, setGap] = useState(5)
  const [how, setHow] = useState<'time' | 'look'>('time')
  const [alike, setAlike] = useState(10)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const close = () => useStore.setState({ autoStackOpen: false })
  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      const s = useStore.getState()
      const ids = s.selected.size >= 2 ? [...s.selected] : await api().photoIds({ ...s.filters, stacks: 'all' })
      const [stacks, photos] = how === 'time' ? await api().stackAuto(ids, gap) : await api().stackSimilar(ids, alike)
      await s.reload()
      close()
      useStore.getState().say(stacks === 0 ? how === 'time' ? 'No photos were taken close enough together to stack.' : 'No photos that look alike were found.' : `Made ${plural(stacks, 'stack')} of ${plural(photos, 'photo')}.`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onClose={close} title="Auto-stack" busy={busy}>
      <div className="form">
        <div className="seg" role="group" aria-label="How to stack">
          <button type="button" aria-pressed={how === 'time'} onClick={() => setHow('time')}>
            By capture time
          </button>
          <button type="button" aria-pressed={how === 'look'} onClick={() => setHow('look')}>
            By look (near duplicates)
          </button>
        </div>
        {how === 'look' && (
          <div className="field-row">
            <label className="lbl" htmlFor="auto-stack-alike">
              How alike
            </label>
            <select id="auto-stack-alike" className="field" value={alike} disabled={busy} onChange={(e) => setAlike(Number(e.target.value))}>
              <option value={5}>Nearly identical</option>
              <option value={10}>Alike</option>
              <option value={16}>Roughly alike</option>
            </select>
          </div>
        )}
        {how === 'time' && (
        <div className="field-row">
          <label className="lbl" htmlFor="auto-stack-gap">
            Stack photos taken no more than
          </label>
          <select id="auto-stack-gap" className="field" value={gap} disabled={busy} onChange={(e) => setGap(Number(e.target.value))}>
            {GAPS.map(([s, label]) => (
              <option key={s} value={s}>
                {label}
              </option>
            ))}
          </select>
          <span className="lbl">apart</span>
        </div>
        )}
        <p className="hint">{selected.size >= 2 ? `Looks at the ${selected.size} selected photos.` : 'Looks at every photo shown now.'} Photos that are in a stack already and virtual copies are left alone.</p>
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="dialog-foot">
        <button className="btn" onClick={close} disabled={busy}>
          Cancel
        </button>
        <button className="btn accent" onClick={() => void run()} disabled={busy}>
          Stack
        </button>
      </div>
    </Dialog>
  )
}
