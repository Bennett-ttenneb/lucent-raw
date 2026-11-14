import { expect, open, test } from './helpers'

test.describe('F30 catalogs share photos', () => {
  test('XC1 the selected photos are exported as a catalog, and another catalog is imported with the count of what was added and what was here already', async ({ page }) => {
    await open(page)
    const cells = page.getByRole('gridcell')
    await cells.nth(0).click()
    await cells.nth(2).click({ modifiers: ['Shift'] })
    await page.locator('.catalog-chip').click()
    const dlg = page.getByRole('dialog', { name: 'Catalogs' })
    await dlg.getByLabel('Name of the new catalog').fill('For the client')
    await dlg.getByRole('button', { name: 'Export 3 selected photos as a catalog…' }).click()
    await expect(dlg.getByText(/Made a catalog of 3 photos in C:\/Demo\/Library\/For the client\./)).toBeVisible()
    expect(await page.evaluate(() => (globalThis as { __exports?: { ids: number[]; name: string; withPreviews: boolean }[] }).__exports)).toEqual([{ ids: expect.any(Array), destination: 'C:/Demo/Library', name: 'For the client', withPreviews: true }])
    await dlg.getByRole('button', { name: 'Import from another catalog…' }).click()
    await expect(dlg.getByText('Added 12 photos from that catalog; 3 photos were here already. A backup of this catalog was made first.')).toBeVisible()
  })
})
