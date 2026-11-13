# Review: spec, tickets, and skeleton for forced rollover carries a VCC-compiled copy

- Date: 2026-11-14
- Mode: document review, one reviewer, no edits by the reviewer; findings reproduced by the orchestrator before acceptance
- Repository: `/home/wilder/git-repos/dsh-context-handoff`
- Feature: forced-rollover-vcc
- Base/head: branch `handoff-only-rollover`, HEAD `dec0662`, no tracked diff
- Scope: kata spec `personal#qazm`, tickets `sycr`, `b61t`, `4fne`, `2zex`, `42ka`, skeleton `docs/work/forced-rollover-vcc/skeleton.md`
- Threat model: a wrong ticket sends a builder to verify the wrong thing; a containment rule that fails open on a missing directory; a required fallback with no acceptance hook
- Rounds: 6 (this report); round 7 follows the fixes below
- Publication: report only; dispositions summarized in a comment on `qazm`

## Round 5 findings, verified in round 6

Both round-5 findings were confirmed fixed: containment now runs per session on the effective roots, and the meter wording distinguishes a preflight miss from a commit-time rejection. All round 1 to 4 carry-forwards also hold.

## Round 6 findings

### [P2] Containment was fail-open when the notes root does not exist

C8 compared realpaths "when both resolve", but the per-session notes directory may legitimately not exist; `NotesStore.list()` treats a missing store as empty (`src/notes.ts:82-87`), and realpath on a nonexistent path returns ENOENT. A symlinked notes base could therefore have disjoint absolute strings while its canonical target lies under the handoff root.

Fix: the C8 precondition now derives the canonical notes root without descending under the handoff directory: the realpath of the notes root when it exists, else the realpath of its nearest existing ancestor with the missing suffix appended. It compares against the handoff root's absolute path and, when that root exists, its own realpath. It throws a TypeError naming `notesDir` on containment and also when no available comparison proves the roots disjoint, so a missing leaf cannot fail open. `qazm` records the rule and a symlinked-notes-base-with-absent-leaf case; `42ka` gains that case as an acceptance criterion.

### [P2] The commit-time fallback had no verification hook

C10 and `4fne` require a commit-time rejection after a passing preflight to return the normal deferral, but the C10 hook and `4fne` AC3 covered only the preflight miss and the compiler-fits/meter-rejects case.

Fix: C10's verification hook now names the commit-time case, and `4fne` gains an acceptance criterion: a candidate that passes preflight but is rejected by the commit-time recheck returns the same deferral with no compaction bracket, while unrelated meter or surface errors still propagate. `qazm` gains the matching test.

## Possible concerns

- The commit-time rejection is identified by the guard's size error. The implementation must not catch unrelated meter or surface errors with that predicate, which the new criterion pins.
- The containment check's fail-closed branch will reject a session whose notes leaf cannot be compared even when no overlap exists. That is the intended direction: it refuses rather than reading a possibly-overlapping store.

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
| P2 containment fail-open on a missing notes root | FIXED | `skeleton.md` C8 precondition and errors; `qazm` decision and test; `42ka` AC5 for a symlinked base with an absent leaf |
| P2 commit-time fallback had no verification hook | FIXED | `skeleton.md` C10 hook; `4fne` new criterion; `qazm` matching test |

## Verification

```text
python3 .../skeleton_lint.py docs/work/forced-rollover-vcc/skeleton.md
requirements: 12, modules: 10, contracts: 10, uncertainty rows: 2, traceability rows: 12, verification hooks: 9
status: OK

body-match: qazm, 4fne, 42ka republished
```

## Unverified risks

- The ticket revisions are documents, not code; nothing in them has run.
- Round 7 has not yet confirmed these fixes.
