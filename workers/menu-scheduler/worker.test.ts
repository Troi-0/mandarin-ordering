import { afterEach, describe, expect, it, vi } from 'vitest'
import workerConfig from './wrangler.json'
import worker, { checkAndRecover, evaluateRecovery } from './worker.ts'

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
  importerRuns?: { status: string }[]
  pagesRuns?: { status: string; conclusion?: string | null; head_sha?: string }[]
  dispatch?: Response
  commit?: unknown
} = {}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    if (init?.method === 'POST') {
      if (!options.dispatch) throw new Error('Unexpected production dispatch')
      return options.dispatch
    }
    if (url.hostname === 'raw.githubusercontent.com') return response(options.menu ?? publication())
    if (url.pathname.includes('/commits/')) return response(options.commit ?? { sha: HEAD_SHA })
    const runs = url.pathname.includes('import-facebook.yml') ? options.importerRuns ?? []
      : options.pagesRuns ?? [{ status: 'completed', conclusion: 'success', head_sha: HEAD_SHA }]
    return response({ workflow_runs: runs.filter((run) => (
      run.status === url.searchParams.get('status')
      || ('conclusion' in run && run.conclusion === url.searchParams.get('status'))
    )) })
  })
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('Cloudflare menu scheduler', () => {
  it('has only a weekday Cron Trigger and no public workers.dev route', () => {
    expect(workerConfig).toMatchObject({
      workers_dev: false,
      preview_urls: false,
      triggers: { crons: ['*/15 5-11 * * MON-FRI'] },
      observability: { enabled: true, logs: { enabled: true, head_sampling_rate: 1 } },
    })
    expect(workerConfig).not.toHaveProperty('routes')
    expect(workerConfig).not.toHaveProperty('route')
    expect(Object.keys(worker)).toEqual(['scheduled'])
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
    expect(fetchMock).toHaveBeenCalledTimes(13)
    const [commitUrl, commitInit] = fetchMock.mock.calls[0]!
    expect(String(commitUrl)).toContain('/commits/master?per_page=1')
    expect(commitInit?.headers).not.toHaveProperty('authorization')
    const menuCall = fetchMock.mock.calls.find(([url]) => String(url).includes('raw.githubusercontent.com'))!
    expect(String(menuCall[0])).toContain(`/${HEAD_SHA}/data/current-menu.json`)
    expect(menuCall[1]?.headers).not.toHaveProperty('authorization')
    expect(fetchMock.mock.calls.every(([url]) => (
      ['api.github.com', 'raw.githubusercontent.com'].includes(new URL(String(url)).hostname)
    ))).toBe(true)
  })

  it('does not duplicate an active importer', async () => {
    const fetchMock = githubSequence({
      menu: publication('2026-09-03'),
      importerRuns: [{ status: 'in_progress' }],
    })
    await expect(checkAndRecover(FRIDAY_MORNING, 'test-token', fetchMock))
      .resolves.toMatchObject({ dispatch: false, reason: 'import-active' })
    expect(fetchMock).toHaveBeenCalledTimes(13)
  })

  it.each(['2026-09-04', '2026-09-03'])('waits for active Pages even with menu date %s', async (date) => {
    const fetchMock = githubSequence({
      menu: publication(date),
      pagesRuns: [{ status: 'in_progress', conclusion: null, head_sha: HEAD_SHA }],
    })
    await expect(checkAndRecover(FRIDAY_MORNING, 'test-token', fetchMock))
      .resolves.toMatchObject({ dispatch: false, reason: 'pages-active' })
    expect(fetchMock).toHaveBeenCalledTimes(13)
  })

  it.each([
    ['stale', { menu: publication('2026-09-03') }],
    ['pages-missing', { pagesRuns: [] }],
  ])('dispatches the importer for %s publication state', async (reason, options) => {
    const fetchMock = githubSequence({
      ...options,
      dispatch: response({ workflow_run_id: 123, html_url: 'https://github.com/Troi-0/mandarin-ordering/actions/runs/123' }),
    })

    await expect(checkAndRecover(FRIDAY_MORNING, 'test-token', fetchMock)).resolves.toEqual({
      dispatch: true,
      reason,
      sofiaDate: '2026-09-04',
      runUrl: 'https://github.com/Troi-0/mandarin-ordering/actions/runs/123',
    })
    expect(fetchMock).toHaveBeenCalledTimes(14)
    const [url, init] = fetchMock.mock.calls[13]!
    expect(url).toBe('https://api.github.com/repos/Troi-0/mandarin-ordering/actions/workflows/import-facebook.yml/dispatches')
    expect(init).toMatchObject({
      method: 'POST',
      headers: { authorization: 'Bearer test-token', 'x-github-api-version': '2026-03-10' },
    })
    expect(JSON.parse(String(init?.body))).toEqual({
      ref: 'master',
      inputs: { dry_run: 'false' },
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

  it.each([
    ['2026-09-04T05:44:59Z', false], ['2026-09-04T05:45:00Z', true],
    ['2026-09-04T10:59:59Z', true], ['2026-09-04T11:00:00Z', false],
    ['2026-12-04T06:44:59Z', false], ['2026-12-04T06:45:00Z', true],
    ['2026-12-04T11:59:59Z', true], ['2026-12-04T12:00:00Z', false],
    ['2026-03-27T06:45:00Z', true], ['2026-03-30T05:45:00Z', true],
    ['2026-10-23T05:45:00Z', true], ['2026-10-26T06:45:00Z', true],
    ['2026-09-05T06:45:00Z', false], ['2026-09-06T06:45:00Z', false],
  ])('enforces Sofia boundaries at %s', (timestamp, dispatch) => {
    expect(evaluateRecovery({ publication: null, headSha: HEAD_SHA,
      importerRuns: [], pagesRuns: [], now: new Date(timestamp),
    }).dispatch).toBe(dispatch)
  })

  it.each(['queued', 'in_progress', 'waiting', 'pending', 'requested'])(
    'finds an older %s importer despite newer completed runs', async (status) => {
      const fetchMock = githubSequence({ importerRuns: [
        ...Array.from({ length: 20 }, () => ({ status: 'completed' })), { status },
      ] })
      await expect(checkAndRecover(FRIDAY_MORNING, 'test-token', fetchMock))
        .resolves.toMatchObject({ dispatch: false, reason: 'import-active' })
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
    },
  )

  it('does not accept a successful deployment of another commit', () => {
    expect(evaluateRecovery({ publication: publication(), headSha: HEAD_SHA,
      importerRuns: [], pagesRuns: [{ status: 'completed', conclusion: 'success', head_sha: 'b'.repeat(40) }],
      now: FRIDAY_MORNING,
    })).toMatchObject({ dispatch: true, reason: 'pages-missing' })
  })

  it.each([401, 403, 429, 500])('fails closed on a %s lookup without exposing response bodies', async (status) => {
    const fetchMock = vi.fn().mockResolvedValue(response({ message: 'test-token' }, status))
    await expect(checkAndRecover(FRIDAY_MORNING, 'test-token', fetchMock))
      .rejects.toThrow(`GitHub lookup failed with ${status}`)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('fails closed on an invalid commit', async () => {
    const fetchMock = githubSequence({ commit: { sha: 'invalid' } })
    await expect(checkAndRecover(FRIDAY_MORNING, 'test-token', fetchMock))
      .rejects.toThrow('invalid master commit SHA')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it.each([response(null, 204), response({}), response({ workflow_run_id: 123, html_url: 'test-token' })])(
    'rejects an obsolete or malformed successful dispatch response', async (dispatch) => {
      const fetchMock = githubSequence({ pagesRuns: [], dispatch })
      await expect(checkAndRecover(FRIDAY_MORNING, 'test-token', fetchMock)).rejects.toThrow(/GitHub/)
      expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    },
  )

  it('logs only a safe scheduled result and propagates sanitized failures', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal('fetch', githubSequence())
    await worker.scheduled({ scheduledTime: FRIDAY_MORNING.getTime() }, { GITHUB_ACTIONS_TOKEN: 'test-token' })
    expect(log).toHaveBeenCalledWith(JSON.stringify({ dispatch: false, reason: 'ready', sofiaDate: '2026-09-04' }))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('test-token')))
    await expect(worker.scheduled({ scheduledTime: FRIDAY_MORNING.getTime() }, { GITHUB_ACTIONS_TOKEN: 'test-token' }))
      .rejects.toThrow('GitHub request failed or timed out')
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('rejects missing credentials before networking', async () => {
    const fetchMock = vi.fn()
    await expect(checkAndRecover(FRIDAY_MORNING, '', fetchMock)).rejects.toThrow('GITHUB_ACTIONS_TOKEN is required')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
