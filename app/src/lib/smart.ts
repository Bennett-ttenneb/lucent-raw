import type { SmartRule } from './types'

/** What a rule's value is typed into. */
export type ValueKind = 'text' | 'whole' | 'number' | 'day' | 'days' | 'choice' | 'collection'

export interface FieldDef {
  id: string
  name: string
  ops: { id: string; name: string }[]
  /** the value control (for "date", "last" turns it into a number of days) */
  kind: ValueKind
  choices?: { id: string; name: string }[]
  /** what a new rule on this field starts with */
  start: string
}

const NUM_OPS = [
  { id: '>=', name: 'is at least' },
  { id: '=', name: 'is' },
  { id: '<=', name: 'is at most' },
]
const YES_NO = [
  { id: 'yes', name: 'yes' },
  { id: 'no', name: 'no' },
]

/** The things a smart collection can look at. The core checks every rule again, so this only decides what is offered. */
export const FIELDS: FieldDef[] = [
  { id: 'rating', name: 'Rating', ops: NUM_OPS, kind: 'choice', choices: [0, 1, 2, 3, 4, 5].map((n) => ({ id: String(n), name: n === 0 ? 'no stars' : `${n} star${n === 1 ? '' : 's'}` })), start: '3' },
  { id: 'flag', name: 'Flag', ops: [{ id: 'is', name: 'is' }], kind: 'choice', choices: [{ id: 'pick', name: 'picked' }, { id: 'reject', name: 'rejected' }, { id: 'unflagged', name: 'not flagged' }], start: 'pick' },
  { id: 'label', name: 'Colour label', ops: [{ id: 'is', name: 'is' }], kind: 'choice', choices: ['red', 'yellow', 'green', 'blue', 'purple', 'none'].map((c) => ({ id: c, name: c === 'none' ? 'no label' : c })), start: 'red' },
  { id: 'keyword', name: 'Keyword', ops: [{ id: 'is', name: 'is (or is under)' }, { id: 'contains', name: 'contains' }], kind: 'text', start: '' },
  { id: 'text', name: 'File name, title, caption, creator or copyright', ops: [{ id: 'contains', name: 'contains' }], kind: 'text', start: '' },
  { id: 'camera', name: 'Camera', ops: [{ id: 'contains', name: 'contains' }], kind: 'text', start: '' },
  { id: 'lens', name: 'Lens', ops: [{ id: 'contains', name: 'contains' }], kind: 'text', start: '' },
  { id: 'iso', name: 'ISO', ops: NUM_OPS, kind: 'whole', start: '800' },
  { id: 'focal', name: 'Focal length (mm)', ops: NUM_OPS, kind: 'number', start: '50' },
  { id: 'aperture', name: 'Aperture (f/)', ops: NUM_OPS, kind: 'number', start: '2.8' },
  { id: 'date', name: 'Date taken', ops: [{ id: 'last', name: 'is in the last' }, { id: 'after', name: 'is after' }, { id: 'before', name: 'is before' }, { id: 'on', name: 'is on' }], kind: 'day', start: '30' },
  { id: 'format', name: 'File type', ops: [{ id: 'is', name: 'is' }], kind: 'choice', choices: ['raw', 'dng', 'jpeg', 'tiff', 'png', 'heic'].map((f) => ({ id: f, name: f.toUpperCase() })), start: 'raw' },
  { id: 'edited', name: 'Has edits', ops: [{ id: 'is', name: 'is' }], kind: 'choice', choices: YES_NO, start: 'yes' },
  { id: 'copy', name: 'Is a virtual copy', ops: [{ id: 'is', name: 'is' }], kind: 'choice', choices: YES_NO, start: 'no' },
  { id: 'missing', name: 'File is missing', ops: [{ id: 'is', name: 'is' }], kind: 'choice', choices: YES_NO, start: 'yes' },
  { id: 'collection', name: 'Is in the collection', ops: [{ id: 'is', name: 'is' }], kind: 'collection', start: '' },
]

export const field = (id: string): FieldDef => FIELDS.find((f) => f.id === id) ?? FIELDS[0]

/** A new rule for this field, with the first test and a sensible start value. */
export function newRule(fieldId: string): SmartRule {
  const f = field(fieldId)
  return { field: f.id, op: f.ops[0].id, value: f.start }
}

/** The value control a rule needs (a date rule is a number of days after "in the last", a day otherwise). */
export function valueKind(r: SmartRule): ValueKind {
  const f = field(r.field)
  return f.kind === 'day' ? (r.op === 'last' ? 'days' : 'day') : f.kind
}

/** Today as YYYY-MM-DD, for a new "after" or "before" date. */
export const today = () => new Date().toISOString().slice(0, 10)

/** When a test changes, the value may need to change with it (days become a date, and back). */
export function withOp(r: SmartRule, op: string): SmartRule {
  const was = valueKind(r)
  const next = { ...r, op }
  const now = valueKind(next)
  if (was !== now) next.value = now === 'days' ? '30' : today()
  return next
}
