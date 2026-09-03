import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  assertFreeGeminiConfig,
  FREE_GEMINI_MODELS,
  GEMINI_BENCHMARK_CONFIGS,
  PRODUCTION_GEMINI_CONFIG,
} from './lib/gemini.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}
const packages = Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies })
const forbiddenPackages = /stripe|openai|firebase|supabase|segment|mixpanel|amplitude|sentry|posthog/i
const forbidden = packages.filter((name) => forbiddenPackages.test(name))
if (forbidden.length) throw new Error(`Cost boundary: forbidden packages found: ${forbidden.join(', ')}`)
for (const config of GEMINI_BENCHMARK_CONFIGS) assertFreeGeminiConfig(config)
if (!FREE_GEMINI_MODELS.includes(PRODUCTION_GEMINI_CONFIG.model)) {
  throw new Error(`Cost boundary: production model is not free-allowlisted: ${PRODUCTION_GEMINI_CONFIG.model}`)
}
if (PRODUCTION_GEMINI_CONFIG.model.includes('latest')) {
  throw new Error('Cost boundary: production must pin an exact stable Gemini model')
}

const sourceFiles = ['index.html', 'src/App.tsx', 'src/styles.css', 'src/lib/menu-schema.ts']
const forbiddenRuntime = /google-analytics|googletagmanager|fonts\.googleapis|stripe\.com|sentry\.io|api\.openai\.com/i
for (const filename of sourceFiles) {
  const content = await readFile(path.join(root, filename), 'utf8')
  if (forbiddenRuntime.test(content)) throw new Error(`Cost boundary: external runtime found in ${filename}`)
}

process.stdout.write('Zero-cost boundary is intact\n')
