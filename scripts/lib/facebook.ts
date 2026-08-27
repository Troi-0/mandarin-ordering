import { chromium } from 'playwright'
import { FACEBOOK_PAGE_URL, PAGE_ID } from '../../src/lib/menu-schema.ts'

export interface FacebookStoryCandidate {
  postId: string
  creationTime: number
  imageUrl: string
  postUrl: string
}

export interface FacebookPostTarget {
  postId: string
}

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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
    const candidate = selectFacebookCandidate(
      extractFacebookCandidatesFromJsonScripts(jsonScripts),
      target,
    )
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
