import { expect, open, test } from './helpers'

test.describe('F30 export details', () => {
  test('ED1 the Export window can ask for the copyright details or everything to be written into the file, and says which kinds of file can carry them', async ({ page }) => {
    await open(page)
    await page.getByRole('gridcell').first().click()
    await page.getByRole('button', { name: 'Export…' }).click()
    const dlg = page.getByRole('dialog', { name: 'Export photos' })
    await expect(dlg.getByLabel('Details in the file', { exact: true })).toHaveValue('none')
    await dlg.getByLabel('Details in the file', { exact: true }).selectOption('all')
    await dlg.getByRole('button', { name: 'Choose folder…' }).click()
    await dlg.getByRole('button', { name: 'Export', exact: true }).click()
    await expect(dlg.getByText('Wrote 1 file.')).toBeVisible()
    const sent = await page.evaluate(() => (globalThis as { __exports?: { settings: { metadata: string } }[] }).__exports)
    expect(sent!.at(-1)!.settings.metadata).toBe('all')
    await dlg.getByRole('button', { name: 'Done' }).click()
    await page.getByRole('button', { name: 'Export…' }).click()
    await dlg.getByLabel('Format').selectOption('tiff')
    await expect(dlg.getByLabel('Details in the file', { exact: true })).toBeDisabled()
    await expect(dlg.getByText('Only JPEG and PNG files can carry them here.')).toBeVisible()
  })
})
