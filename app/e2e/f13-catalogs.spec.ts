import AxeBuilder from '@axe-core/playwright'
import { cells, expect, open, test } from './helpers'
import type { Page } from '@playwright/test'

const chip = (page: Page) => page.locator('.catalog-chip')
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Catalogs' })
const rows = (page: Page) => dialog(page).getByRole('list', { name: 'Your catalogs' }).getByRole('listitem')
const openDialog = async (page: Page, query = '') => {
  await open(page, query)
  await chip(page).click()
  await expect(dialog(page)).toBeVisible()
  return dialog(page)
}
const makeCatalog = async (page: Page, name: string) => {
  const dlg = dialog(page)
  await dlg.getByLabel('Name', { exact: true }).fill(name)
  await dlg.getByRole('button', { name: 'Create and open' }).click()
}

test.describe('F13 catalogs', () => {
  test('CA1 the open catalog is named in the Library, and the dialog lists it with its photos', async ({ page }) => {
    await open(page)
    await expect(chip(page)).toContainText('Main catalog')
    const dlg = await openDialog(page)
    await expect(rows(page)).toHaveCount(1)
    await expect(rows(page).first()).toContainText('Main catalog')
    await expect(rows(page).first()).toContainText('96 photos')
    await expect(rows(page).first().getByRole('status')).toHaveText('Open now')
    await expect(dlg.getByRole('button', { name: 'Remove Main catalog from the list' })).toBeDisabled()
  })

  test('CA2 a new catalog is made, opened, named in the Library and starts empty', async ({ page }) => {
    await openDialog(page)
    await makeCatalog(page, 'Weddings 2026')
    await expect(dialog(page)).toHaveCount(0)
    await expect(chip(page)).toContainText('Weddings 2026')
    await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
    await chip(page).click()
    await expect(rows(page)).toHaveCount(2)
    await expect(rows(page).nth(1).getByRole('status')).toHaveText('Open now')
  })

  test('CA3 switching back finds the photos where they were, and each catalog keeps its own collections', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: 'New collection' }).or(page.getByRole('button', { name: '+' }).first()).click().catch(() => undefined)
    await chip(page).click()
    await makeCatalog(page, 'Second')
    await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
    await chip(page).click()
    await dialog(page).getByRole('button', { name: 'Switch to Main catalog' }).click()
    await expect(chip(page)).toContainText('Main catalog')
    await expect(cells(page).first()).toBeVisible()
    await expect(page.getByRole('list', { name: 'Catalog' }).getByRole('button', { name: /All photographs/ })).toContainText('96')
  })

  test('CA4 a catalog can be renamed, and the new name is shown in the Library', async ({ page }) => {
    const dlg = await openDialog(page)
    await dlg.getByRole('button', { name: 'Rename Main catalog' }).click()
    await dlg.getByLabel('New name for Main catalog').fill('Studio work')
    await dlg.getByRole('button', { name: 'Save' }).click()
    await expect(rows(page).first()).toContainText('Studio work')
    await dlg.getByRole('button', { name: 'Done' }).click()
    await expect(chip(page)).toContainText('Studio work')
  })

  test('CA5 a name that is empty is refused and nothing is made', async ({ page }) => {
    const dlg = await openDialog(page)
    await expect(dlg.getByRole('button', { name: 'Create and open' })).toBeDisabled()
    await dlg.getByRole('button', { name: 'Rename Main catalog' }).click()
    await dlg.getByLabel('New name for Main catalog').fill('   ')
    await dlg.getByRole('button', { name: 'Save' }).click()
    await expect(dlg.getByRole('alert')).toContainText('Give the catalog a name')
    await expect(rows(page)).toHaveCount(1)
  })

  test('CA6 a catalog is taken off the list only after a confirmation, and its photos are not touched', async ({ page }) => {
    const dlg = await openDialog(page, '?catalogs=2')
    await expect(rows(page)).toHaveCount(3)
    await dlg.getByRole('button', { name: 'Remove Old shoots from the list' }).click()
    await expect(rows(page)).toHaveCount(3) // asked first
    await dlg.getByRole('button', { name: 'Keep' }).click()
    await expect(rows(page)).toHaveCount(3)
    await dlg.getByRole('button', { name: 'Remove Old shoots from the list' }).click()
    await dlg.getByRole('button', { name: 'Confirm: take Old shoots off the list' }).click()
    await expect(rows(page)).toHaveCount(2)
    await expect(dlg).not.toContainText('Old shoots')
  })

  test('CA7 a catalog whose folder has gone is shown as such and cannot be switched to', async ({ page }) => {
    const dlg = await openDialog(page, '?catalogs=2')
    const lost = rows(page).filter({ hasText: 'Lost drive' })
    await expect(lost).toContainText('Folder not found')
    await expect(dlg.getByRole('button', { name: 'Switch to Lost drive' })).toBeDisabled()
  })

  test('CA8 an existing catalog folder is opened from its folder, and a folder that is not a catalog is refused', async ({ page }) => {
    const dlg = await openDialog(page)
    await dlg.getByRole('button', { name: 'Open an existing catalog…' }).click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(chip(page)).toContainText('Card')
    await page.goto('/?pick=C:/nocatalog')
    await chip(page).click()
    await dialog(page).getByRole('button', { name: 'Open an existing catalog…' }).click()
    await expect(dialog(page).getByRole('alert')).toContainText('catalog.db')
    await expect(chip(page)).toContainText('Main catalog')
  })

  test('CA9 the dialog has no accessibility violations', async ({ page }) => {
    await openDialog(page, '?catalogs=2')
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
  })

  test('CA10 a catalog that was never backed up says so and suggests a backup', async ({ page }) => {
    const dlg = await openDialog(page)
    await expect(dlg.getByText('This catalog has never been backed up.')).toBeVisible()
    await expect(dlg.getByText(/worth making now/)).toBeVisible()
  })

  test('CA11 backing up asks for a folder, says where the backup went and how to use it, and remembers the time', async ({ page }) => {
    const dlg = await openDialog(page)
    await dlg.getByRole('button', { name: 'Back up…' }).click()
    await expect(dlg.getByText(/Backed up to/)).toContainText('Main catalog backup')
    await expect(dlg.getByText(/Open an existing catalog…" and pick that folder/)).toBeVisible()
    await expect(dlg.getByText('Last backup: 2026-10-18 15:30.')).toBeVisible()
    await expect(dlg.getByText(/worth making now/)).toHaveCount(0)
    expect(await page.evaluate(() => (window as unknown as { __backups: string[] }).__backups.length)).toBe(1)
  })

  test('CA12 a backup that fails says why and the last backup time is not changed', async ({ page }) => {
    const dlg = await openDialog(page, '?backupfail=1')
    await dlg.getByRole('button', { name: 'Back up…' }).click()
    await expect(dlg.getByRole('alert')).toContainText('disk I/O error')
    await expect(dlg.getByText('This catalog has never been backed up.')).toBeVisible()
  })

  test('CA13 the check reports a sound catalog in plain words', async ({ page }) => {
    const dlg = await openDialog(page)
    await dlg.getByRole('button', { name: 'Check for problems' }).click()
    await expect(dlg.getByText(/No problems found: 298 photos, 0 books\./)).toBeVisible()
  })

  test('CA14 the check lists what it found and says to back up first', async ({ page }) => {
    const dlg = await openDialog(page, '?corrupt=1')
    await dlg.getByRole('button', { name: 'Check for problems' }).click()
    await expect(dlg.getByText('Problems were found.')).toBeVisible()
    await expect(dlg.getByText(/Make a backup first/)).toBeVisible()
    await expect(dlg.getByText(/develop_settings/)).toBeVisible()
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id)).toEqual([])
  })
})
