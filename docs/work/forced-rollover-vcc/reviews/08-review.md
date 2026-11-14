# Review: implementation alignment with the forced-rollover VCC spec, tickets, and skeleton

- Date: 2026-11-14
- Mode: read-only implementation and artifact alignment review, one reviewer, no commit requested
- Repository: `dsh-context-rollover`
- Feature: forced-rollover-vcc
- Base/head: `handoff-only-rollover`, base [`559de9e`](https://github.com/scratchspace-mortang/dsh-context-rollover/commit/559de9e), HEAD [`6a02ba9`](https://github.com/scratchspace-mortang/dsh-context-rollover/commit/6a02ba9), plus a modified working-tree skeleton
- Scope: Kata `personal#qazm`, `sycr`, `b61t`, `4fne`, `2zex`, `42ka`; the working-tree [skeleton.md](</home/wilder/git-repos/dsh-context-handoff/docs/work/forced-rollover-vcc/skeleton.md>); implementation commits [`86ef259`](https://github.com/scratchspace-mortang/dsh-context-rollover/commit/86ef259), [`559b2ba`](https://github.com/scratchspace-mortang/dsh-context-rollover/commit/559b2ba), and [`6a02ba9`](https://github.com/scratchspace-mortang/dsh-context-rollover/commit/6a02ba9); relevant source, tests, and README
- Threat model: a public tool contract that disagrees with its implementation can strand a caller; a search description can promise records the implementation excludes; an unowned source change can add coupling without changing behavior
- Rounds: 8
- Publication: report only; no tracker comments or updates

## Findings

### [P2] Align the recall tool arguments with C6 - [skeleton.md:138](</home/wilder/git-repos/dsh-context-handoff/docs/work/forced-rollover-vcc/skeleton.md#L138>), [tools.ts:595-623](</home/wilder/git-repos/dsh-context-handoff/src/tools.ts#L595-L623>)

C6 publishes `recall({ type, ref })`, but the tool schema requires `type` and `id`, optionally accepts `max_tokens`, and the handler reads `args.id`. The new recall tests also call the tool with `id`, so a caller implementing C6 literally will not send the field this implementation consumes. The optional budget override is also absent from C6. The source establishes this interface mismatch; this review did not execute the tool.

Fix: make `recallTool` accept and consume C6's `ref` field, update the recall tests to call `ref`, and add the optional `max_tokens` argument to C6 if the override remains part of the public tool. Verify with a tool invocation using only the contract's required fields.

### [P2] Describe the records that search actually includes - [tools.ts:640-644](</home/wilder/git-repos/dsh-context-handoff/src/tools.ts#L640-L644>), [search.ts:92-94](</home/wilder/git-repos/dsh-context-handoff/src/search.ts#L92-L94>), [README.md:113-115](</home/wilder/git-repos/dsh-context-handoff/README.md#L113-L115>)

The tool description and README promise search over every event or record, but `searchLog` skips compact-checkpoint user-message nodes. The new test explicitly asserts that checkpoint bodies are not searchable, and the source comments explain that those bodies are generated replacement text. The implementation's exclusion is consistent with that design; the user-facing claim is broader than the implemented behavior.

Fix: change the tool description and README to promise search over original conversation records, while stating that generated checkpoint nodes are excluded and remain available through checkpoint recall. Keep the existing exclusion test and assert the corrected README wording when the documentation check is added.

### [P3] Remove the unowned redundant history filter - [history.ts:13-23](</home/wilder/git-repos/dsh-context-handoff/src/history.ts#L13-L23>), [history.ts:68-70](</home/wilder/git-repos/dsh-context-handoff/src/history.ts#L68-L70>), [history.ts:105-107](</home/wilder/git-repos/dsh-context-handoff/src/history.ts#L105-L107>), [history.ts:199-205](</home/wilder/git-repos/dsh-context-handoff/src/history.ts#L199-L205>), [skeleton.md:6](</home/wilder/git-repos/dsh-context-handoff/docs/work/forced-rollover-vcc/skeleton.md#L6>)

Commit `6a02ba9` adds a checkpoint predicate and skips those events in `history.ts`, but the approved scope omits that file and ticket `2zex` delivers the recall/search modules, registration, and tests without changing history. The added filter also cannot change current results: `isCheckpointSource` recognizes `compact-checkpoint` and legacy `plugin`/`compact` sources ([compiler.ts:408-423](</home/wilder/git-repos/dsh-context-handoff/src/vcc/compiler.ts#L408-L423>)), while the existing `directUserText` path returns `null` for every source whose kind is not `user`. This adds an import from the vendored compiler and duplicate branches without changing the history output.

Fix: remove the added import, predicate, and checks from `history.ts`; retain checkpoint filtering in the new recall/search modules that own it. The existing [history.spec.ts:112-154](</home/wilder/git-repos/dsh-context-handoff/tests/history.spec.ts#L112-L154>) cases are the relevant regression check.

## Possible concerns

None beyond the scan and behavior gaps recorded below.

## Serious unresolved risks

- `lizard` parsed the changed files until `tests/recall-search.spec.ts`, then crashed with `IndexError: list index out of range` in its TypeScript binding reader. Its size and duplicate results are incomplete; this review did not retry the scan.
- Tests, builds, and runtime paths were not exercised, as required by the read-only review instruction. In particular, `4fne` and `42ka` remain open, and the three reviewed commits do not change `src/index.ts`; the compiled forced-path wiring, meter preflight, and end-to-end behavior therefore remain unverified here.
- The dispatcher supplied a probe result for emitted `-> result N` pointers from a real four-exchange session. I accepted that result and did not rerun it. The dispatcher also settled that `maxRecallTokens` belongs to `4fne` and is intentionally not yet in `src/config.ts`; C7 lists the key and C3 says the composer uses raw config and VCC defaults until `4fne` wires resolution. Neither item is a finding in this round.

## Queued for the owner

- deepcanary: none; the confirmed findings require contract or documentation alignment, not an unresolved owner choice.
- board: none published; no separate non-blocking design concern was raised.

## Dispositions

- Round 7 reported no new findings and confirmed the prior C8 containment and C10 verification-hook changes at the document/ticket level ([07-review.md:13-24](</home/wilder/git-repos/dsh-context-handoff/docs/work/forced-rollover-vcc/reviews/07-review.md#L13-L24>)). This round did not claim those future engine behaviors as implemented.
- All six current Kata records were open and unassigned when refreshed: `qazm`, `sycr`, `b61t`, `4fne`, `2zex`, and `42ka`.

## Verification

```text
Working tree before report write:
## handoff-only-rollover...origin/handoff-only-rollover [ahead 3]
 M docs/work/forced-rollover-vcc/skeleton.md
?? .dsh-vision-toolkit/
?? .hermes/
?? .scratch/handoff/
?? .scratch/idle-watchdog/
?? .scratch/kata-close-latch.md
?? .scratch/kata-comment-latch-deeper.md
?? .scratch/kata-issue-latch-test.md
?? .scratch/qwen-cutoff/
?? .scratch/structured-handoff/
HEAD=6a02ba975ac67a6b871ba3bb7cb6fca675ffe2df

Kata status refresh:
qazm [open] hold=unassigned
b61t [open] hold=unassigned
4fne [open] hold=unassigned
2zex [open] hold=unassigned
sycr [open] hold=unassigned
42ka [open] hold=unassigned

python3 /home/wilder/.dsh/skills/post-spec-skeleton/scripts/drift_check.py docs/work/forced-rollover-vcc/skeleton.md --root . --baseline /home/wilder/Trash/forced-rollover-vcc/outline-before.json
modules: 12/12 present
status: OK (exit 0)
Warnings were emitted for undeclared public symbols, newly added symbols/modules since the baseline, and baseline paths outside the skeleton module table; no errors were emitted.

python3 /home/wilder/.dsh/skills/post-spec-skeleton/scripts/skeleton_lint.py docs/work/forced-rollover-vcc/skeleton.md
requirements: 12
modules: 12
contracts: 10
stable: 10
provisional: 0
uncertainties: 2
traceability_rows: 12
verification_hooks: 9
warning: every contract is marked stable: confirm internals that may move are provisional
status: OK (exit 0)

mkdir -p /home/wilder/Trash/forced-rollover-vcc-r8-scan && TMPDIR=/home/wilder/Trash/forced-rollover-vcc-r8-scan bash /home/wilder/git-repos/dotfiles/.agents/skills/code-review/scripts/static-scan.sh '86ef259^'
TREE: 86ef259^ (559de9e); 19 changed path(s), 15 code file(s)
===== cccc =====
src/checkpoint.ts: no functions; file total cognitive=7 cyclomatic=12
src/compiled-fallback.ts: buildCompiledReplacement cognitive=12 cyclomatic=13; file total=12/15
src/config.ts: resolveConfig=56/56; file total=67/74
src/history.ts: collectHistory=12/9; readHistoryItem=8/10; file total=35/38
src/recall.ts: projectMessageText=14/15; parseSeqSpec=13/9; recallBySeq=11/8; checkpointSeqFor=10/12; file total=73/84
src/search.ts: searchLog=25/16; file total=29/23
src/tools.ts: lastAcceptedInLog=14/8; newContextTool=0/1; execute=9/10; getContextRemainingTool=0/1; render=11/7; execute=8/10; notesTool=0/1; execute=16/15; historyTool=0/1; execute=11/9; file total=83/106
src/vcc/cap.ts: no functions; file total=1/2
src/vcc/compiler.ts: compileNodes=204/71; compileRegion=39/28; isCjkChar=25/47; findMemorySnapshotSpans=18/9; projectToolResultText=14/10; tailTokens=12/10; truncateTokens=11/10; pickToolKeyArg=10/10; file total=424/311
a summary of 15 files, 310 functions: cognitive sum=786 max=204 median=0 p90=5 p95=11; cyclomatic sum=952 max=71 median=1 p90=6 p95=10
===== lizard size/parameter output =====
src/config.ts:439 resolveConfig 147 NLOC, 56 CCN, 869 tokens, 1 parameter, 147 lines
src/tools.ts:177 newContextTool 93 NLOC, 8 CCN, 406 tokens, 1 parameter, 149 lines
src/vcc/compiler.ts:835 compileNodes 202 NLOC, 62 CCN, 1657 tokens, 3 parameters, 255 lines
tests/compiled-fallback.spec.ts:97 anonymous function 9 NLOC, 1 CCN, 65 tokens, 0 parameters, 120 lines
Error: Fail to parse file `tests/recall-search.spec.ts`; the captured traceback ended with `IndexError: list index out of range` in `lizard_languages/javascript_bindings.py:34`.
===== lizard duplicates =====
The duplicate pass failed on the same TypeScript parser error.
exit codes: cccc=0; lizard=1
STATIC SCAN INCOMPLETE; scan command exit 1

Tests and builds were not run.
```

## Verdict

VERDICT: request changes