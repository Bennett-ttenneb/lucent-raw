import AxeBuilder from '@axe-core/playwright'
import { cells, expect, open, test } from './helpers'
import type { Page } from '@playwright/test'

const dialog = (page: Page) => page.getByRole('dialog', { name: /smart collection/i })
const list = (page: Page) => page.getByRole('list', { name: 'Collections' })
const newSmart = async (page: Page) => {
  await page.getByRole('button', { name: 'New smart collection' }).click()
  await expect(dialog(page)).toBeVisible()
  return dialog(page)
}
const makeFives = async (page: Page, name = 'Fives') => {
  const dlg = await newSmart(page)
  await dlg.getByLabel('Name', { exact: true }).fill(name)
  await dlg.getByLabel('Value for rule 1').selectOption('5')
  await dlg.getByRole('button', { name: 'Save' }).click()
  await expect(dialog(page)).toHaveCount(0)
}

test.describe('F20 smart collections', () => {
  test('SM1 the builder starts with one rule and says how many photos meet it', async ({ page }) => {
    await open(page)
    const dlg = await newSmart(page)
    await expect(dlg.getByRole('list', { name: 'Rules' }).getByRole('listitem')).toHaveCount(1)
    await expect(dlg.getByLabel('Field for rule 1')).toHaveValue('rating')
    await expect(dlg.getByLabel('Test for rule 1')).toHaveValue('>=')
    await expect(dlg.getByText(/photos? meets? these rules now\./)).toBeVisible()
    await expect(dlg.getByText(/fills itself/)).toBeVisible()
  })

  test('SM2 a smart collection needs a name', async ({ page }) => {
    await open(page)
    const dlg = await newSmart(page)
    await dlg.getByRole('button', { name: 'Save' }).click()
    await expect(dlg.getByRole('alert')).toContainText('Give the smart collection a name.')
  })

  test('SM3 it is made, marked Smart, opened, and holds just the photos that meet the rule', async ({ page }) => {
    await open(page)
    await cells(page).first().click()
    await page.keyboard.press('5')
    await makeFives(page)
    const item = list(page).getByRole('button', { name: /Fives/ })
    await expect(item).toContainText('Smart')
    await expect(item).toHaveAttribute('aria-current', 'true')
    await expect(cells(page)).toHaveCount(1)
  })

  test('SM4 it fills itself: rating another photo puts it in, and no photos can be put in by hand', async ({ page }) => {
    await open(page)
    await cells(page).first().click()
    await page.keyboard.press('5')
    await makeFives(page)
    await expect(cells(page)).toHaveCount(1)
    await page.getByRole('button', { name: /All photographs/ }).first().click()
    await cells(page).nth(1).click()
    await page.keyboard.press('5')
    await list(page).getByRole('button', { name: /Fives/ }).click()
    await expect(cells(page)).toHaveCount(2)
    const actions = page.getByRole('group', { name: 'Actions for Fives' })
    await expect(actions.getByRole('button', { name: 'Edit rules…' })).toBeVisible()
    await expect(actions.getByRole('button', { name: 'Add selected photos' })).toHaveCount(0)
    await expect(actions.getByRole('button', { name: /Make target/ })).toHaveCount(0)
  })

  test('SM5 the count changes as rules are added, and any is wider than all', async ({ page }) => {
    await open(page)
    const dlg = await newSmart(page)
    await dlg.getByLabel('Value for rule 1').selectOption('0')
    // every photo has at least no stars: the count is more than nothing
    await expect(dlg.getByText(/^[1-9][\d,.\s]* photos? meets? these rules now\.$/)).toBeVisible()
    await dlg.getByRole('button', { name: 'Add a rule' }).click()
    await dlg.getByLabel('Field for rule 2').selectOption('camera')
    await dlg.getByLabel('Value for rule 2').fill('zzz-no-such-camera')
    await expect(dlg.getByText(/^0 photos meet these rules now\.$/)).toBeVisible()
    await dlg.getByLabel('A photo is in it if it meets').selectOption('any')
    await expect(dlg.getByText(/^[1-9][\d,.\s]* photos? meets? these rules now\.$/)).toBeVisible()
  })

  test('SM6 a rule that cannot be answered is said in words, and the last rule cannot be removed', async ({ page }) => {
    await open(page)
    const dlg = await newSmart(page)
    await expect(dlg.getByRole('button', { name: 'Remove rule 1' })).toBeDisabled()
    await dlg.getByLabel('Field for rule 1').selectOption('camera')
    await expect(dlg.getByText(/The value for camera must be some text/)).toBeVisible()
    await dlg.getByLabel('Name', { exact: true }).fill('Cameras')
    await dlg.getByRole('button', { name: 'Save' }).click()
    await expect(dlg.getByRole('alert')).toContainText('must be some text')
    await expect(dlg).toBeVisible()
  })

  test('SM7 a date rule turns into a number of days, or a date, with its test', async ({ page }) => {
    await open(page)
    const dlg = await newSmart(page)
    await dlg.getByLabel('Field for rule 1').selectOption('date')
    await expect(dlg.getByLabel('Value for rule 1')).toHaveValue('30')
    await dlg.getByLabel('Test for rule 1').selectOption('after')
    await expect(dlg.getByLabel('Value for rule 1')).toHaveAttribute('type', 'date')
    await dlg.getByLabel('Test for rule 1').selectOption('last')
    await expect(dlg.getByLabel('Value for rule 1')).toHaveValue('30')
  })

  test('SM8 the rules can be changed later, and the collection follows them', async ({ page }) => {
    await open(page)
    await cells(page).first().click()
    await page.keyboard.press('5')
    await makeFives(page)
    await expect(cells(page)).toHaveCount(1)
    await page.getByRole('group', { name: 'Actions for Fives' }).getByRole('button', { name: 'Edit rules…' }).click()
    const dlg = dialog(page)
    await expect(dlg.getByLabel('Name', { exact: true })).toHaveValue('Fives')
    await expect(dlg.getByLabel('Value for rule 1')).toHaveValue('5')
    await dlg.getByLabel('Value for rule 1').selectOption('0')
    await dlg.getByRole('button', { name: 'Save' }).click()
    await expect(dialog(page)).toHaveCount(0)
    await expect(cells(page).first()).toBeVisible()
    expect(await cells(page).count()).toBeGreaterThan(1)
  })

  test('SM9 it can be deleted like another collection, and the photos stay', async ({ page }) => {
    await open(page)
    await makeFives(page, 'Temporary')
    const actions = page.getByRole('group', { name: 'Actions for Temporary' })
    await actions.getByRole('button', { name: 'Delete collection…' }).click()
    await page.getByRole('alertdialog', { name: 'Confirm delete' }).getByRole('button', { name: 'Delete' }).click()
    await expect(list(page).getByRole('button', { name: /Temporary/ })).toHaveCount(0)
    expect(await cells(page).count()).toBeGreaterThan(1)
  })

  test('SM10 the builder has no accessibility violations', async ({ page }) => {
    await open(page)
    const dlg = await newSmart(page)
    await dlg.getByRole('button', { name: 'Add a rule' }).click()
    await dlg.getByLabel('Field for rule 2').selectOption('date')
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
  })
})
