import { useEffect, useMemo, useState } from 'react'
import { api } from '../lib/api'
import { plural } from '../lib/format'
import { useStore } from '../lib/store'
import type { Progress } from '../lib/types'
import { Dialog, ProgressBar } from './Primitives'

/** Merge: several shots of one scene at different exposures become one picture that keeps the shadows and the highlights (HDR), or shots taken in turn are joined into one wide picture (panorama). */
export function MergeHdrDialog() {
  const mode = useStore((s) => s.mergeOpen)
  const open = mode !== null
  const selected = useStore((s) => s.selected)
  const activeId = useStore((s) => s.photoAt(s.active)?.id)
  const ids = useMemo(() => (selected.size ? [...selected] : activeId !== undefined ? [activeId] : []), [selected, activeId])
  const [align, setAlign] = useState(true)
  const [amount, setAmount] = useState(100)
  const [iso, setIso] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<Progress | null>(null)
  useEffect(() => {
    if (!open) return
    setError(null)
    setProgress(null)
    let off = () => {}
    void api().on<Progress>('merge:progress', setProgress).then((u) => (off = u))
    return () => off()
  }, [open])
  const close = () => useStore.setState({ mergeOpen: null })
  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      // the photos in the order they are shown, which is the order a panorama is joined in
      const s = useStore.getState()
      const ordered = [...ids].sort((a, b) => s.indexOfId(a) - s.indexOfId(b))
      const isoN = Number(iso)
      const r = mode === 'denoise' ? await api().photoAiDenoise(s.photoAt(s.active)?.id ?? ordered[0], amount, iso.trim() !== '' && Number.isFinite(isoN) && isoN > 0 ? isoN : null) : mode === 'pano' ? await api().photoMergePano(ordered) : mode === 'focus' ? await api().photoMergeFocus(ordered, align) : await api().photoMergeHdr(ordered, align)
      await useStore.getState().reload()
      const at = useStore.getState().indexOfId(r.id)
      if (at >= 0) useStore.getState().clickIndex(at, 'single')
      close()
      close()
      useStore.getState().say(mode === 'denoise' ? `Made ${r.path.split('/').pop()}.` : `Merged ${plural(r.shots, 'photo')} into one: ${r.path.split('/').pop()}.`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }
  const pano = mode === 'pano'
  const denoise = mode === 'denoise'
  const enough = denoise ? ids.length >= 1 : ids.length >= 2
  return (
    <Dialog open={open} onClose={close} title={denoise ? 'AI Denoise' : mode === 'focus' ? 'Merge to focus stack' : pano ? 'Merge to panorama' : 'Merge to HDR'} busy={busy}>
      <div className="form">
        <p>
          {denoise
            ? enough
              ? 'Make a cleaner copy of the open photo.'
              : 'Open a photo first.'
            : ids.length >= 2
              ? `Merge the ${ids.length} selected photos into one.`
              : pano
                ? 'Select two or more photos taken in turn, each overlapping the next, then choose this again.'
                : mode === 'focus'
                  ? 'Select two or more photos of the same subject taken at different focus distances, then choose this again.'
                  : 'Select two or more photos of the same scene, taken at different exposures, then choose this again.'}
        </p>
        {denoise && (
          <>
            <div className="field-row">
              <label className="lbl" htmlFor="dn-amount">
                Amount
              </label>
              <input id="dn-amount" className="field narrow" type="number" min={0} max={100} value={amount} disabled={busy} onChange={(e) => setAmount(Math.min(100, Math.max(0, Number(e.target.value) || 0)))} />
              <span className="hint">0 to 100 (100 uses all of the cleaned picture)</span>
            </div>
            <div className="field-row">
              <label className="lbl" htmlFor="dn-iso">
                ISO
              </label>
              <input id="dn-iso" className="field narrow" type="number" min={50} max={65535} placeholder="the photo's own" value={iso} disabled={busy} onChange={(e) => setIso(e.target.value)} />
              <span className="hint">how noisy it is; leave empty to use the ISO the photo was taken at</span>
            </div>
          </>
        )}
        {!pano && !denoise && (
          <label className="check">
            <input type="checkbox" checked={align} disabled={busy} onChange={(e) => setAlign(e.target.checked)} /> Line the photos up first (for shots taken by hand)
          </label>
        )}
        <p className="hint">
          {mode === 'focus'
            ? 'Each part of the picture is taken from the shot where it is sharpest, so a subject that is deeper than one focus setting allows (an insect, a flower, a product) is sharp from front to back. Line the photos up first when they were shot by hand; a camera on a rail needs less. The result is a JPEG beside the first photo, added to the catalog; the photos are not changed and their edits are not used. Shots whose size changes as the focus moves (breathing) may show soft edges. Up to 40 photos; big ones are shrunk so they fit in memory together.'
            : denoise
            ? 'A small model made for camera noise is built into the program and runs on your computer. The result is a JPEG beside the photo (named with -Denoise), added to the catalog; the photo itself is not changed and its edits are not used. A big photo takes about half a minute.'
            : pano
              ? 'The photos are joined in the order they are shown, each placed where its overlap with the one before matches, with brightness matched and the join blended. They are not bent: this suits shots from a longer lens and a gentle turn, and it cannot correct a camera that was tilted or moved. The empty corners are cut away. The result is a JPEG beside the first photo, added to the catalog; the photos themselves are not changed and their edits are not used.'
              : 'The merge keeps the detail of the dark parts from the bright shots and of the bright parts from the dark shots. The result is a JPEG beside the first photo, added to the catalog; the photos themselves are not changed. Their edits are not used. Anything that moved in the scene between shots may show as a ghost. Pictures over 16 megapixels are shrunk to that for the merge.'}
        </p>
        {busy && progress && <ProgressBar done={progress.done} total={progress.total} label={denoise ? 'Cleaning' : 'Merging'} />}
        {error && (
          <p className="err" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="dialog-foot">
        <button className="btn" onClick={close} disabled={busy}>
          Cancel
        </button>
        <button className="btn accent" onClick={() => void run()} disabled={busy || !enough}>
          {denoise ? 'Denoise' : 'Merge'}
        </button>
      </div>
    </Dialog>
  )
}