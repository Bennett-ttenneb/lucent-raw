import AxeBuilder from '@axe-core/playwright'
import { expect, open, test } from './helpers'
import type { Page } from '@playwright/test'

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Preferences' })
const openPrefs = async (page: Page, query = '') => {
  await open(page, query)
  await page.getByRole('button', { name: 'Preferences' }).click()
  await expect(dialog(page)).toBeVisible()
  return dialog(page)
}

test.describe('F18 preferences', () => {
  test('PF1 it says how much room the previews take and that your photos are not touched', async ({ page }) => {
    const dlg = await openPrefs(page)
    await expect(dlg.getByText(/1\.9 GB/)).toBeVisible()
    await expect(dlg.getByText(/596 preview files for 298 photos/)).toBeVisible()
    await expect(dlg.getByText('Every photo has a preview.')).toBeVisible()
    await expect(dlg.getByText(/your photos are not touched/)).toBeVisible()
  })

  test('PF2 clearing the previews needs a confirmation, and Keep them changes nothing', async ({ page }) => {
    const dlg = await openPrefs(page)
    await dlg.getByRole('button', { name: 'Clear all previews…' }).click()
    await dlg.getByRole('button', { name: 'Keep them' }).click()
    await expect(dlg.getByText(/596 preview files/)).toBeVisible()
    await dlg.getByRole('button', { name: 'Clear all previews…' }).click()
    await dlg.getByRole('button', { name: 'Yes, clear all previews' }).click()
    await expect(dlg.getByText(/0 bytes in 0 preview files for 298 photos/)).toBeVisible()
    await expect(dlg.getByText('298 photos have no preview.')).toBeVisible()
    await expect(dlg.getByText(/made again when you look at its photo/)).toBeVisible()
    await expect(dlg.getByRole('button', { name: 'Clear all previews…' })).toBeDisabled()
  })

  test('PF3 making the missing previews says how many photos it is working on, and with nothing missing says so', async ({ page }) => {
    const dlg = await openPrefs(page)
    await dlg.getByRole('button', { name: 'Make missing previews' }).click()
    await expect(dlg.getByText('Every preview is already there.')).toBeVisible()
    await dlg.getByRole('button', { name: 'Clear all previews…' }).click()
    await dlg.getByRole('button', { name: 'Yes, clear all previews' }).click()
    await dlg.getByRole('button', { name: 'Make missing previews' }).click()
    await expect(dlg.getByText(/Making previews for 298 photos in the background/)).toBeVisible()
  })

  test('PF4 the Develop choices are remembered after a reload', async ({ page }) => {
    const dlg = await openPrefs(page)
    const arrows = dlg.getByRole('checkbox', { name: /up and down arrows/ })
    await expect(arrows).not.toBeChecked()
    await arrows.check()
    await dlg.getByLabel('Grid in the crop frame').selectOption('golden')
    await page.reload()
    await page.getByRole('button', { name: 'Preferences' }).click()
    await expect(dialog(page).getByRole('checkbox', { name: /up and down arrows/ })).toBeChecked()
    await expect(dialog(page).getByLabel('Grid in the crop frame')).toHaveValue('golden')
  })

  test('PF5 the backup reminder can be turned off, and the Catalogs window then stops nagging', async ({ page }) => {
    await open(page)
    await page.locator('.catalog-chip').click()
    await expect(page.getByRole('dialog', { name: 'Catalogs' }).getByText(/worth making now/)).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Preferences' }).click()
    await dialog(page).getByLabel('Remind me to back up').selectOption('0')
    await page.keyboard.press('Escape')
    await page.locator('.catalog-chip').click()
    const cat = page.getByRole('dialog', { name: 'Catalogs' })
    await expect(cat.getByText('This catalog has never been backed up.')).toBeVisible()
    await expect(cat.getByText(/worth making now/)).toHaveCount(0)
  })

  test('PF6 About names the program, the version and what it is built with, including the library that asks for more than a notice', async ({ page }) => {
    const dlg = await openPrefs(page)
    await expect(dlg.getByText(/^Lucent Raw version 0\.1\.0/)).toBeVisible()
    await dlg.getByText('Privacy policy', { exact: true }).click()
    await expect(dlg.getByText(/bbotnicsindustries@gmail\.com/).first()).toBeVisible()
    await dlg.getByText('Terms and conditions', { exact: true }).click()
    await expect(dlg.getByText(/A licence key is bought/)).toBeVisible()
    const list = dlg.getByRole('list', { name: 'What Lucent Raw is built with' })
    await expect(list.getByRole('listitem')).toHaveCount(7)
    await expect(list.getByText(/rawler for reading RAW files: LGPL-2\.1/)).toBeVisible()
  })

  test('PF7 the window has no accessibility violations', async ({ page }) => {
    await openPrefs(page)
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
  })
})
