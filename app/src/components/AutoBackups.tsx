import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { num, plural } from '../lib/format'
import type { AutoBackupState } from '../lib/types'

const KIND: Record<string, string> = { auto: 'Automatic', 'before-upgrade': 'Before an upgrade', 'before-restore': 'Before a restore' }

/**
 * Automatic backups of the open catalog: on or off, how often, how many to keep, and the list of copies with a Restore button.
 * Restoring first saves the catalog as it is now (it appears in the same list), so a restore can be undone.
 */
export function AutoBackups({ open, disabled, onRestored }: { open: boolean; disabled: boolean; onRestored: () => Promise<void> }) {
  const [st, setSt] = useState<AutoBackupState | null>(null)
  const [working, setWorking] = useState<'now' | 'restore' | 'save' | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setConfirm(null)
    setError(null)
    setDone(null)
    api()
      .backupAutoState()
      .then(setSt)
      .catch((e: Error) => setError(e.message))
  }, [open])

  const run = async (kind: 'now' | 'restore' | 'save', job: () => Promise<AutoBackupState>, say?: string) => {
    setWorking(kind)
    setError(null)
    setDone(null)
    try {
      setSt(await job())
      if (say) setDone(say)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setWorking(null)
    }
  }
  const save = (patch: Partial<AutoBackupState['settings']>) => {
    if (!st) return
    const s = { ...st.settings, ...patch }
    void run('save', () => api().backupAutoSettingsSet(s.on, s.everyDays, s.keep))
  }
  const restore = async (file: string) => {
    setConfirm(null)
    setWorking('restore')
    setError(null)
    setDone(null)
    try {
      setSt(await api().backupRestore(file))
      await onRestored()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setWorking(null)
    }
  }
  const locked = disabled || working !== null || !st

  return (
    <fieldset className="export-group" aria-label="Automatic backups">
      <legend>Automatic backups</legend>
      <p className="hint">A copy of the catalog is kept inside its own folder. It holds your ratings, keywords, edits and books. Your photos are not copied; they stay where they are.</p>
      <div className="row">
        <label className="check">
          <input type="checkbox" checked={st?.settings.on ?? true} disabled={locked} onChange={(e) => save({ on: e.target.checked })} />
          Back up automatically
        </label>
        <label>
          every{' '}
          <input type="number" min={1} max={90} aria-label="Days between backups" value={st?.settings.everyDays ?? 1} disabled={locked || !st?.settings.on} onChange={(e) => save({ everyDays: Number(e.target.value) || 1 })} style={{ width: 56 }} />{' '}
          {st?.settings.everyDays === 1 ? 'day' : 'days'}
        </label>
        <label>
          keep the newest{' '}
          <input type="number" min={1} max={30} aria-label="Automatic backups to keep" value={st?.settings.keep ?? 7} disabled={locked || !st?.settings.on} onChange={(e) => save({ keep: Number(e.target.value) || 1 })} style={{ width: 56 }} />
        </label>
        <button type="button" className="btn" disabled={locked} onClick={() => void run('now', () => api().backupAutoNow(), 'Backup made.')}>
          {working === 'now' ? 'Backing up…' : 'Back up now'}
        </button>
      </div>
      {st && st.backups.length === 0 && <p className="hint">No automatic backups yet.</p>}
      {st && st.backups.length > 0 && (
        <ul className="plain-list" aria-label="Backups of this catalog">
          {st.backups.map((b) => (
            <li key={b.file}>
              {confirm === b.file ? (
                <span role="group" aria-label={`Restore the copy from ${b.when}`}>
                  Put the copy from {b.when} in place of the catalog? The catalog as it is now is saved first, so you can undo this from this list.{' '}
                  <button type="button" className="btn accent" disabled={locked} onClick={() => void restore(b.file)}>
                    Restore
                  </button>{' '}
                  <button type="button" className="btn" onClick={() => setConfirm(null)}>
                    Cancel
                  </button>
                </span>
              ) : (
                <>
                  <strong>{b.when}</strong> · {KIND[b.kind] ?? b.kind} · {plural(b.photos, 'photo')} · {(b.bytes / 1_000_000).toFixed(1)} MB{' '}
                  <button type="button" className="btn sm" disabled={locked} aria-label={`Restore the copy from ${b.when}`} onClick={() => setConfirm(b.file)}>
                    Restore…
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {st && <p className="hint">Kept in <span className="path">{st.folder}</span>. {num(st.backups.length)} in the list.</p>}
      {done && <p role="status">{done}</p>}
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  )
}
