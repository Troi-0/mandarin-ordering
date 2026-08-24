import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertMenuInvariants,
  menuPublicationSchema,
  menuSchema,
} from '../src/lib/menu-schema.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const current = menuPublicationSchema.parse(
  JSON.parse(await readFile(path.join(root, 'data', 'current-menu.json'), 'utf8')),
)
if (current.status === 'ready') assertMenuInvariants(current.menu)

const archiveDir = path.join(root, 'data', 'menus')
for (const filename of await readdir(archiveDir)) {
  if (!filename.endsWith('.json')) continue
  const menu = menuSchema.parse(JSON.parse(await readFile(path.join(archiveDir, filename), 'utf8')))
  assertMenuInvariants(menu)
  if (`${menu.date}.json` !== filename) throw new Error(`Archive filename/date mismatch: ${filename}`)
}

process.stdout.write('Menu data is valid\n')
