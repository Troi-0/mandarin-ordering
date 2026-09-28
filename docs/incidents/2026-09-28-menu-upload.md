# Menu upload incident — 2026-09-28

## Observed

- Cloudflare dispatched the Facebook importer at 08:38, 08:53, and 09:08 Sofia.
  [Run 36382759919](https://github.com/Troi-0/mandarin-ordering/actions/runs/36382759919)
  exhausted retries on Gemini 3.8 HTTP 503, reporting that the model was under
  high demand. [Runs 36383835385](https://github.com/Troi-0/mandarin-ordering/actions/runs/36383835385)
  and [36384953707](https://github.com/Troi-0/mandarin-ordering/actions/runs/36384953707)
  received a mix of 503 and 429 responses; their final 429 bodies reported the
  free-tier request quota metric with limit 20. All failed during the first
  transcription, after Facebook image retrieval.
- The scheduler's three-failure Sofia-day budget then prevented another
  automatic import. A manually dispatched
  [run 36416988731](https://github.com/Troi-0/mandarin-ordering/actions/runs/36416988731)
  at 14:39 Sofia, after Google's midnight Pacific reset, still received six
  Gemini 3.8 HTTP 503 high-demand responses. It made no menu or review commit.
- One further manual
  [retry 36419222898](https://github.com/Troi-0/mandarin-ordering/actions/runs/36419222898)
  at 15:02 Sofia received eleven more Gemini 3.8 HTTP 503 responses across its
  transcription attempts. It also made no menu or review commit.
- The hosted `current-menu.json` remained dated 2026-09-24. No 2026-09-28 menu
  was published. The browser's Sofia-date gate keeps stale menu data unavailable.
- On September 27, seven manually dispatched model benchmarks shared the
  production `GEMINI_API_KEY`. Their reports show widespread 503 responses;
  the three Gemini 3.8 low/high runs completed one of six fixture cases safely.
  The benchmark calls' exact share of the 429 quota consumption is not visible
  from the available GitHub logs.

## Repair

- Keep the existing `GEMINI_API_KEY` for live imports, benchmarks, and dry runs.
  [Google documents limits per project](https://ai.google.dev/gemini-api/docs/rate-limits),
  so another key in the same project would share its quota.
- Allow one extra scheduler dispatch after the Pacific daily quota reset only
  when all three failed runs on that Sofia day completed before the reset.
  The additional attempt stays within the existing Sofia publishing window.
  A fourth failure closes the import budget for that day.
- After bounded Gemini 3.8 availability retries, try 3.7 Flash, then 3.6
  Flash on the same free-tier key. Keep a successful fallback for the remaining
  transcription passes and record the actual models used. The two independent
  passes and fail-closed agreement gate still control publication.

Google documents that requests-per-day quotas reset at midnight Pacific and
that model capacity and active limits can vary. The scheduler retry and model
fallback improve recovery, but cannot guarantee capacity or bypass a project
quota. The fail-closed transcription gate remains in force.
