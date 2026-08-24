import { describe, expect, it } from 'vitest'
import { isTodayInSofia, sofiaDate } from './date.ts'

describe('Sofia calendar date', () => {
  it('handles the spring daylight-saving transition', () => {
    expect(sofiaDate(new Date('2026-03-28T22:30:00Z'))).toBe('2026-03-29')
    expect(sofiaDate(new Date('2026-03-29T21:30:00Z'))).toBe('2026-03-30')
  })

  it('handles the autumn daylight-saving transition', () => {
    expect(sofiaDate(new Date('2026-10-24T21:30:00Z'))).toBe('2026-10-25')
    expect(isTodayInSofia('2026-10-25', new Date('2026-10-25T21:30:00Z'))).toBe(true)
  })
})
