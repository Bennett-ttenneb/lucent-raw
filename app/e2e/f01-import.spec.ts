import AxeBuilder from '@axe-core/playwright'
import { cells, expect, open, test } from './helpers'

const importBtn = (page: import('@playwright/test').Page) => page.getByRole('dialog').getByRole('button', { name: /^Import/ }).last()

test.describe('F01 import photos', () => {
  test('F01-H1 choose a folder, import, see the new photos and folder', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: 'Import…' }).click()
    const dlg = page.getByRole('dialog', { name: 'Import photos' })
    await expect(dlg).toBeVisible()
    await expect(importBtn(page)).toBeDisabled()
    await dlg.getByRole('button', { name: 'Choose folder…' }).click()
    await expect(dlg.getByText(/Found 12 photos and 3 RAW files/)).toBeVisible()
    await importBtn(page).click()
    await expect(dlg.getByText('Added 15 photos.')).toBeVisible()
    await dlg.getByRole('button', { name: 'Done' }).click()
    await expect(dlg).toHaveCount(0)
    await expect(page.getByRole('grid', { name: /111 photos/ })).toBeVisible()
    await expect(page.getByRole('button', { name: /^Card import/ })).toBeVisible()
  })

  test('F01-H2 RAW files appear with an honest "no preview" placeholder', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: 'Import…' }).click()
    const dlg = page.getByRole('dialog')
    await dlg.getByRole('button', { name: 'Choose folder…' }).click()
    await importBtn(page).click()
    await dlg.getByRole('button', { name: 'Done' }).click()
    await page.getByRole('button', { name: /^Card import/ }).click()
    await expect(page.getByText('No preview yet').first()).toBeVisible()
  })

  test('F01-E1 double-clicking Import imports once', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: 'Import…' }).click()
    const dlg = page.getByRole('dialog')
    await dlg.getByRole('button', { name: 'Choose folder…' }).click()
    await expect(importBtn(page)).toBeEnabled()
    await importBtn(page).dblclick()
    await expect(dlg.getByText('Added 15 photos.')).toBeVisible()
    await dlg.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByRole('grid', { name: /111 photos/ })).toBeVisible()
  })

  test('F01-E2 Escape cancels an idle dialog, and reopening starts fresh', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: 'Import…' }).click()
    await page.getByRole('dialog').getByRole('button', { name: 'Choose folder…' }).click()
    await expect(page.getByText(/Found 12 photos/)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await page.getByRole('button', { name: 'Import…' }).click()
    await expect(page.getByText('Nothing chosen yet')).toBeVisible()
    await expect(page.getByText(/Found 12 photos/)).toHaveCount(0)
  })

  test('F01-E3 copy mode needs a destination before it can start', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: 'Import…' }).click()
    const dlg = page.getByRole('dialog')
    await dlg.getByRole('button', { name: 'Choose folder…' }).click()
    await dlg.getByRole('radio', { name: /Copy into a folder/ }).check()
    await expect(importBtn(page)).toBeDisabled()
    await dlg.getByRole('button', { name: 'Choose destination…' }).click()
    await expect(importBtn(page)).toBeEnabled()
  })

  test('F01-E4 switching back to leave-in-place re-enables import without a destination', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: 'Import…' }).click()
    const dlg = page.getByRole('dialog')
    await dlg.getByRole('button', { name: 'Choose folder…' }).click()
    await dlg.getByRole('radio', { name: /Copy into a folder/ }).check()
    await dlg.getByRole('radio', { name: /Leave in place/ }).check()
    await expect(importBtn(page)).toBeEnabled()
  })

  test('F01-E5 importing into an empty library works', async ({ page }) => {
    await open(page, '?seed=0')
    await page.getByRole('button', { name: 'Import photos…' }).click()
    const dlg = page.getByRole('dialog')
    await dlg.getByRole('button', { name: 'Choose folder…' }).click()
    await importBtn(page).click()
    await dlg.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByRole('grid', { name: /15 photos/ })).toBeVisible()
    await expect(cells(page).first()).toBeVisible()
  })

  test('F01-N1 a folder that does not exist shows an error and cannot be imported', async ({ page }) => {
    await open(page, '?pick=C:/Missing')
    await page.getByRole('button', { name: 'Import…' }).click()
    const dlg = page.getByRole('dialog')
    await dlg.getByRole('button', { name: 'Choose folder…' }).click()
    await expect(dlg.getByRole('alert')).toHaveText('That folder does not exist.')
    await expect(importBtn(page)).toBeDisabled()
  })

  test('F01-A1 the dialog is labelled, traps focus and passes an accessibility scan', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: 'Import…' }).click()
    await expect(page.getByRole('dialog', { name: 'Import photos' })).toBeVisible()
    for (let i = 0; i < 12; i++) await page.keyboard.press('Tab')
    expect(await page.evaluate(() => !!document.activeElement?.closest('dialog'))).toBe(true)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  })
})

