import { describe, expect, it } from 'vitest'
import { createLaunchAgentPlist } from './install-macos-watchdog.ts'

describe('macOS external-watchdog installer', () => {
  it('creates a launch agent with a stable interval and escaped absolute paths', () => {
    const plist = createLaunchAgentPlist({
      nodePath: '/opt/homebrew/bin/node',
      scriptPath: '/Users/Test & Dev/project/scripts/external-menu-watchdog.ts',
      workingDirectory: '/Users/Test & Dev/project',
      stdoutPath: '/Users/Test & Dev/Library/Logs/watchdog.log',
      stderrPath: '/Users/Test & Dev/Library/Logs/watchdog.error.log',
    })

    expect(plist).toContain('<string>com.hristo.mandarin-ordering.watchdog</string>')
    expect(plist).toContain('<integer>900</integer>')
    expect(plist).toContain('/Users/Test &amp; Dev/project/scripts/external-menu-watchdog.ts')
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>')
    expect(plist).not.toContain('/Users/Test & Dev')
  })
})
