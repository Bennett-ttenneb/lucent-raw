/**
 * How a photo is turned: first mirrored left to right if `mirror` is set, then turned clockwise by `quarterTurns` (0 to 3).
 * That is how the core stores it. The buttons talk about what you see on the screen, so each one says what the pair of
 * numbers becomes: turning is simple, and a flip on the screen is a flip of the mirror together with a mirrored turn.
 */
export interface Orientation {
  quarterTurns: number
  mirror: boolean
}

export const NOT_TURNED: Orientation = { quarterTurns: 0, mirror: false }

export const rotateRight = (o: Orientation): Orientation => ({ quarterTurns: (o.quarterTurns + 1) % 4, mirror: o.mirror })
export const rotateLeft = (o: Orientation): Orientation => ({ quarterTurns: (o.quarterTurns + 3) % 4, mirror: o.mirror })
/** Left becomes right on the screen. */
export const flipHorizontal = (o: Orientation): Orientation => ({ quarterTurns: (4 - o.quarterTurns) % 4, mirror: !o.mirror })
/** Top becomes bottom on the screen. */
export const flipVertical = (o: Orientation): Orientation => ({ quarterTurns: (6 - o.quarterTurns) % 4, mirror: !o.mirror })

/** A picture as rows of text, turned the way the core turns it (used by the tests to check the buttons against the core's table). */
export function orientRows(rows: string[], o: Orientation): string[] {
  let g = rows.map((r) => [...r])
  if (o.mirror) g = g.map((r) => [...r].reverse())
  for (let i = 0; i < o.quarterTurns % 4; i++) {
    // clockwise: the new row i is the old column i read from the bottom up
    g = g[0].map((_, x) => g.map((row) => row[x]).reverse())
  }
  return g.map((r) => r.join(''))
}

export const isNotTurned = (o: Orientation) => o.quarterTurns % 4 === 0 && !o.mirror
