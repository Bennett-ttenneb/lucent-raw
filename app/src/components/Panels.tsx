import { useEffect, useMemo, useRef, useState } from 'react'
import { api } from '../lib/api'
import { useDevelop } from '../lib/develop'
import { ancestorsOf, buildTree, type FolderNode } from '../lib/folderTree'
import { usePanels } from '../lib/panels'
import { usePreviewKey, useStore } from '../lib/store'
import { capturedLabel, diskText, exposureLine, num, plural } from '../lib/format'
import { CollectionsPanel, KeywordingPanel, KeywordListPanel, MetadataEditPanel, NavigatorPanel } from './Organise'
import type { FolderRow } from '../lib/types'
import { FolderActionDialog, SyncFolderDialog, type FolderTarget } from './FolderActions'
import { FlagButtons, LabelChips, Panel, Stars } from './Primitives'
import { QuickDevelopPanel } from './QuickDevelop'

/** "120 GB free of 500 GB" under a place the photos came from, with a bar; nothing when the disk cannot be asked. */
function FreeSpace({ path }: { path: string }) {
  const [space, setSpace] = useState<{ free: number; total: number } | null>(null)
  useEffect(() => {
    let alive = true
    api().volumeSpace(path).then((v) => alive && setSpace(v)).catch(() => alive && setSpace(null))
    return () => {
      alive = false
    }
  }, [path])
  if (!space || space.total <= 0) return null
  const gb = diskText
  const used = Math.min(100, Math.max(0, 100 - (space.free / space.total) * 100))
  return (
    <div className="space-line" title={`${gb(space.free)} free of ${gb(space.total)} on the disk that holds ${path}`}>
      <div className="space-bar" role="img" aria-label={`${gb(space.free)} free of ${gb(space.total)}`}>
        <span style={{ width: `${used}%` }} data-low={space.free / space.total < 0.1 || undefined} />
      </div>
      <span className="hint">{gb(space.free)} free</span>
    </div>
  )
}

/** The folders as a tree: open and close the lines, press a name to see that folder's photos. The counts of a line that only holds others add up what is inside. */
function FoldersPanel() {
  const folders = useStore((s) => s.folders)
  const folderId = useStore((s) => s.filters.folderId)
  const setSource = useStore((s) => s.setSource)
  const tree = useMemo(() => buildTree(folders), [folders])
  const [menu, setMenu] = useState<{ x: number; y: number; row: FolderRow } | null>(null)
  const [action, setAction] = useState<FolderTarget | null>(null)
  const [syncing, setSyncing] = useState<FolderRow | null>(null)
  useEffect(() => {
    if (!menu) return
    const off = () => setMenu(null)
    window.addEventListener('click', off)
    window.addEventListener('keydown', off)
    return () => {
      window.removeEventListener('click', off)
      window.removeEventListener('keydown', off)
    }
  }, [menu])
  const open = usePanels((st) => st.open)
  // a line is open unless it was closed, and the one that is chosen is always shown
  const above = useMemo(() => (folderId === undefined ? [] : ancestorsOf(tree, folderId)), [tree, folderId])
  const isOpen = (n: FolderNode) => above.includes(n.key) || (open[`folder: ${n.key}`] ?? true)
  const line = (n: FolderNode, depth: number) => {
    const has = n.children.length > 0
    const expanded = isOpen(n)
    return (
      <li key={n.key}>
        <div className="tree-line" style={{ paddingLeft: depth * 12 }}>
          {has ? (
            <button type="button" className="tree-twist" aria-expanded={expanded} aria-label={`${expanded ? 'Close' : 'Open'} ${n.label}`} onClick={() => usePanels.getState().set(`folder: ${n.key}`, !expanded)}>
              <span className="tri" aria-hidden />
            </button>
          ) : (
            <span className="tree-twist" aria-hidden />
          )}
          <button
            type="button"
            className="tree-name"
            aria-current={n.folderId !== undefined && folderId === n.folderId ? 'true' : undefined}
            disabled={n.folderId === undefined}
            title={n.path}
            onClick={() => n.folderId !== undefined && void setSource({ folderId: n.folderId })}
            onContextMenu={(e) => {
              const row = folders.find((f) => f.id === n.folderId)
              if (!row) return
              e.preventDefault()
              setMenu({ x: e.clientX, y: e.clientY, row })
            }}
          >
            <span className="trunc">{n.label}</span>
            <span className="cnt" title={has && n.count !== n.total ? `${num(n.count)} in this folder, ${num(n.total)} with the folders inside` : undefined}>
              {num(has ? n.total : n.count)}
            </span>
          </button>
        </div>
        {depth === 0 && n.rootPath && <FreeSpace path={n.rootPath} />}
        {has && expanded && <ul className="tree sub">{n.children.map((c) => line(c, depth + 1))}</ul>}
      </li>
    )
  }
  return (
    <Panel title="Folders">
      {folders.length === 0 ? (
        <p className="hint">Folders you import appear here.</p>
      ) : (
        <ul className="tree" aria-label="Folders">
          {tree.map((r) => line(r, 0))}
        </ul>
      )}
      {menu && (
        <div className="panel-menu" role="menu" aria-label="Folder options" style={{ left: menu.x, top: menu.y }}>
          <button type="button" role="menuitem" onClick={() => setAction({ row: menu.row, mode: 'rename' })}>
            Rename…
          </button>
          <button type="button" role="menuitem" onClick={() => setSyncing(menu.row)}>
            Synchronize…
          </button>
          <button type="button" role="menuitem" disabled={menu.row.relPath === ''} title={menu.row.relPath === '' ? 'The top of an imported place cannot be moved from here' : undefined} onClick={() => setAction({ row: menu.row, mode: 'move' })}>
            Move…
          </button>
        </div>
      )}
      <FolderActionDialog target={action} onClose={() => setAction(null)} />
      <SyncFolderDialog row={syncing} onClose={() => setSyncing(null)} />
    </Panel>
  )
}

