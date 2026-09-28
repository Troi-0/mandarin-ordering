import { readFile, readdir } from 'node:fs/promises'
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
    expect(ci).toContain('run: npm ci --prefix workers/menu-scheduler')
    expect(ci).toContain('workers/menu-scheduler/package-lock.json')
    expect(ci).toContain('run: npm run check')
    expect(ci).not.toContain('GEMINI_API_KEY')
  })

  it('keeps Facebook dry runs unpublished and reconciles every successful live import', async () => {
    const importer = await workflow('import-facebook.yml')

    expect(importer).toContain('workflow_dispatch:')
    expect(importer).not.toContain('schedule:')
    expect(importer).toContain('contents: write\n  actions: read')
    expect(importer).toContain('IMPORT_DRY_RUN: ${{ inputs.dry_run }}')
    expect(importer).toContain('GEMINI_PRODUCTION_API_KEY: ${{ !inputs.dry_run && secrets.GEMINI_API_KEY }}')
    expect(importer).toContain('GEMINI_BENCHMARK_API_KEY: ${{ inputs.dry_run && secrets.GEMINI_BENCHMARK_API_KEY }}')
    expect(importer).toContain('GEMINI_API_KEY="$GEMINI_BENCHMARK_API_KEY"')
    expect(importer).toContain('GEMINI_API_KEY="$GEMINI_PRODUCTION_API_KEY"')
    expect(importer).toContain('IMPORT_BENCHMARK_IMAGE: ${{ inputs.benchmark_image_path }}')
    expect(importer).toContain('menu-import-dry-run-${{ github.run_id }}')
    expect(importer).toContain('uses: actions/upload-artifact@v7')
    expect(importer).toContain("if: ${{ always() && !inputs.dry_run }}")
    expect(importer).toContain(
      "if: steps.importer.outcome == 'success' && !inputs.dry_run && steps.importer.outputs.outcome != 'no-menu-post'",
    )
    expect(importer).toContain("if: steps.importer.outputs.outcome == 'no-menu-post'")
    expect(importer).toContain('GITHUB_STEP_SUMMARY')
    expect(importer).toContain('run: npm run reconcile:pages')
    expect(importer).not.toContain('menu_commit.outputs.pushed')
    expect(importer).not.toContain('gh api --method POST')
    expect(importer).toContain("if: steps.importer.outcome == 'failure'")
  })

  it('uses the same validation and publication gate for manual inbox imports', async () => {
    const importer = await workflow('import-manual.yml')

    expect(importer).toContain('manual-inbox/*.png')
    expect(importer).toContain('contents: write\n  actions: read')
    expect(importer).toContain("GEMINI_PRODUCTION_API_KEY: ${{ (github.event_name != 'workflow_dispatch' || !inputs.dry_run) && secrets.GEMINI_API_KEY }}")
    expect(importer).toContain("GEMINI_BENCHMARK_API_KEY: ${{ github.event_name == 'workflow_dispatch' && inputs.dry_run && secrets.GEMINI_BENCHMARK_API_KEY }}")
    expect(importer).toContain('GEMINI_API_KEY="$GEMINI_BENCHMARK_API_KEY"')
    expect(importer).toContain('GEMINI_API_KEY="$GEMINI_PRODUCTION_API_KEY"')
    expect(importer).toContain("IMPORT_DRY_RUN: ${{ github.event_name == 'workflow_dispatch' && inputs.dry_run }}")
    expect(importer).toContain('manual-menu-dry-run-${{ github.run_id }}')
    expect(importer).toContain('uses: actions/upload-artifact@v7')
    expect(importer).toContain('npm run import:manual -- "${{ steps.image.outputs.path }}"')
    expect(importer).toContain("if: ${{ always() && (github.event_name != 'workflow_dispatch' || !inputs.dry_run) }}")
    expect(importer).toContain("if: ${{ steps.importer.outcome == 'success' && (github.event_name != 'workflow_dispatch' || !inputs.dry_run) }}")
    expect(importer).toContain('run: npm run reconcile:pages')
    expect(importer).not.toContain('menu_commit.outputs.pushed')
  })

  it('keeps model benchmarking manual, read-only, and artifact-backed', async () => {
    const benchmark = await workflow('benchmark-gemini.yml')

    expect(benchmark).toContain('workflow_dispatch:')
    expect(benchmark).not.toContain('schedule:')
    expect(benchmark).toContain('permissions:\n  contents: read')
    expect(benchmark).toContain('GEMINI_API_KEY: ${{ secrets.GEMINI_BENCHMARK_API_KEY }}')
    expect(benchmark).not.toContain('secrets.GEMINI_API_KEY')
    expect(benchmark).toContain('GEMINI_BENCHMARK_CONFIG: ${{ inputs.configuration }}')
    expect(benchmark).toContain('npm run benchmark:gemini')
    expect(benchmark).toContain('if: always()')
    expect(benchmark).toContain('gemini-benchmark-${{ inputs.configuration }}-${{ github.run_id }}')
    expect(benchmark).not.toContain('git push')
  })

  it('leaves daily scheduling exclusively to Cloudflare', async () => {
    const names = await readdir('.github/workflows')

    expect(names).not.toContain('recover-missed-import.yml')
    for (const name of names.filter((name) => /\.ya?ml$/.test(name))) {
      expect(await workflow(name), name).not.toMatch(/^\s+schedule:/m)
    }
  })

  it('builds Pages from menu changes and from the bot repository dispatch', async () => {
    const deploy = await workflow('deploy-pages.yml')

    expect(deploy).toContain('- data/current-menu.json')
    expect(deploy).toContain('repository_dispatch:')
    expect(deploy).toContain('types: [menu-published]')
    expect(deploy).toContain('run: npm run build')
    expect(deploy).toContain('uses: actions/configure-pages@v6')
    expect(deploy).toContain('uses: actions/upload-pages-artifact@v5')
    expect(deploy).toContain('uses: actions/deploy-pages@v5')
    expect(deploy).not.toContain('GEMINI_API_KEY')
  })
})
