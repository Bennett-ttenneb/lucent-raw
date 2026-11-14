import { expect, open, test } from './helpers'

test.describe('F30 profiles', () => {
  test('PR1 the Basic panel names the profile, Browse shows the photo in every profile, choosing one is a history step with an amount, and the sliders still work', async ({ page }) => {
    await open(page)
    await page.getByRole('gridcell').first().click()
    await page.getByRole('tab', { name: 'Develop' }).click()
    const basic = page.locator('section.panel[data-title="Basic"]')
    await expect(basic.getByRole('status').filter({ hasText: 'Standard' })).toBeVisible()
    await expect(basic.getByRole('textbox', { name: 'Profile amount value' })).toHaveCount(0)
    await basic.getByRole('button', { name: 'Browse profiles…' }).click()
    const dlg = page.getByRole('dialog', { name: 'Profiles' })
    await expect(dlg.getByRole('listitem')).toHaveCount(7)
    await expect(dlg.locator('img').first()).toBeVisible()
    await dlg.getByRole('button', { name: /^Vivid/ }).click()
    await expect(basic.getByRole('status').filter({ hasText: 'Vivid' })).toBeVisible()
    await expect(page.getByRole('button', { name: /Profile: Vivid/ })).toBeVisible()
    const src = async () => (await page.locator('img.dev-img').first().getAttribute('src')) ?? ''
    await expect.poll(src).toContain('profile-vivid')
    const amount = basic.getByRole('textbox', { name: 'Profile amount value' })
    await expect(amount).toHaveValue('100')
    await amount.fill('60')
    await amount.press('Enter')
    await expect(amount).toHaveValue('60')
    await expect(page.getByRole('button', { name: /Profile amount/ }).first()).toBeVisible()
    // the exposure slider still moves on top of the profile
    const exposure = page.getByRole('textbox', { name: 'Exposure value' })
    await exposure.fill('0.5')
    await exposure.press('Enter')
    await expect(exposure).toHaveValue('0.50')
    // Standard puts it back
    await basic.getByRole('button', { name: 'Browse profiles…' }).click()
    await dlg.getByRole('button', { name: /^Standard/ }).click()
    await expect(basic.getByRole('status').filter({ hasText: 'Standard' })).toBeVisible()
    await expect(basic.getByRole('textbox', { name: 'Profile amount value' })).toHaveCount(0)
  })
})
