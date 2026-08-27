import { createHash } from 'node:crypto'
import {
  assertMenuInvariants,
  menuSchema,
  PAGE_ID,
  type Menu,
} from '../../src/lib/menu-schema.ts'
import { FREE_GEMINI_MODEL, type ExtractedMenu } from './gemini.ts'

export interface MenuBuildOptions {
  date: string
  sourcePostId: string
  sourcePostUrl: string
  publishedAt: string
  image: Uint8Array
  method: 'facebook' | 'manual'
  extracted: ExtractedMenu
}

export interface ReviewMenu extends Omit<Menu, 'validation'> {
  validation: {
    extractedBy: string
    verifiedBy: 'human-review-required'
    uncertain: true
  }
}

function stableId(prefix: string, value: string): string {
  return `${prefix}-${createHash('sha256').update(value).digest('hex').slice(0, 12)}`
}

export function imageSha256(image: Uint8Array): string {
  return createHash('sha256').update(image).digest('hex')
}

function menuRecord(
  options: MenuBuildOptions,
  validation: Menu['validation'] | ReviewMenu['validation'],
) {
  return {
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
    validation,
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
  }
}

export function reviewMenuFromExtraction(options: MenuBuildOptions): ReviewMenu {
  return menuRecord(options, {
    extractedBy: FREE_GEMINI_MODEL,
    verifiedBy: 'human-review-required',
    uncertain: true,
  }) as ReviewMenu
}

export function menuFromExtraction(options: MenuBuildOptions): Menu {
  const menu = menuSchema.parse(menuRecord(options, {
    extractedBy: FREE_GEMINI_MODEL,
    verifiedBy: `${FREE_GEMINI_MODEL}:blind-transcription`,
    uncertain: false,
  }))
  assertMenuInvariants(menu)
  return menu
}
