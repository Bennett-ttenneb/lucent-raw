import AxeBuilder from '@axe-core/playwright'
import { cells, expect, open, test } from './helpers'

test.describe('F09 export', () => {
  test('F09-H1 export one photo', async ({ page }) => {
    await open(page)
    await cells(page).first().click()
    await page.getByRole('button', { name: 'Export…' }).click()
    const dlg = page.getByRole('dialog', { name: 'Export photos' })
    await expect(dlg.getByText('Exporting 1 photo.')).toBeVisible()
    await expect(dlg.getByRole('button', { name: 'Export', exact: true })).toBeDisabled()
    await dlg.getByRole('button', { name: 'Choose folder…' }).click()
    await dlg.getByRole('button', { name: 'Export', exact: true }).click()
    await expect(dlg.getByText('Wrote 1 file.')).toBeVisible()
    await dlg.getByRole('button', { name: 'Done' }).click()
    await expect(dlg).toHaveCount(0)
  })

  test('F09-H3 camera details are kept by default for a JPEG, and the choice is off for other formats', async ({ page }) => {
    await open(page)
    await cells(page).first().click()
    await page.getByRole('button', { name: 'Export…' }).click()
    const dlg = page.getByRole('dialog', { name: 'Export photos' })
    const keep = dlg.getByRole('checkbox', { name: 'Keep camera details in the file' })
    await expect(keep).toBeChecked()
    await keep.uncheck()
    await expect(keep).not.toBeChecked()
    await dlg.getByLabel('Format').selectOption('png')
    await expect(keep).toBeDisabled()
    await expect(dlg.getByText('Only JPEG files can carry them here.')).toBeVisible()
  })

  test('F09-H2 export a multi-selection', async ({ page }) => {
    await open(page)
    await cells(page).nth(0).click()
    await cells(page).nth(2).click({ modifiers: ['Shift'] })
    await page.getByRole('button', { name: 'Export…' }).click()
    await expect(page.getByText('Exporting 3 photos.')).toBeVisible()
  })

  test('F09-E1 invalid sizes block the export and are announced', async ({ page }) => {
    await open(page)
    await cells(page).first().click()
    await page.getByRole('button', { name: 'Export…' }).click()
    const dlg = page.getByRole('dialog')
    await dlg.getByRole('button', { name: 'Choose folder…' }).click()
    const size = dlg.getByLabel('Longest side (px)')
    for (const bad of ['-5', '99999', '1.5']) {
      await size.fill(bad)
      await expect(size).toHaveAttribute('aria-invalid', 'true')
      await expect(dlg.getByRole('button', { name: 'Export', exact: true })).toBeDisabled()
    }
    await size.fill('0')
    await expect(size).toHaveAttribute('aria-invalid', 'false')
    await expect(dlg.getByRole('button', { name: 'Export', exact: true })).toBeEnabled()
  })

  test('F09-E2 an empty size field is not treated as valid', async ({ page }) => {
    await open(page)
    await cells(page).first().click()
    await page.getByRole('button', { name: 'Export…' }).click()
    const dlg = page.getByRole('dialog')
    await dlg.getByRole('button', { name: 'Choose folder…' }).click()
    await dlg.getByLabel('Longest side (px)').fill('')
    // An empty box is 0 to Number(), which would silently export full size. It must be rejected or clearly 0.
    await expect(dlg.getByRole('button', { name: 'Export', exact: true })).toBeDisabled()
  })

  test('F09-E3 Export is disabled when the library is empty', async ({ page }) => {
    await open(page, '?seed=0')
    await expect(page.getByRole('button', { name: 'Export…' })).toBeDisabled()
  })

  test('F09-E4 the dialog passes an accessibility scan', async ({ page }) => {
    await open(page)
    await cells(page).first().click()
    await page.getByRole('button', { name: 'Export…' }).click()
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  })
})

