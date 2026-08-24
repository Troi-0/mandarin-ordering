import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchFacebookMenu } from './lib/facebook.ts'
import {
  compareTranscriptions,
  extractMenu,
  FREE_GEMINI_MODEL,
  verifyMenu,
  type ExtractedMenu,
  type Verification,
} from './lib/gemini.ts'
import { sofiaDate } from '../src/lib/date.ts'
import {
  assertMenuInvariants,
  FACEBOOK_PAGE_URL,
  menuSchema,
  PAGE_ID,
  type Menu,
} from '../src/lib/menu-schema.ts'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dryRun = process.env.IMPORT_DRY_RUN === 'true'

function dryRunReportPath(): string {
  const configuredPath = process.env.IMPORT_REPORT_PATH?.trim()
  if (!configuredPath) throw new Error('IMPORT_REPORT_PATH is required when IMPORT_DRY_RUN=true')
  return path.resolve(configuredPath)
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`
}

function imageSha256(image: Uint8Array): string {
  return createHash('sha256').update(image).digest('hex')
}

function menuFromExtraction(options: {
  date: string
  sourcePostId: string
  sourcePostUrl: string
  publishedAt: string
  image: Uint8Array
  method: 'facebook' | 'manual'
  extracted: ExtractedMenu
}): Menu {
  const menu = menuSchema.parse({
    date: options.date,
    restaurant: 'Mandarin House',
    currency: 'EUR',
    source: {
      pageId: PAGE_ID,
      postId: options.sourcePostId,
      postUrl: options.sourcePostUrl,
      publishedAt: options.publishedAt,
      imageSha256: imageSha256(options.image),
    },
    importedAt: new Date().toISOString(),
    importMethod: options.method,
    validation: {
      extractedBy: FREE_GEMINI_MODEL,
      verifiedBy: `${FREE_GEMINI_MODEL}:blind-transcription`,
      uncertain: false,
    },
    categories: options.extracted.categories.map((category, categoryIndex) => ({
      id: stableId('category', `${categoryIndex}|${category.name}`),
      name: category.name,
      items: category.items.map((item, itemIndex) => ({
        id: stableId('item', `${category.name}|${itemIndex}|${item.name}|${item.portion ?? ''}`),
        name: item.name,
        ...(item.portion ? { portion: item.portion } : {}),
        priceCents: item.priceCents,
      })),
    })),
  })
  assertMenuInvariants(menu)
  return menu
}

async function writeDraft(
  date: string,
  extracted: ExtractedMenu,
  verificationTranscript: ExtractedMenu,
  verification: Verification,
  benchmark?: Verification,
): Promise<void> {
  const outputPath = dryRun
    ? dryRunReportPath()
    : path.join(root, 'data', 'review', `${date}.json`)
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(
    outputPath,
    `${JSON.stringify({
      status: 'rejected',
      date,
      extracted,
      verificationTranscript,
      verification,
      ...(benchmark ? { benchmark } : {}),
    }, null, 2)}\n`,
  )
}

async function writeApprovedDryRun(
  menu: Menu,
  extracted: ExtractedMenu,
  verificationTranscript: ExtractedMenu,
  verification: Verification,
  benchmark?: Verification,
): Promise<void> {
  const outputPath = dryRunReportPath()
  await mkdir(path.dirname(outputPath), { recursive: true })
  await writeFile(
    outputPath,
    `${JSON.stringify({
      status: 'approved',
      menu,
      extracted,
      verificationTranscript,
      verification,
      ...(benchmark ? { benchmark } : {}),
    }, null, 2)}\n`,
  )
}

async function publishMenu(menu: Menu): Promise<boolean> {
  const currentPath = path.join(root, 'data', 'current-menu.json')
  const archivePath = path.join(root, 'data', 'menus', `${menu.date}.json`)
  try {
    const previous = JSON.parse(await readFile(currentPath, 'utf8')) as unknown
    const parsed = menuSchema.safeParse(
      typeof previous === 'object' && previous !== null && 'menu' in previous
        ? (previous as { menu: unknown }).menu
        : undefined,
    )
    if (parsed.success) {
      const priorFingerprint = JSON.stringify({
        date: parsed.data.date,
        source: parsed.data.source,
        categories: parsed.data.categories,
      })
      const nextFingerprint = JSON.stringify({
        date: menu.date,
        source: menu.source,
        categories: menu.categories,
      })
      if (priorFingerprint === nextFingerprint) return false
    }
  } catch { /* first import */ }

  const nextCurrent = `${JSON.stringify({ status: 'ready', menu }, null, 2)}\n`
  await mkdir(path.dirname(archivePath), { recursive: true })
  await writeFile(archivePath, `${JSON.stringify(menu, null, 2)}\n`)
  await writeFile(currentPath, nextCurrent)
  return true
}

async function processImage(options: {
  image: Uint8Array
  mimeType: string
  date: string
  sourcePostId: string
  sourcePostUrl: string
  publishedAt: string
  method: 'facebook' | 'manual'
  benchmarkReference?: Menu
}) {
  const expectedDate = options.benchmarkReference?.date ?? sofiaDate()
  if (options.date !== expectedDate) {
    throw new Error(`Fail-closed date check: source is ${options.date}, expected ${expectedDate}`)
  }
  const extracted = await extractMenu(options.image, options.mimeType)
  const verificationTranscript = await verifyMenu(options.image, options.mimeType)
  const verification = compareTranscriptions(extracted, verificationTranscript)
  const benchmark = options.benchmarkReference
    ? compareTranscriptions(extracted, referenceTranscript(options.benchmarkReference, extracted))
    : undefined
  if (!verification.approved || (benchmark && !benchmark.approved)) {
    await writeDraft(options.date, extracted, verificationTranscript, verification, benchmark)
    throw new Error(
      dryRun
        ? `Dry run requires manual review; report saved for ${options.date}`
        : `Menu requires manual review; draft saved for ${options.date}`,
    )
  }
  const menu = menuFromExtraction({ ...options, extracted })
  if (dryRun) {
    await writeApprovedDryRun(menu, extracted, verificationTranscript, verification, benchmark)
    const itemCount = menu.categories.reduce((count, category) => count + category.items.length, 0)
    process.stdout.write(
      `Dry run approved ${menu.date}: ${menu.categories.length} categories, ${itemCount} items; nothing published\n`,
    )
    return
  }
  const changed = await publishMenu(menu)
  process.stdout.write(changed ? `Published ${menu.date}\n` : `Menu ${menu.date} is unchanged\n`)
}

function referenceTranscript(reference: Menu, extracted: ExtractedMenu): ExtractedMenu {
  return {
    uncertain: false,
    uncertaintyNotes: [],
    categories: reference.categories.map((category, categoryIndex) => ({
      // Human-verified menu JSON uses display-friendly category casing; item fields remain exact.
      name: extracted.categories[categoryIndex]?.name ?? category.name,
      items: category.items.map((item) => ({
        name: item.name,
        portion: item.portion ?? null,
        priceCents: item.priceCents,
        uncertain: false,
      })),
    })),
  }
}

async function loadBenchmarkReference(): Promise<Menu | undefined> {
  const repositoryPath = process.env.IMPORT_BENCHMARK_MENU?.trim()
  if (!repositoryPath) return undefined
  if (!dryRun) throw new Error('IMPORT_BENCHMARK_MENU is allowed only when IMPORT_DRY_RUN=true')
  if (!/^data\/menus\/\d{4}-\d{2}-\d{2}\.json$/.test(repositoryPath)) {
    throw new Error('Benchmark reference must be data/menus/YYYY-MM-DD.json')
  }
  const reference = menuSchema.parse(
    JSON.parse(await readFile(path.resolve(root, repositoryPath), 'utf8')),
  )
  assertMenuInvariants(reference)
  if (!reference.validation.extractedBy.startsWith('human-verified')) {
    throw new Error('Benchmark reference must be marked as human-verified')
  }
  return reference
}

async function runFacebook() {
  const benchmarkReference = await loadBenchmarkReference()
  try {
    const current = JSON.parse(
      await readFile(path.join(root, 'data', 'current-menu.json'), 'utf8'),
    ) as { status?: string; menu?: { date?: string } }
    if (!dryRun && current.status === 'ready' && current.menu?.date === sofiaDate()) {
      process.stdout.write(`Today's menu (${current.menu.date}) is already ready; skipping import\n`)
      return
    }
  } catch { /* no valid current pointer yet */ }

  const { candidate, image, mimeType } = await fetchFacebookMenu(
    benchmarkReference
      ? { postId: benchmarkReference.source.postId, postUrl: benchmarkReference.source.postUrl }
      : undefined,
  )
  const publishedAt = new Date(candidate.creationTime * 1000).toISOString()
  await processImage({
    image,
    mimeType,
    date: sofiaDate(new Date(candidate.creationTime * 1000)),
    sourcePostId: candidate.postId,
    sourcePostUrl: candidate.postUrl,
    publishedAt,
    method: 'facebook',
    benchmarkReference,
  })
}

