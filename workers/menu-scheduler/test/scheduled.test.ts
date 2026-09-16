import { createScheduledController, env } from 'cloudflare:test'
import { afterEach, describe, expect, it, vi } from 'vitest'
import worker from '../worker.ts'

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_GITHUB_APP_PUBLIC_KEY_SPKI: string
    }
  }
}

const HEAD_SHA = 'c'.repeat(40)
const TOKEN = 'ghs_7654321_eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiI3NjU0MzIxIn0.d29ya2VyZA'
const RUN_URL = 'https://github.com/Troi-0/mandarin-ordering/actions/runs/987'

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

async function verifyJwt(jwt: string): Promise<Record<string, unknown>> {
  const [header, payload, signature] = jwt.split('.')
  const decode = (part: string) => Uint8Array.from(
    atob(part.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0),
  )
  const spki = decode(env.TEST_GITHUB_APP_PUBLIC_KEY_SPKI.replace(/-----[A-Z ]+-----|\s+/g, ''))
  const key = await crypto.subtle.importKey('spki', spki, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
  const valid = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5', key, decode(signature!), new TextEncoder().encode(`${header}.${payload}`),
  )
  expect(valid).toBe(true)
  return JSON.parse(new TextDecoder().decode(decode(payload!)))
}

afterEach(() => { vi.restoreAllMocks() })

describe('scheduled handler in workerd', () => {
  it('runs in workerd with the committed configuration and the required secret', () => {
    expect(navigator.userAgent).toBe('Cloudflare-Workers')
    expect(env.GITHUB_REPOSITORY_ID).toBe('1345231761')
    expect(env.GITHUB_APP_PRIVATE_KEY_PKCS8).toContain('BEGIN PRIVATE KEY')
  })

  it('signs with WebCrypto, reads GitHub, and dispatches a stale menu import', async () => {
    const requests: { url: URL; init?: RequestInit }[] = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input))
      requests.push({ url, init })
      if (url.pathname === '/app/installations/4242/access_tokens') {
        return json({
          token: TOKEN,
          permissions: { actions: 'write', contents: 'read', metadata: 'read' },
          repositories: [{ id: 1345231761 }],
        }, 201)
      }
      if (url.pathname.endsWith('/commits/master')) return new Response(HEAD_SHA)
      if (url.pathname.endsWith('/contents/data/current-menu.json')) {
        return json({ status: 'ready', menu: { date: '2026-09-03', currency: 'EUR', categories: [] } })
      }
      if (url.pathname.endsWith('/runs')) return json({ workflow_runs: [] })
      if (url.pathname.endsWith('/dispatches')) return json({ workflow_run_id: 987, html_url: RUN_URL })
      throw new Error(`Unexpected request ${url.href}`)
    })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})

    // Friday 2026-09-04 09:52 Sofia (summer time).
    const controller = createScheduledController({ scheduledTime: Date.parse('2026-09-04T06:52:00Z'), cron: '7,22,37,52 5-11 * * MON-FRI' })
    await worker.scheduled(controller, env)

    expect(requests).toHaveLength(17)
    const headers = requests[0]!.init?.headers as Record<string, string> | undefined
    const jwt = String(headers?.authorization).replace('Bearer ', '')
    await expect(verifyJwt(jwt)).resolves.toMatchObject({ iss: 'Iv23liTestClient01' })
    const completed = requests.find(({ url }) => url.searchParams.get('status') === 'completed')!
    // Proves workerd's ICU resolves the Sofia offset used for the failure cap.
    expect(completed.url.searchParams.get('created')).toBe('>=2026-09-04T00:00:00+03:00')
    expect(requests.every(({ init }) => init?.signal instanceof AbortSignal)).toBe(true)
    expect(JSON.parse(String(log.mock.calls[0]![0]))).toMatchObject({
      outcome: 'ok', sofiaDate: '2026-09-04', reason: 'stale', dispatch: true, runUrl: RUN_URL,
    })
    expect(String(log.mock.calls[0]![0])).not.toContain(TOKEN)
  })

  it('makes no network request outside the Sofia window', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    vi.spyOn(console, 'log').mockImplementation(() => {})
    // Monday 2026-12-07 07:07 Sofia (winter time): before the 08:37 opening.
    await worker.scheduled(createScheduledController({ scheduledTime: Date.parse('2026-12-07T05:07:00Z') }), env)
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
