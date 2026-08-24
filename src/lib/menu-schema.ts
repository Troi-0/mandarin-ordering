import { z } from 'zod'

export const PAGE_ID = '100063668642218'
export const FACEBOOK_PAGE_URL = `https://www.facebook.com/profile.php?id=${PAGE_ID}`
export const SOFIA_TIME_ZONE = 'Europe/Sofia'

export const menuItemSchema = z.object({
  id: z.string().min(3).max(80),
  name: z.string().trim().min(2).max(220),
  portion: z.string().trim().min(1).max(80).optional(),
  priceCents: z.number().int().min(1).max(10_000),
})

export const menuCategorySchema = z.object({
  id: z.string().min(2).max(50),
  name: z.string().trim().min(2).max(80),
  items: z.array(menuItemSchema).min(1).max(40),
})

export const menuSchema = z.object({
  date: z.iso.date(),
  restaurant: z.literal('Mandarin House'),
  currency: z.literal('EUR'),
  source: z.object({
    pageId: z.literal(PAGE_ID),
    postId: z.string().min(3),
    postUrl: z.url().refine((value) => value.startsWith('https://www.facebook.com/')),
    publishedAt: z.iso.datetime({ offset: true }),
    imageSha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  importedAt: z.iso.datetime({ offset: true }),
  importMethod: z.enum(['facebook', 'manual']),
  validation: z.object({
    extractedBy: z.string().min(2),
    verifiedBy: z.string().min(2),
    uncertain: z.literal(false),
  }),
  categories: z.array(menuCategorySchema).min(2).max(12),
})

export const unavailablePublicationSchema = z.object({
  status: z.literal('unavailable'),
  reason: z.enum(['not-imported', 'not-posted', 'import-failed']),
  lastCheckedAt: z.iso.datetime({ offset: true }).optional(),
})

export const readyPublicationSchema = z.object({
  status: z.literal('ready'),
  menu: menuSchema,
})

export const menuPublicationSchema = z.discriminatedUnion('status', [
  readyPublicationSchema,
  unavailablePublicationSchema,
])

export type MenuItem = z.infer<typeof menuItemSchema>
export type MenuCategory = z.infer<typeof menuCategorySchema>
export type Menu = z.infer<typeof menuSchema>
export type MenuPublication = z.infer<typeof menuPublicationSchema>

export function assertMenuInvariants(menu: Menu): void {
  const items = menu.categories.flatMap((category) => category.items)
  if (items.length < 8 || items.length > 100) {
    throw new Error(`Expected 8-100 items, received ${items.length}`)
  }

  const ids = new Set<string>()
  const signatures = new Set<string>()
  for (const category of menu.categories) {
    for (const item of category.items) {
      if (ids.has(item.id)) throw new Error(`Duplicate item id: ${item.id}`)
      ids.add(item.id)
      const signature = `${category.name}|${item.name}|${item.portion ?? ''}|${item.priceCents}`
        .toLocaleLowerCase('bg-BG')
      if (signatures.has(signature)) throw new Error(`Duplicate menu item: ${item.name}`)
      signatures.add(signature)
    }
  }
}
