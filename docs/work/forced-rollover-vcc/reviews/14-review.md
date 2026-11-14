# Review: round 14 forced-rollover-vcc delta

- Date: 2026-11-14
- Mode: Delta-only re-review; one read-only reviewer; no commit
- Repository: `/home/wilder/git-repos/dsh-context-handoff`
- Feature: `forced-rollover-vcc`
- Base/head: `8dd7d59` to `1c4adc1f3ac9b9375d8d15ca2dae28dc7cada215`
- Scope: `tests/forced-rollover-e2e.spec.ts` and `tests/mutation-check.sh`, the only paths in the pinned diff
- Threat model: Ordinary documentation and test-verifier regressions; hostile writers are out of scope
- Round: 14
- Publication: Report only; no comments or tracker updates

## Review basis

At the start and after verification, HEAD matched `1c4adc1f3ac9b9375d8d15ca2dae28dc7cada215`; the staged and unstaged tracked diffs were empty. The base-to-head diff listed exactly the two scoped files. The mutation script temporarily changed its three source inputs and restored them; no tracked changes remained afterward. The initial status also showed unrelated untracked files.

The round-12 report's old helper probe produced the same `TypeError:`-prefixed text for both `Error` and `TypeError` ([`12-review.md:15-22`](</home/wilder/git-repos/dsh-context-handoff/docs/work/forced-rollover-vcc/reviews/12-review.md#L15-L22>)). The round-13 report and its requested Trash copy both say `VERDICT: clean` and mark all eight round-11 findings resolved ([`13-review.md`](</home/wilder/git-repos/dsh-context-handoff/docs/work/forced-rollover-vcc/reviews/13-review.md>), [`13-verdict.md`](</home/wilder/Trash/forced-rollover-vcc/13-verdict.md>)). The current delta changes neither the source paths nor the separate automatic-rollover specs that carry seven of those fixes. The one round-13 finding sharing the e2e file, the note-symlink traversal test, remains unchanged at [`tests/forced-rollover-e2e.spec.ts:674-731`](</home/wilder/git-repos/dsh-context-handoff/tests/forced-rollover-e2e.spec.ts#L674-L731>).

No authorized different-family verifier route was available, so no separate cross-family verifier ran. This process gap does not withhold this verdict, as directed.

## Round-12 finding dispositions

### [P2] FIXED - Assert the real TypeError at the engine seam

