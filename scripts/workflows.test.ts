import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

async function workflow(name: string): Promise<string> {
  return readFile(`.github/workflows/${name}`, 'utf8')
}

describe('GitHub workflow contracts', () => {
  it('runs the complete zero-cost validation suite in read-only CI', async () => {
    const ci = await workflow('ci.yml')

    expect(ci).toContain('pull_request:')
    expect(ci).toContain('permissions:\n  contents: read')
    expect(ci).toContain('run: npm ci')
    expect(ci).toContain('run: npm run check')
    expect(ci).not.toContain('GEMINI_API_KEY')
  })

  it('keeps Facebook dry runs unpublished and reconciles every successful live import', async () => {
    const importer = await workflow('import-facebook.yml')

    expect(importer).toContain('timezone: Europe/Sofia')
    expect(importer).toContain("cron: '7,22,37,52 8-11 * * 1-5'")
    expect(importer).not.toContain("cron: '0,30 8-11 * * *'")
    expect(importer).toContain('contents: write\n  actions: read')
    expect(importer).toContain('IMPORT_DRY_RUN: ${{ inputs.dry_run }}')
    expect(importer).toContain('IMPORT_BENCHMARK_IMAGE: ${{ inputs.benchmark_image_path }}')
    expect(importer).toContain('menu-import-dry-run-${{ github.run_id }}')
    expect(importer).toContain("if: ${{ always() && !inputs.dry_run }}")
    expect(importer).toContain("if: steps.importer.outcome == 'success' && !inputs.dry_run")
    expect(importer).toContain('run: npm run reconcile:pages')
    expect(importer).not.toContain('menu_commit.outputs.pushed')
    expect(importer).not.toContain('gh api --method POST')
    expect(importer).toContain("if: steps.importer.outcome == 'failure'")
  })

  it('uses the same validation and publication gate for manual inbox imports', async () => {
    const importer = await workflow('import-manual.yml')

    expect(importer).toContain('manual-inbox/*.png')
    expect(importer).toContain('contents: write\n  actions: read')
    expect(importer).toContain('GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}')
    expect(importer).toContain("IMPORT_DRY_RUN: ${{ github.event_name == 'workflow_dispatch' && inputs.dry_run }}")
    expect(importer).toContain('manual-menu-dry-run-${{ github.run_id }}')
    expect(importer).toContain('run: npm run import:manual -- "${{ steps.image.outputs.path }}"')
    expect(importer).toContain("if: ${{ always() && (github.event_name != 'workflow_dispatch' || !inputs.dry_run) }}")
    expect(importer).toContain("if: ${{ steps.importer.outcome == 'success' && (github.event_name != 'workflow_dispatch' || !inputs.dry_run) }}")
    expect(importer).toContain('run: npm run reconcile:pages')
    expect(importer).not.toContain('menu_commit.outputs.pushed')
  })

  it('independently recovers a missed primary schedule without running Gemini when fresh', async () => {
    const watchdog = await workflow('recover-missed-import.yml')

    expect(watchdog).toContain("cron: '13,33,53 5-9 * * 1-5'")
    expect(watchdog).not.toContain('timezone: Europe/Sofia')
    expect(watchdog).toContain('contents: read\n  actions: write')
    expect(watchdog).toContain('run: node scripts/check-menu-freshness.ts')
    expect(watchdog).toContain("if: steps.freshness.outputs.needs_import == 'true'")
    expect(watchdog).toContain('gh workflow run import-facebook.yml --ref master -f dry_run=false')
    expect(watchdog).toContain('for attempt in 1 2 3')
    expect(watchdog).not.toContain('GEMINI_API_KEY')
    expect(watchdog).not.toContain('playwright')
  })

  it('builds Pages from menu changes and from the bot repository dispatch', async () => {
    const deploy = await workflow('deploy-pages.yml')

    expect(deploy).toContain('- data/current-menu.json')
    expect(deploy).toContain('repository_dispatch:')
    expect(deploy).toContain('types: [menu-published]')
    expect(deploy).toContain('run: npm run build')
    expect(deploy).toContain('uses: actions/deploy-pages@v4')
    expect(deploy).not.toContain('GEMINI_API_KEY')
  })
})
