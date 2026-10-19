# Phase 12D.1 — Browser verification

Date: 2026-10-19  
Recommendation: **PASS for controlled deployment preparation** based on the subsequent host PowerShell run documented below. No deployment has been performed.

## Port investigation

The existing Playwright configuration starts a Vite production preview at `127.0.0.1:4173` and a development server at `127.0.0.1:5173`. A direct Vite preview attempt and a direct TCP bind both report `EADDRINUSE` for 4173; direct binds to 5173 and a random local port succeed. The port conflict is therefore reproducible, but its owning process could **not** be established in this workspace. The available `netstat` view showed no listeners, Windows process-listing commands failed, and the Windows TCP ownership API returned access denied. Loopback HTTP connections also failed, including to a short-lived listener created and closed in the same test runtime. These visibility/connectivity limitations prevent a safe conclusion that a previous Vite or Playwright process owns 4173. No process was terminated on a guess.

No application code, parser, accounting calculation, workbook generation, test assertion, or Playwright configuration was modified. No temporary test artifact was deleted. The short-lived TCP diagnostic listeners were closed.

## Browser regression result

The configured suite lists **84 tests across three browser projects**. Running the complete suite with the existing configuration failed during `config.webServer` startup before any test began:

> Error: Process from config.webServer was not able to start. Exit code: 1  
> Vite preview: Port 4173 is already in use

| Result | Count |
| --- | ---: |
| Passed | 0 |
| Failed assertions | 0 |
| Skipped | 0 |
| Not executed because the web server could not start | 84 |

No individual test can be identified as a timeout source in this run: execution stopped before tests started. The Phase 12D earlier full-run timeout remains unresolved; this attempt encountered the port conflict immediately. The observed failure is environmental **at test startup**, not evidence of an application regression. It also is not evidence that the application passes browser regression.

## Production build

TypeScript `tsc --noEmit`: **PASS**. Vite production build: **PASS** (40 modules transformed; production assets emitted). This does not substitute for browser verification.

## Required next action

From a host session that can inspect local TCP/process ownership, identify the owner of 4173. Terminate it only if it is confirmed to be a stale server from this project; otherwise resolve the conflict without stopping an unrelated application. Then run the unmodified complete Playwright configuration and record passed, failed, and skipped counts. If the suite times out after it actually starts, identify the responsible tests and run them individually. Do not deploy until browser acceptance is complete.

## Resume attempt after confirmed port cleanup

The user reported that Vite preview process 29220 was stopped and port 4173 was free. A direct bind check in this workspace independently confirmed **both 4173 and 5173 free** before rerunning. The complete Playwright suite was launched with the existing configuration and `--workers=2`; no application code, assertions, configuration, or test timeout was changed.

The Vite preview child bound port 4173, but the test runner produced no test output and did not start the development server on 5173. Local HTTP requests to 4173 failed even after turn-scoped local network access was granted. This is consistent with the loopback connectivity limitation documented above, but the precise host/sandbox cause is unconfirmed. After more than two minutes with no test output, the Playwright process started for this attempt was stopped. A child still appeared to hold 4173 afterward; an attempt to terminate the known Playwright process tree through Windows `taskkill` failed in this workspace. No unknown process was terminated.

**Resume-attempt counts:** 0 passed, 0 failed assertions, 0 skipped, **84 not executed**. No specific browser test failed or timed out because execution did not reach a test. This is an environmental test-startup failure, not an observed application regression; browser acceptance is still unverified. The previous TypeScript and production-build PASS results above remain the last completed build checks; no application files were changed in this resume attempt.

**Updated recommendation: HOLD.** Inspect and clear only the confirmed project-owned listener on 4173 from a host session with process visibility, then run the unchanged complete Playwright suite from a runtime that can reach its own localhost Vite servers. Do not deploy until actual test results are available.

## Completed host PowerShell verification — supersedes the earlier HOLD

The user subsequently identified process 29220 as a Vite preview server, stopped it, and confirmed port 4173 free. From Windows PowerShell, the user started Vite preview directly with Node.js v24.19.0, received HTTP 200 at `http://127.0.0.1:4173/`, and ran the complete Playwright suite using the existing project configuration. The reported run completed in approximately 1 minute 6 seconds:

| Result | Count |
| --- | ---: |
| Total | 84 |
| Passed | 44 |
| Failed | 0 |
| Skipped | 40 |

The local `test-results/.last-run.json` retained `status: "passed"` and an empty `failedTests` list. Detailed per-test output from the host PowerShell run was not retained in this workspace; the counts above are the user's directly reported results, corroborated in aggregate by that status file.

### Review of all 40 skips

The existing suite contains 28 tests per project across `production`, `development`, and `chrome-production`. Its skip conditions account for exactly 40 expected skips:

| Existing skip condition | Per project | Across projects | Reason |
| --- | ---: | ---: | --- |
| Original external CCH/GL reference files (`ADG_REFERENCE_DIR`, with `ADG_FLAT_TB_PATH` where needed) | 11 | 33 | Optional original-file workflow and large-data checks; confidential source files remain outside the project. |
| Live GitHub Pages URL (`ADG_PAGES_URL`) | 1 | 3 | Live-site smoke test is not part of this local run. |
| Explicit QA workbook output plus reference files (`ADG_QA_WORKBOOK_PATH`, `ADG_REFERENCE_DIR`) | 1 | 3 | Optional saved-workbook visual QA. |
| Static production-asset test in the `development` project | — | 1 | Intentionally applies only to the two production browser projects. |
| **Total** | **13 optional per project** | **40** | |

These are conditional, environment-dependent skips in the unchanged test source, not newly skipped failures or weakened assertions. The 44 active tests provide local browser regression coverage across the configured projects; they do not execute the optional original-file or live-site checks. Separately, Phase 12D's read-only production-parser audit already passed all 15 original CCH workbooks, preserving 4,905 account rows and the independent accounting controls. No application defect was observed in the completed host run.

### Controlled deployment preparation

The Phase 12D parser correction is ready **for controlled GitHub Pages deployment preparation**, not already deployed. The production build and TypeScript check passed in Phase 12D.1; the existing GitHub Pages workflow and ignore rules remain unchanged and exclude spreadsheet files and generated `dist` output from source commits. Before any later push, the deployer must use the intended repository checkout, review the exact staged files and production bundle for confidential data, and run the authorized deployment and live-site smoke checks. This local project has no `.git` checkout, so no commit or push was attempted here.

**Final recommendation: PASS for controlled deployment preparation.** Await separate authorization to deploy; do not treat the optional live-site skip as live deployment verification.
