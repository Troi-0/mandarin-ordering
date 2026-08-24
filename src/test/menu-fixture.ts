import type { Menu } from '../lib/menu-schema.ts'

export const menuFixture: Menu = {
  date: '2026-08-24',
  restaurant: 'Mandarin House',
  currency: 'EUR',
  source: {
    pageId: '100063668642218',
    postId: 'fixture-post',
    postUrl: 'https://www.facebook.com/permalink.php?story_fbid=fixture-post&id=100063668642218',
    publishedAt: '2026-08-24T05:30:03Z',
    imageSha256: 'a'.repeat(64),
  },
  importedAt: '2026-08-24T06:00:00Z',
  importMethod: 'manual',
  validation: {
    extractedBy: 'test-fixture',
    verifiedBy: 'test-fixture',
    uncertain: false,
  },
  categories: [
    {
      id: 'soups',
      name: 'Супи',
      items: [
        { id: 'soup', name: 'Пилешка супа', portion: '350 мл', priceCents: 270 },
      ],
    },
    {
      id: 'mains',
      name: 'Основни',
      items: [
        { id: 'main', name: 'Пилешко филе', portion: '350 г', priceCents: 510 },
      ],
    },
  ],
}
