import { useEffect } from 'react'
import { create } from 'zustand'
import { api } from '../lib/api'
import { usePrefs } from '../lib/prefs'

/** What is known about a newer version: asked of GitHub at most once at start (when that is switched on) and on "Check now". */
export const useUpdate = create<{
  /** the version of this copy, as the installer names it */
  version: string | null
  /** the newer version, when there is one */
  latest: string | null
  /** what the last check said, in words, for Preferences */
  note: string | null
  checking: boolean
  loadVersion(): Promise<void>
  check(): Promise<void>
}>((set, get) => ({
  version: null,
  latest: null,
  note: null,
  checking: false,
  async loadVersion() {
    if (get().version) return
    try {
      set({ version: await api().appVersion() })
    } catch {
      /* the version just is not shown */
    }
  },
  async check() {
    if (get().checking) return
    set({ checking: true, note: null })
    try {
      const u = await api().updateCheck()
      set({ version: u.current, latest: u.latest, note: u.latest ? `Version ${u.latest} is available.` : 'You have the newest version.' })
    } catch (e) {
      set({ note: (e as Error).message || String(e) })
    } finally {
      set({ checking: false })
    }
  },
}))

/** A small button in the header when a newer version has been published. It opens that release's page in the web browser. */
export function UpdateChip() {
  const latest = useUpdate((s) => s.latest)
  useEffect(() => {
    void useUpdate.getState().loadVersion()
    // once at start, and only if the person has left it switched on
    if (usePrefs.getState().checkUpdates) void useUpdate.getState().check()
  }, [])
  if (!latest) return null
  return (
    <button type="button" className="btn sm licence-chip" data-state="trial" onClick={() => void api().updateOpen(latest)} title="A newer version is on GitHub. This opens its page in your web browser; nothing is installed by itself.">
      Version {latest} is available
    </button>
  )
}

/** The update part of Preferences: the switch, "Check now", and what the last check said. */
export function UpdateSection() {
  const { latest, note, checking } = useUpdate()
  const on = usePrefs((s) => s.checkUpdates)
  return (
    <fieldset className="export-group">
      <legend>Updates</legend>
      <label>
        <input type="checkbox" checked={on} onChange={(e) => usePrefs.getState().setCheckUpdates(e.target.checked)} /> Look for a newer version when the program starts
      </label>
      <p className="hint">This asks GitHub for the list of Lucent Raw's releases. Nothing about you, your photos or your catalog is sent, and nothing is downloaded or installed by itself: you are shown the page and decide.</p>
      <div className="row">
        <button type="button" className="btn sm" aria-busy={checking} disabled={checking} onClick={() => void useUpdate.getState().check()}>
          {checking ? 'Checking…' : 'Check now'}
        </button>
        {latest && (
          <button type="button" className="btn sm" onClick={() => void api().updateOpen(latest)}>
            Open the download page
          </button>
        )}
      </div>
      {note && (
        <p className="hint" role="status">
          {note}
        </p>
      )}
    </fieldset>
  )
}
