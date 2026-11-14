import { expect, open, test } from './helpers'

test.describe('F30 tether view', () => {
  test('TV1 with the tick on, a photo that arrives in the watched folder is shown big at once; with it off nothing moves', async ({ page }) => {
    await open(page)
    const emit = (id: number) => page.evaluate((i) => (window as unknown as { __emit: (e: string, p: unknown) => void }).__emit('watch:newest', i), id)
    await emit(9)
    await page.waitForTimeout(400)
    await expect(page.locator('.loupe')).toHaveCount(0)
    await page.getByRole('button', { name: 'Preferences' }).click()
    const prefs = page.getByRole('dialog', { name: 'Preferences' })
    await prefs.getByRole('group', { name: /Watched folder/ }).getByRole('button', { name: 'Choose folder…' }).click()
    await prefs.getByRole('checkbox', { name: /Show each new photo big as it arrives/ }).check()
    await page.keyboard.press('Escape')
    await emit(9)
    await expect(page.locator('.loupe')).toBeVisible()
    await expect(page.getByText(/IMG_1009\.jpg/).first()).toBeVisible()
  })
})
