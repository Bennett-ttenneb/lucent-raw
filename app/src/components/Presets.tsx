import { useEffect, useId, useMemo, useState } from 'react'
import { useDevelop } from '../lib/develop'
import { useStore } from '../lib/store'
import { ADAPTIVE_PRESETS, ALL_GROUPS, DEFAULT_COPY_GROUPS, SETTING_GROUPS, changedGroups, isBuiltin } from '../lib/presets'
import { usePrefs } from '../lib/prefs'
import type { PresetRow, SnapshotRow } from '../lib/types'
import { Dialog, Panel } from './Primitives'

/** A tick list of the groups of settings, with Check all and Check none. */
function GroupChecks({ value, onChange, legend }: { value: string[]; onChange: (v: string[]) => void; legend: string }) {
  const toggle = (id: string) => onChange(value.includes(id) ? value.filter((g) => g !== id) : [...value, id])
  return (
    <fieldset className="checks">
      <legend>{legend}</legend>
      {SETTING_GROUPS.map((g) => (
        <label key={g.id} className="check">
          <input type="checkbox" checked={value.includes(g.id)} onChange={() => toggle(g.id)} />
          {g.label}
        </label>
      ))}
      <div className="row">
        <button type="button" className="btn sm" onClick={() => onChange([...ALL_GROUPS])}>
          Check all
        </button>
        <button type="button" className="btn sm" onClick={() => onChange([])}>
          Check none
        </button>
      </div>
    </fieldset>
  )
}

export function CopyDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [groups, setGroups] = useState<string[]>(DEFAULT_COPY_GROUPS)
  useEffect(() => {
    if (open) setGroups(DEFAULT_COPY_GROUPS)
  }, [open])
  return (
    <Dialog open={open} onClose={onClose} title="Copy settings">
      <div className="form">
        <p className="hint">Pick the settings to copy. Paste them onto another photo, or back onto this one later.</p>
        <GroupChecks legend="Settings to copy" value={groups} onChange={setGroups} />
      </div>
      <div className="dialog-foot">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn accent"
          disabled={groups.length === 0}
          onClick={() => {
            useDevelop.getState().copy(groups)
            onClose()
          }}
        >
          Copy
        </button>
      </div>
    </Dialog>
  )
}

/** Sync: give the other photos selected in the Library the settings of the photo being edited. */
export function SyncDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [groups, setGroups] = useState<string[]>(DEFAULT_COPY_GROUPS)
  const others = useStore((s) => Math.max(0, s.selected.size - (s.selected.has(useDevelop.getState().photoId ?? -1) ? 1 : 0)))
  useEffect(() => {
    if (open) setGroups(changedGroups(useDevelop.getState().recipe).filter((g) => g !== 'crop'))
  }, [open])
  return (
    <Dialog open={open} onClose={onClose} title="Sync settings">
      <div className="form">
        <p className="hint">Give {others === 1 ? 'the other selected photo' : `the ${others} other selected photos`} the settings of this photo. Only the ticked groups change; everything else of theirs stays.</p>
        <GroupChecks legend="Settings to sync" value={groups} onChange={setGroups} />
      </div>
      <div className="dialog-foot">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn accent"
          disabled={groups.length === 0 || others === 0}
          onClick={() => {
            void useDevelop.getState().syncToSelection(groups)
            onClose()
          }}
        >
          Sync
        </button>
      </div>
    </Dialog>
  )
}

function PresetDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [name, setName] = useState('')
  const [group, setGroup] = useState('')
  const [groups, setGroups] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const presets = useDevelop((s) => s.presets) // a stable value; building the list inside the selector would loop forever
  const existing = useMemo(() => [...new Set(presets.filter((p) => !isBuiltin(p)).map((p) => p.group))], [presets])
  const listId = useId()
  useEffect(() => {
    if (!open) return
    setName('')
    setGroup('')
    setError(null)
    setGroups(changedGroups(useDevelop.getState().recipe).filter((g) => g !== 'crop'))
  }, [open])
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      await useDevelop.getState().createPreset(name, group.trim() || null, groups)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title="New preset" busy={busy}>
      <form
        className="form"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label className="stack">
          Name
          <input className="field" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} autoFocus aria-invalid={error ? true : undefined} />
        </label>
        <label className="stack">
          Group
          <input className="field" value={group} maxLength={100} onChange={(e) => setGroup(e.target.value)} list={listId} placeholder="User Presets" />
          <datalist id={listId}>
            {existing.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </label>
        <GroupChecks legend="Settings in the preset" value={groups} onChange={setGroups} />
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
        <div className="dialog-foot">
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="btn accent" disabled={busy || !name.trim() || groups.length === 0}>
            Create
          </button>
        </div>
      </form>
    </Dialog>
  )
}

