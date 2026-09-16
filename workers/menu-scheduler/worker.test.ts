import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import workerConfig from './wrangler.json'
import worker, {
  checkAndRecover,
  createAppJwt,
  evaluateRecovery,
  MAX_FAILED_IMPORTS_FOR_PAGES_RECOVERY,
  MAX_FAILED_IMPORTS_PER_DAY,
  MAX_FAILED_PAGES_RUNS_PER_DAY,
  readAppConfig,
  type SchedulerEnv,
} from './worker.ts'

const HEAD_SHA = 'a'.repeat(40)
const FRIDAY_MORNING = new Date('2026-09-04T06:50:00Z')
// Shape of GitHub's variable-length stateless installation token format.
const INSTALLATION_TOKEN = 'ghs_1234567_eyJhbGciOiJFUzI1NiJ9.eyJpc3MiOiIxMjM0NTY3In0.c2lnbmF0dXJlLXZhbHVl'
const RUN_URL = 'https://github.com/Troi-0/mandarin-ordering/actions/runs/123'
const TOKEN_URL = 'https://api.github.com/app/installations/4242/access_tokens'
const DISPATCH_URL = 'https://api.github.com/repos/Troi-0/mandarin-ordering/actions/workflows/import-facebook.yml/dispatches'

interface Run { status: string; conclusion?: string | null; head_sha?: string }

let privateKeyPem = ''
let publicKey: CryptoKey

beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({
    name: 'RSASSA-PKCS1-v1_5',
    modulusLength: 2048,
    publicExponent: new Uint8Array([1, 0, 1]),
    hash: 'SHA-256',
  }, true, ['sign', 'verify']) as CryptoKeyPair
  const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', pair.privateKey) as ArrayBuffer)
  const body = btoa(String.fromCharCode(...der)).match(/.{1,64}/g)!.join('\n')
  privateKeyPem = `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`
  publicKey = pair.publicKey
})

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

function env(overrides: Partial<SchedulerEnv> = {}): SchedulerEnv {
  return {
    GITHUB_APP_CLIENT_ID: 'Iv23liTestClient01',
    GITHUB_APP_INSTALLATION_ID: '4242',
    GITHUB_REPOSITORY_ID: '1345231761',
    GITHUB_APP_PRIVATE_KEY_PKCS8: privateKeyPem,
    ...overrides,
  }
}

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

function tokenResponse(overrides: Record<string, unknown> = {}): Response {
  return response({
    token: INSTALLATION_TOKEN,
    expires_at: '2026-09-04T07:50:00Z',
    permissions: { actions: 'write', contents: 'read', metadata: 'read' },
    repository_selection: 'selected',
    repositories: [{ id: 1345231761, full_name: 'Troi-0/mandarin-ordering' }],
    ...overrides,
  }, 201)
}

function github(options: {
  menu?: unknown
  sha?: string
  token?: Response
  importerRuns?: Run[]
  completedImports?: Run[]
  pagesRuns?: Run[]
  completedPages?: Run[]
  dispatch?: Response
} = {}) {
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    const status = url.searchParams.get('status')
    if (url.href === TOKEN_URL) return options.token ?? tokenResponse()
    if (url.href === DISPATCH_URL) {
      if (!options.dispatch) throw new Error('Unexpected production dispatch')
      return options.dispatch
    }
    if (init?.method) throw new Error(`Unexpected ${init.method} ${url.href}`)
    if (url.pathname === '/repos/Troi-0/mandarin-ordering/commits/master') {
      return new Response(options.sha ?? HEAD_SHA)
    }
    if (url.pathname === '/repos/Troi-0/mandarin-ordering/contents/data/current-menu.json') {
      return response(options.menu ?? publication())
    }
    if (url.pathname.endsWith('/import-facebook.yml/runs')) {
      if (status === 'completed') return response({ workflow_runs: options.completedImports ?? [] })
      return response({ workflow_runs: (options.importerRuns ?? []).filter((run) => run.status === status) })
    }
    if (url.pathname.endsWith('/deploy-pages.yml/runs')) {
      if (status === 'completed') return response({ workflow_runs: options.completedPages ?? [] })
      const runs = options.pagesRuns ?? [{ status: 'completed', conclusion: 'success', head_sha: HEAD_SHA }]
      return response({ workflow_runs: runs.filter((run) => (status === 'success'
        ? run.conclusion === 'success' && run.head_sha === url.searchParams.get('head_sha')
        : run.status === status)) })
    }
    throw new Error(`Unexpected GitHub request ${url.href}`)
  })
}

