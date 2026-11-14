import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { num, plural } from '../lib/format'
import { useStore } from '../lib/store'
import type { Progress, XmpReadOut, XmpStatus, XmpWriteOut } from '../lib/types'
import { Dialog, ProgressBar } from './Primitives'

type WriteScope = 'changed' | 'all' | 'selected'
type ReadScope = 'all' | 'selected'

const KIND_NAMES: Record<string, string> = { rating: 'rating', flag: 'pick or reject flag', label: 'colour label', title: 'title', caption: 'caption', creator: 'creator', copyright: 'copyright', keywords: 'keywords', edits: 'edits', lightroom: 'Lightroom develop settings' }

/**
 * Sidecar files (XMP): a small text file kept next to a photo that holds what the catalog knows about it (rating, label, title,
 * caption, creator, copyright, keywords and the edits), so it is not only in the catalog. Other programs read the ratings,
 * labels, text and keywords. A sidecar this app did not write is never replaced.
 */
export function SidecarsDialog() {
  const open = useStore((s) => s.sidecarsOpen)
  const selected = useStore((s) => s.selected)
  const close = () => useStore.setState({ sidecarsOpen: false })
  const [status, setStatus] = useState<XmpStatus | null>(null)
  const [wScope, setWScope] = useState<WriteScope>('changed')
  const [rScope, setRScope] = useState<ReadScope>('all')
  const [busy, setBusy] = useState<'write' | 'read' | 'apply' | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  const [wrote, setWrote] = useState<XmpWriteOut | null>(null)
  const [looked, setLooked] = useState<XmpReadOut | null>(null)
  const [applied, setApplied] = useState<XmpReadOut | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let off = () => {}
    void api().on<Progress>('xmp:progress', setProgress).then((u) => (off = u))
    return () => off()
  }, [])
  const refresh = () =>
    api()
      .xmpStatus()
      .then(setStatus)
      .catch((e) => setError((e as Error).message))
  useEffect(() => {
    if (!open) return
    setWrote(null)
    setLooked(null)
    setApplied(null)
    setError(null)
    setWScope('changed')
    setRScope('all')
    void refresh()
  }, [open])

  const ids = [...selected]
  const run = async <T,>(kind: 'write' | 'read' | 'apply', job: () => Promise<T>, done: (r: T) => void) => {
    setBusy(kind)
    setError(null)
    setProgress(null)
    try {
      done(await job())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
      void refresh()
    }
  }
  const noSelection = ids.length === 0

  return (
    <Dialog open={open} onClose={close} title="Sidecar files" wide busy={busy !== null}>
      <div className="form">
        <p>
          A sidecar is a small file kept next to a photo (<code>name.xmp</code> beside a RAW file, <code>name.jpg.xmp</code> beside anything else). It holds the rating, colour label, pick or reject flag, title, caption, creator, copyright, keywords and the edits, so they are not only in the catalog. Other photo programs, such as darktable and digiKam, read the ratings, labels, text and keywords; the edits are in this app's own form and only this app uses them. Your photos themselves are never changed.
        </p>
        <fieldset className="export-group">
          <legend>Keep them up to date</legend>
          <label className="check">
            <input
              type="checkbox"
              checked={status?.auto ?? false}
              disabled={!status || busy !== null}
              onChange={(e) => void run('write', () => api().xmpSetAuto(e.target.checked), (s) => setStatus(s))}
            />{' '}
            Write sidecar files by themselves a few seconds after something changes
          </label>
          <p className="hint" role="status">
            {status === null ? '' : status.changed === 0 ? 'Every sidecar is up to date.' : `${plural(status.changed, 'photo')} changed since ${status.changed === 1 ? 'its' : 'their'} sidecar was written.`}
          </p>
          {status?.lastError && (
            <p className="err" role="alert">
              The last automatic write had a problem: {status.lastError}
            </p>
          )}
        </fieldset>
        <fieldset className="export-group">
          <legend>Write sidecar files now</legend>
          <div className="field-row">
            <label className="lbl" htmlFor="xmp-w">
              For
            </label>
            <select id="xmp-w" className="field" value={wScope} disabled={busy !== null} onChange={(e) => setWScope(e.target.value as WriteScope)}>
              <option value="changed">Photos changed since their sidecar was written ({num(status?.changed ?? 0)})</option>
              <option value="all">All photos in the catalog</option>
              <option value="selected">The selected photos ({num(ids.length)})</option>
            </select>
            <button type="button" className="btn accent" disabled={busy !== null || (wScope === 'selected' && noSelection)} onClick={() => void run('write', () => api().xmpWriteNow(wScope, ids), setWrote)}>
              {busy === 'write' ? 'Writing…' : 'Write'}
            </button>
          </div>
          {busy === 'write' && progress && progress.total > 0 && <ProgressBar done={progress.done} total={progress.total} label="Writing sidecar files" />}
          {wrote && (
            <div role="status">
              <p>
                Wrote {plural(wrote.written, 'file')}
                {wrote.unchanged > 0 ? `; ${plural(wrote.unchanged, 'file')} already up to date` : ''}
                {wrote.missing > 0 ? `; ${plural(wrote.missing, 'photo')} skipped because the photo file is not there` : ''}.
              </p>
              {wrote.leftAlone.length > 0 && (
                <p>
                  {plural(wrote.leftAlone.length, 'sidecar')} left alone because a file from another program is already there (or it cannot be read), and this app never replaces those: {wrote.leftAlone.slice(0, 5).join(', ')}
                  {wrote.leftAlone.length > 5 ? ` and ${wrote.leftAlone.length - 5} more` : ''}. You can still read them below.
                </p>
              )}
            </div>
          )}
          {wrote && wrote.failed.length > 0 && (
            <div className="err" role="alert">
              <p>{plural(wrote.failed.length, 'file')} could not be written (is the folder read-only?):</p>
              <ul className="plain-list">
                {wrote.failed.slice(0, 5).map((f, i) => (
                  <li key={i}>{f}</li>
                ))}
              </ul>
            </div>
          )}
        </fieldset>
        <fieldset className="export-group">
          <legend>Read sidecar files</legend>
          <p className="hint">Reading makes the catalog agree with the sidecars: ratings, labels, flags and text are replaced by what the sidecar says, and keywords and edits are added (never taken away). An edit that is read can be undone in Develop.</p>
          <p className="hint">A sidecar written by Lightroom or Camera Raw also carries develop settings. The ones that mean the same here are read: exposure, contrast, highlights, shadows, whites, blacks, texture, clarity, dehaze, vibrance, saturation, the colour mixer, the tone curve and an unturned crop. White balance, sharpening, noise reduction, profiles, masks and the rest are not, so the picture can look a little different from Lightroom's.</p>
          <div className="field-row">
            <label className="lbl" htmlFor="xmp-r">
              For
            </label>
            <select id="xmp-r" className="field" value={rScope} disabled={busy !== null} onChange={(e) => setRScope(e.target.value as ReadScope)}>
              <option value="all">All photos in the catalog</option>
              <option value="selected">The selected photos ({num(ids.length)})</option>
            </select>
            <button
              type="button"
              className="btn"
              disabled={busy !== null || (rScope === 'selected' && noSelection)}
              onClick={() => (setApplied(null), void run('read', () => api().xmpReadNow(rScope, ids, false), setLooked))}
            >
              {busy === 'read' ? 'Looking…' : 'Look at the sidecars'}
            </button>
          </div>
          {busy === 'read' && progress && progress.total > 0 && <ProgressBar done={progress.done} total={progress.total} label="Reading sidecar files" />}
          {looked && (
            <div role="status">
              {looked.found === 0 ? (
                <p>No sidecar files were found.</p>
              ) : (
                <p>
                  {plural(looked.found, 'sidecar file')} found; <strong>{looked.differ === 0 ? 'none differ from the catalog' : `${looked.differ} differ from the catalog`}</strong>
                  {looked.differ > 0 ? `: ${Object.entries(looked.kinds).map(([k, n]) => `${KIND_NAMES[k] ?? k} (${n})`).join(', ')}` : ''}.
                </p>
              )}
              {looked.unreadable.length > 0 && (
                <>
                  <p>{plural(looked.unreadable.length, 'sidecar')} could not be read and will be skipped:</p>
                  <ul className="plain-list">
                    {looked.unreadable.slice(0, 5).map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                </>
              )}
              {looked.differ > 0 && !applied && (
                <button type="button" className="btn accent" disabled={busy !== null} onClick={() => void run('apply', () => api().xmpReadNow(rScope, ids, true), (r) => (setApplied(r), setLooked(null)))}>
                  {busy === 'apply' ? 'Updating…' : `Update ${plural(looked.differ, 'photo')} from their sidecars`}
                </button>
              )}
            </div>
          )}
          {applied && (
            <p role="status">
              Updated {plural(applied.applied, 'photo')} from {applied.applied === 1 ? 'its sidecar' : 'their sidecars'}.
            </p>
          )}
        </fieldset>
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="dialog-foot">
        <button type="button" className="btn" disabled={busy !== null} onClick={close}>
          Done
        </button>
      </div>
    </Dialog>
  )
}
