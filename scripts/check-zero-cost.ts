import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { FREE_GEMINI_MODEL } from './lib/gemini.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const packages = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies })
const forbiddenPackages = /stripe|openai|firebase|supabase|segment|mixpanel|amplitude|sentry|posthog/i
const forbidden = packages.filter((name) => forbiddenPackages.test(name))
if (forbidden.length) throw new Error(`Cost boundary: forbidden packages found: ${forbidden.join(', ')}`)
if (FREE_GEMINI_MODEL !== 'gemini-3.6-flash') {
  throw new Error(`Cost boundary: only gemini-3.6-flash is permitted, received ${FREE_GEMINI_MODEL}`)
}

const sourceFiles = ['index.html', 'src/App.tsx', 'src/styles.css', 'src/lib/menu-schema.ts']
const forbiddenRuntime = /google-analytics|googletagmanager|fonts\.googleapis|stripe\.com|sentry\.io|api\.openai\.com/i
for (const filename of sourceFiles) {
  const content = await readFile(path.join(root, filename), 'utf8')
  if (forbiddenRuntime.test(content)) throw new Error(`Cost boundary: external runtime found in ${filename}`)
}

process.stdout.write('Zero-cost boundary is intact\n')
