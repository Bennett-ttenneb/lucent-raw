import { expect, open, pick, test } from './helpers'
import type { Page } from '@playwright/test'

const head = (page: Page, title: string) => page.getByRole('complementary', { name: 'Develop controls' }).getByRole('button', { name: title, exact: true })
async function openDevelop(page: Page) {
  await open(page)
  await pick(page, 0)
  await page.getByRole('tab', { name: 'Develop' }).click()
  await expect(page.getByRole('complementary', { name: 'Develop controls' })).not.toHaveAttribute('aria-busy', 'true')
}
const titles = (page: Page) => page.locator('aside.side.right section.panel[data-title]').evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.title))

test.describe('F27 panel shortcuts', () => {
  test('PK1 Alt plus a number opens or closes that panel of the right-hand column and moves the keyboard to it', async ({ page }) => {
    await openDevelop(page)
    const t = (await titles(page)) as string[]
    const n = 6
    const title = t[n - 1]
    const was = await head(page, title).getAttribute('aria-expanded')
    await page.keyboard.press(`Alt+${n}`)
    await expect(head(page, title)).toHaveAttribute('aria-expanded', was === 'true' ? 'false' : 'true')
    if (was !== 'true') await expect(head(page, title)).toBeFocused()
    await page.keyboard.press(`Alt+${n}`)
    await expect(head(page, title)).toHaveAttribute('aria-expanded', was ?? 'false')
  })

  test('PK2 Alt+0 closes every panel of the column', async ({ page }) => {
    await openDevelop(page)
    await page.keyboard.press('Alt+0')
    const open = await page.locator('aside.side.right .phead-btn[aria-expanded=true]').count()
    expect(open).toBe(0)
  })

  test('PK3 Alt+click opens one panel and closes the others', async ({ page }) => {
    await openDevelop(page)
    await head(page, 'Detail').click({ modifiers: ['Alt'] })
    await expect(head(page, 'Detail')).toHaveAttribute('aria-expanded', 'true')
    expect(await page.locator('aside.side.right .phead-btn[aria-expanded=true]').count()).toBe(1)
  })

  test('PK4 Up, Down, Home and End move between the panel names', async ({ page }) => {
    await openDevelop(page)
    const t = (await titles(page)) as string[]
    await head(page, t[2]).focus()
    await page.keyboard.press('ArrowDown')
    await expect(head(page, t[3])).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await page.keyboard.press('ArrowUp')
    await expect(head(page, t[1])).toBeFocused()
    await page.keyboard.press('End')
    await expect(head(page, t[t.length - 1])).toBeFocused()
    await page.keyboard.press('Home')
    await expect(head(page, t[0])).toBeFocused()
  })

  test('PK5 holding Alt shows the numbers and letting go hides them; the choice of open panels survives a reload', async ({ page }) => {
    await openDevelop(page)
    await page.keyboard.down('Alt')
    await expect(page.locator('aside.side.right .phead-btn[data-key="1"]')).toHaveCount(1)
    await page.keyboard.up('Alt')
    await expect(page.locator('.phead-btn[data-key]')).toHaveCount(0)
    await page.keyboard.press('Alt+0')
    await head(page, 'Detail').click()
    await page.reload()
    await pick(page, 0)
    await page.getByRole('tab', { name: 'Develop' }).click()
    await expect(head(page, 'Detail')).toHaveAttribute('aria-expanded', 'true')
    await expect(head(page, 'Effects')).toHaveAttribute('aria-expanded', 'false')
  })
})

test.describe('F27 the icon strip', () => {
  const strip = (page: Page) => page.getByRole('toolbar', { name: 'Go to a panel' })
  const setSlider = async (page: Page, name: string, value: string) => {
    const box = page.getByRole('textbox', { name: `${name} value`, exact: true })
    await box.click()
    await box.fill(value)
    await box.press('Enter')
  }

  test('PK6 an icon opens its panel, closes the others and moves to it; Shift keeps the others', async ({ page }) => {
    await openDevelop(page)
    await strip(page).getByRole('button', { name: 'Go to Detail' }).click()
    await expect(head(page, 'Detail')).toHaveAttribute('aria-expanded', 'true')
    await expect(head(page, 'Detail')).toBeFocused()
    expect(await page.locator('aside.side.right .phead-btn[aria-expanded=true]').count()).toBe(1)
    await expect(strip(page).getByRole('button', { name: 'Go to Detail' })).toHaveAttribute('aria-pressed', 'true')
    await strip(page).getByRole('button', { name: 'Go to Effects' }).click({ modifiers: ['Shift'] })
    await expect(head(page, 'Effects')).toHaveAttribute('aria-expanded', 'true')
    await expect(head(page, 'Detail')).toHaveAttribute('aria-expanded', 'true')
  })

  test('PK7 a dot under an icon shows the panel has changes', async ({ page }) => {
    await openDevelop(page)
    const basic = strip(page).getByRole('button', { name: 'Go to Basic' })
    await expect(basic).not.toHaveAttribute('data-edited', /.*/)
    await setSlider(page, 'Exposure', '1')
    await expect(basic).toHaveAttribute('data-edited', 'true')
    await expect(strip(page).getByRole('button', { name: 'Go to Detail' })).not.toHaveAttribute('data-edited', /.*/)
  })

  test('PK8 the Enlarge icon opens the Enlarge panel, which shows the size of the picture', async ({ page }) => {
    await openDevelop(page)
    await strip(page).getByRole('button', { name: 'Go to Enlarge' }).click()
    await expect(head(page, 'Enlarge')).toHaveAttribute('aria-expanded', 'true')
    await expect(page.getByText(/The picture is about \d+ × \d+ px after the crop\./)).toBeVisible()
  })

  test('PK9 right-click on a panel name offers solo mode, open all and close all', async ({ page }) => {
    await openDevelop(page)
    const t = (await titles(page)) as string[]
    const count = () => page.locator('aside.side.right .phead-btn[aria-expanded=true]').count()
    await head(page, t[1]).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Close all panels' }).click()
    expect(await count()).toBe(0)
    await head(page, t[1]).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Open all panels' }).click()
    expect(await count()).toBe(t.length)
    await head(page, t[1]).click({ button: 'right' })
    await page.getByRole('menuitemcheckbox', { name: /Solo mode/ }).click()
    await head(page, t[2]).click() // closes it (it was open), then open another: only that one stays open
    await head(page, t[2]).click()
    expect(await count()).toBe(1)
    await expect(head(page, t[2])).toHaveAttribute('aria-expanded', 'true')
    await page.reload()
    await page.getByRole('gridcell').first().click()
    await page.getByRole('tab', { name: 'Develop' }).click()
    await head(page, t[3]).click()
    expect(await count()).toBe(1) // solo mode is remembered
  })})

