import { api } from './api'
import { useBook } from './book'
import { useDevelop } from './develop'
import { keyFor } from './keys'
import { useLights, zoomFromLibrary } from './lights'
import { usePrefs } from './prefs'
import { useProof } from './proof'
import { useSecond } from './second'
import type { TurnOp } from './localmap'
import { libraryRedo, libraryRedoLabel, libraryUndo, libraryUndoLabel, useStore, type ModuleId } from './store'
import { useTheme } from './theme'

export interface MenuItem {
  label: string
  /** the shortcut shown beside it (the key itself is handled elsewhere) */
  keys?: string
  run(): void
  /** why it does nothing right now, shown as its tooltip and the item is dimmed */
  disabled?: string
}
export type MenuEntry = MenuItem | 'line'
export interface Menu {
  title: string
  items: MenuEntry[]
}

/** Show the rejected photos, select them all and open the Remove window with the files ticked to go to the Recycle Bin. */
async function deleteRejected() {
  const ui = useStore.getState()
  await ui.setFilters({ flag: 'reject' })
  useStore.getState().perform({ type: 'selectAll' })
  if (useStore.getState().targetIds().length === 0) return useStore.getState().say('There are no rejected photos.')
  useStore.setState({ removeOpen: true, removeDisk: true })
}

/** The Library has no zoom of its own: this opens the photo in Develop and zooms to 100% there. */
export function zoomToHundred() {
  void zoomFromLibrary(
    () => useStore.setState({ module: 'develop' }),
    () => {
      const d = useDevelop.getState()
      return d.photoId !== null && !d.loading
    },
    () => void useDevelop.getState().zoomIn(),
  )
}

/** Turn the selected photos (or the open one) a quarter turn, from the Library. */
async function turn(label: string, op: TurnOp) {
  const ids = useStore.getState().targetIds()
  const r = await useDevelop.getState().turnMany(ids, label, op)
  if (r.failed.length) useStore.getState().say(r.failed[0], true)
  else if (r.done > 0) useStore.getState().say(label === 'Rotate left' ? 'Turned left.' : 'Turned right.')
}

const go = (m: ModuleId) => () => useStore.setState({ module: m })

/**
 * The menu bar of each module: the same File, Edit, Photo, View, Window and Help titles everywhere, with the items that belong to the
 * module you are in. Every item is something that is already in the program; the menu is another way to reach it.
 */