The four overlap cases now assert only the plain logged message, at [`tests/forced-rollover-e2e.spec.ts:616-670`](</home/wilder/git-repos/dsh-context-handoff/tests/forced-rollover-e2e.spec.ts#L616-L670>). The `refusalText` helper now strips the lifecycle wrapper without adding an error-class prefix, at [`tests/forced-rollover-e2e.spec.ts:827-837`](</home/wilder/git-repos/dsh-context-handoff/tests/forced-rollover-e2e.spec.ts#L827-L837>). Before the lifecycle catches the error and logs only `error.message` ([`src/index.ts:488-490`](</home/wilder/git-repos/dsh-context-handoff/src/index.ts#L488-L490>)), the test calls the engine's `assertNotesRootDisjoint` seam and requires the rejected object to be an instance of `TypeError`, at [`tests/forced-rollover-e2e.spec.ts:798-803`](</home/wilder/git-repos/dsh-context-handoff/tests/forced-rollover-e2e.spec.ts#L798-L803>). The automatic path reaches that same check through `renderAutomaticNotes`, at [`src/index.ts:712-715`](</home/wilder/git-repos/dsh-context-handoff/src/index.ts#L712-L715>) and [`src/index.ts:805-807`](</home/wilder/git-repos/dsh-context-handoff/src/index.ts#L805-L807>); the overlap and disjointness error factories return `TypeError`, at [`src/index.ts:213-232`](</home/wilder/git-repos/dsh-context-handoff/src/index.ts#L213-L232>).

Red-green argument: a plain `Error` with the same message is not a `TypeError`, so it cannot satisfy `.rejects.toBeInstanceOf(TypeError)`; the test no longer infers the class from log text. The current implementation passes the focused e2e run, 7/7 tests. I did not inject a plain-`Error` source mutant under the read-only review scope; the negative side is established by the direct instance assertion and the live caller trace.

Fix: Keep the class assertion at the pre-catch engine seam and keep `refusalText` limited to removing log decoration; the e2e spec is the focused check.

### [P2] FIXED - Mutation-test all README key and global assertions

The README runner now makes a whole-README copy for each of the eight compiler-key rows and requires exit 1 plus a diagnostic naming the missing key, at [`tests/mutation-check.sh:357-387`](</home/wilder/git-repos/dsh-context-handoff/tests/mutation-check.sh#L357-L387>). It separately removes the `recall` and `search` tool-list entries and the manual-path sentence, requiring the corresponding exact diagnostic, at [`tests/mutation-check.sh:389-425`](</home/wilder/git-repos/dsh-context-handoff/tests/mutation-check.sh#L389-L425>). The checker owns those guards at [`tests/readme-check.mjs:29-40`](</home/wilder/git-repos/dsh-context-handoff/tests/readme-check.mjs#L29-L40>), [`tests/readme-check.mjs:99-118`](</home/wilder/git-repos/dsh-context-handoff/tests/readme-check.mjs#L99-L118>), and [`tests/readme-check.mjs:246-248`](</home/wilder/git-repos/dsh-context-handoff/tests/readme-check.mjs#L246-L248>).

Red-green argument: if a `COMPILER_KEYS` member or one of the global tool/manual-path guards is deleted from the checker, the matching broken README copy will either pass or lack the required diagnostic. The runner treats either result as `fail` and exits nonzero, at [`tests/mutation-check.sh:380-385`](</home/wilder/git-repos/dsh-context-handoff/tests/mutation-check.sh#L380-L385>), [`tests/mutation-check.sh:400-404`](</home/wilder/git-repos/dsh-context-handoff/tests/mutation-check.sh#L400-L404>), [`tests/mutation-check.sh:417-421`](</home/wilder/git-repos/dsh-context-handoff/tests/mutation-check.sh#L417-L421>), and [`tests/mutation-check.sh:439-473`](</home/wilder/git-repos/dsh-context-handoff/tests/mutation-check.sh#L439-L473>). The standalone mutation run killed all eight key-row cases, both tool-list cases, and the manual-claim case. I did not delete checker source guards during this read-only review; this failure path is a source-level counterfactual, while the README-removal mutants were run.

Fix: Keep the whole-document mutants and require key-specific failures for every key and global assertion; `bash tests/mutation-check.sh` is the check.

## Round-13 findings remain resolved

The round-13 report and its copy both disposition these eight findings as resolved. The round-14 diff does not change any of the cited source files or [`tests/automatic-rollover.spec.ts`](</home/wilder/git-repos/dsh-context-handoff/tests/automatic-rollover.spec.ts>); the e2e change is confined to the separate overlap-refusal seam and leaves the note-symlink case intact.

| Round-13 finding | Round-14 disposition and current evidence |
|---|---|
| Reject symlinked note entries into the handoff tree | Still resolved: [`src/notes.ts:81-124`](</home/wilder/git-repos/dsh-context-handoff/src/notes.ts#L81-L124>) and [`tests/forced-rollover-e2e.spec.ts:674-731`](</home/wilder/git-repos/dsh-context-handoff/tests/forced-rollover-e2e.spec.ts#L674-L731>) are unchanged in the relevant behavior. |
| Canonicalize both roots and reject dangling symlinks | Still resolved: [`src/index.ts:153-193`](</home/wilder/git-repos/dsh-context-handoff/src/index.ts#L153-L193>) and [`tests/automatic-rollover.spec.ts:512-551`](</home/wilder/git-repos/dsh-context-handoff/tests/automatic-rollover.spec.ts#L512-L551>) are outside the delta. |
| Refuse relative handoff roots without a session working directory | Still resolved: [`src/index.ts:821-848`](</home/wilder/git-repos/dsh-context-handoff/src/index.ts#L821-L848>) and [`tests/automatic-rollover.spec.ts:554-569`](</home/wilder/git-repos/dsh-context-handoff/tests/automatic-rollover.spec.ts#L554-L569>) are outside the delta. |
| Assert a preflight miss never calls `commitRollover` | Still resolved: [`src/index.ts:742-759`](</home/wilder/git-repos/dsh-context-handoff/src/index.ts#L742-L759>) and [`tests/automatic-rollover.spec.ts:797-825`](</home/wilder/git-repos/dsh-context-handoff/tests/automatic-rollover.spec.ts#L797-L825>) are outside the delta. |
| Prove handoff priority when both branches are eligible | Still resolved: [`src/index.ts:461-485`](</home/wilder/git-repos/dsh-context-handoff/src/index.ts#L461-L485>) and [`tests/automatic-rollover.spec.ts:406-423`](</home/wilder/git-repos/dsh-context-handoff/tests/automatic-rollover.spec.ts#L406-L423>) are outside the delta. |
| Retry after a size-based deferral | Still resolved: [`tests/automatic-rollover.spec.ts:654-697`](</home/wilder/git-repos/dsh-context-handoff/tests/automatic-rollover.spec.ts#L654-L697>) is outside the delta. |
| Assert compiled ordering independently of the composer | Still resolved: [`tests/automatic-rollover.spec.ts:303-313`](</home/wilder/git-repos/dsh-context-handoff/tests/automatic-rollover.spec.ts#L303-L313>) and [`tests/automatic-rollover.spec.ts:355-365`](</home/wilder/git-repos/dsh-context-handoff/tests/automatic-rollover.spec.ts#L355-L365>) are outside the delta. |
| Limit the per-call budget comment to `recall` | Still resolved: [`src/config.ts:293-296`](</home/wilder/git-repos/dsh-context-handoff/src/config.ts#L293-L296>) and [`src/tools.ts:600-665`](</home/wilder/git-repos/dsh-context-handoff/src/tools.ts#L600-L665>) are outside the delta. |

## Static scan

The round-14 scan analyzed both changed paths as two changed paths and one recognized code file. `cccc` analyzed 55 functions, with cognitive maximum 6 and cyclomatic maximum 9. `lizard` reported one 81-line size warning for `crossWithHandoff`, a test helper at [`tests/forced-rollover-e2e.spec.ts:385-399`](</home/wilder/git-repos/dsh-context-handoff/tests/forced-rollover-e2e.spec.ts#L385-L399>); those lines are not changed by this delta. Its 4.25% duplicate blocks are fixture assertions that extract the committed summary at [`tests/forced-rollover-e2e.spec.ts:447-452`](</home/wilder/git-repos/dsh-context-handoff/tests/forced-rollover-e2e.spec.ts#L447-L452>) and [`tests/forced-rollover-e2e.spec.ts:715-720`](</home/wilder/git-repos/dsh-context-handoff/tests/forced-rollover-e2e.spec.ts#L715-L720>). The one-line test-helper crossing and the short repeated fixture extraction do not name an actionable defect. The scan's extension filter excludes `.sh`; I reviewed and ran the shell verifier directly.

## Possible concerns

None.

## Serious unresolved risks

- No authorized model-family route different from the assigned reviewer route was available, so the required independent cross-family verifier did not run. The reviewer records this gap without withholding the verdict, as the user directed.
- The plain-`Error` negative mutant and checker-source guard deletions were not injected. Their failure behavior is established by the direct instance matcher and by the runner's explicit nonzero/diagnostic predicates; the current positive paths and README-removal mutants passed their checks.

## Queued for the owner

- DeepCanary: none; no separate non-blocking concern was retained.
- Board: none published; this was a report-only review.

## Verification

```text
Initial scope and tree:
HEAD=1c4adc1f3ac9b9375d8d15ca2dae28dc7cada215
Base-to-head changed paths: tests/forced-rollover-e2e.spec.ts, tests/mutation-check.sh
Tracked index and worktree: clean before review and after all checks
Unrelated untracked paths were present at the initial status check.

E2E command, run with TMPDIR=/home/wilder/Trash/forced-rollover-vcc,
NODE_OPTIONS='--max-old-space-size=2048 --disable-wasm-trap-handler',
ulimit -n 512, and a 180-second timeout:
npx vitest run tests/forced-rollover-e2e.spec.ts
Result: 1 test file passed; 7 tests passed; exit 0.

README commands:
node tests/readme-check.mjs
Result: readme-check: OK (8 keys, 2 tools, 3 guarantees, no automatic notes-checkpoint claim); exit 0.
node tests/readme-check.mjs /home/wilder/Trash/forced-rollover-vcc/42ka/review/README-contradiction.md
Result: expected exit 1; three failures included the automatic-path notes-checkpoint claim and the missing manual-path statement. The paired wrapper returned 0 after confirming exit 0 for the real README and exit 1 for this fixture.

Mutation command, run alone and not concurrently with a separate Vitest process:
TMPDIR=/home/wilder/Trash/forced-rollover-vcc
NODE_OPTIONS='--max-old-space-size=2048 --disable-wasm-trap-handler'
VITEST_TIMEOUT_SECONDS=60
MUTATION_WORK_DIR=/home/wilder/Trash/forced-rollover-vcc/14-mutation-check-review
bash tests/mutation-check.sh
Result: compiled-marker, log-position, cap-shrink, and readme-check-anchors all killed; the eight key-row mutants, `recall`, `search`, and manual-claim mutants each produced the required diagnostic; `mutation-check: OK`; exit 0.

Static scan:
TMPDIR=/home/wilder/Trash/forced-rollover-vcc bash /home/wilder/git-repos/dotfiles/.agents/skills/code-review/scripts/static-scan.sh 8dd7d59
Result: 2 changed paths, 1 recognized code file; `cccc` 55 functions, cognitive max 6, cyclomatic max 9; `lizard` one 81-line test-helper warning and 4.25% test-fixture duplicate blocks; exit 0.

Post-check state:
HEAD remained 1c4adc1f3ac9b9375d8d15ca2dae28dc7cada215; `git diff --quiet` and `git diff --cached --quiet` both passed.
```

## Dispositions

| Prior finding | Disposition | Evidence |
|---|---|---|
| Round 12 P2: e2e fabricates the `TypeError` class from `refusalText` | FIXED | [`tests/forced-rollover-e2e.spec.ts:798-803`](</home/wilder/git-repos/dsh-context-handoff/tests/forced-rollover-e2e.spec.ts#L798-L803>), [`tests/forced-rollover-e2e.spec.ts:835-837`](</home/wilder/git-repos/dsh-context-handoff/tests/forced-rollover-e2e.spec.ts#L835-L837>) |
| Round 12 P2: README mutation runner misses compiler-key guards and global assertions | FIXED | [`tests/mutation-check.sh:357-425`](</home/wilder/git-repos/dsh-context-handoff/tests/mutation-check.sh#L357-L425>); standalone mutation run killed each README-removal mutant |
| Round 13: eight source/test findings | STILL RESOLVED; none reopened | Each current line reference appears in the table above; the relevant source and automatic-rollover paths are outside the round-14 diff, and the e2e note-symlink test is unchanged. |

## Verdict

The round-14 delta fixes both round-12 findings, keeps all eight round-13 findings resolved, and introduces no actionable finding. The cross-family verifier gap is recorded but does not withhold this verdict.

VERDICT: clean
