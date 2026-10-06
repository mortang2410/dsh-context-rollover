# Fix brief: implementation-review findings (3)

Source: independent review by codex of `d74876a..HEAD`. Verdict: request changes.

Verified by the orchestrator before this brief was written. All three are real.

## Finding 1 (MAJOR) - a refused handoff can still report success to the model

`new_context` reads the handoff file inside its own `execute` and returns `{ accepted: true }`
(`src/tools.ts:123-132`). The engine later selects the span and checks that the document is
SMALLER than the span it replaces; when it is not, `commitRollover` throws and the pre-step
listener turns that into `ctx.logger.warn(... "continuing the turn")` (`src/index.ts:239-241`),
a warning the model never sees. So the model is told the rollover was accepted, the context does
not change, and the model keeps going.

This is the same defect class already fixed for the READ path, left unfixed for the SIZE path.
The existing test does not catch it: `tests/handoff-only.spec.ts:366-370` asserts only that a
WARNING mentions "not smaller than the shadowed content" and the document path. It never asserts
a model-visible failure.

REQUIRED FIX: `new_context` must size the candidate before it answers, and refuse with a thrown
error when the document cannot shrink the selected span. The read refusal and the size refusal
belong in the same place for the same reason. The engine keeps its own shrink guard as the
authority for the commit; do not remove it.

REQUIRED TEST: a model-visible failure, not a warning. Drive it through the real agent loop and
assert the `tool/result` with `message.isError === true` carries the specific cause, in addition
to asserting the surface is unchanged and no `compaction/start` was written.

## Finding 2 (MINOR) - the mid-call case retains an incomplete tool unit

The `handoff-only` selector walks `keepFromIdx` backward until `toolPairingBalancedAfter` holds
(`src/rollover.ts`, handoff-only arm). When the last surface node is an assistant tool call whose
result has not arrived, the cut is unbalanced, so the walk leaves that tool call - and the result
that arrives later - OUTSIDE the replaced span. `tests/handoff-only.spec.ts:163-220` constructs
exactly that and asserts `[tool-call]` remains visible on the fresh surface.

That contradicts the objective's "no ... tool calls" for that case.

REQUIRED FIX, and prefer the first option:
(a) DEFER instead of retaining. When the cut after the last surface node is not balanced, return
    `null` from the selector so no rollover happens at this pre-step. The tool runtime appends the
    result, so the next pre-step sees a balanced cut and crosses with zero old material. This
    gives the strict guarantee and is what the requirement asks for. Verify the deferral actually
    happens on the next pre-step rather than never, and that a rollover is not silently lost.
(b) If you can show from the host code that (a) can strand a rollover that would otherwise have
    been needed (for example a tool call whose result never arrives), keep the walk-back and
    document it as a stated ceiling in `src/rollover.ts`, the README, and the test name, instead
    of claiming a strict zero-tail guarantee.

Do not leave the current state, which asserts the exception without naming it a ceiling.

## Finding 3 (MINOR) - preflight and commit price the span separately

`sizeRolloverReplacement` calls `meter.measure` (`src/rollover.ts:245`) and `commitRollover` calls
it again (`:408`) after appending `compaction/start` (`:402`). A `request/header` landing between
the two can change route pricing, so the preflight can accept a candidate the commit-time guard
then rejects, after the lock is taken. The reviewer found no ordinary same-turn trigger, so this
is a narrow window, but the disagreement is real and the failure mode is finding 1's shape.

REQUIRED FIX: make the preflight and the commit use one pinned pricing snapshot, or perform the
final shrink decision BEFORE `compaction/start` so a rejection leaves no bracket. Cheapest honest
option: thread the accepted sizing into the transaction so the guard verifies the same numbers the
preflight approved. State which you chose and why.

## Constraints

- Branch `handoff-only-rollover` is already checked out. NEVER run `git checkout`, `git switch`,
  `git reset`, `git clean` or `git restore`, and do not put those words in a commit message. The
  substring inside "preset" is fine.
- Do NOT modify `/home/wilder/.dsh` or `/home/wilder/.npm-global`. Do NOT modify
  `/home/wilder/git-repos/deepseek-harness` (read it freely).
- Do NOT push.
- No probe files in `tests/`. Put throwaway probes in `.scratch/probe/` with your own vitest
  config, and move them to `~/Trash` when done. `rm` is banned on this host.
- Stage only the files you change; NEVER stage `.scratch/`.
- Commit with `git -c user.name=agent -c user.email=agent@local commit`.
- Baseline: `pnpm typecheck` exit 0 and `pnpm test` exit 0 with 15 suites / 126 tests. Both must
  still exit 0 at the end.

## Method

Implement, then run `pnpm typecheck` and `pnpm test` until both are green. Then run a mutation
check per finding: revert the load-bearing part of each fix and confirm the specific test fails,
then restore and confirm green. A fix whose test cannot fail is not a fix.

Report: per finding, what you changed and the test that proves it; the exact final typecheck and
test output; each mutation check and its observed failure; anything you chose not to fix with the
reason; and the commit SHA.
