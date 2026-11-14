import AxeBuilder from '@axe-core/playwright'
import { expect, open, test } from './helpers'
import type { Page } from '@playwright/test'

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Missing photos' })
const openMissing = async (page: Page, query = '') => {
  await open(page, query)
  await page.locator('.catalog-chip').click()
  await page.getByRole('dialog', { name: 'Catalogs' }).getByRole('button', { name: 'Find missing photos…' }).click()
  await expect(dialog(page)).toBeVisible()
  return dialog(page)
}

test.describe('F16 missing photos', () => {
  test('MS1 when nothing is missing it says so', async ({ page }) => {
    const dlg = await openMissing(page)
    await expect(dlg.getByText('Nothing is missing.')).toBeVisible()
    await expect(dlg.getByText(/All 298 photos are where the catalog expects them/)).toBeVisible()
    await expect(dlg.getByRole('button', { name: 'Search a folder for them…' })).toHaveCount(0)
  })

  test('MS2 missing photos are listed by folder, saying whether the folder itself is there', async ({ page }) => {
    const dlg = await openMissing(page, '?missing=1')
    await expect(dlg.getByText('122 photos missing')).toBeVisible()
    const list = dlg.getByRole('list', { name: 'Folders with missing photos' })
    await expect(list.getByRole('listitem')).toHaveCount(2)
    await expect(list.getByText('E:/Photos 2024')).toBeVisible()
    await expect(list.getByText(/All 120 photos missing/)).toBeVisible()
    await expect(list.getByText(/The folder is not there: it was moved or renamed/)).toBeVisible()
    await expect(list.getByText(/2 of 40 photos missing/)).toBeVisible()
    await expect(list.getByText(/The folder is there, so some files were moved or deleted/)).toBeVisible()
  })

  test('MS3 saying where a folder went shows how many are there first, and only then connects them', async ({ page }) => {
    const dlg = await openMissing(page, '?missing=1')
    await dlg.getByRole('button', { name: 'Say where E:/Photos 2024 went' }).click()
    await expect(dlg.getByText(/120 of 120 photos are in/)).toBeVisible()
    await expect(dlg.getByText('122 photos missing')).toBeVisible() // nothing changed yet
    await dlg.getByRole('button', { name: 'Use this folder' }).click()
    await expect(dlg.getByText('2 photos missing')).toBeVisible()
    await expect(dlg.getByText(/The folder now points at/)).toBeVisible()
    await expect(dlg.getByRole('list', { name: 'Folders with missing photos' }).getByRole('listitem')).toHaveCount(1)
  })

  test('MS4 a place that has none of the photos offers no way to use it, and cancelling changes nothing', async ({ page }) => {
    const dlg = await openMissing(page, '?missing=1&pick=C:/empty')
    await dlg.getByRole('button', { name: 'Say where E:/Photos 2024 went' }).click()
    await expect(dlg.getByText(/None of this folder's photos are in C:\/empty/)).toBeVisible()
    await expect(dlg.getByRole('button', { name: 'Use this folder' })).toHaveCount(0)
    await dlg.getByRole('button', { name: 'Cancel' }).click()
    await expect(dlg.getByText('122 photos missing')).toBeVisible()
  })

  test('MS5 searching a folder reconnects what it finds and says what is still missing', async ({ page }) => {
    const dlg = await openMissing(page, '?missing=1')
    await dlg.getByRole('button', { name: 'Search a folder for them…' }).click()
    await expect(dlg.getByText(/Found and reconnected 2 photos\. 120 photos still missing\./)).toBeVisible()
    await expect(dlg.getByText('120 photos missing', { exact: true })).toBeVisible()
  })

  test('MS6 Look again checks the files again, and the dialog has no accessibility violations', async ({ page }) => {
    const dlg = await openMissing(page, '?missing=1')
    await dlg.getByRole('button', { name: 'Look again' }).click()
    await expect(dlg.getByText('122 photos missing')).toBeVisible()
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
  })
})
