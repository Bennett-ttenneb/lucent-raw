import { FIELDS, field, newRule, valueKind, withOp } from '../lib/smart'
import type { CollectionRow, SmartRule, SmartRules } from '../lib/types'

/** At most this many rules in one list (the core checks the same). */
export const MAX_RULES = 12
/** Groups inside groups, at most this deep (the top list is level 1). */
export const MAX_DEPTH = 3

/** A group of rules: a rule whose field is "group", with its own all-or-any list inside it. */
export const newGroup = (): SmartRule => ({ field: 'group', op: 'group', value: '', group: { mode: 'all', rules: [newRule('rating')] } })

interface Props {
  list: SmartRules
  onChange(next: SmartRules): void
  collections: CollectionRow[]
  /** 1 for the top list */
  depth?: number
  /** the number of the group this list is in ("2." for rule 2), empty at the top */
  prefix?: string
}

/**
 * The rules of one list: each has a field, a test, a value, a "not" box that turns it round, and a remove button; and a rule can be a
 * group, which holds a list of its own (with its own all-or-any), down to three levels.
 */
export function RuleList({ list, onChange, collections, depth = 1, prefix = '' }: Props) {
  const choosable = collections.filter((c) => c.kind === 'collection')
  const setRule = (i: number, r: SmartRule) => onChange({ ...list, rules: list.rules.map((x, k) => (k === i ? r : x)) })

  const control = (r: SmartRule, i: number, n: string) => {
    const kind = valueKind(r)
    const label = `Value for rule ${n}`
    const f = field(r.field)
    if (kind === 'choice')
      return (
        <select className="field" aria-label={label} value={r.value} onChange={(e) => setRule(i, { ...r, value: e.target.value })}>
          {f.choices!.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      )
    if (kind === 'collection')
      return (
        <select className="field" aria-label={label} value={r.value} onChange={(e) => setRule(i, { ...r, value: e.target.value })}>
          <option value="">Choose a collection…</option>
          {choosable.map((c) => (
            <option key={c.id} value={String(c.id)}>
              {c.name}
            </option>
          ))}
        </select>
      )
    if (kind === 'day') return <input className="field" type="date" aria-label={label} value={r.value} onChange={(e) => setRule(i, { ...r, value: e.target.value })} />
    if (kind === 'days')
      return (
        <span className="row">
          <input className="field narrow" type="number" min={1} max={36500} aria-label={label} value={r.value} onChange={(e) => setRule(i, { ...r, value: e.target.value })} /> days
        </span>
      )
    if (kind === 'whole' || kind === 'number') return <input className="field narrow" type="number" step={kind === 'whole' ? 1 : 0.1} min={0} aria-label={label} value={r.value} onChange={(e) => setRule(i, { ...r, value: e.target.value })} />
    return <input className="field" aria-label={label} maxLength={100} value={r.value} placeholder="Type some text" onChange={(e) => setRule(i, { ...r, value: e.target.value })} />
  }

  return (
    <>
      <ul className="smart-rules" aria-label={depth === 1 ? 'Rules' : `Rules in group ${prefix.replace(/\.$/, '')}`}>
        {list.rules.map((r, i) => {
          const n = `${prefix}${i + 1}`
          return (
            <li key={i} className={r.field === 'group' ? 'smart-group' : undefined}>
              {r.field === 'group' && r.group ? (
                <div className="stack">
                  <div className="row">
                    <label className="inline">
                      <input type="checkbox" aria-label={`Not, for rule ${n}`} checked={!!r.negate} onChange={(e) => setRule(i, { ...r, negate: e.target.checked })} /> Not
                    </label>
                    <label className="inline">
                      Group {n}: a photo is in it if it meets
                      <select className="field" aria-label={`Group ${n} meets`} value={r.group.mode} onChange={(e) => setRule(i, { ...r, group: { ...r.group!, mode: e.target.value as 'all' | 'any' } })}>
                        <option value="all">all of these rules</option>
                        <option value="any">any one of these rules</option>
                      </select>
                    </label>
                    <button type="button" className="btn sm" aria-label={`Remove rule ${n}`} disabled={list.rules.length <= 1} onClick={() => onChange({ ...list, rules: list.rules.filter((_, k) => k !== i) })}>
                      ×
                    </button>
                  </div>
                  <RuleList list={r.group} onChange={(g) => setRule(i, { ...r, group: g })} collections={collections} depth={depth + 1} prefix={`${n}.`} />
                </div>
              ) : (
                <>
                  <label className="inline smart-not">
                    <input type="checkbox" aria-label={`Not, for rule ${n}`} checked={!!r.negate} onChange={(e) => setRule(i, { ...r, negate: e.target.checked })} /> Not
                  </label>
                  <select className="field" aria-label={`Field for rule ${n}`} value={r.field} onChange={(e) => setRule(i, { ...newRule(e.target.value), negate: r.negate })}>
                    {FIELDS.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </select>
                  <select className="field" aria-label={`Test for rule ${n}`} value={r.op} onChange={(e) => setRule(i, withOp(r, e.target.value))}>
                    {field(r.field).ops.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                  {control(r, i, n)}
                  <button type="button" className="btn sm" aria-label={`Remove rule ${n}`} disabled={list.rules.length <= 1} onClick={() => onChange({ ...list, rules: list.rules.filter((_, k) => k !== i) })}>
                    ×
                  </button>
                </>
              )}
            </li>
          )
        })}
      </ul>
      <div className="row">
        <button type="button" className="btn sm" aria-label={depth === 1 ? 'Add a rule' : `Add a rule to group ${prefix.replace(/\.$/, '')}`} disabled={list.rules.length >= MAX_RULES} onClick={() => onChange({ ...list, rules: [...list.rules, newRule('rating')] })}>
          {depth === 1 ? 'Add a rule' : 'Add a rule here'}
        </button>
        {depth < MAX_DEPTH && (
          <button type="button" className="btn sm" aria-label={depth === 1 ? 'Add a group' : `Add a group to group ${prefix.replace(/\.$/, '')}`} disabled={list.rules.length >= MAX_RULES} onClick={() => onChange({ ...list, rules: [...list.rules, newGroup()] })}>
            {depth === 1 ? 'Add a group' : 'Add a group here'}
          </button>
        )}
      </div>
    </>
  )
}
