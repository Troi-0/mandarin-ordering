# Free operation guide

The production site is designed to run only on free services. It has no server,
database, analytics, payment SDK, hosted font, or order-submission endpoint.

## One-time setup

1. Keep this repository public and enable **Settings → Pages → Source: GitHub
   Actions**. The production address is
   `https://troi-0.github.io/mandarin-ordering/`.
2. In Google AI Studio, create a Gemini Developer API key in a project with no
   billing account attached. Add it as the repository Actions secret
   `GEMINI_API_KEY`. Never add a paid fallback or attach billing to that project.
3. Run **Deploy GitHub Pages** once from the Actions tab. After that, successful
   menu commits deploy automatically.

The only allowed model is `gemini-3.6-flash`. The importer sends only the
already-public restaurant menu image to Gemini. It never receives visitor names,
selections, or browser data.

## Daily behavior

From Monday through Friday, the scheduled workflow checks at 08:07, 08:22,
08:37, and 08:52, repeating that staggered cadence through 11:52 in the
`Europe/Sofia` timezone. These off-peak, 15-minute attempts reduce the chance of
GitHub dropping a scheduled event under load. A second workflow uses a separate
UTC schedule at minutes 13, 33, and 53 from 06:00 through 09:59 UTC. This maps to
09:13-12:53 in summer and 08:13-11:53 in winter. The cron itself defines the
recovery window: a runner that GitHub starts late still checks today's Sofia date
and can recover a stale menu instead of exiting successfully without dispatching.
This watchdog only reads and sanity-checks `data/current-menu.json`; it has no
Gemini key and does not install Playwright. When today's plausible menu is
missing, it retries dispatching the production importer up to three times. The
importer parses Facebook's embedded JSON and accepts an image
only when the same structured post record directly owns the post ID, creation
time, Mandarin House Page author, and one unambiguous Facebook CDN attachment.
It sorts those records by embedded creation time, rejects anything not dated
today in Sofia, then runs two independent image transcriptions. The second pass
is blind: it never receives the first pass. Code matches categories by normalized
Bulgarian name regardless of returned category order, then rejects uncertainty
and every item-count, portion, or integer-cent price disagreement. Item-name
spelling and whitespace differences are non-blocking; the extraction name is
displayed and both raw transcripts remain available in dry-run reports.

Once today's menu is ready, later scheduled runs exit before opening Facebook or
calling Gemini. A changed, fully validated menu is committed to `data/menus/` and
`data/current-menu.json`. Every successful live run then reconciles publication:
it checks for a successful Pages run on the exact checked-out commit and sends a
`menu-published` repository dispatch when one is absent. Transient dispatch errors
receive bounded retries; a later schedule retries again if the API call or Pages
deployment still fails. This explicit dispatch is required because GitHub does
not start another push-triggered workflow for commits made with the workflow
`GITHUB_TOKEN`. A rejected result may create `data/review/YYYY-MM-DD.json` for a
collaborator to inspect, but it cannot become the current menu and does not request
a deployment.

## Independent external scheduler

GitHub's two native schedules share one failure domain: if GitHub drops scheduled
events before creating workflow runs, neither workflow can repair the other. The
external fallback is the schedule-only Cloudflare Worker in
`workers/menu-scheduler/`. It has no HTTP handler or public route and does not run
on a maintainer's computer. Cloudflare invokes it every 15 minutes from 05:00
through 11:59 UTC on weekdays; the Worker applies the `Europe/Sofia` timezone and
only acts from 08:45 through 13:59 local time, so daylight-saving changes do not
shift the recovery window.

Each invocation reads the public `master` commit without authentication, then
reads the authoritative menu at that immutable SHA. Active import and Pages runs
are queried by each active status, so an older waiting run cannot be hidden behind
recent completed runs. Successful Pages runs are queried for that exact SHA.
It does nothing when today's plausible menu is on a
commit with a successful exact-commit Pages run, or while an import or Pages run
is already active. Otherwise it uses `workflow_dispatch` to start the existing
**Import today's Facebook menu** workflow. All Facebook, Gemini, validation,
commit, and Pages work remains inside GitHub Actions.