test.describe('F09 export: colour space', () => {
  const openDialog = async (page: import('@playwright/test').Page) => {
    await open(page)
    await cells(page).first().click()
    await page.getByRole('button', { name: 'Export…' }).click()
    return page.getByRole('dialog', { name: 'Export photos' })
  }
  const sent = (page: import('@playwright/test').Page) => page.evaluate(() => ((globalThis as { __exports?: { settings: { colourSpace: string } }[] }).__exports ?? []).map((e) => ({ colourSpace: e.settings.colourSpace })))

  test('F09-C1 the colour space starts as sRGB, offers four spaces, and what is chosen is what is sent', async ({ page }) => {
    const dlg = await openDialog(page)
    const select = dlg.getByRole('combobox', { name: 'Colour space' })
    await expect(select).toHaveValue('srgb')
    await expect(select.getByRole('option')).toHaveText(['sRGB', 'Display P3', 'Adobe RGB (1998)', 'ProPhoto RGB'])
    await select.selectOption('adobeRgb')
    await dlg.getByRole('button', { name: 'Choose folder…' }).click()
    await dlg.getByRole('button', { name: 'Export', exact: true }).click()
    await expect(dlg.getByText('Wrote 1 file.')).toBeVisible()
    expect((await sent(page)).map((s) => s.colourSpace)).toEqual(['adobeRgb'])
  })

  test('F09-C2 the default is sent as sRGB', async ({ page }) => {
    const dlg = await openDialog(page)
    await dlg.getByRole('button', { name: 'Choose folder…' }).click()
    await dlg.getByRole('button', { name: 'Export', exact: true }).click()
    await expect(dlg.getByText('Wrote 1 file.')).toBeVisible()
    expect((await sent(page)).map((s) => s.colourSpace)).toEqual(['srgb'])
  })

  test('F09-C3 a larger space says honestly what it can and cannot do', async ({ page }) => {
    const dlg = await openDialog(page)
    await expect(dlg.getByText('sRGB works everywhere.')).toBeVisible()
    await dlg.getByRole('combobox', { name: 'Colour space' }).selectOption('displayP3')
    await expect(dlg.getByText(/cannot add colours beyond sRGB/)).toBeVisible()
    await expect(dlg.getByText('sRGB works everywhere.')).toHaveCount(0)
  })

  test('F09-C4 no accessibility violations with a larger space chosen', async ({ page }) => {
    const dlg = await openDialog(page)
    await dlg.getByRole('combobox', { name: 'Colour space' }).selectOption('proPhoto')
    expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([])
  })
})