async function runManual(fileArgument?: string) {
  if (!fileArgument) throw new Error('Usage: npm run import:manual -- manual-inbox/YYYY-MM-DD.png')
  const filePath = path.resolve(root, fileArgument)
  const manualRoot = path.join(root, 'manual-inbox')
  if (!filePath.startsWith(`${manualRoot}${path.sep}`)) {
    throw new Error('Manual image must be inside manual-inbox/')
  }
  const extension = path.extname(filePath).toLowerCase()
  const mimeTypes: Record<string, string> = {
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.png': 'image/png',
    '.webp': 'image/webp',
  }
  const mimeType = mimeTypes[extension]
  if (!mimeType) throw new Error(`Manual image must be PNG, JPEG, or WebP: ${filePath}`)
  const date = path.basename(filePath, extension)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Manual image filename must be YYYY-MM-DD.ext')
  const image = await readFile(filePath)
  if (image.byteLength > 8 * 1024 * 1024) throw new Error('Manual image exceeds the 8 MB limit')
  const sha = imageSha256(image)
  await processImage({
    image,
    mimeType,
    date,
    sourcePostId: `manual-${sha.slice(0, 16)}`,
    sourcePostUrl: FACEBOOK_PAGE_URL,
    publishedAt: new Date().toISOString(),
    method: 'manual',
  })
}

const mode = process.argv[2]
if (mode === 'facebook') await runFacebook()
else if (mode === 'manual') await runManual(process.argv[3])
else throw new Error('Import mode must be facebook or manual')