/** The name of a virtual copy ("Copy 1"), which can be changed to something that says what the copy is for. */
function CopyName({ id, name }: { id: number; name: string }) {
  const [v, setV] = useState(name)
  const save = async () => {
    if (v.trim() === name) return
    try {
      await api().photoRenameCopy(id, v)
      await useStore.getState().reload()
      useStore.getState().say(`The copy is now called “${v.trim()}”.`)
    } catch (e) {
      useStore.getState().say((e as Error).message, true)
      setV(name)
    }
  }
  return (
    <label className="inline stackl">
      Name of this virtual copy
      <input className="field" value={v} maxLength={40} onChange={(e) => setV(e.target.value)} onBlur={() => void save()} onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()} />
    </label>
  )
}

export function LeftPanels() {
  const total = useStore((s) => s.info?.count ?? s.total)
  const info = useStore((s) => s.info)
  const hasCopied = useDevelop((s) => !!s.clipboard)
  const collections = useStore((s) => s.collections)
  const f = useStore((s) => s.filters)
  const setSource = useStore((s) => s.setSource)
  const quick = collections.find((c) => c.kind === 'quick')
  const noSource = f.folderId === undefined && f.collectionId === undefined && f.keywordId === undefined
  return (
    <aside className="side left" aria-label="Library panels">
      <div className="side-scroll">
        <NavigatorPanel />
        <Panel
          title="Catalog"
          action={
            <button type="button" className="btn sm catalog-chip" onClick={() => useStore.setState({ catalogsOpen: true })} title="Switch, make or open a catalog">
              <span className="trunc">{info?.name ?? 'Catalogs'}</span>
              <span aria-hidden>▾</span>
            </button>
          }
        >
          <ul className="tree" aria-label="Catalog">
            <li>
              <button aria-current={noSource ? 'true' : undefined} onClick={() => void setSource({})}>
                All photographs <span className="cnt">{num(total)}</span>
              </button>
            </li>
            <li>
              <button aria-current={quick && f.collectionId === quick.id ? 'true' : undefined} disabled={!quick} onClick={() => quick && void setSource({ collectionId: quick.id })}>
                Quick collection <span className="cnt">{num(quick?.count ?? 0)}</span>
              </button>
            </li>
          </ul>
        </Panel>
        <FoldersPanel />
        <CollectionsPanel />
      </div>
      <div className="side-foot">
        <button className="btn" onClick={() => useStore.setState({ importOpen: true })}>
          Import…
        </button>
        <button className="btn" onClick={() => useStore.setState({ exportOpen: true })} disabled={total === 0}>
          Export…
        </button>
        <button className="btn" onClick={() => void useStore.getState().makeVirtualCopies()} disabled={total === 0} title="Make a virtual copy of the selected photos: it shares the file and has its own rating, keywords and edits (Ctrl+')">
          Virtual copy
        </button>
        <button className="btn" onClick={() => void useStore.getState().openInEditor()} disabled={total === 0} title="Open the original file of the open photo in the editing program chosen in Preferences (or Windows' choice)">
          Open in external editor
        </button>
        <button className="btn" onClick={() => useStore.setState({ cullOpen: true })} disabled={total === 0} title="Find out-of-focus and badly exposed photos, and the best of each burst">
          Cull…
        </button>
        <button className="btn" onClick={() => void useDevelop.getState().pasteToSelection()} disabled={!hasCopied || total === 0} title={hasCopied ? 'Paste the settings you copied in Develop onto the selected photos (Ctrl+Shift+V)' : 'Copy settings in Develop first, then select photos here and paste'}>
          Paste settings
        </button>
      </div>
    </aside>
  )
}

