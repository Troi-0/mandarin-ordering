import { describe, expect, it } from 'vitest'
import { formatBulgarianDate, isTodayInSofia, sofiaDate } from './date.ts'

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
