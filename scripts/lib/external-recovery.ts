import { evaluateMenuFreshness, sofiaClock } from './menu-freshness.ts'

const EXTERNAL_RECOVERY_START_HOUR = 8
const EXTERNAL_RECOVERY_END_HOUR = 13
const ACTIVE_RUN_STATUSES = new Set(['queued', 'in_progress', 'waiting', 'pending', 'requested'])

export interface WorkflowRunSummary {
  status?: unknown
  conclusion?: unknown
  head_sha?: unknown
}

export interface ExternalRecoveryDecision {
  dispatch: boolean
  reason: 'outside-window' | 'import-active' | 'pages-active' | 'ready' | 'stale' | 'pages-missing'
  sofiaDate: string
}

export function isExternalRecoveryWindow(now: Date): boolean {
  const clock = sofiaClock(now)
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].includes(clock.weekday)
    && clock.hour >= EXTERNAL_RECOVERY_START_HOUR
    && clock.hour <= EXTERNAL_RECOVERY_END_HOUR
}

function hasActiveRun(runs: WorkflowRunSummary[]): boolean {
  return runs.some((run) => typeof run.status === 'string' && ACTIVE_RUN_STATUSES.has(run.status))
}

export function evaluateExternalRecovery(options: {
  publication: unknown
  headSha: string
  importerRuns: WorkflowRunSummary[]
  pagesRuns: WorkflowRunSummary[]
  now?: Date
}): ExternalRecoveryDecision {
  const now = options.now ?? new Date()
  const clock = sofiaClock(now)

  if (!isExternalRecoveryWindow(now)) {
    return { dispatch: false, reason: 'outside-window', sofiaDate: clock.date }
  }

  if (hasActiveRun(options.importerRuns)) {
    return { dispatch: false, reason: 'import-active', sofiaDate: clock.date }
  }

  const freshness = evaluateMenuFreshness(options.publication, now, true)
  if (freshness.needsImport) {
    return { dispatch: true, reason: 'stale', sofiaDate: clock.date }
  }

  if (hasActiveRun(options.pagesRuns)) {
    return { dispatch: false, reason: 'pages-active', sofiaDate: clock.date }
  }

  const exactCommitIsDeployed = options.pagesRuns.some((run) => (
    run.head_sha === options.headSha && run.conclusion === 'success'
  ))
  if (exactCommitIsDeployed) {
    return { dispatch: false, reason: 'ready', sofiaDate: clock.date }
  }

  return { dispatch: true, reason: 'pages-missing', sofiaDate: clock.date }
}
