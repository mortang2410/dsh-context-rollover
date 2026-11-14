# Review: Round 9 implementation and skeleton delta for forced-rollover VCC

- Date: 2026-11-14
- Mode: Read-only delta review, one reviewer, no commit requested
- Repository: `dsh-context-handoff`
- Feature: `forced-rollover-vcc`
- Base/head: [`6a02ba9`](https://github.com/scratchspace-mortang/dsh-context-rollover/commit/6a02ba975ac67a6b871ba3bb7cb6fca675ffe2df) through [`eea058b`](https://github.com/scratchspace-mortang/dsh-context-rollover/commit/eea058b97865c1e30f5e18e22d00e6402403dc81); source fix [`07acbed`](https://github.com/scratchspace-mortang/dsh-context-rollover/commit/07acbed)
- Scope: Round 8 fixes in the source, tests, and README, plus the skeleton revision in `eea058b`; reviewed only the recall/search contract, history restoration, changed tests and documentation, current exports, and the shared model-surface gate.
- Threat model: An outdated model-facing instruction could disagree with the registered tool contract; search scope text could promise excluded checkpoint records; skeleton surfaces could drift from current exports. This review covers accidental contract drift, not hostile actors or live runtime behavior.
- Rounds: 9, delta-only re-review of Round 8 findings
- Publication: Report only; no tracker comments or updates

## Findings

### [P2] Use the current recall field in remaining examples - [search.ts:133](</home/wilder/git-repos/dsh-context-handoff/src/search.ts#L133>), [compiler.ts:1197](</home/wilder/git-repos/dsh-context-handoff/src/vcc/compiler.ts#L1197>), [tools.ts:595-623](</home/wilder/git-repos/dsh-context-handoff/src/tools.ts#L595-L623>) [Call-site and contract check]

For a search with hits, `searchLog` appends `recall({ type: "seq", id: "<seq>" })` to its returned text. `searchTool.execute` forwards that text. The current recall schema requires `ref`, and its handler reads `args.ref`; the emitted example therefore does not supply the declared field. The related compiler comment also gives a checkpoint recall example with `id`. A source grep found these two current-code references and the historical Round 8 report. The search tests assert hits and positions, but do not assert the emitted restore instruction.

This is a source-traced contract mismatch, not a runtime invocation. The tested path was intentionally not run in this read-only round.

Fix: In `src/search.ts::searchLog`, emit `ref` instead of `id`, and update the example in `src/vcc/compiler.ts` to use `ref`. Add an assertion to the search test that the returned restore instruction uses `ref` and not `id`; `npx vitest run tests/recall-search.spec.ts` would verify the emitted text against the tool contract after the fix.

## Possible concerns

None. The exported `searchLog` JSDoc says “every record,” but the same module defines a record as a derived message or log-only event and explicitly excludes compaction checkpoint nodes; the current README and tool description also state that checkpoints are recall-only.

## Serious unresolved risks

- This review did not run tests, builds, or typecheck under the round's read-only restriction. The dispatcher reported 490 passing tests and a passing typecheck after the fixes, but this reviewer did not independently observe those runs.
- This review did not invoke the search tool. The finding is established by tracing the returned search text to the required recall schema and handler, not by a live tool call.

## Queued for the owner

- deepcanary: none; tracker records are outside this round's permitted writes.
- board: none published; tracker publication is outside this round's permitted writes.

## Verdict

VERDICT: request changes

The Round 8 fixes align the schema, handler, tests, README, tool description, history scope, and skeleton rows. One model-facing search instruction and one related source comment still use `id` while the tool requires `ref`; update those examples and cover the returned instruction before accepting the delta.

## Dispositions

| Round 8 finding | Disposition | Evidence |
|---|---|---|
| [P2] Align the recall tool arguments with C6 | RESOLVED | [tools.ts:595-623](</home/wilder/git-repos/dsh-context-handoff/src/tools.ts#L595-L623>) requires and reads `ref`; [recall-search.spec.ts:193-297](</home/wilder/git-repos/dsh-context-handoff/tests/recall-search.spec.ts#L193-L297>) uses `ref`, including budget cases; [skeleton.md:130-145](</home/wilder/git-repos/dsh-context-handoff/docs/work/forced-rollover-vcc/skeleton.md#L130-L145>) includes optional `max_tokens`. |
| [P2] Describe the records that search actually includes | RESOLVED | [tools.ts:631-647](</home/wilder/git-repos/dsh-context-handoff/src/tools.ts#L631-L647>) and [README.md:113-116](</home/wilder/git-repos/dsh-context-handoff/README.md#L113-L116>) limit the claim to original conversation records and route generated checkpoint bodies to checkpoint recall; [search.ts:92-94](</home/wilder/git-repos/dsh-context-handoff/src/search.ts#L92-L94>) and [recall-search.spec.ts:329-334](</home/wilder/git-repos/dsh-context-handoff/tests/recall-search.spec.ts#L329-L334>) preserve the exclusion. |
| [P3] Remove the unowned redundant history filter | RESOLVED | `git diff --exit-code 6a02ba9^..eea058b -- src/history.ts` printed `history_pre_2zex_match=yes`; the current file matches its pre-2zex version. |

## Verification

```text
Repository state before report write:
## handoff-only-rollover...origin/handoff-only-rollover
?? .dsh-vision-toolkit/
?? .hermes/
?? .scratch/handoff/
?? .scratch/idle-watchdog/
?? .scratch/kata-close-latch.md
?? .scratch/kata-comment-latch-deeper.md
?? .scratch/kata-issue-latch-test.md
?? .scratch/qwen-cutoff/
?? .scratch/structured-handoff/
HEAD=eea058b97865c1e30f5e18e22d00e6402403dc81
The unrelated untracked paths were preserved; no tracked worktree changes were present.

`git diff --no-ext-diff 6a02ba9..07acbed -- README.md src/history.ts src/recall.ts src/tools.ts tests/recall-search.spec.ts`
exit 0. The diff changes the README and tool search scope, renames recall's required field from `id` to `ref` in schema and handler, updates the cut marker and recall test calls, removes the redundant history predicate, and binds the fixture cast to `providerCtx`.

`git diff --no-ext-diff 6a02ba9..eea058b -- docs/work/forced-rollover-vcc/skeleton.md`
exit 0. The revision splits M8/M12 into one-path rows, lists their exported helper and error surfaces, names M9's shared model-surface gate and default recall budget, adds `max_tokens` to C6, and records b61t and 2zex in the revision log. Current export declarations match the M8/M12/M9 rows; `src/index.ts:272-300` confirms the shared registration gate; `src/tools.ts:677-689` uses VCC's default recall budget.

`git diff --exit-code 6a02ba9^..eea058b -- src/history.ts`
history_pre_2zex_match=yes
exit 0

`cccc src/tools.ts src/recall.ts src/history.ts tests/recall-search.spec.ts`
exit 0
JSON summary: file_count=4, function_count=105, parse_error_count=0, parse_error_file_count=0; cognitive sum=190, max=16, median=0, p90=8, p95=11; cyclomatic sum=269, max=15, median=1, p90=8, p95=9.
Per-file cognitive/cyclomatic totals: history.ts=31/34, recall.ts=73/84, tools.ts=83/106, recall-search.spec.ts=3/45.

`lizard src/tools.ts src/recall.ts src/history.ts tests/recall-search.spec.ts`
exit 0
================================================
  NLOC    CCN   token  PARAM  length  location  
------------------------------------------------
       3      1     30      2       3 notesStoreFor@52-54@src/tools.ts
       2      2     13      0       2 (anonymous)@99-100@src/tools.ts
      16      8    130      1      17 lastAcceptedInLog@89-105@src/tools.ts
       6      3     52      1       6 lastAcceptedNewContextAt@113-118@src/tools.ts
      12      2     54      2      13 recordAcceptedNewContextAt@121-133@src/tools.ts
       7      3     79      1       7 describeDuration@140-146@src/tools.ts
       6      1     25      1       6 refusal@169-174@src/tools.ts
      12      3     71      1      12 render@212-223@src/tools.ts
      93      8    406      1     149 newContextTool@177-325@src/tools.ts
      24      7    192      1      29 render@339-367@src/tools.ts
      23      9    153      1      23 execute@369-391@src/tools.ts
      15      1     51      1      65 getContextRemainingTool@329-393@src/tools.ts
       4      1     38      1       4 render@429-432@src/tools.ts
      57      8    321      1      64 notesTool@396-459@src/tools.ts
       4      1     16      1       4 constructor@33-36@src/recall.ts
      28     12    181      1      28 projectMessageText@74-101@src/recall.ts
       8      2     65      2       8 recordProjection@111-118@src/recall.ts
       9      4     84      1       9 pointerSeq@126-134@src/recall.ts
       3      1     24      2       3 positionMiss@142-144@src/recall.ts
       1      1      7      0       1 (anonymous)@155-155@src/recall.ts
       5      3     59      2       5 positionBody@152-156@src/recall.ts
      14      6    142      2      14 resultSeqFor@165-178@src/recall.ts
       7      4     62      1       7 findCheckpointSeqs@187-193@src/recall.ts
      27     10    229      2      27 checkpointSeqFor@202-228@src/recall.ts
       3      2     32      1       3 isCheckpointEvent@231-233@src/recall.ts
       1      1      4      0       1 (anonymous)@270-270@src/recall.ts
       1      1      4      0       1 (anonymous)@275-275@src/recall.ts
      32      5    227      3      32 recallSeqs@245-276@src/recall.ts
       6      3     38      1       6 recallBudget@283-288@src/recall.ts
      18      9    216      1      18 parseSeqSpec@297-314@src/recall.ts
      27     10    191      3      29 recallBySeq@323-351@src/recall.ts
       4      2     40      3       4 recallByResult@360-363@src/recall.ts
       4      2     40      3       4 recallByCheckpoint@372-375@src/recall.ts
       1      2     18      0       1 (anonymous)@41-41@src/history.ts
       1      1      4      0       1 (anonymous)@42-42@src/history.ts
       6      1     45      1       6 messageBlocksText@39-44@src/history.ts
       4      2     43      1       4 directUserText@56-59@src/history.ts
       8      3     50      3       8 windowForSeq@69-76@src/history.ts
      32      7    172      3      35 collectHistory@86-120@src/history.ts
       8      3     85      3       8 snippetAround@123-130@src/history.ts
      27      6    171      5      27 searchHistory@141-167@src/history.ts
      40      9    199      5      43 readHistoryItem@179-221@src/history.ts
       3      2     22      0       3 (anonymous)@84-86@tests/recall-search.spec.ts
       4      1     28      2       4 appendSeq@89-92@tests/recall-search.spec.ts
       4      1     37      2       4 openTurn@95-98@tests/recall-search.spec.ts
       7      1     40      0       7 (anonymous)@102-108@tests/recall-search.spec.ts
       3      1     23      2       9 appendUserText@101-109@tests/recall-search.spec.ts
      14      1     83      0      14 (anonymous)@125-138@tests/recall-search.spec.ts
      15      1     94      0      15 (anonymous)@139-153@tests/recall-search.spec.ts
      10      1     44      0      10 (anonymous)@154-163@tests/recall-search.spec.ts
      17      1    202      1      55 fixture@118-172@tests/recall-search.spec.ts
       1      3     20      0       1 (anonymous)@189-189@tests/recall-search.spec.ts
      17      1    113      3      17 runTool@175-191@tests/recall-search.spec.ts
       7      1     72      0       7 (anonymous)@194-200@tests/recall-search.spec.ts
       7      1     64      0       7 (anonymous)@202-208@tests/recall-search.spec.ts
       7      1     66      0       7 (anonymous)@210-216@tests/recall-search.spec.ts
       5      1     32      0      25 (anonymous)@193-217@tests/recall-search.spec.ts
       9      1     92      0       9 (anonymous)@220-228@tests/recall-search.spec.ts
       7      1     72      0       7 (anonymous)@230-236@tests/recall-search.spec.ts
       4      1     22      0      19 (anonymous)@219-237@tests/recall-search.spec.ts
       7      1     67      0       7 (anonymous)@240-246@tests/recall-search.spec.ts
       7      1     61      0       7 (anonymous)@248-254@tests/recall-search.spec.ts
       4      1     22      0      17 (anonymous)@239-255@tests/recall-search.spec.ts
       6      1     68      0       6 (anonymous)@258-263@tests/recall-search.spec.ts
       3      1     12      0       8 (anonymous)@257-264@tests/recall-search.spec.ts
       8      1     85      0       8 (anonymous)@267-274@tests/recall-search.spec.ts
      10      1     69      0      13 (anonymous)@276-288@tests/recall-search.spec.ts
      10      1     70      0      10 (anonymous)@290-299@tests/recall-search.spec.ts
       5      1     32      0      35 (anonymous)@266-300@tests/recall-search.spec.ts
       8      1     78      0       8 (anonymous)@303-310@tests/recall-search.spec.ts
       7      1     76      0       7 (anonymous)@312-318@tests/recall-search.spec.ts
       8      1     81      0       8 (anonymous)@320-327@tests/recall-search.spec.ts
       6      1     53      0       6 (anonymous)@329-334@tests/recall-search.spec.ts
       6      1     48      0       6 (anonymous)@336-341@tests/recall-search.spec.ts
       6      1     48      0       6 (anonymous)@343-348@tests/recall-search.spec.ts
       8      1     62      0      48 (anonymous)@302-349@tests/recall-search.spec.ts
       3      1     11      0       3 (anonymous)@352-354@tests/recall-search.spec.ts
      10      1    148      0      10 (anonymous)@356-365@tests/recall-search.spec.ts
       4      1     21      0      16 (anonymous)@351-366@tests/recall-search.spec.ts
       5      1     48      0       5 (anonymous)@369-373@tests/recall-search.spec.ts
       4      1     39      2       4 provide@381-384@tests/recall-search.spec.ts
      10      1     57      0      16 (anonymous)@375-390@tests/recall-search.spec.ts
       4      1     22      0      24 (anonymous)@368-391@tests/recall-search.spec.ts
4 file analyzed.
==============================================================
NLOC    Avg.NLOC  AvgCCN  Avg.token  function_cnt    file
--------------------------------------------------------------
    547      20.0     4.1      115.4        14     src/tools.ts
    223      10.6     4.2       87.4        19     src/recall.ts
    148      14.1     3.8       87.4         9     src/history.ts
    308       7.1     1.1       58.6        41     tests/recall-search.spec.ts

===============================================================================================================
No thresholds exceeded (cyclomatic_complexity > 15 or length > 1000 or nloc > 1000000 or parameter_count > 100)
==========================================================================================
Total nloc   Avg.NLOC  AvgCCN  Avg.token   Fun Cnt  Warning cnt   Fun Rt   nloc Rt
------------------------------------------------------------------------------------------
      1226      10.8     2.6       77.9       83            0      0.00    0.00
```

Read-only call-site grep pattern:
recall.{0,160}(id:|id:"|id =|args\.id)|type:\s*['"](?:seq|result|checkpoint)['"]\s*,\s*id\s*:
Current code hits: src/search.ts:133 and src/vcc/compiler.ts:1197. The third hit was the historical Round 8 report at docs/work/forced-rollover-vcc/reviews/08-review.md:17.

The case-insensitive scope search found the `searchLog` JSDoc's “every record” wording, which the module defines to exclude generated checkpoints, and the README/tool descriptions' qualified “every original conversation record” claim. Only the Round 8 report retains the superseded unqualified wording; direct reads confirm the current user-facing scope is qualified.

No cccc.toml or whitelizard.txt was found in the repository.
No tests, builds, typecheck, or tracker operations were run.
```

## Unverified risks

- No runtime tool invocation was performed; a runtime request log or direct tool call would prove the emitted text in operation, but is not necessary to establish the source/schema mismatch and was outside this round's permitted checks.
- Tests, builds, and typecheck remain externally reported rather than independently verified in this review.
