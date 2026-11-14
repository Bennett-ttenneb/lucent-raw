import { useState } from 'react'
import * as saved from '../lib/savedFilters'
import { useStore } from '../lib/store'

/** Saved filters: keep what the filter bar is set to under a name, and bring it back with one choice. */
export function SavedFilters({ onApplied }: { onApplied: (tab: 'text' | 'attribute' | 'metadata', text: string) => void }) {
  const filters = useStore((s) => s.filters)
  const setFilters = useStore((s) => s.setFilters)
  const [list, setList] = useState(saved.load)
  const [current, setCurrent] = useState('')
  const [naming, setNaming] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)

  const apply = (n: string) => {
    setCurrent(n)
    const s = list.find((x) => x.name === n)
    if (!s) return
    void setFilters({ ...saved.cleared(), ...s.filter })
    onApplied(saved.tabFor(s.filter), s.filter.text ?? '')
  }
  const keep = () => {
    const r = saved.save(name, saved.partOf(filters))
    if ('error' in r) return setError(r.error)
    setList(r.list)
    setCurrent(name.trim())
    setNaming(false)
    setName('')
    setError(null)
  }

  return (
    <div className="saved-filters" role="group" aria-label="Saved filters">
      <select className="field" aria-label="Saved filters" value={current} onChange={(e) => apply(e.target.value)}>
        <option value="">{list.length ? 'Saved filters' : 'No saved filters'}</option>
        {list.map((s) => (
          <option key={s.name} value={s.name}>
            {s.name}
          </option>
        ))}
      </select>
      {current && (
        <button
          type="button"
          className="btn sm"
          onClick={() => {
            setList(saved.remove(current))
            setCurrent('')
          }}
        >
          Delete “{current}”
        </button>
      )}
      {!naming && (
        <button type="button" className="btn sm" onClick={() => setNaming(true)}>
          Keep this filter…
        </button>
      )}
      {naming && (
        <>
          <input className="field" aria-label="Name for this filter" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && keep()} autoFocus />
          <button type="button" className="btn sm accent" onClick={keep}>
            Keep
          </button>
          <button
            type="button"
            className="btn sm"
            onClick={() => {
              setNaming(false)
              setName('')
              setError(null)
            }}
          >
            Cancel
          </button>
        </>
      )}
      {error && (
        <span className="err" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
