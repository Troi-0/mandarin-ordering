import { describe, expect, it } from 'vitest'
import { createValidMenuFixture } from '../../src/test/menu-fixture.ts'
import { evaluateExternalRecovery, isExternalRecoveryWindow } from './external-recovery.ts'

const HEAD_SHA = 'a'.repeat(40)
const FRIDAY_MORNING = new Date('2026-09-04T06:30:00Z')

function readyPublication(date = '2026-09-04') {
  const menu = createValidMenuFixture()
  menu.date = date
  return { status: 'ready' as const, menu }
}

function decision(overrides: Partial<Parameters<typeof evaluateExternalRecovery>[0]> = {}) {
  return evaluateExternalRecovery({
    publication: readyPublication(),
    headSha: HEAD_SHA,
    importerRuns: [],
    pagesRuns: [{ status: 'completed', conclusion: 'success', head_sha: HEAD_SHA }],
    now: FRIDAY_MORNING,
    ...overrides,
  })
}

describe('external menu recovery', () => {
  it('uses a Sofia weekday recovery window independent of the machine timezone', () => {
    expect(isExternalRecoveryWindow(new Date('2026-09-04T05:00:00Z'))).toBe(true)
    expect(isExternalRecoveryWindow(new Date('2026-09-04T10:59:59Z'))).toBe(true)
    expect(isExternalRecoveryWindow(new Date('2026-09-04T11:00:00Z'))).toBe(false)
    expect(isExternalRecoveryWindow(new Date('2026-09-05T06:30:00Z'))).toBe(false)
  })

  it('does nothing when today menu and the exact Pages commit are ready', () => {
    expect(decision()).toEqual({
      dispatch: false,
      reason: 'ready',
      sofiaDate: '2026-09-04',
    })
  })

  it('dispatches when the committed menu is stale', () => {
    expect(decision({ publication: readyPublication('2026-09-03') })).toMatchObject({
      dispatch: true,
      reason: 'stale',
    })
  })

  it('dispatches a reconciliation run when Pages has not deployed the current commit', () => {
    expect(decision({
      pagesRuns: [{ status: 'completed', conclusion: 'success', head_sha: 'b'.repeat(40) }],
    })).toMatchObject({
      dispatch: true,
      reason: 'pages-missing',
    })
  })

  it('does not duplicate an active importer or Pages deployment', () => {
    expect(decision({
      publication: readyPublication('2026-09-03'),
      importerRuns: [{ status: 'in_progress' }],
    })).toMatchObject({ dispatch: false, reason: 'import-active' })

    expect(decision({
      pagesRuns: [{ status: 'queued', head_sha: HEAD_SHA }],
    })).toMatchObject({ dispatch: false, reason: 'pages-active' })
  })

  it('does not dispatch outside the recovery window', () => {
    expect(decision({ now: new Date('2026-09-05T06:30:00Z') })).toMatchObject({
      dispatch: false,
      reason: 'outside-window',
    })
  })
})
