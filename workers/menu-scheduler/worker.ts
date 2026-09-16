const REPOSITORY = 'Troi-0/mandarin-ordering'
const BRANCH = 'master'
const IMPORT_WORKFLOW = 'import-facebook.yml'
const PAGES_WORKFLOW = 'deploy-pages.yml'
const MENU_PATH = 'data/current-menu.json'
const GITHUB_API = 'https://api.github.com'
const API_VERSION = '2026-03-10'
const SOFIA_TIME_ZONE = 'Europe/Sofia'
const ACTIVE_RUN_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested'])
const FAILED_CONCLUSIONS = new Set(['failure', 'timed_out', 'startup_failure'])
const REQUEST_TIMEOUT_MS = 15_000
// Every archived menu was posted at 08:30:0x Sofia, so an earlier dispatch can
// only report that no post exists yet.
const WINDOW_OPENS_AT_MINUTE = 8 * 60 + 37
const WINDOW_CLOSES_AT_MINUTE = 14 * 60
// A persistent Facebook or OCR failure must not become an all-day retry storm
// of Playwright scrapes, free Gemini calls, and review-draft commits.
export const MAX_FAILED_IMPORTS_PER_DAY = 3
// Recovering a missing Pages deployment never scrapes or transcribes: the
// importer sees today's ready menu and only reconciles. It therefore keeps its
// own budget after imports are exhausted, bounded by failed Pages runs and a
// hard ceiling on importer failures so a broken deploy cannot loop all day.
export const MAX_FAILED_PAGES_RUNS_PER_DAY = 3
export const MAX_FAILED_IMPORTS_FOR_PAGES_RECOVERY = 6
const TOKEN_PERMISSIONS = { actions: 'write', contents: 'read' } as const
// JWT issued-at is backdated for clock drift; GitHub rejects exp beyond 10 minutes.
const JWT_BACKDATE_SECONDS = 60
const JWT_LIFETIME_SECONDS = 540
// RFC 6750 b64token. Installation tokens are variable-length since GitHub's
// stateless ghs_APPID_JWT rollout, so never assume the old 40-character shape.
const BEARER_TOKEN = /^[A-Za-z0-9\-._~+/]{20,8192}=*$/
const SOFIA_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: SOFIA_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
  timeZoneName: 'longOffset',
})

export interface SchedulerEnv {
  GITHUB_APP_CLIENT_ID: string
  GITHUB_APP_INSTALLATION_ID: string
  GITHUB_REPOSITORY_ID: string
  GITHUB_APP_PRIVATE_KEY_PKCS8: string
}

interface AppConfig {
  clientId: string
  installationId: number
  repositoryId: number
  privateKey: string
}

interface WorkflowRun {
  status?: unknown
  conclusion?: unknown
  head_sha?: unknown
}

interface WorkflowRunsResponse {
  workflow_runs?: unknown
}

interface RecoveryInputs {
  publication: unknown
  headSha: string
  importerRuns: WorkflowRun[]
  pagesRuns: WorkflowRun[]
  failedImportsToday: number
  failedPagesToday: number
  now: Date
}

export type RecoveryReason =
  | 'outside-window'
  | 'import-active'
  | 'pages-active'
  | 'ready'
  | 'attempts-exhausted'
  | 'pages-attempts-exhausted'
  | 'stale'
  | 'pages-missing'

export interface RecoveryDecision {
  dispatch: boolean
  reason: RecoveryReason
  sofiaDate: string
}

/** Errors whose messages were written here and are safe to log. */
export class SchedulerError extends Error {}

function sofiaClock(now: Date) {
  const parts = SOFIA_FORMATTER.formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  const offset = values.timeZoneName === 'GMT' ? '+00:00' : String(values.timeZoneName).replace('GMT', '')

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    minuteOfDay: Number(values.hour) * 60 + Number(values.minute),
    weekday: values.weekday ?? '',
    offset,
  }
}

function isRecoveryWindow(clock: ReturnType<typeof sofiaClock>): boolean {
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(clock.weekday)
    && clock.minuteOfDay >= WINDOW_OPENS_AT_MINUTE
    && clock.minuteOfDay < WINDOW_CLOSES_AT_MINUTE
}

function hasPlausibleReadyMenu(value: unknown, expectedDate: string): boolean {
  if (!value || typeof value !== 'object') return false

  const publication = value as Record<string, unknown>
  if (publication.status !== 'ready' || !publication.menu || typeof publication.menu !== 'object') {
    return false
  }

  const menu = publication.menu as Record<string, unknown>
  if (menu.date !== expectedDate || menu.currency !== 'EUR' || !Array.isArray(menu.categories)) {
    return false
  }

  const items = menu.categories.flatMap((category) => {
    if (!category || typeof category !== 'object') return []
    const categoryItems = (category as Record<string, unknown>).items
    return Array.isArray(categoryItems) ? categoryItems : []
  })

  return menu.categories.length >= 2
    && items.length >= 8
    && items.every((item) => {
      if (!item || typeof item !== 'object') return false
      const priceCents = (item as Record<string, unknown>).priceCents
      return Number.isInteger(priceCents) && Number(priceCents) > 0
    })
}

