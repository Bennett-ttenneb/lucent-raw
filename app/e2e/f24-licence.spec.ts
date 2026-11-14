import AxeBuilder from '@axe-core/playwright'
import { expect, open, pick, test } from './helpers'
import type { Page } from '@playwright/test'

const chip = (page: Page) => page.locator('.licence-chip')
const prefs = (page: Page) => page.getByRole('dialog', { name: 'Preferences' })
const box = (page: Page) => prefs(page).getByRole('group', { name: 'Licence' })
const openPrefs = async (page: Page) => {
  await page.getByRole('button', { name: 'Preferences' }).click()
  await expect(prefs(page)).toBeVisible()
}

test.describe('F24 licence and trial', () => {
  test('LI1 a licensed copy shows no chip and says who it is licensed to, with no key box', async ({ page }) => {
    await open(page)
    await expect(chip(page)).toHaveCount(0)
    await openPrefs(page)
    await expect(box(page).getByText('Licensed to')).toBeVisible()
    await expect(box(page).getByText('does not expire')).toBeVisible()
    await expect(box(page).getByLabel('Licence key')).toHaveCount(0)
  })

  test('LI2 on trial the days left are shown beside Preferences, and Preferences says nothing is locked yet', async ({ page }) => {
    await open(page, '?licence=trial')
    await expect(chip(page)).toHaveText('Trial: 12 days left')
    await chip(page).click()
    await expect(prefs(page)).toBeVisible()
    await expect(box(page).getByText('12 days left')).toBeVisible()
    await expect(box(page).getByText('Nothing is locked now')).toBeVisible()
  })

  test('LI3 after the trial a note in Develop says edits are not saved and how to carry on', async ({ page }) => {
    await open(page, '?licence=expired')
    await expect(chip(page)).toHaveText('Trial ended')
    await pick(page, 0)
    await page.getByRole('tab', { name: 'Develop' }).click()
    const note = page.locator('.licence-banner')
    await expect(note).toContainText('Your 30 day trial has ended, so edits are not saved')
    await expect(note).toContainText('exporting, still works')
  })

  test('LI4 a key that is not a key is refused in words; a good one licenses the copy and removes the chip and the note', async ({ page }) => {
    await open(page, '?licence=expired')
    await openPrefs(page)
    await expect(box(page).getByRole('button', { name: 'Use this key' })).toBeDisabled()
    await box(page).getByLabel('Licence key').fill('hello')
    await box(page).getByRole('button', { name: 'Use this key' }).click()
    await expect(box(page).getByRole('alert')).toContainText('not a Lucent Raw licence key')
    await box(page).getByLabel('Licence key').fill('LRAW1.abc.bad')
    await box(page).getByRole('button', { name: 'Use this key' }).click()
    await expect(box(page).getByRole('alert')).toContainText('not made by Lucent Raw')
    await box(page).getByLabel('Licence key').fill('  LRAW1.abc.def\n')
    await box(page).getByRole('button', { name: 'Use this key' }).click()
    await expect(box(page).getByText('Thank you. This copy is licensed to Ada Example.')).toBeVisible()
    await expect(chip(page)).toHaveCount(0)
    await expect(box(page).getByLabel('Licence key')).toHaveCount(0)
  })

  test('LI5 the Licence section passes the accessibility scan, on trial and when ended', async ({ page }) => {
    for (const q of ['?licence=trial', '?licence=expired']) {
      await open(page, q)
      await openPrefs(page)
      const r = await new AxeBuilder({ page }).analyze()
      expect(r.violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
    }
  })
})
