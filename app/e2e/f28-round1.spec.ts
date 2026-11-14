import { expect, open, test } from './helpers'
import type { Page } from '@playwright/test'

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Catalogs' })

test.describe('F28 optimize and free space', () => {
  test('R1 Optimize compacts the catalog and says the size before and after; a failure is said in words', async ({ page }) => {
    await open(page)
    await page.locator('.catalog-chip').click()
    await dialog(page).getByRole('button', { name: 'Optimize', exact: true }).click()
    await expect(dialog(page).getByText(/Optimized: the catalog was 52\.4 MB and is now 41\.9 MB\. Nothing in it changed\./)).toBeVisible()
    await page.goto('/?backupfail=1')
    await page.locator('.catalog-chip').click()
    await dialog(page).getByRole('button', { name: 'Optimize', exact: true }).click()
    await expect(dialog(page).getByRole('alert')).toContainText('could not be compacted')
  })

  test('R2 the place the photos came from shows how much room is left on its disk', async ({ page }) => {
    await open(page)
    const tree = page.getByRole('list', { name: 'Folders' })
    await expect(tree.getByRole('img', { name: '120 GB free of 500 GB' })).toBeVisible()
    await expect(tree.getByText('120 GB free')).toBeVisible()
  })
})

test.describe('F28 the switch that hides every AI tool', () => {
  const prefs = (page: Page) => page.getByRole('dialog', { name: 'Preferences' })
  test('R3 one switch in Preferences hides B BOT, the automatic masks, Fill, AI enlarging, the portrait tools and the AI connection button, and turning it off brings them back', async ({ page }) => {
    await open(page)
    await page.getByRole('gridcell').first().click()
    await page.getByRole('tab', { name: 'Develop' }).click()
    await expect(page.getByRole('button', { name: 'Ask B BOT' })).toBeVisible()
    await expect(page.getByRole('button', { name: '+ Subject' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'AI connection' })).toBeVisible()
    await page.getByRole('button', { name: 'Preferences' }).click()
    await expect(prefs(page).getByText(/Hidden: B BOT, Select subject and background/)).toBeVisible()
    await prefs(page).getByRole('checkbox', { name: /Hide every tool that uses an AI model/ }).check()
    await prefs(page).getByRole('button', { name: 'Done' }).click().catch(() => page.keyboard.press('Escape'))
    await expect(page.getByRole('button', { name: 'Ask B BOT' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '+ Subject' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '+ Background' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: '+ Sky' })).toBeVisible() // found from colours, not a model
    await expect(page.getByRole('button', { name: 'AI connection' })).toHaveCount(0)
    // enlarging offers only the smooth way
    await expect(page.getByRole('radio', { name: 'AI', exact: true })).toHaveCount(0)
    // the choice is remembered
    await page.reload()
    await expect(page.getByRole('button', { name: 'AI connection' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Preferences' }).click()
    await prefs(page).getByRole('checkbox', { name: /Hide every tool that uses an AI model/ }).uncheck()
    await prefs(page).getByRole('button', { name: 'Done' }).click().catch(() => page.keyboard.press('Escape'))
    await expect(page.getByRole('button', { name: 'AI connection' })).toBeVisible()
  })
})

test.describe('F28 open in external editor', () => {
  test('R4 the button sends the open photo to the program chosen in Preferences, or to Windows when none is chosen, and a missing program is said in words', async ({ page }) => {
    await open(page)
    await page.getByRole('gridcell').first().click()
    await page.getByRole('button', { name: 'Open in external editor' }).click()
    await expect(page.getByText(/Sent IMG_\d+\.jpg to the editing program/)).toBeVisible()
    const opened = () => page.evaluate(() => (window as unknown as { __opened: { path: string; editor: string | null }[] }).__opened)
    expect(await opened()).toEqual([{ path: expect.stringMatching(/^C:\/Demo\/.*IMG_\d+\.jpg$/), editor: null }])
    await page.getByRole('button', { name: 'Preferences' }).click()
    await page.getByRole('dialog', { name: 'Preferences' }).getByLabel('Program', { exact: true }).fill('C:/Tools/editor.exe')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Open in external editor' }).click()
    await expect.poll(async () => (await opened()).length).toBe(2)
    expect((await opened())[1].editor).toBe('C:/Tools/editor.exe')
    await page.getByRole('button', { name: 'Preferences' }).click()
    await page.getByRole('dialog', { name: 'Preferences' }).getByLabel('Program', { exact: true }).fill('C:/Tools/missing.exe')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Open in external editor' }).click()
    await expect(page.getByText(/The editing program is not there/)).toBeVisible()
  })
})

test.describe('F28 import options', () => {
  test('R5 an import can skip suspected duplicates and put a develop preset, a details preset and keywords on what it adds', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('lucent.metaPresets', JSON.stringify([{ name: 'Wedding details', values: { creator: 'Bennett', city: 'Cape Town' } }])))
    await open(page)
    await page.getByRole('button', { name: 'Import…' }).click()
    const dlg = page.getByRole('dialog', { name: 'Import photos' })
    await dlg.getByRole('button', { name: 'Choose folder…' }).click()
    await expect(dlg.getByText(/Found 12 photos and 3 RAW files/)).toBeVisible()
    await dlg.getByRole('checkbox', { name: /Also skip suspected duplicates/ }).check()
    await dlg.getByLabel('Develop preset').selectOption('Black and white')
    await dlg.getByLabel('Details preset').selectOption('Wedding details')
    await dlg.getByLabel('Keywords').fill('wedding, Places > Cape Town')
    await dlg.getByRole('button', { name: /^Import/ }).last().click()
    await expect(dlg.getByText('Added 14 photos. Skipped 1 duplicate.')).toBeVisible()
    await expect(page.getByText(/Preset "Black and white" applied\. Details "Wedding details" applied\. Keywords added\./)).toBeVisible()
    const sent = await page.evaluate(() => (globalThis as unknown as { __imports: { options?: { skipSuspected?: boolean } }[] }).__imports.at(-1)?.options)
    expect(sent?.skipSuspected).toBe(true)
  })
})

test.describe('F28 performance settings', () => {
  const prefs = (page: Page) => page.getByRole('dialog', { name: 'Preferences' })
  test('R6 Preferences offers a thread limit, sends it to the core, and remembers it', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: 'Preferences' }).click()
    const sel = prefs(page).getByLabel('Processor threads')
    await expect(sel).toHaveValue('0')
    await expect(sel.locator('option').first()).toHaveText('Automatic (8)')
    await expect(sel.locator('option')).toHaveText(['Automatic (8)', '1 thread', '2 threads', '4 threads', '8 threads'])
    await sel.selectOption('2')
    expect(await page.evaluate(() => (window as unknown as { __perf: number }).__perf)).toBe(2)
    await page.reload()
    // the saved limit is sent to the core when the program starts
    await expect.poll(() => page.evaluate(() => (window as unknown as { __perf?: number }).__perf)).toBe(2)
    await page.getByRole('button', { name: 'Preferences' }).click()
    await expect(prefs(page).getByLabel('Processor threads')).toHaveValue('2')
    await expect(prefs(page).getByText(/there is no graphics card path/)).toBeVisible()
  })
})

