import { chromium } from 'playwright'
import { FACEBOOK_PAGE_URL, PAGE_ID } from '../../src/lib/menu-schema.ts'

export interface FacebookStoryCandidate {
  postId: string
  creationTime: number
  imageUrl: string
  postUrl: string
}

function decodeJsonString(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string
  } catch {
    return value.replaceAll('\\/', '/')
  }
}

export function extractFacebookCandidatesFromHtml(html: string): FacebookStoryCandidate[] {
  const pattern = /"post_id":"(\d+)","creation_time":(\d+)/g
  const candidates = new Map<string, FacebookStoryCandidate>()

  for (const match of html.matchAll(pattern)) {
    if (match.index === undefined) continue
    const before = html.slice(Math.max(0, match.index - 8_000), match.index)
    const after = html.slice(match.index, match.index + 180_000)
    const authorMatches = [...before.matchAll(/"(?:actor_id|page_id)":"(\d+)"/g)]
    const nearestAuthor = authorMatches.at(-1)?.[1]
    if (nearestAuthor !== PAGE_ID) continue

    const imageMatch = after.match(/"photo_image":\{"uri":"((?:\\.|[^"\\])+)"/)
    if (!imageMatch) continue

    const postId = match[1]
    const creationTime = Number(match[2])
    const imageUrl = decodeJsonString(imageMatch[1])
    if (!imageUrl.startsWith('https://') || !Number.isSafeInteger(creationTime)) continue

    candidates.set(postId, {
      postId,
      creationTime,
      imageUrl,
      postUrl: `https://www.facebook.com/permalink.php?story_fbid=${postId}&id=${PAGE_ID}`,
    })
  }

  return [...candidates.values()].sort((a, b) => b.creationTime - a.creationTime)
}

export async function fetchLatestFacebookMenu(): Promise<{
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
    await page.goto(FACEBOOK_PAGE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    await page.locator('article').first().waitFor({ state: 'attached', timeout: 25_000 })
    const html = await page.locator('html').evaluate((element) => element.innerHTML)
    const [candidate] = extractFacebookCandidatesFromHtml(html)
    if (!candidate) throw new Error('No Page-authored image post was found in the public Facebook markup')

    const response = await context.request.get(candidate.imageUrl, {
      headers: { referer: FACEBOOK_PAGE_URL },
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
