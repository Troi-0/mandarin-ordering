const REPOSITORY = 'Troi-0/mandarin-ordering'
const BRANCH = 'master'
const IMPORT_WORKFLOW = 'import-facebook.yml'
const PAGES_WORKFLOW = 'deploy-pages.yml'
const API_VERSION = '2026-03-10'
const SOFIA_TIME_ZONE = 'Europe/Sofia'
const ACTIVE_RUN_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested'])

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
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SOFIA_TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
    weekday: 'short',
  }).formatToParts(now)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))

  return {
    date: `${values.year}-${values.month}-${values.day}`,
    hour: Number(values.hour),
    minute: Number(values.minute),
    weekday: values.weekday,
  }
}

function isRecoveryWindow(now: Date): boolean {
  const clock = sofiaClock(now)
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
  if (!isRecoveryWindow(inputs.now)) {
    return { dispatch: false, reason: 'outside-window', sofiaDate: clock.date }
  }
  if (hasActiveRun(inputs.importerRuns)) {
    return { dispatch: false, reason: 'import-active', sofiaDate: clock.date }
  }
  if (!hasPlausibleReadyMenu(inputs.publication, clock.date)) {
    return { dispatch: true, reason: 'stale', sofiaDate: clock.date }
  }
  if (hasActiveRun(inputs.pagesRuns)) {
    return { dispatch: false, reason: 'pages-active', sofiaDate: clock.date }
  }
  if (inputs.pagesRuns.some((run) => (
    run.head_sha === inputs.headSha && run.conclusion === 'success'
  ))) {
    return { dispatch: false, reason: 'ready', sofiaDate: clock.date }
  }
  return { dispatch: true, reason: 'pages-missing', sofiaDate: clock.date }
}

function githubHeaders(token: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'user-agent': 'mandarin-ordering-cloudflare-scheduler',
    'x-github-api-version': API_VERSION,
  }
}

async function responseError(action: string, response: Response): Promise<Error> {
  const body = (await response.text()).trim().slice(0, 300)
  return new Error(`GitHub ${action} failed with ${response.status}${body ? `: ${body}` : ''}`)
}

async function githubJson<T>(
  path: string,
  token: string,
  fetchImpl: typeof fetch,
): Promise<T> {
  const response = await fetchImpl(`https://api.github.com${path}`, {
    headers: githubHeaders(token),
  })
  if (!response.ok) throw await responseError('lookup', response)
  return response.json() as Promise<T>
}

function workflowRuns(payload: WorkflowRunsResponse): WorkflowRun[] {
  if (!Array.isArray(payload.workflow_runs)) {
    throw new Error('GitHub returned an invalid workflow-runs response')
  }
  return payload.workflow_runs.filter(
    (run): run is Record<string, unknown> => typeof run === 'object' && run !== null,
  )
}

export async function checkAndRecover(
  now: Date,
  token: string,
  fetchImpl: typeof fetch = fetch,
): Promise<RecoveryDecision & { runUrl?: string }> {
  if (!token.trim()) throw new Error('GITHUB_ACTIONS_TOKEN is required')

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
  const cacheKey = encodeURIComponent(String(now.getTime()))
  const [menuResponse, commit, importerPayload, pagesPayload] = await Promise.all([
    fetchImpl(
      `https://raw.githubusercontent.com/${REPOSITORY}/${BRANCH}/data/current-menu.json?at=${cacheKey}`,
      { headers: { 'cache-control': 'no-cache' } },
    ),
    githubJson<{ sha?: unknown }>(`/repos/${REPOSITORY}/commits/${BRANCH}`, token, fetchImpl),
    githubJson<WorkflowRunsResponse>(
      `/repos/${REPOSITORY}/actions/workflows/${IMPORT_WORKFLOW}/runs?branch=${BRANCH}&per_page=10`,
      token,
      fetchImpl,
    ),
    githubJson<WorkflowRunsResponse>(
      `/repos/${REPOSITORY}/actions/workflows/${PAGES_WORKFLOW}/runs?branch=${BRANCH}&per_page=10`,
      token,
      fetchImpl,
    ),
  ])

  if (!menuResponse.ok) throw await responseError('menu lookup', menuResponse)
  if (typeof commit.sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(commit.sha)) {
    throw new Error('GitHub returned an invalid master commit SHA')
  }

  const decision = evaluateRecovery({
    publication: await menuResponse.json() as unknown,
    headSha: commit.sha,
    importerRuns: workflowRuns(importerPayload),
    pagesRuns: workflowRuns(pagesPayload),
    now,
  })
  if (!decision.dispatch) return decision

  const dispatchResponse = await fetchImpl(
    `https://api.github.com/repos/${REPOSITORY}/actions/workflows/${IMPORT_WORKFLOW}/dispatches`,
    {
      method: 'POST',
      headers: githubHeaders(token),
      body: JSON.stringify({
        ref: BRANCH,
        inputs: { dry_run: 'false' },
      }),
    },
  )
  if (dispatchResponse.status !== 200) {
    throw await responseError('workflow dispatch', dispatchResponse)
  }

  const details = await dispatchResponse.json() as { html_url?: unknown }
  return {
    ...decision,
    ...(typeof details.html_url === 'string' ? { runUrl: details.html_url } : {}),
  }
}

export default {
  async scheduled(controller: ScheduledController, env: Env): Promise<void> {
    const result = await checkAndRecover(new Date(controller.scheduledTime), env.GITHUB_ACTIONS_TOKEN)
    console.log(JSON.stringify(result))
  },
}
