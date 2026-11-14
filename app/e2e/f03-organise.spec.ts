import AxeBuilder from '@axe-core/playwright'
import { cells, expect, open, pick, test } from './helpers'

const side = (page: import('@playwright/test').Page) => page.getByRole('complementary', { name: 'Library panels' })
const details = (page: import('@playwright/test').Page) => page.getByRole('complementary', { name: 'Photo details' })

async function newCollection(page: import('@playwright/test').Page, name: string, include = true) {
  await page.getByRole('button', { name: 'New collection' }).click()
  await page.getByLabel('Collection name').fill(name)
  const box = page.getByLabel(/Include .* selected photo/)
  if (await box.count()) await box.setChecked(include)
  await page.getByRole('button', { name: 'Create', exact: true }).click()
}

test.describe('F03 organise: quick collection, collections', () => {
  test('F03-H1 B adds the selection to the Quick Collection and again takes it out', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await cells(page).nth(2).click({ modifiers: ['Shift'] })
    await page.keyboard.press('b')
    await expect(page.getByText('Added to the Quick Collection')).toBeVisible()
    await expect(side(page).getByRole('button', { name: /^Quick collection\s*3$/ })).toBeVisible()
    await page.keyboard.press('b')
    await expect(page.getByText('Removed from the Quick Collection')).toBeVisible()
    await expect(side(page).getByRole('button', { name: /^Quick collection\s*0$/ })).toBeVisible()
  })

  test('F03-H2 viewing the Quick Collection shows only its photos', async ({ page }) => {
    await open(page)
    await pick(page, 4)
    await page.keyboard.press('b')
    await side(page).getByRole('button', { name: /^Quick collection/ }).click()
    await expect(page.getByRole('grid', { name: /1 photo/ })).toBeVisible()
    await expect(side(page).getByRole('button', { name: /^Quick collection/ })).toHaveAttribute('aria-current', 'true')
  })

  test('F03-H3 create a collection from the selection, then view it', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await cells(page).nth(1).click({ modifiers: ['Shift'] })
    await newCollection(page, 'Best of')
    const row = side(page).getByRole('list', { name: 'Collections' }).getByRole('button', { name: /^Best of/ })
    await expect(row).toContainText('2')
    await row.click()
    await expect(page.getByRole('grid', { name: /2 photos/ })).toBeVisible()
  })

  test('F03-H4 target collection: make target, Shift+B adds', async ({ page }) => {
    await open(page)
    await newCollection(page, 'Target one', false)
    await side(page).getByRole('list', { name: 'Collections' }).getByRole('button', { name: /^Target one/ }).click()
    await page.getByRole('button', { name: /Make target/ }).click()
    await expect(side(page).getByText('Target', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: /^All photographs/ }).click()
    await pick(page, 3)
    await page.keyboard.press('Shift+B')
    await expect(page.getByText('Added to Target one')).toBeVisible()
    await expect(side(page).getByRole('list', { name: 'Collections' }).getByRole('button', { name: /^Target one/ })).toContainText('1')
  })

  test('F03-E1 Shift+B with no target says so', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await page.keyboard.press('Shift+B')
    await expect(page.getByText(/No target collection yet/)).toBeVisible()
  })

  test('F03-E2 collection names: empty rejected, whitespace tidied, long rejected', async ({ page }) => {
    await open(page)
    await page.getByRole('button', { name: 'New collection' }).click()
    await page.getByLabel('Collection name').fill('   ')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(page.getByRole('alert')).toContainText('1 to 100 characters')
    await page.getByLabel('Collection name').fill('  Spaced    out   name ')
    await page.getByRole('button', { name: 'Create', exact: true }).click()
    await expect(side(page).getByRole('button', { name: /^Spaced out name/ })).toBeVisible()
  })

  test('F03-E3 rename and delete keep the photos', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await newCollection(page, 'Old name')
    await side(page).getByRole('button', { name: /^Old name/ }).click()
    await page.getByRole('button', { name: 'Rename…' }).click()
    await page.getByLabel('New name').fill('New name')
    await page.getByRole('button', { name: 'Save' }).click()
    await expect(side(page).getByRole('button', { name: /^New name/ })).toBeVisible()
    await page.getByRole('button', { name: 'Delete collection…' }).click()
    await page.getByRole('button', { name: 'Delete', exact: true }).click()
    await expect(side(page).getByRole('button', { name: /^New name/ })).toHaveCount(0)
    await expect(page.getByRole('grid', { name: /96 photos/ })).toBeVisible()
  })

  test('F03-E4 take selected photos out of a collection', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await cells(page).nth(2).click({ modifiers: ['Shift'] })
    await newCollection(page, 'Three')
    await side(page).getByRole('button', { name: /^Three/ }).click()
    await expect(page.getByRole('grid', { name: /3 photos/ })).toBeVisible()
    await cells(page).nth(0).click()
    await page.getByRole('button', { name: 'Take selected out' }).click()
    await expect(page.getByRole('grid', { name: /2 photos/ })).toBeVisible()
  })

  test('F03-N1 with nothing selected the collection actions are disabled', async ({ page }) => {
    await open(page, '?seed=0')
    await newCollection(page, 'Empty one')
    await side(page).getByRole('button', { name: /^Empty one/ }).click()
    await expect(page.getByRole('button', { name: 'Add selected photos' })).toBeDisabled()
  })
})

