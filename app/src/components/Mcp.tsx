import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { useStore } from '../lib/store'
import type { McpStatus } from '../lib/types'
import { Dialog } from './Primitives'

const TOOLS: [string, string][] = [
  ['Look through the catalog', 'find photos by rating, flag, label, camera, lens, ISO, aperture or date'],
  ['Set ratings, flags and colour labels', 'up to 500 photos at a time'],
  ['Change tone settings', 'one photo at a time, saved as a step in its history that you can undo'],
  ['Ask B BOT for suggestions', 'it only looks; nothing is applied'],
  ['Look for photos to cull', 'out of focus, badly exposed, bursts; nothing is flagged'],
  ['Export copies', 'into a folder that exists; originals are never touched and nothing is overwritten'],
]

/**
 * The AI connection (MCP): lets an AI assistant on this computer, such as Claude Code, look at the catalog and work in the app.
 * It is off until switched on here; it listens on this computer only and needs the secret token shown below.
 */
export function AiConnectionDialog() {
  const open = useStore((s) => s.mcpOpen)
  const close = () => useStore.setState({ mcpOpen: false })
  const [st, setSt] = useState<McpStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const [confirmNew, setConfirmNew] = useState(false)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setError(null)
    setShowToken(false)
    setConfirmNew(false)
    setCopied(null)
    api()
      .mcpStatus()
      .then(setSt)
      .catch((e) => setError((e as Error).message))
  }, [open])

  const change = async (job: () => Promise<McpStatus>) => {
    setBusy(true)
    setError(null)
    try {
      setSt(await job())
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const copy = async (text: string, what: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(what)
    } catch {
      setError('The text could not be copied. Select it and copy it by hand.')
    }
  }

  return (
    <Dialog open={open} onClose={close} title="AI connection" wide busy={busy}>
      <div className="form">
        <p>
          When this is on, an AI assistant that runs on this computer (such as Claude Code) can work with Lucent Raw for you. It is off until you turn it on, it can only be reached from this computer, and it needs the secret token below.
        </p>
        <label className="check">
          <input type="checkbox" checked={st?.enabled ?? false} disabled={busy || !st} onChange={(e) => void change(() => api().mcpSetEnabled(e.target.checked))} /> Allow an AI assistant on this computer to use Lucent Raw
        </label>
        {st?.error && (
          <p className="err" role="alert">
            {st.error}
          </p>
        )}
        {st?.enabled && st.running && (
          <>
            <p role="status">
              On, and listening at <code>{st.url}</code>
            </p>
            <div className="field-row">
              <span className="lbl">Token</span>
              <code className="token" aria-label="Secret token">
                {showToken ? st.token : '•'.repeat(24)}
              </code>
              <button type="button" className="btn sm" aria-pressed={showToken} onClick={() => setShowToken(!showToken)}>
                {showToken ? 'Hide' : 'Show'}
              </button>
              <button type="button" className="btn sm" onClick={() => void copy(st.token, 'token')}>
                Copy token
              </button>
            </div>
            <p className="hint">To connect Claude Code, run this once in a terminal (it has your token in it, so keep it private):</p>
            <pre className="command" aria-label="Command for Claude Code">
              {showToken ? st.command : st.command.replace(st.token, '•'.repeat(24))}
            </pre>
            <div className="row">
              <button type="button" className="btn sm" onClick={() => void copy(st.command, 'command')}>
                Copy command
              </button>
              {confirmNew ? (
                <>
                  <button type="button" className="btn sm danger" disabled={busy} onClick={() => void change(() => api().mcpNewToken()).then(() => setConfirmNew(false))}>
                    Yes, make a new token
                  </button>
                  <button type="button" className="btn sm" onClick={() => setConfirmNew(false)}>
                    Keep this one
                  </button>
                </>
              ) : (
                <button type="button" className="btn sm" disabled={busy} onClick={() => setConfirmNew(true)} title="Anything using the old token stops working at once">
                  Make a new token
                </button>
              )}
              {copied && (
                <span className="hint" role="status">
                  Copied the {copied}.
                </span>
              )}
            </div>
          </>
        )}
        <h3 className="export-head">What an assistant can do</h3>
        <ul className="plain-list" aria-label="What an assistant can do">
          {TOOLS.map(([what, how]) => (
            <li key={what}>
              <strong>{what}</strong> <span className="hint">{how}</span>
            </li>
          ))}
        </ul>
        <p className="hint">It cannot delete photos, remove them from the catalog, change your original files, or switch catalogs. Words from your photos (names, captions, keywords) are treated as information, never as instructions.</p>
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="dialog-foot">
        <button className="btn" onClick={close} disabled={busy}>
          Done
        </button>
      </div>
    </Dialog>
  )
}
