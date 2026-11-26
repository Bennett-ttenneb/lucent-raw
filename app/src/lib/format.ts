let override: string | null = null

/** Write numbers the way another language does (null: the way the computer is set up). */
export const setNumberLocale = (l: string | null) => {
  override = l
}

const locale = () => override ?? ((typeof navigator !== 'undefined' && navigator.language) || 'en')

/** The characters this language uses between the whole and the fraction of a number, and between thousands. */
export function numberMarks(): { decimal: string; group: string } {
  const parts = new Intl.NumberFormat(locale()).formatToParts(12345.6)
  return { decimal: parts.find((p) => p.type === 'decimal')?.value ?? '.', group: (parts.find((p) => p.type === 'group')?.value ?? ',').replace(/[\u00a0\u202f]/g, ' ') }
}

/** Read a number a person typed, the way their language writes it: "1,5" and "1.5" both mean one and a half in German, and "1.234,5" is one thousand two hundred thirty-four and a half. Returns null when it is not a number. */
export function parseNum(text: string): number | null {
  let s = text.trim().replace(/[\u00a0\u202f ]/g, '').replace(/[\u2212\u2013]/g, '-').replace(/[']/g, '')
  if (s === '' || !/^[+-]?[\d.,]+$/.test(s)) return null
  const { decimal, group } = numberMarks()
  const lastDot = s.lastIndexOf('.')
  const lastComma = s.lastIndexOf(',')
  let dec: string | null = null
  if (lastDot >= 0 && lastComma >= 0) dec = lastDot > lastComma ? '.' : ','
  else if (lastDot >= 0 || lastComma >= 0) {
    const mark = lastDot >= 0 ? '.' : ','
    const count = s.split(mark).length - 1
    const after = s.length - s.lastIndexOf(mark) - 1
    // one mark with three digits after it is a thousands mark in a language that uses that mark for thousands
    dec = count === 1 && !(mark === group && after === 3) ? mark : mark === decimal && count === 1 ? mark : null
  }
  if (dec !== null) {
    const at = s.lastIndexOf(dec)
    s = s.slice(0, at).replace(/[.,]/g, '') + '.' + s.slice(at + 1)
  } else s = s.replace(/[.,]/g, '')
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export const num = (n: number, digits = 0) =>
  n.toLocaleString(locale(), { minimumFractionDigits: digits, maximumFractionDigits: digits })

export function shutter(s: number | null): string {
  if (s === null || s <= 0) return ''
  if (s >= 1) return `${num(s, s % 1 ? 1 : 0)} s`
  return `1/${num(Math.round(1 / s))} s`
}

export const aperture = (a: number | null) => (a === null ? '' : `ƒ/${num(a, 1)}`)

/** One line like "1/160 s, ƒ/2,8, ISO 800, 50 mm". Missing parts are skipped, never printed as "null". */
export function exposureLine(p: { shutterS: number | null; aperture: number | null; iso: number | null; focalMm: number | null }): string {
  return [
    shutter(p.shutterS),
    aperture(p.aperture),
    p.iso !== null ? `ISO ${num(p.iso)}` : '',
    p.focalMm !== null ? `${num(p.focalMm, p.focalMm % 1 ? 1 : 0)} mm` : '',
  ]
    .filter(Boolean)
    .join(', ')
}

export function capturedLabel(iso: string | null): string {
  if (!iso) return 'Unknown'
  const d = new Date(iso) // camera clock, shown as written: no zone conversion
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' })
}

/** "Beta 2" for 0.1.0-beta2, otherwise "Version 0.1.0-test20": how a version is named in a sentence. */
export const versionName = (v: string) => {
  const m = /-beta(\d+)$/.exec(v)
  return m ? `Beta ${m[1]}` : `Version ${v}`
}

/** What About says after "Lucent Raw": "Beta 1 (0.1.0-beta1)", or "version 0.1.0-test20" for a test build. */
export const aboutVersion = (v: string) => {
  const m = /-beta(\d+)$/.exec(v)
  return m ? `Beta ${m[1]} (${v})` : `version ${v}`
}

export const plural = (n: number, one: string, many = one + 's') => `${num(n)} ${n === 1 ? one : many}`

/** A size in bytes as people say it: "1.9 GB", "320 MB", "12 KB". */
/** How sizes are counted: 1 GB is a thousand million bytes (the way disks and Windows Explorer's "GB" columns are sold), or the binary way, where 1 GB is 1024 x 1024 x 1024 bytes and is written GiB. */
let binaryUnits = false
export const setSizeUnits = (binary: boolean) => {
  binaryUnits = binary
}

export function bytesText(n: number): string {
  const [k, kb, mb, gb] = binaryUnits ? [1024, 'KiB', 'MiB', 'GiB'] : [1000, 'KB', 'MB', 'GB']
  const K = k as number
  if (n >= K ** 3) return `${num(n / K ** 3, 1)} ${gb}`
  if (n >= K ** 2) return `${num(n / K ** 2, n >= 100 * K ** 2 ? 0 : 1)} ${mb}`
  if (n >= K) return `${num(n / K)} ${kb}`
  return `${num(n)} bytes`
}

/** A size in whole GB (or TB), for a disk: "120 GB". */
export function diskText(n: number): string {
  const K = binaryUnits ? 1024 : 1000
  return n >= K ** 4 ? `${(n / K ** 4).toFixed(1)} ${binaryUnits ? 'TiB' : 'TB'}` : `${Math.round(n / K ** 3)} ${binaryUnits ? 'GiB' : 'GB'}`
}