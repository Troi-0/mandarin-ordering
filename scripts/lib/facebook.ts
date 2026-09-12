import { chromium, type Page } from 'playwright'
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

function isFacebookCdnUrl(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    return false
  }
  return parsed.protocol === 'https:'
    && (parsed.hostname === 'fbcdn.net' || parsed.hostname.endsWith('.fbcdn.net'))
}

function containsFacebookCdnImage(value: unknown): boolean {
  if (typeof value === 'string') return isFacebookCdnUrl(value)
  if (Array.isArray(value)) return value.some(containsFacebookCdnImage)
  if (!isRecord(value)) return false
  return Object.values(value).some(containsFacebookCdnImage)
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
    if (!isFacebookCdnUrl(imageUrl)) return undefined
    return imageUrl
  } catch {
    return undefined
  }
}

export async function targetedPermalinkCandidate(
  page: Page,
  target: FacebookPostTarget,
): Promise<FacebookStoryCandidate | undefined> {
  if (!Number.isSafeInteger(target.creationTime) || Number(target.creationTime) <= 0) {
    return undefined
  }
  const postUrl = `https://www.facebook.com/permalink.php?story_fbid=${target.postId}&id=${PAGE_ID}`
  // Use a real page navigation. Facebook currently returns HTTP 400 to
  // Playwright's API-style request client even when the public browser page is
  // available, and the browser page preserves the feed context and cookies.
  const response = await page.goto(postUrl, {
    waitUntil: 'domcontentloaded',
    timeout: 45_000,
  })
  if (!response?.ok()) return undefined
  const imageUrl = extractTargetedPermalinkImage(await page.content(), target)
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
    if (!isFacebookCdnUrl(uri)) continue
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

function isPageStory(record: JsonRecord): boolean {
  return typeof record.post_id === 'string'
    && /^\d+$/.test(record.post_id)
    && Number.isSafeInteger(record.creation_time)
    && Number(record.creation_time) > 0
    && directAuthorIds(record).includes(PAGE_ID)
}

function carriesUnusableMedia(record: JsonRecord): boolean {
  if (!Array.isArray(record.attachments) || record.attachments.length === 0) return false
  return record.attachments.some(
    (attachment) => isRecord(attachment) && containsFacebookCdnImage(mediaFromAttachment(attachment)),
  )
}

export interface FacebookFeedInspection {
  candidates: FacebookStoryCandidate[]
  /** Page-authored story records this parser understood, with or without an image. */
  pageStories: number
  /** Page stories whose attachment media holds an image this parser could not resolve to exactly one photo. */
  unusableMediaStories: number
}

export function inspectFacebookFeed(jsonScripts: readonly string[]): FacebookFeedInspection {
  const candidates = new Map<string, FacebookStoryCandidate>()
  const ambiguousPostIds = new Set<string>()
  const pageStoryIds = new Set<string>()
  const unusableMediaIds = new Set<string>()

  for (const source of jsonScripts) {
    let parsed: unknown
    try {
      parsed = JSON.parse(source) as unknown
    } catch {
      continue
    }

    for (const record of recordsIn(parsed)) {
      if (isPageStory(record)) {
        const postId = record.post_id as string
        pageStoryIds.add(postId)
        if (!directPhotoUrl(record) && carriesUnusableMedia(record)) unusableMediaIds.add(postId)
      }

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

  for (const postId of ambiguousPostIds) unusableMediaIds.add(postId)

  return {
    candidates: [...candidates.values()].sort((a, b) => b.creationTime - a.creationTime),
    pageStories: pageStoryIds.size,
    unusableMediaStories: unusableMediaIds.size,
  }
}

export function extractFacebookCandidatesFromJsonScripts(
  jsonScripts: readonly string[],
): FacebookStoryCandidate[] {
  return inspectFacebookFeed(jsonScripts).candidates
}

export function selectFacebookCandidate(
  candidates: FacebookStoryCandidate[],
  target?: FacebookPostTarget,
): FacebookStoryCandidate | undefined {
  if (!target) return candidates[0]
  return candidates.find((candidate) => candidate.postId === target.postId)
}

export type FacebookMenuResult =
  | { status: 'ready'; candidate: FacebookStoryCandidate; image: Uint8Array; mimeType: string }
  | { status: 'no-menu-post'; detail: string }

export async function fetchFacebookMenu(target?: FacebookPostTarget): Promise<FacebookMenuResult> {
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
    const inspection = inspectFacebookFeed(jsonScripts)
    let candidate = selectFacebookCandidate(inspection.candidates, target)
    // Explicitly targeted historical benchmarks are dry-run only. Facebook's
    // feed rotates older records out, so use same-document Open Graph metadata
    // from the exact permalink when a trusted reference supplies the timestamp.
    if (!candidate && target) {
      candidate = await targetedPermalinkCandidate(page, target)
    }
    if (!candidate) {
      const pageTitle = (await page.title()).slice(0, 120)
      const serialized = jsonScripts.join('')
      const diagnostics = {
        jsonScripts: jsonScripts.length,
        pageStories: inspection.pageStories,
        unusableMediaStories: inspection.unusableMediaStories,
        postId: serialized.match(/post_id/g)?.length ?? 0,
        creationTime: serialized.match(/creation_time/g)?.length ?? 0,
        attachments: serialized.match(/attachments/g)?.length ?? 0,
        photoImage: serialized.match(/photo_image/g)?.length ?? 0,
        pageId: serialized.match(new RegExp(PAGE_ID, 'g'))?.length ?? 0,
      }
      const evidence = `${serialized.length} bytes, title: ${pageTitle}, target: ${target?.postId ?? 'latest'}, signals: ${JSON.stringify(diagnostics)}`
      // A Page that simply has not posted a menu today is the ordinary case and
      // must not look like a broken importer. Only an unreadable feed, or a post
      // whose media this parser can no longer resolve, is a real failure.
      if (target || inspection.pageStories === 0 || inspection.unusableMediaStories > 0) {
        throw new Error(
          `No unambiguous Page-authored image post was found in Facebook JSON (${evidence})`,
        )
      }
      return {
        status: 'no-menu-post',
        detail: `read ${inspection.pageStories} Page post(s), none carrying a menu image (${evidence})`,
      }
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
    return { status: 'ready', candidate, image: await response.body(), mimeType: contentType }
  } finally {
    await browser.close()
  }
}
