import { describe, expect, it } from 'vitest'
import { menuFixture } from '../test/menu-fixture.ts'
import {
  clampQuantity,
  createOrderLines,
  createOrderSummary,
  formatEuro,
  summaryToText,
} from './order.ts'

describe('order calculations', () => {
  it('uses integer cents for 2 × €2.70 + 1 × €5.10 = €10.50', () => {
    const summary = createOrderSummary(menuFixture, { soup: 2, main: 1 }, 'Иван', 'Без люто')

    expect(summary.totalCents).toBe(1050)
    expect(summary.lines.map((line) => line.lineTotalCents)).toEqual([540, 510])
    expect(formatEuro(summary.totalCents)).toMatch(/10,50\s*€/)
  })

  it('clamps quantities to whole values between zero and twenty', () => {
    expect(clampQuantity(-4)).toBe(0)
    expect(clampQuantity(2.9)).toBe(2)
    expect(clampQuantity(20)).toBe(20)
    expect(clampQuantity(99)).toBe(20)
  })

  it('ignores zero and negative selections and clamps oversized selections before pricing', () => {
    expect(createOrderLines(menuFixture, { soup: 0, main: -2 })).toEqual([])
    expect(createOrderLines(menuFixture, { soup: 25 })).toEqual([{
      itemId: 'soup',
      name: 'Пилешка супа',
      portion: '350 мл',
      quantity: 20,
      unitPriceCents: 270,
      lineTotalCents: 5400,
    }])
  })

  it('fails instead of silently pricing an item that is absent from the menu', () => {
    expect(() => createOrderLines(menuFixture, { removed: 1 })).toThrow('Unknown item id: removed')
  })

  it('omits a portion only when the source item has none', () => {
    const menu = structuredClone(menuFixture)
    delete menu.categories[1].items[0].portion
    expect(createOrderLines(menu, { main: 1 })[0]).not.toHaveProperty('portion')
  })

  it('formats cents as Bulgarian euros without floating-point drift', () => {
    expect(formatEuro(51)).toMatch(/0,51\s*€/)
    expect(formatEuro(270)).toMatch(/2,70\s*€/)
    expect(formatEuro(10_050)).toMatch(/100,50\s*€/)
  })

  it('creates a named copy summary without a source URL', () => {
    const text = summaryToText(
      createOrderSummary(menuFixture, { soup: 1 }, '  Мария  ', '  без хляб  '),
    )

    expect(text).toContain('Обяд за 2026-08-24 — Мария')
    expect(text).toContain('1 × Пилешка супа (350 мл)')
    expect(text).toContain('Бележка: без хляб')
    expect(text).not.toContain('Източник:')
    expect(text).not.toContain(menuFixture.source.postUrl)
  })

  it('omits an empty note and keeps every selected line and its calculated total', () => {
    const summary = createOrderSummary(menuFixture, { soup: 2, main: 1 }, '  Иван  ', '   ')
    const text = summaryToText(summary)

    expect(summary).not.toHaveProperty('note')
    expect(text).toContain('2 × Пилешка супа (350 мл)')
    expect(text).toContain('1 × Пилешко филе (350 г)')
    expect(text).toMatch(/Общо: 10,50\s*€/)
    expect(text).not.toContain('Бележка:')
  })
})
