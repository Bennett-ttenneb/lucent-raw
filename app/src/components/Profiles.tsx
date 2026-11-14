import { useState } from 'react'
import { api } from '../lib/api'
import { useDevelop } from '../lib/develop'
import { PROFILES } from '../lib/types'
import { Dialog } from './Primitives'
import { SliderRow } from './SliderRow'

const labelOf = (id: string) => PROFILES.find((p) => p.id === id)?.label ?? 'Standard'

/** The profile of the open photo: the look it starts from. Browse shows the photo itself in every profile. */
export function ProfileRow() {
  const profile = useDevelop((s) => s.recipe.profile)
  const amount = useDevelop((s) => s.recipe.profileAmount)
  const [browsing, setBrowsing] = useState(false)
  return (
    <fieldset className="sgroup">
      <legend>Profile</legend>
      <div className="row">
        <span className="trunc" role="status">
          {labelOf(profile)}
        </span>
        <button type="button" className="btn sm" onClick={() => setBrowsing(true)} title="See the photo in every profile">
          Browse profiles…
        </button>
      </div>
      {profile !== '' && (
        <SliderRow
          id="profile-amount"
          label="Profile amount"
          value={amount}
          min={0}
          max={200}
          step={1}
          digits={0}
          neutral={100}
          onLive={(v) => useDevelop.getState().live({ profileAmount: v })}
          onCommit={() => void useDevelop.getState().commit({ label: 'Profile amount', deltaText: null, valueText: String(Math.round(useDevelop.getState().recipe.profileAmount)) })}
          onReset={() => void useDevelop.getState().setAndCommit({ profileAmount: 100 }, { label: 'Reset profile amount', deltaText: null, valueText: '100' })}
        />
      )}
      <ProfileBrowser open={browsing} onClose={() => setBrowsing(false)} />
    </fieldset>
  )
}

function ProfileBrowser({ open, onClose }: { open: boolean; onClose: () => void }) {
  const photoId = useDevelop((s) => s.photoId)
  const recipe = useDevelop((s) => s.recipe)
  const version = useDevelop((s) => s.version)
  const choose = (id: string) => {
    onClose()
    if (id === recipe.profile) return
    void useDevelop.getState().setAndCommit({ profile: id, profileAmount: 100 }, { label: `Profile: ${labelOf(id)}`, deltaText: null, valueText: labelOf(id) })
  }
  return (
    <Dialog open={open} onClose={onClose} title="Profiles" wide>
      <div className="form">
        <p className="hint">A profile is the look the photo starts from, before the sliders. Each picture below is your photo with that profile on it.</p>
        <ul className="profile-grid" aria-label="Profiles">
          {PROFILES.map((p) => (
            <li key={p.id || 'standard'}>
              <button type="button" className="profile-tile" aria-pressed={recipe.profile === p.id} onClick={() => choose(p.id)}>
                {photoId !== null && <img src={api().renderUrl(photoId, { ...recipe, profile: p.id, profileAmount: 100 }, version, 240)} alt="" draggable={false} />}
                <strong>{p.label}</strong>
                <small>{p.note}</small>
              </button>
            </li>
          ))}
        </ul>
      </div>
      <div className="dialog-foot">
        <button type="button" className="btn" onClick={onClose}>
          Close
        </button>
      </div>
    </Dialog>
  )
}
