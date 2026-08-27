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
GitHub dropping a scheduled event under load. It parses Facebook's embedded JSON
and accepts an image
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
- Direct Gemini calls retry transient 408, 429, and 5xx responses at most twice
  with short exponential backoff. They never switch models or paid service tiers;
  permanent errors and exhausted retries still fail closed.
- The browser checks the Sofia date independently. A stale embedded menu renders
  an unavailable screen and cannot be selected or shared.
- GitHub may disable scheduled workflows in a public repository after 60 days
  without repository activity. Re-enable the workflow from the Actions tab if
  needed.
- GitHub documents scheduled Actions as best-effort: runs can be delayed or
  dropped under load. The staggered redundant schedule reduces that risk, and
  **workflow_dispatch** remains the free manual recovery if an entire morning is
  missed.
- If GitHub Pages, standard public-repository runners, or the Gemini free tier
  stops being free, disable the affected workflow. Do not add a metered fallback.
