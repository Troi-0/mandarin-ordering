import { chromium, type BrowserContext } from 'playwright'
import { FACEBOOK_PAGE_URL, PAGE_ID } from '../../src/lib/menu-schema.ts'

export interface FacebookStoryCandidate {
  postId: string
  creationTime: number
  imageUrl: string
  postUrl: string
}

export interface FacebookPostTarget {
  postId: string
  creationTime?: number
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeHtmlAttribute(value: string): string {
  return value
    .replace(/&amp;/giu, '&')
    .replace(/&quot;/giu, '"')
    .replace(/&#39;|&apos;/giu, "'")
    .replace(/&#x([0-9a-f]+);/giu, (_, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/gu, (_, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
}

function metaProperties(html: string): Map<string, Set<string>> {
  const properties = new Map<string, Set<string>>()
  for (const tag of html.match(/<meta\b[^>]*>/giu) ?? []) {
    const attributes = new Map<string, string>()
    const attributePattern = /([\w:.-]+)\s*=\s*(["'])(.*?)\2/gu
    for (const match of tag.matchAll(attributePattern)) {
      const [, name, , value] = match
      if (name && value !== undefined) attributes.set(name.toLocaleLowerCase('en-US'), value)
    }
    const property = attributes.get('property')?.toLocaleLowerCase('en-US')
    const content = attributes.get('content')
    if (!property || content === undefined) continue
    const values = properties.get(property) ?? new Set<string>()
    values.add(decodeHtmlAttribute(content))
    properties.set(property, values)
  }
  return properties
}

function hasExactFacebookPost(url: URL, target: FacebookPostTarget): boolean {
  if (url.protocol !== 'https:') return false
  if (!(url.hostname === 'facebook.com' || url.hostname.endsWith('.facebook.com'))) return false
  const numericTokens: string[] = `${decodeURIComponent(url.pathname)}${url.search}`.match(/\d+/gu) ?? []
  return numericTokens.includes(PAGE_ID) && numericTokens.includes(target.postId)
}

export function extractTargetedPermalinkImage(
  html: string,
  target: FacebookPostTarget,
): string | undefined {
  if (!/^\d+$/.test(target.postId)) return undefined
  const properties = metaProperties(html)
  const canonicalUrls = properties.get('og:url') ?? new Set<string>()
  const imageUrls = properties.get('og:image') ?? new Set<string>()
  if (canonicalUrls.size !== 1 || imageUrls.size !== 1) return undefined

  try {
    const [canonicalUrl] = canonicalUrls
    const [imageUrl] = imageUrls
    if (!canonicalUrl || !imageUrl || !hasExactFacebookPost(new URL(canonicalUrl), target)) {
      return undefined
    }
    const parsedImage = new URL(imageUrl)
    if (
      parsedImage.protocol !== 'https:'
      || !(parsedImage.hostname === 'fbcdn.net' || parsedImage.hostname.endsWith('.fbcdn.net'))
    ) {
      return undefined
    }
    return imageUrl
  } catch {
    return undefined
  }
}

export async function targetedPermalinkCandidate(
  context: BrowserContext,
  target: FacebookPostTarget,
): Promise<FacebookStoryCandidate | undefined> {
  if (!Number.isSafeInteger(target.creationTime) || Number(target.creationTime) <= 0) {
    return undefined
  }
  const postUrl = `https://www.facebook.com/permalink.php?story_fbid=${target.postId}&id=${PAGE_ID}`
  const response = await context.request.get(postUrl, {
    headers: { referer: FACEBOOK_PAGE_URL },
    timeout: 30_000,
  })
  if (!response.ok()) return undefined
  const imageUrl = extractTargetedPermalinkImage(await response.text(), target)
  if (!imageUrl) return undefined
  return {
    postId: target.postId,
    creationTime: Number(target.creationTime),
    imageUrl,
    postUrl,
  }
}

function* recordsIn(value: unknown): Generator<JsonRecord> {
  if (Array.isArray(value)) {
    for (const entry of value) yield* recordsIn(entry)
    return
  }
  if (!isRecord(value)) return

  yield value
  for (const entry of Object.values(value)) yield* recordsIn(entry)
}

function directAuthorIds(record: JsonRecord): string[] {
  const ids: string[] = []
  if (Array.isArray(record.actors)) {
    for (const actor of record.actors) {
      if (isRecord(actor) && typeof actor.id === 'string') ids.push(actor.id)
    }
  }
  for (const field of ['actor_id', 'page_id'] as const) {
    if (typeof record[field] === 'string') ids.push(record[field])
  }
  return ids
}

function mediaFromAttachment(attachment: JsonRecord): JsonRecord | undefined {
  const styles = attachment.styles
  if (isRecord(styles) && isRecord(styles.attachment) && isRecord(styles.attachment.media)) {
    return styles.attachment.media
  }
  return isRecord(attachment.media) ? attachment.media : undefined
}

function directPhotoUrl(record: JsonRecord): string | undefined {
  if (!Array.isArray(record.attachments)) return undefined
  const photos = new Set<string>()

  for (const attachment of record.attachments) {
    if (!isRecord(attachment)) continue
    const media = mediaFromAttachment(attachment)
    if (!media || !isRecord(media.photo_image) || typeof media.photo_image.uri !== 'string') continue
    const uri = media.photo_image.uri
    let parsed: URL
    try {
      parsed = new URL(uri)
    } catch {
      continue
    }
    if (
      parsed.protocol !== 'https:' ||
      !(parsed.hostname === 'fbcdn.net' || parsed.hostname.endsWith('.fbcdn.net'))
    ) {
      continue
    }
    photos.add(uri)
  }

  // Daily menus are single-image posts. Choosing among different photos would
  // reintroduce guesswork, so an ambiguous post is intentionally unavailable.
  if (photos.size !== 1) return undefined
  return photos.values().next().value as string
}

function candidateFromRecord(record: JsonRecord): FacebookStoryCandidate | undefined {
  if (typeof record.post_id !== 'string' || !/^\d+$/.test(record.post_id)) return undefined
  if (!Number.isSafeInteger(record.creation_time) || Number(record.creation_time) <= 0) return undefined
  if (!directAuthorIds(record).includes(PAGE_ID)) return undefined
  const imageUrl = directPhotoUrl(record)
  if (!imageUrl) return undefined

  const postId = record.post_id
  return {
    postId,
    creationTime: Number(record.creation_time),
    imageUrl,
    postUrl: `https://www.facebook.com/permalink.php?story_fbid=${postId}&id=${PAGE_ID}`,
  }
}

export function extractFacebookCandidatesFromJsonScripts(
  jsonScripts: readonly string[],
): FacebookStoryCandidate[] {
  const candidates = new Map<string, FacebookStoryCandidate>()
  const ambiguousPostIds = new Set<string>()

  for (const source of jsonScripts) {
    let parsed: unknown
    try {
      parsed = JSON.parse(source) as unknown
    } catch {
      continue
    }

    for (const record of recordsIn(parsed)) {
      const candidate = candidateFromRecord(record)
      if (!candidate || ambiguousPostIds.has(candidate.postId)) continue
      const previous = candidates.get(candidate.postId)
      if (!previous) {
        candidates.set(candidate.postId, candidate)
        continue
      }
      if (
        previous.creationTime !== candidate.creationTime ||
        previous.imageUrl !== candidate.imageUrl
      ) {
        candidates.delete(candidate.postId)
        ambiguousPostIds.add(candidate.postId)
      }
    }
  }

  return [...candidates.values()].sort((a, b) => b.creationTime - a.creationTime)
}

export function selectFacebookCandidate(
  candidates: FacebookStoryCandidate[],
  target?: FacebookPostTarget,
): FacebookStoryCandidate | undefined {
  if (!target) return candidates[0]
  return candidates.find((candidate) => candidate.postId === target.postId)
}

export async function fetchFacebookMenu(target?: FacebookPostTarget): Promise<{
  candidate: FacebookStoryCandidate
  image: Uint8Array
  mimeType: string
}> {
  const browser = await chromium.launch({ headless: true })
  try {
    const context = await browser.newContext({
      locale: 'bg-BG',
      timezoneId: 'Europe/Sofia',
      viewport: { width: 1365, height: 1600 },
    })
    const page = await context.newPage()
    // The logged-out permalink page often omits embedded post data entirely.
    // Load the Page feed and parse its structured JSON records instead.
    const pageUrl = FACEBOOK_PAGE_URL
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.waitForFunction(
      `Array.from(document.querySelectorAll('script[type="application/json"]')).some((script) => script.textContent?.includes('"post_id"'))`,
      undefined,
      { timeout: 15_000 },
    ).catch(() => undefined)
    const jsonScripts = await page.locator('script[type="application/json"]').allTextContents()
    let candidate = selectFacebookCandidate(
      extractFacebookCandidatesFromJsonScripts(jsonScripts),
      target,
    )
    // Explicitly targeted historical benchmarks are dry-run only. Facebook's
    // feed rotates older records out, so use same-document Open Graph metadata
    // from the exact permalink when a trusted reference supplies the timestamp.
    if (!candidate && target) {
      candidate = await targetedPermalinkCandidate(context, target)
    }
    if (!candidate) {
      const pageTitle = (await page.title()).slice(0, 120)
      const serialized = jsonScripts.join('')
      const diagnostics = {
        jsonScripts: jsonScripts.length,
        postId: serialized.match(/post_id/g)?.length ?? 0,
        creationTime: serialized.match(/creation_time/g)?.length ?? 0,
        attachments: serialized.match(/attachments/g)?.length ?? 0,
        photoImage: serialized.match(/photo_image/g)?.length ?? 0,
        pageId: serialized.match(new RegExp(PAGE_ID, 'g'))?.length ?? 0,
      }
      throw new Error(
        `No unambiguous Page-authored image post was found in Facebook JSON (${serialized.length} bytes, title: ${pageTitle}, target: ${target?.postId ?? 'latest'}, signals: ${JSON.stringify(diagnostics)})`,
      )
    }

    const response = await context.request.get(candidate.imageUrl, {
      headers: { referer: pageUrl },
      timeout: 30_000,
    })
    if (!response.ok()) throw new Error(`Facebook image download failed with ${response.status()}`)
    const contentType = response.headers()['content-type']?.split(';')[0] ?? 'image/jpeg'
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(contentType)) {
      throw new Error(`Unsupported Facebook image type: ${contentType}`)
    }
    return { candidate, image: await response.body(), mimeType: contentType }
  } finally {
    await browser.close()
  }
}
