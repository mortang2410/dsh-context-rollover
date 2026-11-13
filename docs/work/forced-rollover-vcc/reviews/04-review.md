# Review: spec, tickets, and skeleton for forced rollover carries a VCC-compiled copy

- Date: 2026-11-14
- Mode: document review, one reviewer, no edits by the reviewer; findings reproduced by the orchestrator before acceptance
- Repository: `/home/wilder/git-repos/dsh-context-handoff`
- Feature: forced-rollover-vcc
- Base/head: branch `handoff-only-rollover`, HEAD `dec0662`, no tracked diff
- Scope: kata spec `personal#qazm`, tickets `sycr`, `b61t`, `4fne`, `2zex`, `42ka`, skeleton `docs/work/forced-rollover-vcc/skeleton.md`
- Threat model: a wrong ticket sends a builder to verify the wrong thing; a document that promises behaviour the transaction cannot produce; a configuration the contract cannot both honour and keep notes for
- Rounds: 4 (this report); round 5 follows the fixes below
- Publication: report only; dispositions summarized in a comment on `qazm`

## Round 3 dispositions, verified in round 4

Both round-3 findings were confirmed fixed:

- M4 frames guide-first and places the notes header after the guide and before the entries (`skeleton.md:33`), matching C3 (`:89`), the data flow (`:216`), and `b61t` AC5.
- C8's example comment is scoped to the configured handoff directory (`skeleton.md:171`), the invariant allows note-store reads (`:177`), and `42ka` AC3 matches that scope.

## Round 4 finding

### [P2] A notes store that overlaps the handoff directory splits C8

C8 forbids every read, stat, or listing under `handoffDir` while allowing note-store reads. `notesDir` and `handoffDir` are independent strings (`src/config.ts:215-223`, `:307-309`), and `resolveConfig` validates only that `handoffDir` is nonempty (`src/config.ts:423-424`, `:502-503`). With both set to the same directory, `NotesStore.directoryFor` puts the per-session store beneath `handoffDir` (`src/notes.ts:74-76`), and `renderNotes` lists and reads it through `renderAll` (`src/index.ts:701-705`, `src/notes.ts:82-107`, `:183-203`). That configuration cannot both keep the notes R6 requires and obey C8's path-wide prohibition.

Fix: C7 rejects a resolved notes base directory that equals or lies under the configured handoff directory, naming `notesDir`; C8 gains that precondition; M7's responsibility names the rejection; the spec records it as an implementation decision and a configuration test; `4fne` gains the overlap criterion; `42ka` proves the overlap fails before any notes read, stat, or listing.

Also applied: `4fne`'s promise that the commit guard "never trips" is now stated as "never attempts a commit the guard would reject", with the preflight and commit kept in one synchronous stretch or a commit-time size rejection treated as a normal deferral. The reviewer corrected its round-3 claim that the no-yield sequence was demonstrated; M5 is not implemented, so the guarantee must stay a design requirement, not an observed fact.

## Possible concerns

- The overlap rejection compares base directories at construction. A configuration that makes an individual session's store land inside the handoff directory through a symlink is not covered by that string comparison; the implementation test should resolve real paths if it can do so without reading under the handoff directory.
- The meter preflight and the commit must stay synchronous, or a commit-time rejection must be caught as a deferral. The current automatic listener treats a thrown size error as a rollover failure (`src/index.ts:352-354`).

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
| P2 notes store overlap with the handoff directory | FIXED | `skeleton.md` C7 post/errors, C8 precondition, M7 row; `qazm` decision and configuration test; `4fne` overlap criterion; `42ka` overlap criterion |
| P2 `4fne` overclaimed that the commit guard never trips | FIXED | `4fne` now says the forced path never attempts a rejecting commit, with the synchronous stretch or deferral rule stated |

## Verification

```text
python3 .../skeleton_lint.py docs/work/forced-rollover-vcc/skeleton.md
requirements: 12, modules: 10, contracts: 10, uncertainty rows: 2, traceability rows: 12, verification hooks: 9
status: OK

python3 .../drift_check.py ... --baseline .../outline-before.json
status: OK

body-match: compared 3 mismatch []   (qazm, 4fne, 42ka republished)
```

## Unverified risks

- The ticket revisions are documents, not code; nothing in them has run.
- Round 5 has not yet confirmed this fix.
- The symlinked-directory case is untested and unproven.
