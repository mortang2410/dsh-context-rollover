# Review: spec, tickets, and skeleton for forced rollover carries a VCC-compiled copy

- Date: 2026-11-14
- Mode: document review, one reviewer, no edits by the reviewer; findings reproduced by the orchestrator before acceptance
- Repository: `/home/wilder/git-repos/dsh-context-handoff`
- Feature: forced-rollover-vcc
- Base/head: branch `handoff-only-rollover`, HEAD `dec0662`, no tracked diff
- Scope: kata spec `personal#qazm`, tickets `sycr`, `b61t`, `4fne`, `2zex`, `42ka`, skeleton `docs/work/forced-rollover-vcc/skeleton.md`
- Threat model: a wrong ticket sends a builder to verify the wrong thing; a document that promises behaviour the transaction cannot produce; stale references to renamed keys or aliases
- Rounds: 3 (this report); round 4 follows the two fixes below
- Publication: report only; dispositions summarized in a comment on `qazm`

## Round 2 dispositions, verified in round 3

Five of the seven round-2 findings were confirmed fixed against live sources:

- M1 names `estimateEntryTokens`, `projectToolResultText`, and `truncateTokens`; the vendored compiler exports them and the read-back cores import them (`skeleton.md:30`, `vcc/src/compiler.js:146-163`, `:195`, `:404`, `vcc/types/compiler.d.ts:86-94`).
- C10 requires the live meter's preflight and defers on `fits: false` before `commitRollover` (`skeleton.md:205-211`); the helper prices with the meter and the commit rechecks (`src/rollover.ts:417-443`, `:590-598`).
- M5 and M6 edges match the real imports (`src/index.ts:26-47`, `src/rollover.ts:28-33`).
- Message derivation is assigned to `Session.deriveEventMessage` (`dsh-session/lib/types/index.d.ts:303-310`, `vcc/src/index.js:792-799`); `compat.ts` exports event accessors only.
- C2 throws a `ProjectionError` for a missing selected sequence and C3 defers on it (`skeleton.md:71-74`, `:89`), matching VCC's reference projection.

Two fixes were incomplete and are the round 3 findings below.

## Round 3 findings

### [P3] M4's responsibility still directed a notes prepend

The module table said "frame, prepend notes" (`skeleton.md:33`), which contradicts C3's guide-first order and could send an implementer to put notes ahead of the recall guide.

Fix: M4 now reads "frame guide-first, then place the notes header after the guide and before the entries when notes exist". Reproduced: `grep -n 'frame guide-first' skeleton.md` returns line 33.

### [P3] The C8 example still forbade any directory read

C8's postcondition and invariant were scoped to the configured handoff directory, but its code comment still said "any directory read" (`skeleton.md:171`), contradicting the contract's own allowance for note-store reads.

Fix: the comment now names `readHandoffFile`/`resolveHandoffPath` and limits the prohibition to reads, stats, and listings under the configured handoff directory. Reproduced: `grep -n 'configured handoff directory' skeleton.md` returns lines 171 and 177.

## Directive provenance

The two `qazm` rows labeled `User message` are now attributed to a real user event: parent session `a331de17-64fd-809b-af62-6b4ebdce7b7e`, event `1a1235fc-7fea-85f6-b70d-0874aed9bd7b`, sequence 7, which carries both the VCC URL request and the "falloff" sentence. The three grill rows remain labeled as selected option labels, matching the verifier record. This closes the round 2 caveat.

## Possible concerns

- `4fne` promises the commit's shrink guard "never trips" on the forced path. The preflight helper and the commit recheck are synchronous, and `commitRollover` prices before its first yield (`src/rollover.ts:577-598`), so no reachable route change separates them today. If M5 introduces an `await` between the preflight and the commit, the guaranteed-fit claim no longer holds: that case must keep the no-yield sequence or treat a commit-time rejection as a deferral rather than a caught rollover failure.

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
| P3 round-2 item 2: M4 prepend wording | FIXED | `skeleton.md:33` now states guide-first, notes header after the guide, before entries |
| P3 round-2 item 7: C8 comment overbroad | FIXED | `skeleton.md:171` scoped to the configured handoff directory; invariant at `:177` unchanged |

## Verification

```text
python3 .../skeleton_lint.py docs/work/forced-rollover-vcc/skeleton.md
requirements: 12, modules: 10, contracts: 10, uncertainty rows: 2, traceability rows: 12, verification hooks: 9
status: OK

grep -n 'frame guide-first\|configured handoff directory' skeleton.md
33: M4 responsibility
171: C8 comment
177: C8 invariant
```

## Unverified risks

- The ticket revisions are documents, not code; nothing in them has run.
- Round 4 has not yet confirmed these two fixes.
