# Phase 12D — CCH final report-control compatibility

Date: 2026-10-19  
Recommendation: **HOLD pending browser-suite verification.** The parser and accounting checks pass; the local browser runner did not complete.

## Scope and recovery

The Phase 12C read-only production-parser audit and consolidated proposal were reviewed before editing. A recovery checkpoint of the original parser and CCH test file was created outside the production project in the private Phase 12D work area; its copies were hash-verified. The project has no local `.git` checkout, so this is a file recovery checkpoint, not a Git commit. Original client workbooks remained read-only and outside the project. A temporary private audit harness was removed after execution; neither client paths nor workbook data remain in application source or tests.

## Exact correction

Only the Published CCH parser and its synthetic tests changed. The parser now accepts `SumAccountGroups_B` immediately after a closed group and adjacent `NetIncomeLoss_B` / `NetIncomeLoss` ending, then accepts `SumAccountGroups` on the next row. The spacer must be marker-only. The total must carry the exact report label, have typed numeric balance controls at the discovered header columns, and be zero to cent precision. Tiny binary residuals below half a cent are permitted. Formulas, errors, account data, unexpected cells, nonzero cent balances, missing/reversed pairs, controls inside the account table, and nonblank trailing rows block import. The pair is counted as report controls and is never projected as a posting account or included in leadcode totals. Existing `AD_`, `SG_`, `_JE_`, `NetIncomeLoss`, and unknown-row handling remains in place.

Files modified:

- `src/parsers/publishedCCH.ts`
- `src/tests/publishedCCH.test.ts`
- `docs/PHASE12D_CCH_CONTROL_FIX_REPORT.md` (this report)

No GL parser, matching, reconciliation, workbook output, UI, or deployment file was edited. Nothing was pushed or deployed.

## Original-workbook results

The production Excel adapter and current CCH parser processed all 15 original workbooks read-only. File IDs below follow the filename sort order in the private Phase 12C audit; client names and financial values are intentionally excluded from this project report. The full private audit found zero blocking errors and zero source/parser differences in account number, description, leadcode, leadcode description, source row, and unadjusted cents. After the final boundary guard, all 15 were rerun and again had zero blocking errors with source-row account inventories and counts preserved. Counts agree with the independent validation matrix.

| Private file ID | Import | Accounts | Leadcodes on accounts | JE details excluded | Subgroup subtotals checked |
| ---: | --- | ---: | ---: | ---: | ---: |
| 01 | PASS | 559 | 86 | 48 | 186 |
| 02 | PASS | 358 | 98 | 19 | 186 |
| 03 | PASS | 500 | 99 | 20 | 186 |
| 04 | PASS | 430 | 76 | 11 | 186 |
| 05 | PASS | 350 | 99 | 67 | 186 |
| 06 | PASS | 219 | 80 | 15 | 189 |
| 07 | PASS | 203 | 31 | 28 | 186 |
| 08 | PASS | 237 | 97 | 83 | 186 |
| 09 | PASS | 158 | 47 | 21 | 187 |
| 10 | PASS | 669 | 90 | 24 | 186 |
| 11 | PASS | 203 | 58 | 96 | 186 |
| 12 | PASS | 159 | 71 | 28 | 186 |
| 13 | PASS | 465 | 115 | 14 | 186 |
| 14 | PASS | 230 | 73 | 12 | 186 |
| 15 | PASS | 165 | 78 | 32 | 186 |
| **Total** | **15 PASS** | **4,905** | — | **518** | **2,794** |

All 2,794 source subgroup `UNADJ` subtotals equal the sum of preceding posting-account rows within their subgroup at cent precision. All 518 JE detail rows are excluded from the posting-account inventory, with no double count. No posting accounts were missing or extra. The previously blocked five ending pairs now produce zero blocking errors. These checks do not establish GL/TB reconciliation or financial statement presentation.

## Regression and build

- Synthetic Published CCH tests: **59 passed, 0 failed**, including valid final pair, missing/reversed markers, controls inside the table, trailing data, contaminated controls, sub-cent residuals, and unknown rows.
- Full unit inventory, executed one test file per process because the combined Vitest worker run failed with a temporary-file `ENOENT` environment error: **616 passed, 0 failed, 47 pre-existing optional reference-fixture skips** across 30 test files. The combined runner itself did **not** pass; no test assertion failure was observed in the isolated runs. The CCH synthetic suite was rerun after the final boundary guard and passed again.
- TypeScript no-emit check: **PASS**.
- Vite production build: **PASS**.
- Full Playwright run: **not verified**. It exceeded the local tool's 300-second execution limit without a final result. A targeted rerun then failed during web-server startup because port 4173 was reported in use. No browser test result is claimed from that run.

## Remaining exception and next action

There are **no known parser or accounting exceptions** in the 15-file audit. Browser acceptance remains unverified in this environment. Resolve the local Playwright server/port condition, rerun the full browser suite, and review any failures before approval to publish. Do not deploy from this report alone.
