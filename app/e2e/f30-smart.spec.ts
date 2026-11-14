import { expect, open, test } from './helpers'

test.describe('F30 smart previews', () => {
  test('SP1 Preferences builds smart previews for every photo that has its file, says how many and how much room, and a second press finds nothing left to do', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: 'Preferences' }).click()
    const prefs = page.getByRole('dialog', { name: 'Preferences' })
    await expect(prefs.getByText('No photo has a smart preview yet.')).toBeVisible()
    await prefs.getByRole('button', { name: 'Build smart previews for all photos' }).click()
    await expect(prefs.getByText(/\d+ smart previews? made\./)).toBeVisible()
    await expect(prefs.getByText(/photos? of \d+ (has|have) a smart preview, taking/)).toBeVisible()
    await prefs.getByRole('button', { name: 'Build smart previews for all photos' }).click()
    await expect(prefs.getByText('Every photo that can have one already has a smart preview.')).toBeVisible()
  })
})
