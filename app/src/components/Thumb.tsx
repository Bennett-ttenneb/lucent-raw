import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import { usePreviewKey, useStore } from '../lib/store'
import type { Photo, PreviewLevel } from '../lib/types'

/** Preview image with a quiet placeholder. Retries when the core announces new previews. */
export function Thumb({ photo, level = 'thumb', className }: { photo: Photo; level?: PreviewLevel; className?: string }) {
  const version = useStore((s) => s.previewVersion)
  const key = usePreviewKey(photo.id)
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [version, photo.id])

  if (!photo.previewable) {
    return (
      <span className={`ph ph-note ${className ?? ''}`}>
        <span>{photo.format.toUpperCase()}</span>
        <small>No preview yet</small>
      </span>
    )
  }
  if (failed) return <span className={`ph ph-wait ${className ?? ''}`} aria-hidden />
  return (
    <img
      className={`ph-img ${className ?? ''}`}
      src={api().previewUrl(photo.id, level, key)}
      alt=""
      decoding="async"
      draggable={false}
      onError={() => setFailed(true)}
    />
  )
}
