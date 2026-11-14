import { cells, expect, open, test } from './helpers'

test.describe('F21 layout', () => {
  for (const width of [1100, 1280, 1440]) {
    test(`LY1 Develop's button bar shows every button whole, on the bar, at ${width} px wide`, async ({ page }) => {
      await page.setViewportSize({ width, height: 800 })
      await open(page)
      await cells(page).first().click()
      await page.keyboard.press('d')
      const bar = page.getByRole('toolbar', { name: 'Develop tools' })
      await expect(bar).toBeVisible()
      const box = (await bar.boundingBox())!
      const buttons = bar.getByRole('button')
      const n = await buttons.count()
      expect(n).toBeGreaterThanOrEqual(10)
      for (let i = 0; i < n; i++) {
        const b = (await buttons.nth(i).boundingBox())!
        const name = await buttons.nth(i).innerText()
        expect(b.y, `${name} top`).toBeGreaterThanOrEqual(box.y - 1)
        expect(b.y + b.height, `${name} bottom`).toBeLessThanOrEqual(box.y + box.height + 1)
        expect(b.x + b.width, `${name} right`).toBeLessThanOrEqual(box.x + box.width + 1)
        expect(b.height, `${name} is one line`).toBeLessThan(40)
      }
      // the bar reaches the whole width of the picture area above it
      const stage = (await page.getByRole('region', { name: 'Edit', exact: true }).boundingBox())!
      expect(Math.abs(box.width - stage.width)).toBeLessThanOrEqual(2)
    })
  }

  test('LY2 the Presence group has Texture, Clarity and Dehaze before Vibrance and Saturation, and each is one undoable step', async ({ page }) => {
    await open(page)
    await cells(page).first().click()
    await page.keyboard.press('d')
    const names = await page.locator('.slider .slider-label').allInnerTexts()
    const at = (n: string) => names.findIndex((x) => x.trim() === n)
    expect(at('Texture')).toBeGreaterThan(at('Blacks'))
    expect(at('Texture') + 1).toBe(at('Clarity'))
    expect(at('Clarity') + 1).toBe(at('Dehaze'))
    expect(at('Dehaze') + 1).toBe(at('Vibrance'))
    expect(at('Vibrance') + 1).toBe(at('Saturation'))
    for (const name of ['Texture', 'Clarity', 'Dehaze']) {
      const slider = page.getByLabel(name, { exact: true })
      await slider.focus()
      await page.keyboard.press('ArrowRight')
      await page.keyboard.press('ArrowRight')
      await expect(page.locator('.slider-num').nth(names.findIndex((x) => x.trim() === name))).toHaveValue(/2/)
    }
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    await expect(page.getByRole('button', { name: 'Reset all' })).toBeVisible()
  })

  test('LY3 sliders have a thin line and a round handle of the same size, and Tint is a green to magenta gradient', async ({ page }) => {
    await open(page)
    await cells(page).first().click()
    await page.keyboard.press('d')
    const info = await page.evaluate(() => {
      // the style rules for the slider's line and handle (the browser does not report these through computed style)
      const rules: CSSStyleRule[] = []
      for (const sheet of Array.from(document.styleSheets)) for (const r of Array.from(sheet.cssRules)) if (r instanceof CSSStyleRule) rules.push(r)
      const find = (part: string, not = '.grad') => rules.filter((r) => r.selectorText.includes(part) && !r.selectorText.includes(not)).map((r) => r.style)
      const tint = document.getElementById('sl-tint') as HTMLInputElement
      const gradRule = rules.find((r) => r.selectorText.includes('.grad::-webkit-slider-runnable-track'))
      return {
        track: find('::-webkit-slider-runnable-track').map((s) => s.height),
        thumb: find('::-webkit-slider-thumb:not(:hover)', '.grad').concat(find('input[type="range"]::-webkit-slider-thumb')).map((s) => [s.width, s.height, s.borderRadius]),
        tintClass: tint.className,
        tintVar: tint.style.getPropertyValue('--grad'),
        gradTrack: gradRule?.style.height ?? '',
      }
    })
    expect(info.track).toContain('2px')
    expect(info.thumb.some(([w, h, r]) => w === '12px' && h === '12px' && /50%/.test(r))).toBe(true)
    expect(info.tintClass).toContain('grad')
    // green at the left, magenta at the right
    expect(info.tintVar).toMatch(/linear-gradient\(to right, #1fd16a/)
    expect(info.tintVar.indexOf('#1fd16a')).toBeLessThan(info.tintVar.indexOf('#e23bd0'))
    expect(info.gradTrack).toBe('2px')
  })

  test('LY4 the colour mixer tabs and the crop grid choices stay on one line, whole', async ({ page }) => {
    await page.setViewportSize({ width: 1100, height: 800 })
    await open(page)
    await cells(page).first().click()
    await page.keyboard.press('d')
    const group = page.getByRole('group', { name: 'Colour mixer adjustment' })
    await expect(group).toBeVisible()
    const tops = await group.getByRole('button').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))
    expect(new Set(tops).size, 'the three tabs share one line').toBe(1)
    const clipped = await group.getByRole('button').evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length)
    expect(clipped).toBe(0)
  })

  test('LY5 the buttons beside a panel name stay inside the panel, in every panel of Develop and Retouch', async ({ page }) => {
    await open(page)
    await cells(page).first().click()
    await page.keyboard.press('d')
    await expect(page.getByRole('toolbar', { name: 'Develop tools' })).toBeVisible()
    for (const tab of ['Develop', 'Retouch']) {
      await page.getByRole('tab', { name: tab }).click()
      const outside = await page.evaluate(() => {
        const bad: string[] = []
        for (const head of Array.from(document.querySelectorAll('.phead'))) {
          const r = head.getBoundingClientRect()
          for (const b of Array.from(head.querySelectorAll('button'))) {
            const q = b.getBoundingClientRect()
            if (q.width > 0 && (q.right > r.right + 1 || q.left < r.left - 1)) bad.push((head.textContent || '').slice(0, 30) + ' > ' + (b.textContent || ''))
          }
        }
        return bad
      })
      expect(outside, tab).toEqual([])
    }
  })

  test('LY6 moving the pointer over the picture does not change the size of the bar or the picture', async ({ page }) => {
    await open(page)
    await cells(page).first().click()
    await page.keyboard.press('d')
    const bar = page.getByRole('toolbar', { name: 'Develop tools' })
    await expect(bar).toBeVisible()
    const stage = page.getByRole('region', { name: 'Edit', exact: true })
    const before = { bar: (await bar.boundingBox())!, stage: (await stage.boundingBox())! }
    const s = before.stage
    await page.mouse.move(s.x + s.width / 2, s.y + s.height / 3)
    await page.mouse.move(s.x + s.width / 2 + 30, s.y + s.height / 3 + 10)
    await expect(bar.locator('.readout')).toBeVisible() // the colour under the pointer is shown
    const after = { bar: (await bar.boundingBox())!, stage: (await stage.boundingBox())! }
    expect(after.bar.height).toBe(before.bar.height)
    expect(after.bar.y).toBe(before.bar.y)
    expect(after.stage.height).toBe(before.stage.height)
    const picture = page.locator('.stage img, .stage canvas').first()
    const p0 = (await picture.boundingBox())!
    await page.mouse.move(s.x + s.width / 2 - 40, s.y + s.height / 3 + 40)
    const p1 = (await picture.boundingBox())!
    expect([p1.x, p1.y, p1.width, p1.height]).toEqual([p0.x, p0.y, p0.width, p0.height])
  })

  test('LY7 the crop grid choices are in rows of three, and every word is whole', async ({ page }) => {
    await open(page)
    await cells(page).first().click()
    await page.keyboard.press('d')
    const group = page.getByRole('group', { name: 'Grid', exact: true })
    await group.scrollIntoViewIfNeeded()
    await expect(group).toBeVisible()
    const buttons = group.getByRole('button')
    await expect(buttons).toHaveCount(6)
    const tops = await buttons.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))
    expect([...new Set(tops)].length, 'three rows').toBe(3)
    const clipped = await buttons.evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.textContent))
    expect(clipped).toEqual([])
    const names = await buttons.allInnerTexts()
    expect(names.join('|')).toMatch(/Thirds.*Golden.*Diagonal.*Fine.*None/)
  })

  test('LY8 Basic\'s Auto tone, Auto WB and Reset are on a row under the panel name, not beside it', async ({ page }) => {
    await open(page)
    await cells(page).first().click()
    await page.keyboard.press('d')
    const panel = page.locator('section.panel', { has: page.getByRole('button', { name: 'Auto tone' }) })
    const head = (await panel.locator('.phead').boundingBox())!
    await expect(panel.locator('.phead').getByRole('button', { name: /Auto|Reset/ })).toHaveCount(0)
    for (const name of ['Auto tone', 'Auto WB', 'Reset']) {
      const b = (await panel.getByRole('button', { name, exact: true }).boundingBox())!
      expect(b.y, name).toBeGreaterThanOrEqual(head.y + head.height - 1)
      expect(b.x + b.width, name).toBeLessThanOrEqual(head.x + head.width + 1)
    }
    const tops = await panel.getByRole('group', { name: 'Basic tools' }).getByRole('button').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)))
    expect(new Set(tops).size, 'one row').toBe(1)
  })
})
