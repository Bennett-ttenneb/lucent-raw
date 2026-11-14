import { expect, test as base, type Page } from '@playwright/test'

/** Every test fails on a console error, a page error or a 5xx response. */
export const test = base.extend<{ problems: string[] }>({
  problems: [
    async ({ page }, use) => {
      const problems: string[] = []
      page.on('console', (m) => m.type() === 'error' && problems.push(`console: ${m.text()}`))
      page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`))
      page.on('response', (r) => r.status() >= 500 && problems.push(`${r.status()} ${r.url()}`))
      await use(problems)
      expect(problems, 'console errors, page errors or 5xx responses').toEqual([])
    },
    { auto: true },
  ],
})
export { expect }

export async function open(page: Page, query = '') {
  await page.goto('/' + query)
  await expect(page.getByRole('grid', { name: /Photo grid/ }).or(page.getByRole('heading', { name: 'Your library is empty' }))).toBeVisible()
}

export const cells = (page: Page) => page.getByRole('gridcell')
export const selectedCells = (page: Page) => page.locator('[role=gridcell][aria-selected=true]')
export const ratingGroup = (page: Page) => page.getByRole('radiogroup', { name: 'Rating', exact: true })

/** Click the nth visible cell (0-based) without moving into the loupe. */
export async function pick(page: Page, n: number) {
  await cells(page).nth(n).click()
}
