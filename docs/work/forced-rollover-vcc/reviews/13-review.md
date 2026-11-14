# Review: Round 13 forced-rollover-vcc source-fix delta

- Date: 2026-11-14
- Mode: Standard, one reviewer as dispatched; report only
- Repository: `dsh-context-handoff`
- Feature: `forced-rollover-vcc`
- Base/head: [`a76265c`](https://github.com/scratchspace-mortang/dsh-context-rollover/commit/a76265c2cb379b8416b59bc35b51f1fcf535861f) to [`8dd7d59`](https://github.com/scratchspace-mortang/dsh-context-rollover/commit/8dd7d593a75d9d441e1ff9d4cc94476d1fb6ab16)
- Scope: `git diff a76265c..8dd7d59`; eight changed files: `src/index.ts`, `src/notes.ts`, `src/config.ts`, `tests/automatic-rollover.spec.ts`, `tests/forced-rollover-e2e.spec.ts`, `tests/rollover-reminder.spec.ts`, `tests/idle-reopen.spec.ts`, `tests/idle-watchdog.spec.ts`.
- Threat model: ordinary configuration mistakes and symlinked paths crossing the notes/handoff boundary; hostile concurrent writers are out of scope, as recorded in the round 11 report.
- Rounds: 13, delta re-review of the eight round-11 findings
- Publication: report only; no comments or tracker updates published

## Review basis

The checked-out HEAD matched the frozen commit, and the tracked index and worktree were clean. The orchestrator confirmed that unrelated untracked reports and scratch paths were outside this review. The reviewer changed no tracked repository files.

For findings 1-7, the load-bearing assessment is a source/test counterfactual: removing the specific guard or assertion would make the named test fail for the reason stated. The reviewer did not execute a mutated copy or `bash tests/mutation-check.sh`, which the task prohibited. Finding 8 changes a comment only, so no behavioral test is applicable.

## Findings

### [P1] RESOLVED - Reject symlinked note entries before traversal - [src/notes.ts:89-124](</home/wilder/git-repos/dsh-context-handoff/src/notes.ts#L89-L124>)

A note file or directory entry symlinked into the handoff tree must not make the automatic path stat, read, or render the handoff document. `NotesStore.walk` now uses `lstat`, includes only regular files, and recurses only when the entry itself is a directory. The e2e case plants a handoff sentinel, links both a note file and a directory entry into the handoff tree, and asserts the sentinel is absent from the committed replacement and derived surface while the filesystem recorder remains empty ([forced-rollover-e2e.spec.ts:674-731](</home/wilder/git-repos/dsh-context-handoff/tests/forced-rollover-e2e.spec.ts#L674-L731>))

Probe: the five-file Vitest command in Verification exited 0; `tests/forced-rollover-e2e.spec.ts` reported 7 tests passed. Load-bearing: yes, by source/test counterfactual. With the prior `stat` implementation, the file symlink resolves to the planted handoff sentinel, and the `not.toContain` assertion fails because the compiled copy includes it. The test does not claim a mutation run.

Fix: Keep `NotesStore.walk` on `lstat` and real-directory recursion, and retain the sentinel integration case as the probe that catches a rendered handoff link.

### [P2] RESOLVED - Canonicalize both roots and reject dangling symlinks - [src/index.ts:153-193](</home/wilder/git-repos/dsh-context-handoff/src/index.ts#L153-L193>), [src/index.ts:821-848](</home/wilder/git-repos/dsh-context-handoff/src/index.ts#L821-L848>)

A missing handoff leaf beneath a symlink alias of the notes root must not be treated as disjoint, and a dangling notes-root symlink must not be treated as a missing ordinary directory. `canonicalRoot` resolves each root through its nearest resolvable ancestor, checks a failed component with `readlink`, and refuses a dangling link. `assertNotesRootDisjoint` compares the canonical pair and fails closed on resolution errors. The new tests exercise the missing-leaf alias and dangling-root cases and assert refusal before compaction or `renderAll` ([automatic-rollover.spec.ts:512-551](</home/wilder/git-repos/dsh-context-handoff/tests/automatic-rollover.spec.ts#L512-L551>))

Probe: the five-file Vitest command exited 0; `tests/automatic-rollover.spec.ts` reported 28 tests passed. Load-bearing: yes, by source/test counterfactual. Without canonicalizing the missing handoff leaf through its symlink ancestor, the old path accepts an unresolved handoff root and renders notes; without rejecting the dangling notes link, the old fallback appends its name to an ancestor and can continue as if the roots were disjoint. The expected overlap/unprovable warning and zero-render assertions then fail.

Fix: Keep `canonicalRoot`'s dangling-link refusal and canonicalize both roots before comparison; retain both containment fixtures as the probe.

### [P2] RESOLVED - Refuse relative handoff roots without a session working directory - [src/index.ts:821-845](</home/wilder/git-repos/dsh-context-handoff/src/index.ts#L821-L845>)

A session without `header.cwd` cannot safely resolve a relative `handoffDir` against the process directory. The containment check now throws a `TypeError` naming `notesDir` instead. The handoff resolver independently rejects a relative document path when the session has no working directory ([handoff.ts:94-123](</home/wilder/git-repos/dsh-context-handoff/src/handoff.ts#L94-L123>)). The new fixture omits the session cwd and asserts the warning, zero compactions, zero starts, and zero `renderAll` calls ([automatic-rollover.spec.ts:554-569](</home/wilder/git-repos/dsh-context-handoff/tests/automatic-rollover.spec.ts#L554-L569>))

Probe: the five-file Vitest command exited 0; `tests/automatic-rollover.spec.ts` reported 28 tests passed. Load-bearing: yes, by source/test counterfactual. With the previous `process.cwd()` fallback, this fixture's scratch notes path and process-relative handoff path are disjoint, so the check would continue to the note store and miss the expected `notesDir` refusal.

Fix: Keep the fail-closed branch for a relative `handoffDir` without `session.header.cwd`; retain the no-cwd containment case as the probe.

### [P2] RESOLVED - Assert that a preflight miss never calls `commitRollover` - [tests/automatic-rollover.spec.ts:797-825](</home/wilder/git-repos/dsh-context-handoff/tests/automatic-rollover.spec.ts#L797-L825>)

The preflight prices the candidate before the commit boundary and returns on a non-shrinking result ([src/index.ts:742-759](</home/wilder/git-repos/dsh-context-handoff/src/index.ts#L742-L759>)). The test now spies on `commitRollover` and asserts zero calls, in addition to the existing no-rollover and no-bracket checks. The commit function's own guard also refuses before `compaction/start` ([src/rollover.ts:596-617](</home/wilder/git-repos/dsh-context-handoff/src/rollover.ts#L596-L617>)), so the previous assertions alone could pass after an erroneous call.

Probe: the five-file Vitest command exited 0; `tests/automatic-rollover.spec.ts` reported 28 tests passed. Load-bearing: yes. If the preflight path calls `commitRollover` despite `sizing.fits === false`, the spy count becomes nonzero even if the commit-time size guard still leaves the log unchanged. The reviewer did not mutate the call site.

Fix: Keep the preflight return before `commitRollover` and retain the zero-call seam assertion as the probe.

### [P2] RESOLVED - Prove handoff priority when both branches are eligible - [tests/automatic-rollover.spec.ts:406-423](</home/wilder/git-repos/dsh-context-handoff/tests/automatic-rollover.spec.ts#L406-L423>)

The new control and pending-handoff cases use the same `priorityCrossing` setup: the control proves the automatic compiled branch can commit, while the pending variant asserts that the handoff document is committed byte for byte and that no automatic journal line appears. The helper differs only in whether its first request is a plain tool call or `new_context` ([automatic-rollover.spec.ts:965-997](</home/wilder/git-repos/dsh-context-handoff/tests/automatic-rollover.spec.ts#L965-L997>)); the live branch order handles a pending handoff before automatic rollover ([src/index.ts:461-485](</home/wilder/git-repos/dsh-context-handoff/src/index.ts#L461-L485>))

Probe: the five-file Vitest command exited 0; `tests/automatic-rollover.spec.ts` reported 28 tests passed. Load-bearing: yes, by source/test counterfactual. If automatic rollover preempts a pending handoff at the shared eligible pre-step, the exact-document assertion or the no-automatic-line assertion fails; if automatic rollover were not eligible, the control's compiled marker assertion fails.

Fix: Keep the pending-handoff branch ahead of the automatic branch and retain both control and pending cases as the priority probe.

### [P2] RESOLVED - Retry after a size-based deferral - [tests/automatic-rollover.spec.ts:654-697](</home/wilder/git-repos/dsh-context-handoff/tests/automatic-rollover.spec.ts#L654-L697>)

The new test makes the first candidate's meter price exceed the selected span, records zero compaction starts at the deferral, then allows later prices and drives another pre-step in the same turn. It asserts one size-deferral log and one later rollover for turn 2.

Probe: the five-file Vitest command exited 0; `tests/automatic-rollover.spec.ts` reported 28 tests passed. Load-bearing: yes, by source/test counterfactual. If the automatic path stopped retrying after a size deferral, the later pre-step would not commit and the one-rollover assertions would fail. The zero-start sample pins that the first size refusal committed nothing.

Fix: Keep size refusal as a retryable deferral and retain this same-turn two-tool-call fixture as the probe.

### [P2] RESOLVED - Assert compiled ordering independently of the composer - [tests/automatic-rollover.spec.ts:303-313](</home/wilder/git-repos/dsh-context-handoff/tests/automatic-rollover.spec.ts#L303-L313>), [tests/automatic-rollover.spec.ts:355-365](</home/wilder/git-repos/dsh-context-handoff/tests/automatic-rollover.spec.ts#L355-L365>)

The equality helper still uses the production composer, but the tests now inspect markers directly in the committed replacement. The no-notes case asserts guide before the first compiled entry and no notes header; the notes case asserts guide before notes header before the first entry. The expected order therefore no longer follows an ordering change in the production composer.

Probe: the five-file Vitest command exited 0; `tests/automatic-rollover.spec.ts` reported 28 tests passed. Load-bearing: yes, by source/test counterfactual. If the composer moved the guide, notes header, or entries into the wrong order, the direct index comparisons would fail even if the equality helper reproduced the same wrong order.

Fix: Keep the independent marker-order assertions for both notes and no-notes paths; retain the five-file suite as the probe.

### [P3] RESOLVED - Limit the per-call budget comment to recall - [src/config.ts:293-296](</home/wilder/git-repos/dsh-context-handoff/src/config.ts#L293-L296>)

The comment now says that per-call `max_tokens` applies to `recall` only and that `search` uses the configured budget. The actual recall schema exposes `max_tokens`, while the search schema exposes only `query` and calls `searchLog` with `maxRecallTokens` ([src/tools.ts:600-665](</home/wilder/git-repos/dsh-context-handoff/src/tools.ts#L600-L665>))

Probe: source inspection of the tool schemas and execute methods confirms the comment matches the API; the five-file suite also exited 0 with 90 tests passed. Load-bearing: not applicable as a behavior test, because this is a documentation-only correction and no runtime behavior changed.

Fix: Keep the comment scoped to recall and the configured search budget; no behavioral test is required for this comment correction.

## Fixture audit

The three authorized fixture edits only add valid working-directory context or an absolute handoff root. The rollover-reminder case retains its automatic gate, thresholds, reminder values, manual pre-step sequence, and assertions ([rollover-reminder.spec.ts:219-274](</home/wilder/git-repos/dsh-context-handoff/tests/rollover-reminder.spec.ts#L219-L274>)). The idle-reopen and idle-watchdog cases retain their automatic rollover settings, token floors, firing path, counts, and assertions while supplying an absolute handoff root ([idle-reopen.spec.ts:173-194](</home/wilder/git-repos/dsh-context-handoff/tests/idle-reopen.spec.ts#L173-L194>), [idle-watchdog.spec.ts:311-344](</home/wilder/git-repos/dsh-context-handoff/tests/idle-watchdog.spec.ts#L311-L344>)). No assertion, expected count, or threshold was removed or relaxed. The containers still run the real agent/harness paths, and all three files passed in the requested suite. No standalone documentation file changed. The C8 contract remains consistent with the fail-closed check; the only changed documentation text is the config comment, which matches the tool schema and implementation.

## Possible concerns

None new. The no-cwd/default-relative-handoff behavior is treated as a specification-required accepted limitation below, not an unresolved defect.

## Serious unresolved risks

- The round-11 report records that no authorized different-family route was available, so no different-family verifier classified its findings. This round rechecked the fixes but did not erase that historical verifier gap. The orchestrator owns recording it; per this dispatch, the gap alone does not withhold this round's verdict.
- The shipped default handoff directory is relative (`.scratch/handoff`) and notes are enabled by default ([src/config.ts:74-75](</home/wilder/git-repos/dsh-context-handoff/src/config.ts#L74-L75>)). C8 requires a `TypeError` naming `notesDir` when the roots cannot be proven disjoint. With no session cwd, the relative root cannot be resolved under the handoff path contract ([src/handoff.ts:94-123](</home/wilder/git-repos/dsh-context-handoff/src/handoff.ts#L94-L123>)); the automatic path therefore cannot safely render notes. Source inspection shows the pre-step catches the error, warns, and continues without committing ([src/index.ts:488-491](</home/wilder/git-repos/dsh-context-handoff/src/index.ts#L488-L491>)). No live production session was run. The reviewer judges the tradeoff required by C8's fail-closed precondition; a no-cwd session needs an absolute `handoffDir` or a session cwd to retain automatic rollover.

## Verification

```text
Initial runner correction:
The first test and typecheck launches ran from /home/wilder/.dsh and exited 1: Vitest reported "No test files found"; npm reported "Missing script: typecheck." These were wrong-working-directory attempts, not repository results. Both commands were rerun from the checkout.

Test command, from /home/wilder/git-repos/dsh-context-handoff:
npx vitest run tests/automatic-rollover.spec.ts tests/forced-rollover-e2e.spec.ts tests/rollover-reminder.spec.ts tests/idle-reopen.spec.ts tests/idle-watchdog.spec.ts
Output: Test Files 5 passed (5); Tests 90 passed (90); exit 0.
Per-file: automatic-rollover 28, forced-rollover-e2e 7, rollover-reminder 4, idle-reopen 10, idle-watchdog 41.

Typecheck command, from /home/wilder/git-repos/dsh-context-handoff:
npm run typecheck
Output: "generated tsconfig.dsh-paths.json ... (507 paths)"; tsc exit 0. The file is gitignored and left untouched.

Static scan command, from /home/wilder/git-repos/dsh-context-handoff:
TMPDIR=/home/wilder/Trash/forced-rollover-vcc bash /home/wilder/git-repos/dotfiles/.agents/skills/code-review/scripts/static-scan.sh a76265c
Output: TREE a76265c; 8 changed paths, 8 code files. cccc analyzed 8 files and 393 functions; exit 0. Lizard exited 0; size warnings for resolveConfig, registerLifecycle, performAutomaticRollover and test helpers did not identify a new actionable defect in this delta; 33 duplicate blocks were all test fixture/setup repetition, none in product code.

Not run, as instructed: npm test, npm run build, and bash tests/mutation-check.sh. The orchestrator's results for those commands are not claimed as this reviewer's evidence.
```

## Dispositions

| Round-11 finding | Disposition |
|---|---|
| P1 note symlinks into handoff tree | RESOLVED |
| P2 missing handoff leaf and dangling notes-root symlink | RESOLVED |
| P2 relative handoff root with no session cwd | RESOLVED |
| P2 meter miss must skip commitRollover | RESOLVED |
| P2 prove handoff priority when both paths are eligible | RESOLVED |
| P2 retry after size-based deferral | RESOLVED |
| P2 assert committed order independently of composer | RESOLVED |
| P3 correct max_tokens config comment | RESOLVED |

## Verdict

All eight round-11 findings are resolved, the three authorized fixture edits weaken no test criteria, and no new actionable defect was found. The verdict accepts the spec-required no-cwd limitation and keeps the historical cross-family verifier gap visible without treating either as a new implementation defect.

VERDICT: clean
