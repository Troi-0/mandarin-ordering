import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  evaluateExternalRecovery,
  isExternalRecoveryWindow,
  type WorkflowRunSummary,
} from './lib/external-recovery.ts'
import { sofiaClock } from './lib/menu-freshness.ts'

const execFileAsync = promisify(execFile)
const REPOSITORY = 'Troi-0/mandarin-ordering'
const BRANCH = 'master'
const IMPORT_WORKFLOW = 'import-facebook.yml'
const PAGES_WORKFLOW = 'deploy-pages.yml'
const COMMAND_TIMEOUT_MS = 30_000

interface RepositoryContent {
  content?: unknown
  encoding?: unknown
}

interface CommitResponse {
  sha?: unknown
}

interface WorkflowRunsResponse {
  workflow_runs?: unknown
}

async function gh(args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('gh', args, {
    encoding: 'utf8',
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 2 * 1024 * 1024,
  })
  return stdout
}

async function ghJson<T>(endpoint: string): Promise<T> {
  return JSON.parse(await gh(['api', '--method', 'GET', endpoint])) as T
}

function workflowRuns(payload: WorkflowRunsResponse): WorkflowRunSummary[] {
  if (!Array.isArray(payload.workflow_runs)) {
    throw new Error('GitHub returned an invalid workflow-runs response')
  }
  return payload.workflow_runs.filter(
    (run): run is Record<string, unknown> => typeof run === 'object' && run !== null,
  )
}

async function main(): Promise<void> {
  const now = new Date()
  const clock = sofiaClock(now)
  if (!isExternalRecoveryWindow(now)) {
    process.stdout.write(`No recovery needed outside the Sofia weekday window (${clock.date})\n`)
    return
  }

  const [content, commit, importerPayload, pagesPayload] = await Promise.all([
    ghJson<RepositoryContent>(
      `repos/${REPOSITORY}/contents/data/current-menu.json?ref=${encodeURIComponent(BRANCH)}`,
    ),
    ghJson<CommitResponse>(`repos/${REPOSITORY}/commits/${encodeURIComponent(BRANCH)}`),
    ghJson<WorkflowRunsResponse>(
      `repos/${REPOSITORY}/actions/workflows/${IMPORT_WORKFLOW}/runs?branch=${BRANCH}&per_page=10`,
    ),
    ghJson<WorkflowRunsResponse>(
      `repos/${REPOSITORY}/actions/workflows/${PAGES_WORKFLOW}/runs?branch=${BRANCH}&per_page=10`,
    ),
  ])

  if (content.encoding !== 'base64' || typeof content.content !== 'string') {
    throw new Error('GitHub returned an invalid current-menu.json response')
  }
  if (typeof commit.sha !== 'string' || !/^[a-f0-9]{40,64}$/i.test(commit.sha)) {
    throw new Error('GitHub returned an invalid master commit SHA')
  }

  const publication = JSON.parse(Buffer.from(content.content, 'base64').toString('utf8')) as unknown
  const decision = evaluateExternalRecovery({
    publication,
    headSha: commit.sha,
    importerRuns: workflowRuns(importerPayload),
    pagesRuns: workflowRuns(pagesPayload),
    now,
  })

  if (!decision.dispatch) {
    process.stdout.write(`No external recovery dispatch: ${decision.reason} (${decision.sofiaDate})\n`)
    return
  }

  await gh([
    'workflow',
    'run',
    IMPORT_WORKFLOW,
    '--repo',
    REPOSITORY,
    '--ref',
    BRANCH,
    '-f',
    'dry_run=false',
  ])
  process.stdout.write(
    `Dispatched ${IMPORT_WORKFLOW}: ${decision.reason} (${decision.sofiaDate})\n`,
  )
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`External menu watchdog failed: ${message}\n`)
  process.exitCode = 1
})
