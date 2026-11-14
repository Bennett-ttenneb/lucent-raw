import AxeBuilder from '@axe-core/playwright'
import { cells, expect, open, pick, test } from './helpers'
import type { Page } from '@playwright/test'

async function openDevelop(page: Page, query = '') {
  await open(page, query)
  await pick(page, 0)
  await page.getByRole('tab', { name: 'Develop' }).click()
  await expect(page.getByRole('heading', { name: 'Basic' }).or(page.getByRole('button', { name: 'Basic', exact: true }))).toBeVisible()
  // the photo's own settings are fetched after the panels appear; edits made before they arrive are ignored
  await expect(page.getByRole('complementary', { name: 'Develop controls' })).not.toHaveAttribute('aria-busy', 'true')
}

/** Develop, then across to the Retouch module (spots, red eye, faces). */
async function openRetouch(page: Page, query = '') {
  await openDevelop(page, query)
  await page.getByRole('tab', { name: 'Retouch' }).click()
  await expect(page.getByRole('complementary', { name: 'Retouch controls' })).not.toHaveAttribute('aria-busy', 'true')
}

const picture = (page: Page) => page.locator('img.dev-img')

const slider = (page: Page, name: string) => page.getByRole('slider', { name, exact: true })

async function setSlider(page: Page, name: string, value: string) {
  const box = page.getByRole('textbox', { name: `${name} value`, exact: true })
  await box.click()
  await box.fill(value)
  await box.press('Enter')
}

