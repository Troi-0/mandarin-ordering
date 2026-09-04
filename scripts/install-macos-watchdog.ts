import { execFile } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const LABEL = 'com.hristo.mandarin-ordering.watchdog'

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

export function createLaunchAgentPlist(options: {
  nodePath: string
  scriptPath: string
  workingDirectory: string
  stdoutPath: string
  stderrPath: string
}): string {
  const executableDirectories = [
    path.dirname(options.nodePath),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
  ]
  const executablePath = [...new Set(executableDirectories)].join(':')

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(options.nodePath)}</string>
    <string>${xml(options.scriptPath)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(options.workingDirectory)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(executablePath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>StartInterval</key>
  <integer>900</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>LowPriorityIO</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${xml(options.stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(options.stderrPath)}</string>
</dict>
</plist>
`
}

async function executable(name: string): Promise<string> {
  const { stdout } = await execFileAsync('/usr/bin/which', [name], { encoding: 'utf8' })
  const result = stdout.trim()
  if (!path.isAbsolute(result)) throw new Error(`Could not find ${name} on PATH`)
  return result
}

async function main(): Promise<void> {
  if (process.platform !== 'darwin') {
    throw new Error('The independent local watchdog installer currently supports macOS only')
  }
  if (!process.getuid) throw new Error('Could not determine the current macOS user')

  await executable('gh')
  await execFileAsync('gh', ['auth', 'status'], { encoding: 'utf8' })

  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
  const userHome = os.homedir()
  const launchAgentsDirectory = path.join(userHome, 'Library', 'LaunchAgents')
  const logsDirectory = path.join(userHome, 'Library', 'Logs')
  const plistPath = path.join(launchAgentsDirectory, `${LABEL}.plist`)
  const domain = `gui/${process.getuid()}`
  const service = `${domain}/${LABEL}`

  await mkdir(launchAgentsDirectory, { recursive: true })
  await mkdir(logsDirectory, { recursive: true })
  await writeFile(plistPath, createLaunchAgentPlist({
    nodePath: await executable('node'),
    scriptPath: path.join(repositoryRoot, 'scripts', 'external-menu-watchdog.ts'),
    workingDirectory: repositoryRoot,
    stdoutPath: path.join(logsDirectory, 'mandarin-ordering-watchdog.log'),
    stderrPath: path.join(logsDirectory, 'mandarin-ordering-watchdog.error.log'),
  }), { mode: 0o644 })

  try {
    await execFileAsync('/bin/launchctl', ['bootout', service], { encoding: 'utf8' })
  } catch { /* The service was not loaded yet. */ }
  await execFileAsync('/bin/launchctl', ['bootstrap', domain, plistPath], { encoding: 'utf8' })
  await execFileAsync('/bin/launchctl', ['kickstart', '-k', service], { encoding: 'utf8' })

  process.stdout.write(`Installed and started ${LABEL}\n${plistPath}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Could not install the external menu watchdog: ${message}\n`)
    process.exitCode = 1
  })
}
