import { describe, expect, it } from 'vitest'
import { menuFixture } from '../test/menu-fixture.ts'
import { assertMenuInvariants, menuSchema } from './menu-schema.ts'

describe('menu validation', () => {
  it('rejects currencies other than EUR and non-integer prices', () => {
    expect(menuSchema.safeParse({ ...menuFixture, currency: 'BGN' }).success).toBe(false)
    const invalidPrice = structuredClone(menuFixture)
    invalidPrice.categories[0].items[0].priceCents = 270.5
    expect(menuSchema.safeParse(invalidPrice).success).toBe(false)
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
})
