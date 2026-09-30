import { describe, expect, it } from 'vitest'
import { menuFixture } from '../test/menu-fixture.ts'
import { loadDevelopmentMenu } from './development-menu.ts'

describe('latest saved development menu', () => {
  it('uses the newest valid menu by date regardless of archive iteration order', () => {
    const newer = { ...menuFixture, date: '2026-08-25' }
    expect(loadDevelopmentMenu(menuFixture, { newer, older: menuFixture })).toEqual(newer)
    expect(loadDevelopmentMenu(menuFixture, { older: menuFixture, newer })).toEqual(newer)
  })

  it('prefers a corrected current publication over an archive on the same date', () => {
    const corrected = structuredClone(menuFixture)
    corrected.categories[0].items[0].priceCents = 300
    expect(loadDevelopmentMenu(corrected, { original: menuFixture })).toEqual(corrected)
  })

  it('falls back to a saved archive when the current publication is unavailable', () => {
    expect(loadDevelopmentMenu(null, { saved: menuFixture })).toEqual(menuFixture)
  })

  it('ignores invalid or uncertain archives rather than using them as a development menu', () => {
    const uncertain = { ...menuFixture, date: '2026-08-26', validation: { ...menuFixture.validation, uncertain: true } }
    expect(loadDevelopmentMenu(null, { broken: null, incomplete: { date: '2026-08-27' }, uncertain, saved: menuFixture })).toEqual(menuFixture)
  })

  it('does not invent a menu when no valid saved menu exists', () => {
    expect(loadDevelopmentMenu(null, {})).toBeNull()
    expect(loadDevelopmentMenu(null, { invalid: {} })).toBeNull()
    expect(loadDevelopmentMenu(menuFixture, {})).toEqual(menuFixture)
  })
})
