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

The scheduled workflow checks from 08:00 through 11:30 every 30 minutes in the
`Europe/Sofia` timezone. It reads the newest Page-authored Facebook image post by
its embedded creation timestamp, rejects anything not dated today in Sofia, then
runs two independent image transcriptions. The second pass is blind: it never
receives the first pass. Code matches categories by normalized Bulgarian name
regardless of returned category order, then compares item order, exact names,
portions, and integer-cent prices and rejects every real disagreement.

Once today's menu is ready, later scheduled runs exit before opening Facebook or
calling Gemini. A changed, fully validated menu is committed to `data/menus/` and
`data/current-menu.json`. A rejected result may create `data/review/YYYY-MM-DD.json`
for a collaborator to inspect, but it cannot become the current menu.

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
and also compares every item name, portion, and price with the human reference.
Benchmark mode is accepted only during a dry run and can never publish data.

## Manual fallback

1. Download today's public Facebook menu image.
2. In GitHub's web interface, upload it to `manual-inbox/` with an exact Sofia
   date filename, for example `2026-08-24.png`.
3. The manual workflow runs the same extraction, verification, and deterministic
   validation. The API key stays inside Actions.
4. If validation fails, correct the committed review draft with GitHub's editor.
   Copy the corrected, complete `Menu` object to `data/menus/YYYY-MM-DD.json`,
   wrap the same object as `{ "status": "ready", "menu": ... }` in
   `data/current-menu.json`, and open a pull request. CI must pass before merging.

Never publish OCR-only text. Tesseract may help diagnose image readability, but
the real menu test showed corrupted Bulgarian names and missed sections.

## Failure and cost boundaries

- If Facebook markup changes, Gemini is unavailable, the free quota is exhausted,
  or extraction is uncertain, the workflow fails without replacing the menu.
- The browser checks the Sofia date independently. A stale embedded menu renders
  an unavailable screen and cannot be selected or shared.
- GitHub may disable scheduled workflows in a public repository after 60 days
  without repository activity. Re-enable the workflow from the Actions tab if
  needed.
- If GitHub Pages, standard public-repository runners, or the Gemini free tier
  stops being free, disable the affected workflow. Do not add a metered fallback.
