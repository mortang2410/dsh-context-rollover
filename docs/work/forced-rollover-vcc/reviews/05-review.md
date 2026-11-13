# Review: spec, tickets, and skeleton for forced rollover carries a VCC-compiled copy

- Date: 2026-11-14
- Mode: document review, one reviewer, no edits by the reviewer; findings reproduced by the orchestrator before acceptance
- Repository: `/home/wilder/git-repos/dsh-context-handoff`
- Feature: forced-rollover-vcc
- Base/head: branch `handoff-only-rollover`, HEAD `dec0662`, no tracked diff
- Scope: kata spec `personal#qazm`, tickets `sycr`, `b61t`, `4fne`, `2zex`, `42ka`, skeleton `docs/work/forced-rollover-vcc/skeleton.md`
- Threat model: a wrong ticket sends a builder to verify the wrong thing; a document that promises behaviour the transaction cannot produce; a containment rule that cannot be evaluated at the moment it claims to run
- Rounds: 5 (this report); round 6 follows the fixes below
- Publication: report only; dispositions summarized in a comment on `qazm`

## Round 4 finding, verified in round 5

The overlap finding was confirmed fixed for a resolved base-directory comparison: C7 rejected it, C8 carried the precondition, M7 named it, and the tickets required rejection before notes I/O. The reviewer then found the rule was incomplete because a relative `handoffDir` resolves against the session working directory, which construction does not know (`src/config.ts:218-223`, `src/index.ts:193-195`).

## Round 5 findings

### [P2] The overlap rule never defined the effective per-session paths

C7 and the tickets described a base-directory overlap rejected at construction. A relative `handoffDir` resolves against the session working directory (`src/config.ts:218-223`), the plugin resolves config in its constructor without a session (`src/index.ts:193-195`), and the notes store appends a session id to `notesDir` (`src/notes.ts:74-76`). A construction-time string comparison cannot see the paths that actually get touched, and the symlink-alias case was left open.

Fix: containment moved out of C7 into C8's precondition on M5. Immediately before any note-store access, M5 resolves the per-session notes root (`notesDir` base plus session id, defaulting as `NotesStore.directoryFor` does) and the effective handoff root (`handoffDir` against the session working directory), compares them as absolute paths and by realpath of each root's own path only, and throws a TypeError naming `notesDir` on containment. The spec records the same rule; `4fne` gains the case; `42ka` requires both a relative-path case and a symlinked-handoff case before any notes read, stat, or listing. C8's prohibition of touching anything inside the handoff directory is unchanged; resolving the handoff root's own path is explicitly allowed and is not a read of its contents.

### [P2] The meter fallback contradicted "never attempts a rejecting commit"

`4fne` said the forced path never attempts a commit the guard would reject, then allowed a commit-time rejection to be handled as normal deferral, which means `commitRollover` was called after all. C10 already stated the narrower truth: the preflight only prevents a known non-shrinking attempt (`skeleton.md:211`).

Fix: `4fne` now says a preflight miss defers before `commitRollover` and opens no transaction; if the commit-time recheck still rejects a candidate that passed preflight, the size rejection is caught and returned as the same deferral before the compaction bracket opens. C10's postcondition carries the same sentence. The guard still runs before `compaction/start` (`src/rollover.ts:577-607`), so the caught path leaves no transaction.

## Cross-reference sweep

The set agrees on the overlap rule, guide, notes header and entries order, C8 scope, C10 preflight, and the dependency chain (`sycr -> b61t -> 4fne -> 42ka`, plus `sycr -> 2zex -> 42ka`). Earlier round reports retain their historical statements; `04-review.md` already corrects the round-3 no-yield claim.

## Possible concerns

- realpath of the handoff root's own path is allowed and is not a read under it. If a later implementation lists or stats a child of that root during containment, it violates C8 regardless of the overlap result.
- A symlinked handoff root is rejected only when the notes root resolves inside it; a symlinked notes root pointing outside is allowed, which is the intended direction.

## Serious unresolved risks

- No code exists yet; every behavioural claim rests on source reading and the document set.
- VCC's compiler tests are node:test shaped; adapting them to vitest is unproven (skeleton U2).
- The shrink guard's behaviour on a span smaller than the minimum useful checkpoint is unproven (skeleton U3).

## Queued for the owner

- deepcanary: none; every concern is a finding inside this round.
- board: none published; the grill board is closed and submitted.

## Verdict

VERDICT: request changes

## Dispositions

| Finding | Disposition | Evidence |
|---|---|---|
| P2 overlap rule lacked effective per-session paths and symlink handling | FIXED | `skeleton.md` C8 pre/errors, M5 row, M7 row; `qazm` decision and test; `4fne` criterion; `42ka` criterion with relative and symlink cases |
| P2 meter fallback contradicted the no-attempt claim | FIXED | `4fne` What to build; `skeleton.md` C10 post |

## Verification

```text
python3 .../skeleton_lint.py docs/work/forced-rollover-vcc/skeleton.md
requirements: 12, modules: 10, contracts: 10, uncertainty rows: 2, traceability rows: 12, verification hooks: 9
status: OK

body-match: qazm, 4fne, 42ka republished; compared 3 mismatch []
```

## Unverified risks

- The ticket revisions are documents, not code; nothing in them has run.
- Round 6 has not yet confirmed these fixes.