### One-time Cloudflare deployment

1. Obtain the maintainer's immediate confirmation before creating a GitHub token
   or submitting it to Cloudflare. Create a fine-grained personal access token owned by `Troi-0`, limited
   to only the `mandarin-ordering` repository, with **Actions: Read and write**
   and no additional repository permissions. This permission can dispatch any
   workflow in this repository, so do not reuse a broader token. Use a 366-day
   expiration if GitHub permits it, record the actual expiry, and rotate before it.
   GitHub includes read-only Metadata automatically. No Contents permission is
   needed because the public commit and raw menu requests carry no token.
2. Sign into or create a **Workers Free** account; no domain or paid subscription
   is required. Authenticate pinned Wrangler, validate the bundle, and deploy:

   ```sh
   npx wrangler@4.129.0 login
   npx wrangler@4.129.0 deploy --dry-run --config workers/menu-scheduler/wrangler.json
   npx wrangler@4.129.0 deploy --config workers/menu-scheduler/wrangler.json
   npx wrangler@4.129.0 secret put GITHUB_ACTIONS_TOKEN \
     --config workers/menu-scheduler/wrangler.json
   ```

   Enter the token only at Wrangler's secret prompt. Never place it in a command,
   `.env`, `.dev.vars`, GitHub variable, or tracked file. Cloudflare stores Worker
   secrets encrypted and does not expose their value after creation.
3. Confirm the deployed Worker is `mandarin-ordering-scheduler`, uses the Free
   plan, has `workers_dev: false`, `preview_urls: false`, no custom/public routes,
   and has observability/logs enabled with full sampling. Confirm the encrypted
   secret name exists using `npx wrangler@4.129.0 secret list --config
   workers/menu-scheduler/wrangler.json`; never retrieve its value.
4. In **Cloudflare Dashboard → Workers & Pages → mandarin-ordering-scheduler →
   Settings → Trigger Events**, confirm `*/15 5-11 * * MON-FRI`. Cron changes may
   take up to 15 minutes to propagate. **View events** shows scheduled executions;
   a new Worker's Past Cron Events display can lag by up to 30 minutes. Use
   Workers Logs for the structured result and errors. Local scheduled tests and
   a successful deploy do not prove the production Cron Trigger fired.
5. Expected successful results are `outside-window`, `ready`, `import-active`,
   `pages-active`, or `stale`/`pages-missing` with one returned GitHub run URL.
   Follow any dispatched run through importer outcome, exact commit, Pages run,
   and live site. Do not modify production menu data to force recovery.

For a Saturday deployment on September 5, 2026, no production Cron event is due
until Monday September 7 at 05:00 UTC (08:00 Sofia). The first three events should
report `outside-window`; 05:45 UTC (08:45 Sofia) is the first eligible recovery
check. In winter the first eligible event is 06:45 UTC. The last eligible event
is 10:45 UTC in summer and 11:45 UTC in winter. Document deployed configuration
separately from that still-pending weekday execution, and inspect Monday's events
and logs. Do not install a local scheduler to perform this check.

The dispatch contract uses `X-GitHub-Api-Version: 2026-03-10`, POST to
`/repos/Troi-0/mandarin-ordering/actions/workflows/import-facebook.yml/dispatches`,
and only `{"ref":"master","inputs":{"dry_run":"false"}}`. A successful response
is HTTP 200 with `workflow_run_id`, `run_url`, and `html_url`; the removed
`return_run_details` request field must not be sent. The Worker validates the
returned run identity and logs its URL. Lookup, timeout, and dispatch errors
reject the scheduled invocation visibly without logging upstream bodies or
credential-bearing request details. Dispatch is not retried within an invocation:
after an ambiguous response, the next Cron checks active runs first. The existing
GitHub `menu-import` concurrency group prevents simultaneous import execution,
although it cannot make the cross-provider check and dispatch atomic.