test.describe('F01 import: choosing which photos', () => {
  const openDialog = async (page: import('@playwright/test').Page) => {
    await open(page)
    await page.getByRole('button', { name: 'Import…' }).click()
    const dlg = page.getByRole('dialog', { name: 'Import photos' })
    await dlg.getByRole('button', { name: 'Choose folder…' }).click()
    await expect(dlg.getByRole('list', { name: 'Photos in this folder' })).toBeVisible()
    return dlg
  }
  const tile = (dlg: import('@playwright/test').Locator, name: string) => dlg.getByRole('checkbox', { name: new RegExp(name) })

  test('F01-S1 choosing a folder lists its photos, all ticked to start with', async ({ page }) => {
    const dlg = await openDialog(page)
    await expect(dlg.getByRole('list', { name: 'Photos in this folder' }).getByRole('listitem')).toHaveCount(15)
    await expect(dlg.getByRole('list', { name: 'Photos in this folder' }).getByRole('checkbox')).toHaveCount(15)
    for (const box of await dlg.getByRole('list', { name: 'Photos in this folder' }).getByRole('checkbox').all()) await expect(box).toBeChecked()
    await expect(dlg.getByText('15 of 15 selected')).toBeVisible()
    await expect(importBtn(page)).toHaveText('Import 15 photos')
    await expect(dlg.getByRole('button', { name: 'Select all' })).toBeDisabled()
  })

  test('F01-S2 unticked photos are not imported', async ({ page }) => {
    const dlg = await openDialog(page)
    await tile(dlg, 'IMG_0001.jpg').click()
    await tile(dlg, 'IMG_0002.jpg').click()
    await expect(dlg.getByText('13 of 15 selected')).toBeVisible()
    await expect(importBtn(page)).toHaveText('Import 13 photos')
    await importBtn(page).click()
    await expect(dlg.getByText('Added 13 photos.')).toBeVisible()
    await dlg.getByRole('button', { name: 'Done' }).click()
    await expect(page.getByRole('grid', { name: /109 photos/ })).toBeVisible() // 96 + 13, not 96 + 15
  })

  test('F01-S3 Select none stops the import and Select all brings it back', async ({ page }) => {
    const dlg = await openDialog(page)
    await dlg.getByRole('button', { name: 'Select none' }).click()
    await expect(dlg.getByText('0 of 15 selected')).toBeVisible()
    await expect(importBtn(page)).toBeDisabled()
    await expect(dlg.getByRole('button', { name: 'Select none' })).toBeDisabled()
    await tile(dlg, 'IMG_0003.jpg').click()
    await expect(importBtn(page)).toBeEnabled()
    await expect(importBtn(page)).toHaveText('Import 1 photo')
    await dlg.getByRole('button', { name: 'Select all' }).click()
    await expect(dlg.getByText('15 of 15 selected')).toBeVisible()
  })

  test('F01-S4 Shift-click unticks or ticks everything between two photos', async ({ page }) => {
    const dlg = await openDialog(page)
    await tile(dlg, 'IMG_0002.jpg').click()
    await tile(dlg, 'IMG_0005.jpg').click({ modifiers: ['Shift'] })
    await expect(dlg.getByText('11 of 15 selected')).toBeVisible() // 2, 3, 4 and 5 are off
    for (const n of ['0002', '0003', '0004', '0005']) await expect(tile(dlg, `IMG_${n}.jpg`)).not.toBeChecked()
    await expect(tile(dlg, 'IMG_0006.jpg')).toBeChecked()
    await tile(dlg, 'IMG_0003.jpg').click({ modifiers: ['Shift'] }) // from 5 back to 3: ticks 3, 4 and 5
    await expect(dlg.getByText('14 of 15 selected')).toBeVisible()
    await expect(tile(dlg, 'IMG_0002.jpg')).not.toBeChecked()
  })

  test('F01-S5 each photo shows a picture and its name, RAW files are marked, and subfolders show in the tooltip', async ({ page }) => {
    const dlg = await openDialog(page)
    await expect(dlg.locator('.import-grid img')).toHaveCount(15)
    await expect(dlg.locator('.import-raw')).toHaveCount(3)
    await expect(dlg.getByText('RAW_0013.CR2')).toBeVisible()
    await expect(dlg.locator('label.import-tile', { hasText: 'IMG_0011.jpg' })).toHaveAttribute('title', 'Day 2/IMG_0011.jpg')
    await expect(dlg.locator('label.import-tile', { hasText: 'IMG_0001.jpg' })).toHaveAttribute('title', 'IMG_0001.jpg')
  })

  test('F01-S6 the keyboard can tick and untick: Space on a focused photo', async ({ page }) => {
    const dlg = await openDialog(page)
    const box = tile(dlg, 'IMG_0004.jpg')
    await box.focus()
    await page.keyboard.press('Space')
    await expect(box).not.toBeChecked()
    await expect(dlg.getByText('14 of 15 selected')).toBeVisible()
    await page.keyboard.press('Space')
    await expect(box).toBeChecked()
  })

  test('F01-S7 choosing again, or reopening, starts with everything ticked', async ({ page }) => {
    const dlg = await openDialog(page)
    await dlg.getByRole('button', { name: 'Select none' }).click()
    await dlg.getByRole('button', { name: 'Choose folder…' }).click()
    await expect(dlg.getByText('15 of 15 selected')).toBeVisible()
    await tile(dlg, 'IMG_0001.jpg').click()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Import…' }).click()
    await expect(page.getByRole('list', { name: 'Photos in this folder' })).toHaveCount(0)
  })

  test('F01-S8 the photo list passes an accessibility scan', async ({ page }) => {
    await openDialog(page)
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  })

  test('F01-S9 what was ticked is what the core is asked to import', async ({ page }) => {
    const dlg = await openDialog(page)
    await dlg.getByRole('button', { name: 'Select none' }).click()
    await tile(dlg, 'IMG_0010.jpg').click()
    await tile(dlg, 'RAW_0014.CR2').click()
    await importBtn(page).click()
    await expect(dlg.getByText('Added 2 photos.')).toBeVisible()
    await expect(dlg.getByText('1 file could not be previewed.')).toBeVisible() // the one RAW file
  })
})

