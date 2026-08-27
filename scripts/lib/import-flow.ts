import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fetchFacebookMenu, type FacebookPostTarget } from './facebook.ts'
import {
  compareTranscriptions,
  extractMenu,
  verifyMenu,
  type ExtractedMenu,
  type Verification,
} from './gemini.ts'
import {
  imageSha256,
  menuFromExtraction,
  reviewMenuFromExtraction,
} from './menu-build.ts'
import { sofiaDate } from '../../src/lib/date.ts'
import {
  assertMenuInvariants,
  FACEBOOK_PAGE_URL,
  menuPublicationSchema,
  menuSchema,
  type Menu,
} from '../../src/lib/menu-schema.ts'

type FacebookResult = Awaited<ReturnType<typeof fetchFacebookMenu>>

export interface MenuImporterOptions {
  root: string
  dryRun: boolean
  reportPath?: string
  now?: () => Date
  fetchFacebook?: (target?: FacebookPostTarget) => Promise<FacebookResult>
  extract?: typeof extractMenu
  verify?: typeof verifyMenu
}

export interface ProcessImageOptions {
  image: Uint8Array
  mimeType: string
  date: string
  sourcePostId: string
  sourcePostUrl: string
  publishedAt: string
  method: 'facebook' | 'manual'
  benchmarkReference?: Menu
}

export function referenceTranscript(reference: Menu): ExtractedMenu {
  return {
    uncertain: false,
    uncertaintyNotes: [],
    categories: reference.categories.map((category) => ({
      name: category.name,
      items: category.items.map((item) => ({
        name: item.name,
        portion: item.portion ?? null,
        priceCents: item.priceCents,
        uncertain: false,
      })),
    })),
  }
}

