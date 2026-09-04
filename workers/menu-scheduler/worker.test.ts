import { afterEach, describe, expect, it, vi } from 'vitest'
import workerConfig from './wrangler.json'
import { checkAndRecover, evaluateRecovery } from './worker.ts'

const HEAD_SHA = 'a'.repeat(40)
const FRIDAY_MORNING = new Date('2026-09-04T06:50:00Z')

function publication(date = '2026-09-04') {
  return {
    status: 'ready',
    menu: {
      date,
      currency: 'EUR',
      categories: [
        { items: Array.from({ length: 4 }, (_, index) => ({ name: `A${index}`, priceCents: 100 })) },
        { items: Array.from({ length: 4 }, (_, index) => ({ name: `B${index}`, priceCents: 200 })) },
      ],
    },
  }
}

function response(value: unknown, status = 200): Response {
  return new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function githubSequence(options: {
  menu?: unknown
  importerRuns?: unknown[]
  pagesRuns?: unknown[]
  dispatch?: Response
} = {}) {
  const fetchMock = vi.fn()
    .mockResolvedValueOnce(response(options.menu ?? publication()))
    .mockResolvedValueOnce(response({ sha: HEAD_SHA }))
    .mockResolvedValueOnce(response({ workflow_runs: options.importerRuns ?? [] }))
    .mockResolvedValueOnce(response({
      workflow_runs: options.pagesRuns
        ?? [{ status: 'completed', conclusion: 'success', head_sha: HEAD_SHA }],
    }))
  if (options.dispatch) fetchMock.mockResolvedValueOnce(options.dispatch)
  return fetchMock
}

afterEach(() => vi.restoreAllMocks())

describe('Cloudflare menu scheduler', () => {
  it('has only a weekday Cron Trigger and no public workers.dev route', () => {
    expect(workerConfig).toMatchObject({
      workers_dev: false,
      triggers: { crons: ['*/15 5-11 * * 1-5'] },
    })
    expect(workerConfig).not.toHaveProperty('routes')
  })

  it('uses a DST-safe Sofia recovery window beginning after the menu post time', () => {
    expect(evaluateRecovery({
      publication: null,
      headSha: HEAD_SHA,
      importerRuns: [],
      pagesRuns: [],
      now: new Date('2026-09-04T05:35:00Z'),
    })).toMatchObject({ dispatch: false, reason: 'outside-window' })

    expect(evaluateRecovery({
      publication: null,
      headSha: HEAD_SHA,
      importerRuns: [],
      pagesRuns: [],
      now: FRIDAY_MORNING,
    })).toMatchObject({ dispatch: true, reason: 'stale' })

    expect(evaluateRecovery({
      publication: null,
      headSha: HEAD_SHA,
      importerRuns: [],
      pagesRuns: [],
      now: new Date('2026-12-04T06:50:00Z'),
    })).toMatchObject({ dispatch: true, reason: 'stale' })
  })

  it('does not call GitHub outside the recovery window', async () => {
    const fetchMock = vi.fn()
    await expect(checkAndRecover(
      new Date('2026-09-05T06:50:00Z'),
      'test-token',
      fetchMock,
    )).resolves.toMatchObject({ dispatch: false, reason: 'outside-window' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does nothing when today menu and the exact Pages commit are ready', async () => {
    const fetchMock = githubSequence()
    await expect(checkAndRecover(FRIDAY_MORNING, 'test-token', fetchMock))
      .resolves.toMatchObject({ dispatch: false, reason: 'ready' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('does not duplicate an active importer', async () => {
    const fetchMock = githubSequence({
      menu: publication('2026-09-03'),
      importerRuns: [{ status: 'in_progress' }],
    })
    await expect(checkAndRecover(FRIDAY_MORNING, 'test-token', fetchMock))
      .resolves.toMatchObject({ dispatch: false, reason: 'import-active' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('does not duplicate an active Pages deployment', async () => {
    const fetchMock = githubSequence({
      pagesRuns: [{ status: 'in_progress', conclusion: null, head_sha: HEAD_SHA }],
    })
    await expect(checkAndRecover(FRIDAY_MORNING, 'test-token', fetchMock))
      .resolves.toMatchObject({ dispatch: false, reason: 'pages-active' })
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it.each([
    ['stale', { menu: publication('2026-09-03') }],
    ['pages-missing', { pagesRuns: [] }],
  ])('dispatches the importer for %s publication state', async (reason, options) => {
    const fetchMock = githubSequence({
      ...options,
      dispatch: response({ html_url: 'https://github.com/Troi-0/mandarin-ordering/actions/runs/123' }),
    })

    await expect(checkAndRecover(FRIDAY_MORNING, 'test-token', fetchMock)).resolves.toEqual({
      dispatch: true,
      reason,
      sofiaDate: '2026-09-04',
      runUrl: 'https://github.com/Troi-0/mandarin-ordering/actions/runs/123',
    })
    expect(fetchMock).toHaveBeenCalledTimes(5)
    const [url, init] = fetchMock.mock.calls[4]
    expect(url).toContain('/actions/workflows/import-facebook.yml/dispatches')
    expect(init).toMatchObject({
      method: 'POST',
      headers: { authorization: 'Bearer test-token' },
    })
    expect(JSON.parse(String(init.body))).toEqual({
      ref: 'master',
      inputs: { dry_run: 'false' },
      return_run_details: true,
    })
  })

  it('surfaces a failed dispatch for Cloudflare observability', async () => {
    const fetchMock = githubSequence({
      menu: publication('2026-09-03'),
      dispatch: response({ message: 'forbidden' }, 403),
    })
    await expect(checkAndRecover(FRIDAY_MORNING, 'test-token', fetchMock))
      .rejects.toThrow('workflow dispatch failed with 403')
  })
})
