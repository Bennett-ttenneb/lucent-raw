import AxeBuilder from '@axe-core/playwright'
import { cells, expect, open, test } from './helpers'
import type { Page } from '@playwright/test'

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Sidecar files' })
const openSidecars = async (page: Page, query = '') => {
  await open(page, query)
  await page.locator('.catalog-chip').click()
  await page.getByRole('dialog', { name: 'Catalogs' }).getByRole('button', { name: 'Sidecar files…' }).click()
  await expect(dialog(page)).toBeVisible()
  return dialog(page)
}

test.describe('F17 sidecar files', () => {
  test('SC1 it explains what a sidecar is, and says how many photos are waiting', async ({ page }) => {
    const dlg = await openSidecars(page)
    await expect(dlg.getByText(/name\.xmp/)).toBeVisible()
    await expect(dlg.getByText('12 photos changed since their sidecar was written.')).toBeVisible()
    await expect(dlg.getByRole('checkbox', { name: /Write sidecar files by themselves/ })).not.toBeChecked()
  })

  test('SC2 writing the changed photos says how many were written, and then nothing is waiting', async ({ page }) => {
    const dlg = await openSidecars(page)
    await dlg.getByRole('button', { name: 'Write', exact: true }).click()
    await expect(dlg.getByText('Wrote 12 files.')).toBeVisible()
    await expect(dlg.getByText('Every sidecar is up to date.')).toBeVisible()
  })

  test('SC3 a sidecar from another program is reported as left alone, with its name', async ({ page }) => {
    const dlg = await openSidecars(page, '?xmpforeign=1')
    await dlg.getByLabel('For', { exact: false }).first().selectOption('all')
    await dlg.getByRole('button', { name: 'Write', exact: true }).click()
    await expect(dlg.getByText(/2 sidecars left alone because a file from another program is already there/)).toBeVisible()
    await expect(dlg.getByText(/IMG_0001\.xmp, IMG_0007\.xmp/)).toBeVisible()
  })

  test('SC4 a write that fails is said in words with the file and the reason', async ({ page }) => {
    const dlg = await openSidecars(page, '?xmpfail=1')
    await dlg.getByRole('button', { name: 'Write', exact: true }).click()
    await expect(dlg.getByRole('alert')).toContainText('could not be written')
    await expect(dlg.getByRole('alert')).toContainText('IMG_0002.jpg: Access is denied')
  })

  test('SC5 "the selected photos" needs a selection, and then writes for them', async ({ page }) => {
    await open(page)
    await cells(page).nth(0).click()
    await cells(page).nth(1).click({ modifiers: ['Shift'] })
    await page.locator('.catalog-chip').click()
    await page.getByRole('dialog', { name: 'Catalogs' }).getByRole('button', { name: 'Sidecar files…' }).click()
    const dlg = dialog(page)
    await dlg.locator('#xmp-w').selectOption('selected')
    await dlg.getByRole('button', { name: 'Write', exact: true }).click()
    await expect(dlg.getByText('Wrote 2 files.')).toBeVisible()
  })

  test('SC6 reading shows what differs first and changes the catalog only after the button is pressed', async ({ page }) => {
    const dlg = await openSidecars(page)
    await dlg.getByRole('button', { name: 'Look at the sidecars' }).click()
    await expect(dlg.getByText(/40 sidecar files found; 3 differ from the catalog: rating \(2\), keywords \(1\)/)).toBeVisible()
    await expect(dlg.getByText(/Updated/)).toHaveCount(0)
    await dlg.getByRole('button', { name: 'Update 3 photos from their sidecars' }).click()
    await expect(dlg.getByText('Updated 3 photos from their sidecars.')).toBeVisible()
  })

  test('SC7 a sidecar that cannot be read is listed and skipped', async ({ page }) => {
    const dlg = await openSidecars(page, '?xmpforeign=1')
    await dlg.getByRole('button', { name: 'Look at the sidecars' }).click()
    await expect(dlg.getByText(/1 sidecar could not be read and will be skipped/)).toBeVisible()
    await expect(dlg.getByText(/IMG_0009\.jpg\.xmp: it is not readable as XMP/)).toBeVisible()
  })

  test('SC8 switching the automatic writing on is kept, and a problem it had is shown', async ({ page }) => {
    const dlg = await openSidecars(page, '?xmpfail=1')
    const auto = dlg.getByRole('checkbox', { name: /Write sidecar files by themselves/ })
    await auto.check()
    await expect(auto).toBeChecked()
    await expect(dlg.getByRole('alert')).toContainText('The last automatic write had a problem: Access is denied.')
  })

  test('SC9 the dialog has no accessibility violations', async ({ page }) => {
    const dlg = await openSidecars(page)
    await dlg.getByRole('button', { name: 'Look at the sidecars' }).click()
    await expect(dlg.getByText(/found;/)).toBeVisible()
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
  })
})