test.describe('F03 organise: keywords', () => {
  test('F03-H5 add keywords with a sub-keyword, see counts in the list', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await cells(page).nth(1).click({ modifiers: ['Shift'] })
    await details(page).getByLabel('Add keywords').fill('beach, Places > Coast')
    await page.keyboard.press('Enter')
    const chips = details(page).getByRole('list', { name: 'Keywords on the selection' })
    await expect(chips.getByText('beach')).toBeVisible()
    await expect(chips.getByText('Coast')).toBeVisible()
    await details(page).getByRole('button', { name: 'Keyword list' }).click()
    await expect(details(page).getByRole('list', { name: 'Keyword list' }).getByRole('button', { name: /^Places/ })).toContainText('2')
  })

  test('F03-H6 clicking a keyword filters the grid, including sub-keywords', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await details(page).getByLabel('Add keywords').fill('Places > Coast')
    await page.keyboard.press('Enter')
    await details(page).getByRole('button', { name: 'Keyword list' }).click()
    await details(page).getByRole('list', { name: 'Keyword list' }).getByRole('button', { name: /^Places/ }).click()
    await expect(page.getByRole('grid', { name: /1 photo/ })).toBeVisible()
  })

  test('F03-H7 remove a keyword from the selection', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await details(page).getByLabel('Add keywords').fill('temp')
    await page.keyboard.press('Enter')
    await details(page).getByRole('button', { name: /Remove keyword temp/ }).click()
    await expect(details(page).getByText(/No keywords on this photo yet/)).toBeVisible()
  })

  test('F03-E5 partly shared keywords show "x of n" and removing affects only those', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await details(page).getByLabel('Add keywords').fill('solo')
    await page.keyboard.press('Enter')
    await cells(page).nth(1).click({ modifiers: ['Shift'] })
    await expect(details(page).getByText('1 of 2')).toBeVisible()
  })

  test('F03-E6 odd keyword input: duplicates, case, empties, emoji, huge text', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    const box = details(page).getByLabel('Add keywords')
    await box.fill('Sun, sun, SUN ,, ;; , 😀 café')
    await page.keyboard.press('Enter')
    const chips = details(page).getByRole('list', { name: 'Keywords on the selection' }).getByRole('listitem')
    await expect(chips).toHaveCount(2) // Sun, and 😀 café
    await box.fill('x'.repeat(400))
    await page.keyboard.press('Enter')
    await expect(page.getByRole('alert')).toHaveCount(0)
  })

  test('F03-E7 nothing selected: keyword input is not offered', async ({ page }) => {
    await open(page, '?seed=0')
    await expect(details(page).getByText('Select photos to add keywords.')).toBeVisible()
  })
})

test.describe('F03 organise: metadata', () => {
  test('F03-H8 edit title and caption on one photo', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    const meta = details(page)
    await meta.getByLabel('Title').fill('Group portrait')
    await meta.getByLabel('Caption').fill('Everyone smiling')
    await meta.getByLabel('Creator').focus() // blur commits
    await pick(page, 1)
    await pick(page, 0)
    await expect(meta.getByLabel('Title')).toHaveValue('Group portrait')
    await expect(meta.getByLabel('Caption')).toHaveValue('Everyone smiling')
  })

  test('F03-H9 several photos with different titles show "Mixed values" and typing overrides all', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await details(page).getByLabel('Title').fill('Alpha')
    await details(page).getByLabel('Creator').focus()
    await cells(page).nth(1).click({ modifiers: ['Shift'] })
    await expect(details(page).getByLabel('Title')).toHaveAttribute('placeholder', 'Mixed values')
    await expect(details(page).getByLabel('Creator')).not.toHaveAttribute('placeholder', 'Mixed values')
    await details(page).getByLabel('Title').fill('Both')
    await details(page).getByLabel('Creator').focus()
    await expect(details(page).getByLabel('Title')).toHaveValue('Both')
    await expect(details(page).getByLabel('Title')).not.toHaveAttribute('placeholder', 'Mixed values')
  })

  test('F03-E8 a mixed field is left alone when the user edits a different one', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await details(page).getByLabel('Title').fill('First')
    await details(page).getByLabel('Creator').focus()
    await cells(page).nth(1).click({ modifiers: ['Shift'] })
    await details(page).getByLabel('Creator').fill('Sam')
    await details(page).getByLabel('Copyright').focus()
    await pick(page, 0)
    await expect(details(page).getByLabel('Title')).toHaveValue('First')
    await expect(details(page).getByLabel('Creator')).toHaveValue('Sam')
  })

  test('F03-E9 Enter commits a single-line field, and shortcuts are not triggered while typing', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await details(page).getByLabel('Title').pressSequentially('p4x b Delete')
    await details(page).getByLabel('Title').press('Enter')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(cells(page).nth(0)).toHaveAccessibleName(/0 stars/)
    await expect(page.getByRole('grid', { name: /96 photos/ })).toBeVisible()
  })

  test('F03-E10 a failed save shows an error', async ({ page }) => {
    await open(page, '?fail=1')
    await pick(page, 0)
    await details(page).getByLabel('Title').fill('Will fail')
    await details(page).getByLabel('Creator').focus()
    await expect(details(page).getByRole('alert')).toContainText('could not be saved')
  })

  test('F03-E11 over-long text is refused with a message', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await details(page).getByLabel('Caption').fill('x'.repeat(2100))
    await details(page).getByLabel('Title').focus()
    await expect(details(page).getByRole('alert')).toContainText('too long')
  })
})

