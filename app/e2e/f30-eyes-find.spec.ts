import { expect, open, test } from './helpers'

test.describe('F30 find eyes', () => {
  test('RE1 Find eyes puts a red-eye circle on each eye of the three demo faces, once', async ({ page }) => {
    await open(page)
    await page.getByRole('gridcell').first().click()
    await page.getByRole('tab', { name: 'Retouch' }).click()
    const panel = page.locator('section.panel', { has: page.getByRole('button', { name: 'Red eye tool' }) })
    await panel.getByRole('button', { name: 'Find eyes' }).click()
    await expect(panel.getByText(/Put a red-eye circle on 6 eyes/)).toBeVisible()
    await expect(panel.getByRole('list', { name: 'Red-eye fixes' }).getByRole('listitem')).toHaveCount(6)
    await panel.getByRole('button', { name: 'Find eyes' }).click()
    await expect(panel.getByText('No new eyes were found.')).toBeVisible()
  })
})
