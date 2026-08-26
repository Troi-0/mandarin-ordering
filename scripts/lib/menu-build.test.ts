import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { menuSchema } from '../../src/lib/menu-schema.ts'
import { extractedMenuSchema, FREE_GEMINI_MODEL, type ExtractedMenu } from './gemini.ts'
import { imageSha256, menuFromExtraction } from './menu-build.ts'

async function approvedTranscript(): Promise<ExtractedMenu> {
  const source = menuSchema.parse(
    JSON.parse(await readFile('data/menus/2026-08-24.json', 'utf8')),
  )
  return extractedMenuSchema.parse({
    uncertain: false,
    uncertaintyNotes: [],
    categories: source.categories.map((category) => ({
      name: category.name,
      items: category.items.map((item) => ({
        name: item.name,
        portion: item.portion ?? null,
        priceCents: item.priceCents,
        uncertain: false,
      })),
    })),
  })
}

afterEach(() => vi.useRealTimers())

describe('approved transcription to published menu', () => {
  it('copies all 43 prices and portions without conversion or rounding', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-24T06:00:00Z'))
    const extracted = await approvedTranscript()
    const image = new TextEncoder().encode('public-menu-image')

    const menu = menuFromExtraction({
      date: '2026-08-24',
      sourcePostId: '123456789',
      sourcePostUrl: 'https://www.facebook.com/permalink.php?story_fbid=123456789&id=100063668642218',
      publishedAt: '2026-08-24T05:30:00Z',
      image,
      method: 'facebook',
      extracted,
    })

    const extractedItems = extracted.categories.flatMap((category) => category.items)
    const publishedItems = menu.categories.flatMap((category) => category.items)
    expect(publishedItems).toHaveLength(43)
    expect(publishedItems.map((item) => item.priceCents)).toEqual(
      extractedItems.map((item) => item.priceCents),
    )
    expect(publishedItems.map((item) => item.portion ?? null)).toEqual(
      extractedItems.map((item) => item.portion),
    )
    expect(menu.currency).toBe('EUR')
    expect(menu.validation).toEqual({
      extractedBy: FREE_GEMINI_MODEL,
      verifiedBy: `${FREE_GEMINI_MODEL}:blind-transcription`,
      uncertain: false,
    })
    expect(menu.importedAt).toBe('2026-08-24T06:00:00.000Z')
    expect(menu.source.imageSha256).toBe(createHash('sha256').update(image).digest('hex'))
  })

  it('generates deterministic unique IDs from the same approved transcript', async () => {
    const extracted = await approvedTranscript()
    const options = {
      date: '2026-08-24',
      sourcePostId: '123456789',
      sourcePostUrl: 'https://www.facebook.com/permalink.php?story_fbid=123456789&id=100063668642218',
      publishedAt: '2026-08-24T05:30:00Z',
      image: new Uint8Array([1, 2, 3]),
      method: 'manual' as const,
      extracted,
    }

    const first = menuFromExtraction(options)
    const second = menuFromExtraction(options)
    const firstIds = first.categories.flatMap((category) => category.items.map((item) => item.id))
    const secondIds = second.categories.flatMap((category) => category.items.map((item) => item.id))

    expect(secondIds).toEqual(firstIds)
    expect(new Set(firstIds).size).toBe(firstIds.length)
  })

  it('rejects an otherwise valid transcription with too few menu items', async () => {
    const extracted = await approvedTranscript()
    extracted.categories = extracted.categories.slice(0, 2).map((category) => ({
      ...category,
      items: category.items.slice(0, 1),
    }))

    expect(() => menuFromExtraction({
      date: '2026-08-24',
      sourcePostId: '123456789',
      sourcePostUrl: 'https://www.facebook.com/permalink.php?story_fbid=123456789&id=100063668642218',
      publishedAt: '2026-08-24T05:30:00Z',
      image: new Uint8Array([1]),
      method: 'manual',
      extracted,
    })).toThrow('Expected 8-100 items')
  })

  it('hashes image bytes deterministically', () => {
    const bytes = new Uint8Array([0, 1, 2, 255])
    expect(imageSha256(bytes)).toBe(imageSha256(bytes))
    expect(imageSha256(bytes)).toMatch(/^[a-f0-9]{64}$/)
    expect(imageSha256(bytes)).not.toBe(imageSha256(new Uint8Array([0, 1, 2])))
  })
})
