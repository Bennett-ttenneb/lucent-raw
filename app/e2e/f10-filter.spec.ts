import { cells, expect, open, test } from './helpers'

test.describe('F10 find and filter', () => {
  test('F10-H1 text filter narrows the grid and None restores it', async ({ page }) => {
    await open(page)
    await page.getByRole('tab', { name: 'Text' }).click()
    await page.getByLabel(/Search file names/).fill('IMG_1007')
    await expect(cells(page)).toHaveCount(1)
    await page.getByRole('tab', { name: 'None' }).click()
    await expect(page.getByRole('grid', { name: /96 photos/ })).toBeVisible()
  })

  test('F10-H2 attribute filter by rating', async ({ page }) => {
    await open(page)
    await page.getByRole('tab', { name: 'Attribute' }).click()
    await page.getByLabel('Rating at least').selectOption('3')
    await expect(page.getByRole('grid', { name: /13 photos/ })).toBeVisible()
    for (const c of await cells(page).all()) await expect(c).toHaveAccessibleName(/[345] stars/)
  })

  test('F10-H3 folder list filters and All photographs clears it', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: /^2026-10-03/ }).click()
    await expect(page.getByRole('grid', { name: /32 photos/ })).toBeVisible()
    await page.getByRole('button', { name: /^All photographs/ }).click()
    await expect(page.getByRole('grid', { name: /96 photos/ })).toBeVisible()
  })

  test('F10-E1 no match shows a message without an import button', async ({ page }) => {
    await open(page)
    await page.getByRole('tab', { name: 'Text' }).click()
    await page.getByLabel(/Search file names/).fill('zzz-nothing')
    await expect(page.getByRole('heading', { name: 'Nothing matches these filters' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Import photos…' })).toHaveCount(0)
  })

  test('F10-E2 odd characters in the search box do not error', async ({ page }) => {
    await open(page)
    await page.getByRole('tab', { name: 'Text' }).click()
    for (const s of ['%', '_', "'; drop table photo; --", '😀', 'café', '\\', '   ', 'a'.repeat(500)]) {
      await page.getByLabel(/Search file names/).fill(s)
      await page.waitForTimeout(350)
      await expect(page.getByRole('alert')).toHaveCount(0)
    }
  })

  test('F10-E3 sort by name and reverse', async ({ page }) => {
    await open(page)
    await page.getByLabel('Sort').selectOption('name')
    await expect(cells(page).first()).toHaveAccessibleName(/^IMG_1001\.jpg/)
    await page.getByRole('button', { name: /Oldest first/ }).click()
    await expect(cells(page).first()).toHaveAccessibleName(/^IMG_1096\.jpg/)
  })

  test('F10-E4 a filter that hides everything recovers cleanly', async ({ page }) => {
    await open(page)
    await cells(page).nth(10).click()
    await page.getByRole('tab', { name: 'Attribute' }).click()
    await page.getByLabel('Rating at least').selectOption('5')
    await expect(page.getByRole('heading', { name: 'Nothing matches these filters' })).toBeVisible()
    await page.getByRole('tab', { name: 'None' }).click()
    await expect(page.getByRole('grid', { name: /96 photos/ })).toBeVisible()
  })
})
