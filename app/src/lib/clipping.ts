import { create } from 'zustand'

/** A pixel at or above this in any channel has lost its highlight detail. */
export const BLOWN = 253
/** A pixel at or below this in every channel has lost its shadow detail. */
export const CRUSHED = 2

export interface Clipping {
  /** the warning colours, one RGBA pixel per picture pixel: red where blown, blue where crushed, clear elsewhere */
  overlay: Uint8ClampedArray<ArrayBuffer>
  /** the share of the picture that is blown or crushed, 0 to 100 */
  blown: number
  crushed: number
}

/** The colour that says which channels have clipped: red, green or blue alone, two of them mixed, or white for all three. */
const CHANNEL_COLOUR: Record<number, [number, number, number]> = {
  1: [255, 60, 60],
  2: [60, 255, 60],
  4: [60, 60, 255],
  3: [255, 255, 60],
  5: [255, 60, 255],
  6: [60, 255, 255],
  7: [255, 255, 255],
}

/**
 * Find the pixels that have lost their detail. `rgba` is a picture as a canvas gives it (four bytes a pixel).
 * By default blown means any channel at or above `hi` (painted red) and crushed means every channel at or below `lo` (blue).
 * With `byChannel`, the colour says which channels clipped (red, green, blue, or their mixes), for the highlights and for the shadows
 * (the shadows more faintly), and a shadow counts when any channel is at or below `lo`.
 */
export function findClipping(rgba: Uint8ClampedArray, hi = BLOWN, lo = CRUSHED, byChannel = false): Clipping {
  const n = Math.floor(rgba.length / 4)
  const overlay = new Uint8ClampedArray(n * 4)
  let blown = 0
  let crushed = 0
  for (let i = 0; i < n; i++) {
    const [r, g, b] = [rgba[i * 4], rgba[i * 4 + 1], rgba[i * 4 + 2]]
    if (byChannel) {
      const high = (r >= hi ? 1 : 0) | (g >= hi ? 2 : 0) | (b >= hi ? 4 : 0)
      const low = (r <= lo ? 1 : 0) | (g <= lo ? 2 : 0) | (b <= lo ? 4 : 0)
      if (high) {
        overlay.set([...CHANNEL_COLOUR[high], 210], i * 4)
        blown++
      } else if (low) {
        overlay.set([...CHANNEL_COLOUR[low], 110], i * 4)
        crushed++
      }
      continue
    }
    if (r >= hi || g >= hi || b >= hi) {
      overlay.set([255, 50, 50, 200], i * 4)
      blown++
    } else if (r <= lo && g <= lo && b <= lo) {
      overlay.set([50, 120, 255, 200], i * 4)
      crushed++
    }
  }
  return { overlay, blown: n ? (blown / n) * 100 : 0, crushed: n ? (crushed / n) * 100 : 0 }
}

/** "2.1%", or "under 0.1%" for a little, or "none". */
export const shareText = (percent: number) => (percent <= 0 ? 'none' : percent < 0.1 ? 'under 0.1%' : `${percent.toFixed(1)}%`)

// ---- what the clipping warning counts as clipped, kept between launches ------------------------------------

const KEY = 'lucent.clipping'
export interface ClipPrefs {
  /** colour by channel instead of one red and one blue */
  byChannel: boolean
  /** the level (0 to 255) at and above which a highlight counts as blown */
  hi: number
  /** the level at and below which a shadow counts as crushed */
  lo: number
}
const DEFAULT: ClipPrefs = { byChannel: false, hi: BLOWN, lo: CRUSHED }

function load(): ClipPrefs {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<ClipPrefs> | null
    if (!raw) return DEFAULT
    const lim = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d)
    return { byChannel: raw.byChannel === true, hi: lim(raw.hi, 200, 255, BLOWN), lo: lim(raw.lo, 0, 55, CRUSHED) }
  } catch {
    return DEFAULT
  }
}

export const useClipPrefs = create<ClipPrefs & { set(p: Partial<ClipPrefs>): void; reset(): void }>((set, get) => ({
  ...load(),
  set(p) {
    set(p)
    const { byChannel, hi, lo } = get()
    try {
      localStorage.setItem(KEY, JSON.stringify({ byChannel, hi, lo }))
    } catch {
      /* the choice lasts until the window closes */
    }
  },
  reset() {
    get().set(DEFAULT)
  },
}))