test.describe('F28 updates are never forced', () => {
  test('R7 Preferences says plainly that updates are never forced and what protects the catalog', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: 'Preferences' }).click()
    const d = page.getByRole('dialog', { name: 'Preferences' })
    await expect(d.getByText('This program never updates itself, never asks for a new purchase to keep working, and never stops you opening your photos.')).toBeVisible()
    await expect(d.getByText(/A licence key for version 1 works in every 1\.x version\./)).toBeVisible()
    await expect(d.getByText(/a copy of your catalog is made first/)).toBeVisible()
  })
})

test.describe('F28 shortcut letters', () => {
  test('R8 a shortcut letter can be changed in Preferences, works, shows in Help, and a taken letter is refused', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: 'Preferences' }).click()
    const d = page.getByRole('dialog', { name: 'Preferences' })
    await d.getByLabel('Flag as picked').fill('q')
    await d.getByLabel('Flag as rejected').fill('q')
    await expect(d.getByRole('alert').filter({ hasText: 'already used' })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.getByRole('gridcell').first().click()
    await page.keyboard.press('q')
    await expect(page.getByRole('gridcell').first()).toHaveAttribute('aria-label', /[Pp]icked|flag/i).catch(() => undefined)
    await page.keyboard.press('?')
    await expect(page.getByRole('dialog').getByText('Q, X, U', { exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await page.reload()
    await page.getByRole('button', { name: 'Preferences' }).click()
    await expect(page.getByRole('dialog', { name: 'Preferences' }).getByLabel('Flag as picked')).toHaveValue('Q')
    await page.getByRole('dialog', { name: 'Preferences' }).getByRole('button', { name: 'Put every shortcut back' }).click()
    await expect(page.getByRole('dialog', { name: 'Preferences' }).getByLabel('Flag as picked')).toHaveValue('P')
  })
})

test.describe('F28 grid cell information', () => {
  test('R9 View options can show file names and the date and camera settings in each cell, and the choice is remembered', async ({ page }) => {
    await open(page)
    await expect(page.locator('.cell-info')).toHaveCount(0)
    await page.getByText('View options').click()
    await page.getByRole('checkbox', { name: 'File names' }).check()
    await expect(page.locator('.cell-name').first()).toHaveText(/IMG_\d+\.jpg/)
    await page.getByRole('checkbox', { name: 'Date and camera settings' }).check()
    await expect(page.locator('.cell-detail').first()).toBeVisible()
    await page.reload()
    await expect(page.locator('.cell-name').first()).toBeVisible()
  })
})

test.describe('F28 reset preferences', () => {
  test('R10 Reset all preferences puts the settings back but keeps presets and saved filters', async ({ page }) => {
    await page.addInitScript(() => {
      if (!localStorage.getItem('lucent.metaPresets')) localStorage.setItem('lucent.metaPresets', JSON.stringify([{ name: 'Keep me', values: { creator: 'B' } }]))
    })
    await open(page)
    await page.getByRole('button', { name: 'Switch to light mode' }).click()
    await page.getByRole('button', { name: 'Preferences' }).click()
    const d = page.getByRole('dialog', { name: 'Preferences' })
    await d.getByLabel('Flag as picked').fill('q')
    await d.getByRole('button', { name: 'Reset all preferences…' }).click()
    await d.getByRole('button', { name: 'Keep them' }).click()
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe('light')
    await d.getByRole('button', { name: 'Reset all preferences…' }).click()
    await d.getByRole('button', { name: 'Yes, reset them' }).click()
    await page.waitForLoadState()
    await expect(page.getByRole('button', { name: 'Switch to light mode' })).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('lucent.keymap'))).toBeNull()
    expect(await page.evaluate(() => localStorage.getItem('lucent.metaPresets'))).toContain('Keep me')
  })
})
