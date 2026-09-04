const REPOSITORY = 'Troi-0/mandarin-ordering'
const BRANCH = 'master'
const IMPORT_WORKFLOW = 'import-facebook.yml'
const PAGES_WORKFLOW = 'deploy-pages.yml'
const API_VERSION = '2026-03-10'
const SOFIA_TIME_ZONE = 'Europe/Sofia'
const ACTIVE_RUN_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested'])
const REQUEST_TIMEOUT_MS = 15_000
const SOFIA_FORMATTER = new Intl.DateTimeFormat('en-CA', {
  timeZone: SOFIA_TIME_ZONE,
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23', weekday: 'short',
})

interface Env {
  GITHUB_ACTIONS_TOKEN: string
}

interface ScheduledController {
  scheduledTime: number
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
  now: Date
}

export type RecoveryReason =
  | 'outside-window'
  | 'import-active'
  | 'pages-active'
  | 'ready'
  | 'stale'
  | 'pages-missing'

export interface RecoveryDecision {
  dispatch: boolean
  reason: RecoveryReason
  sofiaDate: string
}

function sofiaClock(now: Date): { date: string; hour: number; minute: number; weekday: string } {
  const parts = SOFIA_FORMATTER.formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday: values.weekday,
  }
}

function isRecoveryWindow(clock: ReturnType<typeof sofiaClock>): boolean {
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(clock.weekday)
  const afterOpening = clock.hour > 8 || (clock.hour === 8 && clock.minute >= 45)
  return weekday && afterOpening && clock.hour <= 13
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
  if (!isRecoveryWindow(clock)) {
    return { dispatch: false, reason: 'outside-window', sofiaDate: clock.date }
  }
  if (hasActiveRun(inputs.importerRuns)) {
    return { dispatch: false, reason: 'import-active', sofiaDate: clock.date }
  }
  if (hasActiveRun(inputs.pagesRuns)) {
    return { dispatch: false, reason: 'pages-active', sofiaDate: clock.date }
  }
  if (!hasPlausibleReadyMenu(inputs.publication, clock.date)) {
    return { dispatch: true, reason: 'stale', sofiaDate: clock.date }
  }
  if (inputs.pagesRuns.some((run) => (
    run.head_sha === inputs.headSha && run.status === 'completed' && run.conclusion === 'success'
  ))) {
    return { dispatch: false, reason: 'ready', sofiaDate: clock.date }
  }
  return { dispatch: true, reason: 'pages-missing', sofiaDate: clock.date }
}

function githubHeaders(token?: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    'content-type': 'application/json',
    'user-agent': 'mandarin-ordering-cloudflare-scheduler',
    'x-github-api-version': API_VERSION,
  }
}

function responseError(action: string, response: Response): Error {
  // Do not log upstream bodies or request details: they could reflect a secret.
  return new Error(`GitHub ${action} failed with ${response.status}`)
}

async function request(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch {
    throw new Error('GitHub request failed or timed out')
  }
}

async function readJson<T>(response: Response): Promise<T> {
  try {
    return await response.json() as T
  } catch {
    throw new Error('GitHub returned invalid JSON')
  }
}

async function githubJson<T>(
  path: string,
  token: string | undefined,
  fetchImpl: typeof fetch,
): Promise<T> {
  const response = await request(`https://api.github.com${path}`, {
    headers: githubHeaders(token),
  }, fetchImpl)
  if (!response.ok) throw responseError('lookup', response)
  return readJson<T>(response)
}

function workflowRuns(payload: WorkflowRunsResponse): WorkflowRun[] {
  if (!Array.isArray(payload.workflow_runs)) {
    throw new Error('GitHub returned an invalid workflow-runs response')
  }
  if (!payload.workflow_runs.every((run) => (
    run && typeof run === 'object' && typeof run.status === 'string'
  ))) throw new Error('GitHub returned an invalid workflow run')
  return payload.workflow_runs as WorkflowRun[]
}

async function activeWorkflowRuns(workflow: string, token: string, fetchImpl: typeof fetch) {
  // Status-filtered queries cannot hide a waiting run behind newer completed runs.
  const results = await Promise.all([...ACTIVE_RUN_STATUSES].map(async (status) => (
    workflowRuns(await githubJson<WorkflowRunsResponse>(
      `/repos/${REPOSITORY}/actions/workflows/${workflow}/runs?branch=${BRANCH}&status=${status}&per_page=1`,
      token, fetchImpl,
    ))
  )))
  return results.flat()
}

export async function checkAndRecover(
  now: Date,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RecoveryDecision & { runUrl?: string }> {
  if (typeof token !== 'string' || !token.trim()) throw new Error('GITHUB_ACTIONS_TOKEN is required')

  const earlyDecision = evaluateRecovery({
    publication: null,
    headSha: '',
    importerRuns: [],
    pagesRuns: [],
    now,
  })
  if (earlyDecision.reason === 'outside-window') return earlyDecision

  // Cloudflare Cron is UTC-only. Keep its configured range broad and gate with
  // Sofia civil time here so DST never moves the restaurant's recovery window.
  // This public lookup deliberately has no Authorization header, so the PAT
  // needs only Actions permissions. Pin the menu read to that immutable SHA.
  const commit = await githubJson<{ sha?: unknown }>(
    `/repos/${REPOSITORY}/commits/${BRANCH}?per_page=1`, undefined, fetchImpl,
  )
  if (typeof commit.sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(commit.sha)) {
    throw new Error('GitHub returned an invalid master commit SHA')
  }
  const [publication, importerRuns, pagesRuns, pagesPayload] = await Promise.all([
    (async () => {
      const response = await request(
        `https://raw.githubusercontent.com/${REPOSITORY}/${commit.sha}/data/current-menu.json`,
        { headers: { 'cache-control': 'no-cache' } }, fetchImpl,
      )
      if (!response.ok) throw responseError('menu lookup', response)
      return readJson<unknown>(response)
    })(),
    activeWorkflowRuns(IMPORT_WORKFLOW, token, fetchImpl),
    activeWorkflowRuns(PAGES_WORKFLOW, token, fetchImpl),
    githubJson<WorkflowRunsResponse>(
      `/repos/${REPOSITORY}/actions/workflows/${PAGES_WORKFLOW}/runs?branch=${BRANCH}&status=success&head_sha=${commit.sha}&per_page=1`,
      token, fetchImpl,
    ),
  ])

  const decision = evaluateRecovery({
    publication,
    headSha: commit.sha,
    importerRuns,
    pagesRuns: [...pagesRuns, ...workflowRuns(pagesPayload)],
    now,
  })
  if (!decision.dispatch) return decision

  const dispatchResponse = await request(
    `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${IMPORT_WORKFLOW}/dispatches`,
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
    throw new Error('GitHub dispatch returned invalid workflow run details; check Actions before retrying')
  }
  return {
    ...decision,
    runUrl: details.html_url as string,
  }
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const result = await checkAndRecover(new Date(controller.scheduledTime), env.GITHUB_ACTIONS_TOKEN)
    console.log(JSON.stringify(result))
  },
}
