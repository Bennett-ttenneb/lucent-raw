import { useRef, useState } from 'react'
import { useDevelop } from '../lib/develop'
import { DEFAULT_EYE, DEFAULT_SKIN, DEFAULT_TEETH, REGIONS, eyesIsDefault, handlePositions, moveEllipse, moveWhole, orientationText, regionLabel, skinIsDefault, teethIsDefault, type EllipseHandle, type Pt, type RegionKey } from '../lib/portraitedit'
import type { Portrait } from '../lib/types'
import type { Box } from './Masks'
import { Panel } from './Primitives'
import { SliderRow } from './SliderRow'

const store = () => useDevelop.getState()

/** The face the sliders and regions belong to: the selected one, kept inside the list. */
const useActive = () => {
  const faces = useDevelop((s) => s.recipe.portraits)
  const index = useDevelop((s) => Math.min(s.selectedFace, s.recipe.portraits.length - 1))
  return { faces, index, face: index >= 0 ? faces[index] : undefined }
}

// ---- the regions on the picture ---------------------------------------------------------------

/**
 * With the face tool on, a click on the picture adds a face there. With a face selected, its four regions (the face, two
 * eyes and the mouth) are drawn: the selected region has dots for its middle and its two radii. The other faces are drawn
 * as faint rings that select them. Dragging the middle of a face takes its eyes and mouth along.
 */
