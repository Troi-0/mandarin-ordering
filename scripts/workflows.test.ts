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

  it('keeps Facebook dry runs unpublished and deploys only a successful pushed import', async () => {
    const importer = await workflow('import-facebook.yml')

    expect(importer).toContain('timezone: Europe/Sofia')
    expect(importer).toContain('IMPORT_DRY_RUN: ${{ inputs.dry_run }}')
    expect(importer).toContain('menu-import-dry-run-${{ github.run_id }}')
    expect(importer).toContain("if: ${{ always() && !inputs.dry_run }}")
    expect(importer).toContain(
      "if: steps.importer.outcome == 'success' && steps.menu_commit.outputs.pushed == 'true'",
    )
    expect(importer).toContain('-f event_type=menu-published')
    expect(importer).toContain("if: steps.importer.outcome == 'failure'")
  })

  it('uses the same validation and publication gate for manual inbox imports', async () => {
    const importer = await workflow('import-manual.yml')

    expect(importer).toContain('manual-inbox/*.png')
    expect(importer).toContain('GEMINI_API_KEY: ${{ secrets.GEMINI_API_KEY }}')
    expect(importer).toContain('run: npm run import:manual -- "${{ steps.image.outputs.path }}"')
    expect(importer).toContain(
      "if: steps.importer.outcome == 'success' && steps.menu_commit.outputs.pushed == 'true'",
    )
    expect(importer).toContain('-f event_type=menu-published')
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