function hasActiveRun(runs: WorkflowRun[]): boolean {
  return runs.some((run) => typeof run.status === 'string' && ACTIVE_RUN_STATUSES.has(run.status))
}

export function evaluateRecovery(inputs: RecoveryInputs): RecoveryDecision {
  const clock = sofiaClock(inputs.now)
  const decide = (dispatch: boolean, reason: RecoveryReason) => ({ dispatch, reason, sofiaDate: clock.date })

  if (!isRecoveryWindow(clock)) return decide(false, 'outside-window')
  if (hasActiveRun(inputs.importerRuns)) return decide(false, 'import-active')
  if (hasActiveRun(inputs.pagesRuns)) return decide(false, 'pages-active')

  const menuReady = hasPlausibleReadyMenu(inputs.publication, clock.date)
  if (menuReady && inputs.pagesRuns.some((run) => (
    run.head_sha === inputs.headSha && run.status === 'completed' && run.conclusion === 'success'
  ))) return decide(false, 'ready')
  if (!menuReady) {
    return inputs.failedImportsToday >= MAX_FAILED_IMPORTS_PER_DAY
      ? decide(false, 'attempts-exhausted')
      : decide(true, 'stale')
  }
  if (inputs.failedPagesToday >= MAX_FAILED_PAGES_RUNS_PER_DAY
    || inputs.failedImportsToday >= MAX_FAILED_IMPORTS_FOR_PAGES_RECOVERY) {
    return decide(false, 'pages-attempts-exhausted')
  }
  return decide(true, 'pages-missing')
}

function positiveId(value: unknown, name: string): number {
  if (typeof value !== 'string' || !/^[1-9]\d{0,15}$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new SchedulerError(`${name} must be a positive integer`)
  }
  return Number(value)
}

export function readAppConfig(env: SchedulerEnv): AppConfig {
  if (typeof env.GITHUB_APP_CLIENT_ID !== 'string' || !/^Iv[A-Za-z0-9.]{8,40}$/.test(env.GITHUB_APP_CLIENT_ID)) {
    throw new SchedulerError('GITHUB_APP_CLIENT_ID must be a GitHub App client ID')
  }
  if (typeof env.GITHUB_APP_PRIVATE_KEY_PKCS8 !== 'string' || !env.GITHUB_APP_PRIVATE_KEY_PKCS8.trim()) {
    throw new SchedulerError('GITHUB_APP_PRIVATE_KEY_PKCS8 is required')
  }
  return {
    clientId: env.GITHUB_APP_CLIENT_ID,
    installationId: positiveId(env.GITHUB_APP_INSTALLATION_ID, 'GITHUB_APP_INSTALLATION_ID'),
    repositoryId: positiveId(env.GITHUB_REPOSITORY_ID, 'GITHUB_REPOSITORY_ID'),
    privateKey: env.GITHUB_APP_PRIVATE_KEY_PKCS8,
  }
}

function base64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '')
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  // Never include key material in these messages.
  if (pem.includes('BEGIN RSA PRIVATE KEY')) {
    throw new SchedulerError('GitHub App private key is PKCS#1; convert it with openssl pkcs8 -topk8 -nocrypt')
  }
  const match = /^-----BEGIN PRIVATE KEY-----([A-Za-z0-9+/=\s]+)-----END PRIVATE KEY-----$/.exec(pem.trim())
  if (!match) throw new SchedulerError('GitHub App private key must be an unencrypted PKCS#8 PEM')

  try {
    const der = Uint8Array.from(atob(match[1]!.replace(/\s+/g, '')), (character) => character.charCodeAt(0))
    return await crypto.subtle.importKey(
      'pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign'],
    )
  } catch {
    throw new SchedulerError('GitHub App private key could not be imported')
  }
}

export async function createAppJwt(clientId: string, privateKeyPem: string, now: Date): Promise<string> {
  const key = await importPrivateKey(privateKeyPem)
  const issuedAt = Math.floor(now.getTime() / 1_000) - JWT_BACKDATE_SECONDS
  const encoder = new TextEncoder()
  const unsigned = [
    { alg: 'RS256', typ: 'JWT' },
    { iat: issuedAt, exp: issuedAt + JWT_BACKDATE_SECONDS + JWT_LIFETIME_SECONDS, iss: clientId },
  ].map((part) => base64Url(encoder.encode(JSON.stringify(part)))).join('.')
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, encoder.encode(unsigned))
  return `${unsigned}.${base64Url(new Uint8Array(signature))}`
}

