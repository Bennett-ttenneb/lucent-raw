import { useEffect, useRef, useState, type CSSProperties } from 'react'
import { clamp, signed } from '../lib/develop'
import { num, parseNum } from '../lib/format'
import { usePrefs } from '../lib/prefs'
import { useSliderPrefs } from '../lib/sliderPrefs'

export interface RowProps {
  id: string
  label: string
  value: number
  min: number
  max: number
  step: number
  digits: number
  swatch?: string
  /** a CSS gradient for the line (Tint is green at one end and magenta at the other) */
  gradient?: string
  /** the value that means "untouched" (0 for most sliders, 1.0 for the sharpening radius) */
  neutral?: number
  onLive(v: number): void
  onCommit(): void
  onReset(): void
}

/** How far along its line a slider is, as the page's style needs it to colour the line up to the handle. */
export const fillStyle = (value: number, min: number, max: number) => ({ '--p': max > min ? Math.min(1, Math.max(0, (value - min) / (max - min))) : 0 }) as CSSProperties

/** One labelled slider with a number box. Used by Basic and by the colour mixer. */
export function SliderRow({ id, label, value, min, max, step, digits, swatch, gradient, neutral = 0, onLive, onCommit, onReset }: RowProps) {
  const [text, setText] = useState<string | null>(null)
  const arrows = useSliderPrefs((s) => s.arrows)
  usePrefs((s) => s.numberFormat) // the numbers are written again when the format is changed
  // one arrow click moves by one step (hold Shift for ten); the result is a history step after a short pause, like the keyboard
  // Held down for a second, an arrow keeps stepping (about twelve a second) until it is let go.
  const latest = useRef(value)
  latest.current = value
  const hold = useRef<{ wait?: ReturnType<typeof setTimeout>; tick?: ReturnType<typeof setInterval>; repeated: boolean }>({ repeated: false })
  const nudge = (dir: 1 | -1, big: boolean) => {
    const q = 10 ** digits
    const next = clamp(Math.round((latest.current + dir * step * (big ? 10 : 1)) * q) / q, min, max)
    if (next === latest.current) return false
    latest.current = next
    onLive(next)
    commitSoon()
    return true
  }
  const stopHold = () => {
    clearTimeout(hold.current.wait)
    clearInterval(hold.current.tick)
  }
  const startHold = (dir: 1 | -1, big: boolean) => {
    stopHold()
    hold.current.repeated = false
    hold.current.wait = setTimeout(() => {
      hold.current.repeated = true
      hold.current.tick = setInterval(() => {
        if (!nudge(dir, big)) stopHold()
      }, 80)
    }, 1000)
  }
  const arrowProps = (dir: 1 | -1) => ({
    onPointerDown: (e: React.PointerEvent) => e.button === 0 && startHold(dir, e.shiftKey),
    onPointerUp: stopHold,
    onPointerLeave: stopHold,
    onPointerCancel: stopHold,
    // the click that ends a long press must not add one more step
    onClick: (e: React.MouseEvent) => {
      if (hold.current.repeated) hold.current.repeated = false
      else nudge(dir, e.shiftKey)
    },
  })
  // Dragging is relative and half as fast as the line is long (a tenth with Shift held), so the handle does not jump and small changes are easy.
  const drag = useRef<{ x: number; v: number } | null>(null)
  const dragProps = {
    onPointerDown: (e: React.PointerEvent<HTMLInputElement>) => {
      if (e.button !== 0) return
      e.preventDefault()
      e.currentTarget.focus()
      e.currentTarget.setPointerCapture(e.pointerId)
      drag.current = { x: e.clientX, v: latest.current }
    },
    onPointerMove: (e: React.PointerEvent<HTMLInputElement>) => {
      const d = drag.current
      if (!d) return
      const room = Math.max(e.currentTarget.getBoundingClientRect().width - 16, 1)
      const raw = d.v + ((e.clientX - d.x) / room) * (max - min) * (e.shiftKey ? 0.1 : 0.5)
      const next = clamp(Math.round(Math.round(raw / step) * step * 10 ** digits) / 10 ** digits, min, max)
      if (next !== latest.current) onLive(next)
    },
  }
  const modified = value !== neutral
  const commit = onCommit
  // Holding an arrow key fires many key-ups: wait for a pause so it makes one history step, not twenty.
  const pause = useRef<ReturnType<typeof setTimeout>>(undefined)
  const commitSoon = () => {
    clearTimeout(pause.current)
    pause.current = setTimeout(commit, 600)
  }
  const commitNow = () => {
    clearTimeout(pause.current)
    commit()
  }
  useEffect(() => () => (clearTimeout(pause.current), clearTimeout(hold.current.wait), clearInterval(hold.current.tick)), [])
  return (
    <div className={`slider ${modified ? 'mod' : ''} ${arrows ? 'arrows' : ''}`}>
      <label htmlFor={id} className="slider-label" onDoubleClick={onReset} title="Double-click to reset">
        {swatch && <i className="swatch" style={{ background: swatch }} aria-hidden />}
        {label}
      </label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        className={gradient ? 'grad' : undefined}
        style={gradient ? ({ ...fillStyle(value, min, max), '--grad': gradient } as CSSProperties) : fillStyle(value, min, max)}
        aria-valuetext={signed(value, digits)}
        onChange={(e) => onLive(Number(e.target.value))}
        {...dragProps}
        onPointerUp={() => {
          drag.current = null
          commitNow()
        }}
        onKeyUp={(e) => /^(Arrow|Page|Home|End)/.test(e.key) && commitSoon()}
        onBlur={commitNow}
        onDoubleClick={onReset}
      />
      <input
        className="slider-num"
        type="text"
        inputMode="decimal"
        aria-label={`${label} value`}
        value={text ?? num(value, digits)}
        onFocus={(e) => (setText(num(value, digits)), e.currentTarget.select())} // same text as shown, so the selection survives the re-render
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          if (text !== null) {
            const n = parseNum(text)
            if (n !== null) {
              onLive(clamp(n, min, max))
              commit()
            }
            setText(null)
          }
        }}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
      />
      {arrows && (
        <span className="slider-step">
          <button type="button" aria-label={`Increase ${label}`} title="Up one step (Shift: ten)" disabled={value >= max} {...arrowProps(1)}>
            <svg viewBox="0 0 8 5" aria-hidden><path d="M0 5L4 0l4 5z" /></svg>
          </button>
          <button type="button" aria-label={`Decrease ${label}`} title="Down one step (Shift: ten)" disabled={value <= min} {...arrowProps(-1)}>
            <svg viewBox="0 0 8 5" aria-hidden><path d="M0 0l4 5 4-5z" /></svg>
          </button>
        </span>
      )}
    </div>
  )
}
