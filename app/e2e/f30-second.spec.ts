import { expect, open, test } from './helpers'

test.describe('F30 second window', () => {
  test('SW1 the Window menu opens the second window, which is told the open photo whenever it changes and can be held on one photo', async ({ page }) => {
    await open(page)
    await page.getByRole('gridcell').first().click()
    await page.getByRole('menuitem', { name: 'Window' }).click()
    await page.getByRole('menuitem', { name: 'Open the second window' }).click()
    const log = () => page.evaluate(() => (globalThis as { __second?: unknown[] }).__second ?? [])
    await expect.poll(async () => (await log()).filter((x) => typeof x === 'object').length).toBeGreaterThan(0)
    const last = async () => ((await log()).filter((x) => typeof x === 'object') as { id: number; label: string }[]).at(-1)!
    const first = await last()
    expect(first.label).toMatch(/^IMG_\d+\.jpg/)
    await page.getByRole('gridcell').nth(3).click()
    await expect.poll(async () => (await last()).id).not.toBe(first.id)
    const third = await last()
    // hold it on this photo: moving the main window does not move it
    await page.getByRole('menuitem', { name: 'Window' }).click()
    await page.getByRole('menuitem', { name: /Hold the second window/ }).click()
    await page.getByRole('gridcell').nth(5).click()
    await page.waitForTimeout(400)
    expect((await last()).id).toBe(third.id)
    await page.getByRole('menuitem', { name: 'Window' }).click()
    await page.getByRole('menuitem', { name: /Hold the second window/ }).click()
    await expect.poll(async () => (await last()).id).not.toBe(third.id)
    await page.getByRole('menuitem', { name: 'Window' }).click()
    await page.getByRole('menuitem', { name: 'Close the second window' }).click()
    expect((await log()).at(-1)).toBe('close')
  })

  test('SW2 the second window page shows what it is told and says so when it has nothing', async ({ page }) => {
    await page.goto('/?second=1')
    await expect(page.getByRole('status')).toContainText('Open a photo in the main window')
    await page.evaluate(() => (window as unknown as { __emit: (e: string, p: unknown) => void }).__emit('second:show', { id: 3, label: 'IMG_1003.jpg   1/250 s, ƒ/4.0', key: '0.0' }))
    await expect(page.getByRole('img', { name: /IMG_1003\.jpg/ })).toBeVisible()
    await page.evaluate(() => (window as unknown as { __emit: (e: string, p: unknown) => void }).__emit('second:show', { id: null, label: '', key: '' }))
    await expect(page.getByRole('status')).toContainText('Open a photo in the main window')
  })
})