function githubHeaders(token: string, accept = 'application/vnd.github+json'): Record<string, string> {
  return {
    accept,
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'user-agent': 'mandarin-ordering-cloudflare-scheduler',
    'x-github-api-version': API_VERSION,
  }
}

function responseError(action: string, response: Response): SchedulerError {
  // Do not log upstream bodies or request details: they could reflect a secret.
  return new SchedulerError(`GitHub ${action} failed with ${response.status}`)
}

async function request(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch {
    throw new SchedulerError('GitHub request failed or timed out')
  }
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T
  } catch {
    throw new SchedulerError('GitHub returned invalid JSON')
  }
}

async function readText(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    throw new SchedulerError('GitHub response could not be read')
  }
}

async function githubGet(
  path: string,
  token: string,
  fetchImpl: typeof fetch,
  accept?: string,
): Promise<Response> {
  const response = await request(`${GITHUB_API}${path}`, { headers: githubHeaders(token, accept) }, fetchImpl)
  if (!response.ok) throw responseError('lookup', response)
  return response
}

function hasExactTokenPermissions(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const granted = Object.entries(value as Record<string, unknown>)
    .filter(([name, level]) => !(name === 'metadata' && level === 'read'))
  const requested = Object.entries(TOKEN_PERMISSIONS)
  return granted.length === requested.length
    && requested.every(([name, level]) => (value as Record<string, unknown>)[name] === level)
}

async function mintInstallationToken(config: AppConfig, fetchImpl: typeof fetch, now: Date): Promise<string> {
  const jwt = await createAppJwt(config.clientId, config.privateKey, now)
  const response = await request(`${GITHUB_API}/app/installations/${config.installationId}/access_tokens`, {
    method: 'POST',
    headers: githubHeaders(jwt),
    // Re-scope below the installation grant: one repository, two permissions.
    body: JSON.stringify({ repository_ids: [config.repositoryId], permissions: TOKEN_PERMISSIONS }),
  }, fetchImpl)
  if (response.status !== 201) throw responseError('installation token', response)

  const details = await readJson<{ token?: unknown; permissions?: unknown; repositories?: unknown }>(response)
  if (typeof details.token !== 'string' || !BEARER_TOKEN.test(details.token)) {
    throw new SchedulerError('GitHub returned an invalid installation token')
  }
  if (!hasExactTokenPermissions(details.permissions)) {
    throw new SchedulerError('GitHub installation token has unexpected permissions')
  }
  const repositories = details.repositories
  if (!Array.isArray(repositories) || repositories.length !== 1
    || (repositories[0] as { id?: unknown } | null)?.id !== config.repositoryId) {
    throw new SchedulerError('GitHub installation token has unexpected repository access')
  }
  return details.token
}

function workflowRuns(payload: WorkflowRunsResponse): WorkflowRun[] {
  if (!Array.isArray(payload.workflow_runs)) {
    throw new SchedulerError('GitHub returned an invalid workflow-runs response')
  }
  if (!payload.workflow_runs.every((run) => (
    run && typeof run === 'object' && typeof run.status === 'string'
  ))) throw new SchedulerError('GitHub returned an invalid workflow run')
  return payload.workflow_runs as WorkflowRun[]
}

function runsPath(workflow: string, filters: Record<string, string>): string {
  const query = new URLSearchParams({ branch: BRANCH, ...filters })
  return `/repos/${REPOSITORY}/actions/workflows/${workflow}/runs?${query}`
}

async function listRuns(path: string, token: string, fetchImpl: typeof fetch): Promise<WorkflowRun[]> {
  return workflowRuns(await readJson<WorkflowRunsResponse>(await githubGet(path, token, fetchImpl)))
}

async function activeWorkflowRuns(workflow: string, token: string, fetchImpl: typeof fetch) {
  // Status-filtered queries cannot hide a waiting run behind newer completed runs.
  const results = await Promise.all([...ACTIVE_RUN_STATUSES].map((status) => (
    listRuns(runsPath(workflow, { status, per_page: '1' }), token, fetchImpl)
  )))
  return results.flat()
}

async function failedRunsToday(
  workflow: string,
  now: Date,
  token: string,
  fetchImpl: typeof fetch,
): Promise<number> {
  const clock = sofiaClock(now)
  // The offset at the current time equals midnight's on every weekday; Sofia
  // changes offset only on Sunday nights, outside the recovery window.
  const runs = await listRuns(runsPath(workflow, {
    status: 'completed',
    created: `>=${clock.date}T00:00:00${clock.offset}`,
    per_page: '100',
  }), token, fetchImpl)
  return runs.filter((run) => typeof run.conclusion === 'string' && FAILED_CONCLUSIONS.has(run.conclusion)).length
}

