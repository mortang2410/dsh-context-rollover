# Gates: handoff-only context rollover

Objective: modify this local fork of `athif23/dsh-context-rollover` so a context rollover replaces
the whole prior conversational surface with the durable `/handoff-doc` Markdown file, the reminder
fires at 40% with configurable text naming `/handoff-doc` and `new_context`, `thresholdRatio` 0.90
remains an emergency fallback, no summarizer model is called, the session id is unchanged, history
is retained for manual retrieval only, and the preset name stays `standard-rollover`.

Each gate names a command and the exact output that proves it. A gate passes only on the stated
output, never on a summary of it.

## G1 - the suite measures the running host

CHECK: `cd /home/wilder/git-repos/dsh-context-handoff && pnpm typecheck && pnpm test`
EXPECT: typecheck exits 0 with no `error TS` lines; vitest reports `Tests  N passed` with zero
failed, and no suite in the pre-existing set is missing from the run.

Baseline to beat (measured on the pristine clone at `d74876a`): typecheck 23 errors; tests 3 failed
and 49 passed. The three failures are the two shrink-guard rejections (`tests/rollover.spec.ts`,
`tests/history.spec.ts`) and `tests/web-preset.spec.ts` failing to find a `standard` preset source.

## G2 - the reminder fires once at 40% and names the workflow

CHECK: `pnpm test -- tests/reminder-delivery.spec.ts tests/engine.spec.ts`
EXPECT: a test proves exactly one reminder after usage crosses 40%, none again in the same window,
and the delivered text contains `/handoff-doc` and `new_context` with the measured percent
substituted from the configured default message.

## G3 - new_context loads the durable handoff and injects nothing else

CHECK: `pnpm test -- tests/handoff-only.spec.ts tests/engine.spec.ts`
EXPECT: a test proves the derived messages carry the handoff file's own content, carry zero
pre-rollover conversation sentinels, carry no prior assistant tool-call and no prior tool/result,
and that the surface after the rollover is exactly the `system/message` head plus the replacement
handoff message.

## G4 - the session id is unchanged

CHECK: `pnpm test -- tests/handoff-only.spec.ts`
EXPECT: a test records `session.id` before and after the rollover and asserts they are identical,
and asserts `countRollovers(session)` advanced by one on that same session object.

## G5 - no summarizer runs on any rollover path

CHECK: `pnpm test -- tests/no-summarizer.spec.ts`
EXPECT: for each of the four rollover paths (model-requested, pressure, overflow, manual), a test
asserts that no adapter stream started between that rollover's `compaction/start` and
`compaction/end`, and that the summary event's provider is this engine with its deterministic model
string.

## G6 - the 90% emergency fallback still works

CHECK: `pnpm test -- tests/safety.spec.ts tests/handoff-only.spec.ts`
EXPECT: with the reminder threshold raised so no reminder fires, usage crossing 0.90 commits
exactly one rollover; a newer handoff file in the scan directory is preferred over an older one; a
candidate that cannot shrink the span yields the notes checkpoint instead, with exactly one
successful transaction and no error `compaction/end`.

## G7 - the preset name is retained and the declaration loads

CHECK: `pnpm test -- tests/web-preset.spec.ts tests/preset-deferral.spec.ts`
EXPECT: the preset id is `standard-rollover`; the generated host-format declaration loads through
the real preset registry and selecting it resolves that session's compaction service to this
engine, not to `compaction-basic`.

## G8 - the objective's literal list is satisfied

CHECK: a reading of the delivered `src/`, `presets/`, `tests/` and `README.md` against the eight
numbered requirements in the objective.
EXPECT: each of the eight requirements maps to a named file and, where it is behavioral, to one of
G1-G7. No requirement is satisfied only by a comment or a doc sentence.

## Scope guards (must NOT happen)

- No change to `/home/wilder/.dsh` or `/home/wilder/.npm-global` (the installed DSH host).
- No change to `/home/wilder/git-repos/deepseek-harness` (read-only source tree for resolution).
- No `git checkout`, `git switch`, `git reset`, `git clean` or `git restore` in any command,
  including inside heredoc bodies or prompt text.
- No push to any remote.
- No test assertion deleted or loosened to reach green.

## Verification log (committed tree, measured by the orchestrator)

