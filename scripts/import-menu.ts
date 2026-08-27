import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createMenuImporter } from './lib/import-flow.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const importer = createMenuImporter({
  root,
  dryRun: process.env.IMPORT_DRY_RUN === 'true',
  reportPath: process.env.IMPORT_REPORT_PATH?.trim(),
})

const mode = process.argv[2]
if (mode === 'facebook') {
  await importer.runFacebook(process.env.IMPORT_BENCHMARK_MENU)
} else if (mode === 'manual') {
  await importer.runManual(process.argv[3])
} else {
  throw new Error('Import mode must be facebook or manual')
}
