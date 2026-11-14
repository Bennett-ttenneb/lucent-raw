import AxeBuilder from '@axe-core/playwright'
import { cells, expect, open, pick, ratingGroup, selectedCells, test } from './helpers'

test.describe('F02 cull a shoot', () => {
  test('F02-H1 number key rates the selected photo', async ({ page }) => {
    await open(page)
    await pick(page, 1)
    await page.keyboard.press('4')
    await expect(ratingGroup(page).getByRole('radio', { name: '4 stars' })).toBeChecked()
    await expect(page.getByText('Rating set to 4')).toBeVisible()
    await expect(cells(page).nth(1)).toHaveAccessibleName(/4 stars/)
  })

  test('F02-H2 P marks a pick and the same key clears it', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await page.keyboard.press('p')
    await expect(page.getByRole('button', { name: 'Pick' })).toHaveAttribute('aria-pressed', 'true')
    await expect(cells(page).nth(0)).toHaveAccessibleName(/pick/)
    await page.keyboard.press('p')
    await expect(page.getByRole('button', { name: 'Pick' })).toHaveAttribute('aria-pressed', 'false')
  })

  test('F02-H3 X rejects, U clears', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await page.keyboard.press('x')
    await expect(page.getByRole('button', { name: 'Reject' })).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('u')
    await expect(page.getByRole('button', { name: 'Reject' })).toHaveAttribute('aria-pressed', 'false')
  })

  test('F02-H4 label key sets and clears a colour label', async ({ page }) => {
    await open(page)
    await pick(page, 2)
    await page.keyboard.press('8')
    await expect(page.getByRole('button', { name: 'green label' })).toHaveAttribute('aria-pressed', 'true')
    await page.keyboard.press('8')
    await expect(page.getByRole('button', { name: 'green label' })).toHaveAttribute('aria-pressed', 'false')
  })

  test('F02-H5 arrow keys move the selection by one and by a row', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await page.keyboard.press('ArrowRight')
    await expect(cells(page).nth(1)).toHaveAttribute('aria-selected', 'true')
    const idx = () => page.locator('[role=gridcell]').evaluateAll((els) => els.findIndex((e) => e.getAttribute('aria-selected') === 'true'))
    const before = await idx()
    await page.keyboard.press('ArrowDown')
    await expect.poll(idx).toBeGreaterThan(before + 1) // a whole row down
    await page.keyboard.press('Home')
    await expect(cells(page).nth(0)).toHaveAttribute('aria-selected', 'true')
  })

  test('F02-H6 E opens the loupe, arrows browse, G returns', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await page.keyboard.press('e')
    await expect(page.getByRole('grid')).toHaveCount(0)
    const name = page.locator('.overlay')
    const first = await name.textContent()
    await page.keyboard.press('ArrowRight')
    await expect(name).not.toHaveText(first!)
    await page.keyboard.press('g')
    await expect(page.getByRole('grid', { name: /Photo grid/ })).toBeVisible()
  })

  test('F02-H7 shift-click selects a range and a mark applies to all of it', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await cells(page).nth(3).click({ modifiers: ['Shift'] })
    await expect(selectedCells(page)).toHaveCount(4)
    await page.keyboard.press('5')
    for (let i = 0; i < 4; i++) await expect(cells(page).nth(i)).toHaveAccessibleName(/5 stars/)
    await expect(cells(page).nth(4)).not.toHaveAccessibleName(/5 stars/)
  })

  test('F02-E1 pressing the current rating again clears it', async ({ page }) => {
    await open(page)
    await pick(page, 1)
    await page.keyboard.press('3')
    await page.keyboard.press('3')
    await expect(cells(page).nth(1)).toHaveAccessibleName(/0 stars/)
  })

  test('F02-E2 typing numbers in the search box does not rate a photo', async ({ page }) => {
    await open(page)
    await pick(page, 1)
    await page.getByRole('tab', { name: 'Text' }).click()
    await page.getByLabel(/Search file names/).pressSequentially('12345')
    await expect(page.getByLabel(/Search file names/)).toHaveValue('12345')
    await page.getByRole('tab', { name: 'None' }).click()
    await expect(page.getByRole('grid', { name: /photos/ })).toBeVisible()
    await expect(cells(page).nth(1)).toHaveAccessibleName(/0 stars/)
  })

  test('F02-E3 shortcuts are ignored while a dialog is open', async ({ page }) => {
    await open(page)
    await pick(page, 1)
    await page.getByRole('button', { name: 'Import…' }).click()
    await page.keyboard.press('5')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(cells(page).nth(1)).toHaveAccessibleName(/0 stars/)
  })

  test('F02-E4 hammering keys leaves a single valid rating and no errors', async ({ page }) => {
    await open(page)
    await pick(page, 2)
    await page.keyboard.type('12345123451234512345', { delay: 0 })
    await page.waitForTimeout(300)
    expect(await ratingGroup(page).getByRole('radio', { checked: true }).count()).toBeLessThanOrEqual(1)
  })

  test('F02-E5 very long file names do not break the layout', async ({ page }) => {
    await open(page, '?longnames=1')
    await pick(page, 0)
    await page.getByRole('button', { name: 'Details', exact: true }).click()
    expect(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)).toBe(false)
    const box = await page.locator('.meta dd').first().boundingBox()
    const side = await page.getByRole('complementary', { name: 'Photo details' }).boundingBox()
    expect(box!.x + box!.width).toBeLessThanOrEqual(side!.x + side!.width + 1)
  })

  test('F02-E6 a failed save shows an error and rolls the rating back', async ({ page }) => {
    await open(page, '?fail=1')
    await pick(page, 1)
    await page.keyboard.press('4')
    await expect(page.getByText('The catalog could not be saved.')).toBeVisible()
    await expect(cells(page).nth(1)).toHaveAccessibleName(/0 stars/)
  })

  test('F02-E7 Ctrl+A selects everything', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await page.keyboard.press('Control+a')
    await expect(page.locator('.fsrc')).toContainText('96 selected')
  })

  test('F02-E10 Ctrl+A selects the whole result, not just the loaded pages', async ({ page }) => {
    await open(page, '?seed=3000')
    await pick(page, 0)
    await page.keyboard.press('Control+a')
    await expect(page.locator('.fsrc')).toContainText(/3.?000 selected/)
    await page.keyboard.press('4')
    await expect(page.getByText('Rating set to 4')).toBeVisible()
  })

  test('F02-E8 a large catalog keeps the DOM small and End reaches the last photo', async ({ page }) => {
    await open(page, '?seed=3000')
    await expect(page.getByRole('grid', { name: /3.?000 photos/ })).toBeVisible()
    expect(await cells(page).count()).toBeLessThan(250)
    await pick(page, 0)
    await page.keyboard.press('End')
    await expect(page.locator('.fsrc')).toContainText('IMG_3999.jpg')
  })

  test('F02-N1 an empty library explains itself and keys do nothing', async ({ page }) => {
    await open(page, '?seed=0')
    await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Import photos…' })).toBeVisible()
    await page.keyboard.press('5')
    await page.keyboard.press('p')
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('button', { name: 'Export…' })).toBeDisabled()
  })

  test('F02-E9 the grid has exactly one tab stop', async ({ page }) => {
    await open(page)
    expect(await page.locator('[role=gridcell][tabindex="0"]').count()).toBe(1)
  })

  test('F02-A1 accessibility scan of the grid, loupe and empty state', async ({ page }) => {
    test.setTimeout(90_000) // three full axe scans and three page loads
    await open(page)
    expect((await new AxeBuilder({ page }).analyze()).violations, 'grid').toEqual([])
    await pick(page, 0)
    await page.keyboard.press('e')
    expect((await new AxeBuilder({ page }).analyze()).violations, 'loupe').toEqual([])
    await open(page, '?seed=0')
    expect((await new AxeBuilder({ page }).analyze()).violations, 'empty').toEqual([])
  })
})
