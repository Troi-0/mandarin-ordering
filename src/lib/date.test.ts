import { describe, expect, it } from 'vitest'
import {
  formatBulgarianDate,
  isMenuOverdue,
  isSofiaWeekend,
  isTodayInSofia,
  MENU_OVERDUE_SOFIA_HOUR,
  nextWorkingSofiaDate,
  sofiaDate,
} from './date.ts'

describe('Sofia calendar date', () => {
  it('handles the spring daylight-saving transition', () => {
    expect(sofiaDate(new Date('2026-03-28T22:30:00Z'))).toBe('2026-03-29')
    expect(sofiaDate(new Date('2026-03-29T21:30:00Z'))).toBe('2026-03-30')
  })

  it('handles the autumn daylight-saving transition', () => {
    expect(sofiaDate(new Date('2026-10-24T21:30:00Z'))).toBe('2026-10-25')
    expect(isTodayInSofia('2026-10-25', new Date('2026-10-25T21:30:00Z'))).toBe(true)
  })

  it('changes date at Sofia midnight rather than UTC midnight', () => {
    expect(sofiaDate(new Date('2026-08-24T20:59:59Z'))).toBe('2026-08-24')
    expect(sofiaDate(new Date('2026-08-24T21:00:00Z'))).toBe('2026-08-25')
    expect(isTodayInSofia('2026-08-24', new Date('2026-08-24T21:00:00Z'))).toBe(false)
  })

  it('formats a repository date as a Bulgarian calendar date', () => {
    const formatted = formatBulgarianDate('2026-08-24')
    expect(formatted).toContain('24 август 2026 г.')
    expect(formatted).toContain('понеделник')
  })
})

describe('Sofia working days', () => {
  it('treats only Saturday and Sunday as restaurant rest days', () => {
    expect(isSofiaWeekend('2026-09-04')).toBe(false)
    expect(isSofiaWeekend('2026-09-05')).toBe(true)
    expect(isSofiaWeekend('2026-09-06')).toBe(true)
    expect(isSofiaWeekend('2026-09-07')).toBe(false)
  })

  it('points every weekend and Friday at the following Monday', () => {
    expect(nextWorkingSofiaDate('2026-09-04')).toBe('2026-09-07')
    expect(nextWorkingSofiaDate('2026-09-05')).toBe('2026-09-07')
    expect(nextWorkingSofiaDate('2026-09-06')).toBe('2026-09-07')
    expect(nextWorkingSofiaDate('2026-09-07')).toBe('2026-09-08')
  })

  it('crosses the autumn daylight-saving change and the year boundary', () => {
    expect(nextWorkingSofiaDate('2026-10-24')).toBe('2026-10-26')
    expect(nextWorkingSofiaDate('2026-12-31')).toBe('2027-01-01')
  })
})

describe('menu overdue cutoff', () => {
  it('turns over at the cutoff hour in Sofia, not UTC', () => {
    expect(MENU_OVERDUE_SOFIA_HOUR).toBe(11)
    // Summer: Sofia is UTC+3, so 10:59 local is 07:59Z and 11:00 local is 08:00Z.
    expect(isMenuOverdue(new Date('2026-09-14T07:59:59Z'))).toBe(false)
    expect(isMenuOverdue(new Date('2026-09-14T08:00:00Z'))).toBe(true)
  })

  it('keeps the same local cutoff after the autumn daylight-saving change', () => {
    // Winter: Sofia is UTC+2, so the same local 11:00 is 09:00Z.
    expect(isMenuOverdue(new Date('2026-11-16T08:59:59Z'))).toBe(false)
    expect(isMenuOverdue(new Date('2026-11-16T09:00:00Z'))).toBe(true)
  })

  it('stays overdue for the rest of the day and resets after Sofia midnight', () => {
    expect(isMenuOverdue(new Date('2026-09-14T20:30:00Z'))).toBe(true)
    expect(isMenuOverdue(new Date('2026-09-14T21:30:00Z'))).toBe(false)
  })
})
