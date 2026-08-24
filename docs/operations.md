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

The only allowed model is `gemini-3.1-flash-lite`. The importer sends only the
already-public restaurant menu image to Gemini. It never receives visitor names,
selections, or browser data.

## Daily behavior

The scheduled workflow checks from 08:00 through 11:30 every 30 minutes in the
`Europe/Sofia` timezone. It reads the newest Page-authored Facebook image post by
its embedded creation timestamp, rejects anything not dated today in Sofia, then
runs separate extraction and verification requests.

Once today's menu is ready, later scheduled runs exit before opening Facebook or
calling Gemini. A changed, fully validated menu is committed to `data/menus/` and
`data/current-menu.json`. A rejected result may create `data/review/YYYY-MM-DD.json`
for a collaborator to inspect, but it cannot become the current menu.

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