| Gate | Result | Evidence |
|---|---|---|
| G1 | PASS | typecheck exit 0, 0 `error TS`; 11 suites / 53 tests (baseline 23 errors, 3 failed / 49) |
| G2 | PASS | typecheck exit 0; 12 suites / 79 tests. Default reminder rendered at 40 is byte-identical to the required sentence, verified by direct comparison. Mutation: reverting the 0.40 default fails 4 tests. |
| G3 | PASS | typecheck exit 0; 13 suites / 95 tests |
| G4 | PASS | covered by G3's run; `tests/handoff-only.spec.ts` asserts the id is identical before and after |
| G5 | PASS | `tests/no-summarizer.spec.ts` 7 passed, one case per rollover path. Verified the proof's assumption: `session/event` observers run synchronously inside `Session.append` (`packages/core/session/src/index.ts:764`), so the bracket sampling is exact. |
| G6 | PASS | typecheck exit 0; 14 suites / 114 tests. Mutation: removing the shrink-aware ordering fails 2 tests, including the preflight one. |
| G7 | PASS | typecheck exit 0; 15 suites / 126 tests; `pnpm build` exit 0. Preset id is `standard-rollover`. Mutation: pointing the bundle patch at a nonexistent row id fails 2 tests, including the real-registry resolution case. |
| G8 | PASS | eight requirements mapped below |
| G1-G8 re-run | PASS | after closing the second review's two findings: `pnpm typecheck` exit 0 with 0 `error TS`, `pnpm typecheck:compat` exit 0, `pnpm build` exit 0, `pnpm test` exit 0 with **16 suites / 133 tests**. Three new mutation checks below. |

### G8 requirement map

1. 40%: `src/config.ts` `reminderThresholdRatio ?? 0.4`; 0.90 `thresholdRatio ?? 0.9` documented as the emergency fallback.
2. Configurable message: `DEFAULT_REMINDER_MESSAGE` + `renderReminderMessage` in `src/config.ts`; the preset carries the literal text; placeholders: `{percent}`, `{used_tokens}`, `{window_tokens}`, `{handoff_point_tokens}`, `{rollover_point_tokens}`, `{tokens_to_rollover}`.
3. Durable `/handoff-doc` file: `DEFAULT_HANDOFF_DIR = '.scratch/handoff'`, `DEFAULT_HANDOFF_PATTERN = 'HANDOFF-*.md'`, matching the skill's stated save path.
4. Handoff replaces everything: `selectRolloverRange` `handoff-only` arm in `src/rollover.ts`; `buildReplacementText` in `src/checkpoint.ts` adds nothing to the document.
5. No summarizer: `tests/no-summarizer.spec.ts`, one bracket assertion per path; the engine never calls `ctx.llm` anywhere in `src/`.
6. Same session id, history retained but not injected: `tests/handoff-only.spec.ts` id assertion; `history` is tool-only (`src/tools.ts`), and nothing in `src/` injects history into the surface.
7. Preset name: `presets/standard-rollover/declaration.patch.yml` declares `id: standard-rollover`.
8. Tests: `tests/reminder-delivery.spec.ts` (once at 40%, names the workflow), `tests/handoff-only.spec.ts` (loads the handoff, zero tail, same id), `tests/no-summarizer.spec.ts` (no model call), `tests/emergency-fallback.spec.ts` (90% fallback).

### Independent mutation checks run by the orchestrator (not taken from any implementer's report)

- Revert the 0.40 default -> 4 failures.
- Reintroduce a one-node tail in the `handoffOnly` selector -> 3 failures, including the end-to-end two-node surface assertion which showed `assistant/message` + `tool/result` surviving.
- Remove the shrink-aware candidate ordering -> 2 failures, including the preflight case.
- Point the bundle patch at a nonexistent row id -> 2 failures, including the real-registry resolution case.
- Re-run the pathological glob (`'*a'.repeat(12)+'b'` against 30 'a's) against the fixed matcher: 889 ms before, 0.02 ms after; the new matcher agrees with the old translation on 88 pattern/name pairs.
- Second-review finding (pin bound to the span but not the candidate): reproduce first, then fix. Probe on the pre-fix tree: a pin measured for a 99-token short candidate over a 128-token span let a ~20k-token replacement commit (`countRollovers` 1). Mutation: removing `pinned.replacementText === replacementText` from the guard fails 1 test, `re-prices rather than trusting a pinned sizing measured for a different candidate`.
- Second-review finding 3 (re-priced refusal left a failed bracket): probe on the pre-fix tree showed `["...","compaction/start","compaction/end"]` after a refused oversized commit. Mutation: moving the shrink decision back after `compaction/start` fails 2 tests, `leaves no failed bracket when a stale pin is re-priced and refused` and `leaves no compaction event at all when the size guard refuses`.
- Pin-reuse plumbing: mutation making the commit always re-price (never reuse the pin) fails 1 test, `reuses the sizing it decided with, instead of re-pricing the candidate at commit time`.