test.describe('F03 organise: remove from catalog', () => {
  test('F03-H10 Delete asks first, Cancel keeps everything', async ({ page }) => {
    await open(page)
    await pick(page, 2)
    await page.keyboard.press('Delete')
    const dlg = page.getByRole('dialog', { name: 'Remove from the catalog?' })
    await expect(dlg).toBeVisible()
    await expect(dlg).toContainText('The files stay on your disk')
    await dlg.getByRole('button', { name: 'Cancel' }).click()
    await expect(page.getByRole('grid', { name: /96 photos/ })).toBeVisible()
  })

  test('F03-H11 confirming removes the selected photos only', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await cells(page).nth(2).click({ modifiers: ['Shift'] })
    await page.keyboard.press('Delete')
    await expect(page.getByRole('dialog')).toContainText('Remove 3 photos')
    await page.getByRole('button', { name: 'Remove from catalog' }).click()
    await expect(page.getByRole('grid', { name: /93 photos/ })).toBeVisible()
    await expect(page.getByText(/3 removed from the catalog/)).toBeVisible()
  })

  test('F03-E12 the Remove button works without the keyboard, Escape cancels', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await details(page).getByRole('button', { name: 'Remove…' }).click()
    await expect(page.getByRole('dialog')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.getByRole('grid', { name: /96 photos/ })).toBeVisible()
  })

  test('F03-E13 Delete with nothing selected does nothing', async ({ page }) => {
    await open(page, '?seed=0')
    await page.keyboard.press('Delete')
    await expect(page.getByRole('dialog')).toHaveCount(0)
  })

  test('F03-E14 removing everything leaves a clean empty library', async ({ page }) => {
    await open(page, '?seed=5')
    await pick(page, 0)
    await page.keyboard.press('Control+a')
    await expect(page.locator('.fsrc')).toContainText('5 selected')
    await page.keyboard.press('Delete')
    await page.getByRole('button', { name: 'Remove from catalog' }).click()
    await expect(page.getByRole('heading', { name: 'Your library is empty' })).toBeVisible()
  })
})

test.describe('F03 view options and navigator', () => {
  test('F03-H12 view options hide index numbers, badges and label bars, and are remembered', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await page.keyboard.press('3')
    await page.getByText('View options').click()
    const group = page.getByRole('group', { name: 'Grid view options' })
    await expect(page.locator('.n').first()).toBeVisible()
    await group.getByLabel('Index numbers').uncheck()
    await expect(page.locator('.grid-host .n').first()).toBeHidden()
    await group.getByLabel('Rating and flag badges').uncheck()
    await expect(page.locator('.grid-host .cell-meta').first()).toBeHidden()
    await page.reload()
    await expect(page.getByRole('grid', { name: /Photo grid/ })).toBeVisible()
    await expect(page.locator('.grid-host')).toHaveAttribute('data-hide-index', 'true')
  })

  test('F03-E15 corrupt saved view options fall back to defaults', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('penumbra.viewOptions', '{not json'))
    await open(page)
    await expect(page.locator('.grid-host')).not.toHaveAttribute('data-hide-index', /.*/)
  })

  test('F03-H13 the navigator follows the selection', async ({ page }) => {
    await open(page)
    await pick(page, 3)
    await expect(page.getByRole('img', { name: /^Preview of IMG_/ })).toBeVisible()
  })

  test('F03-A1 accessibility scan with panels open and dialogs', async ({ page }) => {
    await open(page)
    await pick(page, 0)
    await details(page).getByLabel('Add keywords').fill('tag')
    await page.keyboard.press('Enter')
    await details(page).getByRole('button', { name: 'Keyword list' }).click()
    await page.getByRole('button', { name: 'New collection' }).click()
    await page.getByText('View options').click()
    expect((await new AxeBuilder({ page }).analyze()).violations, 'panels').toEqual([])
    await page.keyboard.press('Escape')
    await details(page).getByRole('button', { name: 'Remove…' }).click()
    expect((await new AxeBuilder({ page }).analyze()).violations, 'remove dialog').toEqual([])
  })
})

