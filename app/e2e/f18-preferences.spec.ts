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
    await expect(dlg.getByText(/^Lucent Raw Beta 1/)).toBeVisible()
    await dlg.getByText('Privacy policy', { exact: true }).click()
    await expect(dlg.getByText(/bbotnicsindustries@gmail\.com/).first()).toBeVisible()
    await dlg.getByText('Terms and conditions', { exact: true }).click()
    await expect(dlg.getByText(/You may use the whole program, for as long as you like, without paying/)).toBeVisible()
    const list = dlg.getByRole('list', { name: 'What Lucent Raw is built with' })
    await expect(list.getByRole('listitem')).toHaveCount(7)
    await expect(list.getByText(/rawler for reading RAW files: LGPL-2\.1/)).toBeVisible()
  })

  test('PF8 a newer version is announced in the header and in Preferences, and looking for one can be switched off', async ({ page }) => {
    // nothing newer: no notice, and Check now says so
    const dlg = await openPrefs(page)
    await expect(page.getByRole('button', { name: /is available$/ })).toHaveCount(0)
    const sw = dlg.getByRole('checkbox', { name: 'Look for a newer version when the program starts' })
    await expect(sw).toBeChecked()
    await dlg.getByRole('button', { name: 'Check now' }).click()
    await expect(dlg.getByText('You have the newest version.')).toBeVisible()
    await expect(dlg.getByText(/^Lucent Raw Beta 1/)).toBeVisible() // About names the build, not only 0.1.0
    // a newer one is published: the header says so at start, and Preferences offers its page
    const dlg2 = await openPrefs(page, '?newer=0.1.0-beta2')
    await expect(page.getByRole('button', { name: 'Beta 2 is available' })).toBeVisible()
    await expect(dlg2.getByText('Beta 2 is available.')).toBeVisible()
    await expect(dlg2.getByRole('button', { name: 'Open the download page' })).toBeVisible()
    // switched off: nothing is asked at start, so nothing is announced, until Check now is pressed
    await dlg2.getByRole('checkbox', { name: 'Look for a newer version when the program starts' }).uncheck()
    const dlg3 = await openPrefs(page, '?newer=0.1.0-beta2')
    await expect(page.getByRole('button', { name: /is available$/ })).toHaveCount(0)
    await expect(dlg3.getByRole('checkbox', { name: 'Look for a newer version when the program starts' })).not.toBeChecked()
    await dlg3.getByRole('button', { name: 'Check now' }).click()
    await expect(dlg3.getByText('Beta 2 is available.')).toBeVisible()
  })

  test('PF9 the Buy the developer a coffee button is in the header and under Licence when there is a donation page, and nowhere when there is not', async ({ page }) => {
    // none by default
    const dlg = await openPrefs(page)
    await expect(page.getByRole('button', { name: /Buy the developer a coffee/ })).toHaveCount(0)
    // a free program says so and asks for nothing: no key box
    const free = await openPrefs(page, '?licence=free&donate=1')
    await expect(free.getByText('Lucent Raw is free to use, and nothing is locked. No licence key is needed.')).toBeVisible()
    await expect(free.getByRole('textbox', { name: 'Licence key' })).toHaveCount(0)
    await expect(free.getByRole('button', { name: /Buy the developer a coffee/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /Buy the developer a coffee/ })).toHaveCount(2) // the header and Preferences
    expect(dlg).toBeTruthy()
  })

  test('PF7 the window has no accessibility violations', async ({ page }) => {
    await openPrefs(page)
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
  })
})
