import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useDevelop } from '../lib/develop'
import type { Advice, Recipe, Suggestion } from '../lib/types'
import { Panel } from './Primitives'

const patchOf = (items: Suggestion[]): Partial<Recipe> => {
  const patch: Record<string, number> = {}
  for (const s of items) for (const c of s.changes) patch[c.field] = c.value
  return patch as Partial<Recipe>
}

/**
 * B BOT: looks at the photo as it is now and says what it would change, and why. It measures (the colour of the skin on the
 * faces it finds, how light the picture is, how much is blown out or crushed) and does not guess at taste. Every change it makes
 * is one step in the history, so Undo takes it back.
 */
export function BBotPanel({ skinFirst = false }: { skinFirst?: boolean }) {
  const photoId = useDevelop((s) => s.photoId)
  const loading = useDevelop((s) => s.loading)
  const [advice, setAdvice] = useState<Advice | null>(null)
  const [done, setDone] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // what B BOT said was about the photo that was open
  useEffect(() => {
    setAdvice(null)
    setDone([])
    setError(null)
  }, [photoId])

  const ask = async () => {
    if (photoId === null) return
    const id = photoId
    setBusy(true)
    setError(null)
    try {
      const a = await api().advisePhoto(id, useDevelop.getState().recipe)
      if (useDevelop.getState().photoId !== id) return // moved on while it was looking
      setAdvice(a)
      setDone([])
    } catch (e) {
      setAdvice(null)
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const apply = async (items: Suggestion[], label: string) => {
    await useDevelop.getState().setAndCommit(patchOf(items), { label, deltaText: null, valueText: null })
    setDone((d) => [...d, ...items.map((s) => s.id)])
  }

  const todo = (advice?.items ?? []).filter((s) => !done.includes(s.id))
  const ordered = skinFirst ? [...todo].sort((a, b) => Number(b.id.startsWith('skin')) - Number(a.id.startsWith('skin'))) : todo

  return (
    <Panel title="B BOT">
      <p className="hint">B BOT looks at this photo, measures the skin tones and the light, and suggests changes. You decide what to apply, and Undo takes any of it back.</p>
      <button type="button" className="btn sm" disabled={photoId === null || loading || busy} aria-busy={busy} onClick={() => void ask()}>
        {busy ? 'B BOT is looking…' : advice ? 'Ask B BOT again' : 'Ask B BOT'}
      </button>
      {error && (
        <p className="err" role="alert">
          {error}
        </p>
      )}
      {advice && (
        <div role="status" className="bbot">
          <p>
            {advice.faces === 0 ? 'I did not find a face, so I looked at the whole picture.' : `I found ${advice.faces === 1 ? '1 face' : `${advice.faces} faces`}. ${advice.skin ? advice.skin.verdict : 'There was not enough skin showing to judge its colour.'}`}
          </p>
          {advice.look != null && <p className="hint">How it looks to most people: {advice.look.toFixed(1)} out of 10 (5 is ordinary; a rough guide, not a verdict).</p>}
          {todo.length === 0 && <p className="hint">{advice.items.length === 0 ? 'Nothing to suggest: this photo looks balanced to me.' : 'All of my suggestions are applied. Ask again to see if there is more.'}</p>}
        </div>
      )}
      {ordered.length > 0 && (
        <ul className="bbot-list" aria-label="B BOT suggestions">
          {ordered.map((s) => (
            <li key={s.id}>
              <strong>{s.title}</strong>
              <span className="hint">{s.why}</span>
              <button type="button" className="btn sm" aria-label={`Apply: ${s.title}`} onClick={() => void apply([s], `B BOT: ${s.title}`)}>
                Apply
              </button>
            </li>
          ))}
          {ordered.length > 1 && (
            <li>
              <button type="button" className="btn accent sm" onClick={() => void apply(ordered, 'B BOT: all suggestions')}>
                Apply all {ordered.length}
              </button>
            </li>
          )}
        </ul>
      )}
    </Panel>
  )
}
