# Review: Round 12 ticket 42ka delta

- Date: 2026-11-14
- Mode: Standard, one reviewer; report only, no commit
- Repository: `dsh-context-handoff`
- Feature: `forced-rollover-vcc`
- Base/head: `e514b56` through [`a76265c`](https://github.com/scratchspace-mortang/dsh-context-rollover/commit/a76265c2cb379b8416b59bc35b51f1fcf535861f)
- Scope: The ticket-42ka delta in four files: `README.md`, `tests/readme-check.mjs`, `tests/mutation-check.sh`, `tests/forced-rollover-e2e.spec.ts`. Commits `02cdf05`, `71ae432`, `e05929e`, `a5afa7e`, `b072b5e`, `a76265c`.
- Threat model: Ordinary documentation and test-verifier regressions; no hostile writers.
- Round: 12
- Publication: Report only; no comments or tracker updates published.

## Findings

### [P2] The e2e test fabricates the TypeError class - [tests/forced-rollover-e2e.spec.ts:752-761](</home/wilder/git-repos/dsh-context-handoff/tests/forced-rollover-e2e.spec.ts#L752-L761>)

The README promises a `TypeError` for overlapping roots, but the integration test does not observe the thrown object. The lifecycle catches it, logs only `error.message`, and the test's `refusalText` adds the `TypeError:` prefix to any matching message. A plain `Error` with the same text therefore passes the class assertion. The production source currently constructs a `TypeError`, but the test does not pin that contract. Evidence: test lines 731-736, 758-761; pinned source `src/index.ts:183-187,458-460`; README lines 574-577.

Probe: passed the same message from `new Error(...)` and `new TypeError(...)` through a copy of the exact `refusalText` body.
Output: `REFUSAL_HELPER_Error=TypeError: context-rollover: notesDir /notes resolves to /notes/x`; `REFUSAL_HELPER_TypeError=TypeError: context-rollover: notesDir /notes resolves to /notes/x`.

Fix: assert the real error instance at a test seam before the lifecycle catch, while keeping the integration test for the logged message and no-notes-access behavior; verify a plain-Error mutant fails the TypeError test.

### [P2] The README mutation test does not protect compiler-key guards - [tests/mutation-check.sh:257-286,320-338](</home/wilder/git-repos/dsh-context-handoff/tests/mutation-check.sh#L257-L286>)

The fourth check's hard-coded anchor list omits the eight compiler-key rows and runs the checker on only the compiled-copy section. If the `COMPILER_KEYS` enforcement loop is removed from `tests/readme-check.mjs:99-105`, the fourth check still satisfies its broken-section, missing-section, and real-README predicates. That leaves the README key-presence guarantee unpinned despite the checker comment claiming every section assertion is mutation-tested (`tests/readme-check.mjs:11-13`) and the README claiming it rejects any removed anchored key, tool, or word (`README.md:587-591`).

Probe: a Node harness removed the `COMPILER_KEYS` loop from an extracted checker copy, rebuilt the runner's exact eight-anchor, section-only input, and evaluated its broken/missing/real criteria. The current checker on a full README with the `checkpointCap` row removed was also run.
Output: `LOST_KEY_EXIT=1`, `LOST_KEY_NAMES_CHECKPOINTCAP=true`; `FOURTH_CHECK_WITH_COMPILER_KEY_GUARDS_REMOVED=PASS`, with mutant statuses `broken section=1`, `missing section=1`, `real README=0`.

Fix: exercise each compiler-key row and each global assertion on a full README copy, one removal per run, and require the corresponding key-specific failure; rerun `bash tests/mutation-check.sh` after the concurrent writer is done.

## Prior findings and requested probes

- Round 1 false mutation kill: resolved by `b072b5e`. The final runner translates Vitest's matcher names to summary prose and anchors both marker and matcher checks to arrow lines (`tests/mutation-check.sh:211-245`). The three recorded mutation logs match the intended summaries: `to contain '<compacted-checkpoint>'`, `to be greater than 0`, and `to be less than 10652`. The former unrelated `toBe` failure with `CHECKPOINT_OPEN_TAG` only in its code frame has no match under the final arrow-line patterns.
- Round 1 README checker contradiction and the round-2 label-after, pronoun, and semicolon forms: resolved. Both `e05929e` and `a5afa7e` checkers accept the pinned README (exit 0) and reject all four appended forms (each exit 1). The output names the automatic-path claim for each case. The `a5afa7e` helper split preserved those outcomes.
- Round 1 unmarked-elision finding: resolved by README wording at `README.md:529-536`; the copy now distinguishes cuts/truncations with positions from content left out and recovered from the replaced span.
- Round 1 search-override finding: resolved at `README.md:557`; pinned `src/tools.ts:588-604` gives `recall` a `max_tokens` argument, while `src/tools.ts:648-653` gives `search` only `query` and `src/tools.ts:663-665` uses the configured budget.
- Round 1 TypeError finding: overturned the earlier rejection and upheld as finding 1. The lifecycle's message-only log does not make the fabricated type assertion valid; it means the current test cannot verify the documented class.
- Round 1 absent-leaf finding: rejected. The final fixture at `tests/forced-rollover-e2e.spec.ts:643-662` creates a handoff symlink to `real-notes-base`, uses the disjoint lexical names `handoff-link` and `real-notes-base`, and leaves the session leaf absent. Probe output using the production path-overlap rule: `ABSENT_LEAF_LEXICAL_OVERLAP=false`, `ABSENT_LEAF_CANONICAL_OVERLAP=true`, `ABSENT_LEAF_EXISTS=false`.
- Round 2 HMR `patchReload` finding: resolved. The README now says patch files are watched at exact paths and recompose live, with no toggle (`README.md:633-641`). Host `HmrConfig` exposes only `base`, `root`, `ignored`, and `debounce` (`packages/boot/hmr/src/index.ts:51-60,90-100`); `index.ts:214-236` registers `profile.patchPath` and `PROFILE_PATCH_FILENAME`; `watch-config.ts:37-49,53-73` watches the exact patch path. `patchReload` has no matches in either the pinned README or HMR package.
- The fourth README check does reject a single removed anchored word: removing `frame` from a pinned README made the checker exit 1 and report `the compiled-copy section never names the framed guarantee`. However, the key-loop mutant above shows the fourth check does not cover every asserted anchor.
- The final `a76265c` spec removes the tautological `toHaveLength(logPositions.length)` and retains `expect(logPositions.length).toBeGreaterThan(0)`. The orchestrator reported 6/6 e2e tests on that tree.

The external contradiction fixture exits 1 and reports `clause 327 attaches a notes checkpoint to the automatic path: At the rollover point the engine commits a notes checkpoint` (plus two independent failures).

## Scope and scans

`git show --stat` confirmed these commit scopes: `02cdf05` changed the four files; `71ae432` changed README only; `e05929e` changed README and the checker; `a5afa7e` changed the checker only; `b072b5e` changed the mutation runner only; `a76265c` removed one assertion from the e2e spec. `git diff --name-only e514b56..a76265c` lists exactly the four requested files; no `src/` or `packages/` production path changed. The pinned HEAD and repository HEAD both resolved to `a76265c`.

Static scan on the four final extracted files: `cccc --no-config --table --min 10` exited 0, analyzed 2 parsable files and 68 functions; maximum cognitive score 11 and cyclomatic score 14. Lizard size pass exited 0 but printed one warning: `crossWithHandoff` is 81 lines against the 80-line threshold (CCN 1); dismissed as a one-line test-helper crossing, non-actionable. Lizard duplicate pass exited 0 with 0.00% duplicates.

The reviewer did not run the mutation script or the e2e spec; the orchestrator supplied exit 0 with all four checks killed, and the e2e result. The reviewer read the pinned mutation logs and independently checked the final matching patterns.

## Serious unresolved risks

Round 11's report says its required independent cross-family verifier did not run because no authorized different-family route was available; its separate review gate remains open (`docs/work/forced-rollover-vcc/reviews/11-review.md:71`). That recorded gap does not independently withhold this ticket verdict.

## Verdict

VERDICT: request changes
