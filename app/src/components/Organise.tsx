import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { cleanCollectionName, fieldView, META_FIELDS, META_MAIN, META_MORE, parseKeywords, type MetaField } from '../lib/logic'
import * as presetStore from '../lib/metaPresets'
import { plural } from '../lib/format'
import { refreshCollections, useStore } from '../lib/store'
import type { KeywordRow, KeywordUse } from '../lib/types'
import { Panel } from './Primitives'
import { Thumb } from './Thumb'

/** The ids that marks and edits apply to: the selection, or the current photo. */
export function useTargetIds(): number[] {
  const selected = useStore((s) => s.selected)
  const current = useStore((s) => s.photoAt(s.active))
  return useMemo(() => (selected.size ? [...selected] : current ? [current.id] : []), [selected, current?.id]) // eslint-disable-line react-hooks/exhaustive-deps
}

export function NavigatorPanel() {
  const photo = useStore((s) => s.photoAt(s.active))
  useStore((s) => s.pages)
  return (
    <Panel title="Navigator">
      {photo ? (
        <div className="nav" role="img" aria-label={`Preview of ${photo.name}`}>
          <Thumb photo={photo} level="standard" className="nav-img" />
        </div>
      ) : (
        <p className="hint">Select a photo to see it here.</p>
      )}
    </Panel>
  )
}

