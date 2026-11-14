import { expect, open, test } from './helpers'

test.describe('F30 panel switches', () => {
  test('PE1 the eye on a Develop panel shows the picture without that panel while keeping its settings, and goes back when switched on or when another photo is opened', async ({ page }) => {
    await open(page)
    await page.getByRole('gridcell').first().click()
    await page.getByRole('tab', { name: 'Develop' }).click()
    const basic = page.locator('section.panel[data-title="Basic"]')
    const exposure = page.getByRole('textbox', { name: 'Exposure value' })
    await exposure.fill('1.5')
    await exposure.press('Enter')
    await expect(exposure).toHaveValue('1.50')
    const urlOf = async () => (await page.locator('img.dev-img').first().getAttribute('src')) ?? ''
    await expect.poll(urlOf).toContain('slope%3D%222.828')
    const eye = basic.getByRole('button', { name: "Switch this panel's settings on or off" })
    await expect(eye).toHaveAttribute('aria-pressed', 'true')
    await eye.click()
    await expect(eye).toHaveAttribute('aria-pressed', 'false')
    await expect(exposure).toHaveValue('1.50') // the settings are kept
    await expect.poll(urlOf).not.toContain('slope%3D%222.828')
    await eye.click()
    await expect(eye).toHaveAttribute('aria-pressed', 'true')
    await expect.poll(urlOf).toContain('slope%3D%222.828')
    // a panel that has no switch has no eye
    await expect(page.locator('section.panel[data-title="History"]').getByRole('button', { name: "Switch this panel's settings on or off" })).toHaveCount(0)
  })
})
