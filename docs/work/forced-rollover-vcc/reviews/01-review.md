# Review: spec, tickets, and skeleton for forced rollover carries a VCC-compiled copy

- Date: 2026-11-14
- Mode: document review, one reviewer, no commit requested of the reviewer
- Repository: `/home/wilder/git-repos/dsh-context-handoff`
- Feature: forced-rollover-vcc
- Base/head: branch `handoff-only-rollover`, HEAD `dec0662`, no code diff this round
- Scope: kata spec `personal#qazm`, tickets `sycr`, `b61t`, `4fne`, `2zex`, `42ka`, skeleton `docs/work/forced-rollover-vcc/skeleton.md`
- Threat model: a wrong ticket sends a builder to verify the wrong thing; a document that promises behaviour the transaction cannot produce; stale references to renamed keys or aliases
- Rounds: 1 (this report); round 2 follows the fixes below
- Publication: report only; nothing published to kata beyond the dispositions comment

## Findings

### [P2] Directive-table quotations are mislabeled, and two rows cite the wrong lines - kata `qazm`

Q1-Q3 are selected grill option labels, not typed quotations (`verifier.md:13-22` records `custom: ""`), and Q2's cites did not include the MIT license lines while Q3's cited only plugin metadata.

Fix: label the three rows as grill choices, cite `vcc/package.json:70`, `vcc/LICENSE:1-14`, `vcc/src/tool.js:96-115`, `:129-181`, `vcc/src/recall.js:218-263`, `vcc/src/search.js:54-112`.

### [P3] Skeleton traceability used unresolved ticket aliases and omitted owners - `skeleton.md:210-222`

Rows used `01`-`05` while the tracker keys are `sycr`, `b61t`, `4fne`, `2zex`, `42ka`, and four rows omitted owners that check the same requirement.

Fix: use the tracker keys and list every owning ticket per requirement.

### [P2] User story 15 had no requirement, contract, or acceptance test - kata `qazm`, story 15

No R12 existed; C3 required presence, not position; `b61t` tested presence only.

Fix: add R12, state in C3 that the guide precedes the entries, and assert ordering in `tests/compiled-fallback.spec.ts` under `b61t`.

### [P2] User story 14 contradicted the composition ticket - kata `qazm`, story 14

Story 14 promised a commit when the compiler cannot shrink, while `b61t` promised deferral, and the transaction rejects any replacement at least as large as the span (`src/rollover.ts:590-598`).

Fix: restate story 14 as a deferral that retries next pre-step, with no guarantee that the span rolls over.

### [P2] The tool-result input did not fit the vendored declaration - ticket `sycr`

`vcc/types/compiler.d.ts:7-13` allows only `system|user|assistant` and omits `toolCallId`, while the runtime handles role `tool` (`vcc/src/compiler.js:738-767`).

Fix: extend the vendored declaration with role `tool` and an optional tool-call id, and keep typecheck in `sycr`'s verify.

### [P2] Skeleton edges forbade the implementation they name - `skeleton.md:29-36`

M2 allowed only M1 although projection uses `src/compat.ts`; M8 allowed only M7 although recall and search import compiler helpers and session accessors.

Fix: add M10 for `src/compat.ts`, allow M2 to depend on M1 and M10, allow M8 to depend on M1, M7 and M10, and list the helpers on M1's exposed surface.

### [P2] "Original text only" is impossible for the real output - kata `qazm`, testing decisions; ticket `sycr`; `skeleton.md:52-55`

The compiler generates role labels, tool-call summaries, media labels, provenance markers, recall instructions, and framing.

Fix: state that retained conversation payload comes from source without paraphrase, and that generated labels are allowed with every elision pointing at durable source.

### [P2] Read-back required byte identity the compiler cannot provide - ticket `2zex`

Recall derives a display projection, sanitizes, labels media, and truncates at `maxRecallTokens` (`vcc/src/recall.js:86-112,218-247`).

Fix: require VCC's complete textual projection within budget, media as labels, and a cut marker over budget.

### [P2] C7 added an unowned, self-contradictory feature flag - `skeleton.md:151-158`

`compiledFallback` carried conflicting default implications and no ticket defined or verified it.

Fix: remove the flag and state that the forced path always uses the compiler.

### [P3] C7 did not map its settings to the required compiler config - `skeleton.md:151-157`

Names differed (`assistantTextTokens` vs `textTokens`) and `toolResultExcerptTokens` was missing.

Fix: state the mapping and that remaining required fields take VCC's published defaults.

