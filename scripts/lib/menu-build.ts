import { createHash } from 'node:crypto'
import {
  assertMenuInvariants,
  menuSchema,
  PAGE_ID,
  type Menu,
} from '../../src/lib/menu-schema.ts'
import { FREE_GEMINI_MODEL, type ExtractedMenu } from './gemini.ts'

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`
}

export function imageSha256(image: Uint8Array): string {
  return createHash('sha256').update(image).digest('hex')
}

export function menuFromExtraction(options: {
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
