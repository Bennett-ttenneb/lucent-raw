/** Where a pointer is on the picture, as fractions of it (0 to 1 each way), or null when it is outside the picture. */
export function pictureFraction(box: { left: number; top: number; width: number; height: number }, naturalWidth: number, naturalHeight: number, clientX: number, clientY: number): [number, number] | null {
  if (!naturalWidth || !naturalHeight || box.width <= 0 || box.height <= 0) return null
  // the picture is drawn as large as fits in its box, centred
  const scale = Math.min(box.width / naturalWidth, box.height / naturalHeight)
  const [dw, dh] = [naturalWidth * scale, naturalHeight * scale]
  const [fx, fy] = [(clientX - (box.left + (box.width - dw) / 2)) / dw, (clientY - (box.top + (box.height - dh) / 2)) / dh]
  return fx < 0 || fy < 0 || fx > 1 || fy > 1 ? null : [fx, fy]
}

/** The pixel that a fraction points at. */
export const pixelAt = (f: [number, number], naturalWidth: number, naturalHeight: number): [number, number] => [Math.min(naturalWidth - 1, Math.floor(f[0] * naturalWidth)), Math.min(naturalHeight - 1, Math.floor(f[1] * naturalHeight))]

/** "R 124  G 98  B 77  (49%  38%  30%)" */
export function readoutText(r: number, g: number, b: number): string {
  const pc = (v: number) => `${Math.round((v / 255) * 100)}%`
  return `R ${r}  G ${g}  B ${b}  (${pc(r)}  ${pc(g)}  ${pc(b)})`
}
