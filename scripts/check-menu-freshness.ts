import { appendFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { evaluateMenuFreshness } from './lib/menu-freshness.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
let publication: unknown

try {
  publication = JSON.parse(await readFile(path.join(root, 'data/current-menu.json'), 'utf8')) as unknown
} catch {
  publication = null
}

const force = process.env.MENU_WATCHDOG_FORCE === 'true'
const decision = evaluateMenuFreshness(publication, new Date(), force)
const output = [
  `needs_import=${decision.needsImport}`,
  `reason=${decision.reason}`,
  `sofia_date=${decision.sofiaDate}`,
].join('\n')

process.stdout.write(`${output}\n`)

if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `${output}\n`)
}
