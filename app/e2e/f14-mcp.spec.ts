import AxeBuilder from '@axe-core/playwright'
import { expect, open, test } from './helpers'
import type { Page } from '@playwright/test'

const dialog = (page: Page) => page.getByRole('dialog', { name: 'AI connection' })
const allow = (page: Page) => dialog(page).getByRole('checkbox', { name: /Allow an AI assistant/ })
const openDialog = async (page: Page, query = '') => {
  await open(page, query)
  await page.getByRole('button', { name: 'AI connection' }).click()
  await expect(dialog(page)).toBeVisible()
  return dialog(page)
}

test.describe('F14 AI connection', () => {
  test('MC1 it is off to begin with, says what an assistant can and cannot do, and shows no token', async ({ page }) => {
    const dlg = await openDialog(page)
    await expect(allow(page)).not.toBeChecked()
    await expect(dlg.getByRole('list', { name: 'What an assistant can do' }).getByRole('listitem')).toHaveCount(6)
    await expect(dlg.getByText(/cannot delete photos/)).toBeVisible()
    await expect(dlg.getByLabel('Secret token')).toHaveCount(0)
    await expect(dlg.getByRole('status')).toHaveCount(0)
  })

  test('MC2 switching it on shows where it listens, hides the token until asked, and gives the command for Claude Code', async ({ page }) => {
    const dlg = await openDialog(page)
    await allow(page).check()
    await expect(dlg.getByRole('status').first()).toContainText('http://127.0.0.1:47321/mcp')
    const token = dlg.getByLabel('Secret token')
    await expect(token).toHaveText(/^•+$/)
    const command = dlg.getByLabel('Command for Claude Code')
    await expect(command).toContainText('claude mcp add --transport http lucent-raw http://127.0.0.1:47321/mcp')
    await expect(command).not.toContainText('aaaaaaaa')
    await dlg.getByRole('button', { name: 'Show', exact: true }).click()
    await expect(token).toHaveText('a'.repeat(64))
    await expect(command).toContainText('Bearer ' + 'a'.repeat(64))
    await dlg.getByRole('button', { name: 'Hide', exact: true }).click()
    await expect(token).toHaveText(/^•+$/)
  })

  test('MC3 the token can be copied, and a new one is made only after a confirmation', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const dlg = await openDialog(page)
    await allow(page).check()
    await dlg.getByRole('button', { name: 'Copy token' }).click()
    await expect(dlg.getByText('Copied the token.')).toBeVisible()
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('a'.repeat(64))
    await dlg.getByRole('button', { name: 'Make a new token' }).click()
    await expect(dlg.getByRole('button', { name: 'Yes, make a new token' })).toBeVisible()
    await dlg.getByRole('button', { name: 'Keep this one' }).click()
    await dlg.getByRole('button', { name: 'Show', exact: true }).click()
    await expect(dlg.getByLabel('Secret token')).toHaveText('a'.repeat(64)) // nothing changed
    await dlg.getByRole('button', { name: 'Make a new token' }).click()
    await dlg.getByRole('button', { name: 'Yes, make a new token' }).click()
    await expect(dlg.getByLabel('Secret token')).not.toHaveText('a'.repeat(64))
    await expect(dlg.getByLabel('Secret token')).toHaveText(/^f{32}[0-9a-f]{32}$/)
  })

  test('MC4 it can be switched off again, and the token and command go away', async ({ page }) => {
    const dlg = await openDialog(page)
    await allow(page).check()
    await expect(dlg.getByLabel('Secret token')).toBeVisible()
    await allow(page).uncheck()
    await expect(dlg.getByLabel('Secret token')).toHaveCount(0)
    await expect(dlg.getByLabel('Command for Claude Code')).toHaveCount(0)
    await dlg.getByRole('button', { name: 'Done' }).click()
    await page.getByRole('button', { name: 'AI connection' }).click()
    await expect(allow(page)).not.toBeChecked()
  })

  test('MC5 when it cannot start, it says why and stays off', async ({ page }) => {
    const dlg = await openDialog(page, '?mcpfail=1')
    await allow(page).click() // it ends up off again, so check() would complain that it did not stay on
    await expect(dlg.getByRole('alert')).toContainText('could not be used')
    await expect(allow(page)).not.toBeChecked()
    await expect(dlg.getByLabel('Secret token')).toHaveCount(0)
  })

  test('MC6 the dialog has no accessibility violations, on and off', async ({ page }) => {
    const dlg = await openDialog(page)
    const scan = async () => expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
    await scan()
    await allow(page).check()
    await dlg.getByRole('button', { name: 'Show', exact: true }).click()
    await scan()
  })
})
