# Review: Round 11 forced-rollover wiring

- Date: 2026-11-14
- Mode: Standard, three finders; report only, no commit
- Repository: `dsh-context-handoff`
- Feature: `forced-rollover-vcc`
- Base/head: [`0b3ea70`](https://github.com/scratchspace-mortang/dsh-context-rollover/commit/0b3ea70ee11e17e5c6c6c7caad5c98e17f90a209) through [`5b42492`](https://github.com/scratchspace-mortang/dsh-context-rollover/commit/5b42492679d07886beefbb04ac4ec405c2432656)
- Scope: Round 11 delta in nine source/test files, including implementer commit [`d951f79`](https://github.com/scratchspace-mortang/dsh-context-rollover/commit/d951f798a5cd7c902305434eca3cc43600b612f2) and dispatcher-owned guidance correction `5b42492`; no later commit content reviewed
- Threat model: Ordinary configuration mistakes and symlinked paths that cross the notes/handoff boundary; hostile concurrent writers are out of scope
- Rounds: 11
- Publication: Report only; no comments or tracker updates published

## Findings

The three finder reports returned `Request changes`. The findings below are source-backed against the pinned range and ticket/skeleton contracts. Each finding is tagged with the Spec check. The independent cross-family verifier required by the review procedure did not run; see Serious unresolved risks.

### [P1] Reject note entries that resolve into the handoff tree - [src/index.ts:684](</home/wilder/git-repos/dsh-context-handoff/src/index.ts#L684>) (Spec)

When a note file under the per-session notes root is a symlink to a handoff document, the automatic path checks only the roots before rendering notes. [NotesStore.list](</home/wilder/git-repos/dsh-context-handoff/src/notes.ts#L82-L107>) calls `stat` on each entry, and [renderAll](</home/wilder/git-repos/dsh-context-handoff/src/notes.ts#L183-L193>) then reads it. Node documents that `stat` follows symbolic links ([fsPromises.stat](https://nodejs.org/download/release/v22.23.4/docs/api/fs.html#fspromisesstatpath-options)); the notes root can therefore be disjoint while the compiled copy still stats and reads a file under the configured handoff root, contrary to C8.

Fix: Make note enumeration reject symlinks before following them and keep recursive traversal from entering symlinked directories; add a case linking a note entry to a handoff sentinel and assert the sentinel is neither read nor rendered.

### [P2] Fail closed when a missing root prevents proving disjointness - [src/index.ts:809-815](</home/wilder/git-repos/dsh-context-handoff/src/index.ts#L809-L815>) (Spec)

If a missing handoff leaf sits below a symlink ancestor that resolves into the notes root, the lexical paths differ and `realpath(handoffAbsolute)` can return `ENOENT`. The code ignores that missing-path error and accepts the roots without proving they are disjoint. A dangling notes-root symlink has the same unresolved-target problem: [canonicalRoot](</home/wilder/git-repos/dsh-context-handoff/src/index.ts#L146-L161>) appends a missing suffix after resolving an ancestor, while the handoff-root comparison can skip its unresolved realpath. C8 requires failure when no available comparison proves disjointness.

Fix: In `assertNotesRootDisjoint`, canonicalize both roots through their nearest resolvable ancestors and reject dangling symlinks or unresolved paths whenever the relationship remains unknown; add separate tests for a missing handoff leaf below a symlink alias and a dangling notes-root symlink, asserting refusal before note rendering.

### [P2] Refuse relative handoff roots when the session has no working directory - [src/index.ts:793-796](</home/wilder/git-repos/dsh-context-handoff/src/index.ts#L793-L796>) (Spec)

`SessionHeader.cwd` is optional ([SessionHeader](</home/wilder/git-repos/deepseek-harness/packages/core/session/src/types.ts#L94-L105>), and [handoffDir's config comment](</home/wilder/git-repos/dsh-context-handoff/src/config.ts#L218-L224>) says relative paths resolve against the session working directory. The containment check instead falls back to `process.cwd()`. The handoff reader refuses a relative document path when the session has no cwd ([resolveHandoffPath](</home/wilder/git-repos/dsh-context-handoff/src/handoff.ts#L91-L123>)), so the boundary check can compare against a different root than the handoff path contract permits and accept a configuration it cannot prove safe.

Fix: Make the containment check use the handoff reader's resolution rule and fail closed for a relative `handoffDir` without `session.header.cwd`; add a no-cwd case asserting a `notesDir` TypeError before any note-store access.

### [P2] Assert that a preflight miss skips `commitRollover` - [tests/automatic-rollover.spec.ts:651-669](</home/wilder/git-repos/dsh-context-handoff/tests/automatic-rollover.spec.ts#L651-L669>) (Spec)

The meter-miss test asserts no rollover and no `compaction/start`, but does not assert that `commitRollover` was not called. The commit-time size guard itself returns before appending `compaction/start` ([rollover.ts](</home/wilder/git-repos/dsh-context-handoff/src/rollover.ts#L596-L618>)), so the current assertions can pass even if a preflight miss reaches the commit function, contrary to the ticket's explicit call-boundary criterion.

Fix: Add a call-count assertion at the `commitRollover` seam for the `fits === false` case, while retaining the no-bracket assertions; the test should fail if the engine calls commit after a preflight miss.

### [P2] Make the handoff-priority fixture eligible for both branches - [tests/automatic-rollover.spec.ts:353-385](</home/wilder/git-repos/dsh-context-handoff/tests/automatic-rollover.spec.ts#L353-L385>) (Spec)

The fixture sets `thresholdRatio` to `0.9` and uses short filler exchanges; its comment says the forced branch cannot preempt the pending request. Reversing the branch priority would therefore still pass because automatic rollover is not eligible when the handoff arrives. The test does not discriminate the required priority when both paths could run.

Fix: Arrange for the automatic threshold and pending handoff to be eligible on the same pre-step, then assert the handoff document is committed byte-for-byte and the compiled branch does not run.

### [P2] Retry after a size-based deferral - [tests/automatic-rollover.spec.ts:621-649](</home/wilder/git-repos/dsh-context-handoff/tests/automatic-rollover.spec.ts#L621-L649>) (Spec)

This test ends after one meter-size refusal. The existing retry case covers only a no-selectable-span deferral ([automatic-rollover.spec.ts](</home/wilder/git-repos/dsh-context-handoff/tests/automatic-rollover.spec.ts#L528-L553>)), so no test proves that the size-refusal branch retries on a later pre-step as ticket 4fne requires.

Fix: Make the meter refuse the first candidate and accept a later candidate in the same turn; assert the first attempt opens no bracket and the later pre-step commits.

### [P2] Assert entries follow the notes header independently - [tests/automatic-rollover.spec.ts:342-349](</home/wilder/git-repos/dsh-context-handoff/tests/automatic-rollover.spec.ts#L342-L349>) (Spec)

The expected text helper calls `buildCompiledReplacement` itself ([automatic-rollover.spec.ts](</home/wilder/git-repos/dsh-context-handoff/tests/automatic-rollover.spec.ts#L204-L221>)), so its equality assertion follows any ordering change in the production composer. The independent assertion checks only that the recall guide precedes the notes header; it does not assert that compiled entries follow the header, as C3 requires ([compiled-fallback.ts](</home/wilder/git-repos/dsh-context-handoff/src/compiled-fallback.ts#L99-L103>)).

Fix: Assert the guide, notes header, and a known compiled entry in that order without using the production composer to build the expected order; include the no-notes path separately.

### [P3] Limit the per-call budget comment to recall - [src/config.ts:293-295](</home/wilder/git-repos/dsh-context-handoff/src/config.ts#L293-L295>) (Spec)

The comment says a per-call `max_tokens` overrides the budget for a recall or search result. The recall schema accepts `max_tokens` ([tools.ts](</home/wilder/git-repos/dsh-context-handoff/src/tools.ts#L600-L603>)), but the search schema accepts only `query` and the implementation always uses the configured budget ([tools.ts](</home/wilder/git-repos/dsh-context-handoff/src/tools.ts#L648-L665>)). The comment promises a per-call search option the tool does not expose.

Fix: Update the config comment to state that per-call `max_tokens` applies to recall only and that search uses the configured budget, unless search is intentionally being extended with its own validated argument.

## Possible concerns

None beyond the verifier gap recorded below.

## Serious unresolved risks

- The review procedure requires a fresh verifier from a model family different from the finders. All three finder reports used Luna, and this session had no authorized different-family verifier route. No substitute was dispatched. The eight source-backed findings remain unclassified by that required verifier, so the review gate is open. Settle with a verifier from an authorized different family if one becomes available; do not treat this report as a clean closure.
- The Node default WebAssembly trap-handler path was not exercised with a virtual-memory cap of at least 10GB. The authorized specs passed with the documented `--disable-wasm-trap-handler` workaround.

## Queued for the owner

- deepcanary: none; no separate non-blocking concern was retained.
- board: none published; the report contains the review findings and the open verifier gate.

## Verdict

VERDICT: request changes

All three finder reports returned `Request changes`, and the source/test traces support the eight findings above. The independent cross-family verifier gate remains open, so this report does not claim review closure. No code or test files were changed because this task authorized only the report write.

## Dispositions

No prior findings apply to this Round 11 code range. Round 10's report reviewed a separate guidance delta.

## Candidate dispositions

- Rejected the concern that the 5b guidance wording materially misdescribes the post-rollover context. It says the engine commits a compiled copy plus a recent tail and that the replacement carries compiled text and the tail ([guidance.ts](</home/wilder/git-repos/dsh-context-handoff/src/guidance.ts#L24-L29>)); the rollover replaces only the selected span, leaving the recent tail outside that range ([rollover.ts](</home/wilder/git-repos/dsh-context-handoff/src/rollover.ts#L638-L647>)). The wording can describe the total next context, and no concrete user harm was demonstrated.
- The static scan reported a product duplicate in [tools.ts](</home/wilder/git-repos/dsh-context-handoff/src/tools.ts#L602-L614>) and [tools.ts](</home/wilder/git-repos/dsh-context-handoff/src/tools.ts#L652-L664>); those bodies are unchanged in the reviewed diff, so the duplicate is pre-existing and is not a finding.

## Verification

```text
Scope and current tree:
Repository: /home/wilder/git-repos/dsh-context-handoff
Branch: handoff-only-rollover
Current HEAD: 02cdf0571a7a36b8be6e0b582e32c2c7409991bd
origin/handoff-only-rollover: 4040f1ddcc9f66bc960c497830b0b1f50eaffd76
`git -C /home/wilder/git-repos/dsh-context-handoff diff --quiet 5b42492679d07886beefbb04ac4ec405c2432656..HEAD -- src/config.ts src/guidance.ts src/index.ts src/rollover.ts src/tools.ts tests/automatic-rollover.spec.ts tests/config-readers.spec.ts tests/handoff-only.spec.ts tests/no-summarizer.spec.ts`: exit 0, all nine R11 paths identical to 5b.
`git -C /home/wilder/git-repos/dsh-context-handoff diff --quiet -- src/config.ts src/guidance.ts src/index.ts src/rollover.ts src/tools.ts tests/automatic-rollover.spec.ts tests/config-readers.spec.ts tests/handoff-only.spec.ts tests/no-summarizer.spec.ts` and the matching `diff --cached --quiet` command: exit 0, no R11 worktree/index changes.
The branch is one commit ahead of origin. No later commit content was reviewed.
`git -C /home/wilder/git-repos/dsh-context-handoff check-ignore -v /home/wilder/git-repos/dsh-context-handoff/docs/work/forced-rollover-vcc/reviews/11-review.md`: no ignore rule; report path is not ignored.

Ticket:
`kata --project personal show 4fne`: exit 0; ticket is open and lists the compiled replacement, deferral, preflight, handoff priority, mode marker, config, overlap, and tail-floor acceptance criteria.

Authorized specs, run earlier in this Round 11 review:
Node v20.15 release notes document the 10GB WebAssembly virtual-memory cage and `--disable-wasm-trap-handler`: https://nodejs.org/en/blog/release/v20.15.0
Node v22.23.4 CLI docs list `--disable-wasm-trap-handler`: https://nodejs.org/download/release/v22.23.4/docs/api/cli.html#--disable-wasm-trap-handler
For each run: `ulimit -v 8388608`; `ulimit -n 512`; `NODE_OPTIONS='--max-old-space-size=2048 --disable-wasm-trap-handler'`; `timeout --signal=TERM --kill-after=5s 120s /usr/bin/time -v` around the local Vitest executable; `--maxWorkers=1 --minWorkers=1 --no-file-parallelism`.
`./node_modules/.bin/vitest run tests/automatic-rollover.spec.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism`: 23/23 passed; Vitest 3.68s, wall 5.15s, peak RSS 175636KiB, exit 0. TMPDIR was `/home/wilder/Trash/forced-rollover-vcc-round-11/round11-auto-wasm.xfsKaY`.
`./node_modules/.bin/vitest run tests/config-readers.spec.ts tests/handoff-only.spec.ts tests/no-summarizer.spec.ts --maxWorkers=1 --minWorkers=1 --no-file-parallelism`: 46/46 passed across three files; Vitest 2.06s, wall 2.40s, peak RSS 165716KiB, exit 0. TMPDIR was `/home/wilder/Trash/forced-rollover-vcc-round-11/round11-remaining-specs.MzMdpJ`.
Initial automatic-spec attempts with 4GiB and 8GiB virtual-memory caps failed before Vitest collection with `RangeError: WebAssembly.instantiate(): Out of memory: Cannot allocate Wasm memory for new instance`. With the documented workaround, the 655360-byte Wasm probe and all four authorized specs passed. Do not classify the initial runner failures as product failures.

Static quality scan, run at pinned HEAD 5b:
`TMPDIR=/home/wilder/Trash/forced-rollover-vcc-round-11 bash /home/wilder/git-repos/dotfiles/.agents/skills/code-review/scripts/static-scan.sh 0b3ea70`: exit 0, nine files/405 functions; cognitive sum 504/max 57; cyclomatic sum 885/max 57; lizard size and duplicate passes exited 0. The one product duplicate is pre-existing; R11 files are unchanged at current HEAD.

No build, typecheck, full suite, additional spec, or Round 12 check was run.
```

## Unverified risks

- No different-family verifier classified the eight findings; the formal review gate remains open.
- The default Node trap-handler path under a virtual-memory cap of at least 10GB was not run.
- The tests establish the current tested paths, not a live production session performing an automatic rollover.
