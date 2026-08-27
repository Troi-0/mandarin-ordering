import { isTodayInSofia } from '../../src/lib/date.ts'
import { menuPublicationSchema } from '../../src/lib/menu-schema.ts'

const API_VERSION = '2026-03-10'
const DEPLOY_WORKFLOW = 'deploy-pages.yml'
const DEFAULT_BRANCH = 'master'
const TRANSIENT_RETRY_DELAYS_MS = [2_000, 8_000]
const MAX_RATE_LIMIT_WAIT_MS = 30_000
const REQUEST_TIMEOUT_MS = 15_000

type Fetch = typeof fetch

export interface PagesReconciliationOptions {
  repository: string
  token: string
  headSha: string
  publication: unknown
  now?: Date
  fetchImpl?: Fetch
  sleep?: (milliseconds: number) => Promise<void>
  log?: (message: string) => void
}

export interface PagesReconciliationResult {
  status: 'already-deployed' | 'dispatched'
  menuDate: string
  headSha: string
}

function assertRepository(value: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) {
    throw new Error('GITHUB_REPOSITORY must have the form owner/repository')
  }
}

function assertHeadSha(value: string): void {
  if (!/^[a-f0-9]{40,64}$/i.test(value)) {
    throw new Error('Current git HEAD must be a full commit SHA')
  }
}

function apiHeaders(token: string): Record<string, string> {
  return {
    accept: 'application/vnd.github+json',
    authorization: `Bearer ${token}`,
    'x-github-api-version': API_VERSION,
  }
}

function apiError(action: string, response: Response, body: string): Error {
  const detail = body.trim().slice(0, 300)
  return new Error(
    `GitHub ${action} failed with ${response.status}${detail ? `: ${detail}` : ''}`,
  )
}

async function responseBody(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return ''
  }
}

function isRateLimited(response: Response, body: string): boolean {
  return response.status === 429 || (
    response.status === 403 && (
      response.headers.has('retry-after') ||
      response.headers.get('x-ratelimit-remaining') === '0' ||
      /rate limit/i.test(body)
    )
  )
}

function rateLimitDelay(response: Response, now: Date): number | undefined {
  const retryAfter = response.headers.get('retry-after')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000)
    const retryAt = Date.parse(retryAfter)
    if (Number.isFinite(retryAt)) return Math.max(0, retryAt - now.getTime())
  }

  if (response.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(response.headers.get('x-ratelimit-reset'))
    if (Number.isFinite(reset) && reset > 0) {
      return Math.max(0, (reset * 1_000) - now.getTime() + 1_000)
    }
  }
  return undefined
}

function isTransient(response: Response): boolean {
  return response.status === 408 || response.status >= 500
}

async function hasSuccessfulDeployment(options: {
  fetchImpl: Fetch
  repository: string
  token: string
  headSha: string
}): Promise<boolean> {
  const workflow = encodeURIComponent(DEPLOY_WORKFLOW)
  const query = new URLSearchParams({
    branch: DEFAULT_BRANCH,
    status: 'success',
    head_sha: options.headSha,
    per_page: '1',
  })
  const response = await options.fetchImpl(
    `https://api.github.com/repos/${options.repository}/actions/workflows/${workflow}/runs?${query}`,
    { headers: apiHeaders(options.token), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) },
  )
  if (!response.ok) throw apiError('Pages status lookup', response, await responseBody(response))

  const payload = await response.json() as { workflow_runs?: unknown }
  if (!Array.isArray(payload.workflow_runs)) {
    throw new Error('GitHub Pages status lookup returned an unexpected response')
  }
  return payload.workflow_runs.some((run) => {
    if (typeof run !== 'object' || run === null) return false
    const fields = run as { head_sha?: unknown; conclusion?: unknown }
    return fields.head_sha === options.headSha && fields.conclusion === 'success'
  })
}

async function dispatchDeployment(options: {
  fetchImpl: Fetch
  sleep: (milliseconds: number) => Promise<void>
  repository: string
  token: string
  headSha: string
  menuDate: string
  now: Date
}): Promise<void> {
  const url = `https://api.github.com/repos/${options.repository}/dispatches`
  const body = JSON.stringify({
    event_type: 'menu-published',
    client_payload: {
      menu_date: options.menuDate,
      menu_commit: options.headSha,
    },
  })

  for (let attempt = 0; attempt <= TRANSIENT_RETRY_DELAYS_MS.length; attempt += 1) {
    let response: Response
    try {
      response = await options.fetchImpl(url, {
        method: 'POST',
        headers: { ...apiHeaders(options.token), 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
    } catch (error) {
      if (attempt === TRANSIENT_RETRY_DELAYS_MS.length) {
        throw new Error('GitHub deployment dispatch failed after transient network errors', {
          cause: error,
        })
      }
      await options.sleep(TRANSIENT_RETRY_DELAYS_MS[attempt])
      continue
    }

    if (response.status === 204) return
    const errorBody = await responseBody(response)

    if (isRateLimited(response, errorBody)) {
      const wait = rateLimitDelay(response, options.now)
      if (
        attempt === TRANSIENT_RETRY_DELAYS_MS.length ||
        wait === undefined ||
        wait > MAX_RATE_LIMIT_WAIT_MS
      ) {
        throw new Error(
          `${apiError('deployment dispatch', response, errorBody).message}; a later scheduled import will retry`,
        )
      }
      await options.sleep(wait)
      continue
    }

    if (!isTransient(response) || attempt === TRANSIENT_RETRY_DELAYS_MS.length) {
      throw apiError('deployment dispatch', response, errorBody)
    }
    await options.sleep(TRANSIENT_RETRY_DELAYS_MS[attempt])
  }
}

export async function reconcilePagesDeployment(
  options: PagesReconciliationOptions,
): Promise<PagesReconciliationResult> {
  assertRepository(options.repository)
  assertHeadSha(options.headSha)
  if (!options.token.trim()) throw new Error('GH_TOKEN is required for Pages reconciliation')

  const publication = menuPublicationSchema.parse(options.publication)
  const now = options.now ?? new Date()
  if (publication.status !== 'ready' || !isTodayInSofia(publication.menu.date, now)) {
    throw new Error('Pages reconciliation requires a ready menu for today in Europe/Sofia')
  }

  const fetchImpl = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? ((milliseconds) => new Promise((resolve) => {
    setTimeout(resolve, milliseconds)
  }))
  const log = options.log ?? (() => undefined)

  try {
    if (await hasSuccessfulDeployment({
      fetchImpl,
      repository: options.repository,
      token: options.token,
      headSha: options.headSha,
    })) {
      return { status: 'already-deployed', menuDate: publication.menu.date, headSha: options.headSha }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log(`Could not confirm the current Pages deployment (${message}); dispatching to avoid a false skip.`)
  }

  await dispatchDeployment({
    fetchImpl,
    sleep,
    repository: options.repository,
    token: options.token,
    headSha: options.headSha,
    menuDate: publication.menu.date,
    now,
  })
  return { status: 'dispatched', menuDate: publication.menu.date, headSha: options.headSha }
}
