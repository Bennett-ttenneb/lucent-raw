// Copies the generated design tokens into the app. Source of truth: replica/design/tokens.json.
import { copyFileSync, existsSync } from 'node:fs'
const from = new URL('../../design/tokens.css', import.meta.url)
const to = new URL('../src/styles/tokens.css', import.meta.url)
if (existsSync(from)) copyFileSync(from, to)
