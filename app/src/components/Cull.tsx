import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { plural } from '../lib/format'
import { useStore } from '../lib/store'
import type { CullReport, CullRow, Progress } from '../lib/types'
import { Dialog, ProgressBar } from './Primitives'

type Phase = 'idle' | 'scanning' | 'done'

/**
 * Cull: look at the previews of the selected photos (or everything shown) and point out the ones that are probably not
 * keepers: out of focus, badly exposed, and bursts or near-duplicates with the best of each. It only measures; nothing is
 * flagged until a button is pressed, and a flag can be undone.
 */
export function CullDialog() {
  const open = useStore((s) => s.cullOpen)
  const close = () => useStore.setState({ cullOpen: false })
  const [phase, setPhase] = useState<Phase>('idle')
  const [ids, setIds] = useState<number[]>([])
  const [scope, setScope] = useState('')
  const [progress, setProgress] = useState<Progress>({ done: 0, total: 0 })
  const [report, setReport] = useState<CullReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let off = () => {}
    void api().on<Progress>('cull:progress', setProgress).then((u) => (off = u))
    return () => off()
  }, [])

  // each time it opens: the photos to look at are the selected ones if several are selected, otherwise everything shown
  useEffect(() => {
    if (!open) return
    let alive = true
    setPhase('idle')
    setReport(null)
    setError(null)
    setNote(null)
    const s = useStore.getState()
    if (s.selected.size > 1) {
      setIds([...s.selected])
      setScope(`the ${s.selected.size} selected photos`)
    } else {
      setIds([])
      setScope('everything shown in the Library')
      void api()
        .photoIds(s.filters)
        .then((all) => alive && setIds(all))
        .catch((e) => alive && setError((e as Error).message))
    }
    return () => {
      alive = false
    }
  }, [open])

  const start = async () => {
    setPhase('scanning')
    setProgress({ done: 0, total: ids.length })
    setError(null)
    setNote(null)
    try {
      setReport(await api().cullScan(ids))
      setPhase('done')
    } catch (e) {
      setError((e as Error).message)
      setPhase('idle')
    }
  }

  const rows = report?.rows ?? []
  const soft = useMemo(() => rows.filter((r) => r.soft), [rows])
  const exposure = useMemo(() => rows.filter((r) => r.exposure), [rows])
  const weak = useMemo(() => rows.filter((r) => r.look !== null && r.look < 4.3 && !r.soft && !r.exposure), [rows])
  const groups = useMemo(() => {
    const m = new Map<number, CullRow[]>()
    for (const r of rows) if (r.group !== null) m.set(r.group, [...(m.get(r.group) ?? []), r])
    return [...m.entries()].sort((a, b) => a[0] - b[0])
  }, [rows])
  const losers = useMemo(() => groups.flatMap(([, g]) => g.filter((r) => !r.best)), [groups])
  const skipped = rows.filter((r) => r.skipped).length

  const select = (list: CullRow[]) => {
    useStore.setState({ selected: new Set(list.map((r) => r.id)) })
    setNote(`${plural(list.length, 'photo')} selected in the Library.`)
  }
  const reject = async (list: CullRow[]) => {
    try {
      await api().setFlag(list.map((r) => r.id), -1)
      await useStore.getState().reload()
      setNote(`${plural(list.length, 'photo')} marked as reject. You can undo this by selecting them and pressing X.`)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const Row = ({ r, extra }: { r: CullRow; extra?: string }) => (
    <li>
      <span className="trunc">{r.name}</span>
      {extra && <small className="muted">{extra}</small>}
    </li>
  )

  return (
    <Dialog open={open} onClose={close} title="Cull photos" busy={phase === 'scanning'} wide>
      <div className="form">
        {phase === 'idle' && (
          <>
            <p>
              Cull looks at {scope} and points out the ones that are probably not keepers: photos that are out of focus, photos that are badly exposed, and bursts or near-duplicates (with the best of each named). It only measures. Nothing is flagged until you press a button.
            </p>
            <p className="hint">It also scores how good each photo looks to most people (a small model, built in). It cannot tell closed eyes, blinks or expressions, so look at the best of each group yourself.</p>
            <p role="status">{ids.length === 0 ? 'Looking for the photos…' : `${plural(ids.length, 'photo')} to look at.`}</p>
          </>
        )}
        {phase === 'scanning' && <ProgressBar done={progress.done} total={progress.total} label="Culling progress" />}
        {phase === 'done' && report && (
          <>
            <p role="status">
              Looked at {plural(rows.length - skipped, 'photo')}: {soft.length} out of focus, {exposure.length} badly exposed, {plural(groups.length, 'group')} of bursts or near-duplicates.
              {skipped > 0 && ` ${plural(skipped, 'photo')} could not be looked at (no preview yet).`}
            </p>
            <section aria-label="Out of focus">
              <h3 className="export-head">Out of focus ({soft.length})</h3>
              {soft.length === 0 ? (
                <p className="hint">None found.</p>
              ) : (
                <>
                  <ul className="cull-list" aria-label="Out of focus photos">
                    {soft.slice(0, 50).map((r) => (
                      <Row key={r.id} r={r} extra={`sharpness ${Math.round(r.sharpness)}`} />
                    ))}
                    {soft.length > 50 && <li className="hint">and {soft.length - 50} more</li>}
                  </ul>
                  <div className="row">
                    <button type="button" className="btn sm" onClick={() => select(soft)}>
                      Select these {soft.length}
                    </button>
                    <button type="button" className="btn sm" onClick={() => void reject(soft)}>
                      Reject these {soft.length}
                    </button>
                  </div>
                </>
              )}
            </section>
            <section aria-label="Badly exposed">
              <h3 className="export-head">Badly exposed ({exposure.length})</h3>
              {exposure.length === 0 ? (
                <p className="hint">None found.</p>
              ) : (
                <>
                  <ul className="cull-list" aria-label="Badly exposed photos">
                    {exposure.slice(0, 50).map((r) => (
                      <Row key={r.id} r={r} extra={r.exposure ?? ''} />
                    ))}
                    {exposure.length > 50 && <li className="hint">and {exposure.length - 50} more</li>}
                  </ul>
                  <div className="row">
                    <button type="button" className="btn sm" onClick={() => select(exposure)}>
                      Select these {exposure.length}
                    </button>
                    <button type="button" className="btn sm" onClick={() => void reject(exposure)}>
                      Reject these {exposure.length}
                    </button>
                  </div>
                </>
              )}
            </section>
            <section aria-label="Plain-looking photos">
              <h3 className="export-head">Plain-looking photos ({weak.length})</h3>
              {weak.length === 0 ? (
                <p className="hint">None found.</p>
              ) : (
                <>
                  <ul className="cull-list" aria-label="Plain-looking photos">
                    {weak.slice(0, 50).map((r) => (
                      <Row key={r.id} r={r} extra={`look ${(r.look ?? 0).toFixed(1)} of 10`} />
                    ))}
                    {weak.length > 50 && <li className="hint">and {weak.length - 50} more</li>}
                  </ul>
                  <div className="row">
                    <button type="button" className="btn sm" onClick={() => select(weak)}>
                      Select these {weak.length}
                    </button>
                  </div>
                  <p className="hint">Scored by a model trained on what people rate highly (sharp, well lit, colourful, well framed). It is a rough guide to taste and cannot see what a photo means to you, so only select these; look before you reject.</p>
                </>
              )}
            </section>
            <section aria-label="Bursts and near-duplicates">
              <h3 className="export-head">Bursts and near-duplicates ({groups.length})</h3>
              {groups.length === 0 ? (
                <p className="hint">None found.</p>
              ) : (
                <>
                  <ol className="cull-groups" aria-label="Groups">
                    {groups.slice(0, 30).map(([g, list]) => (
                      <li key={g}>
                        <strong>
                          {plural(list.length, 'photo')}, best: {list.find((r) => r.best)?.name}
                        </strong>
                        <span className="muted"> ({list.filter((r) => !r.best).map((r) => r.name).join(', ')})</span>
                      </li>
                    ))}
                    {groups.length > 30 && <li className="hint">and {groups.length - 30} more groups</li>}
                  </ol>
                  <div className="row">
                    <button type="button" className="btn sm" onClick={() => select(losers)}>
                      Select the {losers.length} others
                    </button>
                    <button type="button" className="btn sm" onClick={() => void reject(losers)}>
                      Keep the best of each group and reject the other {losers.length}
                    </button>
                  </div>
                </>
              )}
            </section>
            {note && (
              <p role="status" className="result">
                {note}
              </p>
            )}
          </>
        )}
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="dialog-foot">
        <button className="btn" onClick={close} disabled={phase === 'scanning'}>
          {phase === 'done' ? 'Done' : 'Close'}
        </button>
        {phase !== 'done' && (
          <button className="btn accent" onClick={() => void start()} disabled={phase === 'scanning' || ids.length === 0} aria-busy={phase === 'scanning'}>
            {phase === 'scanning' ? 'Looking…' : 'Start'}
          </button>
        )}
      </div>
    </Dialog>
  )
}
