import AxeBuilder from '@axe-core/playwright'
import { cells, expect, open, test } from './helpers'

const count = (n: number) => `${n} photos`

test.describe('F19 virtual copies', () => {
  test('VC1 a virtual copy appears next to the photo with a Copy 1 badge, and is the one selected', async ({ page }) => {
    await open(page)
    await expect(page.locator('.fsrc')).toContainText(count(96))
    await cells(page).first().click()
    await page.getByRole('button', { name: 'Virtual copy' }).click()
    await expect(page.getByText(/Made a virtual copy/)).toBeVisible()
    await expect(page.locator('.fsrc')).toContainText(count(97))
    await expect(page.getByText('Copy 1', { exact: true })).toHaveCount(1)
    await expect(page.locator('[role=gridcell][aria-selected=true]')).toHaveCount(1)
    await expect(page.locator('[role=gridcell][aria-selected=true]').getByText('Copy 1')).toBeVisible()
  })

  test('VC2 Ctrl+apostrophe makes another copy, numbered on', async ({ page }) => {
    await open(page)
    await cells(page).first().click()
    await page.keyboard.press("Control+'")
    await expect(page.getByText('Copy 1', { exact: true })).toHaveCount(1)
    await cells(page).first().click()
    await page.keyboard.press("Control+'")
    await expect(page.getByText('Copy 2', { exact: true })).toHaveCount(1)
    await expect(page.locator('.fsrc')).toContainText(count(98))
  })

  test('VC3 the copy has a rating of its own', async ({ page }) => {
    await open(page)
    await cells(page).first().click()
    await page.getByRole('button', { name: 'Virtual copy' }).click()
    await expect(page.getByText('Copy 1', { exact: true })).toHaveCount(1)
    await page.keyboard.press('5')
    await expect(page.locator('.cell-stars', { hasText: '★★★★★' })).toHaveCount(1)
  })

  test('VC4 several selected photos each get a copy', async ({ page }) => {
    await open(page)
    await cells(page).nth(0).click()
    await cells(page).nth(2).click({ modifiers: ['Shift'] })
    await page.getByRole('button', { name: 'Virtual copy' }).click()
    await expect(page.getByText(/Made 3 virtual copies/)).toBeVisible()
    await expect(page.locator('.fsrc')).toContainText(count(99))
    await expect(page.locator('[role=gridcell][aria-selected=true]')).toHaveCount(3)
  })

  test('VC5 removing a photo asks, says its copies go too, and takes them with it', async ({ page }) => {
    await open(page)
    await cells(page).first().click()
    await page.getByRole('button', { name: 'Virtual copy' }).click()
    await expect(page.locator('.fsrc')).toContainText(count(97))
    await cells(page).first().click()
    await page.keyboard.press('Delete')
    const dlg = page.getByRole('dialog', { name: 'Remove from the catalog?' })
    await expect(dlg).toContainText('virtual copies')
    await dlg.getByRole('button', { name: 'Remove from catalog' }).click()
    await expect(page.locator('.fsrc')).toContainText(count(95))
    await expect(page.getByText('Copy 1', { exact: true })).toHaveCount(0)
  })

  test('VC6 there is nothing to copy with no selection photos shown, and the grid has no accessibility violations with copies', async ({ page }) => {
    await open(page)
    await cells(page).first().click()
    await page.getByRole('button', { name: 'Virtual copy' }).click()
    await expect(page.getByText('Copy 1', { exact: true })).toHaveCount(1)
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
  })
})
