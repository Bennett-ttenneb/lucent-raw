import { expect, open, pick, test } from './helpers'
import type { Page } from '@playwright/test'

const slider = (page: Page, name: string) => page.getByRole('slider', { name, exact: true })
const tools = (page: Page) => page.getByRole('toolbar', { name: 'Develop tools' })

async function setSlider(page: Page, name: string, value: string) {
  const box = page.getByRole('textbox', { name: `${name} value`, exact: true })
  await box.click()
  await box.fill(value)
  await box.press('Enter')
}
async function openDevelop(page: Page, index = 0) {
  await open(page)
  await pick(page, index)
  await page.getByRole('tab', { name: 'Develop' }).click()
  await expect(page.getByRole('complementary', { name: 'Develop controls' })).not.toHaveAttribute('aria-busy', 'true')
}

test.describe('F25 develop: gaps in the must-have list', () => {
  test('DG1 Previous goes back to how the photo was when it was opened, as one step that can be undone', async ({ page }) => {
    await openDevelop(page)
    await expect(tools(page).getByRole('button', { name: 'Previous' })).toBeDisabled()
    await setSlider(page, 'Exposure', '1.5')
    await setSlider(page, 'Contrast', '20')
    await expect(tools(page).getByRole('button', { name: 'Previous' })).toBeEnabled()
    await tools(page).getByRole('button', { name: 'Previous' }).click()
    await expect(slider(page, 'Exposure')).toHaveValue('0')
    await expect(slider(page, 'Contrast')).toHaveValue('0')
    await expect(page.getByRole('list', { name: /Edit history/ }).getByRole('button', { name: /Previous/ })).toBeVisible()
    await expect(tools(page).getByRole('button', { name: 'Previous' })).toBeDisabled()
    await page.keyboard.press('Control+z')
    await expect(slider(page, 'Exposure')).toHaveValue('1.5')
    await expect(slider(page, 'Contrast')).toHaveValue('20')
  })

  test('DG2 Previous means how the photo was when it was opened, not before the last edit: a photo that already had edits goes back to those', async ({ page }) => {
    await openDevelop(page)
    await setSlider(page, 'Exposure', '1')
    // away to another photo and back: the edit is now part of how it was opened
    await page.getByRole('tab', { name: 'Library' }).click()
    await pick(page, 0)
    await page.getByRole('tab', { name: 'Develop' }).click()
    await expect(slider(page, 'Exposure')).toHaveValue('1')
    await expect(tools(page).getByRole('button', { name: 'Previous' })).toBeDisabled()
    await setSlider(page, 'Exposure', '-2')
    await tools(page).getByRole('button', { name: 'Previous' }).click()
    await expect(slider(page, 'Exposure')).toHaveValue('1')
  })
})

test.describe('F25 develop: sync', () => {
  test('DG3 Sync gives the other selected photos this photo\'s ticked settings, as a history step on each', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await page.getByRole('gridcell').nth(1).click({ modifiers: ['Control'] })
    await page.getByRole('tab', { name: 'Develop' }).click()
    await expect(page.getByRole('complementary', { name: 'Develop controls' })).not.toHaveAttribute('aria-busy', 'true')
    await expect(tools(page).getByRole('button', { name: 'Sync…' })).toBeDisabled() // nothing edited yet
    await setSlider(page, 'Exposure', '1.5')
    await tools(page).getByRole('button', { name: 'Sync…' }).click()
    const dlg = page.getByRole('dialog', { name: 'Sync settings' })
    await expect(dlg).toContainText('the other selected photo')
    await dlg.getByRole('button', { name: 'Sync' }).click()
    await expect(page.getByText('Settings synced to 1 photo')).toBeVisible()
  })

  test('DG4 with only one photo selected there is nothing to sync to', async ({ page }) => {
    await openDevelop(page)
    await setSlider(page, 'Exposure', '1')
    await expect(tools(page).getByRole('button', { name: 'Sync…' })).toBeDisabled()
  })
})

test.describe('F25 develop: detail', () => {
  const detail = (page: Page) => page.locator('section.panel', { hasText: 'Noise reduction' })
  const s = (page: Page, name: string) => detail(page).getByRole('slider', { name, exact: true })

  test('DG5 sharpening has a Detail slider and noise reduction has luminance detail and contrast and colour smoothness, each with its own plain value and history name', async ({ page }) => {
    await openDevelop(page)
    await expect(s(page, 'Detail')).toHaveValue('0')
    await expect(s(page, 'Luminance detail')).toHaveValue('50')
    await expect(s(page, 'Luminance contrast')).toHaveValue('0')
    await expect(s(page, 'Colour smoothness')).toHaveValue('50')
    await setSlider(page, 'Detail', '40')
    await setSlider(page, 'Luminance detail', '80')
    await expect(page.getByRole('list', { name: /Edit history/ }).getByRole('button', { name: /Sharpening detail/ })).toBeVisible()
    await expect(page.getByRole('list', { name: /Edit history/ }).getByRole('button', { name: /Luminance noise reduction detail/ })).toBeVisible()
    await detail(page).getByRole('button', { name: 'Reset', exact: true }).click()
    await expect(s(page, 'Detail')).toHaveValue('0')
    await expect(s(page, 'Luminance detail')).toHaveValue('50')
  })
})

test.describe('F25 develop: crop ratio of your own', () => {
  test('DG6 a ratio typed in is used for the frame, refused when it is not a ratio, and shows in History', async ({ page }) => {
    await openDevelop(page)
    const box = page.getByRole('group', { name: 'Ratio of your own' })
    await expect(box.getByRole('button', { name: 'Use' })).toBeDisabled()
    await box.getByLabel('Ratio width').fill('0')
    await box.getByLabel('Ratio height').fill('5')
    await expect(box.getByRole('alert')).toContainText('0.1 to 100')
    await expect(box.getByRole('button', { name: 'Use' })).toBeDisabled()
    await box.getByLabel('Ratio width').fill('7')
    await expect(box.getByRole('button', { name: 'Use' })).toBeEnabled()
    await box.getByRole('button', { name: 'Use' }).click()
    await expect(box.getByRole('button', { name: 'Use' })).toHaveAttribute('aria-pressed', 'true')
    await expect(page.getByRole('list', { name: /Edit history/ }).getByRole('button', { name: /Crop.*7:5/ })).toBeVisible()
    // a named ratio takes over again
    await page.getByRole('group', { name: 'Aspect ratio' }).getByRole('button', { name: '1:1' }).click()
    await expect(box.getByRole('button', { name: 'Use' })).toHaveAttribute('aria-pressed', 'false')
  })
})