export function PortraitOverlay({ box }: { box: Box }) {
  const { faces, index, face: portrait } = useActive()
  const selected = useDevelop((s) => s.selectedRegion)
  const tool = useDevelop((s) => s.portraitTool)
  const svg = useRef<SVGSVGElement>(null)
  const drag = useRef<{ key: RegionKey; handle: EllipseHandle; from: Pt; start: Portrait } | null>(null)
  const pause = useRef<ReturnType<typeof setTimeout>>(undefined)
  if (!tool && !(selected && portrait)) return null

  const { w, h } = box
  const aspect = w / h
  const long = Math.max(w, h)
  const norm = (e: { clientX: number; clientY: number }): Pt => {
    const r = svg.current!.getBoundingClientRect()
    return [(e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height]
  }
  const change = (start: Portrait, key: RegionKey, handle: EllipseHandle, from: Pt, to: Pt) =>
    handle === 'centre' && key === 'face' ? moveWhole(start, to[0] - from[0], to[1] - from[1]) : { ...start, [key]: moveEllipse(start[key], handle, from, to, aspect, start.roll) }
  const label = (key: RegionKey, handle: EllipseHandle) => `Face ${index + 1}${key === 'face' ? '' : ` ${regionLabel(key).toLowerCase()}`}: ${handle === 'centre' ? 'move' : 'resize'}`

  const grab = (key: RegionKey, handle: EllipseHandle) => (e: React.PointerEvent) => {
    if (e.button !== 0 || !portrait) return
    e.stopPropagation() // not a click on the picture, which would zoom
    store().selectRegion(key)
    drag.current = { key, handle, from: norm(e), start: portrait }
    svg.current!.setPointerCapture(e.pointerId)
  }
  const move = (e: React.PointerEvent) => {
    const d = drag.current
    if (d) store().livePortrait(() => change(d.start, d.key, d.handle, d.from, norm(e)))
  }
  const up = (e: React.PointerEvent) => {
    const d = drag.current
    if (d) {
      drag.current = null
      void store().commitPortrait(label(d.key, d.handle))
    } else if (tool) {
      // a click on the picture (not on a region, which would have started a drag)
      void store().markFace(norm(e), aspect)
    }
  }
  const background = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.stopPropagation() // not a click on the picture, which would zoom
    svg.current!.setPointerCapture(e.pointerId)
  }
  const nudge = (key: RegionKey, handle: EllipseHandle) => (e: React.KeyboardEvent) => {
    if (!portrait) return
    const step = e.shiftKey ? 0.02 : 0.004
    const delta: Record<string, Pt> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }
    const d = delta[e.key]
    if (!d) return
    e.preventDefault()
    e.stopPropagation() // the arrow keys also step to the next photo; here they belong to the region
    const at = handlePositions(portrait[key], aspect, portrait.roll)[handle]
    store().livePortrait((p) => change(p, key, handle, at, [at[0] + d[0], at[1] + d[1]]))
    clearTimeout(pause.current)
    pause.current = setTimeout(() => void store().commitPortrait(label(key, handle)), 600)
  }

  const handleLabel: Record<EllipseHandle, string> = { centre: 'position', rx: 'width', ry: 'height' }
  const ring = (f: Portrait) => ({ cx: f.face.cx * w, cy: f.face.cy * h, rx: Math.max(f.face.rx * long, 3), ry: Math.max(f.face.ry * long, 3) })
  return (
    <svg
      ref={svg}
      className={`mask-layer spot-layer ${tool ? 'paint' : ''}`}
      style={{ left: box.left, top: box.top, width: w, height: h }}
      viewBox={`0 0 ${w} ${h}`}
      role="group"
      aria-label="Portrait regions"
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
    >
      {tool && <rect x={0} y={0} width={w} height={h} fill="transparent" style={{ pointerEvents: 'all' }} onPointerDown={background} />}
      {/* the other faces: a faint ring with its number, which selects the face */}
      {faces.map((f, k) => {
        if (k === index && !tool) return null
        const r = ring(f)
        return (
          <g key={k}>
            <ellipse className="spot-ring faint" {...r} transform={`rotate(${f.roll} ${r.cx} ${r.cy})`} onPointerDown={(e) => (e.stopPropagation(), store().selectFace(k))} />
            <text className="face-number" x={r.cx} y={r.cy - r.ry - 4} textAnchor="middle" aria-hidden>
              {k + 1}
            </text>
          </g>
        )
      })}
      {portrait &&
        selected &&
        REGIONS.map(({ key, label: name }) => {
          const e = portrait[key]
          const [cx, cy, rx, ry] = [e.cx * w, e.cy * h, Math.max(e.rx * long, 3), Math.max(e.ry * long, 3)]
          if (key !== selected) return <ellipse key={key} className="spot-ring faint" cx={cx} cy={cy} rx={rx} ry={ry} transform={`rotate(${portrait.roll} ${cx} ${cy})`} onPointerDown={grab(key, 'centre')} />
          const hp = handlePositions(e, aspect, portrait.roll)
          return (
            <g key={key}>
              <ellipse className="spot-ring" cx={cx} cy={cy} rx={rx} ry={ry} transform={`rotate(${portrait.roll} ${cx} ${cy})`} onPointerDown={grab(key, 'centre')} />
              {(['centre', 'rx', 'ry'] as EllipseHandle[]).map((handle) => (
                <circle
                  key={handle}
                  className={`mask-dot ${handle === 'centre' ? '' : 'hollow'}`}
                  cx={hp[handle][0] * w}
                  cy={hp[handle][1] * h}
                  r={handle === 'centre' ? 5 : 4}
                  tabIndex={0}
                  role="button"
                  aria-label={`${name}: ${handleLabel[handle]}`}
                  onPointerDown={grab(key, handle)}
                  onKeyDown={nudge(key, handle)}
                />
              ))}
            </g>
          )
        })}
    </svg>
  )
}

// ---- the panels --------------------------------------------------------------------------------

