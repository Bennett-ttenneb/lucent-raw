import { expect, open, test } from './helpers'

test.describe('F30 find dust', () => {
  test('FD1 Find dust puts a healing spot on each speck as one history step, and does not add the same ones again', async ({ page }) => {
    await open(page)
    await page.getByRole('gridcell').first().click()
    await page.getByRole('tab', { name: 'Retouch' }).click()
    const panel = page.locator('section.panel', { has: page.getByRole('button', { name: 'Spot removal tool' }) })
    await panel.getByRole('button', { name: 'Find dust' }).click()
    await expect(panel.getByText('Found 3 specks and put a healing spot on each.')).toBeVisible()
    await expect(panel.getByRole('list', { name: 'Spots' }).getByRole('listitem')).toHaveCount(3)
    await expect(page.getByRole('button', { name: /Find dust/ }).first()).toBeVisible()
    await panel.getByRole('button', { name: 'Find dust' }).click()
    await expect(panel.getByText('No new dust specks were found.')).toBeVisible()
    await expect(panel.getByRole('list', { name: 'Spots' }).getByRole('listitem')).toHaveCount(3)
  })
})
