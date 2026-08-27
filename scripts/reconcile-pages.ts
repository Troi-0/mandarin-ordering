import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { reconcilePagesDeployment } from './lib/pages-reconciliation.ts'

const execFileAsync = promisify(execFile)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const publication = JSON.parse(
  await readFile(path.join(root, 'data', 'current-menu.json'), 'utf8'),
) as unknown
const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root })
const result = await reconcilePagesDeployment({
  repository: process.env.GITHUB_REPOSITORY ?? '',
  token: process.env.GH_TOKEN ?? '',
  headSha: stdout.trim(),
  publication,
  log: (message) => process.stderr.write(`${message}\n`),
})

process.stdout.write(
  result.status === 'already-deployed'
    ? `Pages already successfully deployed commit ${result.headSha} for ${result.menuDate}\n`
    : `Requested Pages deployment of commit ${result.headSha} for ${result.menuDate}\n`,
)
