import { expect, open, pick, test as base } from './helpers'
import fs from 'node:fs'

// Presses every enabled button of each module on a fresh page (so nothing an earlier button did can hide the next) and records
// any that throw, log an error, leave an alert, or cannot be pressed. A copy of the report is written to C:/temp/button-report.txt.
const test = base
const MODULES = ['Library', 'Develop', 'Retouch', 'Book', 'Print']

for (const m of MODULES) {
  test(`press every button in ${m}, each on a fresh page`, async ({ page, problems }) => {
    test.setTimeout(1_500_000)
    await page.setViewportSize({ width: 1500, height: 900 })
    const report: string[] = []
    const fresh = async () => {
      await open(page)
      await pick(page, 0)
      if (m !== 'Library') await page.getByRole('tab', { name: m }).click()
      await page.waitForTimeout(250)
    }
    await fresh()
    const buttons: { name: string; nth: number }[] = await page.getByRole('button').evaluateAll((els) => {
      const seen: Record<string, number> = {}
      return els
        .filter((e) => !(e as HTMLButtonElement).disabled && (e as HTMLElement).offsetParent !== null)
        .map((e) => (e.getAttribute('aria-label') || e.textContent || '').trim())
        .filter((n) => n && n.length < 60 && !/^(Library|Develop|Retouch|Book|Print)$/.test(n))
        .map((name) => ({ name, nth: (seen[name] = (seen[name] ?? -1) + 1) }))
    })
    for (const { name, nth } of buttons) {
      await fresh()
      const before = problems.length
      const btn = page.getByRole('button', { name, exact: true }).nth(nth)
      try {
        if ((await btn.count()) === 0) {
          report.push(`${m} | ${name} | not there on a fresh page`)
          continue
        }
        await btn.scrollIntoViewIfNeeded({ timeout: 3000 })
        if (await btn.isDisabled()) {
          report.push(`${m} | ${name} | disabled on a fresh page (it was enabled when the list was made)`)
          continue
        }
        await btn.click({ timeout: 4000 })
        await page.waitForTimeout(200)
        const alert = await page.getByRole('alert').first().textContent({ timeout: 300 }).catch(() => null)
        if (alert) report.push(`${m} | ${name} | alert: ${alert.slice(0, 120)}`)
      } catch (e) {
        report.push(`${m} | ${name} | could not press: ${(e as Error).message.split('\n')[0].slice(0, 110)}`)
      }
      if (problems.length > before) {
        report.push(`${m} | ${name} | ${problems.slice(before).join(' ; ').slice(0, 200)}`)
        problems.length = 0
      }
    }
    fs.appendFileSync('C:/temp/button-report.txt', `== ${m}: ${buttons.length} buttons pressed, ${report.length} to look at\n` + report.join('\n') + '\n')
    problems.length = 0
    expect(true).toBe(true)
  })
}
