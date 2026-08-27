import { describe, expect, it } from 'vitest'
import { createValidMenuFixture } from '../../src/test/menu-fixture.ts'
import { reconcilePagesDeployment } from './pages-reconciliation.ts'

const SHA = 'a'.repeat(40)
const NOW = new Date('2026-08-26T09:00:00Z')

function readyPublication(date = '2026-08-26') {
  const menu = createValidMenuFixture()
  menu.date = date
  return { status: 'ready' as const, menu }
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function fetchSequence(steps: Array<Response | Error>) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const fetchImpl = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init })
    const next = steps.shift()
    if (!next) throw new Error('Unexpected fetch call')
    if (next instanceof Error) throw next
    return next
  }
  return { fetchImpl: fetchImpl as typeof fetch, calls }
}

function options(fetchImpl: typeof fetch) {
  return {
    repository: 'Troi-0/mandarin-ordering',
    token: 'test-token',
    headSha: SHA,
    publication: readyPublication(),
    now: NOW,
    fetchImpl,
  }
}

describe('Pages deployment reconciliation', () => {
  it('does not dispatch when this exact commit already has a successful Pages run', async () => {
    const mock = fetchSequence([
      jsonResponse({ workflow_runs: [{ head_sha: SHA, conclusion: 'success' }] }),
    ])

    await expect(reconcilePagesDeployment(options(mock.fetchImpl))).resolves.toEqual({
      status: 'already-deployed',
      menuDate: '2026-08-26',
      headSha: SHA,
    })
    expect(mock.calls).toHaveLength(1)
    expect(mock.calls[0].url).toContain('actions/workflows/deploy-pages.yml/runs?')
    expect(mock.calls[0].url).toContain(`head_sha=${SHA}`)
  })

  it('dispatches when the current commit has no successful Pages run', async () => {
    const mock = fetchSequence([jsonResponse({ workflow_runs: [] }), new Response(null, { status: 204 })])

    await expect(reconcilePagesDeployment(options(mock.fetchImpl))).resolves.toMatchObject({
      status: 'dispatched',
    })
    expect(mock.calls).toHaveLength(2)
    expect(mock.calls[1]).toMatchObject({
      url: 'https://api.github.com/repos/Troi-0/mandarin-ordering/dispatches',
      init: { method: 'POST' },
    })
    expect(JSON.parse(String(mock.calls[1].init?.body))).toEqual({
      event_type: 'menu-published',
      client_payload: { menu_date: '2026-08-26', menu_commit: SHA },
    })
  })

  it('dispatches rather than falsely skipping when the status lookup fails', async () => {
    const mock = fetchSequence([
      jsonResponse({ message: 'temporary failure' }, 500),
      new Response(null, { status: 204 }),
    ])
    const logs: string[] = []

    await expect(reconcilePagesDeployment({
      ...options(mock.fetchImpl),
      log: (message) => logs.push(message),
    })).resolves.toMatchObject({ status: 'dispatched' })
    expect(logs[0]).toContain('dispatching to avoid a false skip')
  })

  it('retries transient dispatch failures with bounded delays', async () => {
    const mock = fetchSequence([
      jsonResponse({ workflow_runs: [] }),
      jsonResponse({ message: 'server error' }, 500),
      new Error('socket reset'),
      new Response(null, { status: 204 }),
    ])
    const sleeps: number[] = []

    await expect(reconcilePagesDeployment({
      ...options(mock.fetchImpl),
      sleep: async (milliseconds) => { sleeps.push(milliseconds) },
    })).resolves.toMatchObject({ status: 'dispatched' })
    expect(sleeps).toEqual([2_000, 8_000])
    expect(mock.calls).toHaveLength(4)
  })

  it('honors a short GitHub Retry-After value before retrying', async () => {
    const mock = fetchSequence([
      jsonResponse({ workflow_runs: [] }),
      new Response(JSON.stringify({ message: 'rate limited' }), {
        status: 429,
        headers: { 'retry-after': '3' },
      }),
      new Response(null, { status: 204 }),
    ])
    const sleeps: number[] = []

    await reconcilePagesDeployment({
      ...options(mock.fetchImpl),
      sleep: async (milliseconds) => { sleeps.push(milliseconds) },
    })
    expect(sleeps).toEqual([3_000])
  })

  it('defers long rate-limit waits to a later schedule instead of retrying too early', async () => {
    const mock = fetchSequence([
      jsonResponse({ workflow_runs: [] }),
      new Response(JSON.stringify({ message: 'rate limited' }), {
        status: 429,
        headers: { 'retry-after': '120' },
      }),
    ])

    await expect(reconcilePagesDeployment(options(mock.fetchImpl))).rejects.toThrow(
      'a later scheduled import will retry',
    )
    expect(mock.calls).toHaveLength(2)
  })

  it('defers a secondary rate limit without retry headers to the next schedule', async () => {
    const mock = fetchSequence([
      jsonResponse({ workflow_runs: [] }),
      jsonResponse({ message: 'You have exceeded a secondary rate limit' }, 403),
    ])

    await expect(reconcilePagesDeployment(options(mock.fetchImpl))).rejects.toThrow(
      'a later scheduled import will retry',
    )
    expect(mock.calls).toHaveLength(2)
  })

  it('does not retry permanent dispatch failures', async () => {
    const mock = fetchSequence([
      jsonResponse({ workflow_runs: [] }),
      jsonResponse({ message: 'bad credentials' }, 401),
    ])
    const sleeps: number[] = []

    await expect(reconcilePagesDeployment({
      ...options(mock.fetchImpl),
      sleep: async (milliseconds) => { sleeps.push(milliseconds) },
    })).rejects.toThrow('GitHub deployment dispatch failed with 401')
    expect(sleeps).toEqual([])
    expect(mock.calls).toHaveLength(2)
  })

  it('fails after the bounded number of transient dispatch attempts', async () => {
    const mock = fetchSequence([
      jsonResponse({ workflow_runs: [] }),
      jsonResponse({ message: 'server error' }, 500),
      jsonResponse({ message: 'server error' }, 502),
      jsonResponse({ message: 'server error' }, 503),
    ])
    const sleeps: number[] = []

    await expect(reconcilePagesDeployment({
      ...options(mock.fetchImpl),
      sleep: async (milliseconds) => { sleeps.push(milliseconds) },
    })).rejects.toThrow('GitHub deployment dispatch failed with 503')
    expect(sleeps).toEqual([2_000, 8_000])
    expect(mock.calls).toHaveLength(4)
  })

  it('rejects stale or unavailable publication data before calling GitHub', async () => {
    const stale = fetchSequence([])
    await expect(reconcilePagesDeployment({
      ...options(stale.fetchImpl),
      publication: readyPublication('2026-08-25'),
    })).rejects.toThrow('requires a ready menu for today')
    expect(stale.calls).toEqual([])

    const unavailable = fetchSequence([])
    await expect(reconcilePagesDeployment({
      ...options(unavailable.fetchImpl),
      publication: { status: 'unavailable', reason: 'not-posted' },
    })).rejects.toThrow('requires a ready menu for today')
    expect(unavailable.calls).toEqual([])
  })
})