test.describe('Help and shortcuts', () => {
  const help = (page: import('@playwright/test').Page) => page.getByRole('dialog', { name: 'Help and shortcuts' })

  test('HP1 the ? key and the ? button open the help, which has a guide, the shortcuts and tips, and Escape closes it', async ({ page }) => {
    await open(page)
    await page.keyboard.press('?')
    await expect(help(page)).toBeVisible()
    await expect(help(page).getByRole('heading', { name: 'Getting started' })).toBeVisible()
    await expect(help(page).getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible()
    await expect(help(page).getByRole('heading', { name: 'Good to know' })).toBeVisible()
    await expect(help(page).getByRole('list').first().getByRole('listitem')).toHaveCount(5)
    for (const group of ['Everywhere', 'Library', 'Develop']) await expect(help(page).getByRole('table', { name: group })).toBeVisible()
    await expect(help(page).getByRole('row', { name: /Ctrl\+Z/ })).toContainText('Undo the last edit')
    await page.keyboard.press('Escape')
    await expect(help(page)).toHaveCount(0)
    await page.getByRole('button', { name: 'Help and shortcuts' }).click()
    await expect(help(page)).toBeVisible()
    await help(page).getByRole('button', { name: 'Close' }).click()
    await expect(help(page)).toHaveCount(0)
  })

  test('HP2 typing a question mark in a box does not open the help', async ({ page }) => {
    await open(page)
    await page.getByRole('tab', { name: 'Text' }).click()
    await page.getByRole('searchbox').or(page.getByRole('textbox').first()).first().fill('why?')
    await page.keyboard.press('?')
    await expect(help(page)).toHaveCount(0)
  })

  test('HP3 it works from Develop too, and the help passes an accessibility scan', async ({ page }) => {
    await open(page)
    await cells(page).first().click()
    await page.keyboard.press('d')
    await expect(page.getByRole('region', { name: 'Edit' })).toBeVisible()
    await page.keyboard.press('?')
    await expect(help(page)).toBeVisible()
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
  })
})

test.describe('Paste settings onto several photos', () => {
  const paste = (page: import('@playwright/test').Page) => page.getByRole('button', { name: 'Paste settings', exact: true })

  test('PS1 settings copied in Develop can be pasted onto the photos selected in the Library', async ({ page }) => {
    await open(page)
    await expect(paste(page)).toBeDisabled() // nothing copied yet
    await cells(page).nth(0).click()
    await page.keyboard.press('d')
    await expect(page.getByRole('region', { name: 'Edit' })).toBeVisible()
    await page.getByRole('textbox', { name: 'Exposure value', exact: true }).fill('1.2')
    await page.getByRole('textbox', { name: 'Exposure value', exact: true }).press('Enter')
    await page.getByRole('button', { name: 'Copy settings…' }).click()
    await page.getByRole('dialog', { name: 'Copy settings' }).getByRole('button', { name: 'Copy', exact: true }).click()
    await page.keyboard.press('g')
    await expect(page.getByRole('grid', { name: /Photo grid/ })).toBeVisible()
    await expect(paste(page)).toBeEnabled()
    await cells(page).nth(1).click()
    await cells(page).nth(2).click({ modifiers: ['Shift'] })
    await paste(page).click()
    await expect(page.getByText(/Settings pasted onto 2 photos/)).toBeVisible()
    // the second photo now has the copied exposure
    await cells(page).nth(1).click()
    await page.keyboard.press('d')
    await expect(page.getByRole('slider', { name: 'Exposure', exact: true })).toHaveValue('1.2')
  })

  test('PS2 Ctrl+Shift+V does the same, and pasting again says the photos already match', async ({ page }) => {
    await open(page)
    await cells(page).nth(0).click()
    await page.keyboard.press('d')
    await page.getByRole('textbox', { name: 'Exposure value', exact: true }).fill('0.6')
    await page.getByRole('textbox', { name: 'Exposure value', exact: true }).press('Enter')
    await page.getByRole('button', { name: 'Copy settings…' }).click()
    await page.getByRole('dialog', { name: 'Copy settings' }).getByRole('button', { name: 'Copy', exact: true }).click()
    await page.keyboard.press('g')
    await cells(page).nth(3).click()
    await page.keyboard.press('Control+Shift+v')
    await expect(page.getByText('Settings pasted onto 1 photo')).toBeVisible()
    await page.keyboard.press('Control+Shift+v')
    await expect(page.getByText('That photo already has these settings.')).toBeVisible()
  })
})