export function createMenuImporter(options: MenuImporterOptions) {
  const now = options.now ?? (() => new Date())
  const facebookFetcher = options.fetchFacebook ?? fetchFacebookMenu
  const extract = options.extract ?? extractMenu
  const verify = options.verify ?? verifyMenu

  function reportPath(): string {
    if (!options.reportPath) {
      throw new Error('IMPORT_REPORT_PATH is required when IMPORT_DRY_RUN=true')
    }
    return path.resolve(options.reportPath)
  }

  async function writeDraft(
    source: ProcessImageOptions,
    extracted: ExtractedMenu,
    verificationTranscript: ExtractedMenu,
    verification: Verification,
    benchmark?: Verification,
  ): Promise<void> {
    const outputPath = options.dryRun
      ? reportPath()
      : path.join(options.root, 'data', 'review', `${source.date}.json`)
    const editableMenu = reviewMenuFromExtraction({ ...source, extracted })
    await mkdir(path.dirname(outputPath), { recursive: true })
    await writeFile(
      outputPath,
      `${JSON.stringify({
        status: 'rejected',
        date: source.date,
        editableMenu,
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
    const outputPath = reportPath()
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
    const currentPath = path.join(options.root, 'data', 'current-menu.json')
    const archivePath = path.join(options.root, 'data', 'menus', `${menu.date}.json`)
    try {
      const previous = JSON.parse(await readFile(currentPath, 'utf8')) as unknown
      const parsed = menuPublicationSchema.safeParse(previous)
      if (parsed.success && parsed.data.status === 'ready') {
        const priorFingerprint = JSON.stringify({
          date: parsed.data.menu.date,
          source: parsed.data.menu.source,
          categories: parsed.data.menu.categories,
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

  async function processImage(source: ProcessImageOptions): Promise<'published' | 'unchanged' | 'dry-run'> {
    const expectedDate = source.benchmarkReference?.date ?? sofiaDate(now())
    if (source.date !== expectedDate) {
      throw new Error(`Fail-closed date check: source is ${source.date}, expected ${expectedDate}`)
    }
    const extracted = await extract(source.image, source.mimeType)
    const verificationTranscript = await verify(source.image, source.mimeType)
    const verification = compareTranscriptions(extracted, verificationTranscript)
    const benchmarkTranscript = source.benchmarkReference
      ? referenceTranscript(source.benchmarkReference)
      : undefined
    const benchmark = benchmarkTranscript
      ? compareTranscriptions(extracted, benchmarkTranscript)
      : undefined
    if (!verification.approved || (benchmark && !benchmark.approved)) {
      await writeDraft(source, extracted, verificationTranscript, verification, benchmark)
      throw new Error(
        options.dryRun
          ? `Dry run requires manual review; report saved for ${source.date}`
          : `Menu requires manual review; draft saved for ${source.date}`,
      )
    }
    const menu = menuFromExtraction({ ...source, extracted })
    if (options.dryRun) {
      await writeApprovedDryRun(menu, extracted, verificationTranscript, verification, benchmark)
      const itemCount = menu.categories.reduce((count, category) => count + category.items.length, 0)
      process.stdout.write(
        `Dry run approved ${menu.date}: ${menu.categories.length} categories, ${itemCount} items; nothing published\n`,
      )
      return 'dry-run'
    }
    const changed = await publishMenu(menu)
    process.stdout.write(changed ? `Published ${menu.date}\n` : `Menu ${menu.date} is unchanged\n`)
    return changed ? 'published' : 'unchanged'
  }

  async function loadBenchmarkReference(repositoryPath?: string): Promise<Menu | undefined> {
    const requestedPath = repositoryPath?.trim()
    if (!requestedPath) return undefined
    if (!options.dryRun) {
      throw new Error('IMPORT_BENCHMARK_MENU is allowed only when IMPORT_DRY_RUN=true')
    }
    if (!/^data\/menus\/\d{4}-\d{2}-\d{2}\.json$/.test(requestedPath)) {
      throw new Error('Benchmark reference must be data/menus/YYYY-MM-DD.json')
    }
    const reference = menuSchema.parse(
      JSON.parse(await readFile(path.resolve(options.root, requestedPath), 'utf8')),
    )
    assertMenuInvariants(reference)
    if (!reference.validation.extractedBy.startsWith('human-verified')) {
      throw new Error('Benchmark reference must be marked as human-verified')
    }
    return reference
  }

  async function hasValidCurrentMenuForToday(): Promise<boolean> {
    try {
      const parsed = menuPublicationSchema.safeParse(
        JSON.parse(
          await readFile(path.join(options.root, 'data', 'current-menu.json'), 'utf8'),
        ),
      )
      if (!parsed.success || parsed.data.status !== 'ready') return false
      assertMenuInvariants(parsed.data.menu)
      return parsed.data.menu.date === sofiaDate(now())
    } catch {
      return false
    }
  }

  async function runFacebook(benchmarkPath?: string): Promise<'skipped' | 'published' | 'unchanged' | 'dry-run'> {
    const benchmarkReference = await loadBenchmarkReference(benchmarkPath)
    if (!options.dryRun && await hasValidCurrentMenuForToday()) {
      process.stdout.write(`Today's menu (${sofiaDate(now())}) is already ready; skipping import\n`)
      return 'skipped'
    }

    const { candidate, image, mimeType } = await facebookFetcher(
      benchmarkReference
        ? { postId: benchmarkReference.source.postId }
        : undefined,
    )
    const publishedAt = new Date(candidate.creationTime * 1_000).toISOString()
    return processImage({
      image,
      mimeType,
      date: sofiaDate(new Date(candidate.creationTime * 1_000)),
      sourcePostId: candidate.postId,
      sourcePostUrl: candidate.postUrl,
      publishedAt,
      method: 'facebook',
      benchmarkReference,
    })
  }

  async function runManual(fileArgument?: string): Promise<'published' | 'unchanged' | 'dry-run'> {
    if (!fileArgument) {
      throw new Error('Usage: npm run import:manual -- manual-inbox/YYYY-MM-DD.png')
    }
    const filePath = path.resolve(options.root, fileArgument)
    const manualRoot = path.join(options.root, 'manual-inbox')
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
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error('Manual image filename must be YYYY-MM-DD.ext')
    }
    const image = await readFile(filePath)
    if (image.byteLength > 8 * 1024 * 1024) {
      throw new Error('Manual image exceeds the 8 MB limit')
    }
    const sha = imageSha256(image)
    return processImage({
      image,
      mimeType,
      date,
      sourcePostId: `manual-${sha.slice(0, 16)}`,
      sourcePostUrl: FACEBOOK_PAGE_URL,
      publishedAt: now().toISOString(),
      method: 'manual',
    })
  }

  return {
    hasValidCurrentMenuForToday,
    loadBenchmarkReference,
    processImage,
    publishMenu,
    runFacebook,
    runManual,
  }
}