export function menusFor(module: ModuleId, hasPhoto: boolean, hasCopied: boolean): Menu[] {
  const ui = () => useStore.getState()
  const dev = () => useDevelop.getState()
  const editing = module === 'develop' || module === 'retouch'
  const photoOnly = hasPhoto ? undefined : 'Select a photo first'
  const library = module === 'library'

  const file: MenuEntry[] = [
    { label: 'Import photos…', run: () => useStore.setState({ importOpen: true }) },
    { label: 'Export…', run: () => useStore.setState({ exportOpen: true }), disabled: photoOnly },
    { label: 'Print…', keys: 'Ctrl+P', run: () => useStore.setState({ module: 'print' }), disabled: photoOnly },
    'line',
    { label: 'Catalogs…', run: () => useStore.setState({ catalogsOpen: true }) },
    { label: 'Export the selected photos as a catalog…', run: () => useStore.setState({ catalogsOpen: true }), disabled: photoOnly },
    { label: 'Import from another catalog…', run: () => useStore.setState({ catalogsOpen: true }) },
    { label: 'Build smart previews for the selection', run: () => void buildSmartForSelection(), disabled: photoOnly },
    { label: 'Watched folder, previews and numbers…', run: () => useStore.setState({ preferencesOpen: true }) },
    { label: 'Find missing photos…', run: () => useStore.setState({ missingOpen: true }) },
    { label: 'Sidecar files…', run: () => useStore.setState({ sidecarsOpen: true }) },
    { label: 'Cull…', run: () => useStore.setState({ cullOpen: true }), disabled: photoOnly },
    'line',
    { label: 'Preferences…', run: () => useStore.setState({ preferencesOpen: true }) },
  ]

  const edit: MenuEntry[] = []
  if (editing) {
    edit.push(
      { label: 'Undo', keys: 'Ctrl+Z', run: () => void dev().undo() },
      { label: 'Redo', keys: 'Ctrl+Shift+Z', run: () => void dev().redo() },
      'line',
      { label: 'Copy settings', run: () => dev().copy(), disabled: photoOnly },
      { label: 'Paste settings', run: () => void dev().paste(), disabled: hasCopied ? undefined : 'Copy settings first' },
      { label: 'Reset all', run: () => void dev().resetAll(), disabled: photoOnly },
    )
  } else if (module === 'book') {
    edit.push({ label: 'Undo', keys: 'Ctrl+Z', run: () => useBook.getState().undo() }, { label: 'Redo', keys: 'Ctrl+Shift+Z', run: () => useBook.getState().redo() })
  } else {
    edit.push(
      { label: libraryUndoLabel() ? `Undo ${libraryUndoLabel()}` : 'Undo', keys: 'Ctrl+Z', run: () => void libraryUndo(), disabled: libraryUndoLabel() ? undefined : 'Nothing to undo' },
      { label: libraryRedoLabel() ? `Redo ${libraryRedoLabel()}` : 'Redo', keys: 'Ctrl+Shift+Z', run: () => void libraryRedo(), disabled: libraryRedoLabel() ? undefined : 'Nothing to redo' },
      'line',
      { label: 'Select all', keys: 'Ctrl+A', run: () => ui().perform({ type: 'selectAll' }) },
      'line',
      { label: 'Paste settings onto the selection', keys: 'Ctrl+Shift+V', run: () => void dev().pasteToSelection(), disabled: hasCopied ? undefined : 'Copy settings in Develop first' },
    )
  }

  const photo: MenuEntry[] = [
    { label: 'Pick', keys: 'P', run: () => void ui().flag(1), disabled: photoOnly },
    { label: 'Reject', keys: 'X', run: () => void ui().flag(-1), disabled: photoOnly },
    { label: 'Unflag', keys: 'U', run: () => void ui().flag(0), disabled: photoOnly },
    'line',
    ...[1, 2, 3, 4, 5].map((n): MenuItem => ({ label: `Rate ${n} ${n === 1 ? 'star' : 'stars'}`, keys: String(n), run: () => void ui().rate(n), disabled: photoOnly })),
    { label: 'Clear rating', keys: '0', run: () => void ui().rate(0), disabled: photoOnly },
    'line',
    ...(['red', 'yellow', 'green', 'blue', 'purple'] as const).map((c, i): MenuItem => ({ label: `Colour label: ${c}`, keys: i < 4 ? String(6 + i) : undefined, run: () => void ui().label(c), disabled: photoOnly })),
    { label: 'Colour label: none', run: () => void ui().label(null), disabled: photoOnly },
    'line',
    { label: 'Add to or take out of the Quick Collection', keys: keyFor('quick').toUpperCase(), run: () => void ui().quick(), disabled: photoOnly },
    'line',
    ...(editing
      ? [
          { label: 'Auto tone', run: () => void dev().autoTone(), disabled: photoOnly } as MenuItem,
          { label: 'Auto white balance', run: () => void dev().autoWhiteBalance(), disabled: photoOnly } as MenuItem,
          { label: 'Previous settings (back to how it was opened)', run: () => void dev().previous(), disabled: photoOnly } as MenuItem,
          'line' as const,
        ]
      : []),
    ...(module === 'retouch'
      ? [
          { label: 'Find dust', run: () => void dev().findDust(), disabled: photoOnly } as MenuItem,
          { label: 'Find eyes (red eye)', run: () => void dev().findRedEyes(), disabled: photoOnly } as MenuItem,
          'line' as const,
        ]
      : []),
    { label: 'Rotate left', keys: 'Ctrl+[', run: () => void turn('Rotate left', 'left'), disabled: photoOnly },
    { label: 'Rotate right', keys: 'Ctrl+]', run: () => void turn('Rotate right', 'right'), disabled: photoOnly },
    'line',
    { label: 'Virtual copy', keys: "Ctrl+'", run: () => void ui().makeVirtualCopies(), disabled: photoOnly },
    ...(library
      ? [
          'line' as const,
          { label: 'Group into a stack', keys: 'Ctrl+G', run: () => void ui().stackAction('group'), disabled: photoOnly } as MenuItem,
          { label: 'Unstack', keys: 'Ctrl+Shift+G', run: () => void ui().stackAction('ungroup'), disabled: photoOnly } as MenuItem,
          { label: 'Take out of the stack', run: () => void ui().stackAction('remove'), disabled: photoOnly } as MenuItem,
          { label: 'Make the top of the stack', run: () => void ui().stackAction('top'), disabled: photoOnly } as MenuItem,
          { label: 'Open or close the stack', keys: 'S', run: () => void ui().stackAction('toggle'), disabled: photoOnly } as MenuItem,
          { label: 'Auto-stack (by time or by look)…', run: () => useStore.setState({ autoStackOpen: true }) } as MenuItem,
          { label: 'Merge to HDR…', run: () => useStore.setState({ mergeOpen: 'hdr' }), disabled: photoOnly } as MenuItem,
          { label: 'AI Denoise…', run: () => useStore.setState({ mergeOpen: 'denoise' }), disabled: usePrefs.getState().hideAi ? 'The AI tools are hidden in Preferences' : photoOnly } as MenuItem,
          { label: 'Merge to focus stack (macro)…', run: () => useStore.setState({ mergeOpen: 'focus' }), disabled: photoOnly } as MenuItem,
          { label: 'Merge to panorama…', run: () => useStore.setState({ mergeOpen: 'pano' }), disabled: photoOnly } as MenuItem,
          { label: 'Open all stacks', run: () => void ui().stackAction('openAll') } as MenuItem,
          { label: 'Close all stacks', run: () => void ui().stackAction('closeAll') } as MenuItem,
          'line' as const,
        ]
      : []),
    { label: 'Open in external editor', run: () => void ui().openInEditor(), disabled: photoOnly },
    { label: 'Edit a copy with the edits applied in the external editor', run: () => void ui().editCopyInEditor(), disabled: photoOnly },
    { label: 'Delete rejected photos…', run: () => void deleteRejected(), disabled: library ? undefined : 'Go to the Library first' },
    { label: 'Remove from catalog…', keys: 'Delete', run: () => useStore.setState({ removeOpen: true }), disabled: library ? photoOnly : 'Go to the Library to remove photos' },
  ]

  const view: MenuEntry[] = []
  if (library) {
    view.push({ label: 'Grid', keys: 'G', run: () => useStore.setState({ view: 'grid' }) }, { label: 'Loupe', keys: 'E', run: () => useStore.setState({ view: 'loupe' }) }, { label: 'Compare', keys: 'C', run: () => useStore.getState().perform({ type: 'view', value: 'compare' }) }, { label: 'Survey', keys: 'N', run: () => useStore.setState({ view: 'survey' }) }, 'line')
  }
  if (editing) {
    view.push(
      { label: 'Before (show the original)', keys: '\\', run: () => dev().toggleOriginal() },
      { label: 'Show clipping', keys: 'J', run: () => dev().toggleClipping() },
      { label: 'Compare with the original: side by side', keys: 'Y', run: () => dev().setCompareView('side') },
      { label: 'Compare with the original: split', run: () => dev().setCompareView('split') },
      { label: 'Compare with the original: off', run: () => dev().setCompareView('off') },
      { label: 'Soft proof on or off', keys: 'S', run: () => (useProof.getState().name ? useProof.getState().setOn(!useProof.getState().on) : ui().say('Choose a colour profile in the Soft proofing panel first.', true)), disabled: module === 'develop' ? undefined : 'Soft proofing is in Develop' },
      { label: 'Zoom to 100%', keys: 'Z', run: () => dev().toggleZoom() },
      { label: 'Crop', keys: 'C', run: () => dev().setCropEdit(!dev().cropEdit) },
      'line',
    )
  }
  if (library) view.push({ label: 'Zoom to 100% (in Develop)', keys: keyFor('zoom').toUpperCase(), run: () => zoomToHundred(), disabled: photoOnly }, 'line')
  view.push(
    { label: 'Lights dim, out, on', keys: 'L', run: () => useLights.getState().cycle() },
    { label: 'Switch dark and light', run: () => useTheme.getState().toggle() },
  )

  const windows: MenuEntry[] = [
    { label: 'Library', run: go('library') },
    { label: 'Develop', run: go('develop'), disabled: photoOnly },
    { label: 'Retouch', run: go('retouch'), disabled: photoOnly },
    { label: 'Book', run: go('book') },
    { label: 'Print', keys: 'Ctrl+P', run: go('print'), disabled: photoOnly },
    'line',
    { label: 'Open the second window', run: () => void useSecond.getState().openIt() },
    { label: 'Close the second window', run: () => void useSecond.getState().close() },
    { label: 'Hold the second window on this photo (or let it follow)', run: () => useSecond.getState().toggleLock(), disabled: photoOnly },
  ]

  const help: MenuEntry[] = [
    { label: 'Help and shortcuts', keys: '?', run: () => useStore.setState({ helpOpen: true }) },
    { label: 'Licence…', run: () => useStore.setState({ preferencesOpen: true }) },
    { label: 'Connect an AI assistant…', run: () => useStore.setState({ mcpOpen: true }), disabled: usePrefs.getState().hideAi ? 'The AI tools are hidden in Preferences' : undefined },
  ]

  return [
    { title: 'File', items: file },
    { title: 'Edit', items: edit },
    { title: 'Photo', items: photo },
    { title: 'View', items: view },
    { title: 'Window', items: windows },
    { title: 'Help', items: help },
  ]
}

/** Build smart previews for the selected photos (File menu). */
async function buildSmartForSelection() {
  const s = useStore.getState()
  const ids = s.targetIds()
  try {
    const r = await api().smartBuild(ids)
    s.say(r.failed.length ? `Smart previews: ${r.made} made, ${r.failed.length} failed.` : r.made === 0 ? 'The selected photos already have smart previews (or their files are offline).' : `Made ${r.made} smart preview${r.made === 1 ? '' : 's'}.`, r.failed.length > 0)
  } catch (e) {
    s.say((e as Error).message, true)
  }
}