test.describe('F05 develop: basic adjustments, crop and history', () => {
  test('F05-H1 pressing D opens Develop on the selected photo, and G goes back', async ({ page }) => {
    await open(page)
    await pick(page, 2)
    await page.keyboard.press('d')
    await expect(page.getByRole('region', { name: 'Edit' })).toBeVisible()
    await expect(picture(page)).toHaveAttribute('alt', /^IMG_[0-9]+.jpg$/)
    await page.keyboard.press('g')
    await expect(page.getByRole('grid', { name: /Photo grid/ })).toBeVisible()
  })

  test('F05-H2 a slider changes the picture, shows in History, and survives leaving and coming back', async ({ page }) => {
    await openDevelop(page)
    const before = await picture(page).getAttribute('src')
    await setSlider(page, 'Exposure', '1.5')
    await expect(slider(page, 'Exposure')).toHaveValue('1.5')
    await expect(picture(page)).not.toHaveAttribute('src', before!)
    await expect(picture(page)).toHaveAttribute('alt', /edited/)
    await expect(page.getByRole('list', { name: /Edit history/ }).getByRole('button', { name: /Exposure/ })).toBeVisible()
    // go to the library and back: still edited
    await page.getByRole('tab', { name: 'Library' }).click()
    await page.getByRole('tab', { name: 'Develop' }).click()
    await expect(slider(page, 'Exposure')).toHaveValue('1.5')
  })

  test('F05-H3 double-clicking a slider resets it', async ({ page }) => {
    await openDevelop(page)
    await setSlider(page, 'Contrast', '40')
    await page.locator('label', { hasText: /^Contrast$/ }).dblclick()
    await expect(slider(page, 'Contrast')).toHaveValue('0')
    await expect(page.getByRole('list', { name: /Edit history/ }).getByRole('button', { name: /Reset Contrast/ })).toBeVisible()
  })

  test('F05-H4 Before shows the original and backslash toggles it', async ({ page }) => {
    await openDevelop(page)
    await setSlider(page, 'Saturation', '-100')
    await page.keyboard.press('\\')
    await expect(picture(page)).toHaveAttribute('alt', /original/)
    await expect(page.getByText('Before', { exact: true }).first()).toBeVisible()
    await page.keyboard.press('\\')
    await expect(picture(page)).toHaveAttribute('alt', /edited/)
  })

  test('F05-H5 clicking a history step goes back to that state', async ({ page }) => {
    await openDevelop(page)
    await setSlider(page, 'Exposure', '1')
    await setSlider(page, 'Contrast', '50')
    await page.getByRole('list', { name: /Edit history/ }).getByRole('button', { name: /Exposure/ }).click()
    await expect(slider(page, 'Contrast')).toHaveValue('0')
    await expect(slider(page, 'Exposure')).toHaveValue('1')
  })

  test('F05-H6 reset all clears every adjustment', async ({ page }) => {
    await openDevelop(page)
    await setSlider(page, 'Exposure', '1')
    await setSlider(page, 'Vibrance', '30')
    await page.getByRole('toolbar', { name: 'Develop tools' }).getByRole('button', { name: 'Reset all' }).click()
    await expect(slider(page, 'Exposure')).toHaveValue('0')
    await expect(slider(page, 'Vibrance')).toHaveValue('0')
  })

  test('F05-H7 crop: picking a ratio and an angle is saved and can be reset', async ({ page }) => {
    await openDevelop(page)
    await page.getByRole('group', { name: 'Aspect ratio' }).getByRole('button', { name: '1:1' }).click()
    await expect(page.getByRole('button', { name: '1:1', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('list', { name: /Edit history/ }).getByRole('button', { name: /Crop/ })).toBeVisible()
    await page.getByRole('button', { name: 'Reset crop' }).click()
    await expect(page.getByRole('button', { name: 'Original', exact: true })).toHaveAttribute('aria-pressed', 'true')
  })

  test('F05-H8 copy and paste settings between photos', async ({ page }) => {
    await openDevelop(page)
    await setSlider(page, 'Tint', '25')
    await page.getByRole('button', { name: 'Copy settings…' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Copy', exact: true }).click()
    const first = await picture(page).getAttribute('alt')
    await page.keyboard.press('ArrowRight') // the next photo in the filmstrip
    await expect(picture(page)).not.toHaveAttribute('alt', first!)
    await expect(slider(page, 'Tint')).toHaveValue('0')
    await page.getByRole('button', { name: 'Paste settings' }).click()
    await expect(slider(page, 'Tint')).toHaveValue('25')
  })

  test('F05-E1 a value typed out of range is clamped, and text is ignored', async ({ page }) => {
    await openDevelop(page)
    await setSlider(page, 'Exposure', '99')
    await expect(slider(page, 'Exposure')).toHaveValue('5')
    await setSlider(page, 'Exposure', 'abc')
    await expect(slider(page, 'Exposure')).toHaveValue('5')
  })

  test('F05-E2 a failed save puts the slider back and says so', async ({ page }) => {
    await openDevelop(page, '?fail=1')
    await setSlider(page, 'Exposure', '2')
    await expect(page.getByRole('alert')).toContainText(/could not be saved/)
    await expect(slider(page, 'Exposure')).toHaveValue('0')
  })

  test('F05-E3 with nothing selected, Develop explains what to do', async ({ page }) => {
    await open(page, '?seed=0')
    await page.getByRole('tab', { name: 'Develop' }).click()
    await expect(page.getByRole('heading', { name: 'No photo selected' })).toBeVisible()
  })

  test('F05-E4 keyboard only: tab reaches the sliders and arrows adjust them', async ({ page }) => {
    await openDevelop(page)
    const s = slider(page, 'Contrast')
    await s.focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    await expect(s).toHaveValue('2')
    await s.blur()
    await expect(page.getByRole('list', { name: /Edit history/ }).getByRole('button', { name: /Contrast/ })).toBeVisible()
  })

  test('F05-A1 no accessibility violations in Develop', async ({ page }) => {
    await openDevelop(page)
    await setSlider(page, 'Exposure', '1')
    const r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
  })
})

test.describe('F05 develop: tone curve', () => {
  const curve = (page: Page) => page.getByRole('group', { name: /^Tone curve/ })
  const points = (page: Page) => page.getByRole('slider', { name: /^Curve point/ })

  test('F05-C1 clicking the curve adds a point, dragging moves it, and it is saved to history', async ({ page }) => {
    await openDevelop(page)
    await expect(points(page)).toHaveCount(0)
    await curve(page).scrollIntoViewIfNeeded()
    const box = (await curve(page).boundingBox())!
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 4, { steps: 5 })
    await page.mouse.up()
    await expect(points(page)).toHaveCount(1)
    const y = Number(await points(page).first().getAttribute('aria-valuenow'))
    expect(y).toBeGreaterThan(150) // dragged up from the middle
    await expect(page.getByRole('list', { name: /Edit history/ }).getByRole('button', { name: /Tone curve/ })).toBeVisible()
  })

  test('F05-C2 keyboard: arrows move a focused point and Delete removes it, without stepping to another photo', async ({ page }) => {
    await openDevelop(page)
    const photo = await picture(page).getAttribute('alt')
    await curve(page).scrollIntoViewIfNeeded()
    const box = (await curve(page).boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    const p = points(page).first()
    await p.focus()
    const before = Number(await p.getAttribute('aria-valuenow'))
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('Shift+ArrowUp')
    await expect(p).toHaveAttribute('aria-valuenow', String(before + 11))
    await page.keyboard.press('Delete')
    await expect(points(page)).toHaveCount(0)
    expect(await picture(page).getAttribute('alt')).toBe(photo)
  })

  test('F05-C3 double-clicking a point removes it, and Reset clears the whole curve', async ({ page }) => {
    await openDevelop(page)
    await curve(page).scrollIntoViewIfNeeded()
    const box = (await curve(page).boundingBox())!
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.6)
    await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.3)
    await expect(points(page)).toHaveCount(2)
    await points(page).first().dblclick()
    await expect(points(page)).toHaveCount(1)
    await page.getByRole('region', { name: 'Tone curve' }).or(page.locator('section.panel', { hasText: 'Tone curve' })).getByRole('button', { name: 'Reset' }).click()
    await expect(points(page)).toHaveCount(0)
  })

  test('F05-C4 the curve survives leaving Develop', async ({ page }) => {
    await openDevelop(page)
    await curve(page).scrollIntoViewIfNeeded()
    const box = (await curve(page).boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await page.getByRole('tab', { name: 'Library' }).click()
    await page.getByRole('tab', { name: 'Develop' }).click()
    await expect(points(page)).toHaveCount(1)
  })

  test('F05-C5 no accessibility violations with a curve point', async ({ page }) => {
    await openDevelop(page)
    await curve(page).scrollIntoViewIfNeeded()
    const box = (await curve(page).boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    const r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
  })
})

test.describe('F05 develop: colour mixer', () => {
  const mixer = (page: Page) => page.locator('section.panel', { hasText: 'Colour mixer' })
  const band = (page: Page, name: string) => mixer(page).getByRole('slider', { name, exact: true })

  test('F05-M1 the mixer has eight bands and three kinds', async ({ page }) => {
    await openDevelop(page)
    for (const b of ['Red', 'Orange', 'Yellow', 'Green', 'Aqua', 'Blue', 'Purple', 'Magenta']) await expect(band(page, b)).toBeVisible()
    await expect(mixer(page).getByRole('group', { name: 'Colour mixer adjustment' }).getByRole('button')).toHaveText(['Hue', 'Saturation', 'Luminance'])
  })

  test('F05-M2 a band slider is saved to history with its name, and each kind keeps its own values', async ({ page }) => {
    await openDevelop(page)
    await mixer(page).getByRole('textbox', { name: 'Red value' }).fill('30')
    await mixer(page).getByRole('textbox', { name: 'Red value' }).press('Enter')
    await expect(band(page, 'Red')).toHaveValue('30')
    await expect(page.getByRole('list', { name: /Edit history/ }).getByRole('button', { name: /Red hue/ })).toBeVisible()
    await mixer(page).getByRole('button', { name: 'Saturation' }).click()
    await expect(band(page, 'Red')).toHaveValue('0')
    await mixer(page).getByRole('button', { name: 'Hue' }).click()
    await expect(band(page, 'Red')).toHaveValue('30')
  })

  test('F05-M3 double-clicking a band label resets it, and Reset clears the whole mixer', async ({ page }) => {
    await openDevelop(page)
    for (const [name, v] of [['Blue', '-50'], ['Green', '20']] as const) {
      const box = mixer(page).getByRole('textbox', { name: `${name} value` })
      await box.fill(v)
      await box.press('Enter')
    }
    await mixer(page).locator('label', { hasText: 'Blue' }).dblclick()
    await expect(band(page, 'Blue')).toHaveValue('0')
    await expect(band(page, 'Green')).toHaveValue('20')
    await mixer(page).getByRole('button', { name: 'Reset', exact: true }).click()
    await expect(band(page, 'Green')).toHaveValue('0')
  })

  test('F05-M4 the mixer survives leaving Develop, and a value out of range is clamped', async ({ page }) => {
    await openDevelop(page)
    const box = mixer(page).getByRole('textbox', { name: 'Aqua value' })
    await box.fill('500')
    await box.press('Enter')
    await expect(band(page, 'Aqua')).toHaveValue('100')
    await page.getByRole('tab', { name: 'Library' }).click()
    await page.getByRole('tab', { name: 'Develop' }).click()
    await expect(band(page, 'Aqua')).toHaveValue('100')
  })

  test('F05-M5 no accessibility violations with the mixer in use', async ({ page }) => {
    await openDevelop(page)
    const box = mixer(page).getByRole('textbox', { name: 'Red value' })
    await box.fill('20')
    await box.press('Enter')
    const r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
  })
})

test.describe('F05 develop: detail', () => {
  const detail = (page: Page) => page.locator('section.panel', { hasText: 'Noise reduction' })
  const field = async (page: Page, name: string, value: string) => {
    const box = detail(page).getByRole('textbox', { name: `${name} value` })
    await box.fill(value)
    await box.press('Enter')
  }

  test('F05-D1 the panel offers sharpening and noise reduction sliders with the right ranges', async ({ page }) => {
    await openDevelop(page)
    const s = (name: string) => detail(page).getByRole('slider', { name, exact: true })
    await expect(s('Amount')).toHaveAttribute('max', '150')
    await expect(s('Radius')).toHaveValue('1')
    await expect(s('Radius')).toHaveAttribute('min', '0.5')
    await expect(s('Masking')).toBeVisible()
    await expect(s('Luminance')).toBeVisible()
    await expect(s('Colour')).toBeVisible()
  })

  test('F05-D2 a detail slider is saved with its own history name, and survives leaving Develop', async ({ page }) => {
    await openDevelop(page)
    await field(page, 'Amount', '60')
    await expect(page.getByRole('list', { name: /Edit history/ }).getByRole('button', { name: /Sharpening amount/ })).toBeVisible()
    await page.getByRole('tab', { name: 'Library' }).click()
    await page.getByRole('tab', { name: 'Develop' }).click()
    await expect(detail(page).getByRole('slider', { name: 'Amount', exact: true })).toHaveValue('60')
  })

  test('F05-D3 double-clicking the radius label puts it back at 1.0 (not 0), and Reset clears everything', async ({ page }) => {
    await openDevelop(page)
    await field(page, 'Radius', '2.5')
    await field(page, 'Luminance', '40')
    await detail(page).locator('label', { hasText: 'Radius' }).dblclick()
    await expect(detail(page).getByRole('slider', { name: 'Radius', exact: true })).toHaveValue('1')
    await detail(page).getByRole('button', { name: 'Reset', exact: true }).click()
    await expect(detail(page).getByRole('slider', { name: 'Luminance', exact: true })).toHaveValue('0')
  })

  test('F05-D4 values outside the range are clamped', async ({ page }) => {
    await openDevelop(page)
    await field(page, 'Amount', '900')
    await expect(detail(page).getByRole('slider', { name: 'Amount', exact: true })).toHaveValue('150')
    await field(page, 'Radius', '0')
    await expect(detail(page).getByRole('slider', { name: 'Radius', exact: true })).toHaveValue('0.5')
  })

  test('F05-D5 no accessibility violations with detail in use', async ({ page }) => {
    await openDevelop(page)
    await field(page, 'Amount', '40')
    const r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
  })
})

test.describe('F05 develop: 1:1 zoom and pan', () => {
  const zoomImg = (page: Page) => page.locator('img.zoom-img')
  const stage = (page: Page) => page.locator('.stage')
  const at = async (page: Page, fx: number, fy: number) => {
    const b = (await stage(page).boundingBox())!
    return { x: b.x + b.width * fx, y: b.y + b.height * fy }
  }

  test('F05-Z1 the Z key goes to 100% and back', async ({ page }) => {
    await openDevelop(page)
    await expect(page.getByRole('button', { name: 'Fit' })).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('z')
    await expect(zoomImg(page)).toBeVisible()
    await expect(page.getByText('100%', { exact: true }).first()).toBeVisible()
    await expect(page.getByRole('button', { name: '100%' })).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('z')
    await expect(zoomImg(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Fit' })).toHaveAttribute('aria-pressed', 'true')
  })

  test('F05-Z2 clicking the picture zooms in at the clicked spot', async ({ page }) => {
    await openDevelop(page)
    const left = await at(page, 0.3, 0.5)
    await page.mouse.click(left.x, left.y)
    await expect(zoomImg(page)).toBeVisible()
    const x1 = Number(await zoomImg(page).getAttribute('data-x'))
    await page.keyboard.press('z')
    const right = await at(page, 0.7, 0.5)
    await page.mouse.click(right.x, right.y)
    await expect(zoomImg(page)).toBeVisible()
    await expect(async () => {
      expect(Number(await zoomImg(page).getAttribute('data-x'))).toBeGreaterThan(x1 + 200)
    }).toPass()
  })

  test('F05-Z3 dragging pans, and a drag does not count as a click', async ({ page }) => {
    await openDevelop(page)
    await page.keyboard.press('z')
    await expect(zoomImg(page)).toBeVisible()
    const x0 = Number(await zoomImg(page).getAttribute('data-x'))
    const p = await at(page, 0.5, 0.5)
    await page.mouse.move(p.x, p.y)
    await page.mouse.down()
    await page.mouse.move(p.x - 200, p.y, { steps: 8 })
    await page.mouse.up()
    await expect(zoomImg(page)).toBeVisible() // still zoomed
    await expect(async () => {
      expect(Number(await zoomImg(page).getAttribute('data-x'))).toBeGreaterThan(x0 + 100) // dragged left, so the view moved right
    }).toPass()
  })

  test('F05-Z3b the picture at 100% fills the whole stage (it is not shifted off to one side)', async ({ page }) => {
    await openRetouch(page)
    await page.keyboard.press('z')
    await expect(zoomImg(page)).toBeVisible()
    const [img, box] = [(await zoomImg(page).boundingBox())!, (await stage(page).boundingBox())!]
    expect(Math.abs(img.x - box.x)).toBeLessThan(3)
    expect(Math.abs(img.y - box.y)).toBeLessThan(3)
    expect(Math.abs(img.width - box.width)).toBeLessThan(3)
  })

  test('F05-Z3c the Navigator sits under Presets, its frame follows the view, and clicking and dragging it moves the view', async ({ page }) => {
    await openDevelop(page)
    const titles = await page.locator('aside.side.left section.panel[data-title]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.title))
    expect(titles.indexOf('Navigator')).toBe(titles.indexOf('Presets') + 1)
    const nav = page.getByRole('button', { name: /^Picture map/ })
    await expect(nav).toBeVisible()
    await expect(page.locator('.nav-view')).toHaveCount(0) // fitted: no frame
    await nav.scrollIntoViewIfNeeded()
    const b = (await nav.boundingBox())!
    await page.mouse.click(b.x + b.width * 0.2, b.y + b.height * 0.2) // a click zooms in at that spot
    await expect(zoomImg(page)).toBeVisible()
    await expect(page.locator('.nav-view')).toHaveCount(1)
    const x0 = Number(await zoomImg(page).getAttribute('data-x'))
    await page.mouse.move(b.x + b.width * 0.2, b.y + b.height * 0.5)
    await page.mouse.down()
    await page.mouse.move(b.x + b.width * 0.9, b.y + b.height * 0.5, { steps: 6 })
    await page.mouse.up()
    await expect(async () => {
      expect(Number(await zoomImg(page).getAttribute('data-x'))).toBeGreaterThan(x0 + 100)
    }).toPass()
  })

  test('F05-Z4 a plain click at 100% goes back to fit', async ({ page }) => {
    await openDevelop(page)
    await page.keyboard.press('z')
    await expect(zoomImg(page)).toBeVisible()
    const p = await at(page, 0.5, 0.5)
    await page.mouse.click(p.x, p.y)
    await expect(zoomImg(page)).toHaveCount(0)
  })

  test('F05-Z5 the Fit and 100% buttons work, and the view stays inside the picture', async ({ page }) => {
    await openDevelop(page)
    await page.getByRole('button', { name: '100%' }).click()
    await expect(zoomImg(page)).toBeVisible()
    // drag right and down in short strokes inside the window, until the view is stopped by the top-left corner
    const from = await at(page, 0.15, 0.2)
    const to = await at(page, 0.85, 0.85)
    for (let i = 0; i < 4; i++) {
      await page.mouse.move(from.x, from.y)
      await page.mouse.down()
      await page.mouse.move(to.x, to.y, { steps: 6 })
      await page.mouse.up()
    }
    await expect(async () => {
      expect(Number(await zoomImg(page).getAttribute('data-x'))).toBe(0) // stopped at the left edge
      expect(Number(await zoomImg(page).getAttribute('data-y'))).toBe(0)
    }).toPass()
    await page.getByRole('button', { name: 'Fit' }).click()
    await expect(zoomImg(page)).toHaveCount(0)
  })

  test('F05-Z6 a slider still works at 100%', async ({ page }) => {
    await openDevelop(page)
    await page.keyboard.press('z')
    await expect(zoomImg(page)).toBeVisible()
    const before = await zoomImg(page).getAttribute('src')
    await setSlider(page, 'Exposure', '1')
    await expect(async () => {
      expect(await zoomImg(page).getAttribute('src')).not.toBe(before)
    }).toPass()
    await expect(zoomImg(page)).toHaveAttribute('alt', /edited, 100%/)
  })

  test('F05-Z7 changing the crop goes back to fit, and another photo starts fitted', async ({ page }) => {
    await openDevelop(page)
    await page.keyboard.press('z')
    await expect(zoomImg(page)).toBeVisible()
    await page.getByRole('group', { name: 'Aspect ratio' }).getByRole('button', { name: '3:2' }).click()
    await expect(zoomImg(page)).toHaveCount(0)
    await page.keyboard.press('z')
    await expect(zoomImg(page)).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await expect(zoomImg(page)).toHaveCount(0)
  })

  test('F05-Z8 no accessibility violations at 100%', async ({ page }) => {
    await openDevelop(page)
    await page.keyboard.press('z')
    await expect(zoomImg(page)).toBeVisible()
    const r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
  })
})

test.describe('F05 develop: edits show in the Library', () => {
  const badges = (page: Page) => page.locator('.cell-meta .flag.edit')

  test('F05-L1 an edited photo gets an edited badge in the grid and others do not', async ({ page }) => {
    await openDevelop(page)
    await expect(badges(page)).toHaveCount(0)
    await setSlider(page, 'Exposure', '1')
    await page.getByRole('tab', { name: 'Library' }).click()
    await expect(page.getByRole('grid', { name: /Photo grid/ })).toBeVisible()
    await expect(badges(page)).toHaveCount(1)
    await expect(badges(page).first()).toHaveText('edited')
  })

  test('F05-L2 resetting everything removes the badge again', async ({ page }) => {
    await openDevelop(page)
    await setSlider(page, 'Contrast', '30')
    await page.getByRole('toolbar', { name: 'Develop tools' }).getByRole('button', { name: 'Reset all' }).click()
    await page.getByRole('tab', { name: 'Library' }).click()
    await expect(page.getByRole('grid', { name: /Photo grid/ })).toBeVisible()
    await expect(badges(page)).toHaveCount(0)
  })

  test('F05-L3 only the edited photo\'s thumbnail is reloaded', async ({ page }) => {
    await openDevelop(page)
    const src = async () => page.locator('.cell-img').evaluateAll((els) => els.slice(0, 4).map((e) => (e as HTMLImageElement).src))
    await page.getByRole('tab', { name: 'Library' }).click()
    await expect(page.locator('.cell-img').first()).toBeVisible()
    const before = await src()
    await page.getByRole('tab', { name: 'Develop' }).click()
    await setSlider(page, 'Exposure', '1')
    await page.getByRole('tab', { name: 'Library' }).click()
    await expect(badges(page)).toHaveCount(1)
    const after = await src()
    const changed = before.map((s, i) => s !== after[i])
    expect(changed.filter(Boolean)).toHaveLength(1)
  })

  test('F05-L4 the badge is not announced as extra text in the grid cell name', async ({ page }) => {
    await openDevelop(page)
    await setSlider(page, 'Exposure', '1')
    await page.getByRole('tab', { name: 'Library' }).click()
    const r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
  })
})

test.describe('F05 develop: presets, snapshots and copy settings', () => {
  const presets = (page: Page) => page.locator('section.panel', { hasText: 'Presets' }).first()
  const snapshots = (page: Page) => page.locator('section.panel', { has: page.getByRole('button', { name: 'New snapshot' }) })
  const historyList = (page: Page) => page.getByRole('list', { name: /Edit history/ })

  test('F05-P1 the built-in presets are listed, and a click applies one as one history step', async ({ page }) => {
    await openDevelop(page)
    await expect(presets(page).getByRole('button', { name: 'Black and white' })).toBeVisible()
    await presets(page).getByRole('button', { name: 'Black and white' }).click()
    await expect(slider(page, 'Saturation')).toHaveValue('-100')
    await expect(historyList(page).getByRole('button', { name: /Preset: Black and white/ })).toBeVisible()
  })

  test('F05-P2 hovering a preset previews it without changing the settings or the history', async ({ page }) => {
    await openDevelop(page)
    const before = await picture(page).getAttribute('src')
    await presets(page).getByRole('button', { name: 'Punchy' }).hover()
    await expect(async () => {
      expect(await picture(page).getAttribute('src')).not.toBe(before)
    }).toPass()
    await expect(slider(page, 'Contrast')).toHaveValue('0')
    await expect(historyList(page)).toHaveCount(0)
    await page.mouse.move(700, 300)
    await expect(async () => {
      expect(await picture(page).getAttribute('src')).toBe(before)
    }).toPass()
  })

  test('F05-P3 a preset only changes its own groups', async ({ page }) => {
    await openDevelop(page)
    await setSlider(page, 'Saturation', '30')
    await presets(page).getByRole('button', { name: 'Open shadows' }).click()
    await expect(slider(page, 'Shadows')).toHaveValue('60')
    await expect(slider(page, 'Saturation')).toHaveValue('30')
  })

  test('F05-P4 saving a preset: the dialog starts with the changed groups ticked, the preset appears, and it can be deleted', async ({ page }) => {
    await openDevelop(page)
    await setSlider(page, 'Exposure', '0.5')
    await setSlider(page, 'Vibrance', '20')
    await presets(page).getByRole('button', { name: 'New preset' }).click()
    const dlg = page.getByRole('dialog', { name: 'New preset' })
    await expect(dlg.getByRole('checkbox', { name: 'Tone', exact: true })).toBeChecked()
    await expect(dlg.getByRole('checkbox', { name: 'Presence' })).toBeChecked()
    await expect(dlg.getByRole('checkbox', { name: 'Tone curve' })).not.toBeChecked()
    await dlg.getByLabel('Name').fill('Evening')
    await dlg.getByRole('button', { name: 'Create' }).click()
    await expect(dlg).not.toBeVisible()
    await expect(presets(page).getByRole('button', { name: 'Evening', exact: true })).toBeVisible()
    await expect(presets(page).getByText('User Presets')).toBeVisible()
    await presets(page).getByRole('button', { name: 'Delete preset Evening' }).click()
    await expect(presets(page).getByRole('button', { name: 'Evening', exact: true })).toHaveCount(0)
  })

  test('F05-P5 a repeated preset name is refused in the dialog, which stays open', async ({ page }) => {
    await openDevelop(page)
    await setSlider(page, 'Exposure', '0.5')
    for (const expectOk of [true, false]) {
      await presets(page).getByRole('button', { name: 'New preset' }).click()
      const dlg = page.getByRole('dialog', { name: 'New preset' })
      await dlg.getByLabel('Name').fill('Same')
      await dlg.getByRole('button', { name: 'Create' }).click()
      if (expectOk) await expect(dlg).not.toBeVisible()
      else {
        await expect(dlg.getByRole('alert')).toContainText('already exists')
        await dlg.getByRole('button', { name: 'Cancel' }).click()
      }
    }
  })

  test('F05-P6 the preset dialog needs a name and at least one group', async ({ page }) => {
    await openDevelop(page)
    await presets(page).getByRole('button', { name: 'New preset' }).click()
    const dlg = page.getByRole('dialog', { name: 'New preset' })
    await expect(dlg.getByRole('button', { name: 'Create' })).toBeDisabled()
    await dlg.getByLabel('Name').fill('Empty')
    await expect(dlg.getByRole('button', { name: 'Create' })).toBeDisabled() // nothing is changed, so nothing is ticked
    await dlg.getByRole('checkbox', { name: 'Tone', exact: true }).check()
    await expect(dlg.getByRole('button', { name: 'Create' })).toBeEnabled()
    await dlg.getByRole('button', { name: 'Check none' }).click()
    await expect(dlg.getByRole('button', { name: 'Create' })).toBeDisabled()
  })

  test('F05-S1 a snapshot remembers the look and clicking it brings it back', async ({ page }) => {
    await openDevelop(page)
    await setSlider(page, 'Contrast', '35')
    await snapshots(page).getByRole('button', { name: 'New snapshot' }).click()
    await page.getByRole('textbox', { name: 'Snapshot name' }).fill('Nice and flat')
    await page.getByRole('textbox', { name: 'Snapshot name' }).press('Enter')
    await expect(snapshots(page).getByRole('button', { name: 'Nice and flat', exact: true })).toBeVisible()
    await setSlider(page, 'Contrast', '-20')
    await snapshots(page).getByRole('button', { name: 'Nice and flat', exact: true }).click()
    await expect(slider(page, 'Contrast')).toHaveValue('35')
    await expect(historyList(page).getByRole('button', { name: /Snapshot: Nice and flat/ })).toBeVisible()
  })

  test('F05-S2 snapshots belong to one photo and can be deleted', async ({ page }) => {
    await openDevelop(page)
    await snapshots(page).getByRole('button', { name: 'New snapshot' }).click()
    await page.getByRole('textbox', { name: 'Snapshot name' }).fill('Only here')
    await page.getByRole('textbox', { name: 'Snapshot name' }).press('Enter')
    await expect(snapshots(page).getByRole('button', { name: 'Only here', exact: true })).toBeVisible()
    await page.keyboard.press('ArrowRight')
    await expect(snapshots(page).getByRole('button', { name: 'Only here', exact: true })).toHaveCount(0)
    await page.keyboard.press('ArrowLeft')
    await expect(snapshots(page).getByRole('button', { name: 'Only here', exact: true })).toBeVisible()
    await snapshots(page).getByRole('button', { name: 'Delete snapshot Only here' }).click()
    await expect(snapshots(page).getByRole('button', { name: 'Only here', exact: true })).toHaveCount(0)
  })

  test('F05-S3 an empty snapshot name cannot be created', async ({ page }) => {
    await openDevelop(page)
    await snapshots(page).getByRole('button', { name: 'New snapshot' }).click()
    await expect(page.getByRole('button', { name: 'Create', exact: true })).toBeDisabled()
  })

  test('F05-C1 copy settings: choose groups in the dialog, and paste puts only those on the next photo', async ({ page }) => {
    await openDevelop(page)
    await setSlider(page, 'Tint', '25')
    await setSlider(page, 'Contrast', '40')
    await page.getByRole('button', { name: 'Copy settings…' }).click()
    const dlg = page.getByRole('dialog', { name: 'Copy settings' })
    await expect(dlg.getByRole('checkbox', { name: 'Crop and straighten' })).not.toBeChecked()
    await dlg.getByRole('button', { name: 'Check none' }).click()
    await expect(dlg.getByRole('button', { name: 'Copy', exact: true })).toBeDisabled()
    await dlg.getByRole('checkbox', { name: 'White balance' }).check()
    await dlg.getByRole('button', { name: 'Copy', exact: true }).click()
    await page.keyboard.press('ArrowRight')
    await page.getByRole('button', { name: 'Paste settings' }).click()
    await expect(slider(page, 'Tint')).toHaveValue('25')
    await expect(slider(page, 'Contrast')).toHaveValue('0')
  })

  test('F05-A2 no accessibility violations with the panels and both dialogs', async ({ page }) => {
    await openDevelop(page)
    await setSlider(page, 'Exposure', '0.5')
    let r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
    await presets(page).getByRole('button', { name: 'New preset' }).click()
    r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
    await page.getByRole('dialog').getByRole('button', { name: 'Cancel' }).click()
    await page.getByRole('button', { name: 'Copy settings…' }).click()
    r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
  })
})

test.describe('F05 develop: effects and auto', () => {
  const effects = (page: Page) => page.locator('section.panel', { hasText: 'Vignette' })
  const field = async (page: Page, name: string, value: string) => {
    const box = effects(page).getByRole('textbox', { name: `${name} value` }).first()
    await box.fill(value)
    await box.press('Enter')
  }
  const basic = (page: Page) => page.locator('section.panel', { has: page.getByRole('button', { name: 'Auto tone' }) })

  test('F05-X1 the effects panel has vignette and grain sliders with the right ranges and starting points', async ({ page }) => {
    await openDevelop(page)
    const s = (name: string, n = 0) => effects(page).getByRole('slider', { name, exact: true }).nth(n)
    await expect(s('Amount', 0)).toHaveAttribute('min', '-100') // vignette amount
    await expect(s('Midpoint')).toHaveValue('50')
    await expect(s('Feather')).toHaveValue('50')
    await expect(s('Roundness')).toHaveValue('50')
    await expect(s('Amount', 1)).toHaveAttribute('min', '0') // grain amount
    await expect(s('Size')).toHaveValue('25')
    await expect(s('Roughness')).toHaveValue('50')
  })

  test('F05-X2 an effects slider is saved with its own history name and survives leaving Develop', async ({ page }) => {
    await openDevelop(page)
    await field(page, 'Amount', '-40')
    await expect(page.getByRole('list', { name: /Edit history/ }).getByRole('button', { name: /Vignette amount/ })).toBeVisible()
    await page.getByRole('tab', { name: 'Library' }).click()
    await page.getByRole('tab', { name: 'Develop' }).click()
    await expect(effects(page).getByRole('slider', { name: 'Amount', exact: true }).first()).toHaveValue('-40')
  })

  test('F05-X3 double-clicking a label puts a slider back at its own starting value, and Reset clears the panel', async ({ page }) => {
    await openDevelop(page)
    await field(page, 'Midpoint', '80')
    await field(page, 'Size', '70')
    await effects(page).locator('label', { hasText: 'Midpoint' }).dblclick()
    await expect(effects(page).getByRole('slider', { name: 'Midpoint', exact: true })).toHaveValue('50')
    await effects(page).getByRole('button', { name: 'Reset', exact: true }).click()
    await expect(effects(page).getByRole('slider', { name: 'Size', exact: true })).toHaveValue('25')
  })

  test('F05-X4 Auto tone sets the tone and presence sliders as one history step and leaves the white balance', async ({ page }) => {
    await openDevelop(page)
    await setSlider(page, 'Saturation', '20')
    await basic(page).getByRole('button', { name: 'Auto tone' }).click()
    await expect(slider(page, 'Exposure')).not.toHaveValue('0')
    await expect(slider(page, 'Shadows')).not.toHaveValue('0')
    await expect(slider(page, 'Saturation')).toHaveValue('4') // Auto tone sets Vibrance and Saturation too, so the picture is not left flat
    await expect(slider(page, 'Temperature')).toHaveValue('0')
    await expect(page.getByRole('list', { name: /Edit history/ }).getByRole('button', { name: /Auto tone/ })).toBeVisible()
  })

  test('F05-X5 Auto WB sets temperature and tint only', async ({ page }) => {
    await openDevelop(page)
    await setSlider(page, 'Exposure', '0.5')
    await basic(page).getByRole('button', { name: 'Auto WB' }).click()
    await expect(slider(page, 'Temperature')).not.toHaveValue('0')
    await expect(slider(page, 'Exposure')).toHaveValue('0.5')
    await expect(page.getByRole('list', { name: /Edit history/ }).getByRole('button', { name: /Auto white balance/ })).toBeVisible()
  })

  test('F05-X6 the Old print preset carries effects, and no accessibility violations with effects in use', async ({ page }) => {
    await openDevelop(page)
    await page.locator('section.panel', { hasText: 'Presets' }).first().getByRole('button', { name: 'Old print' }).click()
    await expect(effects(page).getByRole('slider', { name: 'Amount', exact: true }).first()).not.toHaveValue('0')
    const r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
  })
})

test.describe('F06 masks', () => {
  const panel = (page: Page) => page.locator('section.panel', { has: page.getByRole('group', { name: 'Add a mask' }) })
  const list = (page: Page) => panel(page).getByRole('list', { name: 'Masks' })
  const layer = (page: Page) => page.locator('svg.mask-layer')
  const history = (page: Page) => page.getByRole('list', { name: /Edit history/ })
  const add = async (page: Page, name: '+ Linear' | '+ Radial' | '+ Brush' | '+ Luminance' | '+ Colour') => panel(page).getByRole('button', { name, exact: true }).click()
  const adjust = async (page: Page, name: string, value: string) => {
    const box = panel(page).getByRole('textbox', { name: `${name} value` })
    await box.fill(value)
    await box.press('Enter')
  }

  test('F06-M1 adding a linear gradient selects it, shows handles on the picture and records history', async ({ page }) => {
    await openDevelop(page)
    await expect(panel(page).getByText('Add one to begin')).toBeVisible()
    await add(page, '+ Linear')
    await expect(list(page).getByRole('button', { name: /^Linear gradient 1/ })).toBeVisible()
    await expect(layer(page)).toBeVisible()
    await expect(page.getByRole('button', { name: /Gradient start/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Gradient end/ })).toBeVisible()
    await expect(history(page).getByRole('button', { name: /Add linear gradient/ })).toBeVisible()
  })

  test('F06-M2 dragging a gradient handle moves it and saves one history step', async ({ page }) => {
    await openDevelop(page)
    await add(page, '+ Linear')
    const start = page.getByRole('button', { name: /Gradient start/ })
    const before = (await start.boundingBox())!
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
    await page.mouse.down()
    await page.mouse.move(before.x + 80, before.y + 60, { steps: 6 })
    await page.mouse.up()
    const after = (await start.boundingBox())!
    expect(after.x).toBeGreaterThan(before.x + 50)
    expect(after.y).toBeGreaterThan(before.y + 30)
    await expect(history(page).getByRole('button', { name: /Linear gradient 1: move/ })).toBeVisible()
    await expect(page.locator('img.zoom-img')).toHaveCount(0) // a drag on a handle is not a click on the picture
  })

  test('F06-M3 handles can be moved with the arrow keys', async ({ page }) => {
    await openDevelop(page)
    await add(page, '+ Radial')
    const centre = page.getByRole('button', { name: 'Radial centre' })
    const photo = await picture(page).getAttribute('alt')
    const before = (await centre.boundingBox())!
    await centre.focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Shift+ArrowDown')
    const after = (await centre.boundingBox())!
    expect(await picture(page).getAttribute('alt')).toBe(photo) // the arrow keys moved the handle, not the filmstrip
    expect(after.x).toBeGreaterThan(before.x + 2)
    expect(after.y).toBeGreaterThan(before.y + 10)
  })

  test('F06-M4 a mask adjustment is saved with the mask name, and survives leaving Develop', async ({ page }) => {
    await openDevelop(page)
    await add(page, '+ Radial')
    await adjust(page, 'Exposure', '0.8')
    await expect(history(page).getByRole('button', { name: /Radial gradient 1: Exposure/ })).toBeVisible()
    await page.getByRole('tab', { name: 'Library' }).click()
    await page.getByRole('tab', { name: 'Develop' }).click()
    await list(page).getByRole('button', { name: /^Radial gradient 1/ }).click()
    await expect(panel(page).getByRole('slider', { name: 'Exposure', exact: true })).toHaveValue('0.8')
  })

  test('F06-M5 painting with the brush adds a stroke, and Clear strokes removes it', async ({ page }) => {
    await openDevelop(page)
    await add(page, '+ Brush')
    await expect(panel(page).getByText('Nothing is painted yet')).toBeVisible()
    const b = (await layer(page).boundingBox())!
    await page.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.4)
    await page.mouse.down()
    await page.mouse.move(b.x + b.width * 0.6, b.y + b.height * 0.5, { steps: 8 })
    await page.mouse.up()
    await expect(panel(page).getByText('1 stroke.')).toBeVisible()
    await expect(history(page).getByRole('button', { name: /Brush 1: brush stroke/ })).toBeVisible()
    await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.3)
    await page.mouse.down()
    await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.7, { steps: 5 })
    await page.mouse.up()
    await expect(panel(page).getByText('2 strokes.')).toBeVisible()
    await panel(page).getByRole('button', { name: 'Clear strokes' }).click()
    await expect(panel(page).getByText('Nothing is painted yet')).toBeVisible()
  })

  test('F06-M5b while a stroke is drawn it shows at once as a trail and the picture is rendered small; both go when the button is released', async ({ page }) => {
    await openDevelop(page)
    await add(page, '+ Brush')
    const b = (await layer(page).boundingBox())!
    const src = () => picture(page).getAttribute('src')
    expect(await src()).not.toContain('edge640')
    await page.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.4)
    await page.mouse.down()
    await expect(page.locator('polyline.mask-trail')).toHaveCount(1) // the stroke shows at once, before any render (a dot has no outline, so it is counted, not 'visible')
    await page.mouse.move(b.x + b.width * 0.6, b.y + b.height * 0.5, { steps: 8 })
    await expect(async () => expect(await src()).toContain('edge640')).toPass() // a small picture while painting
    const points = (await page.locator('polyline.mask-trail').getAttribute('points'))!.split(' ').length
    expect(points).toBeGreaterThan(3)
    await page.mouse.up()
    await expect(page.locator('polyline.mask-trail')).toHaveCount(0)
    await expect(async () => expect(await src()).not.toContain('edge640')).toPass() // and the proper picture again
  })

  test('F06-M5c erasing shows a dark trail', async ({ page }) => {
    await openDevelop(page)
    await add(page, '+ Brush')
    await panel(page).getByRole('button', { name: 'Erase', exact: true }).click()
    const b = (await layer(page).boundingBox())!
    await page.mouse.move(b.x + b.width * 0.3, b.y + b.height * 0.4)
    await page.mouse.down()
    await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.4, { steps: 4 })
    await expect(page.locator('polyline.mask-trail.erase')).toHaveCount(1)
    await page.mouse.up()
  })

  test('F06-M6 hide, invert and delete a mask', async ({ page }) => {
    await openDevelop(page)
    await add(page, '+ Linear')
    await panel(page).getByRole('button', { name: 'Invert' }).click()
    await expect(panel(page).getByRole('button', { name: 'Invert' })).toHaveAttribute('aria-pressed', 'true')
    await expect(history(page).getByRole('button', { name: /Linear gradient 1: invert/ })).toBeVisible()
    await panel(page).getByRole('button', { name: 'Hide Linear gradient 1' }).click()
    await expect(panel(page).getByRole('button', { name: 'Show Linear gradient 1' })).toHaveAttribute('aria-pressed', 'false')
    await panel(page).getByRole('button', { name: 'Delete Linear gradient 1' }).click()
    await expect(list(page)).toHaveCount(0)
    await expect(layer(page)).toHaveCount(0)
  })

  test('F06-M7 several masks can be listed and switched between, and a rename is kept', async ({ page }) => {
    await openDevelop(page)
    await add(page, '+ Linear')
    await add(page, '+ Radial')
    await expect(list(page).getByRole('listitem')).toHaveCount(2)
    await list(page).getByRole('button', { name: /^Linear gradient 1/ }).click()
    await expect(page.getByRole('button', { name: /Gradient start/ })).toBeVisible()
    await panel(page).getByLabel('Name').fill('Sky')
    await panel(page).getByLabel('Name').press('Enter')
    await expect(list(page).getByRole('button', { name: /^Sky/ })).toBeVisible()
    await list(page).getByRole('button', { name: /^Radial gradient 1/ }).click()
    await expect(page.getByRole('button', { name: 'Radial centre' })).toBeVisible()
  })

  test('F06-M8 at 100% the handles are hidden and the panel says why', async ({ page }) => {
    await openDevelop(page)
    await add(page, '+ Linear')
    await page.keyboard.press('z')
    await expect(page.locator('img.zoom-img')).toBeVisible()
    await expect(layer(page)).toHaveCount(0)
    await expect(panel(page).getByText('Masks are edited with the whole picture in view')).toBeVisible()
  })

  test('F06-M9 the edge cases: out-of-range values are clamped and a sixteenth mask is refused', async ({ page }) => {
    await openDevelop(page)
    await add(page, '+ Linear')
    await adjust(page, 'Exposure', '99')
    await expect(panel(page).getByRole('slider', { name: 'Exposure', exact: true })).toHaveValue('5')
    for (let i = 0; i < 9; i++) await add(page, '+ Linear')
    await expect(list(page).getByRole('listitem')).toHaveCount(10)
    await expect(panel(page).getByRole('button', { name: '+ Linear' })).toBeDisabled()
    await expect(panel(page).getByRole('button', { name: '+ Radial' })).toBeDisabled()
  })

  test('F06-M10 no accessibility violations with a mask, its handles and its sliders', async ({ page }) => {
    await openDevelop(page)
    await add(page, '+ Radial')
    await adjust(page, 'Exposure', '0.5')
    const r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
  })
})

test.describe('F07 spot removal', () => {
  const panel = (page: Page) => page.locator('section.panel', { has: page.getByRole('button', { name: 'Spot removal tool' }) })
  const tool = (page: Page) => panel(page).getByRole('button', { name: 'Spot removal tool' })
  const list = (page: Page) => panel(page).getByRole('list', { name: 'Spots' })
  const history = (page: Page) => page.getByRole('list', { name: /Edit history/ })
  const layer = (page: Page) => page.locator('svg.spot-layer')
  const pictureBox = async (page: Page) => (await page.locator('svg.spot-layer').boundingBox())!
  const clickPicture = async (page: Page, fx: number, fy: number) => {
    const b = await pictureBox(page)
    await page.mouse.click(b.x + b.width * fx, b.y + b.height * fy)
  }
  const dot = (page: Page, what: RegExp) => page.getByRole('button', { name: what })

  test('F07-S1 with the tool on, a click on the picture adds a spot, selects it and records history', async ({ page }) => {
    await openRetouch(page)
    await expect(panel(page).getByText('No spots yet')).toBeVisible()
    await tool(page).click()
    await expect(tool(page)).toHaveAttribute('aria-pressed', 'true')
    await clickPicture(page, 0.3, 0.5)
    await expect(list(page).getByRole('listitem')).toHaveCount(1)
    await expect(list(page).getByRole('button', { name: /^Spot 1/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(dot(page, /Spot 1: the spot to remove/)).toBeVisible()
    await expect(dot(page, /Spot 1: where it is copied from/)).toBeVisible()
    await expect(history(page).getByRole('button', { name: /Add heal spot/ })).toBeVisible()
    await expect(page.locator('img.zoom-img')).toHaveCount(0) // a click with the tool on does not zoom
  })

  test('F07-S2 dragging the spot moves both circles, dragging the source moves only the source', async ({ page }) => {
    await openRetouch(page)
    await tool(page).click()
    await clickPicture(page, 0.3, 0.5)
    const target = dot(page, /the spot to remove/)
    const source = dot(page, /where it is copied from/)
    const [t0, s0] = [(await target.boundingBox())!, (await source.boundingBox())!]
    await page.mouse.move(t0.x + t0.width / 2, t0.y + t0.height / 2)
    await page.mouse.down()
    await page.mouse.move(t0.x + 60, t0.y + 40, { steps: 6 })
    await page.mouse.up()
    const [t1, s1] = [(await target.boundingBox())!, (await source.boundingBox())!]
    expect(t1.x).toBeGreaterThan(t0.x + 40)
    expect(s1.x - s0.x).toBeCloseTo(t1.x - t0.x, 0) // the source went with it
    await page.mouse.move(s1.x + s1.width / 2, s1.y + s1.height / 2)
    await page.mouse.down()
    await page.mouse.move(s1.x + 80, s1.y + 70, { steps: 6 })
    await page.mouse.up()
    const [t2, s2] = [(await target.boundingBox())!, (await source.boundingBox())!]
    expect(Math.abs(t2.x - t1.x)).toBeLessThan(2)
    expect(s2.x).toBeGreaterThan(s1.x + 50)
    await expect(history(page).getByRole('button', { name: /Spot 1: move source/ })).toBeVisible()
  })

  test('F07-S3 the size handle resizes the circle, and the size slider follows', async ({ page }) => {
    await openRetouch(page)
    await tool(page).click()
    await clickPicture(page, 0.4, 0.5)
    const size = panel(page).getByRole('slider', { name: 'Size', exact: true })
    const before = Number(await size.inputValue())
    const handle = dot(page, /Spot 1: size/)
    const b = (await handle.boundingBox())!
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    await page.mouse.down()
    await page.mouse.move(b.x + 70, b.y + b.height / 2, { steps: 6 })
    await page.mouse.up()
    expect(Number(await size.inputValue())).toBeGreaterThan(before + 2)
    await expect(history(page).getByRole('button', { name: /Spot 1: resize/ })).toBeVisible()
  })

  test('F07-S4 heal or clone is chosen for the next spot, and changed on a selected one', async ({ page }) => {
    await openRetouch(page)
    await tool(page).click()
    await panel(page).getByRole('button', { name: 'Clone', exact: true }).click()
    await clickPicture(page, 0.3, 0.5)
    await expect(history(page).getByRole('button', { name: /Add clone spot/ })).toBeVisible()
    await expect(list(page).getByRole('button', { name: /^Spot 1/ })).toContainText('Clone')
    await panel(page).getByRole('button', { name: 'Heal', exact: true }).click()
    await expect(list(page).getByRole('button', { name: /^Spot 1/ })).toContainText('Heal')
    await expect(history(page).getByRole('button', { name: /Spot 1: heal/ })).toBeVisible()
  })

  test('F07-S5 the sliders change the selected spot and are saved with its name', async ({ page }) => {
    await openRetouch(page)
    await tool(page).click()
    await clickPicture(page, 0.3, 0.5)
    const box = panel(page).getByRole('textbox', { name: 'Opacity value' })
    await box.fill('40')
    await box.press('Enter')
    await expect(panel(page).getByRole('slider', { name: 'Opacity', exact: true })).toHaveValue('40')
    await expect(history(page).getByRole('button', { name: /Spot 1: opacity/ })).toBeVisible()
    await page.getByRole('tab', { name: 'Library' }).click()
    await page.getByRole('tab', { name: 'Retouch' }).click()
    await list(page).getByRole('button', { name: /^Spot 1/ }).click()
    await expect(panel(page).getByRole('slider', { name: 'Opacity', exact: true })).toHaveValue('40')
  })

  test('F07-S6 arrow keys and Delete work on a circle without stepping to another photo', async ({ page }) => {
    await openRetouch(page)
    await tool(page).click()
    await clickPicture(page, 0.3, 0.5)
    const name = async () => ((await picture(page).getAttribute('alt')) ?? '').split(',')[0] // the file name; ", edited" comes and goes
    const photo = await name()
    const target = dot(page, /the spot to remove/)
    const before = (await target.boundingBox())!
    await target.focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('Shift+ArrowDown')
    const after = (await target.boundingBox())!
    expect(after.x).toBeGreaterThan(before.x + 2)
    expect(after.y).toBeGreaterThan(before.y + 10)
    expect(await name()).toBe(photo)
    await page.keyboard.press('Delete')
    await expect(list(page)).toHaveCount(0)
    expect(await name()).toBe(photo)
  })

  test('F07-S7 hide, delete and delete all', async ({ page }) => {
    await openRetouch(page)
    await tool(page).click()
    await clickPicture(page, 0.25, 0.4)
    await clickPicture(page, 0.7, 0.6)
    await expect(list(page).getByRole('listitem')).toHaveCount(2)
    await panel(page).getByRole('button', { name: 'Hide spot 1' }).click()
    await expect(panel(page).getByRole('button', { name: 'Show spot 1' })).toHaveAttribute('aria-pressed', 'false')
    await panel(page).getByRole('button', { name: 'Delete spot 2' }).click()
    await expect(list(page).getByRole('listitem')).toHaveCount(1)
    await panel(page).getByRole('button', { name: 'Delete all spots' }).click()
    await expect(list(page)).toHaveCount(0)
    await expect(history(page).getByRole('button', { name: /Delete all spots/ })).toBeVisible()
  })

  test('F07-S8 the tool and masks take turns, and at 100% the circles are hidden with a hint', async ({ page }) => {
    await openRetouch(page)
    await panel(page).getByRole('button', { name: 'Spot removal tool' }).click()
    await expect(layer(page)).toBeVisible()
    // the masks are in Develop: going there switches the spot tool off
    await page.getByRole('tab', { name: 'Develop' }).click()
    await page.getByRole('button', { name: '+ Radial', exact: true }).click()
    await page.getByRole('tab', { name: 'Retouch' }).click()
    await expect(tool(page)).toHaveAttribute('aria-pressed', 'false')
    await expect(layer(page)).toHaveCount(0)
    await tool(page).click()
    await clickPicture(page, 0.4, 0.4)
    await page.keyboard.press('z')
    await expect(page.locator('img.zoom-img')).toBeVisible()
    await expect(layer(page)).toHaveCount(0)
    await expect(panel(page).getByText('Spots are edited with the whole picture in view')).toBeVisible()
  })

  test('F07-FL1 Fill removes a bigger thing: the spot has no source circle, is named Fill, and is one history step', async ({ page }) => {
    await openRetouch(page)
    await panel(page).getByRole('group', { name: 'Spot mode' }).getByRole('button', { name: 'Fill', exact: true }).click()
    await expect(panel(page).getByText(/Fill removes something bigger/)).toBeVisible()
    await tool(page).click()
    await clickPicture(page, 0.4, 0.5)
    await expect(list(page).getByRole('listitem')).toHaveCount(1)
    await expect(list(page).getByRole('button', { name: /^Spot 1/ })).toContainText('Fill')
    await expect(dot(page, /Spot 1: the spot to remove/)).toBeVisible()
    await expect(dot(page, /Spot 1: where it is copied from/)).toHaveCount(0)
    await expect(history(page).getByRole('button', { name: /Add fill spot/ })).toHaveCount(1)
  })

  test('F07-FL2 a heal spot can be changed to Fill and back, and a Fill spot is kept with the photo', async ({ page }) => {
    await openRetouch(page)
    await tool(page).click()
    await clickPicture(page, 0.4, 0.5)
    await expect(dot(page, /Spot 1: where it is copied from/)).toBeVisible()
    await panel(page).getByRole('group', { name: 'Spot mode' }).getByRole('button', { name: 'Fill', exact: true }).click()
    await expect(dot(page, /Spot 1: where it is copied from/)).toHaveCount(0)
    await expect(history(page).getByRole('button', { name: /Spot 1: fill/ })).toHaveCount(1)
    await page.getByRole('tab', { name: 'Library' }).click()
    await page.getByRole('tab', { name: 'Retouch' }).click()
    await expect(list(page).getByRole('button', { name: /^Spot 1/ })).toContainText('Fill')
    await list(page).getByRole('button', { name: /^Spot 1/ }).click()
    await panel(page).getByRole('group', { name: 'Spot mode' }).getByRole('button', { name: 'Heal', exact: true }).click()
    await expect(dot(page, /Spot 1: where it is copied from/)).toBeVisible()
  })

  test('F07-FL3 no accessibility violations with a Fill spot selected', async ({ page }) => {
    await openRetouch(page)
    await panel(page).getByRole('group', { name: 'Spot mode' }).getByRole('button', { name: 'Fill', exact: true }).click()
    await tool(page).click()
    await clickPicture(page, 0.3, 0.5)
    await expect(list(page).getByRole('listitem')).toHaveCount(1)
    const r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
  })

  test('F07-S9 a spot at the very edge of the picture can be placed', async ({ page }) => {
    await openRetouch(page)
    await tool(page).click()
    await clickPicture(page, 0.995, 0.01)
    await expect(list(page).getByRole('listitem')).toHaveCount(1)
  })

  test('F07-S10 no accessibility violations with spots and the tool', async ({ page }) => {
    await openRetouch(page)
    await tool(page).click()
    await clickPicture(page, 0.3, 0.5)
    const r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
  })
})

test.describe('F06 masks: ranges and combining', () => {
  const panel = (page: Page) => page.locator('section.panel', { has: page.getByRole('group', { name: 'Add a mask' }) })
  const add = async (page: Page, name: '+ Linear' | '+ Radial' | '+ Brush' | '+ Luminance' | '+ Colour') => panel(page).getByRole('button', { name, exact: true }).click()
  const combine = (page: Page, name: 'Linear' | 'Radial' | 'Brush' | 'Luminance' | 'Colour') => panel(page).getByRole('group', { name: 'Combine with another shape' }).getByRole('button', { name, exact: true })
  const shapes = (page: Page) => panel(page).getByRole('list', { name: 'Shapes of this mask' })
  const history = (page: Page) => page.getByRole('list', { name: /Edit history/ })
  const slider = (page: Page, name: string) => panel(page).getByRole('slider', { name, exact: true })
  const layer = (page: Page) => page.locator('svg.mask-layer')

  test('F06-R1 a luminance range is a mask of its own: sliders, no handles on the picture', async ({ page }) => {
    await openDevelop(page)
    await add(page, '+ Luminance')
    await expect(panel(page).getByRole('list', { name: 'Masks' }).getByRole('button', { name: /^Luminance range 1/ })).toBeVisible()
    await expect(slider(page, 'Darkest')).toHaveValue('60')
    await expect(slider(page, 'Brightest')).toHaveValue('100')
    await expect(slider(page, 'Smoothness')).toHaveValue('30')
    await expect(layer(page)).toHaveCount(0) // a range has nothing to place on the picture
    await expect(history(page).getByRole('button', { name: /Add luminance range/ })).toBeVisible()
  })

  test('F06-R2 the two ends of a luminance range push each other, and changes are saved by name', async ({ page }) => {
    await openDevelop(page)
    await add(page, '+ Luminance')
    const box = panel(page).getByRole('textbox', { name: 'Darkest value' })
    await box.fill('90')
    await box.press('Enter')
    await expect(slider(page, 'Darkest')).toHaveValue('90')
    await expect(slider(page, 'Brightest')).toHaveValue('100')
    const hi = panel(page).getByRole('textbox', { name: 'Brightest value' })
    await hi.fill('40')
    await hi.press('Enter')
    await expect(slider(page, 'Brightest')).toHaveValue('40')
    await expect(slider(page, 'Darkest')).toHaveValue('40') // the low end cannot be above the high end
    await expect(history(page).getByRole('button', { name: /Luminance range 1: brightest/ })).toBeVisible()
  })

  test('F06-R3 combining another shape: it joins the list, can be set to subtract, and can be removed', async ({ page }) => {
    await openDevelop(page)
    await add(page, '+ Radial')
    await expect(shapes(page).getByRole('listitem')).toHaveCount(1)
    await combine(page, 'Luminance').click()
    await expect(shapes(page).getByRole('listitem')).toHaveCount(2)
    await expect(panel(page).getByLabel('How shape 2 combines')).toHaveValue('intersect') // a range narrows what is there
    await expect(history(page).getByRole('button', { name: /Radial gradient 1: intersect luminance range/ })).toBeVisible()
    await panel(page).getByLabel('How shape 2 combines').selectOption('subtract')
    await expect(history(page).getByRole('button', { name: /Radial gradient 1: subtract luminance range/ })).toBeVisible()
    await expect(panel(page).getByRole('list', { name: 'Masks' }).getByRole('button', { name: /^Radial gradient 1/ })).toContainText('+1')
    await panel(page).getByRole('button', { name: 'Remove shape 2' }).click()
    await expect(shapes(page).getByRole('listitem')).toHaveCount(1)
    await expect(history(page).getByRole('button', { name: /Radial gradient 1: remove luminance range/ })).toBeVisible()
  })

  test('F06-R4 a shape that has handles shows them for the selected shape only, and a range shows none', async ({ page }) => {
    await openDevelop(page)
    await add(page, '+ Radial')
    await expect(page.getByRole('button', { name: 'Radial centre' })).toHaveCount(1)
    await combine(page, 'Linear').click() // selected at once
    await expect(page.getByRole('button', { name: /Gradient start/ })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Radial centre' })).toHaveCount(0)
    await combine(page, 'Luminance').click()
    await expect(layer(page)).toHaveCount(0)
    await shapes(page).getByRole('button', { name: /^Base/ }).click()
    await expect(page.getByRole('button', { name: 'Radial centre' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Gradient start/ })).toHaveCount(0)
  })

  test('F06-R5 the handles of a combined shape move that shape, not the first', async ({ page }) => {
    await openDevelop(page)
    await add(page, '+ Radial')
    await combine(page, 'Linear').click()
    const start = page.getByRole('button', { name: /Gradient start/ })
    const before = (await start.boundingBox())!
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
    await page.mouse.down()
    await page.mouse.move(before.x + 90, before.y + 50, { steps: 6 })
    await page.mouse.up()
    expect((await start.boundingBox())!.x).toBeGreaterThan(before.x + 60)
    await shapes(page).getByRole('button', { name: /^Base/ }).click()
    const centre = page.getByRole('button', { name: 'Radial centre' })
    const c = (await centre.boundingBox())!
    // the radial is where it was made: the middle of the picture
    const layerBox = (await layer(page).boundingBox())!
    expect(Math.abs(c.x + c.width / 2 - (layerBox.x + layerBox.width / 2))).toBeLessThan(3)
  })

  test('F06-R6 picking a colour from the picture sets the hue of a colour range', async ({ page }) => {
    await openDevelop(page)
    await add(page, '+ Colour')
    await expect(slider(page, 'Hue')).toHaveValue('0')
    await panel(page).getByRole('button', { name: 'Pick colour from the picture' }).click()
    await expect(panel(page).getByText('Click a colour on the picture')).toBeVisible()
    const stage = (await page.locator('.stage').boundingBox())!
    await page.mouse.click(stage.x + stage.width * 0.5, stage.y + stage.height * 0.5)
    await expect(panel(page).getByText('Click a colour on the picture')).toHaveCount(0)
    await expect(slider(page, 'Hue')).not.toHaveValue('0')
    await expect(history(page).getByRole('button', { name: /Colour range 1: pick colour/ })).toBeVisible()
    await expect(page.locator('img.zoom-img')).toHaveCount(0) // picking is not a click-to-zoom
  })

  test('F06-R7 a mask can combine six more shapes and no more; the combined shapes are kept when leaving Develop', async ({ page }) => {
    await openDevelop(page)
    await add(page, '+ Radial')
    for (let i = 0; i < 6; i++) await combine(page, 'Linear').click()
    await expect(shapes(page).getByRole('listitem')).toHaveCount(7)
    await expect(combine(page, 'Brush')).toBeDisabled()
    await page.getByRole('tab', { name: 'Library' }).click()
    await page.getByRole('tab', { name: 'Develop' }).click()
    await panel(page).getByRole('list', { name: 'Masks' }).getByRole('button', { name: /^Radial gradient 1/ }).click()
    await expect(shapes(page).getByRole('listitem')).toHaveCount(7)
  })

  test('F06-R8 no accessibility violations with a range, a combined shape and the list', async ({ page }) => {
    await openDevelop(page)
    await add(page, '+ Radial')
    await combine(page, 'Colour').click()
    const r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
  })
})

test.describe('F05 develop: lens corrections and transform', () => {
  const lens = (page: Page) => page.locator('section.panel', { has: page.getByText('Set by eye: there is no lens database') })
  const transform = (page: Page) => page.locator('section.panel', { has: page.getByRole('button', { name: 'Constrain to picture' }) })
  const field = async (box: ReturnType<typeof lens>, page: Page, name: string, value: string) => {
    const input = box.getByRole('textbox', { name: `${name} value` })
    await input.fill(value)
    await input.press('Enter')
  }
  const history = (page: Page) => page.getByRole('list', { name: /Edit history/ })

  test('F05-G1 the lens and transform panels offer their sliders with the right ranges', async ({ page }) => {
    await openDevelop(page)
    await expect(lens(page).getByRole('slider', { name: 'Distortion', exact: true })).toHaveAttribute('min', '-100')
    await expect(lens(page).getByRole('slider', { name: 'Red/cyan fringe', exact: true })).toBeVisible()
    await expect(lens(page).getByRole('slider', { name: 'Blue/yellow fringe', exact: true })).toBeVisible()
    for (const n of ['Vertical', 'Horizontal', 'Aspect', 'X offset', 'Y offset']) await expect(transform(page).getByRole('slider', { name: n, exact: true })).toBeVisible()
    await expect(transform(page).getByRole('slider', { name: 'Rotate', exact: true })).toHaveAttribute('max', '10')
    await expect(transform(page).getByRole('slider', { name: 'Scale', exact: true })).toHaveValue('100')
    await expect(transform(page).getByRole('button', { name: 'Constrain to picture' })).toHaveAttribute('aria-pressed', 'true')
  })

  test('F05-G2 a transform slider is saved with its panel name, survives leaving Develop, and marks the photo edited', async ({ page }) => {
    await openDevelop(page)
    await field(transform(page), page, 'Vertical', '30')
    await expect(history(page).getByRole('button', { name: /Transform: Vertical/ })).toBeVisible()
    await field(lens(page), page, 'Distortion', '-20')
    await expect(history(page).getByRole('button', { name: /Lens: Distortion/ })).toBeVisible()
    await page.getByRole('tab', { name: 'Library' }).click()
    await expect(page.locator('.cell-meta .flag.edit')).toHaveCount(1)
    await page.getByRole('tab', { name: 'Develop' }).click()
    await expect(transform(page).getByRole('slider', { name: 'Vertical', exact: true })).toHaveValue('30')
    await expect(lens(page).getByRole('slider', { name: 'Distortion', exact: true })).toHaveValue('-20')
  })

  test('F05-G3 scale goes back to 100 (not 0) on a double-click, and each panel resets on its own', async ({ page }) => {
    await openDevelop(page)
    await field(transform(page), page, 'Scale', '140')
    await field(transform(page), page, 'Rotate', '2.5')
    await field(lens(page), page, 'Distortion', '40')
    await transform(page).locator('label', { hasText: 'Scale' }).dblclick()
    await expect(transform(page).getByRole('slider', { name: 'Scale', exact: true })).toHaveValue('100')
    await transform(page).getByRole('button', { name: 'Reset', exact: true }).click()
    await expect(transform(page).getByRole('slider', { name: 'Rotate', exact: true })).toHaveValue('0')
    await expect(lens(page).getByRole('slider', { name: 'Distortion', exact: true })).toHaveValue('40') // the transform reset leaves the lens alone
    await lens(page).getByRole('button', { name: 'Reset', exact: true }).click()
    await expect(lens(page).getByRole('slider', { name: 'Distortion', exact: true })).toHaveValue('0')
  })

  test('F05-G4 Constrain can be turned off and on, and each is a history step', async ({ page }) => {
    await openDevelop(page)
    const c = transform(page).getByRole('button', { name: 'Constrain to picture' })
    await c.click()
    await expect(c).toHaveAttribute('aria-pressed', 'false')
    await expect(history(page).getByRole('button', { name: /Constrain off/ })).toBeVisible()
    await c.click()
    await expect(c).toHaveAttribute('aria-pressed', 'true')
    await expect(history(page).getByRole('button', { name: /Constrain on/ })).toBeVisible()
  })

  test('F05-G5 values out of range are clamped', async ({ page }) => {
    await openDevelop(page)
    await field(transform(page), page, 'Rotate', '45')
    await expect(transform(page).getByRole('slider', { name: 'Rotate', exact: true })).toHaveValue('10')
    await field(transform(page), page, 'Scale', '5')
    await expect(transform(page).getByRole('slider', { name: 'Scale', exact: true })).toHaveValue('50')
  })

  test('F05-G6 changing the transform at 100% goes back to the fitted view', async ({ page }) => {
    await openDevelop(page)
    await page.keyboard.press('z')
    await expect(page.locator('img.zoom-img')).toBeVisible()
    await field(transform(page), page, 'Vertical', '20')
    await expect(page.locator('img.zoom-img')).toHaveCount(0)
  })

  test('F05-G7 lens and transform are in the copy dialog but not ticked by default', async ({ page }) => {
    await openDevelop(page)
    await field(transform(page), page, 'Vertical', '20')
    await page.getByRole('button', { name: 'Copy settings…' }).click()
    const dlg = page.getByRole('dialog', { name: 'Copy settings' })
    await expect(dlg.getByRole('checkbox', { name: 'Lens and transform' })).not.toBeChecked()
    await expect(dlg.getByRole('checkbox', { name: 'Tone', exact: true })).toBeChecked()
  })

  test('F05-G8 no accessibility violations with the lens and transform panels in use', async ({ page }) => {
    await openDevelop(page)
    await field(transform(page), page, 'Vertical', '20')
    await field(lens(page), page, 'Distortion', '10')
    const r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`)).toEqual([])
  })
})

test.describe('F05 develop: fine-tune arrows', () => {
  test('F05-J1 arrows are off until switched on, step one value (Shift ten), stop at the ends, and are remembered', async ({ page }) => {
    await openDevelop(page)
    await expect(page.getByRole('button', { name: 'Increase Exposure' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Fine-tune arrows' }).click()
    const up = page.getByRole('button', { name: 'Increase Exposure' })
    const down = page.getByRole('button', { name: 'Decrease Exposure' })
    const box = page.getByRole('textbox', { name: 'Exposure value' })
    await up.click()
    await expect(box).toHaveValue('0.01')
    await up.click({ modifiers: ['Shift'] })
    await expect(box).toHaveValue('0.11')
    await down.click()
    await expect(box).toHaveValue('0.10')
    await expect(page.getByRole('list', { name: /Edit history/ }).getByRole('button', { name: /Exposure/ })).toHaveCount(1) // the clicks made one step
    await page.getByRole('slider', { name: 'Exposure', exact: true }).fill('5')
    await expect(up).toBeDisabled()
    await page.reload()
    await openDevelop(page)
    await expect(page.getByRole('button', { name: 'Fine-tune arrows' })).toHaveAttribute('aria-pressed', 'true')
  })
  test('F05-J2 no accessibility violations with the arrows on', async ({ page }) => {
    await openDevelop(page)
    await page.getByRole('button', { name: 'Fine-tune arrows' }).click()
    const r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
  })
})

test.describe('F05 develop: holding an arrow', () => {
  test('F05-K1 a short press is one step; holding for over a second keeps stepping until released, with no extra step on release', async ({ page }) => {
    await openDevelop(page)
    await page.getByRole('button', { name: 'Fine-tune arrows' }).click()
    const up = page.getByRole('button', { name: 'Increase Exposure' })
    const box = page.getByRole('textbox', { name: 'Exposure value' })
    await up.hover() // waits until the button has stopped moving
    await page.mouse.down()
    await page.waitForTimeout(600)
    await page.mouse.up()
    await expect(box).toHaveValue('0.01') // under a second: just the one step
    await page.mouse.down()
    await page.waitForTimeout(2000)
    const held = Number(await box.inputValue())
    await page.mouse.up()
    expect(held).toBeGreaterThan(0.06) // after the first second it stepped many times
    await page.waitForTimeout(200)
    const stopped = await box.inputValue()
    await page.waitForTimeout(500)
    await expect(box).toHaveValue(stopped)
  })
})

test.describe('F05 develop: the crop frame', () => {
  const panel = (page: Page) => page.locator('section.panel', { hasText: 'Crop and straighten' })
  const body = (page: Page) => page.locator('.crop-body')
  const history = (page: Page) => page.getByRole('list', { name: /Edit history/ })
  const box = async (page: Page) => (await body(page).boundingBox())!
  const frameTool = async (page: Page) => {
    await panel(page).getByRole('button', { name: 'Frame tool' }).click()
    await expect(body(page)).toBeVisible()
  }
  const drag = async (page: Page, from: { x: number; y: number }, dx: number, dy: number) => {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(from.x + dx / 2, from.y + dy / 2, { steps: 4 })
    await page.mouse.move(from.x + dx, from.y + dy, { steps: 4 })
    await page.mouse.up()
  }
  const handle = async (page: Page, name: string) => {
    const b = (await page.getByRole('button', { name, exact: true }).boundingBox())!
    return { x: b.x + b.width / 2, y: b.y + b.height / 2 }
  }

  test('F05-L1 the frame tool shows the frame with eight points and a grid; Done, C and Escape turn it off and on', async ({ page }) => {
    await openDevelop(page)
    await expect(body(page)).toHaveCount(0)
    await frameTool(page)
    await expect(page.locator('.crop-handle')).toHaveCount(8)
    await expect(page.locator('.crop-grid')).toHaveCount(2) // thirds: two lines each way
    await expect(panel(page).getByRole('button', { name: 'Done' })).toHaveAttribute('aria-pressed', 'true')
    await panel(page).getByRole('button', { name: 'Done' }).click()
    await expect(body(page)).toHaveCount(0)
    await page.keyboard.press('c')
    await expect(body(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(body(page)).toHaveCount(0)
  })

  test('F05-L2 a ratio gives a frame of that shape, which can be moved, and moving it again after leaving the tool keeps it', async ({ page }) => {
    await openDevelop(page)
    await frameTool(page)
    await panel(page).getByRole('group', { name: 'Aspect ratio' }).getByRole('button', { name: '1:1', exact: true }).click()
    const sq = await box(page)
    expect(Math.abs(sq.width - sq.height)).toBeLessThan(2)
    await expect(history(page).getByRole('button', { name: /Crop/ })).toBeVisible()
    await drag(page, { x: sq.x + sq.width / 2, y: sq.y + sq.height / 2 }, 60, 0)
    const moved = await box(page)
    expect(moved.x - sq.x).toBeGreaterThan(40)
    expect(Math.abs(moved.width - sq.width)).toBeLessThan(2)
    await expect(history(page).getByRole('button', { name: /Crop frame/ })).toBeVisible()
    // out of the tool and back: the frame is where it was left (this is how a crop is re-framed)
    await panel(page).getByRole('button', { name: 'Done' }).click()
    await frameTool(page)
    const again = await box(page)
    expect(Math.abs(again.x - moved.x)).toBeLessThan(2)
  })

  test('F05-L3 Free lets one edge move alone; a ratio keeps its shape when a corner is dragged', async ({ page }) => {
    await openDevelop(page)
    await frameTool(page)
    const aspects = panel(page).getByRole('group', { name: 'Aspect ratio' })
    await aspects.getByRole('button', { name: 'Free', exact: true }).click()
    const before = await box(page)
    await drag(page, await handle(page, 'Crop right edge'), -120, 0)
    const free = await box(page)
    expect(before.width - free.width).toBeGreaterThan(90)
    expect(Math.abs(free.height - before.height)).toBeLessThan(2)
    await aspects.getByRole('button', { name: '1:1', exact: true }).click()
    const locked = await box(page)
    expect(Math.abs(locked.width - locked.height)).toBeLessThan(2)
    await drag(page, await handle(page, 'Crop bottom right corner'), -80, -30)
    const smaller = await box(page)
    expect(smaller.width).toBeLessThan(locked.width - 20)
    expect(Math.abs(smaller.width - smaller.height)).toBeLessThan(2)
  })

  test('F05-L4 the grid can be thirds, fine or none, and is remembered', async ({ page }) => {
    await openDevelop(page)
    await frameTool(page)
    const grid = panel(page).getByRole('group', { name: 'Grid' })
    await grid.getByRole('button', { name: 'Fine' }).click()
    await expect(page.locator('.crop-grid')).toHaveCount(7)
    await grid.getByRole('button', { name: 'None' }).click()
    await expect(page.locator('.crop-grid')).toHaveCount(0)
    await page.reload()
    await openDevelop(page)
    await expect(panel(page).getByRole('group', { name: 'Grid' }).getByRole('button', { name: 'None' })).toHaveAttribute('aria-pressed', 'true')
  })

  test('F05-L5 the arrow keys nudge a point and become one history step', async ({ page }) => {
    await openDevelop(page)
    await frameTool(page)
    await panel(page).getByRole('group', { name: 'Aspect ratio' }).getByRole('button', { name: 'Free', exact: true }).click()
    const before = await box(page)
    const right = page.getByRole('button', { name: 'Crop right edge', exact: true })
    await right.focus()
    await page.keyboard.press('Shift+ArrowLeft')
    await page.keyboard.press('Shift+ArrowLeft')
    const after = await box(page)
    expect(before.width - after.width).toBeGreaterThan(30)
    await expect(history(page).getByRole('button', { name: /Crop frame/ })).toHaveCount(1)
  })

  test('F05-L6 straightening turns the frame over the picture, and the angle has fine-tune arrows', async ({ page }) => {
    await openDevelop(page)
    await frameTool(page)
    await setSlider(page, 'Angle', '5')
    await expect(page.locator('.crop-body').locator('xpath=..')).toHaveAttribute('transform', /rotate\(5\)/)
    await page.getByRole('button', { name: 'Fine-tune arrows' }).click()
    await page.getByRole('button', { name: 'Increase Angle' }).click()
    await expect(page.getByRole('textbox', { name: 'Angle value' })).toHaveValue('5.1')
  })

  test('F05-L7 Turn frame makes landscape portrait, and Reset crop puts everything back', async ({ page }) => {
    await openDevelop(page)
    await expect(panel(page).getByRole('button', { name: 'Reset crop' })).toBeDisabled()
    await frameTool(page)
    await panel(page).getByRole('group', { name: 'Aspect ratio' }).getByRole('button', { name: '3:2', exact: true }).click()
    const land = await box(page)
    expect(land.width).toBeGreaterThan(land.height)
    await panel(page).getByRole('button', { name: 'Turn frame' }).click()
    await expect(async () => {
      const b = await box(page)
      expect(b.height).toBeGreaterThan(b.width)
    }).toPass()
    await panel(page).getByRole('button', { name: 'Reset crop' }).click()
    const full = await box(page)
    expect(Math.abs(full.width - land.width)).toBeLessThan(2) // the whole picture again
    await expect(panel(page).getByRole('button', { name: 'Reset crop' })).toBeDisabled()
  })

  test('F05-L8 the picture does not zoom while framing, and other overlays step aside', async ({ page }) => {
    await openDevelop(page)
    await frameTool(page)
    await page.locator('.stage').click({ position: { x: 5, y: 5 } })
    await page.keyboard.press('z')
    await expect(page.locator('img.zoom-img')).toHaveCount(0)
    await expect(page.locator('.mask-layer')).toHaveCount(0)
  })

  test('F05-L9 no accessibility violations with the frame tool open', async ({ page }) => {
    await openDevelop(page)
    await frameTool(page)
    const r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
  })
})

test.describe('F05 develop: red eye', () => {
  const panel = (page: Page) => page.locator('section.panel', { has: page.getByRole('button', { name: 'Red eye tool' }) })
  const tool = (page: Page) => panel(page).getByRole('button', { name: 'Red eye tool' })
  const setHere = async (page: Page, name: string, value: string) => {
    const box = panel(page).getByRole('textbox', { name: name + ' value' })
    await box.click()
    await box.fill(value)
    await box.press('Enter')
  }
  const layer = (page: Page) => page.getByRole('group', { name: 'Red-eye circles' })
  const history = (page: Page) => page.getByRole('list', { name: /Edit history/ })
  /** click on the picture at a fraction of the circles layer */
  const clickAt = async (page: Page, fx: number, fy: number) => {
    const b = (await layer(page).boundingBox())!
    await page.mouse.click(b.x + b.width * fx, b.y + b.height * fy)
  }

  test('F05-RE1 the tool adds a circle where the picture is clicked, selects it and records a history step', async ({ page }) => {
    await openRetouch(page)
    await expect(layer(page)).toHaveCount(0)
    await tool(page).click()
    await expect(tool(page)).toHaveAttribute('aria-pressed', 'true')
    await clickAt(page, 0.3, 0.4)
    await expect(history(page).getByRole('button', { name: /Add red-eye fix/ })).toBeVisible()
    await expect(panel(page).getByRole('list', { name: 'Red-eye fixes' }).getByRole('listitem')).toHaveCount(1)
    await expect(page.getByRole('button', { name: 'Red eye 1: position' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Red eye 1: size' })).toBeVisible()
  })

  test('F05-RE2 size and darken change the selected circle and are named history steps; with none selected they set the next one', async ({ page }) => {
    await openRetouch(page)
    await setHere(page, 'Size', '12') // nothing selected: the starting size for new circles
    await tool(page).click()
    await clickAt(page, 0.5, 0.5)
    await expect(panel(page).getByRole('slider', { name: 'Size', exact: true })).toHaveValue('12')
    await setHere(page, 'Darken', '80')
    await expect(history(page).getByRole('button', { name: /Red eye 1: darken/ })).toBeVisible()
    await expect(panel(page).getByRole('slider', { name: 'Darken', exact: true })).toHaveValue('80')
  })

  test('F05-RE3 it is kept with the photo, can be deleted one at a time or all at once, and an edited mark shows', async ({ page }) => {
    await openRetouch(page)
    await tool(page).click()
    await clickAt(page, 0.3, 0.5)
    await clickAt(page, 0.7, 0.5)
    await expect(panel(page).getByRole('listitem')).toHaveCount(2)
    await page.getByRole('tab', { name: 'Library' }).click()
    await expect(page.locator('.cell-meta .flag.edit')).toHaveCount(1)
    await page.getByRole('tab', { name: 'Retouch' }).click()
    await expect(panel(page).getByRole('listitem')).toHaveCount(2)
    await panel(page).getByRole('button', { name: 'Delete red eye 1' }).click()
    await expect(panel(page).getByRole('listitem')).toHaveCount(1)
    await expect(history(page).getByRole('button', { name: /Delete red eye 1/ })).toBeVisible()
    await panel(page).getByRole('button', { name: 'Delete all red-eye fixes' }).click()
    await expect(panel(page).getByRole('listitem')).toHaveCount(0)
    await expect(panel(page).getByText('No red-eye fixes yet.')).toBeVisible()
  })

  test('F05-RE4 a circle moves with the mouse and resizes with the small dot', async ({ page }) => {
    await openRetouch(page)
    await tool(page).click()
    await clickAt(page, 0.5, 0.5)
    const dot = page.getByRole('button', { name: 'Red eye 1: position' })
    const before = (await dot.boundingBox())!
    await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2)
    await page.mouse.down()
    await page.mouse.move(before.x + 60, before.y + 30, { steps: 5 })
    await page.mouse.up()
    const after = (await dot.boundingBox())!
    expect(after.x - before.x).toBeGreaterThan(40)
    await expect(history(page).getByRole('button', { name: /Red eye 1: move/ })).toBeVisible()
    const size = page.getByRole('button', { name: 'Red eye 1: size' })
    const s0 = (await size.boundingBox())!
    await page.mouse.move(s0.x + s0.width / 2, s0.y + s0.height / 2)
    await page.mouse.down()
    await page.mouse.move(s0.x + 40, s0.y, { steps: 5 })
    await page.mouse.up()
    await expect(history(page).getByRole('button', { name: /Red eye 1: resize/ })).toBeVisible()
  })

  test('F05-RE5 the arrow keys nudge a focused point and Delete removes the circle', async ({ page }) => {
    await openRetouch(page)
    await tool(page).click()
    await clickAt(page, 0.5, 0.5)
    const dot = page.getByRole('button', { name: 'Red eye 1: position' })
    const x0 = (await dot.boundingBox())!.x
    await dot.focus()
    await page.keyboard.press('Shift+ArrowRight')
    expect((await dot.boundingBox())!.x).toBeGreaterThan(x0 + 5)
    await expect(history(page).getByRole('button', { name: /Red eye 1: move/ })).toBeVisible()
    await page.keyboard.press('Delete')
    await expect(panel(page).getByRole('listitem')).toHaveCount(0)
  })

  test('F05-RE6 the red-eye tool and the spot tool take turns', async ({ page }) => {
    await openRetouch(page)
    await tool(page).click()
    await page.getByRole('button', { name: 'Spot removal tool' }).click()
    await expect(tool(page)).toHaveAttribute('aria-pressed', 'false')
    await tool(page).click()
    await expect(page.getByRole('button', { name: 'Spot removal tool' })).toHaveAttribute('aria-pressed', 'false')
  })

  test('F05-RE7 no accessibility violations with a red-eye circle selected', async ({ page }) => {
    await openRetouch(page)
    await tool(page).click()
    await clickAt(page, 0.5, 0.5)
    const r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
  })
})

test.describe('F05 develop: portrait retouching', () => {
  const panel = (page: Page, title: string) => page.locator('section.panel', { hasText: title })
  const selector = (page: Page) => panel(page, 'Retouch face selector')
  const skin = (page: Page) => panel(page, 'Retouch face skin')
  const teeth = (page: Page) => panel(page, 'Retouch teeth')
  const eyes = (page: Page) => panel(page, 'Retouch eyes')
  const layer = (page: Page) => page.getByRole('group', { name: 'Portrait regions' })
  const history = (page: Page) => page.getByRole('list', { name: /Edit history/ })
  const markTool = (page: Page) => selector(page).getByRole('button', { name: /^Mark face/ })
  const field = async (box: ReturnType<typeof skin>, name: string, value: string) => {
    const input = box.getByRole('textbox', { name: `${name} value` })
    await input.click()
    await input.fill(value)
    await input.press('Enter')
  }
  const markAt = async (page: Page, fx = 0.5, fy = 0.5) => {
    await markTool(page).click()
    const b = (await layer(page).boundingBox())!
    await page.mouse.click(b.x + b.width * fx, b.y + b.height * fy)
    await expect(layer(page).getByRole('button', { name: 'Face: position' })).toBeVisible()
  }

  test('PT1 the four panels are there, and the sliders wait for a face', async ({ page }) => {
    await openRetouch(page)
    for (const t of ['Retouch face selector', 'Retouch face skin', 'Retouch teeth', 'Retouch eyes']) await expect(panel(page, t)).toBeVisible()
    await expect(selector(page).getByText('No face marked')).toBeVisible()
    await expect(skin(page).getByRole('slider', { name: 'Blemishes', exact: true })).toBeDisabled()
    await expect(teeth(page).getByRole('slider', { name: 'Brightness', exact: true })).toBeDisabled()
    await expect(eyes(page).getByRole('slider', { name: 'Iris', exact: true })).toBeDisabled()
    await expect(skin(page).getByRole('button', { name: 'Reset' })).toBeDisabled()
  })

  test('PT2 marking a face places a face, two eyes and a mouth, selects the face and records one history step', async ({ page }) => {
    await openRetouch(page)
    await markAt(page)
    await expect(history(page).getByRole('button', { name: /Mark face/ })).toBeVisible()
    await expect(selector(page).getByRole('list', { name: 'Marked regions' }).getByRole('listitem')).toHaveCount(4)
    await expect(selector(page).getByRole('button', { name: 'Face', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(layer(page).locator('.spot-ring.faint')).toHaveCount(3) // the eyes and the mouth, drawn faintly
    await expect(selector(page).getByText('No face marked')).toHaveCount(0)
    await expect(skin(page).getByRole('slider', { name: 'Blemishes', exact: true })).toBeEnabled()
  })

  test('PT3 a slider is a named history step with its group, and Impact starts at 100', async ({ page }) => {
    await openRetouch(page)
    await markAt(page)
    await expect(skin(page).getByRole('slider', { name: 'Impact', exact: true })).toHaveValue('100')
    await expect(skin(page).getByRole('slider', { name: 'Contouring', exact: true })).toHaveAttribute('min', '-100')
    await field(skin(page), 'Blemishes', '60')
    await expect(history(page).getByRole('button', { name: /Skin: blemishes/ })).toBeVisible()
    await field(teeth(page), 'Brightness', '-30')
    await expect(history(page).getByRole('button', { name: /Teeth: brightness/ })).toBeVisible()
    await expect(skin(page).getByRole('button', { name: 'Reset' })).toBeEnabled()
    await skin(page).getByRole('button', { name: 'Reset' }).click()
    await expect(skin(page).getByRole('slider', { name: 'Blemishes', exact: true })).toHaveValue('0')
    await expect(teeth(page).getByRole('slider', { name: 'Brightness', exact: true })).toHaveValue('-30') // only the skin was reset
  })

  test('PT4 moving the face takes the eyes and mouth with it, and a single region can be moved on its own', async ({ page }) => {
    await openRetouch(page)
    await markAt(page)
    const faint = layer(page).locator('.spot-ring.faint').first()
    const before = (await faint.boundingBox())!
    const dot = (await layer(page).getByRole('button', { name: 'Face: position' }).boundingBox())!
    await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2)
    await page.mouse.down()
    await page.mouse.move(dot.x + 50, dot.y + 20, { steps: 5 })
    await page.mouse.up()
    const after = (await faint.boundingBox())!
    expect(after.x - before.x).toBeGreaterThan(35)
    await expect(history(page).getByRole('button', { name: /Face 1: move/ })).toBeVisible()
    // one eye alone
    await selector(page).getByRole('button', { name: 'Left eye', exact: true }).click()
    const eyeDot = layer(page).getByRole('button', { name: 'Left eye: position' })
    const e0 = (await eyeDot.boundingBox())!
    const mouth0 = (await layer(page).locator('.spot-ring.faint').last().boundingBox())!
    await page.mouse.move(e0.x + e0.width / 2, e0.y + e0.height / 2)
    await page.mouse.down()
    await page.mouse.move(e0.x + 30, e0.y, { steps: 4 })
    await page.mouse.up()
    expect(((await eyeDot.boundingBox())!).x - e0.x).toBeGreaterThan(20)
    expect(Math.abs(((await layer(page).locator('.spot-ring.faint').last().boundingBox())!).x - mouth0.x)).toBeLessThan(2)
    await expect(history(page).getByRole('button', { name: /Face 1 left eye: move/ })).toBeVisible()
  })

  test('PT5 the dots resize a region and the arrow keys nudge a focused dot', async ({ page }) => {
    await openRetouch(page)
    await markAt(page)
    await selector(page).getByRole('button', { name: 'Mouth', exact: true }).click()
    const width = layer(page).getByRole('button', { name: 'Mouth: width' })
    const w0 = (await width.boundingBox())!
    await page.mouse.move(w0.x + w0.width / 2, w0.y + w0.height / 2)
    await page.mouse.down()
    await page.mouse.move(w0.x + 25, w0.y, { steps: 4 })
    await page.mouse.up()
    expect(((await width.boundingBox())!).x - w0.x).toBeGreaterThan(15)
    await expect(history(page).getByRole('button', { name: /Face 1 mouth: resize/ })).toBeVisible()
    const pos = layer(page).getByRole('button', { name: 'Mouth: position' })
    const x0 = (await pos.boundingBox())!.x
    await pos.focus()
    await page.keyboard.press('Shift+ArrowRight')
    expect(((await pos.boundingBox())!).x).toBeGreaterThan(x0 + 5)
  })

  test('PT6 the eye tabs keep a value each, and the label says which eye', async ({ page }) => {
    await openRetouch(page)
    await markAt(page)
    await eyes(page).getByRole('group', { name: 'Which eye' }).getByRole('button', { name: 'Left', exact: true }).click()
    await field(eyes(page), 'Iris', '40')
    await expect(history(page).getByRole('button', { name: /Eyes \(left\): iris/ })).toBeVisible()
    await eyes(page).getByRole('group', { name: 'Which eye' }).getByRole('button', { name: 'Both', exact: true }).click()
    await expect(eyes(page).getByRole('slider', { name: 'Iris', exact: true })).toHaveValue('0')
    await eyes(page).getByRole('group', { name: 'Which eye' }).getByRole('button', { name: 'Left', exact: true }).click()
    await expect(eyes(page).getByRole('slider', { name: 'Iris', exact: true })).toHaveValue('40')
    await eyes(page).getByRole('group', { name: 'Which eye' }).getByRole('button', { name: 'Right', exact: true }).click()
    await expect(eyes(page).getByRole('slider', { name: 'Iris', exact: true })).toHaveValue('0')
  })

  test('PT7 it is kept with the photo and marks it edited, and Clear face puts it all away', async ({ page }) => {
    await openRetouch(page)
    await markAt(page)
    await field(skin(page), 'Amount', '50')
    await page.getByRole('tab', { name: 'Library' }).click()
    await expect(page.locator('.cell-meta .flag.edit')).toHaveCount(1)
    await page.getByRole('tab', { name: 'Retouch' }).click()
    await expect(skin(page).getByRole('slider', { name: 'Amount', exact: true })).toHaveValue('50')
    await selector(page).getByRole('button', { name: 'Clear face' }).click()
    await expect(history(page).getByRole('button', { name: /Clear face/ })).toBeVisible()
    await expect(selector(page).getByText('No face marked')).toBeVisible()
    await expect(skin(page).getByRole('slider', { name: 'Amount', exact: true })).toBeDisabled()
  })

  test('PT8 marking again adds a second face with its own sliders, and the first keeps its own', async ({ page }) => {
    await openRetouch(page)
    await markAt(page, 0.3, 0.5)
    await field(skin(page), 'Amount', '70')
    await markAt(page, 0.7, 0.5)
    await expect(selector(page).getByRole('list', { name: 'Faces' }).getByRole('listitem')).toHaveCount(2)
    await expect(history(page).getByRole('button', { name: /Mark face/ }).first()).toBeVisible()
    await expect(skin(page).getByText('Editing face 2 of 2.')).toBeVisible()
    await expect(skin(page).getByRole('slider', { name: 'Amount', exact: true })).toHaveValue('0') // the new face starts fresh
    await selector(page).getByRole('button', { name: 'Face 1', exact: true }).click()
    await expect(skin(page).getByText('Editing face 1 of 2.')).toBeVisible()
    await expect(skin(page).getByRole('slider', { name: 'Amount', exact: true })).toHaveValue('70')
  })

  test('PT9 the portrait tool and the red-eye tool take turns, and the whole picture is shown while framing', async ({ page }) => {
    await openRetouch(page)
    await markTool(page).click()
    await page.getByRole('button', { name: 'Red eye tool' }).click()
    await expect(markTool(page)).toHaveAttribute('aria-pressed', 'false')
    await markTool(page).click()
    await expect(page.getByRole('button', { name: 'Red eye tool' })).toHaveAttribute('aria-pressed', 'false')
    await page.keyboard.press('c')
    await expect(markTool(page)).toHaveAttribute('aria-pressed', 'false')
  })

  test('PT10 no accessibility violations with a face marked and a region selected', async ({ page }) => {
    await openRetouch(page)
    await markAt(page)
    await field(skin(page), 'Amount', '30')
    const r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
  })
  test('PT11 Detect faces finds the faces, lists them, selects the first and is one history step', async ({ page }) => {
    await openRetouch(page)
    await selector(page).getByRole('button', { name: 'Detect faces' }).click()
    await expect(selector(page).getByText('3 faces found.')).toBeVisible()
    await expect(selector(page).getByRole('list', { name: 'Faces' }).getByRole('listitem')).toHaveCount(3)
    await expect(selector(page).getByRole('button', { name: 'Face 1', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(history(page).getByRole('button', { name: /Detect faces/ })).toBeVisible()
    await expect(skin(page).getByText('Editing face 1 of 3.')).toBeVisible()
    await expect(skin(page).getByRole('slider', { name: 'Blemishes', exact: true })).toBeEnabled()
    await expect(layer(page).getByRole('button', { name: 'Face: position' })).toBeVisible()
    await expect(layer(page).locator('.face-number')).toHaveCount(2) // the other two faces are numbered on the picture
  })

  test('PT12 detecting again keeps the faces and what was set on them, and says nothing new was found', async ({ page }) => {
    await openRetouch(page)
    await selector(page).getByRole('button', { name: 'Detect faces' }).click()
    await expect(selector(page).getByText('3 faces found.')).toBeVisible()
    await selector(page).getByRole('button', { name: 'Face 2', exact: true }).click()
    await field(teeth(page), 'Brightness', '40')
    await expect(history(page).getByRole('button', { name: /Teeth \(face 2\): brightness/ })).toBeVisible()
    await selector(page).getByRole('button', { name: 'Detect faces' }).click()
    await expect(selector(page).getByText('No new faces: the faces found are already marked.')).toBeVisible()
    await expect(selector(page).getByRole('list', { name: 'Faces' }).getByRole('listitem')).toHaveCount(3)
    await expect(teeth(page).getByRole('slider', { name: 'Brightness', exact: true })).toHaveValue('40')
  })

  test('PT19 Select all faces makes the Skin, Teeth and Eyes sliders change every face, and picking one face goes back to one', async ({ page }) => {
    await openRetouch(page)
    const sel = selector(page)
    await expect(sel.getByRole('button', { name: 'Select all faces' })).toHaveCount(0) // nothing to select yet
    await sel.getByRole('button', { name: 'Detect faces' }).click()
    await expect(sel.getByText('3 faces found.')).toBeVisible()
    const all = sel.getByRole('button', { name: 'Select all faces' })
    await expect(all).toHaveAttribute('aria-pressed', 'false')
    await all.click()
    await expect(all).toHaveAttribute('aria-pressed', 'true')
    await expect(sel.getByRole('button', { name: /^Face \d$/ }).first()).toHaveAttribute('aria-pressed', 'true')
    await expect(skin(page).getByText(/Editing all 3 faces together/)).toBeVisible()
    await field(teeth(page), 'Brightness', '35')
    await expect(history(page).getByRole('button', { name: /Teeth \(all faces\): brightness/ })).toBeVisible()
    for (const n of [1, 2, 3]) {
      await sel.getByRole('button', { name: `Face ${n}`, exact: true }).click()
      await expect(all).toHaveAttribute('aria-pressed', 'false')
      await expect(teeth(page).getByRole('slider', { name: 'Brightness', exact: true })).toHaveValue('35')
    }
    // with one face picked again, a change belongs to that face only
    await sel.getByRole('button', { name: 'Face 2', exact: true }).click()
    await field(teeth(page), 'Brightness', '60')
    await sel.getByRole('button', { name: 'Face 1', exact: true }).click()
    await expect(teeth(page).getByRole('slider', { name: 'Brightness', exact: true })).toHaveValue('35')
    await sel.getByRole('button', { name: 'Face 2', exact: true }).click()
    await expect(teeth(page).getByRole('slider', { name: 'Brightness', exact: true })).toHaveValue('60')
  })

  test('PT20 with all faces selected, Reset puts every face back, and one undo takes a whole change back', async ({ page }) => {
    await openRetouch(page)
    const sel = selector(page)
    await sel.getByRole('button', { name: 'Detect faces' }).click()
    await expect(sel.getByText('3 faces found.')).toBeVisible()
    await sel.getByRole('button', { name: 'Select all faces' }).click()
    await field(skin(page), 'Amount', '50')
    await page.keyboard.press('Control+z')
    for (const n of [1, 3]) {
      await sel.getByRole('button', { name: `Face ${n}`, exact: true }).click()
      await expect(skin(page).getByRole('slider', { name: 'Amount', exact: true })).toHaveValue('0')
    }
    await sel.getByRole('button', { name: 'Select all faces' }).click()
    await field(skin(page), 'Amount', '40')
    await skin(page).getByRole('button', { name: 'Reset' }).click()
    for (const n of [1, 2, 3]) {
      await sel.getByRole('button', { name: `Face ${n}`, exact: true }).click()
      await expect(skin(page).getByRole('slider', { name: 'Amount', exact: true })).toHaveValue('0')
    }
  })

  test('PT13 a wrong face can be deleted, and the others are renumbered', async ({ page }) => {
    await openRetouch(page)
    await selector(page).getByRole('button', { name: 'Detect faces' }).click()
    await expect(selector(page).getByRole('list', { name: 'Faces' }).getByRole('listitem')).toHaveCount(3)
    await selector(page).getByRole('button', { name: 'Delete face 2' }).click()
    await expect(selector(page).getByRole('list', { name: 'Faces' }).getByRole('listitem')).toHaveCount(2)
    await expect(history(page).getByRole('button', { name: /Delete face 2/ })).toBeVisible()
    await expect(selector(page).getByRole('button', { name: 'Face 3', exact: true })).toHaveCount(0)
  })

  test('PT14 Copy to all faces gives every face the settings of the selected one', async ({ page }) => {
    await openRetouch(page)
    await selector(page).getByRole('button', { name: 'Detect faces' }).click()
    await expect(selector(page).getByRole('list', { name: 'Faces' }).getByRole('listitem')).toHaveCount(3)
    await field(skin(page), 'Amount', '65')
    await selector(page).getByRole('button', { name: 'Copy to all faces' }).click()
    await expect(history(page).getByRole('button', { name: /Copy retouch to all faces/ })).toBeVisible()
    for (const n of [2, 3]) {
      await selector(page).getByRole('button', { name: `Face ${n}`, exact: true }).click()
      await expect(skin(page).getByRole('slider', { name: 'Amount', exact: true })).toHaveValue('65')
    }
  })

  test('PT15 clicking another face on the picture selects it', async ({ page }) => {
    await openRetouch(page)
    await selector(page).getByRole('button', { name: 'Detect faces' }).click()
    await expect(layer(page).locator('.face-number')).toHaveCount(2)
    await layer(page).locator('.spot-ring.faint').first().dispatchEvent('pointerdown', { button: 0 })
    await expect(selector(page).getByRole('button', { name: /^Face [23]$/ , pressed: true })).toBeVisible()
  })

  test('PT16 Clear all faces removes them all, and the sliders wait for a face again', async ({ page }) => {
    await openRetouch(page)
    await selector(page).getByRole('button', { name: 'Detect faces' }).click()
    await expect(selector(page).getByRole('list', { name: 'Faces' }).getByRole('listitem')).toHaveCount(3)
    await selector(page).getByRole('button', { name: 'Clear all faces' }).click()
    await expect(selector(page).getByText('No face marked')).toBeVisible()
    await expect(skin(page).getByRole('slider', { name: 'Blemishes', exact: true })).toBeDisabled()
    await expect(history(page).getByRole('button', { name: /Clear faces/ })).toBeVisible()
  })

  test('PT17 several faces are kept with the photo', async ({ page }) => {
    await openRetouch(page)
    await selector(page).getByRole('button', { name: 'Detect faces' }).click()
    await expect(selector(page).getByRole('list', { name: 'Faces' }).getByRole('listitem')).toHaveCount(3)
    await selector(page).getByRole('button', { name: 'Face 3', exact: true }).click()
    await field(skin(page), 'Amount', '45')
    await page.getByRole('tab', { name: 'Library' }).click()
    await expect(page.locator('.cell-meta .flag.edit')).toHaveCount(1)
    await page.getByRole('tab', { name: 'Retouch' }).click()
    await expect(selector(page).getByRole('list', { name: 'Faces' }).getByRole('listitem')).toHaveCount(3)
    await selector(page).getByRole('button', { name: 'Face 3', exact: true }).click()
    await expect(skin(page).getByRole('slider', { name: 'Amount', exact: true })).toHaveValue('45')
  })

  test('PT18 no accessibility violations with several faces listed and one selected', async ({ page }) => {
    await openRetouch(page)
    await selector(page).getByRole('button', { name: 'Detect faces' }).click()
    await expect(selector(page).getByText('3 faces found.')).toBeVisible()
    const r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
  })
})

test.describe('F05 develop: undo and redo', () => {
  const undo = (page: Page) => page.getByRole('group', { name: 'Undo' }).getByRole('button', { name: 'Undo', exact: true })
  const redo = (page: Page) => page.getByRole('group', { name: 'Undo' }).getByRole('button', { name: 'Redo', exact: true })
  const history = (page: Page) => page.getByRole('list', { name: /Edit history/ })

  test('UR1 Ctrl+Z goes back one edit at a time and Ctrl+Shift+Z and Ctrl+Y go forward', async ({ page }) => {
    await openDevelop(page)
    await setSlider(page, 'Exposure', '1.5')
    await setSlider(page, 'Contrast', '20')
    await page.keyboard.press('Control+z')
    await expect(slider(page, 'Contrast')).toHaveValue('0')
    await expect(slider(page, 'Exposure')).toHaveValue('1.5')
    await page.keyboard.press('Control+Shift+z')
    await expect(slider(page, 'Contrast')).toHaveValue('20')
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    await expect(slider(page, 'Exposure')).toHaveValue('0')
    await page.keyboard.press('Control+y')
    await expect(slider(page, 'Exposure')).toHaveValue('1.5')
    await expect(history(page).getByRole('button', { name: /Redo/ }).first()).toBeVisible()
    await expect(history(page).getByRole('button', { name: /Undo/ }).first()).toBeVisible()
  })

  test('UR2 the buttons are off until there is something to undo or redo', async ({ page }) => {
    await openDevelop(page)
    await expect(undo(page)).toBeDisabled()
    await expect(redo(page)).toBeDisabled()
    await setSlider(page, 'Exposure', '1')
    await expect(undo(page)).toBeEnabled()
    await expect(redo(page)).toBeDisabled()
    await undo(page).click()
    await expect(slider(page, 'Exposure')).toHaveValue('0')
    await expect(undo(page)).toBeDisabled()
    await expect(redo(page)).toBeEnabled()
    await redo(page).click()
    await expect(slider(page, 'Exposure')).toHaveValue('1')
    await expect(redo(page)).toBeDisabled()
  })

  test('UR3 Ctrl+Z inside a number box is the box\'s own, not an undo of the photo', async ({ page }) => {
    await openDevelop(page)
    await setSlider(page, 'Exposure', '1.5')
    await page.getByRole('textbox', { name: 'Contrast value', exact: true }).click()
    await page.keyboard.press('Control+z')
    await expect(slider(page, 'Exposure')).toHaveValue('1.5')
    await expect(undo(page)).toBeEnabled()
  })

  test('UR4 a new edit after an undo ends the redo', async ({ page }) => {
    await openDevelop(page)
    await setSlider(page, 'Exposure', '1')
    await undo(page).click()
    await expect(redo(page)).toBeEnabled()
    await setSlider(page, 'Saturation', '30')
    await expect(redo(page)).toBeDisabled()
  })

  test('UR5 another photo starts with nothing to undo', async ({ page }) => {
    await openDevelop(page)
    await setSlider(page, 'Exposure', '1')
    await expect(undo(page)).toBeEnabled()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('complementary', { name: 'Develop controls' })).not.toHaveAttribute('aria-busy', 'true')
    await expect(undo(page)).toBeDisabled()
  })
})

test.describe('F05 develop: clipping warnings', () => {
  const button = (page: Page) => page.getByRole('button', { name: 'Clipping', exact: true })
  const badge = (page: Page) => page.locator('.clip-badge')

  test('CL1 J and the button show and hide the warning, with how much of the picture is blown and crushed', async ({ page }) => {
    await openDevelop(page)
    await expect(badge(page)).toHaveCount(0)
    await expect(button(page)).toHaveAttribute('aria-pressed', 'false')
    await page.keyboard.press('j')
    await expect(button(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(badge(page)).toBeVisible()
    await expect(badge(page)).toContainText('Blown highlights (red)')
    await expect(badge(page)).toContainText('Crushed shadows (blue)')
    await expect(page.locator('canvas.clip-layer')).toBeVisible()
    await button(page).click()
    await expect(badge(page)).toHaveCount(0)
    await expect(page.locator('canvas.clip-layer')).toHaveCount(0)
  })

  test('CL2 it follows the edits: a very bright picture is mostly blown, and the share goes back down', async ({ page }) => {
    await openDevelop(page)
    await page.keyboard.press('j')
    await expect(badge(page)).toContainText('Blown highlights (red) none')
    await setSlider(page, 'Exposure', '5')
    await expect(badge(page)).not.toContainText('Blown highlights (red) none')
    await expect(badge(page)).toContainText(/Blown highlights \(red\) (9\d|100)\.\d%/)
    await setSlider(page, 'Exposure', '0')
    await expect(badge(page)).toContainText('Blown highlights (red) none')
  })

  test('CL3 it is out of the way at 100%, in the Before view and while framing, and comes back', async ({ page }) => {
    await openDevelop(page)
    await page.keyboard.press('j')
    await expect(badge(page)).toBeVisible()
    await page.keyboard.press('z')
    await expect(page.locator('img.zoom-img')).toBeVisible()
    await expect(badge(page)).toHaveCount(0)
    await page.keyboard.press('z')
    await expect(badge(page)).toBeVisible()
    await page.keyboard.press('Backslash')
    await expect(badge(page)).toHaveCount(0)
    await page.keyboard.press('Backslash')
    await expect(badge(page)).toBeVisible()
    await page.keyboard.press('c')
    await expect(badge(page)).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(badge(page)).toBeVisible()
  })

  test('CL4 the choice stays when moving to the next photo', async ({ page }) => {
    await openDevelop(page)
    await page.keyboard.press('j')
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('complementary', { name: 'Develop controls' })).not.toHaveAttribute('aria-busy', 'true')
    await expect(button(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(badge(page)).toBeVisible()
  })

  test('CL5 no accessibility violations with the warning on', async ({ page }) => {
    await openDevelop(page)
    await page.keyboard.press('j')
    await expect(badge(page)).toBeVisible()
    const r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
  })
})

test.describe('F05 develop: more crop guides', () => {
  const panel = (page: Page) => page.locator('section.panel', { hasText: 'Crop and straighten' })
  const guide = (page: Page, name: string) => panel(page).getByRole('group', { name: 'Grid' }).getByRole('button', { name, exact: true })
  const frameOpen = async (page: Page) => {
    await openDevelop(page)
    await panel(page).getByRole('button', { name: 'Frame tool' }).click()
    await expect(page.locator('.crop-body')).toBeVisible()
  }

  test('CG1 the guides are Thirds, Golden ratio, Diagonals, Triangles, Fine and None', async ({ page }) => {
    await frameOpen(page)
    const names = await panel(page).getByRole('group', { name: 'Grid' }).getByRole('button').allTextContents()
    expect(names).toEqual(['Thirds', 'Golden ratio', 'Diagonals', 'Triangles', 'Fine', 'None'])
  })

  test('CG2 the golden ratio draws two lines each way at 38% and 62% across the frame, and diagonals draw the two corner lines', async ({ page }) => {
    await frameOpen(page)
    await guide(page, 'Golden ratio').click()
    await expect(page.locator('.crop-grid')).toHaveCount(2)
    const body = (await page.locator('.crop-body').boundingBox())!
    const xs = await page.locator('.crop-grid').evaluateAll((gs) => gs.map((g) => g.querySelector('line')!.getBoundingClientRect().x))
    expect((xs[0] - body.x) / body.width).toBeCloseTo(0.382, 1)
    expect((xs[1] - body.x) / body.width).toBeCloseTo(0.618, 1)
    await guide(page, 'Diagonals').click()
    await expect(page.locator('.crop-grid')).toHaveCount(1)
    await expect(page.locator('.crop-grid line')).toHaveCount(2)
    const diag = await page.locator('.crop-grid line').first().boundingBox()
    expect(Math.abs(diag!.width - body.width)).toBeLessThan(3) // corner to corner
    expect(Math.abs(diag!.height - body.height)).toBeLessThan(3)
  })

  test('CG3 the choice is remembered', async ({ page }) => {
    await frameOpen(page)
    await guide(page, 'Diagonals').click()
    await page.reload()
    await frameOpen(page)
    await expect(guide(page, 'Diagonals')).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('.crop-grid')).toHaveCount(1)
  })
})

test.describe('F05 develop: turn and flip', () => {
  const panel = (page: Page) => page.locator('section.panel', { has: page.getByRole('button', { name: 'Constrain to picture' }) })
  const turn = (page: Page, name: string) => panel(page).getByRole('group', { name: 'Turn and flip' }).getByRole('button', { name, exact: true })
  const history = (page: Page) => page.getByRole('list', { name: /Edit history/ })

  test('TF1 four buttons turn and flip, each a named history step, and the Library marks the photo edited', async ({ page }) => {
    await openDevelop(page)
    const names = await panel(page).getByRole('group', { name: 'Turn and flip' }).getByRole('button').allTextContents()
    expect(names).toEqual(['Rotate left', 'Rotate right', 'Flip horizontal', 'Flip vertical'])
    for (const n of names) {
      await turn(page, n).click()
      await expect(history(page).getByRole('button', { name: new RegExp(n) }).first()).toBeVisible()
    }
    await page.getByRole('tab', { name: 'Library' }).click()
    await expect(page.locator('.cell-meta .flag.edit')).toHaveCount(1)
  })

  test('TF2 Reset in the Transform panel puts the turn back, and Ctrl+Z undoes a single turn', async ({ page }) => {
    await openDevelop(page)
    await expect(panel(page).getByRole('button', { name: 'Reset', exact: true })).toBeDisabled()
    await turn(page, 'Rotate right').click()
    await expect(panel(page).getByRole('button', { name: 'Reset', exact: true })).toBeEnabled()
    await turn(page, 'Flip horizontal').click()
    await page.keyboard.press('Control+z')
    await expect(panel(page).getByRole('button', { name: 'Reset', exact: true })).toBeEnabled() // the rotation is still there
    await page.keyboard.press('Control+z')
    await expect(panel(page).getByRole('button', { name: 'Reset', exact: true })).toBeDisabled()
    await turn(page, 'Rotate left').click()
    await panel(page).getByRole('button', { name: 'Reset', exact: true }).click()
    await expect(panel(page).getByRole('button', { name: 'Reset', exact: true })).toBeDisabled()
  })

  test('TF3 turning starts the crop frame again and ends a 100% view', async ({ page }) => {
    await openDevelop(page)
    const crop = page.locator('section.panel', { hasText: 'Crop and straighten' })
    await crop.getByRole('button', { name: 'Frame tool' }).click()
    await crop.getByRole('group', { name: 'Aspect ratio' }).getByRole('button', { name: '1:1', exact: true }).click()
    await crop.getByRole('button', { name: 'Done' }).click()
    await turn(page, 'Rotate right').click()
    await crop.getByRole('button', { name: 'Frame tool' }).click()
    const box = (await page.locator('.crop-body').boundingBox())!
    expect(Math.abs(box.width - box.height)).toBeLessThan(3) // a 1:1 frame is still a square, placed afresh
    await crop.getByRole('button', { name: 'Done' }).click()
    await page.keyboard.press('z')
    await expect(page.locator('img.zoom-img')).toBeVisible()
    await turn(page, 'Flip vertical').click()
    await expect(page.locator('img.zoom-img')).toHaveCount(0)
  })

  test('TF4 no accessibility violations with the turn buttons', async ({ page }) => {
    await openDevelop(page)
    await turn(page, 'Rotate right').click()
    const r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
  })
})

test.describe('F05 develop: colour readout and the spots view', () => {
  const readout = (page: Page) => page.locator('.readout')
  const stage = async (page: Page) => (await page.locator('.stage').boundingBox())!
  const spots = (page: Page) => page.locator('section.panel', { has: page.getByRole('button', { name: 'Spot removal tool' }) })
  const showSpots = (page: Page) => spots(page).getByRole('button', { name: 'Show spots', exact: true })

  test('RO1 the colour under the pointer is shown while it is over the picture, and goes when it leaves', async ({ page }) => {
    await openDevelop(page)
    await expect(readout(page)).toHaveCount(0)
    const s = await stage(page)
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2)
    await expect(readout(page)).toHaveText(/^R \d+\s+G \d+\s+B \d+\s+\(\d+%\s+\d+%\s+\d+%\)$/)
    await page.mouse.move(s.x + s.width / 2 + 30, s.y + s.height / 2 + 20)
    await expect(readout(page)).toBeVisible()
    await page.mouse.move(s.x + s.width + 80, s.y + s.height / 2) // over the panels
    await expect(readout(page)).toHaveCount(0)
  })

  test('RO2 it follows the edits, and is not shown at 100% or while framing', async ({ page }) => {
    await openDevelop(page)
    const s = await stage(page)
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2)
    await expect(readout(page)).toBeVisible()
    const before = await readout(page).textContent()
    await setSlider(page, 'Exposure', '5')
    await page.mouse.move(s.x + s.width / 2 + 5, s.y + s.height / 2 + 5)
    await expect.poll(async () => readout(page).textContent()).not.toBe(before)
    await expect(readout(page)).toHaveText(/R 255\s+G 255\s+B 255/) // five stops up: everything is white
    await page.keyboard.press('c')
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 2)
    await expect(readout(page)).toHaveCount(0)
  })

  test('SV1 Show spots turns the picture into a map of specks, and off puts the picture back', async ({ page }) => {
    await openRetouch(page)
    await expect(page.locator('canvas.spot-map')).toHaveCount(0)
    await expect(showSpots(page)).toHaveAttribute('aria-pressed', 'false')
    await showSpots(page).click()
    await expect(showSpots(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('canvas.spot-map')).toBeVisible()
    await expect(page.locator('.spot-badge')).toContainText('Spots view')
    expect(await page.locator('canvas.spot-map').evaluate((c) => (c as HTMLCanvasElement).width)).toBeGreaterThan(100)
    await showSpots(page).click()
    await expect(page.locator('canvas.spot-map')).toHaveCount(0)
    await expect(page.locator('.spot-badge')).toHaveCount(0)
  })

  test('SV2 it is out of the way at 100%, in the Before view and while framing, and stays for the next photo', async ({ page }) => {
    await openRetouch(page)
    await showSpots(page).click()
    await expect(page.locator('canvas.spot-map')).toBeVisible()
    await page.keyboard.press('z')
    await expect(page.locator('img.zoom-img')).toBeVisible()
    await expect(page.locator('canvas.spot-map')).toHaveCount(0)
    await page.keyboard.press('z')
    await expect(page.locator('canvas.spot-map')).toBeVisible()
    await page.keyboard.press('Backslash')
    await expect(page.locator('canvas.spot-map')).toHaveCount(0)
    await page.keyboard.press('Backslash')
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('complementary', { name: 'Retouch controls' })).not.toHaveAttribute('aria-busy', 'true')
    await expect(showSpots(page)).toHaveAttribute('aria-pressed', 'true')
    await expect(page.locator('canvas.spot-map')).toBeVisible()
  })

  test('SV3 the spot tool still works over the map, and there are no accessibility violations', async ({ page }) => {
    await openRetouch(page)
    await showSpots(page).click()
    await spots(page).getByRole('button', { name: 'Spot removal tool' }).click()
    await expect(page.getByRole('group', { name: 'Spot removal circles' })).toBeVisible()
    await expect(page.locator('canvas.spot-map')).toBeVisible()
    const r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
  })

  test('RM1 Retouch is a module of its own: spots, red eye and faces are there and no longer in Develop', async ({ page }) => {
    await openDevelop(page)
    const tools = ['Spot removal tool', 'Red eye tool', 'Mark face']
    for (const t of tools) await expect(page.getByRole('button', { name: t, exact: true })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Basic' }).or(page.getByRole('button', { name: 'Basic', exact: true }))).toBeVisible()
    await page.getByRole('tab', { name: 'Retouch' }).click()
    await expect(page.getByRole('tab', { name: 'Retouch' })).toHaveAttribute('aria-selected', 'true')
    for (const t of tools) await expect(page.getByRole('button', { name: t, exact: true })).toBeVisible()
    await expect(page.getByRole('heading', { name: 'Basic' }).or(page.getByRole('button', { name: 'Basic', exact: true }))).toHaveCount(0)
    await expect(page.getByRole('complementary', { name: 'Retouch history' })).toBeVisible()
  })

  test('RM2 the picture, its edits and its history are shared between Develop and Retouch, and a tool is not left on', async ({ page }) => {
    await openDevelop(page)
    await setSlider(page, 'Exposure', '1')
    await page.getByRole('tab', { name: 'Retouch' }).click()
    await expect(page.getByRole('complementary', { name: 'Retouch controls' })).not.toHaveAttribute('aria-busy', 'true')
    await expect(page.getByRole('button', { name: /Exposure/ }).first()).toBeVisible() // in the history
    await page.getByRole('button', { name: 'Spot removal tool' }).click()
    await expect(page.getByRole('button', { name: 'Spot removal tool' })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('tab', { name: 'Develop' }).click()
    await expect(page.getByRole('heading', { name: 'Basic' }).or(page.getByRole('button', { name: 'Basic', exact: true }))).toBeVisible()
    await page.getByRole('tab', { name: 'Retouch' }).click()
    await expect(page.getByRole('button', { name: 'Spot removal tool' })).toHaveAttribute('aria-pressed', 'false')
    const r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
  })
})

test.describe('F05 develop: enlarging a photo that was cropped in too far', () => {
  const panel = (page: Page) => page.locator('section.panel', { has: page.getByRole('group', { name: 'Enlarge by' }) })
  const openPanel = async (page: Page) => {
    await page.getByRole('button', { name: 'Enlarge', exact: true }).click()
    await expect(panel(page)).toBeVisible()
  }
  const edge = (page: Page) => panel(page).getByRole('textbox', { name: /Enlarge to/ })

  test('EN1 shows the size, 2x to 4x set the longest side, and a size that is not bigger is refused', async ({ page }) => {
    await openDevelop(page)
    await openPanel(page)
    await expect(panel(page).getByRole('status')).toContainText(/The picture is about \d+ × \d+ px after the crop/)
    const exportBtn = panel(page).getByRole('button', { name: /^Export enlarged/ })
    await expect(edge(page)).toHaveValue(/^\d+$/)
    const start = Number(await edge(page).inputValue())
    await panel(page).getByRole('button', { name: '4×' }).click()
    expect(Number(await edge(page).inputValue())).toBe(Math.min(20000, (start / 2) * 4)) // 4× the size, up to the largest allowed
    await expect(exportBtn).toBeEnabled()
    await edge(page).fill('10')
    await expect(panel(page).getByRole('alert')).toContainText(/not bigger than the picture/)
    await expect(exportBtn).toBeDisabled()
    await edge(page).fill('99999')
    await expect(panel(page).getByRole('alert')).toContainText(/largest size is 20000/)
  })

  test('EN2 before and after can be shown for each way, and the way can be changed', async ({ page }) => {
    await openDevelop(page)
    await openPanel(page)
    await panel(page).getByRole('button', { name: 'Show before and after' }).click()
    await expect(panel(page).getByRole('img', { name: /^Before/ })).toBeVisible()
    await expect(panel(page).getByRole('img', { name: /After: the same part enlarged smoothly/ })).toBeVisible()
    await panel(page).getByRole('radio', { name: 'AI' }).click()
    await expect(panel(page).getByRole('img', { name: /^Before/ })).toHaveCount(0) // a new way, so the old look is dropped
    await panel(page).getByRole('button', { name: 'Show before and after' }).click()
    await expect(panel(page).getByRole('img', { name: /enlarged by the AI/ })).toBeVisible()
  })

  test('EN3 Export enlarged opens the Export dialog with that size and way already chosen', async ({ page }) => {
    await openDevelop(page)
    await openPanel(page)
    await panel(page).getByRole('radio', { name: 'AI' }).click()
    await panel(page).getByRole('button', { name: '3×' }).click()
    const target = await edge(page).inputValue()
    await panel(page).getByRole('button', { name: /^Export enlarged/ }).click()
    const dlg = page.getByRole('dialog', { name: 'Export photos' })
    await expect(dlg.getByRole('combobox', { name: 'Enlarge small photos' })).toHaveValue('ai')
    await expect(dlg.getByLabel('Longest side (px)')).toHaveValue(target)
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
  })
})

test.describe('F05 develop: B BOT, the skin tone assistant and suggestions', () => {
  const bot = (page: Page) => page.locator('section.panel', { has: page.getByRole('button', { name: /Ask B BOT/ }) })
  const ask = (page: Page) => bot(page).getByRole('button', { name: /Ask B BOT/ })

  test('BB1 asks, says what it found in words, and lists suggestions with the reason', async ({ page }) => {
    await openDevelop(page)
    await expect(bot(page).getByRole('list', { name: 'B BOT suggestions' })).toHaveCount(0)
    await ask(page).click()
    await expect(bot(page).getByRole('status')).toContainText('I found 2 faces. The skin looks a little too red.')
    const list = bot(page).getByRole('list', { name: 'B BOT suggestions' })
    await expect(list.getByRole('listitem')).toHaveCount(3) // two suggestions and Apply all
    await expect(list).toContainText('Take the red out of the skin')
    await expect(list).toContainText('healthy skin sits between 36 and 64')
    await expect(ask(page)).toHaveText('Ask B BOT again')
  })

  test('BB2 Apply changes the settings it names, is one history step, and Undo takes it back', async ({ page }) => {
    await openDevelop(page)
    await ask(page).click()
    await bot(page).getByRole('button', { name: 'Apply: Take the red out of the skin' }).click()
    await expect(slider(page, 'Temperature')).toHaveValue('10')
    await expect(slider(page, 'Tint')).toHaveValue('-8')
    await expect(page.getByRole('list', { name: /Edit history/ }).getByRole('button', { name: /B BOT: Take the red out of the skin/ })).toBeVisible()
    await expect(bot(page).getByRole('button', { name: 'Apply: Take the red out of the skin' })).toHaveCount(0) // done
    await page.keyboard.press('Control+z')
    await expect(slider(page, 'Temperature')).toHaveValue('0')
    await expect(slider(page, 'Tint')).toHaveValue('0')
  })

  test('BB3 Apply all applies every suggestion together as one step', async ({ page }) => {
    await openDevelop(page)
    await ask(page).click()
    await bot(page).getByRole('button', { name: /^Apply all 2/ }).click()
    await expect(slider(page, 'Temperature')).toHaveValue('10')
    await expect(slider(page, 'Contrast')).toHaveValue('20')
    await expect(page.getByRole('list', { name: /Edit history/ }).getByRole('button', { name: /B BOT: all suggestions/ })).toHaveCount(1)
    await expect(bot(page).getByText(/All of my suggestions are applied/)).toBeVisible()
  })

  test('BB4 with no faces it says so and looks at the whole picture; a failure is said and does not break the panel', async ({ page }) => {
    await openDevelop(page, '?nofaces=1')
    await ask(page).click()
    await expect(bot(page).getByRole('status')).toContainText('I did not find a face, so I looked at the whole picture.')
    await expect(bot(page).getByRole('list', { name: 'B BOT suggestions' })).toContainText('Brighten the picture')
    await page.goto('/?failpreview=1')
    await openDevelop(page, '?failpreview=1')
    await ask(page).click()
    await expect(bot(page).getByRole('alert')).toContainText('no preview yet')
    await expect(ask(page)).toBeEnabled()
  })

  test('BB5 it is in Retouch too, with the skin suggestion first, and the panel has no accessibility violations', async ({ page }) => {
    await openRetouch(page)
    await expect(page.getByRole('complementary', { name: 'Retouch controls' }).getByRole('heading', { name: 'B BOT' }).or(page.getByRole('button', { name: 'B BOT', exact: true }))).toBeVisible()
    await ask(page).click()
    await expect(bot(page).getByRole('list', { name: 'B BOT suggestions' }).getByRole('listitem').first()).toContainText('Take the red out of the skin')
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
  })
})

test.describe('F06 masks: select automatically', () => {
  const panel = (page: Page) => page.locator('section.panel', { has: page.getByRole('group', { name: 'Select automatically' }) })
  const auto = (page: Page, name: '+ Subject' | '+ Background' | '+ Sky') => panel(page).getByRole('group', { name: 'Select automatically' }).getByRole('button', { name, exact: true })
  const list = (page: Page) => panel(page).getByRole('list', { name: 'Masks' })
  const history = (page: Page) => page.getByRole('list', { name: /Edit history/ })

  test('AM1 Subject finds the subject, names the mask and shows it, in one history step', async ({ page }) => {
    await openDevelop(page)
    await auto(page, '+ Subject').click()
    await expect(list(page).getByRole('listitem')).toHaveCount(1)
    await expect(list(page)).toContainText('Subject 1')
    await expect(panel(page).getByRole('button', { name: 'Show mask' })).toHaveAttribute('aria-pressed', 'true')
    await expect(panel(page).getByRole('button', { name: 'Invert' })).toHaveAttribute('aria-pressed', 'false')
    await expect(panel(page).getByText(/Found automatically/)).toBeVisible()
    await expect(history(page).getByRole('button', { name: /Add subject/ })).toHaveCount(1)
    await page.keyboard.press('Control+z')
    await expect(list(page)).toHaveCount(0)
  })

  test('AM2 Background is the subject turned round', async ({ page }) => {
    await openDevelop(page)
    await auto(page, '+ Background').click()
    await expect(list(page)).toContainText('Background 1')
    await expect(panel(page).getByRole('button', { name: 'Invert' })).toHaveAttribute('aria-pressed', 'true')
    await expect(history(page).getByRole('button', { name: /Add background/ })).toHaveCount(1)
  })

  test('AM3 Sky has a sensitivity slider that is saved with the mask', async ({ page }) => {
    await openDevelop(page)
    await auto(page, '+ Sky').click()
    await expect(list(page)).toContainText('Sky 1')
    const sens = page.getByRole('slider', { name: 'Sensitivity', exact: true })
    await expect(sens).toHaveValue('50')
    await setSlider(page, 'Sensitivity', '80')
    await expect(history(page).getByRole('button', { name: /Sky 1: sensitivity/ })).toHaveCount(1)
    await page.getByRole('tab', { name: 'Library' }).click()
    await page.getByRole('tab', { name: 'Develop' }).click()
    await list(page).locator('button.mask-name', { hasText: 'Sky 1' }).click()
    await expect(page.getByRole('slider', { name: 'Sensitivity', exact: true })).toHaveValue('80')
  })

  test('AM4 a failure is said and nothing is added; the buttons come back', async ({ page }) => {
    await openDevelop(page, '?failpreview=1')
    await auto(page, '+ Subject').click()
    await expect(page.getByText(/no preview yet/).first()).toBeVisible()
    await expect(list(page)).toHaveCount(0)
    await expect(auto(page, '+ Subject')).toBeEnabled()
  })

  test('AM5 no accessibility violations with an automatic mask selected', async ({ page }) => {
    await openDevelop(page)
    await auto(page, '+ Subject').click()
    await expect(list(page)).toContainText('Subject 1')
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
  })
})
