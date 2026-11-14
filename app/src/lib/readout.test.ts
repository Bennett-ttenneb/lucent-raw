import { describe, expect, it } from 'vitest'
import { pictureFraction, pixelAt, readoutText } from './readout'

describe('where the pointer is on the picture', () => {
  const box = { left: 100, top: 50, width: 800, height: 400 }
  it('a picture that fills the box is measured across the box', () => {
    expect(pictureFraction(box, 1600, 800, 100, 50)).toEqual([0, 0])
    expect(pictureFraction(box, 1600, 800, 900, 450)).toEqual([1, 1])
    expect(pictureFraction(box, 1600, 800, 500, 250)).toEqual([0.5, 0.5])
  })
  it('a picture that is narrower than the box is centred, and the bars either side are outside it', () => {
    // a square picture in an 800 x 400 box is 400 wide, from x = 300 to 700
    expect(pictureFraction(box, 1000, 1000, 299, 250)).toBeNull()
    expect(pictureFraction(box, 1000, 1000, 701, 250)).toBeNull()
    const f = pictureFraction(box, 1000, 1000, 400, 250)!
    expect(f[0]).toBeCloseTo(0.25)
    expect(f[1]).toBeCloseTo(0.5)
  })
  it('a wide picture in a tall box is centred the other way', () => {
    const tall = { left: 0, top: 0, width: 400, height: 800 }
    expect(pictureFraction(tall, 2000, 1000, 200, 100)).toBeNull() // above the picture: it runs from y = 300 to 500
    expect(pictureFraction(tall, 2000, 1000, 200, 400)![1]).toBeCloseTo(0.5)
  })
  it('outside the box, an empty picture or an empty box is nowhere', () => {
    expect(pictureFraction(box, 1600, 800, 50, 250)).toBeNull()
    expect(pictureFraction(box, 0, 800, 500, 250)).toBeNull()
    expect(pictureFraction({ left: 0, top: 0, width: 0, height: 10 }, 100, 100, 0, 0)).toBeNull()
  })
  it('points at the pixel under it, and never past the last', () => {
    expect(pixelAt([0, 0], 100, 50)).toEqual([0, 0])
    expect(pixelAt([0.5, 0.5], 100, 50)).toEqual([50, 25])
    expect(pixelAt([1, 1], 100, 50)).toEqual([99, 49])
  })
})

describe('the readout', () => {
  it('shows the three values and their shares', () => {
    expect(readoutText(0, 0, 0)).toBe('R 0  G 0  B 0  (0%  0%  0%)')
    expect(readoutText(255, 255, 255)).toBe('R 255  G 255  B 255  (100%  100%  100%)')
    expect(readoutText(124, 98, 77)).toBe('R 124  G 98  B 77  (49%  38%  30%)')
  })
})
