// Makes docs/whats-built.md from features.csv (the one list the build keeps up to date).
// Run from the project root:  node docs/make-built-list.mjs
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const text = readFileSync(join(root, 'features.csv'), 'utf8').replace(/^﻿/, '').replace(/\r/g, '')
const rows = []
{
  let row = [], f = '', q = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++ } else q = false } else f += c }
    else if (c === '"') q = true
    else if (c === ',') { row.push(f); f = '' }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = '' }
    else f += c
  }
  if (f || row.length) { row.push(f); rows.push(row) }
}
const head = rows[0].map((h) => h.trim().toLowerCase())
const feats = rows.slice(1).filter((r) => r.some((x) => x.trim())).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? '').trim()])))

const AREAS = { library: 'Library', develop: 'Develop and Retouch', catalog: 'Catalog', import: 'Import', export: 'Export', book: 'Book', color: 'Colour', settings: 'Settings', shell: 'The window and its menus', metadata: 'Metadata', map: 'Map', slideshow: 'Slideshow', print: 'Print', web: 'Web', platform: 'Platform', content: 'Content from other companies' }
const status = (r) => (r.clone === 'yes' ? 'Built' : r.clone === 'partial' ? 'Partly built' : r.clone === 'skip' ? 'Left out on purpose' : 'Not built')
const clean = (s) => s.replace(/\|/g, '/').replace(/\s+/g, ' ').trim()
const counts = { Built: 0, 'Partly built': 0, 'Not built': 0, 'Left out on purpose': 0 }
for (const r of feats) counts[status(r)]++

let out = `# Lucent Raw: what is built and what is not

Made on ${new Date().toISOString().slice(0, 10)} from \`features.csv\`, the one list that is kept up to date as the program is built. It is meant to be honest: "Built" means it works and is tested; "Partly built" means it works but something a person would expect is missing, and the note says what; "Not built" means it does not exist; "Left out on purpose" means it was decided not to build it.

**Totals: ${feats.length} features. Built: ${counts.Built}. Partly built: ${counts['Partly built']}. Not built: ${counts['Not built']}. Left out on purpose: ${counts['Left out on purpose']}.**

The feature list is made from the program being copied (Lightroom Classic), so it counts that program's features. Some things in Lucent Raw are not in that program at all (the B BOT advisor, the AI connection, AI enlargement and the AI Fill spot mode); they appear in the notes and are not counted in the score. Parity with the original, scored as the build requires (must-haves count 3, should 2, could 1, partly built counts half, left-out features not counted), was 41.3 out of 100 on 18 October 2026. See \`parity.md\`.

## What this list cannot tell you

- **Tested is not the same as proven on real use.** The core has 306 automated tests and the interface 359, but no automated test drives the real window with the real core, and most features have been tried on test pictures rather than on a photographer's real library. The first real use will find things.
- **No installer exists yet**, and the program has only ever been run on the machine it was built on.
- **RAW support** has been tried on a small number of camera files. Other makers and very new cameras may not work.
- **A licence question is open** (the RAW-reading library is LGPL-2.1) and must be settled before the program is shared or sold. See \`THIRD_PARTY.md\`.

`

const order = Object.keys(AREAS)
for (const area of order) {
  const list = feats.filter((r) => r.area === area)
  if (!list.length) continue
  out += `\n## ${AREAS[area]}\n\n| Feature | Status | What there is, and what is missing |\n| --- | --- | --- |\n`
  const rank = { Built: 0, 'Partly built': 1, 'Not built': 2, 'Left out on purpose': 3 }
  for (const r of list.sort((a, b) => rank[status(a)] - rank[status(b)] || a.feature.localeCompare(b.feature))) {
    const own = r.original === 'no' ? ' (not in the original program)' : ''
    out += `| ${clean(r.feature)}${own} | ${status(r)} | ${clean(r.notes) || (r.clone === 'no' ? '' : '')} |\n`
  }
}
const known = new Set(order)
const rest = feats.filter((r) => !known.has(r.area))
if (rest.length) {
  out += `\n## Other\n\n| Feature | Status | Notes |\n| --- | --- | --- |\n`
  for (const r of rest) out += `| ${clean(r.feature)} | ${status(r)} | ${clean(r.notes)} |\n`
}
writeFileSync(join(root, 'docs', 'whats-built.md'), out)
console.log('written', feats.length, counts)
