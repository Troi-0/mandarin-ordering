# Cloudflare-only scheduler cutover audit — 2026-09-27

## Change scope

The owner requested removing the GitHub watchdog and explicitly confirmed removing
both GitHub schedules so Cloudflare becomes the sole automated daily scheduler.
The change removes `recover-missed-import.yml`, its three unused TypeScript files,
and the Facebook importer's `schedule` block. `workflow_dispatch`, manual-inbox
imports, fail-closed verification, and Pages reconciliation remain.

The hosted watchdog is also disabled, preserving its historical runs. No
Cloudflare code, configuration, secrets, plan, or resources are changed. No local
service or recurring process is introduced. The pre-change GitHub `master` commit
was `ea1aee0e31b0119ec1e1675592309d7552db7cda`. An unrelated untracked `CLAUDE.md`
was preserved and excluded from the change.

## Cloudflare control plane and recent execution

Read through the configured Cloudflare API on 2026-09-27:

- Account: `dd2e5f3aa7d0fdf50daa0589602e2fe2`.
- Worker: `mandarin-ordering-scheduler`.
- Active version: `2ddc5cda-9509-4914-b9e5-4036083e052b`, 100% allocation.
- Cron: `7,22,37,52 5-11 * * MON-FRI`; code gates weekday Sofia time.
- Logs and traces enabled with full sampling; invocation logs persisted.
- Public `workers.dev` and preview URLs disabled.
- GitHub App identifiers match repository configuration; required private-key
  secret binding exists. Its value was not retrieved.

Read-only historical telemetry queries (`dry: true`) returned:

| Publishing date | Cron invocations | Recorded outcome | Decisions | Maximum CPU | CPU over 10 ms |
| --- | --- | --- | --- | --- | --- |
| 2026-09-24 | 28 | all `ok` | 2 `stale`, 20 `ready`, 6 `outside-window` | 20 ms | 19 |
| 2026-09-25 | 28 | all `ok` | 3 `stale`, 19 `attempts-exhausted`, 6 `outside-window` | 17 ms | 20 |

On September 24, Cloudflare first dispatched a safely failed import, then
[run 35961879237](https://github.com/Troi-0/mandarin-ordering/actions/runs/35961879237),
which published menu commit `9a593ac2409a767f5ea9263b29ced25d11a3e3e7`.
[Pages run 35962171483](https://github.com/Troi-0/mandarin-ordering/actions/runs/35962171483)
succeeded for that exact commit. Subsequent Cron decisions were `ready`.

On September 25, Cloudflare dispatched runs
[36099343811](https://github.com/Troi-0/mandarin-ordering/actions/runs/36099343811),
[36100396350](https://github.com/Troi-0/mandarin-ordering/actions/runs/36100396350), and
[36101475847](https://github.com/Troi-0/mandarin-ordering/actions/runs/36101475847).
All failed, so it correctly stopped at three failures. The separate GitHub
schedule and watchdog later added two more attempts. The final
[watchdog run](https://github.com/Troi-0/mandarin-ordering/actions/runs/36131029427)
explicitly dispatched
[import run 36131042488](https://github.com/Troi-0/mandarin-ordering/actions/runs/36131042488),
which exhausted Gemini 503 retries during blind verification without replacing
`current-menu.json`.

## Local verification and live browser behavior

`npm run check` passed using Node 24.19.0 and the existing exact dependency installs:
zero-cost validation, lint, root coverage (129 tests), menu validation, application
build, scheduler generated types and typechecks, scheduler coverage (87 tests),
workerd integration (3 tests), and a dry-run Worker bundle. The workflow regression
contract rejects any GitHub schedule and requires the watchdog workflow to be absent.

The live [site](https://troi-0.github.io/mandarin-ordering/) loaded over HTTPS and
rendered the Bulgarian Sunday closure for September 27 with the next menu on
Monday, September 28. It did not expose September 24's stale menu for ordering.

Hosted CI, default-branch removal, disabled watchdog state, and an exact-commit
Pages run must be checked after pushing this cutover. A successful build alone
cannot prove those hosted states.

## Remaining verification limits

- Post-cutover weekday operation is pending: September 27 is Sunday. Check the
  next two publishing weekdays for App-dispatched imports, exact-commit Pages
  publication, subsequent `ready`, and no native GitHub scheduled imports.
- CPU margin remains unresolved: 39 of 56 recent invocations exceeded the
  documented Free 10 ms limit despite successful outcomes. The current billing
  subscription could not be read with the configured integration (authentication
  error); `usage_model: standard` does not establish the billing plan. No paid
  upgrade is authorized or performed.
- September 25's menu was never approved/published. GitHub's current menu still
  dates from September 24. Schedule removal does not fix rejected OCR or upstream
  Gemini availability.
- There is no independent scheduled GitHub freshness check after removal. An
  outage that prevents Cloudflare from dispatching does not start a failed
  GitHub run and therefore does not produce its failure notification.

## Rollback

Revert the cutover commit and re-enable `recover-missed-import.yml` through
`gh workflow enable recover-missed-import.yml --repo Troi-0/mandarin-ordering`.
For immediate recovery, manually dispatch the Facebook importer with
`dry_run=false` after resolving the underlying problem. Do not edit menu data or
bypass verification to manufacture recovery.