export function PresetsPanel() {
  const presets = useDevelop((s) => s.presets)
  const hideAi = usePrefs((s) => s.hideAi)
  const busy = useDevelop((s) => s.selecting || s.loading || s.photoId === null)
  const [creating, setCreating] = useState(false)
  useEffect(() => {
    void useDevelop.getState().loadPresets()
  }, [])
  const byGroup = new Map<string, PresetRow[]>()
  for (const p of presets) byGroup.set(p.group, [...(byGroup.get(p.group) ?? []), p])
  const groups = [...byGroup.entries()].sort(([a], [b]) => (a === 'Lucent Raw' ? -1 : b === 'Lucent Raw' ? 1 : a.localeCompare(b)))
  const preview = (p: PresetRow | null) => useDevelop.getState().previewPreset(p)
  return (
    <Panel
      title="Presets"
      action={
        <button type="button" className="btn sm ghost" onClick={() => setCreating(true)} aria-label="New preset">
          + New
        </button>
      }
    >
      <div className="preset-scroll">
      {groups.map(([group, list]) => (
        <fieldset key={group} className="sgroup">
          <legend>{group}</legend>
          <ul className="preset-list">
            {list.map((p) => (
              <li key={p.id}>
                <button
                  type="button"
                  className="preset-btn"
                  title="Click to apply. Hover to preview."
                  onMouseEnter={() => preview(p)}
                  onMouseLeave={() => preview(null)}
                  onFocus={() => preview(p)}
                  onBlur={() => preview(null)}
                  onClick={() => void useDevelop.getState().applyPreset(p)}
                >
                  {p.name}
                </button>
                {!isBuiltin(p) && (
                  <button type="button" className="x" aria-label={`Delete preset ${p.name}`} onClick={() => void useDevelop.getState().deletePreset(p.id)}>
                    ×
                  </button>
                )}
              </li>
            ))}
          </ul>
        </fieldset>
      ))}
      <fieldset className="sgroup">
        <legend>Adaptive</legend>
        <p className="hint">These look for the sky, the subject or the background in this photo and adjust only that, as a mask you can change.</p>
        <ul className="preset-list">
          {ADAPTIVE_PRESETS.filter((a) => a.needs === 'sky' || !hideAi).map((a) => (
            <li key={a.name}>
              <button type="button" className="preset-btn" title="Click to find it and apply." disabled={busy} onClick={() => void useDevelop.getState().applyAdaptive(a)}>
                {a.name}
              </button>
            </li>
          ))}
        </ul>
      </fieldset>
      </div>
      <PresetDialog open={creating} onClose={() => setCreating(false)} />
    </Panel>
  )
}

export function SnapshotsPanel() {
  const snapshots = useDevelop((s) => s.snapshots)
  const photoId = useDevelop((s) => s.photoId)
  const [adding, setAdding] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const nameId = useId()
  useEffect(() => {
    setAdding(false)
    setError(null)
  }, [photoId])
  const create = async () => {
    setError(null)
    try {
      await useDevelop.getState().createSnapshot(name)
      setName('')
      setAdding(false)
    } catch (e) {
      setError((e as Error).message)
    }
  }
  return (
    <Panel
      title="Snapshots"
      action={
        <button type="button" className="btn sm ghost" onClick={() => setAdding(true)} aria-label="New snapshot" disabled={photoId === null}>
          + New
        </button>
      }
    >
      {adding && (
        <form
          className="row snap-form"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <label htmlFor={nameId} className="sr">
            Snapshot name
          </label>
          <input id={nameId} className="field grow" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} placeholder="Snapshot name" autoFocus onKeyDown={(e) => e.key === 'Escape' && setAdding(false)} />
          <button type="submit" className="btn sm" disabled={!name.trim()}>
            Create
          </button>
        </form>
      )}
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      {snapshots.length === 0 && !adding ? (
        <p className="hint">A snapshot remembers how this photo looks now, so you can come back to it.</p>
      ) : (
        <ul className="preset-list" aria-label="Snapshots, newest first">
          {snapshots.map((s: SnapshotRow) => (
            <li key={s.id}>
              <button type="button" className="preset-btn" title="Go back to this snapshot" onClick={() => void useDevelop.getState().applySnapshot(s)}>
                {s.name}
              </button>
              <button type="button" className="x" aria-label={`Delete snapshot ${s.name}`} onClick={() => void useDevelop.getState().deleteSnapshot(s.id)}>
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  )
}