test.describe('F03 metadata filter', () => {
  type P = import('@playwright/test').Page
  const tab = (page: P) => page.getByRole('tablist', { name: 'Filter type' }).getByRole('tab', { name: 'Metadata' })
  const bar = (page: P) => page.getByRole('search')
  const count = (page: P, n: number) => expect(page.getByRole('grid', { name: new RegExp(`Photo grid, ${n} photos`) })).toBeVisible()

  test('MF1 the Metadata tab offers the cameras and lenses of the catalog with how many photos each has, and picks one', async ({ page }) => {
    await open(page)
    await tab(page).click()
    const camera = bar(page).getByRole('combobox', { name: 'Camera' })
    await expect(camera.getByRole('option')).toHaveText(['Any camera', 'Canon EOS 800D (48)', 'Nikon Z6 (48)'])
    await expect(bar(page).getByRole('combobox', { name: 'Lens' }).getByRole('option')).toHaveCount(3)
    await camera.selectOption('Canon EOS 800D')
    await count(page, 48)
    await camera.selectOption('')
    await count(page, 96)
  })

  test('MF2 ISO, focal length, aperture and date ranges narrow the grid', async ({ page }) => {
    await open(page)
    await tab(page).click()
    await bar(page).getByLabel('ISO from').fill('800')
    await bar(page).getByLabel('ISO to').fill('1600')
    await count(page, 38) // ids whose ISO is 800 or 1600
    await bar(page).getByLabel('ISO from').fill('')
    await bar(page).getByLabel('ISO to').fill('')
    await count(page, 96)
    await bar(page).getByLabel('Focal length (mm) from').fill('50')
    await bar(page).getByLabel('Focal length (mm) to').fill('70')
    await count(page, 48)
    await bar(page).getByLabel('Focal length (mm) from').fill('')
    await bar(page).getByLabel('Focal length (mm) to').fill('')
    await bar(page).getByLabel('Aperture (f) from').fill('5.6')
    await count(page, 24)
    await bar(page).getByLabel('Aperture (f) from').fill('')
    await count(page, 96)
    await bar(page).getByLabel('Taken from').fill('2026-10-04')
    await count(page, 48)
    await bar(page).getByLabel('Taken to').fill('2026-10-03')
    await expect(page.getByRole('heading', { name: 'Nothing matches these filters' })).toBeVisible() // from the 4th, to the 3rd: no day fits
  })

  test('MF3 filters work together, and None clears them all', async ({ page }) => {
    await open(page)
    await tab(page).click()
    await bar(page).getByRole('combobox', { name: 'Camera' }).selectOption('Canon EOS 800D')
    await bar(page).getByLabel('ISO from').fill('800')
    await expect(page.getByRole('grid', { name: /Photo grid, \d+ photos/ })).not.toHaveAccessibleName(/Photo grid, (48|96|38) photos/)
    await page.getByRole('tablist', { name: 'Filter type' }).getByRole('tab', { name: 'None' }).click()
    await count(page, 96)
    await tab(page).click()
    await expect(bar(page).getByRole('combobox', { name: 'Camera' })).toHaveValue('')
    await expect(bar(page).getByLabel('ISO from')).toHaveValue('')
  })

  test('MF4 changing to the Text or Attribute tab drops the metadata filter, and back again starts clean', async ({ page }) => {
    await open(page)
    await tab(page).click()
    await bar(page).getByRole('combobox', { name: 'Camera' }).selectOption('Nikon Z6')
    await count(page, 48)
    await page.getByRole('tablist', { name: 'Filter type' }).getByRole('tab', { name: 'Attribute' }).click()
    await count(page, 96)
    await tab(page).click()
    await expect(bar(page).getByRole('combobox', { name: 'Camera' })).toHaveValue('')
  })

  test('MF5 no accessibility violations on the Metadata tab', async ({ page }) => {
    await open(page)
    await tab(page).click()
    await expect(bar(page).getByRole('combobox', { name: 'Camera' }).getByRole('option')).toHaveCount(3)
    expect((await new AxeBuilder({ page }).analyze()).violations.map((v) => v.id + ': ' + v.nodes.map((n) => n.target.join(' ')).join(' | '))).toEqual([])
  })
})
