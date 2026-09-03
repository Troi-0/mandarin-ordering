import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { menuSchema } from '../src/lib/menu-schema.ts'
import {
  comparePriceBenchmark,
  compareTranscriptions,
  extractMenu,
  GEMINI_BENCHMARK_CONFIGS,
  verifyMenu,
  type ExtractedMenu,
  type GeminiConfig,
  type GeminiRequestPolicy,
  type Verification,
} from './lib/gemini.ts'
import { referenceTranscript } from './lib/import-flow.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const reportPath = path.resolve(
  process.env.GEMINI_BENCHMARK_REPORT_PATH?.trim()
    || path.join(root, 'gemini-benchmark-report.json'),
)
const fixtures = [
  {
    image: 'test-fixtures/facebook/2026-08-24.jpg',
    reference: 'data/menus/2026-08-24.json',
  },
  {
    image: 'test-fixtures/facebook/2026-08-25.jpg',
    reference: 'data/menus/2026-08-25.json',
  },
] as const
const requestedConfigId = process.env.GEMINI_BENCHMARK_CONFIG?.trim()
const configs = requestedConfigId
  ? GEMINI_BENCHMARK_CONFIGS.filter((config) => config.id === requestedConfigId)
  : GEMINI_BENCHMARK_CONFIGS
if (configs.length === 0) {
  throw new Error(`Unknown GEMINI_BENCHMARK_CONFIG: ${requestedConfigId}`)
}
// Benchmarks should expose availability problems without spending minutes on
// each candidate. Production requests retain their five bounded retries.
const benchmarkRequestPolicy: GeminiRequestPolicy = Object.freeze({
  retryDelaysMs: [],
  timeoutMs: 90_000,
})

interface PassResult {
  elapsedMs: number
  transcript?: ExtractedMenu
  error?: string
}

interface NameDifference {
  category: string
  item: number
  expected: string
  actual: string
}

interface BenchmarkResult {
  config: GeminiConfig
  fixture: typeof fixtures[number]
  extraction: PassResult
  blindVerification: PassResult
  checks?: {
    extractionVsHuman: Verification
    verificationVsHuman: Verification
    extractionVsVerification: Verification
    extractionNameDifferences: NameDifference[]
    verificationNameDifferences: NameDifference[]
    passedSafetyGate: boolean
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function runPass(
  operation: () => Promise<ExtractedMenu>,
): Promise<PassResult> {
  const startedAt = performance.now()
  try {
    const transcript = await operation()
    return {
      elapsedMs: Math.round(performance.now() - startedAt),
      transcript,
    }
  } catch (error) {
    return {
      elapsedMs: Math.round(performance.now() - startedAt),
      error: errorMessage(error),
    }
  }
}

function categoryKey(name: string): string {
  const key = name
    .normalize('NFC')
    .trim()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLocaleUpperCase('bg-BG')
  return key.endsWith('И') && key.length > 4 ? key.slice(0, -1) : key
}

function nameDifferences(
  actual: ExtractedMenu,
  expected: ExtractedMenu,
): NameDifference[] {
  const actualCategories = new Map(actual.categories.map((category) => [
    categoryKey(category.name),
    category,
  ]))
  return expected.categories.flatMap((expectedCategory) => {
    const actualCategory = actualCategories.get(categoryKey(expectedCategory.name))
    if (!actualCategory) {
      return [{
        category: expectedCategory.name,
        item: 0,
        expected: expectedCategory.name,
        actual: '<missing category>',
      }]
    }
    return expectedCategory.items.flatMap((expectedItem, itemIndex) => {
      const actualItem = actualCategory.items[itemIndex]
      if (!actualItem || actualItem.name !== expectedItem.name) {
        return [{
          category: expectedCategory.name,
          item: itemIndex + 1,
          expected: expectedItem.name,
          actual: actualItem?.name ?? '<missing item>',
        }]
      }
      return []
    })
  })
}

async function writeReport(results: BenchmarkResult[], startedAt: string): Promise<void> {
  const completed = results.filter((result) => result.checks).length
  const safe = results.filter((result) => result.checks?.passedSafetyGate).length
  await mkdir(path.dirname(reportPath), { recursive: true })
  await writeFile(reportPath, `${JSON.stringify({
    startedAt,
    finishedAt: new Date().toISOString(),
    productionChanged: false,
    summary: {
      expectedCases: configs.length * fixtures.length,
      completedCases: completed,
      safeCases: safe,
      erroredCases: results.length - completed,
    },
    results,
  }, null, 2)}\n`)
}

const startedAt = new Date().toISOString()
const results: BenchmarkResult[] = []

for (const config of configs) {
  for (const fixture of fixtures) {
    process.stdout.write(`Benchmarking ${config.id} on ${fixture.image}\n`)
    const image = await readFile(path.join(root, fixture.image))
    const reference = menuSchema.parse(
      JSON.parse(await readFile(path.join(root, fixture.reference), 'utf8')),
    )
    const humanTranscript = referenceTranscript(reference)
    const extraction = await runPass(() => extractMenu(
      image,
      'image/jpeg',
      config,
      benchmarkRequestPolicy,
    ))
    const blindVerification = await runPass(() => verifyMenu(
      image,
      'image/jpeg',
      config,
      benchmarkRequestPolicy,
    ))
    const result: BenchmarkResult = {
      config,
      fixture,
      extraction,
      blindVerification,
    }
    if (extraction.transcript && blindVerification.transcript) {
      const extractionVsHuman = comparePriceBenchmark(extraction.transcript, humanTranscript)
      const verificationVsHuman = comparePriceBenchmark(
        blindVerification.transcript,
        humanTranscript,
      )
      const extractionVsVerification = compareTranscriptions(
        extraction.transcript,
        blindVerification.transcript,
      )
      result.checks = {
        extractionVsHuman,
        verificationVsHuman,
        extractionVsVerification,
        extractionNameDifferences: nameDifferences(extraction.transcript, humanTranscript),
        verificationNameDifferences: nameDifferences(
          blindVerification.transcript,
          humanTranscript,
        ),
        passedSafetyGate: extractionVsHuman.approved
          && verificationVsHuman.approved
          && extractionVsVerification.approved,
      }
    }
    results.push(result)
    await writeReport(results, startedAt)
  }
}

const errored = results.filter((result) => !result.checks)
if (errored.length > 0) {
  throw new Error(`${errored.length} Gemini benchmark case(s) did not complete; inspect ${reportPath}`)
}

process.stdout.write(`Gemini benchmark report written to ${reportPath}\n`)