Official references, checked September 5, 2026:
- [GitHub dispatch contract](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event)
- [GitHub 2026-03-10 breaking changes](https://docs.github.com/en/rest/about-the-rest-api/breaking-changes)
- [Public commit access and Contents permission](https://docs.github.com/en/rest/commits/commits#get-a-commit)
- [Cloudflare Cron and event history](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [Preview URL configuration](https://developers.cloudflare.com/workers/versions-and-deployments/preview-urls/)
- [Workers Free limits](https://developers.cloudflare.com/workers/platform/limits/)

Deployment is an administrative action, not a persistent local process. The
source, schedule, and secret name are versioned here; the secret value exists only
in Cloudflare. Rotate the GitHub token before its expiry and immediately replace
the Worker secret. If the external fallback is retired, delete the Worker and
revoke the token together.

This uses one Cron Trigger and 28 invocations per weekday, with at most 14
subrequests per eligible invocation. Workers Free currently allows 100,000
requests/day, 50 subrequests/invocation, and 10 ms CPU/invocation. Network waiting
does not count as CPU, but actual deployed CPU must still be checked. Workers
Logs on Free retains three days of logs. No paid resource binding is configured.
The existing zero-cost check does not inspect Cloudflare billing or the Gemini
project's billing account; verify those provider settings independently.

The unauthenticated public commit lookup uses GitHub's 60 requests/hour/IP rate
limit, potentially shared with other Cloudflare traffic; a rate limit fails
visibly and the next Cron retries. Authenticated Actions calls use the token's
higher rate limit. If shared-IP limits prove problematic, explicitly approve
adding Contents: Read and authenticating the commit lookup. A GitHub App could
replace expiring PATs with short-lived installation tokens, but adds app setup,
private-key storage/rotation and token minting; it is not part of this PAT design.
Token expiry/revocation, Cloudflare outages/free limits, GitHub API or runner
outages, and Facebook/Gemini failures can still prevent recovery. Observability
makes failures inspectable; it does not itself send a proactive alert.

## Safe live test

Run **Import today's Facebook menu** manually from the Actions tab and leave the
**Run Facebook, Gemini, and validation without publishing anything** checkbox
selected. This bypasses the already-ready shortcut and exercises the real public
Facebook retrieval, both Gemini passes, schema checks, and deterministic menu
invariants. It never commits or replaces menu data.

The run uploads `menu-import-dry-run-<run id>` for three days. An approved report
contains the candidate menu, both blind transcripts, and their deterministic
comparison. A rejected report contains both transcripts and the exact disagreement
list. A rejected dry run intentionally finishes red.

To regression-test the model against the original human-verified 43-item menu,
set **Optional human-verified reference** to `data/menus/2026-08-24.json`. This
loads that reference's historical Facebook post, runs both live Gemini passes,
and also compares every category/item count, portion, and price with the human
reference.
Benchmark mode is accepted only during a dry run and can never publish data.
For a reproducible replay that does not depend on Facebook retaining historical
feed markup, also select the matching archived source image under
`test-fixtures/facebook/YYYY-MM-DD.jpg`. These fixtures are public menu images
from the referenced posts; the importer requires an exact date match and still
runs both live Gemini passes plus the human-reference comparison. Both checks
tolerate item-name spelling and whitespace differences, but reject uncertainty
or any category/item-count, portion, or price change. The human comparison also
tolerates singular/plural category-label changes while still pairing categories
deterministically.
If Facebook has rotated the post out of the Page feed, the targeted benchmark
may use the exact permalink's Open Graph image only when its canonical URL
contains both the expected Page ID and post ID and it exposes one Facebook-CDN
image. The trusted reference supplies the timestamp, and its numeric structure
still has to match before the benchmark can pass. This fallback is never used
for the untargeted daily import.

### Free Gemini configuration benchmark

The manually dispatched **Benchmark free Gemini menu OCR** workflow runs one
selected configuration on both archived human-verified menu images. Its choices
cover the production Gemini 3.6 control, Gemini 3.7 with low thinking and high
image resolution, plus Gemini 3.8 with low and medium thinking at both high and
per-image ultra-high resolution. Separate, short runs keep free-tier demand
failures attributable to the exact candidate. Benchmark calls do not retry so
availability problems are measured without blocking the full matrix; production
calls retain five bounded retries. Candidate model IDs are exact and allowlisted;
the workflow has read-only repository permission, cannot publish menu data, and
never changes the scheduled production configuration.

The uploaded `gemini-benchmark-<run id>` report retains both raw transcripts,
elapsed time, human-reference comparisons for both passes, the existing blind
cross-check, and exact item-name differences. A configuration passes the safety
gate only when both independent passes have no uncertainty and agree with each
other and the human reference on every category/item count, portion, and price.
Use the observed safety result first, then name accuracy and latency, before
changing the pinned production configuration.

If today's menu is already ready but Pages needs a manual recovery attempt, run
the same Facebook workflow with **dry run** unchecked. The importer will skip
Facebook and Gemini, then reconcile the current commit with Pages.

## Manual fallback

1. Download today's public Facebook menu image.
2. In GitHub's web interface, upload it to `manual-inbox/` with an exact Sofia
   date filename, for example `2026-08-24.png`.
3. The manual workflow runs the same extraction, verification, and deterministic
   validation. The API key stays inside Actions.
4. If validation fails, open the committed review draft and correct its
   `editableMenu` object with GitHub's editor. After checking every price against
   the image, change `validation.extractedBy` to `human-corrected`,
   `validation.verifiedBy` to `human-reviewed`, and
   `validation.uncertain` to `false`.
5. Copy that corrected `editableMenu` object to
   `data/menus/YYYY-MM-DD.json`, wrap the same object as
   `{ "status": "ready", "menu": ... }` in `data/current-menu.json`, and open
   a pull request. CI must pass before merging. The untouched fail-closed draft
   cannot pass the menu schema or be published accidentally.

Never publish OCR-only text. Tesseract may help diagnose image readability, but
the real menu test showed corrupted Bulgarian names and missed sections.

## Safe manual-image test

The manually dispatched **Import manually uploaded menu** workflow defaults to
**dry run**. It reads the selected `manual-inbox/YYYY-MM-DD.ext` image, performs
both live Gemini transcriptions, compares them, validates the candidate, and
uploads `manual-menu-dry-run-<run id>` for three days. It never commits menu
data or reconciles Pages while dry run is selected. Push-triggered inbox uploads
remain live imports, and unchecking dry run is an explicit publishing action.

## Failure and cost boundaries

- If Facebook markup changes, Gemini is unavailable, the free quota is exhausted,
  or extraction is uncertain, the workflow fails without replacing the menu.
- Direct Gemini calls retry transient network failures plus 408, 429, and 5xx
  responses at most five times with bounded exponential backoff, jitter, and
  `Retry-After` support. They never switch models or paid service tiers;
  permanent errors and exhausted retries still fail closed.
- The browser checks the Sofia date independently. A stale embedded menu renders
  an unavailable screen and cannot be selected or shared.
- GitHub may disable scheduled workflows in a public repository after 60 days
  without repository activity. Re-enable the workflow from the Actions tab if
  needed.
- GitHub documents scheduled Actions as best-effort: runs can be delayed or
  dropped under load. The primary Sofia schedule and independently defined UTC
  watchdog reduce that risk. The external Cloudflare schedule is the independent
  recovery path when GitHub misses both workflows; **workflow_dispatch** remains
  the free manual fallback if both providers are unavailable.
- If GitHub Pages, standard public-repository runners, or the Gemini free tier
  stops being free, disable the affected workflow. Do not add a metered fallback.
