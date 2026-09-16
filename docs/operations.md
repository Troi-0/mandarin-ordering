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

From Monday through Friday, the [Cloudflare scheduler](#cloudflare-scheduler)
checks every 15 minutes from 08:37 through 13:52 Sofia time and dispatches the
importer when today's menu or its Pages deployment is missing. Until its proof
period ends, GitHub's own schedules remain as fallbacks. The importer workflow is
scheduled at 08:07, 08:22, 08:37, and 08:52, repeating that staggered cadence
through 11:52 in the `Europe/Sofia` timezone, although GitHub has been creating
about one of those runs per weekday, hours late. A second workflow uses a separate
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

When those full-image passes do not approve, the importer makes one final
focused close inspection of the original pixels, with explicit attention to
leading price digits and text crossing decorative artwork. It publishes only if
that focused transcript contains no uncertainty and exactly matches one of the
two earlier transcripts on categories, item counts, portions, and every price.
It does not average, infer, or merge conflicting values. A failed, uncertain, or
third distinct result remains rejected and all available evidence is saved for
manual review. Benchmark runs intentionally skip this recovery so they continue
to measure the configured pair of model passes against the human reference.

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

## Cloudflare scheduler

GitHub documents scheduled Actions as best-effort, and in practice that has not
been good enough for a menu posted at 08:30. From late August 2026 GitHub created
roughly one scheduled run per workflow per weekday instead of the 16 importer and
12 watchdog slots, and each arrived 1-5 hours late: typically 12:30-13:30 Sofia for
the importer and 14:00-15:30 for the watchdog, after the site's 11:00 cutoff.

The schedule-only Cloudflare Worker in `workers/menu-scheduler/` is therefore the
authoritative trigger. It only decides and dispatches: all Facebook, Gemini,
validation, commit, and Pages work stays in GitHub Actions. It has no HTTP handler,
no route, `workers_dev: false`, and `preview_urls: false`, and never runs on a
maintainer's computer.

### What each invocation does

Cloudflare Cron is UTC-only, so the trigger `7,22,37,52 5-11 * * MON-FRI` is
deliberately broad (28 invocations per weekday) and the Worker gates on
`Europe/Sofia` civil time. It acts from 08:37 through 13:59 Sofia on weekdays, which
is 22 eligible checks in both summer and winter time. Every archived menu was
posted at 08:30:0x, so earlier dispatches could only report that no post exists.

Outside that window it returns `outside-window` without any network request.
Inside it:

1. It signs a nine-minute RS256 JWT with the GitHub App private key (issued-at
   backdated 60 seconds for clock drift) and exchanges it for an installation
   token re-scoped to this one repository ID with only `actions: write` and
   `contents: read`. It rejects a token response with any other permission or
   repository, or a token outside the RFC 6750 bearer character set. Installation
   tokens are variable-length since GitHub's stateless `ghs_APPID_JWT` rollout.
2. It reads the `master` SHA, then reads `data/current-menu.json` at that
   immutable SHA through the Contents API.
3. It queries active import and Pages runs by each active status, so an older
   waiting run cannot hide behind newer completed runs, plus successful Pages
   runs for that exact SHA and today's completed importer runs from Sofia
   midnight.
4. It decides:

| Result | Meaning |
| --- | --- |
| `import-active` / `pages-active` | Work already in progress; nothing dispatched. |
| `ready` | Today's plausible menu is on a commit with a successful exact-SHA Pages run. |
| `attempts-exhausted` | Three importer runs failed, timed out, or failed to start today. The Worker stops dispatching so a persistent Facebook or OCR failure cannot turn into an all-day storm of Playwright scrapes, free Gemini calls, and review-draft commits. Fix the cause, then dispatch the importer manually. |
| `stale` / `pages-missing` | The importer is dispatched once with `{"ref":"master","inputs":{"dry_run":"false"}}`; the Worker validates and logs the returned run URL. |

The failure count includes every importer run on `master` today, including a
maintainer's failed dry runs. A day spent debugging with dry runs can therefore
also stop automatic dispatch; dispatch manually after the fix.

The dispatch contract uses `X-GitHub-Api-Version: 2026-03-10`. A successful
response is HTTP 200 with `workflow_run_id` and `html_url`. Dispatch is not retried
within an invocation: after an ambiguous response, the next Cron checks active runs
first. The `menu-import` concurrency group prevents simultaneous imports, although
it cannot make the cross-provider check and dispatch atomic.

Each invocation writes one structured JSON line with only `event`,
`scheduledTime`, `sofiaDate`, `outcome`, `reason`, `dispatch`, `runUrl` (when
dispatched), `durationMs`, or on failure a message authored by the Worker. Unknown
errors are replaced with `Unexpected scheduler failure` before logging so that a
response snippet can never reach the logs. The invocation is then rejected so
Cloudflare records it as failed. Traces record outbound URLs and only the
`content-type`, `content-length`, and `accept` headers, never `Authorization`, and
no URL carries a secret.

### One-time GitHub App registration

The Worker authenticates as a private GitHub App rather than a personal access
token: installation tokens last one hour, nothing expires on a calendar, and every
dispatched run is attributed to the App.

1. **Settings → Developer settings → GitHub Apps → New GitHub App** on the
   `Troi-0` account.
   - Name: `troi-0-mandarin-menu-scheduler`.
   - Homepage URL: `https://github.com/Troi-0/mandarin-ordering`.
   - Leave **Request user authorization (OAuth) during installation** and
     **Enable Device Flow** unselected, and deselect webhook **Active**.
   - Repository permissions: **Actions: Read and write** and
     **Contents: Read-only**. Metadata is read-only automatically. Grant no
     account permissions.
   - **Where can this GitHub App be installed?** → **Only on this account**.
2. Record the **Client ID** (not the numeric App ID) from the App's settings page.
3. **Install App** → **Only select repositories** → `mandarin-ordering`. The
   installation ID is the number at the end of the resulting
   `https://github.com/settings/installations/<id>` URL.
4. Put the client ID and installation ID into `vars` in
   `workers/menu-scheduler/wrangler.json`, run `npm run types` in that directory,
   and commit. They are identifiers, not secrets. The scheduler's configuration test
   fails, and so does its deploy build, until both are real values. Reinstalling
   the App changes the installation ID.
5. Under **Private keys**, click **Generate a private key**. GitHub downloads a
   PKCS#1 `.pem` once and cannot download it again.

### First deployment

A Worker with `secrets.required` cannot be created without its secret, and
`wrangler secret put` cannot target a Worker that does not exist yet. The first
deploy therefore uploads code and key together. Run this from a clean, pushed
commit on a trusted machine:

```sh
cd workers/menu-scheduler
npm ci
npm run check
npx wrangler login
openssl pkcs8 -topk8 -nocrypt -in ~/Downloads/<downloaded-key>.pem \
  | jq -Rs '{GITHUB_APP_PRIVATE_KEY_PKCS8: .}' \
  | npx wrangler deploy --secrets-file /dev/stdin
```

The key only moves through pipes: never through a command argument, environment
variable, `.dev.vars`, tracked file, chat, or log. Wrangler detects the JSON format
from the piped content. Afterwards, delete the downloaded `.pem`. A lost key is
replaced by generating a new one, not by keeping a copy. `npx` resolves the Wrangler
version pinned in the scheduler's lockfile.

Then confirm:

- `npx wrangler deployments list` shows the version for the pushed commit.
- `npx wrangler secret list` lists `GITHUB_APP_PRIVATE_KEY_PKCS8`. Never retrieve
  its value.
- **Workers & Pages → mandarin-ordering-scheduler → Settings** shows the exact Cron,
  no routes or custom domains, `workers.dev` and preview URLs disabled, and logs and
  traces enabled. Cron changes can take up to 15 minutes to propagate, and
  **View events** can lag by up to 30 minutes.

### Continuous deployment with Workers Builds

Connecting the existing Worker to Workers Builds keeps the deployed version equal to
`master` without storing a Cloudflare credential in GitHub:

- **Settings → Build → Connect**: GitHub, `Troi-0/mandarin-ordering`, branch
  `master`. Install the **Cloudflare Workers & Pages** GitHub App with **Only select
  repositories**; it is a second third-party App with access to this repository.
- Root directory: `workers/menu-scheduler`. Dependencies install from its own
  lockfile, and the image's default Node 24 matches CI.
- Build command: `npm run check`. It verifies generated types, type-checks, runs
  unit tests with coverage and the workerd integration test, and bundles.
- Deploy command: `npm run deploy`.
- Non-production branch builds: disabled.
- Build watch paths: include `workers/menu-scheduler/*`.

Workers Builds creates a user API token by default with Workers Scripts, KV, R2, and
all-zone Workers Routes edit permissions. Only user tokens are supported. It lives in
Cloudflare rather than GitHub. Narrowing it under **My Profile → API Tokens** is
optional hardening; restore the defaults if a build then fails to authorize.

Workers Builds on Free allows 3,000 build minutes a month and one concurrent build.
A `wrangler rollback` lasts only until the next watched push to `master` redeploys.

### Proof, cutover, and rollback

The GitHub schedules stay in place, unchanged, until the Worker has proven itself.
They already fire hours after the Worker's checks, so no offset is needed, and runs
the Worker dispatches are distinguishable because their actor is
`troi-0-mandarin-menu-scheduler[bot]`.

Accept the Worker when a real publishing weekday shows all of the following:

1. Past Cron Events and a safe structured log line.
2. A dispatched run attributed to the App.
3. An approved import commit.
4. A successful Pages run for that exact commit.
5. The correct Sofia-date menu live on the site.
6. The following Cron reporting `ready` without another dispatch.

Never alter menu data to force a stale state; on a day without a menu post, keep
monitoring.

Then remove only the importer's `schedule` block, keeping `workflow_dispatch`, and
monitor the next two weekdays. Keep the watchdog's schedule. It needs no Gemini key
or Playwright, and even arriving hours late it can still rescue a day on which
Cloudflare, the App, or a deploy failed. GitHub also emails workflow failures, which
makes it the only free alert in this design.

To roll back, revert the schedule-removal commit and dispatch the importer manually
if today's menu is still missing.

### Key rotation and retirement

An App can hold up to 25 private keys at once, and keys never expire. To rotate:

1. Generate a new key.
2. Replace the Worker secret:

   ```sh
   openssl pkcs8 -topk8 -nocrypt -in ~/Downloads/<new-key>.pem \
     | jq -Rs '{GITHUB_APP_PRIVATE_KEY_PKCS8: .}' \
     | npx wrangler secret bulk
   ```

3. Confirm the next in-window invocation logs `outcome: ok`.
4. Delete the old key in the App settings.

If the scheduler is retired, delete the Worker and the GitHub App together.

### Free-plan boundaries

Workers Free allows 100,000 requests/day, 50 external subrequests per invocation,
and 10 ms CPU per invocation. The Worker uses 28 invocations per weekday and at most
16 subrequests: token, SHA, menu, ten active-run queries, exact Pages, today's
imports, and dispatch. Tests assert that count. A configured `limits` block is only
supported on the Standard usage model, so none is set. Network waiting is not CPU,
but check deployed CPU time after the first real runs. Workers Logs on Free keep
three days.

The scheduler package pins Wrangler to the version `@cloudflare/vitest-pool-workers`
depends on so tests and deploys share one workerd runtime. It also overrides `sharp`
to a patched release; Miniflare uses `sharp` only for local image simulation, which
this Worker does not use. It is a separate package so the importer, Pages, and root
installs never download the 130 MB workerd binary. The existing zero-cost check
scans both manifests but does not inspect Cloudflare or Gemini billing settings;
verify those in each provider.

Cloudflare outages or free limits, App key revocation, GitHub API or runner outages,
and Facebook or Gemini failures can still prevent a publication. Logs make failures
inspectable; the watchdog schedule is what raises an alert.

## Safe live test

Run **Import today's Facebook menu** manually from the Actions tab and leave the
**Run Facebook, Gemini, and validation without publishing anything** checkbox
selected. This bypasses the already-ready shortcut and exercises the real public
Facebook retrieval, both full-image Gemini passes, the conditional focused pass,
schema checks, and deterministic menu invariants. It never commits or replaces
menu data.

The run uploads `menu-import-dry-run-<run id>` for three days. An approved report
contains the candidate menu, both full-image transcripts, and their deterministic
comparison. When focused recovery was needed, the report also includes the
initial disagreement, focused transcript, certainty flag, and which earlier pass
it matched. A rejected report contains the available transcripts and exact
disagreement list. A rejected dry run intentionally finishes red.

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

## What visitors see without a menu

The page never shows a menu from another day, so it explains the gap instead. It
picks the explanation from the visitor's own Sofia clock, with no build, commit,
or workflow run involved, which is what makes it work on days when the importer
itself never ran:

- Saturday and Sunday: the restaurant rest day, naming the next working day.
- A working day before 11:00 Sofia: the menu is still expected.
- A working day from 11:00 Sofia: no menu was published today, with the Facebook
  Page linked so visitors can check for themselves.

Every archived menu was posted at 08:30:0x Sofia by an automated Page post, so
11:00 is roughly two and a half hours of margin. The wording deliberately does
not blame the restaurant: the import pipeline has historically been the later of
the two, and the page cannot tell the difference. Move
`MENU_OVERDUE_SOFIA_HOUR` in `src/lib/date.ts` to change the cutoff.

## Days without a menu post

A weekday with no menu is ordinary: the restaurant can be closed, on holiday, or
simply late. The importer reports this as the successful outcome `no-menu-post`,
writes nothing, skips Pages reconciliation, and records the reason in the run
summary. Keeping those runs green is what makes a red run mean something.

The outcome is chosen from what the feed actually contained:

- Page-authored story records were read and none carries a menu image, or the
  newest image post is not from today in Sofia: `no-menu-post`, run stays green.
- No Page-authored story record was read at all: the feed is unreadable, so the
  run fails. Facebook markup changes, blocks, and empty responses land here.
- A Page post carries Facebook-CDN media that no longer resolves to exactly one
  photo: the run fails. This is the guard against a silent shape change, and it
  also covers an ambiguous multi-photo post.

An explicitly targeted benchmark still fails when its post cannot be found;
a dry run is an assertion that a specific post is readable.

A long run of `no-menu-post` days is visible in the Actions list and on the live
site, which keeps showing the unavailable screen. Confirm against the Page itself
before assuming the importer is at fault.

## Failure and cost boundaries

- If Facebook markup becomes unreadable, Gemini is unavailable, the free quota is
  exhausted, or focused consensus cannot safely resolve uncertain extraction, the
  workflow fails without replacing the menu.
- Direct Gemini calls retry transient network failures plus 408, 429, and 5xx
  responses at most five times with bounded exponential backoff, jitter, and
  `Retry-After` support. They never switch models or paid service tiers;
  permanent errors and exhausted retries still fail closed.
- The browser checks the Sofia date independently. A stale embedded menu renders
  an unavailable screen and cannot be selected or shared.
- GitHub may disable scheduled workflows in a public repository after 60 days
  without repository activity. Re-enable the workflow from the Actions tab if
  needed.
- GitHub documents scheduled Actions as best-effort, and its runs have arrived
  hours late, so the Cloudflare scheduler is authoritative. The UTC watchdog
  schedule stays as a late, independent backstop and alert;
  **workflow_dispatch** remains the free manual fallback if both providers are
  unavailable.
- If GitHub Pages, standard public-repository runners, or the Gemini free tier
  stops being free, disable the affected workflow. Do not add a metered fallback.