function calls(fetchMock: ReturnType<typeof github>) {
  return fetchMock.mock.calls.map(([input, init]) => ({ url: new URL(String(input)), init }))
}

function authorization(init?: RequestInit): string | undefined {
  return (init?.headers as Record<string, string> | undefined)?.authorization
}

function decodeJwtPart(part: string): unknown {
  return JSON.parse(atob(part.replaceAll('-', '+').replaceAll('_', '/')))
}

function expandCron(expression: string, day: string): Date[] {
  const [minutes, hours] = expression.split(' ')
  const [firstHour, lastHour] = hours!.split('-').map(Number)
  const instants: Date[] = []
  for (let hour = firstHour!; hour <= lastHour!; hour += 1) {
    for (const minute of minutes!.split(',').map(Number)) {
      instants.push(new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`))
    }
  }
  return instants
}

const sofiaTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Europe/Sofia', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
})

function decisionAt(now: Date, overrides: Partial<Parameters<typeof evaluateRecovery>[0]> = {}) {
  return evaluateRecovery({
    publication: null, headSha: HEAD_SHA, importerRuns: [], pagesRuns: [], failedImportsToday: 0, failedPagesToday: 0, now, ...overrides,
  })
}

describe('Cloudflare menu scheduler configuration', () => {
  it('has only a weekday Cron Trigger, required secret, full observability, and no public route', () => {
    expect(workerConfig).toMatchObject({
      workers_dev: false,
      preview_urls: false,
      upload_source_maps: true,
      triggers: { crons: ['7,22,37,52 5-11 * * MON-FRI'] },
      secrets: { required: ['GITHUB_APP_PRIVATE_KEY_PKCS8'] },
      observability: {
        enabled: true,
        logs: { enabled: true, head_sampling_rate: 1, invocation_logs: true },
        traces: { enabled: true, head_sampling_rate: 1 },
      },
    })
    for (const key of ['routes', 'route', 'limits', 'kv_namespaces', 'd1_databases', 'r2_buckets']) {
      expect(workerConfig).not.toHaveProperty(key)
    }
    expect(Object.keys(worker)).toEqual(['scheduled'])
  })

  it('commits deployable, non-secret GitHub App identifiers', () => {
    expect(workerConfig.vars.GITHUB_REPOSITORY_ID).toBe('1345231761')
    expect(() => readAppConfig({ ...workerConfig.vars, GITHUB_APP_PRIVATE_KEY_PKCS8: 'stored only in Cloudflare' }))
      .not.toThrow()
  })

  it.each([
    ['summer', '2026-09-04'],
    ['winter', '2026-12-04'],
  ])('covers 08:37-13:52 Sofia with the UTC Cron in %s', (_, day) => {
    const instants = expandCron(workerConfig.triggers.crons[0]!, day)
    const eligible = instants.filter((now) => decisionAt(now).reason !== 'outside-window')
    expect(instants).toHaveLength(28)
    expect(eligible).toHaveLength(22)
    expect(sofiaTime.format(eligible[0])).toBe('08:37')
    expect(sofiaTime.format(eligible.at(-1))).toBe('13:52')
  })
})

describe('Sofia recovery window', () => {
  it.each([
    ['2026-09-04T05:36:59Z', false], ['2026-09-04T05:37:00Z', true],
    ['2026-09-04T10:59:59Z', true], ['2026-09-04T11:00:00Z', false],
    ['2026-12-04T06:36:59Z', false], ['2026-12-04T06:37:00Z', true],
    ['2026-12-04T11:59:59Z', true], ['2026-12-04T12:00:00Z', false],
    // Sofia changes offset on Sunday nights: check the weekdays either side.
    ['2026-03-27T06:37:00Z', true], ['2026-03-27T05:37:00Z', false],
    ['2026-03-30T05:37:00Z', true], ['2026-03-30T05:36:00Z', false],
    ['2026-10-23T05:37:00Z', true], ['2026-10-23T05:36:00Z', false],
    ['2026-10-26T06:37:00Z', true], ['2026-10-26T05:37:00Z', false],
    ['2026-09-05T08:00:00Z', false], ['2026-09-06T08:00:00Z', false],
  ])('at %s dispatch is %s for a stale menu', (timestamp, dispatch) => {
    expect(decisionAt(new Date(timestamp)).dispatch).toBe(dispatch)
  })

  it('does not accept a successful deployment of another commit', () => {
    expect(decisionAt(FRIDAY_MORNING, {
      publication: publication(),
      pagesRuns: [{ status: 'completed', conclusion: 'success', head_sha: 'b'.repeat(40) }],
    })).toMatchObject({ dispatch: true, reason: 'pages-missing' })
  })

  it('stops importing a missing menu after the daily failure cap', () => {
    expect(decisionAt(FRIDAY_MORNING, { failedImportsToday: MAX_FAILED_IMPORTS_PER_DAY - 1 }))
      .toMatchObject({ dispatch: true, reason: 'stale' })
    expect(decisionAt(FRIDAY_MORNING, { failedImportsToday: MAX_FAILED_IMPORTS_PER_DAY }))
      .toMatchObject({ dispatch: false, reason: 'attempts-exhausted' })
    // Pages failures belong to the other budget and must not unblock or block imports.
    expect(decisionAt(FRIDAY_MORNING, { failedPagesToday: MAX_FAILED_PAGES_RUNS_PER_DAY }))
      .toMatchObject({ dispatch: true, reason: 'stale' })
  })

  it('still recovers a missing Pages deployment after the import budget is spent', () => {
    const readyMenu = { publication: publication(), pagesRuns: [] }
    expect(decisionAt(FRIDAY_MORNING, { ...readyMenu, failedImportsToday: MAX_FAILED_IMPORTS_PER_DAY }))
      .toMatchObject({ dispatch: true, reason: 'pages-missing' })
    expect(decisionAt(FRIDAY_MORNING, { ...readyMenu, failedImportsToday: MAX_FAILED_IMPORTS_FOR_PAGES_RECOVERY - 1 }))
      .toMatchObject({ dispatch: true, reason: 'pages-missing' })
    expect(decisionAt(FRIDAY_MORNING, { ...readyMenu, failedPagesToday: MAX_FAILED_PAGES_RUNS_PER_DAY - 1 }))
      .toMatchObject({ dispatch: true, reason: 'pages-missing' })
  })

  it('bounds Pages recovery so a broken deployment cannot loop all day', () => {
    const readyMenu = { publication: publication(), pagesRuns: [] }
    expect(decisionAt(FRIDAY_MORNING, { ...readyMenu, failedPagesToday: MAX_FAILED_PAGES_RUNS_PER_DAY }))
      .toMatchObject({ dispatch: false, reason: 'pages-attempts-exhausted' })
    expect(decisionAt(FRIDAY_MORNING, { ...readyMenu, failedImportsToday: MAX_FAILED_IMPORTS_FOR_PAGES_RECOVERY }))
      .toMatchObject({ dispatch: false, reason: 'pages-attempts-exhausted' })
    expect(MAX_FAILED_IMPORTS_FOR_PAGES_RECOVERY).toBeGreaterThan(MAX_FAILED_IMPORTS_PER_DAY)
  })

  it('reports a verified publication as ready whatever either budget says', () => {
    expect(decisionAt(FRIDAY_MORNING, {
      publication: publication(),
      pagesRuns: [{ status: 'completed', conclusion: 'success', head_sha: HEAD_SHA }],
      failedImportsToday: MAX_FAILED_IMPORTS_FOR_PAGES_RECOVERY,
      failedPagesToday: MAX_FAILED_PAGES_RUNS_PER_DAY,
    })).toMatchObject({ dispatch: false, reason: 'ready' })
  })
})

describe('GitHub App authentication', () => {
  it('signs a short-lived RS256 JWT with the client ID as issuer', async () => {
    const now = new Date('2026-09-04T06:50:30Z')
    const [header, payload, signature] = (await createAppJwt('Iv23liTestClient01', privateKeyPem, now)).split('.')
    expect(decodeJwtPart(header!)).toEqual({ alg: 'RS256', typ: 'JWT' })
    const nowSeconds = now.getTime() / 1_000
    expect(decodeJwtPart(payload!)).toEqual({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: 'Iv23liTestClient01' })
    const signatureBytes = Uint8Array.from(
      atob(signature!.replaceAll('-', '+').replaceAll('_', '/')), (character) => character.charCodeAt(0),
    )
    await expect(crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5', publicKey, signatureBytes, new TextEncoder().encode(`${header}.${payload}`),
    )).resolves.toBe(true)
  })

  it('requests a token scoped to this repository, Actions write, and Contents read', async () => {
    const fetchMock = github()
    const wallClock = new Date('2026-09-04T06:50:02Z')
    await checkAndRecover(FRIDAY_MORNING, env(), fetchMock, () => wallClock)

    const [mint, ...rest] = calls(fetchMock)
    expect(mint!.url.href).toBe(TOKEN_URL)
    expect(mint!.init).toMatchObject({ method: 'POST', headers: { 'x-github-api-version': '2026-03-10' } })
    expect(JSON.parse(String(mint!.init?.body))).toEqual({
      repository_ids: [1345231761],
      permissions: { actions: 'write', contents: 'read' },
    })
    const jwt = String(authorization(mint!.init)).replace('Bearer ', '')
    expect(decodeJwtPart(jwt.split('.')[1]!)).toMatchObject({ iat: wallClock.getTime() / 1_000 - 60 })
    expect(rest.every(({ init }) => authorization(init) === `Bearer ${INSTALLATION_TOKEN}`)).toBe(true)
  })

  it.each([
    ['a missing client ID', { GITHUB_APP_CLIENT_ID: '' }, 'GITHUB_APP_CLIENT_ID must be a GitHub App client ID'],
    ['a placeholder installation', { GITHUB_APP_INSTALLATION_ID: 'REPLACE_ME' }, 'GITHUB_APP_INSTALLATION_ID must be a positive integer'],
    ['an unsafe repository ID', { GITHUB_REPOSITORY_ID: '9007199254740993' }, 'GITHUB_REPOSITORY_ID must be a positive integer'],
    ['a missing key', { GITHUB_APP_PRIVATE_KEY_PKCS8: ' ' }, 'GITHUB_APP_PRIVATE_KEY_PKCS8 is required'],
  ])('rejects %s before networking, even outside the window', async (_, overrides, message) => {
    const fetchMock = vi.fn()
    await expect(checkAndRecover(new Date('2026-09-05T08:00:00Z'), env(overrides), fetchMock)).rejects.toThrow(message)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['PKCS#1', '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----', 'is PKCS#1'],
    ['encrypted', '-----BEGIN ENCRYPTED PRIVATE KEY-----\nMIIE\n-----END ENCRYPTED PRIVATE KEY-----', 'unencrypted PKCS#8'],
    ['corrupt', '-----BEGIN PRIVATE KEY-----\nbm90IGEga2V5\n-----END PRIVATE KEY-----', 'could not be imported'],
  ])('rejects a %s private key without echoing it', async (_, key, message) => {
    const fetchMock = vi.fn()
    const failure = checkAndRecover(FRIDAY_MORNING, env({ GITHUB_APP_PRIVATE_KEY_PKCS8: key }), fetchMock)
    await expect(failure).rejects.toThrow(message)
    await expect(failure).rejects.not.toThrow(/MIIE|bm90/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    ['a non-201 status', response({ message: INSTALLATION_TOKEN }, 401), 'installation token failed with 401'],
    ['invalid JSON', new Response('{', { status: 201 }), 'invalid JSON'],
    ['a header-injecting token', tokenResponse({ token: 'ghs_abcdefghijklmnopqrstuvwxyz\r\nx-evil: 1' }), 'invalid installation token'],
    ['a missing token', tokenResponse({ token: undefined }), 'invalid installation token'],
    ['broader permissions', tokenResponse({ permissions: { actions: 'write', contents: 'write' } }), 'unexpected permissions'],
    ['extra permissions', tokenResponse({ permissions: { actions: 'write', contents: 'read', workflows: 'write' } }), 'unexpected permissions'],
    ['missing permissions', tokenResponse({ permissions: null }), 'unexpected permissions'],
    ['another repository', tokenResponse({ repositories: [{ id: 1 }] }), 'unexpected repository access'],
    ['all repositories', tokenResponse({ repositories: undefined, repository_selection: 'all' }), 'unexpected repository access'],
  ])('fails closed on %s from the token endpoint', async (_, token, message) => {
    const fetchMock = github({ token })
    const failure = checkAndRecover(FRIDAY_MORNING, env(), fetchMock)
    await expect(failure).rejects.toThrow(message)
    await expect(failure).rejects.not.toThrow(INSTALLATION_TOKEN)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('menu recovery against GitHub', () => {
  it('does not call GitHub outside the recovery window', async () => {
    const fetchMock = vi.fn()
    await expect(checkAndRecover(new Date('2026-09-05T06:50:00Z'), env(), fetchMock))
      .resolves.toMatchObject({ dispatch: false, reason: 'outside-window' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reads the menu at the immutable master SHA and does nothing when Pages matches it', async () => {
    const fetchMock = github()
    await expect(checkAndRecover(FRIDAY_MORNING, env(), fetchMock))
      .resolves.toEqual({ dispatch: false, reason: 'ready', sofiaDate: '2026-09-04' })

    const requests = calls(fetchMock)
    expect(requests).toHaveLength(16)
    expect(requests.every(({ url }) => url.origin === 'https://api.github.com')).toBe(true)
    const commit = requests.find(({ url }) => url.pathname.endsWith('/commits/master'))!
    expect(commit.init?.headers).toMatchObject({ accept: 'application/vnd.github.sha' })
    const menu = requests.find(({ url }) => url.pathname.endsWith('/contents/data/current-menu.json'))!
    expect(menu.url.searchParams.get('ref')).toBe(HEAD_SHA)
    expect(menu.init?.headers).toMatchObject({ accept: 'application/vnd.github.raw+json' })
    const exactPages = requests.find(({ url }) => url.searchParams.get('status') === 'success')!
    expect(Object.fromEntries(exactPages.url.searchParams)).toEqual({
      branch: 'master', status: 'success', head_sha: HEAD_SHA, per_page: '1',
    })
    expect(requests.every(({ init }) => init?.signal instanceof AbortSignal)).toBe(true)
  })

  it.each([
    ['summer', FRIDAY_MORNING, '2026-09-04', '>=2026-09-04T00:00:00+03:00'],
    ['winter', new Date('2026-12-04T07:50:00Z'), '2026-12-04', '>=2026-12-04T00:00:00+02:00'],
  ])('counts only today’s importer and Pages runs from Sofia midnight in %s', async (_, now, date, created) => {
    const fetchMock = github({ menu: publication(date) })
    await expect(checkAndRecover(now, env(), fetchMock)).resolves.toMatchObject({ reason: 'ready' })
    for (const workflow of ['import-facebook.yml', 'deploy-pages.yml']) {
      const completed = calls(fetchMock).find(({ url }) => (
        url.pathname.endsWith(`/${workflow}/runs`) && url.searchParams.get('status') === 'completed'
      ))!
      expect(Object.fromEntries(completed.url.searchParams)).toEqual({
        branch: 'master', status: 'completed', created, per_page: '100',
      })
      expect(completed.url.search).toContain('%2B0')
    }
  })

  it('does not duplicate an active importer', async () => {
    const fetchMock = github({ menu: publication('2026-09-03'), importerRuns: [{ status: 'in_progress' }] })
    await expect(checkAndRecover(FRIDAY_MORNING, env(), fetchMock))
      .resolves.toMatchObject({ dispatch: false, reason: 'import-active' })
  })

  it.each(['queued', 'in_progress', 'waiting', 'pending', 'requested'])(
    'finds an older %s importer despite newer completed runs', async (status) => {
      const fetchMock = github({ importerRuns: [
        ...Array.from({ length: 20 }, () => ({ status: 'completed' })), { status },
      ] })
      await expect(checkAndRecover(FRIDAY_MORNING, env(), fetchMock))
        .resolves.toMatchObject({ dispatch: false, reason: 'import-active' })
    },
  )

  it.each(['2026-09-04', '2026-09-03'])('waits for active Pages even with menu date %s', async (date) => {
    const fetchMock = github({
      menu: publication(date),
      pagesRuns: [{ status: 'in_progress', conclusion: null, head_sha: HEAD_SHA }],
    })
    await expect(checkAndRecover(FRIDAY_MORNING, env(), fetchMock))
      .resolves.toMatchObject({ dispatch: false, reason: 'pages-active' })
  })

  it.each([
    ['stale', { menu: publication('2026-09-03') }],
    ['pages-missing', { pagesRuns: [] }],
  ])('dispatches the importer with the installation token for %s', async (reason, options) => {
    const fetchMock = github({
      ...options,
      completedImports: [
        { status: 'completed', conclusion: 'failure' },
        { status: 'completed', conclusion: 'cancelled' },
        { status: 'completed', conclusion: 'success' },
      ],
      dispatch: response({ workflow_run_id: 123, html_url: RUN_URL }),
    })

    await expect(checkAndRecover(FRIDAY_MORNING, env(), fetchMock)).resolves.toEqual({
      dispatch: true, reason, sofiaDate: '2026-09-04', runUrl: RUN_URL,
    })
    const requests = calls(fetchMock)
    expect(requests).toHaveLength(17)
    const dispatch = requests.at(-1)!
    expect(dispatch.url.href).toBe(DISPATCH_URL)
    expect(dispatch.init).toMatchObject({
      method: 'POST',
      headers: { authorization: `Bearer ${INSTALLATION_TOKEN}`, 'x-github-api-version': '2026-03-10' },
    })
    expect(JSON.parse(String(dispatch.init?.body))).toEqual({ ref: 'master', inputs: { dry_run: 'false' } })
  })

  it('stops after today’s failed, timed-out, and startup-failed imports', async () => {
    const fetchMock = github({
      menu: publication('2026-09-03'),
      completedImports: ['failure', 'timed_out', 'startup_failure'].map((conclusion) => ({ status: 'completed', conclusion })),
    })
    await expect(checkAndRecover(FRIDAY_MORNING, env(), fetchMock))
      .resolves.toMatchObject({ dispatch: false, reason: 'attempts-exhausted' })
    expect(calls(fetchMock).some(({ url }) => url.href === DISPATCH_URL)).toBe(false)
  })

  it('redeploys a ready menu after three failed imports, then stops on three failed Pages runs', async () => {
    const failedImports = ['failure', 'timed_out', 'startup_failure'].map((conclusion) => ({ status: 'completed', conclusion }))
    const recovering = github({
      pagesRuns: [],
      completedImports: failedImports,
      completedPages: [{ status: 'completed', conclusion: 'failure' }, { status: 'completed', conclusion: 'cancelled' }],
      dispatch: response({ workflow_run_id: 123, html_url: RUN_URL }),
    })
    await expect(checkAndRecover(FRIDAY_MORNING, env(), recovering))
      .resolves.toMatchObject({ dispatch: true, reason: 'pages-missing', runUrl: RUN_URL })

    const exhausted = github({
      pagesRuns: [],
      completedImports: failedImports,
      completedPages: ['failure', 'timed_out', 'failure'].map((conclusion) => ({ status: 'completed', conclusion })),
    })
    await expect(checkAndRecover(FRIDAY_MORNING, env(), exhausted))
      .resolves.toMatchObject({ dispatch: false, reason: 'pages-attempts-exhausted' })
    expect(calls(exhausted).some(({ url }) => url.href === DISPATCH_URL)).toBe(false)
  })

  it('surfaces a failed dispatch for Cloudflare observability', async () => {
    const fetchMock = github({ menu: publication('2026-09-03'), dispatch: response({ message: 'forbidden' }, 403) })
    await expect(checkAndRecover(FRIDAY_MORNING, env(), fetchMock)).rejects.toThrow('workflow dispatch failed with 403')
  })

  it.each([response(null, 204), response({}), response({ workflow_run_id: 123, html_url: INSTALLATION_TOKEN })])(
    'rejects an obsolete or malformed successful dispatch response', async (dispatch) => {
      const fetchMock = github({ pagesRuns: [], dispatch })
      await expect(checkAndRecover(FRIDAY_MORNING, env(), fetchMock)).rejects.toThrow(/GitHub/)
      expect(calls(fetchMock).filter(({ url }) => url.href === DISPATCH_URL)).toHaveLength(1)
    },
  )

  it.each([401, 403, 429, 500])('fails closed on a %s lookup without exposing response bodies', async (status) => {
    const base = github()
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => (
      String(input).includes('/commits/') ? response({ message: INSTALLATION_TOKEN }, status) : base(input, init)
    ))
    const failure = checkAndRecover(FRIDAY_MORNING, env(), fetchMock)
    await expect(failure).rejects.toThrow(`GitHub lookup failed with ${status}`)
    await expect(failure).rejects.not.toThrow(INSTALLATION_TOKEN)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each(['invalid', `${HEAD_SHA}\n${HEAD_SHA}`, 'A'.repeat(40)])('fails closed on an invalid commit %j', async (sha) => {
    const fetchMock = github({ sha })
    await expect(checkAndRecover(FRIDAY_MORNING, env(), fetchMock)).rejects.toThrow('invalid master commit SHA')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['a menu that is not JSON', (url: URL) => url.pathname.endsWith('.json') && new Response('<html>'), 'invalid JSON'],
    ['a runs payload without runs', (url: URL) => url.pathname.endsWith('/runs') && response({}), 'invalid workflow-runs response'],
    ['a run without status', (url: URL) => url.pathname.endsWith('/runs') && response({ workflow_runs: [{}] }), 'invalid workflow run'],
    ['a timed-out request', (url: URL) => url.pathname.endsWith('/runs') && Promise.reject(new DOMException('timeout', 'TimeoutError')), 'failed or timed out'],
  ])('fails closed on %s', async (_, override, message) => {
    const base = github()
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => (
      await override(new URL(String(input))) || base(input, init)
    ))
    await expect(checkAndRecover(FRIDAY_MORNING, env(), fetchMock)).rejects.toThrow(message)
  })

  it('fails closed when a commit body cannot be read', async () => {
    const base = github()
    const unreadable = new Response('x')
    vi.spyOn(unreadable, 'text').mockRejectedValue(new Error(INSTALLATION_TOKEN))
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => (
      String(input).includes('/commits/') ? unreadable : base(input, init)
    ))
    await expect(checkAndRecover(FRIDAY_MORNING, env(), fetchMock)).rejects.toThrow('GitHub response could not be read')
  })
})

describe('scheduled handler', () => {
  it('logs only a structured, credential-free result', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal('fetch', github({
      menu: publication('2026-09-03'),
      dispatch: response({ workflow_run_id: 123, html_url: RUN_URL }),
    }))

    await worker.scheduled({ scheduledTime: FRIDAY_MORNING.getTime() }, env())

    expect(log).toHaveBeenCalledTimes(1)
    const line = String(log.mock.calls[0]![0])
    expect(JSON.parse(line)).toEqual({
      event: 'menu-scheduler',
      scheduledTime: '2026-09-04T06:50:00.000Z',
      sofiaDate: '2026-09-04',
      outcome: 'ok',
      reason: 'stale',
      dispatch: true,
      runUrl: RUN_URL,
      durationMs: expect.any(Number),
    })
    expect(line).not.toContain(INSTALLATION_TOKEN)
    expect(line).not.toContain('eyJ')
  })

  it('logs and rethrows a sanitized failure', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(INSTALLATION_TOKEN)))

    await expect(worker.scheduled({ scheduledTime: FRIDAY_MORNING.getTime() }, env()))
      .rejects.toThrow('GitHub request failed or timed out')
    const line = String(error.mock.calls[0]![0])
    expect(JSON.parse(line)).toEqual({
      event: 'menu-scheduler',
      scheduledTime: '2026-09-04T06:50:00.000Z',
      sofiaDate: '2026-09-04',
      outcome: 'error',
      error: 'GitHub request failed or timed out',
      durationMs: expect.any(Number),
    })
    expect(line).not.toContain(INSTALLATION_TOKEN)
  })

  it('replaces unexpected errors that could carry sensitive text', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const leakyEnv = new Proxy(env(), {
      get() { throw new TypeError(`leaked ${INSTALLATION_TOKEN}`) },
    })
    const failure = worker.scheduled({ scheduledTime: FRIDAY_MORNING.getTime() }, leakyEnv)
    await expect(failure).rejects.toThrow('Unexpected scheduler failure')
    await expect(failure).rejects.not.toThrow(INSTALLATION_TOKEN)
    expect(String(error.mock.calls[0]![0])).not.toContain(INSTALLATION_TOKEN)
  })
})
