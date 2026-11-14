import { expect, open, test } from './helpers'
import type { Page } from '@playwright/test'

const lights = (page: Page) => page.evaluate(() => document.documentElement.dataset.lights ?? 'on')

test.describe('F24 lights dim and out', () => {
  test('LT1 L steps on, dim, out, on; Escape brings the lights back', async ({ page }) => {
    await open(page)
    expect(await lights(page)).toBe('on')
    await page.keyboard.press('l')
    expect(await lights(page)).toBe('dim')
    await page.keyboard.press('l')
    expect(await lights(page)).toBe('out')
    await page.keyboard.press('l')
    expect(await lights(page)).toBe('on')
    await page.keyboard.press('l')
    await page.keyboard.press('Escape')
    expect(await lights(page)).toBe('on')
  })

  test('LT2 in Lights out the parts round the photo are invisible, in Lights dim they are faint, and the photo area stays', async ({ page }) => {
    await open(page)
    const bar = page.locator('.foot')
    await page.keyboard.press('l')
    expect(Number(await bar.evaluate((e) => getComputedStyle(e).opacity))).toBeLessThan(0.5)
    await page.keyboard.press('l')
    expect(await bar.evaluate((e) => getComputedStyle(e).opacity)).toBe('0')
    await expect(page.locator('.stage').first()).toBeVisible()
  })
})
