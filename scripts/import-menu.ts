import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fetchLatestFacebookMenu } from './lib/facebook.ts'
import {
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
      verifiedBy: FREE_GEMINI_MODEL,
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

async function writeDraft(date: string, extracted: ExtractedMenu, verification: Verification): Promise<void> {
  const reviewDir = path.join(root, 'data', 'review')
  await mkdir(reviewDir, { recursive: true })
  await writeFile(
    path.join(reviewDir, `${date}.json`),
    `${JSON.stringify({ date, extracted, verification }, null, 2)}\n`,
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
}) {
  const today = sofiaDate()
  if (options.date !== today) {
    throw new Error(`Fail-closed date check: source is ${options.date}, today in Sofia is ${today}`)
  }
  const extracted = await extractMenu(options.image, options.mimeType)
  const verification = await verifyMenu(options.image, options.mimeType, extracted)
  const hasUncertainItems = extracted.categories.some((category) =>
    category.items.some((item) => item.uncertain),
  )
  if (extracted.uncertain || hasUncertainItems || !verification.approved || verification.uncertain || verification.issues.length > 0) {
    await writeDraft(options.date, extracted, verification)
    throw new Error(`Menu requires manual review; draft saved for ${options.date}`)
  }
  const menu = menuFromExtraction({ ...options, extracted })
  const changed = await publishMenu(menu)
  process.stdout.write(changed ? `Published ${menu.date}\n` : `Menu ${menu.date} is unchanged\n`)
}

async function runFacebook() {
  try {
    const current = JSON.parse(
      await readFile(path.join(root, 'data', 'current-menu.json'), 'utf8'),
    ) as { status?: string; menu?: { date?: string } }
    if (current.status === 'ready' && current.menu?.date === sofiaDate()) {
      process.stdout.write(`Today's menu (${current.menu.date}) is already ready; skipping import\n`)
      return
    }
  } catch { /* no valid current pointer yet */ }

  const { candidate, image, mimeType } = await fetchLatestFacebookMenu()
  const publishedAt = new Date(candidate.creationTime * 1000).toISOString()
  await processImage({
    image,
    mimeType,
    date: sofiaDate(new Date(candidate.creationTime * 1000)),
    sourcePostId: candidate.postId,
    sourcePostUrl: candidate.postUrl,
    publishedAt,
    method: 'facebook',
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
