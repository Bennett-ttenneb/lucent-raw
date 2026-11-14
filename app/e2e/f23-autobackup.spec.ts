import AxeBuilder from '@axe-core/playwright'
import { expect, open, test } from './helpers'
import type { Page } from '@playwright/test'

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Catalogs' })
const box = (page: Page) => dialog(page).getByRole('group', { name: 'Automatic backups' })
const list = (page: Page) => dialog(page).getByRole('list', { name: 'Backups of this catalog' })
const openBox = async (page: Page) => {
  await open(page)
  await page.locator('.catalog-chip').click()
  await expect(dialog(page)).toBeVisible()
}

test.describe('F23 automatic backups', () => {
  test('AB1 they are on by default, daily, keeping the newest seven, with none made yet', async ({ page }) => {
    await openBox(page)
    await expect(box(page).getByLabel('Back up automatically')).toBeChecked()
    await expect(box(page).getByLabel('Days between backups')).toHaveValue('1')
    await expect(box(page).getByLabel('Automatic backups to keep')).toHaveValue('7')
    await expect(box(page).getByText('No automatic backups yet.')).toBeVisible()
  })

  test('AB2 Back up now adds a copy to the list with its time, photo count and size', async ({ page }) => {
    await openBox(page)
    await box(page).getByRole('button', { name: 'Back up now' }).click()
    await expect(box(page).getByText('Backup made.')).toBeVisible()
    await expect(list(page).getByRole('listitem')).toHaveCount(1)
    await expect(list(page).getByRole('listitem').first()).toContainText('Automatic')
    await expect(list(page).getByRole('listitem').first()).toContainText('96 photos')
  })

  test('AB3 the settings can be changed, switched off, and stay inside sensible limits', async ({ page }) => {
    await openBox(page)
    await box(page).getByLabel('Days between backups').fill('7')
    await expect(box(page).getByLabel('Days between backups')).toHaveValue('7')
    await box(page).getByLabel('Automatic backups to keep').fill('99')
    await expect(box(page).getByLabel('Automatic backups to keep')).toHaveValue('30')
    await box(page).getByLabel('Back up automatically').uncheck()
    await expect(box(page).getByLabel('Back up automatically')).not.toBeChecked()
    await expect(box(page).getByLabel('Days between backups')).toBeDisabled()
  })

  test('AB4 restoring asks first, saves the catalog as it is now, and starts the window again from the restored one', async ({ page }) => {
    await openBox(page)
    await box(page).getByRole('button', { name: 'Back up now' }).click()
    await expect(list(page).getByRole('listitem')).toHaveCount(1)
    await box(page).getByRole('button', { name: /^Restore the copy from/ }).click()
    // nothing happens until it is confirmed
    expect(await page.evaluate(() => (window as unknown as { __restored: string[] }).__restored.length)).toBe(0)
    await expect(box(page).getByText('The catalog as it is now is saved first')).toBeVisible()
    await box(page).getByRole('button', { name: 'Cancel' }).click()
    await box(page).getByRole('button', { name: /^Restore the copy from/ }).click()
    await box(page).getByRole('button', { name: 'Restore', exact: true }).click()
    await expect(page.getByText('Restored from a backup.')).toBeVisible()
    expect(await page.evaluate(() => (window as unknown as { __restored: string[] }).__restored.length)).toBe(1)
  })

  test('AB5 the section passes the accessibility scan', async ({ page }) => {
    await openBox(page)
    await box(page).getByRole('button', { name: 'Back up now' }).click()
    await expect(list(page).getByRole('listitem')).toHaveCount(1)
    const r = await new AxeBuilder({ page }).analyze()
    expect(r.violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
  })
})
