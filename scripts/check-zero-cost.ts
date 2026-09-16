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
const packages: string[] = []
for (const manifest of ['package.json', 'workers/menu-scheduler/package.json']) {
  const packageJson = JSON.parse(await readFile(path.join(root, manifest), 'utf8')) as {
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  packages.push(...Object.keys({ ...packageJson.dependencies, ...packageJson.devDependencies }))
}
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

// The scheduler Worker runs on Workers Free. Allow only configuration that Free
// supports without a payment method: no bindings, routes, Logpush, configurable
// limits, or extra triggers. A new key must be reviewed for cost before it is added.
const FREE_SCHEDULER_KEYS = new Set([
  '$schema', 'name', 'main', 'compatibility_date', 'workers_dev', 'preview_urls',
  'upload_source_maps', 'send_metrics', 'triggers', 'vars', 'secrets', 'observability',
])
const schedulerConfig = JSON.parse(
  await readFile(path.join(root, 'workers/menu-scheduler/wrangler.json'), 'utf8'),
) as Record<string, unknown>
const paidSchedulerKeys = Object.keys(schedulerConfig).filter((key) => !FREE_SCHEDULER_KEYS.has(key))
if (paidSchedulerKeys.length) {
  throw new Error(`Cost boundary: scheduler Worker config uses unreviewed keys: ${paidSchedulerKeys.join(', ')}`)
}
const triggers = schedulerConfig.triggers as Record<string, unknown> | undefined
if (!triggers || Object.keys(triggers).join() !== 'crons' || !Array.isArray(triggers.crons) || triggers.crons.length !== 1) {
  throw new Error('Cost boundary: the scheduler Worker must use exactly one Cron Trigger and nothing else')
}
if (schedulerConfig.workers_dev !== false || schedulerConfig.preview_urls !== false) {
  throw new Error('Cost boundary: the scheduler Worker must not expose workers.dev or preview URLs')
}

const sourceFiles = ['index.html', 'src/App.tsx', 'src/styles.css', 'src/lib/menu-schema.ts']
const forbiddenRuntime = /google-analytics|googletagmanager|fonts\.googleapis|stripe\.com|sentry\.io|api\.openai\.com/i
for (const filename of sourceFiles) {
  const content = await readFile(path.join(root, filename), 'utf8')
  if (forbiddenRuntime.test(content)) throw new Error(`Cost boundary: external runtime found in ${filename}`)
}

process.stdout.write('Zero-cost boundary is intact\n')
