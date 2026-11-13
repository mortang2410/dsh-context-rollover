# Review: spec, tickets, and skeleton for forced rollover carries a VCC-compiled copy

- Date: 2026-11-14
- Mode: document review, one reviewer, no code changed; findings reproduced by the orchestrator before acceptance
- Repository: `/home/wilder/git-repos/dsh-context-handoff`
- Feature: forced-rollover-vcc
- Base/head: branch `handoff-only-rollover`, HEAD `dec0662`, no code diff this round
- Scope: kata spec `personal#qazm`, tickets `sycr`, `b61t`, `4fne`, `2zex`, `42ka`, skeleton `docs/work/forced-rollover-vcc/skeleton.md`
- Threat model: a wrong ticket sends a builder to verify the wrong thing; a document that promises behaviour the transaction cannot produce; stale references to renamed keys or aliases
- Rounds: 2 (this report); round 3 follows the fixes below
- Publication: report only; dispositions summarized in a comment on `qazm`

## Round 1 findings

The round 2 reviewer returned 14 of the 15 round 1 findings resolved and one partially resolved:

- **Partial, now fixed:** M1's exposed surface still omitted `estimateEntryTokens`, `projectToolResultText`, and `truncateTokens`, which the read-back cores import (`vcc/src/recall.js:17-18`, `vcc/src/search.js:15-17`). Skeleton M1 now names all three.
- All other round 1 findings resolved as recorded in `01-review.md`.

Residual the reviewer stated and the orchestrator leaves as is: the two directive-table rows labeled `User message` cannot be certified as verbatim, because the originating messages were not recovered from the session store. The columns still name their source kind; no row now claims a grill label for typed text, and the three selected grill answers cite the board and verifier report.

## Round 2 findings

### [P2] The replacement ordered the notes header before the recall guide

C3 and `b61t` AC4 put the notes header first, while story 15 puts the guide at the head. VCC's `frameCheckpoint` starts with `RECALL_GUIDE` and appends the optional header and entries (`vcc/src/compiler.js:1156-1160`).

Fix: C3, the data flow, the spec's implementation and testing decisions, and `b61t` now state and test the order guide, then notes header when notes exist, then framed entries.

### [P2] Deferral did not use the transaction's meter price

C3 accepted `shadowedTokens` without defining its metric; `commitRollover` prices the candidate with the live meter and throws when it is not smaller (`src/rollover.ts:417-443`, `:590-598`). The automatic listener catches that throw as a rollover failure, not as the named deferral.

Fix: a new contract C10 requires M5 to price the composed candidate with `sizeRolloverReplacement` over the selected span and defer when `fits` is false, before `commitRollover` opens a transaction. `4fne` gains that criterion and the compiler-fits/meter-rejects case; `b61t` AC7 now covers only the empty-compile and projection-error deferrals the composer can decide.

### [P2] Module edges omitted the engine's and transaction's real dependencies

M5 allowed only M3/M4 while `src/index.ts` also imports M6, M7, M9, and M10; M6 allowed none while `src/rollover.ts` imports M3, M7, and M10 (`src/index.ts:26-47`, `src/rollover.ts:28-33`).

Fix: M5 allows M3, M4, M6, M7, M9, M10; M6 allows M3, M7, M10.

### [P3] Message derivation was attributed to `src/compat.ts`

M10 and the Brownfield delta described a derived-message adapter in `compat.ts`, which exports event accessors only (`src/compat.ts:29-50`). The installed Session API exposes `Session.deriveEventMessage` (`dsh-session/lib/types/index.d.ts:286-310`), and VCC calls it (`vcc/src/index.js:792-799`).

Fix: M10 is described as the event-accessor compatibility module, C2 states that projection calls `Session.deriveEventMessage`, the Brownfield row is corrected, and U1 is removed.

### [P2] C2 allowed a partial projection

The postcondition promised one node per selected sequence while the error rule allowed skipping a missing one; a skipped node drops the `(seq N)` pointer R2 requires. VCC's reference projection throws on a missing selected sequence (`vcc/src/index.js:792-799`).

Fix: C2 now throws a `ProjectionError` naming the seq; C3 returns defer on a projection throw; `b61t` adds the missing-event criterion and asserts the engine commits nothing.

### [P2] The no-read invariant forbade the notes read it must keep

C8 and `42ka` AC3 forbade any directory read, while the forced path renders durable notes through `NotesStore.renderAll`, which lists and reads the notes directory (`src/index.ts:565`, `src/notes.ts:82-99`).

Fix: C8 and `42ka` AC3 are scoped to the configured handoff directory, allow note-store reads, and assert the notes snapshot still appears.

## Possible concerns

- The meter preflight is specified against `sizeRolloverReplacement`, whose signature takes a selected range. The engine currently holds one; if a later refactor changes that signature, C10 must move with it.
- The compiler's own estimate and the meter price can disagree. The design accepts that as a deferral, not a compile failure; a span the compiler shrinks but the meter rejects simply waits for the next pre-step.

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
| P3 M1 surface omitted read-back helpers | FIXED | `skeleton.md` M1 names `estimateEntryTokens`, `projectToolResultText`, `truncateTokens`; `sycr` names them in What to build |
| P2 guide ordered after the notes header | FIXED | `skeleton.md` C3 and data flow guide-first; `qazm` decisions and tests; `b61t` AC4 |
| P2 deferral lacked the meter price | FIXED | `skeleton.md` C10; `4fne` preflight criterion and Verify; `b61t` AC7 reworded |
| P2 M5/M6 edges wrong | FIXED | `skeleton.md` module table |
| P3 derivation attributed to `compat.ts` | FIXED | `skeleton.md` M10, C2, Brownfield row; U1 removed |
| P2 partial projection allowed | FIXED | `skeleton.md` C2 and C3; `qazm` projection test; `b61t` missing-event AC |
| P2 no-read invariant overbroad | FIXED | `skeleton.md` C8; `qazm` e2e test; `42ka` AC3 and What to build |

## Verification

```text
python3 .../skeleton_lint.py docs/work/forced-rollover-vcc/skeleton.md
requirements: 12, modules: 10, contracts: 10, stable: 10, uncertainty rows: 2, traceability rows: 12, verification hooks: 9
status: OK

python3 .../drift_check.py docs/work/forced-rollover-vcc/skeleton.md --root . --baseline .../outline-before.json
status: OK (warnings only for the not-yet-created modules)

kata --project personal show qazm sycr b61t 4fne 42ka   (revised bodies re-read)
```

## Unverified risks

- The ticket revisions are documents, not code; nothing in them has run.
- Round 3 has not yet confirmed these fixes.
- The two `User message` directive rows remain uncertified as verbatim quotations.
