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
