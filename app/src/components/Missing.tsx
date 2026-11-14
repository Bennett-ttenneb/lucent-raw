import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { num, plural } from '../lib/format'
import { useStore } from '../lib/store'
import type { MissingGroup, MissingReport, Progress, RelinkOutcome } from '../lib/types'
import { Dialog, ProgressBar } from './Primitives'

type Trial = { rootId: number; folder: string; found: number; total: number }

/**
 * Missing photos: the catalog only remembers where each photo's file is. If a folder was moved or renamed, a drive has a new
 * letter or is not connected, or a file was deleted, the photo shows as missing. This looks for them, and offers two ways to
 * connect them again: say where a whole folder went, or search a folder for the files. Nothing is moved, copied or deleted.
 */
export function MissingDialog() {
  const open = useStore((s) => s.missingOpen)
  const close = () => useStore.setState({ missingOpen: false })
  const [report, setReport] = useState<MissingReport | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [busy, setBusy] = useState<'scan' | 'work' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [trial, setTrial] = useState<Trial | null>(null)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let off = () => {}
    void api().on<Progress>('missing:progress', setProgress).then((u) => (off = u))
    return () => off()
  }, [])

  const refreshLibrary = () => void useStore.getState().reload()

  const scan = async () => {
    setBusy('scan')
    setError(null)
    setProgress(null)
    try {
      setReport(await api().missingScan())
      refreshLibrary()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  useEffect(() => {
    if (!open) return
    setReport(null)
    setTrial(null)
    setNote(null)
    void scan()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const choose = async (g: MissingGroup) => {
    setError(null)
    setNote(null)
    const folder = await api().pickFolder(`Choose where the folder "${g.path}" is now`)
    if (!folder) return
    try {
      const r = await api().relinkPreview(g.rootId, folder)
      setTrial({ rootId: g.rootId, folder, found: r.found, total: r.total })
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const apply = async () => {
    if (!trial) return
    setBusy('work')
    setError(null)
    try {
      const r = await api().relinkRoot(trial.rootId, trial.folder)
      setReport(r)
      setNote(`The folder now points at ${trial.folder}.`)
      setTrial(null)
      refreshLibrary()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }
  const search = async () => {
    setError(null)
    setNote(null)
    const folder = await api().pickFolder('Choose a folder to search for the missing photos')
    if (!folder) return
    setBusy('work')
    setProgress(null)
    try {
      const r = await api().relinkSearch(folder)
      setReport(r.report)
      setNote(searchSummary(r.outcome))
      refreshLibrary()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  return (
    <Dialog open={open} onClose={close} title="Missing photos" wide busy={busy !== null}>
      <div className="form">
        <p>
          The catalog remembers where each photo's file is. A photo is missing when its file is no longer there: the folder was moved or renamed, a drive is not connected or has a new letter, or the file was deleted. Your photos are never moved, copied or deleted by anything here.
        </p>
        {busy === 'scan' && <ProgressBar done={progress?.done ?? 0} total={progress?.total ?? 0} label="Looking for the files" />}
        {busy === 'work' && progress && progress.total === 0 && <p role="status">Looked at {plural(progress.done, 'file')} so far…</p>}
        {report && report.missing === 0 && busy !== 'scan' && (
          <p role="status">
            <strong>Nothing is missing.</strong> All {plural(report.checked, 'photo')} are where the catalog expects them.
          </p>
        )}
        {report && report.missing > 0 && (
          <>
            <p role="status">
              <strong>{plural(report.missing, 'photo')} missing</strong> out of {num(report.checked)}.
            </p>
            <ul className="catalog-list" aria-label="Folders with missing photos">
              {report.groups.map((g) => (
                <li key={g.rootId}>
                  <div className="grow">
                    <strong className="path" title={g.path}>
                      {g.path}
                    </strong>
                    <small>
                      {g.missing === g.total ? `All ${plural(g.total, 'photo')} missing` : `${g.missing} of ${plural(g.total, 'photo')} missing`}.{' '}
                      {g.folderThere ? 'The folder is there, so some files were moved or deleted.' : 'The folder is not there: it was moved or renamed, or its drive is not connected.'}
                    </small>
                    {trial && trial.rootId === g.rootId && (
                      <div role="status">
                        {trial.found === 0 ? (
                          <p>None of this folder's photos are in {trial.folder}. Choose another place, or search a folder below.</p>
                        ) : (
                          <p>
                            {trial.found} of {plural(trial.total, 'photo')} are in <span className="path">{trial.folder}</span>.
                          </p>
                        )}
                        <div className="row">
                          {trial.found > 0 && (
                            <button type="button" className="btn sm accent" disabled={busy !== null} onClick={() => void apply()}>
                              Use this folder
                            </button>
                          )}
                          <button type="button" className="btn sm" disabled={busy !== null} onClick={() => setTrial(null)}>
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  <button type="button" className="btn sm" disabled={busy !== null} aria-label={`Say where ${g.path} went`} onClick={() => void choose(g)}>
                    It moved…
                  </button>
                </li>
              ))}
            </ul>
            <div className="row">
              <button type="button" className="btn" disabled={busy !== null} onClick={() => void search()}>
                Search a folder for them…
              </button>
              <span className="hint">Looks for files with the same name and size, in the folder and the folders inside it.</span>
            </div>
          </>
        )}
        {note && <p role="status">{note}</p>}
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="dialog-foot">
        <button type="button" className="btn" disabled={busy !== null} onClick={() => void scan()}>
          Look again
        </button>
        <button type="button" className="btn" disabled={busy !== null} onClick={close}>
          Done
        </button>
      </div>
    </Dialog>
  )
}

function searchSummary(o: RelinkOutcome): string {
  const parts = [o.relinked > 0 ? `Found and reconnected ${plural(o.relinked, 'photo')}.` : 'Nothing in that folder matched.']
  if (o.byContent > 0) parts.push(`${plural(o.byContent, 'photo')} had been renamed and ${o.byContent === 1 ? 'was' : 'were'} found by what is inside the file.`)
  if (o.stillMissing > 0) parts.push(`${plural(o.stillMissing, 'photo')} still missing.`)
  if (o.ambiguous > 0) parts.push(`${plural(o.ambiguous, 'photo')} left alone because more than one file fits (or one file fits more than one photo).`)
  if (o.conflicts > 0) parts.push(`${plural(o.conflicts, 'photo')} left alone because the file is already in the catalog.`)
  return parts.join(' ')
}