/** One slider that edits a field of the selected face. Does nothing until there is a face. */
function Row({ id, label, group, value, min, max, neutral, apply }: { id: string; label: string; group: string; value: number; min: number; max: number; neutral: number; apply: (p: Portrait, v: number) => Portrait }) {
  const faceNo = useDevelop((s) => Math.min(s.selectedFace, s.recipe.portraits.length - 1) + 1)
  const several = useDevelop((s) => s.recipe.portraits.length > 1)
  const all = useDevelop((s) => s.allFaces && s.recipe.portraits.length > 1)
  const name = `${group}${all ? ' (all faces)' : several ? ` (face ${faceNo})` : ''}: ${label.toLowerCase()}`
  return (
    <SliderRow
      id={id}
      label={label}
      value={value}
      min={min}
      max={max}
      step={1}
      digits={0}
      neutral={neutral}
      onLive={(v) => store().liveFaceSliders((p) => apply(p, v))}
      onCommit={() => void store().commitPortrait(name)}
      onReset={() => {
        store().liveFaceSliders((p) => apply(p, neutral))
        void store().commitPortrait(`Reset ${name}`)
      }}
    />
  )
}

const ResetButton = ({ disabled, onClick }: { disabled: boolean; onClick: () => void }) => (
  <button type="button" className="btn sm ghost" disabled={disabled} onClick={onClick}>
    Reset
  </button>
)

/** "Editing face 2 of 5", for the panels whose sliders belong to one face. */
function WhichFace() {
  const { faces, index } = useActive()
  const all = useDevelop((s) => s.allFaces)
  if (faces.length < 2) return null
  return (
    <p className="hint" role="status">
      {all ? `Editing all ${faces.length} faces together. The sliders show face ${index + 1}.` : `Editing face ${index + 1} of ${faces.length}.`}
    </p>
  )
}

/** What the sliders say when there is no face yet: how to get one, with the button that finds faces by itself. */
function NoFace() {
  const detecting = useDevelop((s) => s.detecting)
  return (
    <div className="row">
      <p className="hint">Mark a face first.</p>
      <button type="button" className="btn sm" aria-busy={detecting} disabled={detecting} onClick={() => void store().detectFaces()} title="Look for faces in the picture">
        {detecting ? 'Looking…' : 'Find faces'}
      </button>
    </div>
  )
}

