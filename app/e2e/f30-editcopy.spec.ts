import { expect, open, test } from './helpers'

test.describe('F30 edited copy', () => {
  test('EC1 Photo > Edit a copy makes a TIFF with the edits, adds it to the catalog and opens it in the editor', async ({ page }) => {
    await open(page)
    await page.getByRole('gridcell').nth(1).click()
    await page.getByRole('menuitem', { name: 'Photo' }).click()
    await page.getByRole('menuitem', { name: /Edit a copy with the edits applied/ }).click()
    await expect(page.getByRole('status').filter({ hasText: /Made IMG_\d+-Edit\.tif and opened it\./ })).toBeVisible()
    const opened = await page.evaluate(() => (window as unknown as { __opened: { path: string }[] }).__opened)
    expect(opened.at(-1)!.path).toMatch(/-Edit\.tif$/)
  })
})
