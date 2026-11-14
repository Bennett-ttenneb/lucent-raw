import { expect, open, test } from './helpers'

test.describe('F30 soft proofing', () => {
  test('SP1 a profile is chosen, the proof is shown and toggled with S, the intent is sent to the core, and the choice is remembered', async ({ page }) => {
    await open(page)
    await page.getByRole('gridcell').first().click()
    await page.getByRole('tab', { name: 'Develop' }).click()
    const panel = page.locator('section.panel[data-title="Soft proofing"]')
    await panel.getByRole('button', { name: 'Soft proofing' }).click() // it starts closed
    await expect(panel.getByRole('checkbox', { name: 'Show the proof' })).toBeDisabled()
    await page.keyboard.press('s')
    await expect(page.getByRole('status').filter({ hasText: 'Choose a colour profile in the Soft proofing panel first.' })).toBeVisible()
    await panel.getByRole('button', { name: 'Choose a profile…' }).click()
    await expect(panel.getByText('Profile: Glossy Paper')).toBeVisible()
    await expect(panel.getByRole('checkbox', { name: 'Show the proof' })).toBeChecked()
    const src = async () => (await page.locator('img.dev-img').first().getAttribute('src')) ?? ''
    await expect.poll(src).toContain('proof-on')
    await page.keyboard.press('s')
    await expect(panel.getByRole('checkbox', { name: 'Show the proof' })).not.toBeChecked()
    await expect.poll(src).not.toContain('proof-')
    await panel.getByRole('checkbox', { name: 'Show the proof' }).check()
    await panel.getByRole('checkbox', { name: 'Mark colours the profile cannot reproduce' }).check()
    await expect.poll(src).toContain('proof-gamut')
    await panel.getByLabel('Rendering intent').selectOption('perceptual')
    const sent = () => page.evaluate(() => (globalThis as { __proof?: unknown[] }).__proof)
    expect((await sent())!.at(-1)).toEqual({ path: 'C:/Profiles/Glossy Paper.icc', intent: 'perceptual' })
    await page.reload()
    expect((await sent())!.at(-1)).toEqual({ path: 'C:/Profiles/Glossy Paper.icc', intent: 'perceptual' }) // sent again at start-up
  })
})
