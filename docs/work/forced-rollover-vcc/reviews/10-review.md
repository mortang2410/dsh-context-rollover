# Review: Round 10 delta for recall reference guidance

- Date: 2026-11-14
- Mode: Read-only delta review, one reviewer, no commit requested
- Repository: `dsh-context-handoff`
- Feature: `forced-rollover-vcc`
- Base/head: [`eea058b`](https://github.com/scratchspace-mortang/dsh-context-rollover/commit/eea058b97865c1e30f5e18e22d00e6402403dc81) through [`0c6474c`](https://github.com/scratchspace-mortang/dsh-context-rollover/commit/0c6474cea0455e63304f7fac385944cae029f94f)
- Scope: Final delta review of the Round 9 recall-reference finding, the three files changed by `0c6474c`, the recall examples named in the request, and the prior finding record.
- Threat model: A model-facing restore instruction or source example could disagree with the recall tool's required pointer field and prevent a caller from restoring a record. This review covers accidental contract drift, not hostile actors or live runtime behavior.
- Rounds: 10, delta-only re-review
- Publication: Report only; no tracker comments or updates

## Findings

No findings.

## Possible concerns

None.

## Serious unresolved risks

- This reviewer did not run tests or typecheck, as instructed. The dispatcher reports `recall-search.spec.ts` passed 21 tests and typecheck reported 0 errors; this reviewer did not independently observe those runs.
- The review did not invoke the search tool. The corrected output text and its regression assertion were verified in source, not by a live tool call.

## Queued for the owner

- deepcanary: none; no non-blocking concern remains from this delta.
- board: none published; no separate concern remains to publish.

## Verdict

VERDICT: clean

The Round 9 P2 finding is resolved. The search result now names `ref`, the compiler comment now names `ref`, and the test asserts the exact search restore instruction. No new defect was found in this delta.

## Dispositions

| Prior finding | Disposition | Evidence |
|---|---|---|
| [P2] Use the current recall field in remaining examples | RESOLVED | [search.ts:133](</home/wilder/git-repos/dsh-context-handoff/src/search.ts#L133>) emits `ref`; [compiler.ts:1197](</home/wilder/git-repos/dsh-context-handoff/src/vcc/compiler.ts#L1197>) uses `ref`; [recall-search.spec.ts:303-312](</home/wilder/git-repos/dsh-context-handoff/tests/recall-search.spec.ts#L303-L312>) asserts the exact instruction. |

## Call-site sweep

- The read-only stale-key probes found no `type: "seq", id` or `type:"checkpoint", id` occurrences in `src/` or `README.md`. A broader source search for recall examples using `id` also returned no matches.
- The complete examples in [recall.ts:263-264](</home/wilder/git-repos/dsh-context-handoff/src/recall.ts#L263-L264>), [search.ts:133](</home/wilder/git-repos/dsh-context-handoff/src/search.ts#L133>), [compiler.ts:1195-1197](</home/wilder/git-repos/dsh-context-handoff/src/vcc/compiler.ts#L1195-L1197>), and [skeleton.md:137-140](</home/wilder/git-repos/dsh-context-handoff/docs/work/forced-rollover-vcc/skeleton.md#L137-L140>) use `ref`.
- [tools.ts:635](</home/wilder/git-repos/dsh-context-handoff/src/tools.ts#L635>) retains a type-only shorthand, `recall({ type: "checkpoint" })`; it does not give an `id` or show a complete call. The actual schema at [tools.ts:595-599](</home/wilder/git-repos/dsh-context-handoff/src/tools.ts#L595-L599>) requires `ref` and documents checkpoint references, so the shorthand is not a conflicting pointer instruction.

## Verification

```text
Repository:
branch=handoff-only-rollover
HEAD=0c6474cea0455e63304f7fac385944cae029f94f
origin/handoff-only-rollover tracking ref=0c6474cea0455e63304f7fac385944cae029f94f
`git ls-remote origin refs/heads/handoff-only-rollover` returned:
0c6474cea0455e63304f7fac385944cae029f94f refs/heads/handoff-only-rollover
The initial status check showed no tracked worktree changes. The final status check showed uncommitted changes in `src/config.ts`, `src/index.ts`, `src/rollover.ts`, and `src/tools.ts`; those changes are outside the pinned commit and remain unreviewed. This review did not modify those files; it wrote only this report. The current `tools.ts` diff leaves the cited schema lines 595-599 and shorthand at line 635 unchanged. The prior `09-review.md` and unrelated untracked paths were preserved.

`git show --no-ext-diff --format= 0c6474c`
exit 0; exactly three paths changed: `src/search.ts` changes the restore string from `id` to `ref`; `src/vcc/compiler.ts` changes the checkpoint example from `id` to `ref`; `tests/recall-search.spec.ts` asserts the exact `ref` restore instruction. No control-flow code changed.

`cccc src/search.ts src/vcc/compiler.ts tests/recall-search.spec.ts`
exit 0
JSON summary: file_count=3, function_count=94, parse_error_count=0, parse_error_file_count=0; cognitive sum=456, max=204, median=0, p90=9, p95=18; cyclomatic sum=379, max=71, median=1, p90=7, p95=10.
Per-file cognitive/cyclomatic totals: search.ts=29/23, compiler.ts=424/311, recall-search.spec.ts=3/45. The maximum is the existing `compileNodes` implementation, outside the changed logic.

`lizard src/search.ts src/vcc/compiler.ts tests/recall-search.spec.ts`
exit 1 after analyzing all 3 files; the command completed with 4 default complexity-threshold warnings, not a parser failure:
- `searchLog`: CCN 16 (threshold >15); this commit changes only its output string.
- `isCjkChar`: CCN 47; unchanged by this commit.
- `compileNodes`: CCN 62; unchanged by this commit.
- `compileRegion`: CCN 23; this commit changes only a comment in the function.
Total NLOC=1169, function count=93, warning count=4. The four crossings are scan advisories, not findings introduced by the string, comment, or test-assertion changes.

Read-only `functions.grep` probes:
- Pattern `type: "seq", id|type:"checkpoint", id` over `src/`: no matches.
- The same pattern over `README.md`: no matches.
- Pattern `(?i)recall.{0,120}\bid\s*:` over `src/`: no matches.

No tests, builds, typecheck, or tracker operations were run.
```

## Unverified risks

- The dispatcher-reported 21 passing recall/search tests and zero typecheck errors were not independently verified in this read-only review.
- The review verified the changed search text and test assertion in source; it did not observe a live model request using the search tool.
- The final worktree has uncommitted changes in [config.ts](</home/wilder/git-repos/dsh-context-handoff/src/config.ts>), [index.ts](</home/wilder/git-repos/dsh-context-handoff/src/index.ts>), [rollover.ts](</home/wilder/git-repos/dsh-context-handoff/src/rollover.ts>), and [tools.ts](</home/wilder/git-repos/dsh-context-handoff/src/tools.ts>). This report covers only pinned commit `0c6474c`; it does not review those worktree changes.