### [P3] C5 assigned the logger contract to the wrong owner - `skeleton.md:109-123`

The summary marker is written in `src/rollover.ts:622-623` (M6) and the journal line in `src/index.ts:590-593` (M5).

Fix: split into C5 summary format (M6) and C9 journal format (M5), each with its own assertion.

### [P2] The tool ticket did not accept or verify registration - ticket `2zex`

A test could pass against helpers while the model never receives either tool.

Fix: add a criterion that the registry holds both tools when the model surface is enabled and neither when disabled, and test it.

### [P3] The foreign-file assertion did not prove the no-read invariant - ticket `42ka`

Sentinel absence passes even when the code reads the file and discards it.

Fix: assert that no handoff-reader or directory read ran on the forced path.

### [P3] The compiler ticket's verify did not check its static criteria - ticket `sycr`

Typecheck permits a harness import, and nothing checked the notice.

Fix: add `tests/vendored-provenance.spec.ts` to the ticket's verify.

### [P2] The end-to-end ticket's verify omitted its mutation and README criteria - ticket `42ka`

The repository scripts carry no mutation or docs check.

Fix: add `tests/mutation-check.sh` and `tests/readme-check.mjs` to the ticket's verify.

## Possible concerns

- None recorded this round beyond the findings above.

## Serious unresolved risks

- The compiled replacement's real behaviour on a live host is unobserved; only the test harness and the transaction code establish it. The end-to-end ticket's live probe settles it.
- VCC's compiler tests are node:test shaped; adapting them to vitest is unproven (skeleton U2).

## Queued for the owner

- deepcanary: none; every concern is a finding inside this round.
- board: none published; the grill board is closed and submitted.

## Verdict

VERDICT: request changes

## Dispositions

| Finding | Disposition | Evidence |
|---|---|---|
| P2 directive-table labels and anchors | RESOLVED | `qazm` directive table now labels Q1-Q3 as grill choices and cites the license, tool registration, recall, and search lines |
| P3 traceability aliases and owners | RESOLVED | `skeleton.md` Traceability now uses `sycr`, `b61t`, `4fne`, `2zex`, `42ka` and lists every owning ticket |
| P2 story 15 unowned | RESOLVED | `skeleton.md` adds R12 and C3 states the guide precedes the entries; `b61t` criterion 4 asserts the order |
| P2 story 14 contradiction | RESOLVED | `qazm` story 14 and its implementation decision now state a deferral with no rollover guarantee |
| P2 tool-result type | RESOLVED | `qazm` decision and `skeleton.md` C2 require role `tool` and the optional tool-call id; `sycr` extends the declaration |
| P2 skeleton edges | RESOLVED | `skeleton.md` adds M10 and updates M2, M8, M1 |
| P2 original-text claim | RESOLVED | `qazm`, `sycr`, and `skeleton.md` C1 now allow generated labels |
| P2 recall byte identity | RESOLVED | `2zex` now requires VCC's textual projection within budget, media labels, and the cut marker |
| P2 C7 feature flag | RESOLVED | `skeleton.md` C7 has no `compiledFallback` and states the forced path always compiles |
| P3 C7 mapping | RESOLVED | `skeleton.md` C7 states the `assistantTextTokens` to `textTokens` mapping and VCC defaults |
| P3 C5 owner | RESOLVED | `skeleton.md` splits C5 (M6) and C9 (M5) |
| P2 tool registration unverified | RESOLVED | `2zex` criterion 8 requires the registry gating test |
| P3 no-read invariant unproven | RESOLVED | `42ka` criterion 3 requires an observed absence of any handoff reader or directory read |
| P3 compiler static criteria unverified | RESOLVED | `sycr` verify now includes `tests/vendored-provenance.spec.ts` |
| P2 e2e verify incomplete | RESOLVED | `42ka` verify now names `tests/mutation-check.sh` and `tests/readme-check.mjs` |

## Verification

```text
python3 .../skeleton_lint.py docs/work/forced-rollover-vcc/skeleton.md
requirements: 12, modules: 10, contracts: 9, stable: 9, uncertainty rows: 3, traceability rows: 12, verification hooks: 8
status: OK

kata --project personal show qazm   (directive table re-read, five rows)
kata --project personal show sycr b61t 4fne 2zex 42ka   (revised acceptance criteria)
```

## Unverified risks

- The ticket revisions are documents, not code; nothing in them has run.
- Round 2 has not yet confirmed these fixes.
