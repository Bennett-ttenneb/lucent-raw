import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { plural } from '../lib/format'
import { newRule } from '../lib/smart'
import { refreshCollections, useStore } from '../lib/store'
import type { SmartRules } from '../lib/types'
import { RuleList } from './SmartRuleList'
import { Dialog } from './Primitives'

/**
 * The rule builder for a smart collection: a name, whether a photo must meet all of the rules or any one of them, and the rules.
 * It shows how many photos meet the rules as they are changed. A smart collection fills itself, so photos are never put in by hand.
 */
export function SmartDialog() {
  const edit = useStore((s) => s.smartDialog)
  const open = edit !== null
  const collections = useStore((s) => s.collections)
  const close = () => useStore.setState({ smartDialog: null })
  const [name, setName] = useState('')
  const [rules, setRules] = useState<SmartRules>({ mode: 'all', rules: [newRule('rating')] })
  const [matches, setMatches] = useState<{ n: number } | { error: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // each time it opens: a new one starts with one rule, an existing one loads its own
  useEffect(() => {
    if (!edit) return
    setError(null)
    setMatches(null)
    if (edit.id === null) {
      setName('')
      setRules({ mode: 'all', rules: [newRule('rating')] })
    } else {
      setName(collections.find((c) => c.id === edit.id)?.name ?? '')
      void api()
        .smartRules(edit.id)
        .then(setRules)
        .catch((e) => setError((e as Error).message))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, edit?.id])

  // how many photos meet the rules, a moment after they stop changing
  useEffect(() => {
    if (!open) return
    let alive = true
    const t = setTimeout(() => {
      api()
        .smartCount(rules)
        .then((n) => alive && setMatches({ n }))
        .catch((e) => alive && setMatches({ error: (e as Error).message }))
    }, 250)
    return () => {
      alive = false
      clearTimeout(t)
    }
  }, [open, rules])

  const save = async () => {
    if (!edit) return
    setBusy(true)
    setError(null)
    try {
      const n = name.replace(/\s+/g, ' ').trim()
      if (!n) throw new Error('Give the smart collection a name.')
      let id = edit.id
      if (id === null) id = await api().smartCreate(n, rules)
      else await api().smartUpdate(id, n, rules)
      await refreshCollections()
      await useStore.getState().setSource({ collectionId: id })
      useStore.getState().say(edit.id === null ? `Made the smart collection “${n}”.` : `Saved “${n}”.`)
      close()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onClose={close} title={edit?.id === null ? 'New smart collection' : 'Smart collection rules'} wide busy={busy}>
      <div className="form">
        <p className="hint">A smart collection fills itself: it holds every photo that meets its rules, now and as the catalog changes. Photos cannot be put in by hand.</p>
        <div className="field-row">
          <label className="lbl" htmlFor="smart-name">
            Name
          </label>
          <input id="smart-name" className="field" maxLength={100} value={name} placeholder="For example: Best of this year" onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="field-row">
          <label className="lbl" htmlFor="smart-mode">
            A photo is in it if it meets
          </label>
          <select id="smart-mode" className="field" value={rules.mode} onChange={(e) => setRules((s) => ({ ...s, mode: e.target.value as 'all' | 'any' }))}>
            <option value="all">all of these rules</option>
            <option value="any">any one of these rules</option>
          </select>
        </div>
        <RuleList list={rules} onChange={setRules} collections={collections} />
        <div className="row">          <span className="hint" role="status">
            {matches === null ? '' : 'n' in matches ? `${plural(matches.n, 'photo')} meet${matches.n === 1 ? 's' : ''} these rules now.` : matches.error}
          </span>
        </div>
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="dialog-foot">
        <button type="button" className="btn" disabled={busy} onClick={close}>
          Cancel
        </button>
        <button type="button" className="btn accent" disabled={busy} onClick={() => void save()}>
          Save
        </button>
      </div>
    </Dialog>
  )
}
