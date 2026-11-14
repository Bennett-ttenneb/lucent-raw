import { expect, open, test } from './helpers'

test.describe('F30 adaptive presets', () => {
  test('AP1 an adaptive preset finds the sky or the subject, puts its adjustments on a mask of it, and says so in the history', async ({ page }) => {
    await open(page)
    await page.getByRole('gridcell').first().click()
    await page.getByRole('tab', { name: 'Develop' }).click()
    const presets = page.locator('section.panel[data-title="Presets"]')
    await presets.getByRole('button', { name: 'Sky: deeper' }).click()
    await expect(page.getByRole('button', { name: /Adaptive preset: Sky: deeper/ })).toBeVisible()
    await expect(page.locator('section.panel[data-title="Masks"]')).toContainText('Sky: deeper')
    await presets.getByRole('button', { name: 'Subject: pop' }).click()
    await expect(page.getByRole('button', { name: /Adaptive preset: Subject: pop/ })).toBeVisible()
    await expect(page.locator('section.panel[data-title="Masks"]')).toContainText('Subject: pop')
  })

  test('AP2 the preset that needs the subject model is hidden with the AI switch, the sky one is not', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('lucent.hideAi', '1'))
    await open(page)
    await page.getByRole('gridcell').first().click()
    await page.getByRole('tab', { name: 'Develop' }).click()
    const presets = page.locator('section.panel[data-title="Presets"]')
    await expect(presets.getByRole('button', { name: 'Sky: deeper' })).toBeVisible()
    await expect(presets.getByRole('button', { name: 'Subject: pop' })).toHaveCount(0)
  })
})
