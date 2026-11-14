import { expect, open, test } from './helpers'
import { paginate, sheetSize, DEFAULT_PRINT } from '../src/lib/printlayout'

test.describe('F30 printing', () => {
  test('PT1 the Print module lays the selected photos out on pages, follows the layout and paper choices, and sends them to the printer', async ({ page }) => {
    await open(page)
    await page.evaluate(() => ((window as unknown as { __printed: number }).__printed = 0, (window.print = () => ((window as unknown as { __printed: number }).__printed += 1))))
    const cells = page.getByRole('gridcell')
    await cells.nth(0).click()
    await cells.nth(4).click({ modifiers: ['Shift'] })
    await page.getByRole('tab', { name: 'Print' }).click()
    await expect(page.getByRole('status').filter({ hasText: '5 photos on 5 pages' })).toBeVisible()
    await page.getByLabel('Photos across').fill('2')
    await page.getByLabel('Photos down').fill('2')
    await expect(page.getByRole('status').filter({ hasText: '5 photos on 2 pages' })).toBeVisible()
    await page.getByLabel('Copies of each').fill('2')
    await expect(page.getByRole('status').filter({ hasText: '5 photos on 3 pages' })).toBeVisible()
    await page.getByLabel('Size').selectOption('letter')
    await page.getByRole('button', { name: 'Landscape' }).click()
    await expect(page.locator('section.print-sheet').first()).toHaveCSS('width', /^\d+/)
    await page.getByRole('button', { name: 'Print…' }).click()
    expect(await page.evaluate(() => (window as unknown as { __printed: number }).__printed)).toBe(1)
    // the printer's own copy of the pages sits outside the window
    expect(await page.locator('#print-root .print-sheet').count()).toBe(3)
  })

  test('PT2 the page arithmetic: copies and cells per page, and sizes turn with the orientation', () => {
    expect(paginate([1, 2, 3, 4, 5], { ...DEFAULT_PRINT, cols: 2, rows: 2 }).map((p) => p.length)).toEqual([4, 1])
    expect(paginate([1, 2], { ...DEFAULT_PRINT, copies: 3 }).flat()).toEqual([1, 1, 1, 2, 2, 2])
    expect(sheetSize({ ...DEFAULT_PRINT, paper: 'a4' })).toEqual([210, 297])
    expect(sheetSize({ ...DEFAULT_PRINT, paper: 'a4', landscape: true })).toEqual([297, 210])
  })
})
