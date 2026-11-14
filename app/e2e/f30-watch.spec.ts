import { expect, open, test } from './helpers'

test.describe('F30 watched folder', () => {
  test('WF1 Preferences can watch a folder, asks for a filing folder when photos are moved, can stop, and is remembered', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: 'Preferences' }).click()
    const prefs = page.getByRole('dialog', { name: 'Preferences' })
    await expect(prefs.getByText('None: nothing is watched')).toBeVisible()
    await prefs.getByRole('group', { name: /Watched folder/ }).getByRole('button', { name: 'Choose folder…' }).click()
    await expect(prefs.getByText(/Watching\. 5 photos imported since it was switched on\./)).toBeVisible()
    await prefs.getByLabel('What to do with them').selectOption('move')
    await expect(prefs.getByRole('alert').filter({ hasText: 'Choose the folder the photos are to be filed in.' })).toBeVisible()
    await prefs.getByRole('button', { name: 'Choose folder…' }).last().click()
    await expect(prefs.getByRole('alert').filter({ hasText: 'Choose the folder' })).toHaveCount(0)
    const sent = () => page.evaluate(() => (globalThis as { __watch?: unknown[] }).__watch)
    expect((await sent())!.at(-1)).toEqual({ folder: 'C:/Demo/Card', mode: 'move', destination: 'C:/Demo/Library' })
    await page.reload()
    expect((await sent())!.at(-1)).toEqual({ folder: 'C:/Demo/Card', mode: 'move', destination: 'C:/Demo/Library' }) // sent to the core again at start-up
    await page.getByRole('button', { name: 'Preferences' }).click()
    await prefs.getByRole('button', { name: 'Stop watching' }).click()
    await expect(prefs.getByText('None: nothing is watched')).toBeVisible()
    expect((await sent())!.at(-1)).toBeNull()
  })
})