function Histogram() {
  const photo = useStore((s) => s.photoAt(s.active))
  const version = useStore((s) => s.previewVersion)
  const key = usePreviewKey(photo?.id ?? -1)
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    if (!cv) return
    const g = cv.getContext('2d')
    if (!g) return
    g.clearRect(0, 0, cv.width, cv.height)
    if (!photo || !photo.previewable) return
    let cancelled = false
    {
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.onload = () => {
        if (cancelled) return
        try {
          const c = document.createElement('canvas')
          c.width = 96
          c.height = Math.max(1, Math.round((96 * img.height) / img.width))
          const cx = c.getContext('2d', { willReadFrequently: true })!
          cx.drawImage(img, 0, 0, c.width, c.height)
          const d = cx.getImageData(0, 0, c.width, c.height).data
          const bins = [new Array(64).fill(0), new Array(64).fill(0), new Array(64).fill(0)]
          for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) bins[k][d[i + k] >> 2]++
          const max = Math.max(...bins.flat()) || 1
          g.clearRect(0, 0, cv.width, cv.height)
          const cols = ['rgba(224,65,58,.55)', 'rgba(63,174,79,.55)', 'rgba(59,111,224,.55)']
          bins.forEach((b, k) => {
            g.beginPath()
            g.moveTo(0, cv.height)
            b.forEach((v, x) => g.lineTo((x / 63) * cv.width, cv.height - (v / max) * (cv.height - 4)))
            g.lineTo(cv.width, cv.height)
            g.fillStyle = cols[k]
            g.fill()
          })
        } catch {
          /* a blocked read just leaves the graph empty */
        }
      }
      img.src = api().previewUrl(photo.id, 'thumb', key)
    }
    return () => {
      cancelled = true
    }
  }, [photo?.id, photo?.previewable, version]) // eslint-disable-line react-hooks/exhaustive-deps
  return <canvas ref={ref} width={248} height={90} className="histo" role="img" aria-label={photo ? `Colour histogram of ${photo.name}` : 'Histogram, no photo selected'} />
}

export function RightPanels() {
  const photo = useStore((s) => s.photoAt(s.active))
  const selectedCount = useStore((s) => s.selected.size)
  const { rate, flag, label } = useStore.getState()
  return (
    <aside className="side right" aria-label="Photo details">
      <div className="side-scroll">
        <Panel title="Histogram">
          <Histogram />
          <p className="exif-line">{photo ? exposureLine(photo) : ''}</p>
        </Panel>
        <QuickDevelopPanel />
        <Panel title="Marks">
          {photo ? (
            <div className="stack">
              <Stars value={photo.rating} onChange={(n) => void rate(n)} />
              <FlagButtons value={photo.flag} onChange={(f) => void flag(f)} />
              <LabelChips value={photo.label} onChange={(l) => void label(l)} />
              <div className="row">
                <button className="btn sm" onClick={() => void useStore.getState().quick()} title="Add to or take out of the Quick Collection (B)">
                  Quick collection (B)
                </button>
                <button className="btn sm danger" onClick={() => useStore.setState({ removeOpen: true })} title="Remove from the catalog (Delete)">
                  Remove…
                </button>
              </div>
              {selectedCount > 1 && <p className="hint">Applies to all {plural(selectedCount, 'selected photo')}.</p>}
            </div>
          ) : (
            <p className="hint">Select a photo to rate or flag it.</p>
          )}
        </Panel>
        <KeywordingPanel />
        <KeywordListPanel />
        <MetadataEditPanel />
        <Panel title="Details" defaultOpen={false}>
          {photo ? (
            <>
            <dl className="meta">
              <dt>File</dt>
              <dd title={photo.path}>{photo.name}</dd>
              <dt>Folder</dt>
              <dd>{photo.folder}</dd>
              <dt>Captured</dt>
              <dd>{capturedLabel(photo.captured)}</dd>
              <dt>Camera</dt>
              <dd>{photo.camera ?? 'Unknown'}</dd>
              <dt>Lens</dt>
              <dd>{photo.lens ?? 'Unknown'}</dd>
              <dt>Size</dt>
              <dd>{photo.width && photo.height ? `${num(photo.width)} × ${num(photo.height)} px` : 'Unknown'}</dd>
              <dt>Format</dt>
              <dd>{photo.format.toUpperCase()}</dd>
            </dl>
          {photo?.missing && (
            <div className="stack">
              <p className="err">The file cannot be found.</p>
              <button
                type="button"
                className="btn sm"
                onClick={() =>
                  void (async () => {
                    const file = await api().pickPhotoFile(`Choose the file for ${photo.name}`)
                    if (!file) return
                    try {
                      await api().photoRelink(photo.id, file)
                      await useStore.getState().reload()
                      useStore.getState().say(`${photo.name} is connected to the file you chose.`)
                    } catch (e) {
                      useStore.getState().say((e as Error).message, true)
                    }
                  })()
                }
              >
                Find this file…
              </button>
            </div>
          )}
          {photo?.copyName != null && <CopyName key={photo.id} id={photo.id} name={photo.copyName} />}
            </>
          ) : (
            <p className="hint">Nothing selected.</p>
          )}
        </Panel>
      </div>
    </aside>
  )
}