function SelectorPanel() {
  const { faces, index } = useActive()
  const tool = useDevelop((s) => s.portraitTool)
  const selected = useDevelop((s) => s.selectedRegion)
  const zoomed = useDevelop((s) => s.zoom.on)
  const detecting = useDevelop((s) => s.detecting)
  const note = useDevelop((s) => s.faceNote)
  const all = useDevelop((s) => s.allFaces)
  return (
    <Panel title="Retouch face selector">
      {faces.length === 0 && (
        <p className="hint" role="status">
          No face marked
        </p>
      )}
      <button type="button" className="btn sm" disabled={detecting} onClick={() => void store().autoRetouch()} title="Finds the faces and gives every one a light, natural retouch. Adjust the sliders afterwards.">
        Auto retouch
      </button>
      <div className="row" role="group" aria-label="Find faces">
        <button type="button" className="btn sm" aria-busy={detecting} disabled={detecting} onClick={() => void store().detectFaces()} title="Look for faces in the picture. Faces already marked are kept.">
          {detecting ? 'Looking for faces…' : 'Detect faces'}
        </button>
        <button type="button" className="btn sm" aria-pressed={tool} onClick={() => store().setPortraitTool(!tool)} title="Click the middle of a face on the picture to add it">
          Mark face
        </button>
      </div>
      {note && (
        <p className="hint" role="status">
          {note}
        </p>
      )}
      {tool && <p className="hint">Click the middle of a face. Its eyes and mouth are placed for you; drag them into position afterwards.</p>}
      {zoomed && <p className="hint">Faces are found and marked with the whole picture in view. Press Z to fit it.</p>}
      {faces.length > 0 && (
        <>
          {faces.length > 1 && (
            <button type="button" className="btn sm" aria-pressed={all} onClick={() => store().setAllFaces(!all)} title="Select every marked face, so the Skin, Teeth and Eyes sliders change all of them together">
              Select all faces
            </button>
          )}
          <ul className="mask-list" aria-label="Faces">
            {faces.map((_, k) => (
              <li key={k} className={all || k === index ? 'sel' : ''}>
                <button type="button" className="mask-name" aria-pressed={all || k === index} onClick={() => store().selectFace(k)}>
                  <span className="trunc">Face {k + 1}{orientationText(faces[k]) ? ` (${orientationText(faces[k])})` : ''}</span>
                </button>
                <button type="button" className="x" aria-label={`Delete face ${k + 1}`} onClick={() => void store().deleteFace(k)}>
                  ×
                </button>
              </li>
            ))}
          </ul>
          <p className="hint">Pick a face to retouch it, or Select all faces to retouch them together. Delete one that is not a face.</p>
          <ul className="mask-list" aria-label="Marked regions">
            {REGIONS.map(({ key, label }) => (
              <li key={key} className={key === selected ? 'sel' : ''}>
                <button type="button" className="mask-name" aria-pressed={key === selected} onClick={() => store().selectRegion(key === selected ? null : key)}>
                  <span className="trunc">{label}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="hint">Pick a region to see it on the picture and drag its dots. Moving the face moves its eyes and mouth with it.</p>
          <div className="row">
            {faces.length > 1 && (
              <button type="button" className="btn sm" title="Give every face the skin, teeth and eye settings of this one" onClick={() => void store().copyToAllFaces()}>
                Copy to all faces
              </button>
            )}
            <button type="button" className="btn sm" onClick={() => void store().clearPortraits()}>
              {faces.length > 1 ? 'Clear all faces' : 'Clear face'}
            </button>
          </div>
        </>
      )}
    </Panel>
  )
}

function SkinPanel() {
  const { face } = useActive()
  const s = face?.skin ?? DEFAULT_SKIN
  const skin = (key: keyof typeof DEFAULT_SKIN) => (p: Portrait, v: number): Portrait => ({ ...p, skin: { ...p.skin, [key]: v } })
  const row = (key: keyof typeof DEFAULT_SKIN, label: string, min: number, max: number) => <Row id={`sl-skin-${key}`} label={label} group="Skin" value={s[key]} min={min} max={max} neutral={DEFAULT_SKIN[key]} apply={skin(key)} />
  return (
    <Panel
      title="Retouch face skin"
      action={<ResetButton disabled={!face || skinIsDefault(face)} onClick={() => { store().liveFaceSliders((p) => ({ ...p, skin: { ...DEFAULT_SKIN } })); void store().commitPortrait('Reset skin retouch') }} />}
    >
      <WhichFace />
      <fieldset className="plain" disabled={!face}>
        {row('impact', 'Impact', 0, 100)}
        <p className="subhead">Blemish removal</p>
        {row('blemishes', 'Blemishes', 0, 100)}
        {row('darkCircles', 'Dark circles', 0, 100)}
        <p className="subhead">Frequency separation</p>
        {row('radius', 'Detail size', 0, 100)}
        {row('evenAmount', 'Amount', 0, 100)}
        {row('evenTexture', 'Texture', 0, 100)}
        {row('contouring', 'Contouring', -100, 100)}
        <p className="subhead">Tone, shine and colour</p>
        {row('tone', 'Even tone', 0, 100)}
        {row('shine', 'Shine', 0, 100)}
        {row('colour', 'Even colour', 0, 100)}
        <p className="subhead">Finish</p>
        {row('glow', 'Skin highlights', 0, 100)}
        {row('crisp', 'Skin texture', 0, 100)}
        <p className="hint">Even tone lifts hollows and eases bright patches (dodge and burn). Shine takes the oily highlights down. Even colour smooths blotches and redness towards the usual colour of the skin.</p>
        <p className="subhead">Neck, shoulders and arms</p>
        {row('body', 'Body skin', 0, 100)}
        <p className="hint">Smooths skin below the chin that is the colour of the face, with the same settings. Clothes, hair and the background are left alone.</p>
      </fieldset>
      {!face && <NoFace />}
    </Panel>
  )
}

function TeethPanel() {
  const { face } = useActive()
  const t = face?.teeth ?? DEFAULT_TEETH
  return (
    <Panel
      title="Retouch teeth"
      action={<ResetButton disabled={!face || teethIsDefault(face)} onClick={() => { store().liveFaceSliders((p) => ({ ...p, teeth: { ...DEFAULT_TEETH } })); void store().commitPortrait('Reset teeth retouch') }} />}
    >
      <WhichFace />
      <fieldset className="plain" disabled={!face}>
        <Row id="sl-teeth-brightness" label="Brightness" group="Teeth" value={t.brightness} min={-100} max={100} neutral={0} apply={(p, v) => ({ ...p, teeth: { ...p.teeth, brightness: v } })} />
        <Row id="sl-teeth-desaturation" label="Desaturation" group="Teeth" value={t.desaturation} min={0} max={100} neutral={0} apply={(p, v) => ({ ...p, teeth: { ...p.teeth, desaturation: v } })} />
      </fieldset>
      {!face && <NoFace />}
    </Panel>
  )
}

function FeaturesPanel() {
  const { face } = useActive()
  const changed = !!face && ((face.lips ?? 0) !== 0 || (face.brows ?? 0) !== 0)
  return (
    <Panel
      title="Retouch lips and brows"
      action={<ResetButton disabled={!changed} onClick={() => { store().liveFaceSliders((p) => ({ ...p, lips: 0, brows: 0 })); void store().commitPortrait('Reset lips and brows') }} />}
    >
      <WhichFace />
      <fieldset className="plain" disabled={!face}>
        <Row id="sl-lips" label="Lip colour" group="Lips" value={face?.lips ?? 0} min={-100} max={100} neutral={0} apply={(p, v) => ({ ...p, lips: v })} />
        <Row id="sl-brows" label="Eyebrows" group="Brows" value={face?.brows ?? 0} min={-100} max={100} neutral={0} apply={(p, v) => ({ ...p, brows: v })} />
      </fieldset>
      {!face && <NoFace />}
    </Panel>
  )
}

type Side = 'both' | 'left' | 'right'
const SIDES: { key: Side; label: string }[] = [
  { key: 'both', label: 'Both' },
  { key: 'left', label: 'Left' },
  { key: 'right', label: 'Right' },
]

function EyesPanel() {
  const { face } = useActive()
  const [side, setSide] = useState<Side>('both')
  const e = face?.eyes[side] ?? DEFAULT_EYE
  const apply = (key: 'iris' | 'sclera') => (p: Portrait, v: number): Portrait => ({ ...p, eyes: { ...p.eyes, [side]: { ...p.eyes[side], [key]: v } } })
  return (
    <Panel
      title="Retouch eyes"
      action={<ResetButton disabled={!face || eyesIsDefault(face)} onClick={() => { store().liveFaceSliders((p) => ({ ...p, eyes: { both: { ...DEFAULT_EYE }, left: { ...DEFAULT_EYE }, right: { ...DEFAULT_EYE } } })); void store().commitPortrait('Reset eyes retouch') }} />}
    >
      <WhichFace />
      <div className="row" role="group" aria-label="Which eye">
        {SIDES.map(({ key, label }) => (
          <button key={key} type="button" className="btn sm" aria-pressed={side === key} onClick={() => setSide(key)}>
            {label}
          </button>
        ))}
      </div>
      <fieldset className="plain" disabled={!face}>
        <Row id="sl-eyes-iris" label="Iris" group={`Eyes (${side})`} value={e.iris} min={-100} max={100} neutral={0} apply={apply('iris')} />
        <Row id="sl-eyes-sclera" label="Sclera" group={`Eyes (${side})`} value={e.sclera} min={-100} max={100} neutral={0} apply={apply('sclera')} />
      </fieldset>
      {!face && <NoFace />}
      {face && side !== 'both' && <p className="hint">The {side} eye gets what Both says, plus this.</p>}
    </Panel>
  )
}

export function PortraitPanels() {
  return (
    <>
      <SelectorPanel />
      <SkinPanel />
      <TeethPanel />
      <EyesPanel />
      <FeaturesPanel />
    </>
  )
}
