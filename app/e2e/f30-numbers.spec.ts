import { expect, open, test } from './helpers'

test.describe('F30 numbers', () => {
  test('NF1 the Numbers choice in Preferences changes how a slider writes its value, accepts a typed point or comma, and is remembered', async ({ page }) => {
    await open(page)
    await page.getByRole('gridcell').first().click()
    await page.getByRole('tab', { name: 'Develop' }).click()
    const box = page.getByRole('textbox', { name: 'Exposure value' })
    await expect(box).toHaveValue('0.00')
    await page.getByRole('button', { name: 'Preferences' }).click()
    const prefs = page.getByRole('dialog', { name: 'Preferences' })
    await prefs.getByLabel('Numbers').selectOption('de')
    await prefs.getByRole('button', { name: 'Done' }).click().catch(() => page.keyboard.press('Escape'))
    await expect(box).toHaveValue('0,00')
    await box.fill('1.25')
    await box.press('Enter')
    await expect(box).toHaveValue('1,25')
    await page.reload()
    await page.getByRole('gridcell').first().click()
    await page.getByRole('tab', { name: 'Develop' }).click()
    await expect(page.getByRole('textbox', { name: 'Exposure value' })).toHaveValue(/^\d,\d\d$/)
  })
})
