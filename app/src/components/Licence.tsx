import { useEffect, useState } from 'react'
import { useLicence } from '../lib/licence'
import { useStore } from '../lib/store'

/** A small button beside Preferences while the program is on trial or the trial is over. It opens Preferences, where the key goes. */
export function LicenceChip() {
  const status = useLicence((s) => s.status)
  useEffect(() => {
    void useLicence.getState().refresh()
  }, [])
  if (!status || status.state === 'licensed') return null
  const text = status.state === 'trial' ? `Trial: ${status.daysLeft} ${status.daysLeft === 1 ? 'day' : 'days'} left` : 'Trial ended'
  return (
    <button type="button" className="btn sm licence-chip" data-state={status.state} onClick={() => useStore.setState({ preferencesOpen: true })} title="See your licence, or enter a licence key">
      {text}
    </button>
  )
}

/** Shown at the top of Develop when the trial is over: edits are not saved until a key is entered. */
export function LicenceBanner() {
  const status = useLicence((s) => s.status)
  if (status?.state !== 'expired') return null
  return (
    <p className="hint licence-banner" role="status">
      Your 30 day trial has ended, so edits are not saved. Enter a licence key in{' '}
      <button type="button" className="btn sm" onClick={() => useStore.setState({ preferencesOpen: true })}>
        Preferences
      </button>{' '}
      to carry on. Everything else, including opening your catalog and exporting, still works.
    </p>
  )
}

/** The Licence part of Preferences: the state, and a box for the key. */
export function LicenceSection({ open }: { open: boolean }) {
  const status = useLicence((s) => s.status)
  const [key, setKey] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  useEffect(() => {
    if (!open) return
    setKey('')
    setError(null)
    setDone(null)
    void useLicence.getState().refresh()
  }, [open])
  const use = async () => {
    setError(null)
    setDone(null)
    try {
      const s = await useLicence.getState().enter(key)
      setKey('')
      setDone(`Thank you. This copy is licensed to ${s.name ?? 'you'}.`)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <fieldset className="export-group" aria-label="Licence">
      <legend>Licence</legend>
      {status?.state === 'licensed' && (
        <p role="status">
          Licensed to <strong>{status.name}</strong>. It does not expire, and it works in every version 1 update.
        </p>
      )}
      {status?.state === 'trial' && (
        <p role="status">
          You are using the 30 day trial: {status.daysLeft} {status.daysLeft === 1 ? 'day' : 'days'} left. Nothing is locked now; after the trial, editing needs a licence key.
        </p>
      )}
      {status?.state === 'expired' && <p role="status">The 30 day trial has ended. Edits are not saved until you enter a licence key. Opening your catalog, rating, keywording and exporting still work.</p>}
      {status?.problem && <p className="err">{status.problem}</p>}
      {status && status.state !== 'licensed' && (
        <>
          <label className="stack">
            Licence key
            <textarea rows={3} value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} placeholder="LRAW1.…" />
          </label>
          <div className="row">
            <button type="button" className="btn accent" disabled={key.trim() === ''} onClick={() => void use()}>
              Use this key
            </button>
          </div>
        </>
      )}
      {done && <p role="status">{done}</p>}
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      <p className="hint">The key is checked on this computer. Nothing is sent anywhere.</p>
    </fieldset>
  )
}
