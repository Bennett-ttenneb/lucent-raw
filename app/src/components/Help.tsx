import { keyFor, REMAPPABLE } from '../lib/keys'
import { useStore } from '../lib/store'

/** A listed single letter (or "P, X, U") as it is now, after any letters changed in Preferences. */
export function shownKeys(listed: string): string {
  if (!/^[A-Z](, [A-Z])*$/.test(listed)) return listed
  return listed.replace(/[A-Z]/g, (c) => {
    const r = REMAPPABLE.find((x) => x.key === c.toLowerCase())
    return r ? keyFor(r.id).toUpperCase() : c
  })
}
import { Dialog } from './Primitives'

interface Shortcut {
  keys: string
  what: string
}

export const SHORTCUTS: { title: string; items: Shortcut[] }[] = [
  {
    title: 'Everywhere',
    items: [
      { keys: '?', what: 'Open or close this help' },
      { keys: 'D', what: 'Open the selected photo in Develop' },
      { keys: "Ctrl+'", what: 'Make a virtual copy of the selected photos' },
      { keys: 'G', what: 'Back to the grid of photos' },
      { keys: 'Left and Right arrows', what: 'Previous and next photo' },
      { keys: '0 to 5', what: 'Give the photo that many stars (the same key again clears it)' },
      { keys: 'P, X, U', what: 'Flag as picked, flag as rejected, remove the flag' },
      { keys: '6, 7, 8, 9', what: 'Colour label red, yellow, green, blue' },
    ],
  },
  {
    title: 'Library',
    items: [
      { keys: 'E', what: 'Show one photo large' },
      { keys: 'Z', what: 'In the loupe: open the photo in Develop at 100%' },
      { keys: 'Arrow keys, Home, End', what: 'Move through the grid' },
      { keys: 'Ctrl+A', what: 'Select all photos shown' },
      { keys: 'Ctrl+Shift+V', what: 'Paste the settings you copied in Develop onto the selected photos' },
      { keys: 'B', what: 'Add or remove from the quick collection' },
      { keys: 'Shift+B', what: 'Add to the target collection' },
      { keys: 'Delete', what: 'Remove from the catalog (the files stay on the disk)' },
    ],
  },
  {
    title: 'Develop',
    items: [
      { keys: 'Ctrl+Z', what: 'Undo the last edit' },
      { keys: 'Ctrl+Shift+Z or Ctrl+Y', what: 'Redo' },
      { keys: 'Z', what: 'Zoom to 100% and back' },
      { keys: '\\', what: 'Show the photo as it was before your edits' },
      { keys: 'L', what: 'Dim everything round the photo, then switch it off, then bring it back (Esc also brings it back)' },
      { keys: 'J', what: 'Show blown highlights in red and crushed shadows in blue' },
      { keys: 'C', what: 'Open the crop frame (Esc or Enter to leave it)' },
      { keys: 'Double-click a slider name', what: 'Put that slider back to zero' },
      { keys: 'Alt+1 to Alt+9', what: 'Open or close the 1st to 9th panel of the right-hand column and move to it (hold Alt to see the numbers; Alt+Shift for the left-hand column)' },
      { keys: 'Alt+0', what: 'Close every panel of the right-hand column (Alt+Shift+0 for the left-hand one)' },
      { keys: 'Alt+click a panel name', what: 'Open that panel and close the others in its column' },
      { keys: 'Up, Down, Home, End on a panel name', what: 'Move between the panel names' },
    ],
  },
]

const STEPS: { title: string; text: string }[] = [
  { title: 'Bring your photos in', text: 'In the Library press Import…, choose a folder, then untick any photos you do not want. Your original files are never changed.' },
  { title: 'Pick the keepers', text: 'Step through with the arrow keys. Press 1 to 5 for stars, P to pick, X to reject. Use the filter bar to show only what you picked.' },
  { title: 'Edit', text: 'Press D to open a photo in Develop. Start with the Basic sliders, or try a preset. Hold the Backslash key to compare with the original, and Ctrl+Z to undo.' },
  { title: 'Fix the details', text: 'Crop with C. Then open the Retouch tab: remove dust with the spot tool and red pupils with the red-eye tool, and for portraits use the face panels; on group photos press Detect faces.' },
  { title: 'Export', text: 'Select the photos and press Export…. Pick a preset (for the web, for print, for clients with a watermark), choose a folder, and check the preview.' },
]

const TIPS = [
  'A small local edit is easier with a mask: add a gradient, a brush or a colour range, then adjust only that area.',
  'The Fine-tune arrows button next to the sliders adds up and down arrows for small steps. Hold one for a second to keep stepping.',
  'Copy settings… in Develop lets you choose which groups to carry to other photos (the crop is left out unless you tick it). Then select photos in the Library and press Paste settings to give them all the same look.',
  'The History list on the left keeps every step, and Snapshots save a look you want to come back to.',
  'Photos without camera information (scans, screenshots) simply get no camera caption when you export with a border.',
]

export function HelpDialog() {
  const open = useStore((s) => s.helpOpen)
  const close = () => useStore.setState({ helpOpen: false })
  return (
    <Dialog open={open} onClose={close} title="Help and shortcuts" wide>
      <div className="help" tabIndex={0} role="region" aria-label="Help contents">
        <h3>Getting started</h3>
        <ol className="help-steps">
          {STEPS.map((s) => (
            <li key={s.title}>
              <strong>{s.title}.</strong> {s.text}
            </li>
          ))}
        </ol>
        <h3>Keyboard shortcuts</h3>
        {SHORTCUTS.map((g) => (
          <table key={g.title} className="help-keys">
            <caption>{g.title}</caption>
            <thead>
              <tr>
                <th scope="col">Key</th>
                <th scope="col">What it does</th>
              </tr>
            </thead>
            <tbody>
              {g.items.map((s) => (
                <tr key={s.keys}>
                  <th scope="row">
                    <kbd>{shownKeys(s.keys)}</kbd>
                  </th>
                  <td>{s.what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ))}
        <h3>Good to know</h3>
        <ul className="help-tips">
          {TIPS.map((t) => (
            <li key={t}>{t}</li>
          ))}
        </ul>
      </div>
      <div className="dialog-foot">
        <button className="btn" onClick={close}>
          Close
        </button>
      </div>
    </Dialog>
  )
}
