import { describe, expect, it } from 'vitest'
import { menuFixture } from '../test/menu-fixture.ts'
import { createOrderSummary, formatEuro, summaryToText } from './order.ts'

describe('order calculations', () => {
  it('uses integer cents for 2 × €2.70 + 1 × €5.10 = €10.50', () => {
    const summary = createOrderSummary(menuFixture, { soup: 2, main: 1 }, 'Иван', 'Без люто')

    expect(summary.totalCents).toBe(1050)
    expect(summary.lines.map((line) => line.lineTotalCents)).toEqual([540, 510])
    expect(formatEuro(summary.totalCents)).toMatch(/10,50\s*€/)
  })

  it('creates a named, complete share summary', () => {
    const text = summaryToText(
      createOrderSummary(menuFixture, { soup: 1 }, '  Мария  ', '  без хляб  '),
    )

    expect(text).toContain('Обяд за 2026-08-24 — Мария')
    expect(text).toContain('1 × Пилешка супа (350 мл)')
    expect(text).toContain('Бележка: без хляб')
    expect(text).toContain(menuFixture.source.postUrl)
  })
})
