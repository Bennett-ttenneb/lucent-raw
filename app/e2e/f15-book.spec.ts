import AxeBuilder from '@axe-core/playwright'
import { expect, open, pick, test } from './helpers'
import type { Page } from '@playwright/test'

const openBook = async (page: Page, query = '') => {
  await open(page, query)
  await page.getByRole('tab', { name: 'Book' }).click()
}
const newBook = async (page: Page) => {
  await openBook(page)
  await page.getByRole('button', { name: 'New book' }).first().click()
  await expect(page.getByTestId('book-page')).toBeVisible()
}
const frames = (page: Page) => page.getByTestId('book-page').getByRole('button')

test.describe('F15 book', () => {
  test('BK1 the Book tab starts with no book and makes one on a single empty page', async ({ page }) => {
    await openBook(page)
    await expect(page.getByRole('heading', { name: 'Photo books' })).toBeVisible()
    await page.getByRole('button', { name: 'New book' }).first().click()
    await expect(page.getByRole('list', { name: 'Your books' }).getByRole('listitem')).toHaveCount(1)
    await expect(page.getByText('Page 1 of 1')).toBeVisible()
    await expect(page.getByRole('option', { name: 'Page 1' })).toBeVisible()
    await expect(frames(page)).toHaveCount(0)
  })

  test('BK2 an arrangement puts photo frames on the page, and the next one keeps the photos that are there', async ({ page }) => {
    await newBook(page)
    await page.getByRole('button', { name: 'Two side by side' }).click()
    await expect(frames(page)).toHaveCount(2)
    await frames(page).first().click()
    await page.getByRole('button', { name: 'Use the selected photo' }).click()
    await expect(page.getByTestId('book-page').locator('img')).toHaveCount(1)
    await page.getByRole('button', { name: 'Photo and caption' }).click()
    await expect(frames(page)).toHaveCount(2)
    await expect(page.getByTestId('book-page').locator('img')).toHaveCount(1)
    await page.getByRole('button', { name: 'Blank' }).click()
    await expect(frames(page)).toHaveCount(0)
  })

  test('BK3 pages can be added, copied, moved and deleted, and the last page cannot be deleted', async ({ page }) => {
    await newBook(page)
    await page.getByRole('button', { name: 'Add page' }).click()
    await page.getByRole('button', { name: 'Copy page' }).click()
    await expect(page.getByText('Page 3 of 3')).toBeVisible()
    await page.getByRole('button', { name: 'Move earlier' }).click()
    await expect(page.getByText('Page 2 of 3')).toBeVisible()
    await page.getByRole('button', { name: 'Delete page' }).click()
    await page.getByRole('button', { name: 'Delete page' }).click()
    await expect(page.getByText('Page 1 of 1')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Delete page' })).toBeDisabled()
  })

  test('BK4 text can be added, edited and deleted from its frame', async ({ page }) => {
    await newBook(page)
    await page.getByRole('button', { name: 'Add text' }).click()
    await expect(page.getByTestId('book-page')).toContainText('Your text')
    await page.getByLabel('Text', { exact: true }).fill('Summer at the lake')
    await expect(page.getByTestId('book-page')).toContainText('Summer at the lake')
    await page.getByRole('button', { name: 'Bold' }).click()
    await expect(page.getByRole('button', { name: 'Bold' })).toHaveAttribute('aria-pressed', 'true')
    await page.getByRole('button', { name: 'Delete frame' }).click()
    await expect(frames(page)).toHaveCount(0)
  })

  test('BK5 a frame can be moved with the arrow keys and deleted with Delete', async ({ page }) => {
    await newBook(page)
    await page.getByRole('button', { name: 'One photo' }).click()
    const f = frames(page).first()
    const before = await f.boundingBox()
    await f.focus()
    await page.keyboard.press('ArrowRight')
    await page.keyboard.press('ArrowRight')
    const after = await f.boundingBox()
    expect(after!.x).toBeGreaterThan(before!.x)
    await page.keyboard.press('Delete')
    await expect(frames(page)).toHaveCount(0)
  })

  test('BK12 undo and redo take back and bring back page changes, with the buttons and with Ctrl+Z', async ({ page }) => {
    await newBook(page)
    await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled()
    await page.getByRole('button', { name: 'Two stacked' }).click()
    await expect(frames(page)).toHaveCount(2)
    await page.waitForTimeout(800)
    await page.getByRole('button', { name: 'Add page' }).click()
    await expect(page.getByText('Page 2 of 2')).toBeVisible()
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(page.getByText('Page 1 of 1')).toBeVisible()
    await expect(frames(page)).toHaveCount(2)
    await page.getByRole('button', { name: 'Redo' }).click()
    await expect(page.getByText('of 2')).toBeVisible()
    await page.keyboard.press('Control+z')
    await page.keyboard.press('Control+z')
    await expect(frames(page)).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Undo' })).toBeDisabled()
    await page.keyboard.press('Control+y')
    await expect(frames(page)).toHaveCount(2)
  })

  test('BK6 pages are made from the selected photos, the number to a page as asked', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await page.keyboard.press('Control+a')
    await page.getByRole('tab', { name: 'Book' }).click()
    await page.getByRole('button', { name: 'New book' }).first().click()
    await page.getByLabel('Photos to a page').selectOption('4')
    await page.getByRole('button', { name: /Make pages from \d+ selected photos?/ }).click()
    await expect(page.getByRole('option', { name: /^Page \d+$/ }).first()).toBeVisible()
    await expect(frames(page)).toHaveCount(4)
  })

  test('BK7 the book is kept: it is there after leaving the module and coming back', async ({ page }) => {
    await newBook(page)
    await page.getByLabel('Name', { exact: true }).fill('Our trip')
    await page.getByRole('button', { name: 'Two stacked' }).click()
    await page.getByRole('tab', { name: 'Library' }).click()
    await page.getByRole('tab', { name: 'Book' }).click()
    await page.getByRole('list', { name: 'Your books' }).getByRole('button', { name: /^Our trip/ }).click()
    await expect(page.getByTestId('book-page')).toBeVisible()
    await expect(frames(page)).toHaveCount(2)
  })

  test('BK8 making the PDF asks for a folder, reports the file, and a failure is said in words', async ({ page }) => {
    await newBook(page)
    await page.getByRole('button', { name: 'Make PDF…' }).click()
    const dlg = page.getByRole('dialog', { name: 'Make a PDF of the book' })
    await expect(dlg.getByRole('button', { name: 'Make PDF', exact: true })).toBeDisabled()
    await dlg.getByRole('button', { name: 'Choose folder…' }).click()
    await dlg.getByRole('button', { name: 'Make PDF', exact: true }).click()
    await expect(dlg.getByRole('status')).toContainText('.pdf')
    await expect(dlg.getByRole('status')).toContainText('Made 1 page')
  })

  test('BK9 a PDF that cannot be made says why', async ({ page }) => {
    await openBook(page, '?bookfail=1')
    await page.getByRole('button', { name: 'New book' }).first().click()
    await page.getByRole('button', { name: 'Make PDF…' }).click()
    const dlg = page.getByRole('dialog', { name: 'Make a PDF of the book' })
    await dlg.getByRole('button', { name: 'Choose folder…' }).click()
    await dlg.getByRole('button', { name: 'Make PDF', exact: true }).click()
    await expect(dlg.getByRole('alert')).toContainText('disk is full')
  })

  test('BK10 a book can be deleted only after a confirmation', async ({ page }) => {
    await newBook(page)
    await page.getByRole('button', { name: /^Delete Untitled book/ }).click()
    await page.getByRole('button', { name: 'Keep' }).click()
    await expect(page.getByRole('list', { name: 'Your books' }).getByRole('listitem')).toHaveCount(1)
    await page.getByRole('button', { name: /^Delete Untitled book/ }).click()
    await page.getByRole('button', { name: /^Confirm: delete/ }).click()
    await expect(page.getByRole('list', { name: 'Your books' }).getByRole('listitem')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Photo books' })).toBeVisible()
  })

  test('BK11 the module has no accessibility violations, empty and with a book open', async ({ page }) => {
    await openBook(page)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
    await page.getByRole('button', { name: 'New book' }).first().click()
    await page.getByRole('button', { name: 'Photo and caption' }).click()
    await frames(page).first().click()
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  })
})

test.describe('F15 book and catalogs', () => {
  test('BK13 switching catalog closes the open book, so it cannot be saved into the other catalog', async ({ page }) => {
    await open(page, '?catalogs=2')
    await page.getByRole('tab', { name: 'Book' }).click()
    await page.getByRole('button', { name: 'New book' }).first().click()
    await page.getByRole('button', { name: 'Two stacked' }).click()
    await expect(frames(page)).toHaveCount(2)
    await page.getByRole('tab', { name: 'Library' }).click()
    await page.locator('.catalog-chip').click()
    const dlg = page.getByRole('dialog', { name: 'Catalogs' })
    await dlg.getByRole('button', { name: /^Switch to / }).first().click()
    await expect(dlg).toHaveCount(0)
    await page.getByRole('tab', { name: 'Book' }).click()
    await expect(page.getByRole('heading', { name: 'Photo books' })).toBeVisible()
    await expect(page.getByTestId('book-page')).toHaveCount(0)
  })
})
