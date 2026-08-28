import { describe, expect, it } from 'vitest'
import { evaluateMenuFreshness } from './menu-freshness.ts'

function readyMenu(date: string, priceCents = 500): unknown {
  return {
    status: 'ready',
    menu: {
      date,
      currency: 'EUR',
      categories: [
        {
          items: Array.from({ length: 4 }, (_, index) => ({
            name: `Soup ${index}`,
            priceCents,
          })),
        },
        {
          items: Array.from({ length: 4 }, (_, index) => ({
            name: `Main ${index}`,
            priceCents,
          })),
        },
      ],
    },
  }
}

describe('menu freshness watchdog', () => {
  it('does not dispatch when a plausible menu for today is ready', () => {
    expect(evaluateMenuFreshness(
      readyMenu('2026-08-28'),
      new Date('2026-08-28T06:30:00Z'),
    )).toEqual({
      needsImport: false,
      reason: 'fresh',
      sofiaDate: '2026-08-28',
    })
  })

  it('requests recovery when the current menu is from yesterday', () => {
    expect(evaluateMenuFreshness(
      readyMenu('2026-08-27'),
      new Date('2026-08-28T06:30:00Z'),
    )).toMatchObject({ needsImport: true, reason: 'stale' })
  })

  it.each([
    null,
    { status: 'unavailable' },
    readyMenu('2026-08-28', 0),
    { status: 'ready', menu: { date: '2026-08-28', currency: 'EUR', categories: [] } },
  ])('requests recovery for missing or implausible current data', (publication) => {
    expect(evaluateMenuFreshness(
      publication,
      new Date('2026-08-28T06:30:00Z'),
    )).toMatchObject({ needsImport: true, reason: 'stale' })
  })

  it('does nothing outside the weekday ordering window', () => {
    expect(evaluateMenuFreshness(
      readyMenu('2026-08-27'),
      new Date('2026-08-28T10:30:00Z'),
    )).toMatchObject({ needsImport: false, reason: 'outside-window' })
    expect(evaluateMenuFreshness(
      readyMenu('2026-08-28'),
      new Date('2026-08-29T06:30:00Z'),
    )).toMatchObject({ needsImport: false, reason: 'outside-window' })
  })

  it('allows a manual recovery check outside the scheduled window', () => {
    expect(evaluateMenuFreshness(
      readyMenu('2026-08-27'),
      new Date('2026-08-28T12:30:00Z'),
      true,
    )).toMatchObject({ needsImport: true, reason: 'stale' })
  })

  it('uses Sofia daylight-saving time for the recovery window', () => {
    expect(evaluateMenuFreshness(
      readyMenu('2026-08-27'),
      new Date('2026-08-28T05:15:00Z'),
    )).toMatchObject({ needsImport: true })
    expect(evaluateMenuFreshness(
      readyMenu('2026-01-09'),
      new Date('2026-01-09T05:15:00Z'),
    )).toMatchObject({ needsImport: false, reason: 'outside-window' })
    expect(evaluateMenuFreshness(
      readyMenu('2026-01-08'),
      new Date('2026-01-09T06:15:00Z'),
    )).toMatchObject({ needsImport: true })
  })
})
