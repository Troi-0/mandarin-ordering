import { describe, expect, it } from 'vitest'
import { createValidMenuFixture, menuFixture } from '../test/menu-fixture.ts'
import {
  assertMenuInvariants,
  menuPublicationSchema,
  menuSchema,
  PAGE_ID,
} from './menu-schema.ts'

describe('menu validation', () => {
  it('accepts a complete ready EUR publication from the configured Facebook Page', () => {
    const menu = createValidMenuFixture()
    expect(menuSchema.parse(menu)).toEqual(menu)
    expect(menuPublicationSchema.parse({ status: 'ready', menu })).toEqual({ status: 'ready', menu })
    expect(() => assertMenuInvariants(menu)).not.toThrow()
  })

  it('rejects currencies other than EUR and non-integer prices', () => {
    expect(menuSchema.safeParse({ ...menuFixture, currency: 'BGN' }).success).toBe(false)
    const invalidPrice = structuredClone(menuFixture)
    invalidPrice.categories[0].items[0].priceCents = 270.5
    expect(menuSchema.safeParse(invalidPrice).success).toBe(false)
  })

  it('rejects zero, negative, and implausibly large prices', () => {
    for (const priceCents of [0, -1, 10_001]) {
      const menu = structuredClone(menuFixture)
      menu.categories[0].items[0].priceCents = priceCents
      expect(menuSchema.safeParse(menu).success).toBe(false)
    }
    const maximumPrice = structuredClone(menuFixture)
    maximumPrice.categories[0].items[0].priceCents = 10_000
    expect(menuSchema.safeParse(maximumPrice).success).toBe(true)
  })

  it('requires the configured Page, a Facebook source URL, and verified certainty', () => {
    const wrongPage = {
      ...structuredClone(menuFixture),
      source: { ...menuFixture.source, pageId: '999999999999999' },
    }
    expect(menuSchema.safeParse(wrongPage).success).toBe(false)

    const wrongSource = structuredClone(menuFixture)
    wrongSource.source.postUrl = 'https://example.com/menu'
    expect(menuSchema.safeParse(wrongSource).success).toBe(false)

    const uncertain = structuredClone(menuFixture) as unknown as Record<string, unknown>
    const validation = (uncertain.validation as Record<string, unknown>)
    validation.uncertain = true
    expect(menuSchema.safeParse(uncertain).success).toBe(false)
    expect(menuFixture.source.pageId).toBe(PAGE_ID)
  })

  it('accepts only the documented unavailable reasons', () => {
    expect(menuPublicationSchema.safeParse({
      status: 'unavailable',
      reason: 'not-posted',
      lastCheckedAt: '2026-08-24T06:00:00Z',
    }).success).toBe(true)
    expect(menuPublicationSchema.safeParse({
      status: 'unavailable',
      reason: 'yesterday-is-good-enough',
    }).success).toBe(false)
  })

  it('rejects implausibly small menus and duplicates', () => {
    expect(() => assertMenuInvariants(menuFixture)).toThrow('Expected 8-100 items')
    const duplicateFixture = structuredClone(menuFixture)
    const items = Array.from({ length: 8 }, (_, index) => ({
      id: `item-${index}`,
      name: index < 2 ? 'Еднакво ястие' : `Ястие ${index}`,
      portion: '100 г',
      priceCents: 250,
    }))
    duplicateFixture.categories[0].items = items
    duplicateFixture.categories[1].items = []
    expect(() => assertMenuInvariants(duplicateFixture)).toThrow('Duplicate menu item')
  })

  it('rejects duplicate item IDs even when their contents differ', () => {
    const menu = createValidMenuFixture()
    menu.categories[1].items[0].id = menu.categories[0].items[0].id
    expect(() => assertMenuInvariants(menu)).toThrow('Duplicate item id')
  })

  it('allows the same display name in different categories when the complete signatures differ', () => {
    const menu = createValidMenuFixture()
    menu.categories[0].items[0].name = 'Ориз'
    menu.categories[1].items[0].name = 'Ориз'
    expect(() => assertMenuInvariants(menu)).not.toThrow()
  })
})
