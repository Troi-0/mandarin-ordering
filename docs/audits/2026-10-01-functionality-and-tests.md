# Mandarin Ordering functionality and test audit

Audit started 30 September and completed 1 October 2026, Europe/Sofia.
Original audited source and GitHub master: `f62f8b02d780b229da5b56b2db71ebdb57f3efa8`.
Live site: https://troi-0.github.io/mandarin-ordering/.

## Follow-up fixes — 1 October 2026

F1 (Pages release gate), F3 (remembered-name opt-out across tabs), and F4 (unsaved favorites across tabs) are fixed and verified locally, in real browser tabs, and through hosted release-gate checks. The code release is `2d5014d96669889d7194c6062aa5440c545fd0af` (following `34d586d`). The original audit evidence below is retained as a baseline.

- **Pages:** Every push, manual run and menu repository-dispatch now installs both packages and runs the complete `npm run check` before uploading `dist`. The deploy job requires this successful build job. The checks and artifact use one checkout; no condition or continue-on-error bypasses this gate. The separate Validate workflow remains in place for PRs.
- **Remembered name:** Explicit consent is kept in `mandarin-remember-name-v1`, separately from the existing saved-name key. Opt-out writes a durable false marker and removes the saved name. Old saved names remain readable. Name edits cannot write consent; they verify it before and after saving, including an interleaved opt-out or clear. Storage events synchronize the checkbox without replacing the current basket name. Only a fresh checkbox opt-in enables remembering again. Opt-out always attempts saved-name deletion even when a full store refuses its marker. If either write or cleanup is refused, the warning reports that limitation.
- **Favorites:** Failed additions and removals remain pending per dish. Events merge the latest saved list with that local intent, retain the warning, and do not echo ordinary storage writes. An external clear removes saved favorites while preserving unsaved choices for the current page. The next heart action retries the merged list, including absent-menu favorites; pending changes and the warning are cleared only after a successful save. Web Storage is not a general transactional multi-tab basket store.
- **Complete verification:** Final `npm run check` passed with **334 tests** (240 root, 91 scheduler unit, 3 workerd), lint, zero-cost policy, menu validation, TypeScript, production build and Worker dry-run bundle. Root coverage: 90.54% lines, 83.33% branches, 89.49% statements, 94.59% functions. Scheduler coverage remains 99.41% lines / 94.89% branches.
- **Regression evidence:** Twelve assertions failed before fixes (including the existing Pages contract changed to require checks). The final suite adds 16 cases over the 318-test baseline, covering failed add/remove, external add/remove/clear, failed event reads, pre-event edits, explicit re-opt-in, blocked storage recovery, legacy-name writes after opt-out, interleaved opt-out/clear, and failed name writes. The full check log is linked below.
- **Hosted positive control:** [Validate 36780816889](https://github.com/Troi-0/mandarin-ordering/actions/runs/36780816889) and [Pages 36780817044](https://github.com/Troi-0/mandarin-ordering/actions/runs/36780817044) succeeded for exactly `2d5014d96669889d7194c6062aa5440c545fd0af`. In Pages, `npm run check` succeeded before configure/upload, followed by successful deployment.
- **Hosted negative control:** A temporary branch based on that release added one deliberately failing behavioral test, without merging it. [Manual Pages run 36781062466](https://github.com/Troi-0/mandarin-ordering/actions/runs/36781062466), SHA `5f3818474af030367eaea98b6fef807194912b99`, failed specifically on that assertion (240 other root tests passed). Its check step failed, configure/upload steps were skipped, the deploy job was skipped, and the artifact API returned **zero artifacts**. The test branch/worktree are removed after verification; the failing fixture is not in master.
- **Live artifact proof:** The live `index.html`, `assets/index-EjKpO_1A.js`, and `assets/index-mpu7ZYoE.css` match the successful Pages artifact byte for byte. JavaScript SHA-256: `9d174aa56f2f57e113d112804537c8939812ba741b5c0424be1f1fa795773886`; it includes the new name-consent marker. A fresh live browser shows October 1's waiting state with no console warnings/errors. Today's menu is not yet available, so post-deployment menu interactions were not claimed.
- **Browser evidence:** Real separate tabs on an isolated `127.0.0.1` origin verified opt-out → edit in another tab → fresh tab remains opted out, failed favorite add/remove → another tab's update → retained local intent and warning, then successful saving and reload. Favorite storage errors were deliberately simulated in a temporary local fixture using the production MenuApp component. The fixture used a synthetic menu because October 1's production page correctly shows waiting for today's menu; no menu data/date was changed. Temporary fixture files and server are removed after testing. These are local component-in-browser checks, not claims of live-menu interaction after deployment.

Current remaining findings: **F2, F5, F6, F7 and F8**. Browser CI, screen-reader/share-sheet validation, importer orchestration coverage and reviewed OCR fixtures also remain recommended test improvements.

External behavior was checked through Context7 against current [GitHub Actions job dependencies](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax#jobsjob_idneeds) and [MDN storage events](https://developer.mozilla.org/en-US/docs/Web/API/Window/storage_event). React 19.2 / Vitest 4.1 APIs already used in the repository were retained.

## Original assessment

The normal ordering-helper flows work, and the suite has meaningful failure-path coverage. It is not yet justified to say every feature meets the applicable standards or every important edge case is covered. The audit found four state/release problems, two accessibility gaps, an intentional OCR validation limitation, and a smaller copy-recovery focus gap. Six additional probes failed against the originally audited code; they are separate from the passing repository suite.

During the original audit, no application, workflow, or menu source was changed. Temporary probes were removed from the repository and retained alongside this report. The pre-existing untracked CLAUDE.md was preserved. No import, provider request, deployment, or scheduler change was triggered.

## Original audit verification

- `npm run check`: passed. This includes zero-cost checks, lint, menu validation, TypeScript, production build, coverage thresholds, Worker generated-type checking, Worker runtime tests, and a dry-run Worker bundle.
- Existing tests: **318 passed**: 224 app/importer/workflow tests, 91 scheduler unit tests, and 3 workerd runtime tests.
- Root suite coverage: 90.14% lines, 82.76% branches, 89% statements, 94.41% functions.
- Scheduler unit coverage: 99.41% lines and 94.89% branches. Runtime tests run in workerd, with mocked GitHub requests.
- GitHub [Validate](https://github.com/Troi-0/mandarin-ordering/actions/runs/36770574209) and [Pages](https://github.com/Troi-0/mandarin-ordering/actions/runs/36770574176) both succeeded for the audited SHA. This confirms this release, not a mandatory validation gate for future releases.
- Current live browser checks passed for search/no matches, retained hidden selections, exact totals, basket editing/removal, required-name focus, Copy, reload draft/name recovery, Clear/Undo, sticky category shortcuts, favorite toggling, mobile dialog focus/Tab wrapping/Escape, and scroll locking. No warning/error console entries were observed. Desktop and 390px phone layouts were inspected.
- Cross-tab name opt-out and open-tab expiry were reproduced in the live browser. The audit crossed actual Sofia midnight: the existing tab retained September 30's menu; a new tab showed October 1's waiting screen.
- Native phone share targets, actual screen-reader announcements, other browser engines, and the current Cloudflare control-plane deployment/logs were not independently exercised in this audit. Provider and transport errors in unit tests are simulated; the audit does not establish that an OCR provider always reads a source image correctly.

## Features and existing coverage

| Functionality | Implementation and tests | Assessment / remaining coverage |
|---|---|---|
| Today's menu, prices, portions, categories and source links | Schema validation plus build-time invariants; EUR integer cents; category/menu rendering and disclaimer tests | Normal flow passes. Names are not part of OCR agreement; see F7. |
| Weekend closure, next Monday, weekday waiting and 11:00 overdue state | Sofia timezone; DST/midnight/year-boundary tests; Saturday/Sunday and cutoff rendering tests | Initial page loading is covered. Changes in an already-open page are not; F2. Holidays are not implemented as closures and are not claimed to be. |
| Quantities and exact totals | Menu and basket controls; 0–20 bounds; integer-cent calculations; absent/removed dish handling | Strong normal and boundary coverage. Add real-browser checks with many lines and a short viewport. |
| Direct basket editing/removal | Menu and basket quantities stay aligned; removal and repricing tested in desktop/mobile views | Normal flows pass. |
| Clear and Undo | Quantities/name/note restore; new selection expires Undo; remembered-name retention is tested | Normal flows pass. Name-preference changes during pending Undo and cross-tab draft conflicts need explicit product policy/tests. |
| Discreet search | Bulgarian case-insensitive, whitespace-separated terms, independent word order; empty categories hidden; selected dishes retained in basket/copy | Matching/no-results/Clear tests pass. Empty-result accessibility status is missing; F6. Price and selected-only filters were intentionally removed at the user's request. |
| Sticky category navigation | Sticky CSS on desktop and mobile; horizontal overflow; category scroll offsets | Manual browser evidence passes. No CI tests protect layout, scrolling, zoom, or breakpoint behavior. |
| Mobile basket dialog | Native showModal, title focus, Tab wrapping, Escape/backdrop/close, return focus, breakpoint cleanup, body scroll restoration | Normal behavior agrees with [W3C modal guidance](https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/). Component tests shim showModal/close, so native inertness/top-layer behavior is not proved by CI. |
| Copy and manual recovery | Validated name/selection; Clipboard API errors; checked legacy-copy result; selectable fallback; obsolete results discarded on basket edits | Strong tests for standard success/failure paths. Closing/reopening or resizing while Copy is pending needs coverage; F8. Copy-button contrast fails; F5. |
| Phone sharing | Feature detection, direct user-triggered call, shared/copy summary equality, empty/name validation, cancellation/error handling, duplicate prevention and stale result suppression | Source follows [MDN Web Share behavior](https://developer.mozilla.org/en-US/docs/Web/API/Navigator/share). Tests mock the API. Add InvalidStateError/TypeError and browser/OS cancellation checks; successful handoff does not confirm delivery. |
| Same-day draft recovery and corrected menus | Safe storage access; malformed records, invalid quantities, obsolete IDs, price corrections, changed name/portion, date expiry, blocked/full storage | 100% measured lines/branches in storage.ts. A stale open tab can still overwrite a newer day's shared draft; address expiry first. Multi-tab basket synchronization is not implemented. |
| Remember your name | Opt-in device/browser storage; next-day restoration without quantities/notes; trim, opt-out and storage-failure tests | Resolved in this follow-up: device-level consent synchronization and guarded updates; F3. Current basket names remain independent. |
| Hearts and returning favorites | Stable normalized full-name identity; NFC/case/spacing; independent of date/price/portion/IDs; missing-day retention; accessible aria-pressed controls; tab synchronization | Ordinary behavior is well tested; favorites.ts has 100% measured lines/branches. Resolved in this follow-up: pending additions/removals reconcile with storage events and retain the warning until saved; F4. Differently named variants intentionally stay separate. |
| Automatic Facebook image import | Correct Page/post/photo association; dimensions/CDN/conflict validation; stale/no-image handling; manual image path and size guards | Useful fixture tests. Facebook download/viewer/browser orchestration remains partly untested; facebook.ts line coverage is 68.91%. |
| OCR validation and retry recovery | Two passes, uncertainty gates, focused consensus, manual-review drafts, free model fallback, bounded backoff/Retry-After, dry-run/human benchmark | Many failure scenarios are tested. Numerical agreement is not proof of name accuracy or malformed source-price detection; F7. |
| Pages reconciliation | Exact-SHA check, missing deployment, status failures, bounded network/dispatch retries, short/long rate limits | Existing cases pass; module branch coverage is 71.42%. Add malformed JSON/response, transport rejection and exhausted rate-limit combinations. |
| Weekday scheduler | Sofia/DST windows; weekend no-network behavior; active-run suppression; separate import/Pages budgets; Pacific reset attempt; scoped App token/JWT; sanitized logs | Strong unit coverage plus real workerd/WebCrypto tests. Awaited scheduled work and UTC cron handling agree with [Cloudflare scheduled-handler docs](https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/) and [Cron docs](https://developers.cloudflare.com/workers/configuration/cron-triggers/). Live scheduler state was not refreshed here. |
| Release pipeline | CI validates; Pages builds and deploys separately | Resolved in this follow-up: the complete checks gate artifact upload and deployment for every publishing trigger; F1. |

## Findings and recommended changes

### F1 — Resolved: Pages publishing now requires the complete checks

Source: [deploy-pages.yml](/Users/hristo/projects/mandarin-ordering/.github/workflows/deploy-pages.yml:44), [workflow regression](/Users/hristo/projects/mandarin-ordering/scripts/workflows.test.ts:101).

Previously, Pages ran only `npm run build` while behavioral validation ran separately. Pages now runs `npm run check`, which also builds the artifact, in the publishing workflow itself. Default GitHub success gating prevents artifact upload after a failed step and skips the deploy job when its required build fails. This applies equally to push, workflow_dispatch and repository_dispatch. Contract tests protect the dependency, single checkout, complete dependencies, check-before-upload ordering and absence of conditional/failure bypasses. The hosted positive and negative controls above independently confirm successful publication and failed-test → skipped artifact/deploy behavior.

### F2 — P2: An open page does not expire its menu

Source: [App.tsx](/Users/hristo/projects/mandarin-ordering/src/App.tsx:736).

The current-day guard runs when App renders. No timer, visibility/focus handler, or submission-time date check invalidates a page left open across midnight. Child basket interactions do not rerender the parent date guard. The same pattern leaves a morning waiting page unchanged after the 11:00 cutoff until reload.

The additional test advances the clock from September 30 at 23:59 Sofia to October 1 at 00:01, then emits focus and visibilitychange; the old menu remains. The live audit independently observed the old menu in the open tab and the correct waiting state in a fresh tab after midnight.

Revalidate on resume and at relevant time boundaries, and refuse Copy/Share for an expired menu. Test midnight, Friday→Saturday, Sunday→Monday, 10:59→11:00, and DST boundaries without remounting. Treat fetching a newly published menu as a separate refresh behavior; the current page embeds its menu at build time.

### F3 — Resolved: Stale name edits cannot re-enable remembering

Source: [name storage](/Users/hristo/projects/mandarin-ordering/src/lib/storage.ts:15), [tab synchronization](/Users/hristo/projects/mandarin-ordering/src/App.tsx:224).

The former effect wrote the preference from stale local checkbox state. Explicit consent now has its own durable marker, and only the checkbox handler writes that marker. Name edits read the current preference, update only an existing opt-in, then recheck for a concurrent opt-out/clear. A stale legacy-name write cannot override the false marker. Event handlers reread the current stored preference so older queued events do not substitute obsolete values. Mounting or receiving a storage event does not save the current basket name over another tab's remembered name.

Regression cases cover remove/clear before event delivery, consent changes without clobbering the basket, blocked reads and recovery, explicit re-opt-in, a different same-day draft on mount, legacy stale writes, read/write failure, and opt-out/clear interleaved between read and write. Real browser tabs independently passed the opt-out/edit/fresh-load sequence.

### F4 — Resolved: Unsaved favorite edits survive external storage changes

Source: [favorite reconciliation](/Users/hristo/projects/mandarin-ordering/src/lib/favorites.ts:16), [tab synchronization](/Users/hristo/projects/mandarin-ordering/src/App.tsx:253).

The former handler replaced all in-memory favorites with the saved list, losing failed local edits. Pending per-name additions and removal intents are now overlaid on the latest saved list. External clear removes saved entries but preserves pending intent. Failed reads retain current choices. A successful read alone does not dismiss the unsaved warning. The next explicit heart action retries the merged list; only a successful write clears pending intent and the warning.

Regression cases cover failed additions and removals, external additions/removals including absent-menu dishes, key removal/clear, event-read failure, changes received before their event, no ordinary event write echo, save recovery and reload. Real tabs passed both failed-add and failed-remove sequences with tab-scoped storage-error simulation, plus successful recovery.

### F5 — P2: Orange-button text fails WCAG contrast

Source: [styles.css](/Users/hristo/projects/mandarin-ordering/src/styles.css:141), root orange at line 11.

The normal Copy button uses white text on #f36f2a. The relative-luminance calculation gives **2.9502:1**, below the **4.5:1** requirement for ordinary text. Even the 3:1 large-text threshold is not met. Its darker hover background #c84815 gives 4.7796:1; relying on hover does not correct the normal state. The orange hero text needs the same contrast review.

Choose a sufficiently dark button background or a suitable dark text color, and review normal/focus/hover hero and button states. Add a real-browser accessibility check. Reference: [WCAG 1.4.3](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). This finding comes from declared CSS colors and calculation, not screenshot pixel sampling.

### F6 — P2: The no-results message lacks accessible status semantics

Source: [App.tsx](/Users/hristo/projects/mandarin-ordering/src/App.tsx:630).

Typing an unmatched search adds “Няма намерени ястия” without moving focus, but the message has no status/live-region semantics. A probe verifying that semantics fails. [WCAG 4.1.3](https://www.w3.org/WAI/WCAG22/Understanding/status-messages.html) specifically distinguishes a search results list from the brief no-results status message.

Use an appropriate persistent polite status region for the result status. It can be visually hidden to preserve the requested discreet search. Test no matches, recovery to matches, and Clear, then verify announcements with a screen reader.

### F7 — P2 policy decision: OCR agreement deliberately ignores dish names

Source: [gemini.ts](/Users/hristo/projects/mandarin-ordering/scripts/lib/gemini.ts:715), [gemini.test.ts](/Users/hristo/projects/mandarin-ordering/scripts/lib/gemini.test.ts:535).

The comparator checks category structure, corresponding item positions, portions, prices, and uncertainty, but does not compare item names. An existing test explicitly requires name differences to be ignored. The additional stricter-policy probe changes “Пилешка супа” to “Супа от морски дарове” at the same price/portion and still receives approved=true.

This is not a regression against the current price-focused contract. It is a limitation relevant to copied dish names and favorite identity. Decide whether materially different names must trigger review while allowing harmless punctuation/case/spacing variations. Then update both the contract and tests. The output schema also stores only numeric cents, so matching numbers alone cannot independently prove that a malformed printed price was unambiguous. Preserving raw printed price text and a mandatory ambiguity flag would enable a stronger guard; actual source-image benchmarks are needed as well.

### F8 — P3: Delayed copy recovery is not focused after reopening the basket

Source: [App.tsx](/Users/hristo/projects/mandarin-ordering/src/App.tsx:309).

Start Copy in the mobile dialog, close it before the clipboard promise rejects, then reopen it. The fallback summary is visible, but the focus/select effect ran while its mobile field was absent. Reopening focuses the dialog heading rather than the recovery field. Manual recovery remains usable through its Select all button, so this is a smaller usability/test gap.

Choose either to discard results for a closed view or to focus/select the recovery field when it becomes visible. Add close/reopen, mobile→desktop resize, and corrected-menu remount cases with pending clipboard promises.

## Test additions in priority order

1. Completed and verified in this follow-up: publishing requires successful checks for its checkout, including dispatch/manual paths. Hosted success and deliberately failing-check evidence are recorded above.
2. Promote the reproduced state/accessibility probes into regression tests alongside each fix. The OCR probe requires a deliberate change to the existing validation policy.
3. Add CI browser smoke tests in Chromium and WebKit: selection→basket→Copy, draft/name/favorite reload, mobile dialog inertness/Escape/focus, failed copy recovery, tab preference changes, sticky anchors, and 320/390/900/901px breakpoints. Include a short desktop viewport and many basket lines.
4. Add accessibility checks for contrast, status announcements and focus. Automated checks should be complemented by a real screen-reader pass, zoom and reduced-motion checks.
5. Test the Facebook download/viewer/fallback orchestration with bounded mocked HTTP/browser failures, and add the missing Pages response/retry combinations. Avoid live provider calls in ordinary CI.
6. Keep human-reviewed image fixtures for name and ambiguous-price scenarios. Numerical schema validation and 100% unit coverage cannot prove source-image transcription accuracy.

## Evidence files

- [Release Pages job/step evidence](/private/tmp/mandarin-audit-2026-09-30/release-pages.json)
- [Negative-control job/step evidence](/private/tmp/mandarin-audit-2026-09-30/negative-pages.json)
- [Negative-control assertion failure](/private/tmp/mandarin-audit-2026-09-30/negative-pages-failure.log)
- [Live artifact checksums](/private/tmp/mandarin-audit-2026-09-30/live-artifact-verification.json)
- [Fix verification log](/private/tmp/mandarin-audit-2026-09-30/fixes-check.log)
- [Pre-fix selected regressions](/private/tmp/mandarin-audit-2026-09-30/selected-before-fixes.log)
- [Favorites retained after another tab updated storage](/private/tmp/mandarin-audit-2026-09-30/favorites-tab-recovery.png)
- [Original full passing check log](/private/tmp/mandarin-audit-2026-09-30/check.log)
- [Six failing edge-case probes](/private/tmp/mandarin-audit-2026-09-30/edge-probes.test.tsx)
- [Probe failure log](/private/tmp/mandarin-audit-2026-09-30/probes.log)
- [Mobile browser check](/private/tmp/mandarin-audit-2026-09-30/mobile-check.png)
- [Open-tab menu after midnight](/private/tmp/mandarin-audit-2026-09-30/open-tab-after-midnight.png)

To replay the probes, copy edge-probes.test.tsx to src/audit-edge-probes.test.tsx, run `npm test -- src/audit-edge-probes.test.tsx`, then remove that temporary file. Their assertions encode proposed stronger behavior and failed before these fixes; they were not part of the passing 318-test baseline. F3 and F4 are now protected by passing repository regressions; the other probe scenarios remain open. The OCR probe requires a policy decision.