export async function checkAndRecover(
  now: Date,
  env: SchedulerEnv,
  fetchImpl: typeof fetch = fetch,
  wallClock: () => Date = () => new Date(),
): Promise<RecoveryDecision & { runUrl?: string }> {
  const config = readAppConfig(env)

  const earlyDecision = evaluateRecovery({
    publication: null,
    headSha: '',
    importerRuns: [],
    pagesRuns: [],
    failedImportsToday: 0,
    failedPagesToday: 0,
    now,
  })
  // Cloudflare Cron is UTC-only. Keep its configured range broad and gate with
  // Sofia civil time here so DST never moves the restaurant's recovery window.
  if (earlyDecision.reason === 'outside-window') return earlyDecision

  const token = await mintInstallationToken(config, fetchImpl, wallClock())
  const headSha = (await readText(await githubGet(
    `/repos/${REPOSITORY}/commits/${BRANCH}`, token, fetchImpl, 'application/vnd.github.sha',
  ))).trim()
  if (!/^[a-f0-9]{40}([a-f0-9]{24})?$/.test(headSha)) {
    throw new SchedulerError('GitHub returned an invalid master commit SHA')
  }

  // Every remaining read is pinned to that immutable SHA or filtered by it.
  const [publication, importerRuns, pagesRuns, exactPagesRuns, failedImports, failedPages] = await Promise.all([
    githubGet(
      `/repos/${REPOSITORY}/contents/${MENU_PATH}?ref=${headSha}`, token, fetchImpl, 'application/vnd.github.raw+json',
    ).then((response) => readJson<unknown>(response)),
    activeWorkflowRuns(IMPORT_WORKFLOW, token, fetchImpl),
    activeWorkflowRuns(PAGES_WORKFLOW, token, fetchImpl),
    listRuns(runsPath(PAGES_WORKFLOW, { status: 'success', head_sha: headSha, per_page: '1' }), token, fetchImpl),
    failedRunsToday(IMPORT_WORKFLOW, now, token, fetchImpl),
    failedRunsToday(PAGES_WORKFLOW, now, token, fetchImpl),
  ])

  const decision = evaluateRecovery({
    publication,
    headSha,
    importerRuns,
    pagesRuns: [...pagesRuns, ...exactPagesRuns],
    failedImportsToday: failedImports,
    failedPagesToday: failedPages,
    now,
  })
  if (!decision.dispatch) return decision

  const dispatchResponse = await request(
    `${GITHUB_API}/repos/${REPOSITORY}/actions/workflows/${IMPORT_WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: githubHeaders(token),
      body: JSON.stringify({
        ref: BRANCH,
        inputs: { dry_run: 'false' },
      }),
    }, fetchImpl,
  )
  if (dispatchResponse.status !== 200) {
    throw responseError('workflow dispatch', dispatchResponse)
  }

  const details = await readJson<{ workflow_run_id?: unknown; html_url?: unknown }>(dispatchResponse)
  if (!Number.isSafeInteger(details.workflow_run_id) || Number(details.workflow_run_id) <= 0
    || details.html_url !== `https://github.com/${REPOSITORY}/actions/runs/${details.workflow_run_id}`) {
    throw new SchedulerError('GitHub dispatch returned invalid workflow run details; check Actions before retrying')
  }
  return {
    ...decision,
    runUrl: details.html_url as string,
  }
}

export default {
  async scheduled(controller: Pick<ScheduledController, 'scheduledTime'>, env: SchedulerEnv): Promise<void> {
    const startedAt = Date.now()
    const scheduledTime = new Date(controller.scheduledTime)
    const context = {
      event: 'menu-scheduler',
      scheduledTime: scheduledTime.toISOString(),
      sofiaDate: sofiaClock(scheduledTime).date,
    }

    try {
      const result = await checkAndRecover(scheduledTime, env)
      console.log(JSON.stringify({
        ...context,
        outcome: 'ok',
        reason: result.reason,
        dispatch: result.dispatch,
        ...(result.runUrl ? { runUrl: result.runUrl } : {}),
        durationMs: Date.now() - startedAt,
      }))
    } catch (error) {
      // Only messages authored in this module are logged; anything else could
      // carry a response snippet, so it is replaced before Cloudflare records it.
      const message = error instanceof SchedulerError ? error.message : 'Unexpected scheduler failure'
      console.error(JSON.stringify({ ...context, outcome: 'error', error: message, durationMs: Date.now() - startedAt }))
      throw new SchedulerError(message)
    }
  },
} satisfies ExportedHandler<Env>
