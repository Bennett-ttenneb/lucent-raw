import AxeBuilder from '@axe-core/playwright'
import { cells, expect, open, test } from './helpers'
import type { Page } from '@playwright/test'

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Cull photos' })
const openCull = async (page: Page, query = '') => {
  await open(page, query)
  await page.getByRole('button', { name: 'Cull…' }).click()
  await expect(dialog(page)).toBeVisible()
  return dialog(page)
}
const scan = async (page: Page, query = '') => {
  const dlg = await openCull(page, query)
  await expect(dlg.getByRole('status').first()).toContainText(/photos? to look at/)
  await dlg.getByRole('button', { name: 'Start', exact: true }).click()
  await expect(dlg.getByText(/Looked at \d+ photos/)).toBeVisible()
  return dlg
}

test.describe('F12 cull', () => {
  test('CU1 it says how many photos it will look at, looks, and reports in words', async ({ page }) => {
    const dlg = await openCull(page)
    await expect(dlg.getByText(/It cannot tell closed eyes/)).toBeVisible()
    await expect(dlg.getByRole('status').first()).toContainText(/\d+ photos to look at/)
    await dlg.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(dlg.getByText(/Looked at \d+ photos: \d+ out of focus, \d+ badly exposed, 3 groups of bursts or near-duplicates/)).toBeVisible()
    await expect(dlg.getByRole('list', { name: 'Out of focus photos' })).toBeVisible()
    await expect(dlg.getByRole('list', { name: 'Badly exposed photos' })).toBeVisible()
    await expect(dlg.getByRole('list', { name: 'Groups' }).getByRole('listitem')).toHaveCount(3)
    await expect(dlg.getByRole('button', { name: 'Done' })).toBeVisible()
  })

  test('CU2 nothing is flagged until a button is pressed; Reject marks exactly the photos listed', async ({ page }) => {
    const dlg = await scan(page)
    await expect(page.locator('[data-flag="-1"]')).toHaveCount(0)
    const btn = dlg.getByRole('button', { name: /^Reject these \d+$/ }).first()
    const n = Number(/(\d+)$/.exec((await btn.textContent()) ?? '')![1])
    expect(n).toBeGreaterThan(0)
    await btn.click()
    await expect(dlg.getByText(new RegExp(`${n} photos marked as reject`))).toBeVisible()
  })

  test('CU3 for a burst it names the best, and keeping the best rejects the others', async ({ page }) => {
    const dlg = await scan(page)
    const groups = dlg.getByRole('list', { name: 'Groups' })
    await expect(groups.getByRole('listitem').first()).toContainText(/3 photos, best: /)
    await dlg.getByRole('button', { name: /Keep the best of each group and reject the other 6/ }).click()
    await expect(dlg.getByText(/6 photos marked as reject/)).toBeVisible()
  })

  test('CU4 Select puts the photos in the Library selection', async ({ page }) => {
    const dlg = await scan(page)
    await dlg.getByRole('button', { name: /^Select the 6 others$/ }).click()
    await expect(dlg.getByText(/6 photos selected in the Library/)).toBeVisible()
    await dlg.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByText(/6 selected|6 photos selected/).first()).toBeVisible()
  })

  test('CU5 with several photos selected it looks at those and no others', async ({ page }) => {
    await open(page)
    await cells(page).first().click()
    await cells(page).nth(3).click({ modifiers: ['Shift'] })
    await page.getByRole('button', { name: 'Cull…' }).click()
    await expect(dialog(page).getByText(/the 4 selected photos/)).toBeVisible()
    await expect(dialog(page).getByRole('status').first()).toContainText('4 photos to look at')
  })

  test('CU6 a failure is said in words and Start can be tried again; the dialog has no accessibility violations', async ({ page }) => {
    const dlg = await openCull(page, '?failpreview=1')
    await expect(dlg.getByRole('status').first()).toContainText(/photos to look at/)
    await dlg.getByRole('button', { name: 'Start', exact: true }).click()
    await expect(dlg.getByRole('alert')).toContainText('no preview yet')
    await expect(dlg.getByRole('button', { name: 'Start', exact: true })).toBeEnabled()
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
  })
})
