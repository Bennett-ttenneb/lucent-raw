/**
 * From the brightness of a picture and of a blurred copy of it, a picture of the small specks: black where the two agree,
 * brighter the more a spot differs from its surroundings (a dust speck, a hair, a blemish), dark or light alike.
 * `gain` makes faint specks easier to see.
 */
export function speckMap(luma: ArrayLike<number>, blurred: ArrayLike<number>, gain = 6): Uint8ClampedArray<ArrayBuffer> {
  const n = Math.min(luma.length, blurred.length)
  const out = new Uint8ClampedArray(n * 4)
  for (let i = 0; i < n; i++) {
    const v = Math.abs(luma[i] - blurred[i]) * gain
    // a gentle curve so that faint specks show without the busy parts of the picture turning white
    const s = Math.min(255, Math.round(255 * Math.pow(Math.min(1, v / 255), 0.7)))
    out[i * 4] = s
    out[i * 4 + 1] = s
    out[i * 4 + 2] = s
    out[i * 4 + 3] = 255
  }
  return out
}

/** Brightness (0 to 255) of each pixel of an RGBA picture. */
export function lumaOf(rgba: ArrayLike<number>): Float32Array {
  const n = Math.floor(rgba.length / 4)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2]
  return out
}