export function CollectionsPanel() {
  const collections = useStore((s) => s.collections)
  const sourceId = useStore((s) => s.filters.collectionId)
  const setSource = useStore((s) => s.setSource)
  const ids = useTargetIds()
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [include, setInclude] = useState(true)
  const [renaming, setRenaming] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [makingSet, setMakingSet] = useState(false)
  const [closedSets, setClosedSets] = useState<Set<number>>(new Set())
  /** a collection set that was clicked: it is not a source of photos, but it can be renamed, deleted and added to */
  const [pickedSet, setPickedSet] = useState<number | null>(null)
  const user = collections.filter((c) => c.kind === 'collection' || c.kind === 'smart' || c.kind === 'set')
  const sets = user.filter((c) => c.kind === 'set')
  const current = user.find((c) => c.id === sourceId) ?? sets.find((c) => c.id === pickedSet)
  /** the sets from the top down to this one's parent, so a set cannot be offered a place inside itself */
  const insideOf = (id: number): number[] => user.filter((c) => c.parentId === id).flatMap((c) => [c.id, ...insideOf(c.id)])

  const fail = (e: unknown) => setError((e as Error).message)

  const create = async () => {
    const n = cleanCollectionName(name)
    if (!n) return setError('Give the collection a name of 1 to 100 characters.')
    try {
      if (makingSet) {
        await api().collectionSetCreate(n, current?.kind === 'set' ? current.id : null)
        await refreshCollections()
        setCreating(false)
        setMakingSet(false)
        setName('')
        setError(null)
        useStore.getState().say(`Created the set “${n}”`)
        return
      }
      const id = await api().collectionCreate(n)
      if (current?.kind === 'set') await api().collectionMove(id, current.id)
      if (include && ids.length) await api().collectionAdd(id, ids)
      await refreshCollections()
      setCreating(false)
      setName('')
      setError(null)
      useStore.getState().say(`Created “${n}”`)
    } catch (e) {
      fail(e)
    }
  }

  /** the collections and sets whose parent is `parent`, each set followed by what is in it */
  const level = (parent: number | null, depth: number): React.ReactNode =>
    user
      .filter((c) => (c.parentId ?? null) === parent)
      .map((c) =>
        c.kind === 'set' ? (
          <li key={c.id}>
            <button aria-current={pickedSet === c.id && sourceId !== c.id ? 'true' : undefined} aria-expanded={!closedSets.has(c.id)} style={{ paddingLeft: 6 + depth * 12 }} onClick={() => {
                const again = pickedSet === c.id && sourceId === undefined
                setPickedSet(c.id)
                void setSource({})
                // the first click chooses the set and opens it; clicking it again opens or closes it
                setClosedSets((s) => (again ? (s.has(c.id) ? new Set([...s].filter((x) => x !== c.id)) : new Set([...s, c.id])) : new Set([...s].filter((x) => x !== c.id))))
              }}>
              <span aria-hidden>{closedSets.has(c.id) ? '▸' : '▾'}</span> <span className="trunc">{c.name}</span>
              <span className="pill">Set</span>
            </button>
            {!closedSets.has(c.id) && <ul className="tree sub">{level(c.id, depth + 1)}</ul>}
          </li>
        ) : (
          <li key={c.id}>
            <button aria-current={c.id === sourceId ? 'true' : undefined} style={{ paddingLeft: 6 + depth * 12 }} onClick={() => (setPickedSet(null), void setSource({ collectionId: c.id }))}>
              <span className="trunc">{c.name}</span>
              {c.kind === 'smart' && <span className="pill">Smart</span>}
              {c.isTarget && <span className="pill">Target</span>}
              <span className="cnt">{c.count}</span>
            </button>
          </li>
        ),
      )
  return (
    <Panel
      title="Collections"
      action={
        <>
          <button className="icon-btn" aria-label="New smart collection" title="New smart collection: it fills itself from rules" onClick={() => useStore.setState({ smartDialog: { id: null } })}>
            ✦
          </button>
          <button className="icon-btn" aria-label="New set of collections" title="New collection set: a folder for collections" onClick={() => (setCreating(!creating || !makingSet), setMakingSet(true), setError(null))}>
            ▤
          </button>
          <button className="icon-btn" aria-label="New collection" title="New collection" onClick={() => (setCreating(!creating || makingSet), setMakingSet(false), setError(null))}>
            +
          </button>
        </>
      }
    >
      {creating && (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault()
            void create()
          }}
        >
          <label className="inline stackl">
            {makingSet ? 'Set name' : 'Collection name'}
            <input className="field" value={name} onChange={(e) => setName(e.target.value)} autoFocus maxLength={120} aria-invalid={!!error} />
          </label>
          {!makingSet && ids.length > 0 && (
            <label className="inline">
              <input type="checkbox" checked={include} onChange={(e) => setInclude(e.target.checked)} /> Include {plural(ids.length, 'selected photo')}
            </label>
          )}
          <div className="row">
            <button className="btn sm accent" type="submit">
              Create
            </button>
            <button className="btn sm" type="button" onClick={() => (setCreating(false), setError(null))}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      {user.length === 0 && !creating ? (
        <p className="hint">No collections yet. Use + to make one.</p>
      ) : (
        <ul className="tree" aria-label="Collections">
          {level(null, 0)}
        </ul>
      )}
      {current && (
        <div className="stack tools" role="group" aria-label={`Actions for ${current.name}`}>
          {current.kind === 'smart' && (
            <button className="btn sm" onClick={() => useStore.setState({ smartDialog: { id: current.id } })}>
              Edit rules…
            </button>
          )}
          {current.kind === 'collection' && (
          <>
          <button className="btn sm" disabled={!ids.length} onClick={() => void api().collectionAdd(current.id, ids).then(refreshCollections).then(() => useStore.getState().say(`Added to ${current.name}`)).catch(fail)}>
            Add selected photos
          </button>
          <button
            className="btn sm"
            disabled={!ids.length}
            onClick={() => void api().collectionRemove(current.id, ids).then(() => useStore.getState().reload()).then(() => useStore.getState().say(`Removed from ${current.name}`)).catch(fail)}
          >
            Take selected out
          </button>
          <button className="btn sm" aria-pressed={current.isTarget} onClick={() => void api().collectionSetTarget(current.isTarget ? null : current.id).then(refreshCollections).catch(fail)}>
            {current.isTarget ? 'Not the target' : 'Make target (Shift+B adds)'}
          </button>
          </>
          )}
          <label className="inline">
            Put in set
            <select
              className="field"
              value={current.parentId ?? ''}
              onChange={(e) => void api().collectionMove(current.id, e.target.value === '' ? null : Number(e.target.value)).then(refreshCollections).catch(fail)}
            >
              <option value="">(none: at the top)</option>
              {sets
                .filter((s) => s.id !== current.id && !(current.kind === 'set' && insideOf(current.id).includes(s.id)))
                .map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
            </select>
          </label>
          {renaming ? (
            <RenameRow
              initial={current.name}
              onDone={async (n) => {
                try {
                  if (n) await api().collectionRename(current.id, n)
                  await refreshCollections()
                  setRenaming(false)
                } catch (e) {
                  fail(e)
                }
              }}
            />
          ) : (
            <button className="btn sm" onClick={() => setRenaming(true)}>
              Rename…
            </button>
          )}
          {confirmDelete ? (
            <div className="row" role="alertdialog" aria-label="Confirm delete">
              <span className="hint">{current.kind === 'set' ? 'Delete this set? The collections in it stay.' : 'Delete this collection? Photos stay.'}</span>
              <button
                className="btn sm danger"
                onClick={() =>
                  void (async () => {
                    try {
                      await setSource({})
                      await api().collectionDelete(current.id)
                      await refreshCollections()
                      setConfirmDelete(false)
                      useStore.getState().say(`Deleted “${current.name}”`)
                    } catch (e) {
                      fail(e)
                    }
                  })()
                }
              >
                Delete
              </button>
              <button className="btn sm" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
            </div>
          ) : (
            <button className="btn sm danger" onClick={() => setConfirmDelete(true)}>
              {current.kind === 'set' ? 'Delete set…' : 'Delete collection…'}
            </button>
          )}
        </div>
      )}
    </Panel>
  )
}

function RenameRow({ initial, onDone }: { initial: string; onDone: (name: string | null) => void }) {
  const [v, setV] = useState(initial)
  return (
    <form
      className="row"
      onSubmit={(e) => {
        e.preventDefault()
        onDone(cleanCollectionName(v))
      }}
    >
      <label className="sr" htmlFor="rename-col">
        New name
      </label>
      <input id="rename-col" className="field" value={v} onChange={(e) => setV(e.target.value)} autoFocus />
      <button className="btn sm accent" type="submit">
        Save
      </button>
      <button className="btn sm" type="button" onClick={() => onDone(null)}>
        Cancel
      </button>
    </form>
  )
}

function pathOf(k: KeywordRow, all: KeywordRow[]): string {
  const parts = [k.name]
  for (let p = k.parentId, guard = 0; p !== null && guard < 5; guard++) {
    const parent = all.find((x) => x.id === p)
    if (!parent) break
    parts.unshift(parent.name)
    p = parent.parentId
  }
  return parts.join(' > ')
}

export function KeywordingPanel() {
  const ids = useTargetIds()
  const keywords = useStore((s) => s.keywords)
  const [uses, setUses] = useState<KeywordUse[]>([])
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const key = ids.join(',')

  useEffect(() => {
    let live = true
    if (!ids.length) return setUses([])
    api()
      .keywordsFor(ids)
      .then((u) => live && setUses(u))
      .catch(() => live && setUses([]))
    return () => {
      live = false
    }
  }, [key, keywords]) // eslint-disable-line react-hooks/exhaustive-deps

  const add = async () => {
    const paths = parseKeywords(text)
    if (!paths.length || !ids.length) return
    try {
      for (const p of paths) await api().keywordAdd(ids, p)
      setText('')
      setError(null)
      await refreshCollections()
      useStore.getState().say(`Added ${plural(paths.length, 'keyword')}`)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  return (
    <Panel title="Keywords">
      {ids.length === 0 ? (
        <p className="hint">Select photos to add keywords.</p>
      ) : (
        <div className="stack">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void add()
            }}
          >
            <label className="stackl inline">
              Add keywords
              <input className="field" value={text} onChange={(e) => setText(e.target.value)} placeholder="beach, sunset > orange" aria-describedby="kw-h" />
            </label>
            <p id="kw-h" className="hint">
              Separate with commas. Use &gt; for a sub-keyword. Press Enter to add to {plural(ids.length, 'photo')}.
            </p>
          </form>
          {error && (
            <p className="err" role="alert">
              {error}
            </p>
          )}
          {uses.length === 0 ? (
            <p className="hint">No keywords on {ids.length === 1 ? 'this photo' : 'these photos'} yet.</p>
          ) : (
            <ul className="kwchips" aria-label="Keywords on the selection">
              {uses.map((u) => {
                const k = keywords.find((x) => x.id === u.keywordId)
                if (!k) return null
                const partial = u.count < ids.length
                return (
                  <li key={u.keywordId} className="kwchip" title={pathOf(k, keywords)}>
                    <span>{k.name}</span>
                    {partial && <small>{`${u.count} of ${ids.length}`}</small>}
                    <button
                      aria-label={`Remove keyword ${k.name} from ${plural(partial ? u.count : ids.length, 'photo')}`}
                      onClick={() => void api().keywordRemove(ids, u.keywordId).then(refreshCollections).catch((e) => setError((e as Error).message))}
                    >
                      ×
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
      )}
    </Panel>
  )
}

export function KeywordListPanel() {
  const keywords = useStore((s) => s.keywords)
  const current = useStore((s) => s.filters.keywordId)
  const setSource = useStore((s) => s.setSource)
  const [find, setFind] = useState('')
  const rows = useMemo(() => {
    const out: { k: KeywordRow; depth: number }[] = []
    const walk = (parent: number | null, depth: number) => {
      keywords
        .filter((k) => k.parentId === parent)
        .sort((a, b) => a.name.localeCompare(b.name))
        .forEach((k) => (out.push({ k, depth }), depth < 4 && walk(k.id, depth + 1)))
    }
    walk(null, 0)
    return out
  }, [keywords])
  // the name or any synonym can be typed in the find box
  const q = find.trim().toLowerCase()
  const shown = q ? rows.filter(({ k }) => k.name.toLowerCase().includes(q) || k.synonyms.toLowerCase().includes(q)) : rows
  const picked = keywords.find((k) => k.id === current)
  return (
    <Panel title="Keyword list" defaultOpen={false}>
      {rows.length === 0 ? (
        <p className="hint">Keywords you add appear here.</p>
      ) : (
        <>
          <input className="field" type="search" aria-label="Find a keyword" placeholder="Find a keyword or synonym" value={find} onChange={(e) => setFind(e.target.value)} />
          <ul className="tree" aria-label="Keyword list">
            {shown.map(({ k, depth }) => (
              <li key={k.id}>
                <button style={{ paddingLeft: `calc(var(--space-4) + ${q ? 0 : depth} * var(--space-5))` }} aria-current={k.id === current ? 'true' : undefined} onClick={() => void setSource({ keywordId: k.id })} title={k.synonyms ? `Also: ${k.synonyms}` : undefined}>
                  <span className="trunc">{k.name}</span>
                  {k.isPrivate && <span className="pill">Private</span>}
                  <span className="cnt">{k.count}</span>
                </button>
              </li>
            ))}
          </ul>
          {shown.length === 0 && <p className="hint">No keyword or synonym matches.</p>}
          {picked && <KeywordOptions key={picked.id} keyword={picked} />}
        </>
      )}
    </Panel>
  )
}

/** Synonyms, and what goes into sidecar files, for the keyword that is chosen in the list. */
function KeywordOptions({ keyword }: { keyword: KeywordRow }) {
  const [synonyms, setSynonyms] = useState(keyword.synonyms)
  const [onExport, setOnExport] = useState(keyword.includeOnExport)
  const [priv, setPriv] = useState(keyword.isPrivate)
  const [error, setError] = useState<string | null>(null)
  const save = async (next: { synonyms?: string; onExport?: boolean; priv?: boolean }) => {
    const s = next.synonyms ?? synonyms
    const e = next.onExport ?? onExport
    const p = next.priv ?? priv
    try {
      await api().keywordSetOptions(keyword.id, s, e, p)
      setError(null)
      await refreshCollections() // reads the keyword list again
    } catch (err) {
      setError((err as Error).message)
    }
  }
  return (
    <div className="stack tools" role="group" aria-label={`Options for ${keyword.name}`}>
      <label className="inline stackl">
        Synonyms
        <input className="field" value={synonyms} maxLength={600} placeholder="seaside, shore" onChange={(e) => setSynonyms(e.target.value)} onBlur={() => synonyms !== keyword.synonyms && void save({ synonyms })} />
      </label>
      <label className="inline">
        <input type="checkbox" checked={onExport && !priv} disabled={priv} onChange={(e) => (setOnExport(e.target.checked), void save({ onExport: e.target.checked }))} /> Write to sidecar files
      </label>
      <label className="inline">
        <input type="checkbox" checked={priv} onChange={(e) => (setPriv(e.target.checked), void save({ priv: e.target.checked }))} /> Private (never written out)
      </label>
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}
const FIELD_LABEL: Record<MetaField, string> = { title: 'Title', caption: 'Caption', creator: 'Creator', copyright: 'Copyright', credit: 'Credit', source: 'Source', sublocation: 'Place (street or site)', city: 'City', state: 'State or region', country: 'Country', headline: 'Headline', jobTitle: 'Position held', instructions: 'Instructions', jobId: 'Job identifier', usageTerms: 'Usage terms' }
const EMPTY_DRAFT = Object.fromEntries(META_FIELDS.map((f) => [f, ''])) as Record<MetaField, string>

export function MetadataEditPanel() {
  const ids = useTargetIds()
  const key = ids.join(',')
  const [shown, setShown] = useState<Record<MetaField, { value: string; mixed: boolean }> | null>(null)
  const [draft, setDraft] = useState<Record<MetaField, string>>(EMPTY_DRAFT)
  const [error, setError] = useState<string | null>(null)
  const dirty = useRef<Set<MetaField>>(new Set())
  const [presets, setPresets] = useState(presetStore.load)
  const [presetName, setPresetName] = useState('')
  const [naming, setNaming] = useState(false)
  const [presetError, setPresetError] = useState<string | null>(null)

  const load = () => {
    if (!ids.length) return setShown(null)
    api()
      .metadataGet(ids)
      .then((m) => {
        const v = Object.fromEntries(META_FIELDS.map((f) => [f, fieldView(m[f])])) as Record<MetaField, { value: string; mixed: boolean }>
        setShown(v)
        setDraft(Object.fromEntries(META_FIELDS.map((f) => [f, v[f].value])) as Record<MetaField, string>)
        dirty.current.clear()
      })
      .catch((e) => setError((e as Error).message))
  }
  useEffect(load, [key]) // eslint-disable-line react-hooks/exhaustive-deps

  const commit = async (f: MetaField) => {
    if (!dirty.current.has(f) || !ids.length) return
    dirty.current.delete(f)
    try {
      await api().metadataSet(ids, { [f]: draft[f] })
      setError(null)
      load()
    } catch (e) {
      setError((e as Error).message)
      load()
    }
  }

  const applyPreset = async (name: string) => {
    const p = presets.find((x) => x.name === name)
    if (!p || !ids.length) return
    try {
      await api().metadataSet(ids, p.values)
      setError(null)
      load()
    } catch (e) {
      setError((e as Error).message)
    }
  }
  const keepPreset = () => {
    // what is shown now, leaving out the fields that hold different values on different photos
    const values = Object.fromEntries(META_FIELDS.filter((f) => !shown?.[f].mixed || dirty.current.has(f)).map((f) => [f, draft[f]]))
    const r = presetStore.save(presetName, values)
    if ('error' in r) return setPresetError(r.error)
    setPresets(r.list)
    setNaming(false)
    setPresetName('')
    setPresetError(null)
  }
  const field = (f: MetaField) => (
    <label key={f} className="stackl inline">
      {FIELD_LABEL[f]}
      {f === 'caption' ? (
        <textarea
          className="field area"
          rows={3}
          value={draft[f]}
          placeholder={shown?.[f].mixed ? 'Mixed values' : ''}
          onChange={(e) => (dirty.current.add(f), setDraft({ ...draft, [f]: e.target.value }))}
          onBlur={() => void commit(f)}
        />
      ) : (
        <input
          className="field"
          value={draft[f]}
          placeholder={shown?.[f].mixed ? 'Mixed values' : ''}
          onChange={(e) => (dirty.current.add(f), setDraft({ ...draft, [f]: e.target.value }))}
          onBlur={() => void commit(f)}
          onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget.blur(), e.preventDefault())}
        />
      )}
    </label>
  )

  return (
    <Panel title="Metadata">
      {!shown ? (
        <p className="hint">Select a photo to edit its details.</p>
      ) : (
        <div className="stack">
          {META_MAIN.map(field)}
          <details className="more-details">
            <summary>More details</summary>
            <div className="stack">{META_MORE.map(field)}</div>
          </details>
          <div className="row meta-presets" role="group" aria-label="Detail presets">
            <select className="field" aria-label="Detail presets" value="" onChange={(e) => void applyPreset(e.target.value)}>
              <option value="">{presets.length ? 'Apply a preset…' : 'No presets yet'}</option>
              {presets.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.name}
                </option>
              ))}
            </select>
            {!naming && (
              <button type="button" className="btn sm" onClick={() => setNaming(true)}>
                Keep these details…
              </button>
            )}
            {naming && (
              <>
                <input className="field" aria-label="Name for this preset" placeholder="Preset name" value={presetName} onChange={(e) => setPresetName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && keepPreset()} autoFocus />
                <button type="button" className="btn sm accent" onClick={keepPreset}>
                  Keep
                </button>
                <button type="button" className="btn sm" onClick={() => (setNaming(false), setPresetName(''), setPresetError(null))}>
                  Cancel
                </button>
              </>
            )}
            {presets.length > 0 && !naming && (
              <select className="field" aria-label="Delete a preset" value="" onChange={(e) => e.target.value && setPresets(presetStore.remove(e.target.value))}>
                <option value="">Delete a preset…</option>
                {presets.map((p) => (
                  <option key={p.name} value={p.name}>
                    {p.name}
                  </option>
                ))}
              </select>
            )}
            {presetError && (
              <span className="err" role="alert">
                {presetError}
              </span>
            )}
          </div>
          {ids.length > 1 && <p className="hint">Changes apply to all {plural(ids.length, 'selected photo')}. Fields with mixed values stay as they are unless you type in them.</p>}
          {error && (
            <p className="err" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </Panel>
  )
}
