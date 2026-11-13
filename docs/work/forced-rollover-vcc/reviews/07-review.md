# Review: spec, tickets, and skeleton for forced rollover carries a VCC-compiled copy

- Date: 2026-11-14
- Mode: document review, one reviewer, no edits by the reviewer; findings reproduced by the orchestrator before acceptance
- Repository: `/home/wilder/git-repos/dsh-context-handoff`
- Feature: forced-rollover-vcc
- Base/head: branch `handoff-only-rollover`, HEAD `dec0662`, no tracked diff
- Scope: kata spec `personal#qazm`, tickets `sycr`, `b61t`, `4fne`, `2zex`, `42ka`, skeleton `docs/work/forced-rollover-vcc/skeleton.md`
- Threat model: a wrong ticket sends a builder to verify the wrong thing; a containment rule that fails open; a required fallback with no acceptance hook
- Rounds: 7 (this report); document review closes here
- Publication: report only; dispositions summarized in a comment on `qazm`

## Round 6 dispositions, verified in round 7

Both round-6 findings were confirmed fixed:

- C8 derives the canonical per-session notes root from the existing root or its nearest existing ancestor plus the missing suffix, never descends under the handoff directory, compares against the handoff absolute path and its own realpath when present, and fails closed with a TypeError naming `notesDir` when containment holds or disjointness cannot be proven (`skeleton.md:174-177`). `42ka` AC5 covers the symlinked-notes-base-with-absent-leaf case before any notes read, stat, or listing.
- C10's verification hook requires the commit-time rejection after a passing preflight, with unrelated meter and surface errors propagating (`skeleton.md:244`); `4fne` AC4 asserts the same deferral without a compaction bracket; `qazm` carries the matching test.

All round 1 to 5 carry-forwards also hold: helper surface, guide-first order, meter preflight, module edges, derivation ownership, strict projection, C8 scope, per-session containment ownership, and the dependency chain.

## New findings

None. The reviewer found no P-level finding this round.

## Possible concerns

None new. The unverified risks below remain.

## Serious unresolved risks

- No code exists yet; every behavioural claim rests on source reading and the document set.
- VCC's compiler tests are node:test shaped; adapting them to vitest is unproven (skeleton U2).
- The shrink guard's behaviour on a span smaller than the minimum useful checkpoint is unproven (skeleton U3).

## Queued for the owner

- deepcanary: none.
- board: none published; the grill board is closed and submitted.

## Verdict

VERDICT: clean

## Dispositions

| Finding | Disposition | Evidence |
|---|---|---|
| P2 containment fail-open on a missing notes root | FIXED, confirmed in round 7 | `skeleton.md` C8 precondition; `qazm`; `42ka` AC5 |
| P2 commit-time fallback had no verification hook | FIXED, confirmed in round 7 | `skeleton.md` C10 hook; `4fne` AC4; `qazm` test |

## Verification

```text
python3 .../skeleton_lint.py docs/work/forced-rollover-vcc/skeleton.md
requirements: 12, modules: 10, contracts: 10, uncertainty rows: 2, traceability rows: 12, verification hooks: 9
status: OK

body-match: qazm, sycr, b61t, 4fne, 2zex, 42ka all equal their published bodies
```

## Unverified risks

- The ticket revisions are documents, not code; nothing in them has run.
- Implementation and the code review loop are still ahead.
