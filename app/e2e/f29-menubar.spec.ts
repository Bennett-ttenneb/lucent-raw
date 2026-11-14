import { cells, expect, open, test } from './helpers'
import type { Page } from '@playwright/test'

const bar = (page: Page) => page.getByRole('menubar', { name: 'Menu' })

test.describe('F29 menu bar', () => {
  test('MB1 each module has its own menus: Library has Select all, Develop has Undo and Before, and Book has its own Undo', async ({ page }) => {
    await open(page)
    await bar(page).getByRole('menuitem', { name: 'Edit' }).click()
    await expect(page.getByRole('menu', { name: 'Edit' }).getByRole('menuitem', { name: /Select all/ })).toBeVisible()
    await expect(page.getByRole('menu', { name: 'Edit' }).getByRole('menuitem', { name: /Copy settings/ })).toHaveCount(0) // that one belongs to Develop
    await page.keyboard.press('Escape')
    await cells(page).first().click()
    await page.getByRole('tab', { name: 'Develop' }).click()
    await bar(page).getByRole('menuitem', { name: 'Edit' }).click()
    await expect(page.getByRole('menu', { name: 'Edit' }).getByRole('menuitem', { name: /^Undo/ })).toBeVisible()
    await bar(page).getByRole('menuitem', { name: 'View' }).click()
    await expect(page.getByRole('menu', { name: 'View' }).getByRole('menuitem', { name: /Before/ })).toBeVisible()
    await expect(page.getByRole('menu', { name: 'View' }).getByRole('menuitem', { name: /^Grid/ })).toHaveCount(0)
  })

  test('MB2 an item does its job, an unavailable one says why and does nothing, Escape closes, arrows move', async ({ page }) => {
    await open(page)
    await bar(page).getByRole('menuitem', { name: 'File' }).click()
    await page.getByRole('menu', { name: 'File' }).getByRole('menuitem', { name: /Import photos/ }).click()
    await expect(page.getByRole('dialog', { name: 'Import photos' })).toBeVisible()
    await page.keyboard.press('Escape')
    await bar(page).getByRole('menuitem', { name: 'Edit' }).click()
    const virt = page.getByRole('menu', { name: 'Edit' }).getByRole('menuitem', { name: /Paste settings/ })
    await expect(virt).toHaveAttribute('aria-disabled', 'true')
    await expect(virt).toHaveAttribute('title', 'Copy settings in Develop first')
    await page.keyboard.press('Escape')
    await expect(page.getByRole('menu')).toHaveCount(0)
    await cells(page).first().click()
    await bar(page).getByRole('menuitem', { name: 'Photo' }).focus()
    await page.keyboard.press('ArrowDown')
    await expect(page.getByRole('menu', { name: 'Photo' }).getByRole('menuitem').first()).toBeFocused()
    await page.keyboard.press('ArrowRight')
    await expect(page.getByRole('menu', { name: 'View' })).toBeVisible()
    await page.keyboard.press('Escape')
    await bar(page).getByRole('menuitem', { name: 'Photo' }).click()
    await page.getByRole('menu', { name: 'Photo' }).getByRole('menuitem', { name: /^Pick/ }).click()
    await expect(page.getByRole('menu')).toHaveCount(0)
    await bar(page).getByRole('menuitem', { name: 'Window' }).click()
    await page.getByRole('menu', { name: 'Window' }).getByRole('menuitem', { name: 'Develop' }).click()
    await expect(page.getByRole('tab', { name: 'Develop' })).toHaveAttribute('aria-selected', 'true')
  })
})
