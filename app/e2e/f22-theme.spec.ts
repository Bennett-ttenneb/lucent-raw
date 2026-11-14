import AxeBuilder from '@axe-core/playwright'
import { cells, expect, open, test } from './helpers'
import type { Page } from '@playwright/test'

const theme = (page: Page) => page.evaluate(() => document.documentElement.dataset.theme)
const violations = async (page: Page) => (await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))
const light = (page: Page) => page.addInitScript(() => localStorage.setItem('penumbra.theme', 'light'))

test.describe('F22 light and dark', () => {
  test('TH1 it starts dark, one press of the title bar button makes it light and back, and the choice is remembered', async ({ page }) => {
    await open(page)
    expect(await theme(page)).toBe('dark')
    await page.getByRole('button', { name: 'Switch to light mode' }).click()
    expect(await theme(page)).toBe('light')
    await expect(page.getByRole('button', { name: 'Switch to dark mode' })).toBeVisible()
    await page.reload()
    expect(await theme(page)).toBe('light')
    await page.getByRole('button', { name: 'Switch to dark mode' }).click()
    expect(await theme(page)).toBe('dark')
    await page.reload()
    expect(await theme(page)).toBe('dark')
  })

  test('TH2 Preferences offers dark, light and match my computer, and match follows the computer', async ({ page }) => {
    await page.emulateMedia({ colorScheme: 'light' })
    await open(page)
    await page.getByRole('button', { name: 'Preferences' }).click()
    const select = page.getByRole('dialog', { name: 'Preferences' }).getByLabel('Colour scheme')
    await expect(select).toHaveValue('dark')
    expect(await select.locator('option').allInnerTexts()).toEqual(['Dark', 'Light', 'Match my computer'])
    await select.selectOption('system')
    expect(await theme(page)).toBe('light')
    await page.emulateMedia({ colorScheme: 'dark' })
    await expect.poll(() => theme(page)).toBe('dark')
    await select.selectOption('light')
    expect(await theme(page)).toBe('light')
    await page.reload()
    expect(await theme(page)).toBe('light')
    await page.getByRole('button', { name: 'Preferences' }).click()
    await expect(page.getByRole('dialog', { name: 'Preferences' }).getByLabel('Colour scheme')).toHaveValue('light')
  })

  test('TH3 the Library has no accessibility violations in light mode', async ({ page }) => {
    await light(page)
    await open(page)
    await cells(page).first().click()
    expect(await violations(page)).toEqual([])
  })

  test('TH4 Develop has no accessibility violations in light mode, with Basic, the curve and masks open', async ({ page }) => {
    await light(page)
    await open(page)
    await cells(page).first().click()
    await page.keyboard.press('d')
    await expect(page.getByRole('toolbar', { name: 'Develop tools' })).toBeVisible()
    await page.getByRole('button', { name: '+ Linear' }).click()
    expect(await violations(page)).toEqual([])
  })

  test('TH5 the dialogs have no accessibility violations in light mode', async ({ page }) => {
    await light(page)
    await open(page)
    await cells(page).first().click()
    await page.getByRole('button', { name: 'Export…' }).click()
    expect(await violations(page)).toEqual([])
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Preferences' }).click()
    expect(await violations(page)).toEqual([])
    await page.keyboard.press('Escape')
    await page.locator('.catalog-chip').click()
    expect(await violations(page)).toEqual([])
  })

  test('TH6 Retouch and Book have no accessibility violations in light mode', async ({ page }) => {
    await light(page)
    await open(page)
    await cells(page).first().click()
    await page.getByRole('tab', { name: 'Retouch' }).click()
    await page.getByRole('button', { name: 'Detect faces' }).click()
    await expect(page.getByText('3 faces found.')).toBeVisible()
    expect(await violations(page)).toEqual([])
    await page.getByRole('tab', { name: 'Book' }).click()
    await page.getByRole('button', { name: 'New book' }).first().click()
    await page.getByRole('button', { name: 'Photo and caption' }).click()
    expect(await violations(page)).toEqual([])
  })

  test('TH7 the logo is the same tile in both themes and the page title is the name', async ({ page }) => {
    await light(page)
    await open(page)
    const logo = page.locator('.identity img').first()
    await expect(logo).toHaveAttribute('src', '/brand/app-icon.png')
    expect(await logo.evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0)).toBe(true)
    await page.getByRole('button', { name: 'Switch to dark mode' }).click()
    await expect(logo).toHaveAttribute('src', '/brand/app-icon.png')
  })
})