test.describe('F09 export: formats, presets, watermark and border', () => {
  type P = import('@playwright/test').Page
  const openDialog = async (page: P, query = '') => {
    await open(page, query)
    await cells(page).first().click()
    await page.getByRole('button', { name: 'Export…' }).click()
    const dlg = page.getByRole('dialog', { name: 'Export photos' })
    await expect(dlg).toBeVisible()
    return dlg
  }
  const exportNow = async (page: P, dlg: import('@playwright/test').Locator) => {
    await dlg.getByRole('button', { name: 'Choose folder…' }).click()
    await dlg.getByRole('button', { name: 'Export', exact: true }).click()
    await expect(dlg.getByText(/Wrote 1 file/)).toBeVisible()
    return page.evaluate(() => {
      const log = (globalThis as { __exports?: { settings: Record<string, any> }[] }).__exports ?? []
      return log[log.length - 1].settings
    })
  }
  const previewText = async (dlg: import('@playwright/test').Locator) => decodeURIComponent((await dlg.getByRole('img', { name: /How the first photo will look/ }).getAttribute('src')) ?? '')

  test('F09-X1 the formats are JPEG, PNG, TIFF and lossless WebP; only JPEG has a quality setting', async ({ page }) => {
    const dlg = await openDialog(page)
    const format = dlg.getByRole('combobox', { name: 'Format' })
    await expect(format).toHaveValue('jpeg')
    await expect(format.getByRole('option')).toHaveText(['JPEG', 'PNG', 'TIFF', 'WebP (lossless)', 'Original file (copied as it is)', 'DNG (a RAW photo in the open RAW format)'])
    await expect(dlg.getByLabel('Quality')).toBeVisible()
    for (const [value, hint] of [['png', /PNG keeps every detail/], ['tiff', /TIFF keeps every detail/], ['webp', /Lossless WebP/]] as const) {
      await format.selectOption(value)
      await expect(dlg.getByLabel('Quality')).toHaveCount(0)
      await expect(dlg.getByText(hint)).toBeVisible()
    }
    await format.selectOption('tiff')
    expect((await exportNow(page, dlg)).format).toBe('tiff')
  })

  test('F09-X2 a preset sets everything it names, and changing anything afterwards says the settings are your own', async ({ page }) => {
    const dlg = await openDialog(page)
    const preset = dlg.getByRole('combobox', { name: 'Preset' })
    await preset.selectOption('Print, full size TIFF (Adobe RGB)')
    await expect(dlg.getByRole('combobox', { name: 'Format' })).toHaveValue('tiff')
    await expect(dlg.getByLabel('Longest side (px)')).toHaveValue('0')
    await expect(dlg.getByRole('combobox', { name: 'Colour space' })).toHaveValue('adobeRgb')
    await expect(dlg.getByRole('combobox', { name: 'Sharpening' })).toHaveValue('print')
    await expect(preset).toHaveValue('Print, full size TIFF (Adobe RGB)')
    await dlg.getByLabel('Longest side (px)').fill('3000')
    await expect(preset).toHaveValue('')
    await expect(preset.getByRole('option', { name: 'Your own settings' })).toHaveCount(1)
    await preset.selectOption('Client proofs, watermarked')
    await expect(dlg.getByRole('radio', { name: 'Text' })).toBeChecked()
    await expect(dlg.getByRole('textbox', { name: 'Text', exact: true })).toHaveValue('PROOF')
    await expect.poll(() => previewText(dlg)).toContain('watermark: PROOF') // the preview follows a moment after the settings
  })

  test('F09-X3 your own settings can be saved as a preset, come back after closing, and be deleted', async ({ page }) => {
    let dlg = await openDialog(page)
    await dlg.getByRole('combobox', { name: 'Format' }).selectOption('png')
    await dlg.getByLabel('Longest side (px)').fill('1234')
    await expect(dlg.getByRole('button', { name: 'Save as preset' })).toBeDisabled()
    await dlg.getByLabel('Save these').fill('My PNGs')
    await dlg.getByRole('button', { name: 'Save as preset' }).click()
    const preset = dlg.getByRole('combobox', { name: 'Preset' })
    await expect(preset).toHaveValue('My PNGs')
    await expect(preset.locator('optgroup[label="Yours"] option')).toHaveText(['My PNGs'])
    await dlg.getByRole('button', { name: 'Cancel' }).click()
    dlg = await (async () => {
      await page.getByRole('button', { name: 'Export…' }).click()
      return page.getByRole('dialog', { name: 'Export photos' })
    })()
    await dlg.getByRole('combobox', { name: 'Preset' }).selectOption('Web, 2048 px JPEG')
    await dlg.getByRole('combobox', { name: 'Preset' }).selectOption('My PNGs')
    await expect(dlg.getByRole('combobox', { name: 'Format' })).toHaveValue('png')
    await expect(dlg.getByLabel('Longest side (px)')).toHaveValue('1234')
    await dlg.getByRole('button', { name: 'Delete preset' }).click()
    await expect(dlg.getByRole('combobox', { name: 'Preset' }).locator('optgroup[label="Yours"]')).toHaveCount(0)
    await expect(dlg.getByRole('button', { name: 'Delete preset' })).toHaveCount(0)
  })

  test('F09-X4 a text watermark: its text, a position out of nine, size and opacity, and the preview shows it', async ({ page }) => {
    const dlg = await openDialog(page)
    await expect(dlg.getByRole('radio', { name: 'None', exact: true })).toBeChecked()
    await expect(dlg.getByRole('radiogroup', { name: 'Watermark position' })).toHaveCount(0)
    await dlg.getByRole('radio', { name: 'Text' }).check()
    await expect(dlg.getByRole('radiogroup', { name: 'Watermark position' }).getByRole('radio')).toHaveCount(9)
    await expect(dlg.getByRole('radio', { name: 'Bottom right', exact: true })).toBeChecked()
    await dlg.getByRole('textbox', { name: 'Text', exact: true }).fill('© Test Studio')
    await dlg.getByRole('radio', { name: 'Top left', exact: true }).check()
    await dlg.getByRole('textbox', { name: 'Watermark opacity value' }).fill('45')
    await dlg.getByRole('textbox', { name: 'Watermark opacity value' }).press('Enter')
    await expect.poll(() => previewText(dlg)).toContain('watermark: © Test Studio')
    const sent = await exportNow(page, dlg)
    expect(sent.watermark).toMatchObject({ kind: 'text', text: '© Test Studio', anchor: 'topLeft', opacity: 45 })
  })

  test('F09-X5 a logo watermark needs a logo: Export waits until one is chosen', async ({ page }) => {
    const dlg = await openDialog(page)
    await dlg.getByRole('button', { name: 'Choose folder…' }).click()
    await dlg.getByRole('radio', { name: 'Logo image' }).check()
    await expect(dlg.getByRole('alert').filter({ hasText: 'Choose the image' })).toBeVisible()
    await expect(dlg.getByRole('button', { name: 'Export', exact: true })).toBeDisabled()
    await dlg.getByRole('button', { name: 'Choose image…' }).click()
    await expect(dlg.getByText('C:/Demo/logo.png')).toBeVisible()
    await expect(dlg.getByRole('button', { name: 'Export', exact: true })).toBeEnabled()
    await dlg.getByRole('button', { name: 'Export', exact: true }).click()
    await expect(dlg.getByText(/Wrote 1 file/)).toBeVisible()
    const sent = await page.evaluate(() => (globalThis as { __exports?: { settings: Record<string, any> }[] }).__exports!.at(-1)!.settings)
    expect(sent.watermark).toMatchObject({ kind: 'image', imagePath: 'C:/Demo/logo.png' })
  })

  test('F09-X6 a border with the camera settings under the photo: which ones, and a line of your own', async ({ page }) => {
    const dlg = await openDialog(page)
    await expect(dlg.getByLabel('Border width')).toHaveCount(0)
    await dlg.getByRole('checkbox', { name: /Add a border/ }).check()
    await expect(dlg.getByRole('textbox', { name: 'Border width value' })).toBeVisible()
    await expect(dlg.getByRole('group', { name: 'Settings to show' })).toHaveCount(0)
    expect(await previewText(dlg)).toContain('border')
    await dlg.getByRole('checkbox', { name: /Show the camera settings/ }).check()
    const fields = dlg.getByRole('group', { name: 'Settings to show' })
    await expect(fields.getByRole('checkbox')).toHaveCount(7)
    for (const name of ['Camera', 'Lens', 'Focal length', 'Aperture', 'Shutter speed', 'ISO']) await expect(fields.getByRole('checkbox', { name })).toBeChecked()
    await expect(fields.getByRole('checkbox', { name: 'Date' })).not.toBeChecked()
    await fields.getByRole('checkbox', { name: 'ISO' }).uncheck()
    await fields.getByRole('checkbox', { name: 'Date' }).check()
    await dlg.getByLabel('Your own line').fill('Studio session')
    await expect.poll(() => previewText(dlg)).toContain('border and caption')
    await dlg.getByRole('button', { name: 'White' }).click()
    const sent = await exportNow(page, dlg)
    expect(sent.border).toMatchObject({ enabled: true, colour: [255, 255, 255] })
    expect(sent.border.caption).toMatchObject({ show: true, camera: true, iso: false, date: true, note: 'Studio session' })
  })

  test('F09-X6b the camera settings can be set out as two lines, one line or one line each, with the separator, the spacing and the weight chosen', async ({ page }) => {
    const dlg = await openDialog(page)
    await dlg.getByRole('checkbox', { name: /Add a border/ }).check()
    await dlg.getByRole('checkbox', { name: /Show the camera settings/ }).check()
    await expect(dlg.getByLabel('Layout')).toHaveValue('grouped')
    await expect(dlg.getByLabel('Between items')).toHaveValue('dot')
    await expect(dlg.getByRole('textbox', { name: 'Space round the separator value' })).toHaveValue('2')
    await expect(dlg.getByRole('textbox', { name: 'Letter size value' })).toHaveValue('1.6')
    await expect(dlg.getByLabel('Letters')).toHaveValue('regular')
    await dlg.getByLabel('Layout').selectOption('single')
    await dlg.getByLabel('Between items').selectOption('bar')
    const space = dlg.getByRole('textbox', { name: 'Space round the separator value' })
    await space.fill('4')
    await space.press('Enter')
    const size = dlg.getByRole('textbox', { name: 'Letter size value' })
    await size.fill('2.4')
    await size.press('Enter')
    await dlg.getByLabel('Letters').selectOption('semibold')
    // one line for each item has nothing between items, so those two choices wait
    await dlg.getByLabel('Layout').selectOption('items')
    await expect(dlg.getByLabel('Between items')).toBeDisabled()
    await expect(dlg.getByRole('textbox', { name: 'Space round the separator value' })).toHaveValue('4') // the choice is kept while it does not apply
    await dlg.getByLabel('Layout').selectOption('single')
    await expect(dlg.getByLabel('Between items')).toBeEnabled()
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id)).toEqual([])
    const sent = await exportNow(page, dlg)
    expect(sent.border.caption).toMatchObject({ show: true, layout: 'single', separator: 'bar', spacing: 4, weight: 'semibold', size: 2.4 })
  })

  test('F09-X7 the file name template is sent as typed', async ({ page }) => {
    const dlg = await openDialog(page)
    await expect(dlg.getByLabel('File names')).toHaveValue('{name}')
    await expect(dlg.getByText(/\{seq\}/)).toBeVisible()
    await dlg.getByLabel('File names').fill('{date}_{name}_{seq}')
    expect((await exportNow(page, dlg)).nameTemplate).toBe('{date}_{name}_{seq}')
  })

  test('F09-X8 the settings used last time are there the next time, after closing the dialog and after a reload', async ({ page }) => {
    let dlg = await openDialog(page)
    await dlg.getByRole('combobox', { name: 'Format' }).selectOption('webp')
    await dlg.getByRole('radio', { name: 'Text' }).check()
    await dlg.getByRole('textbox', { name: 'Text', exact: true }).fill('Remember me')
    await dlg.getByRole('button', { name: 'Cancel' }).click()
    await page.getByRole('button', { name: 'Export…' }).click()
    dlg = page.getByRole('dialog', { name: 'Export photos' })
    await expect(dlg.getByRole('combobox', { name: 'Format' })).toHaveValue('webp')
    await expect(dlg.getByRole('textbox', { name: 'Text', exact: true })).toHaveValue('Remember me')
    await page.reload()
    dlg = await openDialog(page)
    await expect(dlg.getByRole('combobox', { name: 'Format' })).toHaveValue('webp')
    await expect(dlg.getByRole('radio', { name: 'Text' })).toBeChecked()
  })

  test('F09-X9 a preview that cannot be made says why and does not stop the export', async ({ page }) => {
    const dlg = await openDialog(page, '?failpreview=1')
    await expect(dlg.getByText('This photo has no preview yet.')).toBeVisible()
    expect((await exportNow(page, dlg)).format).toBe('jpeg')
  })

  test('F09-X10 the preview follows the settings', async ({ page }) => {
    const dlg = await openDialog(page)
    await expect.poll(() => previewText(dlg)).toContain('jpeg 2048 no watermark no border')
    await dlg.getByRole('combobox', { name: 'Format' }).selectOption('png')
    await dlg.getByLabel('Longest side (px)').fill('1000')
    await expect.poll(() => previewText(dlg)).toContain('png 1000 no watermark no border')
  })

  test('F09-X11 no accessibility violations with a watermark, a border and a caption all on', async ({ page }) => {
    const dlg = await openDialog(page)
    await dlg.getByRole('radio', { name: 'Text' }).check()
    await dlg.getByRole('checkbox', { name: /Add a border/ }).check()
    await dlg.getByRole('checkbox', { name: /Show the camera settings/ }).check()
    await expect.poll(() => previewText(dlg)).toContain('border and caption')
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
  })

  test.describe('into a new folder', () => {
    const openExport = async (page: import('@playwright/test').Page) => {
      await open(page)
      await cells(page).first().click()
      await page.getByRole('button', { name: 'Export…' }).click()
      const dlg = page.getByRole('dialog', { name: 'Export photos' })
      await dlg.getByRole('button', { name: 'Choose folder…' }).click()
      return dlg
    }
    const lastSent = (page: import('@playwright/test').Page) => page.evaluate(() => (globalThis as { __exports?: { destination: string; newFolder: string | null }[] }).__exports!.at(-1)!)

    test('F09-NF1 off by default: the files go straight into the chosen folder', async ({ page }) => {
      const dlg = await openExport(page)
      await expect(dlg.getByRole('checkbox', { name: 'Put the files in a new folder' })).not.toBeChecked()
      await expect(dlg.getByRole('textbox', { name: 'New folder name' })).toHaveCount(0)
      await dlg.getByRole('button', { name: 'Export', exact: true }).click()
      await expect(dlg.getByText('Wrote 1 file.')).toBeVisible()
      expect((await lastSent(page)).newFolder).toBeNull()
    })

    test('F09-NF2 on: a name is offered, can be changed, is sent and the result says where the files went', async ({ page }) => {
      const dlg = await openExport(page)
      await dlg.getByRole('checkbox', { name: 'Put the files in a new folder' }).check()
      const name = dlg.getByRole('textbox', { name: 'New folder name' })
      await expect(name).toHaveValue(/^Lucent Raw export \d{4}-\d{2}-\d{2}$/)
      await name.fill('Proofs for Sam')
      await dlg.getByRole('button', { name: 'Export', exact: true }).click()
      await expect(dlg.getByText(/Wrote 1 file to/)).toBeVisible()
      await expect(dlg.locator('.result .path')).toHaveText('C:/Demo/Library/Proofs for Sam')
      expect(await lastSent(page)).toMatchObject({ destination: 'C:/Demo/Library', newFolder: 'Proofs for Sam' })
    })

    test('F09-NF3 a name that cannot be a folder blocks the export and says why, and the choice is remembered', async ({ page }) => {
      const dlg = await openExport(page)
      await dlg.getByRole('checkbox', { name: 'Put the files in a new folder' }).check()
      const name = dlg.getByRole('textbox', { name: 'New folder name' })
      await name.fill('a/b')
      await expect(dlg.getByRole('alert').filter({ hasText: "cannot contain '/'" })).toBeVisible()
      await expect(dlg.getByRole('button', { name: 'Export', exact: true })).toBeDisabled()
      await name.fill('')
      await expect(dlg.getByRole('alert').filter({ hasText: 'Give the new folder a name' })).toBeVisible()
      await name.fill('Keepers')
      await expect(dlg.getByRole('button', { name: 'Export', exact: true })).toBeEnabled()
      await dlg.getByRole('button', { name: 'Cancel' }).click()
      await page.getByRole('button', { name: 'Export…' }).click()
      const again = page.getByRole('dialog', { name: 'Export photos' })
      await expect(again.getByRole('checkbox', { name: 'Put the files in a new folder' })).toBeChecked()
      await expect(again.getByRole('textbox', { name: 'New folder name' })).toHaveValue('Keepers')
      expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
    })
  })

  test.describe('enlarging small photos', () => {
    const openExport = async (page: import('@playwright/test').Page) => {
      await open(page)
      await cells(page).first().click()
      await page.getByRole('button', { name: 'Export…' }).click()
      const dlg = page.getByRole('dialog', { name: 'Export photos' })
      await dlg.getByRole('button', { name: 'Choose folder…' }).click()
      return dlg
    }
    const sentSettings = (page: import('@playwright/test').Page) => page.evaluate(() => (globalThis as { __exports?: { settings: { enlarge: string; longEdge: number } }[] }).__exports!.at(-1)!.settings)

    test('F09-EN1 off by default, can be set to smooth or AI, is sent, and is remembered', async ({ page }) => {
      const dlg = await openExport(page)
      const pick = dlg.getByRole('combobox', { name: 'Enlarge small photos' })
      await expect(pick).toHaveValue('none')
      await expect(dlg.getByText(/Photos are never made smaller by this/)).toBeVisible()
      await pick.selectOption('ai')
      await dlg.getByLabel('Longest side (px)').fill('5000')
      await dlg.getByRole('button', { name: 'Export', exact: true }).click()
      await expect(dlg.getByText('Wrote 1 file.')).toBeVisible()
      expect(await sentSettings(page)).toMatchObject({ enlarge: 'ai', longEdge: 5000 })
      await dlg.getByRole('button', { name: 'Done' }).click()
      await page.getByRole('button', { name: 'Export…' }).click()
      await expect(page.getByRole('dialog', { name: 'Export photos' }).getByRole('combobox', { name: 'Enlarge small photos' })).toHaveValue('ai')
    })

    test('F09-EN2 the preview and the controls are accessible with the enlarge choice shown', async ({ page }) => {
      const dlg = await openExport(page)
      await dlg.getByRole('combobox', { name: 'Enlarge small photos' }).selectOption('smooth')
      expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
    })
  })
})

test.describe('F09 export: folding sections', () => {
  test('F09-S1 File, Watermark and Border are sections that fold away, and what is folded is remembered', async ({ page }) => {
    await open(page)
    await cells(page).first().click()
    await page.getByRole('button', { name: 'Export…' }).click()
    const dlg = page.getByRole('dialog', { name: 'Export photos' })
    const file = dlg.locator('details.export-section', { hasText: 'File and size' })
    await expect(file).toHaveAttribute('open', '')
    await expect(dlg.getByLabel('Format')).toBeVisible()
    await file.locator('summary').click()
    await expect(dlg.getByLabel('Format')).toBeHidden()
    await expect(dlg.locator('details.export-section')).toHaveCount(3)
    // Preset stays at the top, outside the sections
    await expect(dlg.getByRole('combobox', { name: 'Preset' })).toBeVisible()
    await dlg.getByRole('button', { name: 'Cancel' }).click()
    await page.getByRole('button', { name: 'Export…' }).click()
    await expect(dlg.getByLabel('Format')).toBeHidden()
    await dlg.locator('details.export-section', { hasText: 'File and size' }).locator('summary').click()
    await expect(dlg.getByLabel('Format')).toBeVisible()
  })
})
