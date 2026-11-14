# Skeleton: forced rollover carries a VCC-compiled copy

- status: draft
- mode: design
- spec: kata `personal#qazm`
- scope: `src/vcc/`, `src/checkpoint.ts`, `src/compiled-fallback.ts`, `src/tools.ts`, `src/recall.ts`, `src/search.ts`, `src/config.ts`, `src/index.ts`, `src/rollover.ts`, `tests/`
- grill: `/home/wilder/Trash/rollover-vcc-grill/verifier.md` (frontier empty) and `/home/wilder/Trash/rollover-vcc-grill/findings.md`

## Requirements map

| Id | Requirement | Spec anchor | Kind |
|----|-------------|-------------|------|
| R1 | The forced path keeps a shortened copy of the conversation it removes | Solution | behaviour |
| R2 | Every cut carries the log position that still holds the full text | User story 2 | behaviour |
| R3 | Recall and search tools are available in the session | User story 3 | behaviour |
| R4 | `new_context` with a handoff stays the preferred path, byte for byte | User story 4 | behaviour |
| R5 | No forced path reads or scans the handoff directory | User story 5 | invariant |
| R6 | Durable notes and the recent verbatim tail are kept | User stories 6, 7 | behaviour |
| R7 | The compiled copy is smaller than the span it replaces | User story 8 | invariant |
| R8 | The log and journal name the replacement mode | User story 9 | behaviour |
| R9 | VCC's code is copied with MIT attribution and its tests | User stories 10, 12 | provenance |
| R10 | Compiler budgets are configurable | User story 11 | behaviour |
| R11 | No smaller compiled copy means a deferral, not a commit | User story 14 | behaviour |
| R12 | The recall guide sits ahead of the compiled entries | User story 15 | behaviour |

## Modules

| Id | Path | Responsibility | Allowed deps | Forbidden deps | Exposed surface |
|----|------|----------------|--------------|----------------|-----------------|
| M1 | src/vcc/compiler.ts | Vendored deterministic compiler: tokenizer, block budgets, elision passes, checkpoint framing, recall guide, and the text helpers the read-back cores use | none | M2 M3 M4 M5 M6 M7 M8 M12 M9 M10 M11 | `compileRegion`, `compileNodes`, `frameCheckpoint`, `RECALL_GUIDE`, `CHECKPOINT_PREAMBLE`, `CHECKPOINT_OPEN_TAG`, `CHECKPOINT_CLOSE_TAG`, `DEFAULT_TOOL_KEY_FIELDS`, `DEFAULT_ARG_TOOLS`, `DEFAULT_NOISE_PATTERNS`, `tokenize`, `countTokens`, `sanitize`, `entryText`, `joinCompiledEntries`, `isCheckpointSource`, `estimateEntryTokens`, `projectToolResultText`, `truncateTokens` |
| M2 | src/vcc/project.ts | Project shadowed surface positions into the compiler's node shape | M1 M10 | M3 M4 M5 M6 M7 M8 M12 M9 M11 | `projectShadowedNodes` |
| M3 | src/checkpoint.ts | Existing rollover compositions; gains the compiled composition | M1 | M2 M4 M5 M6 M7 M8 M12 M9 M10 M11 | `RolloverReplacement`, `buildReplacementText` |
| M4 | src/compiled-fallback.ts | Compose the forced replacement: project, compile, cap from the span, frame guide-first, then place the notes header after the guide and before the entries when notes exist | M1 M2 M3 M7 M10 M11 | M5 M6 M8 M12 M9 | `buildCompiledReplacement` |
| M5 | src/index.ts | Engine wiring: forced path builds the compiled replacement, preflights it with the meter, rejects an overlapping notes/handoff root before rendering notes, then defers or commits; journal marker | M3 M4 M6 M7 M9 M10 M11 | none | `ContextRolloverEngine` |
| M6 | src/rollover.ts | Replacement metadata written to the summary event; names the replacement mode; owns the commit-time shrink guard | M3 M7 M10 | none | `commitRollover`, `sizeRolloverReplacement` |
| M7 | src/config.ts | Compiler budget keys, recall budget key, defaults, and static key validation; per-session path containment lives in M5 | none | none | `resolveConfig`, `Config`, `RolloverConfig`, `ResolvedRolloverConfig` |
| M8 | src/recall.ts | Vendored recall core: textual projection by seq, result, or checkpoint ordinal, within the recall budget | M1 M7 M10 | M5 | `recallBySeq`, `recallByResult`, `recallByCheckpoint`, `DEFAULT_MAX_RECALL_TOKENS`, `RecallMissError`, `RecallResult`, `findCheckpointSeqs`, `projectMessageText` |
| M12 | src/search.ts | Vendored search core over the durable log | M1 M7 M8 M10 | M5 | `searchLog`, `InvalidSearchPatternError`, `SearchResult` |
| M9 | src/tools.ts | Register `recall` and `search` tools when the model surface is enabled; both rows sit behind the same gate, and the recall budget stays at VCC's default until `4fne` threads the configured key | M6 M7 M8 M10 M12 | none | `createRolloverTools` |
| M10 | src/compat.ts | Host event-accessor compatibility only; message derivation stays on `Session.deriveEventMessage` | none | M5 M9 | `sessionEventAt`, `sessionEvents`, `nodeHeuristicTokens`, `replaceSurfaceOp`, `Seq` |
| M11 | src/vcc/cap.ts | Checkpoint cap derived from the shadowed span and bounded by the configured cap | none | M2 M3 M4 M5 M6 M7 M8 M12 M9 M10 | `checkpointCapFor` |

## Contracts

### C1: compileRegion

- kind: function
- owner: M1
- stability: stable
- satisfies: R1, R2, R7

```ts
compileRegion(nodes: readonly CompileNode[], config: CompilerConfig): { entries: CompileEntry[]; stats: CompileStats; capped: boolean }
```

- pre: nodes are ordered by sequence and each carries the message the model saw
- post: returns ordered entries whose retained conversation payload comes from source text without model paraphrase; generated role, framing, media and provenance labels are allowed; every truncation or elision carries a `(seq N)` or `(seqs A-B)` marker; `capped` is true when the cap pass ran
- errors: none thrown for well-formed nodes
- invariants: no retained sentence is rewritten or invented; prior checkpoints are copied or reduced to `[checkpoint N]`
- state: none

### C2: projectShadowedNodes

- kind: function
- owner: M2
- stability: stable
- satisfies: R1, R2

```ts
projectShadowedNodes(session: Session, shadowedSeqs: readonly number[]): CompileNode[]
```

- pre: the sequences belong to the session log and are inside the replaced span
- post: one node per sequence, in ascending order; a message-less event yields `message: null`; a tool-result message keeps its role and tool-call id
- errors: throws a `ProjectionError` naming the seq when a selected sequence has no session event, so a partial array never reaches the compiler
- invariants: the projected message is exactly the derived message the model saw, taken from `session.deriveEventMessage`
- state: none

### C3: buildCompiledReplacement

- kind: function
- owner: M4
- stability: stable
- satisfies: R1, R6, R7, R11, R12

```ts
buildCompiledReplacement(input: { session: Session; shadowedSeqs: readonly number[]; shadowedTokens: number; windowNumber: number; notes: string | null }, config: RolloverConfig): RolloverReplacement | { defer: true }
```

- pre: the span is balanced and non-empty; `shadowedTokens` is the span's heuristic count and only bounds the compiler's budget; `config` is the raw `RolloverConfig` the composer reads with VCC's defaults until `4fne` wires resolution, and the resolved type is `ResolvedRolloverConfig`
- post: returns a `compiled` replacement whose text holds the recall guide first, the durable notes header after it when notes exist, then the framed entries; returns `{ defer: true }` when the projection throws or compiles to no entries
- errors: none; the compiler elides rows further when the body exceeds its cap
- invariants: the compiler cap never exceeds the configured cap and never exceeds half the shadowed span tokens; the return is smaller than the span only after C10 prices it
- state: none

### C4: RolloverReplacement compiled variant

- kind: type
- owner: M3
- stability: stable
- satisfies: R4, R6

```ts
| { kind: 'compiled'; windowNumber: number; text: string }
```

- pre: text is the exact compiled replacement
- post: `buildReplacementText` returns that text unchanged; `replacementWindowNumber` returns the window number
- errors: none
- invariants: the handoff variant is untouched, so a submitted handoff still replaces the context byte for byte
- state: none

### C5: summary replacement-mode marker

- kind: format
- owner: M6
- stability: stable
- satisfies: R8

```ts
model === `deterministic/handoff-window-${n}` | `deterministic/compiled-window-${n}` | `deterministic/notes-window-${n}`
```

- pre: one rollover commits
- post: the summary event carries exactly one of the three markers
- errors: none
- invariants: the marker is derived from the replacement variant, not a separate flag
- state: none

### C6: recall and search tools

- kind: tool
- owner: M9
- stability: stable
- satisfies: R3

```ts
recall({ type: 'seq' | 'result' | 'checkpoint'; ref: string; max_tokens?: number }): string
search({ query: string }): string
```

- pre: the session log is readable through the session accessors
- post: `recall` returns VCC's complete textual projection of the named record within the recall budget, with media represented by labels and an over-budget result carrying a cut marker; `search` returns matching records with their log positions
- errors: an unknown position or ordinal returns a message naming what was not found, never an empty silent result
- invariants: no word of the projection is model-written; a cut marker can always be resolved
- state: none

### C7: compiler configuration

- kind: schema
- owner: M7
- stability: stable
- satisfies: R10

```ts
checkpointCap?: number; assistantTextTokens?: number; userTextTokens?: number; toolCallTokens?: number; includeReasoning?: boolean; toolArgTools?: string[]; hideTools?: string[]; maxRecallTokens?: number
```

- pre: values are validated at construction; per-session path containment is not a construction-time check and belongs to C8
- post: `assistantTextTokens` maps onto the compiler's `textTokens`; the remaining required compiler fields take VCC's published defaults; defaults mirror VCC's published defaults, and an invalid value throws a TypeError naming the key
- errors: `TypeError` for a non-positive number or a wrong type
- invariants: the forced path always uses the compiler, with no feature flag to disable it
- state: none

### C8: forced path keeps no handoff dependency

- kind: boundary invariant
- owner: M5
- stability: stable
- satisfies: R5

```ts
// no call from the automatic path to readHandoffFile or resolveHandoffPath, and no read, stat, or directory listing under the configured handoff directory
```

- pre: the forced branch runs with no pending handoff request; immediately before any note-store access, M5 derives the canonical per-session notes root without descending under the handoff directory: the realpath of the notes root when it exists, else the realpath of its nearest existing ancestor with the missing suffix appended; it takes the handoff root's absolute path and, when that root exists, its realpath (the root's own path only). It throws a TypeError naming `notesDir` when the canonical notes root equals or lies under either handoff form, and also when no available comparison proves them disjoint, so a missing notes leaf or a symlinked base cannot fail open
- post: the compiled replacement is built from the session log and the notes store only
- errors: TypeError naming `notesDir` for an overlapping configuration, thrown before any note-store access
- invariants: no handoff-reader call and no read, stat, or directory listing happens under the configured handoff directory, for any file name or age; note-store reads are allowed
- state: none

### C9: journal replacement-mode line

- kind: format
- owner: M5
- stability: stable
- satisfies: R8

```ts
`context rollover (automatic): compiled mode; window ${n}; ...`
```

- pre: one forced rollover commits
- post: the journal line names the same mode word as the summary marker
- errors: none
- invariants: the journal mode and the summary marker cannot disagree
- state: none

### C10: meter preflight before commit

- kind: boundary
- owner: M5
- stability: stable
- satisfies: R7, R11

```ts
sizeRolloverReplacement(dependencies, session, range, replacement).fits
```

- pre: the compiled replacement text is composed for the selected span
- post: the engine prices the candidate with the live meter over that span; a `fits` of false returns the normal deferral without calling `commitRollover`, so no compaction transaction opens; a commit-time size rejection that survives a passing preflight is caught and returned as that same deferral before the compaction bracket opens
- errors: a meter/surface mismatch still throws as it does today
- invariants: the commit-time shrink guard stays the authority; the preflight only prevents a known non-shrinking commit from being attempted
- state: none

## Data flow

A pre-step at or above the rollover point with no pending handoff selects a balanced range. The engine passes the shadowed sequences and the shadowed token count to the compiled fallback, which projects one compiler node per sequence from the session's own derived messages, compiles them under the span-derived cap, and frames them as the recall guide first, the durable notes header after it when notes exist, then the entries. The engine prices that text with the transaction's meter over the selected span before it commits. A candidate the meter does not price smaller, a projection that throws, and a compile with no entries all defer: nothing commits, and the next pre-step retries. Otherwise the text becomes a `compiled` replacement and commits through `commitRollover`, which prices it again, refuses a non-shrinking replacement, and writes the summary marker and the surface replacement. The attention tail stays outside the replaced range exactly as today.

## State and concurrency

No new shared state. The fallback is a pure function of the session's log and the selected range. The compiler cap is local to one call. The recall tools read the durable log through the same accessors the history tool uses.

## Brownfield delta

| Path | Existing fact | Proposed change | Evidence |
|------|---------------|-----------------|----------|
| `src/index.ts` | Forced path commits `checkpoint { reason: automatic, handoff: null }` and never reads a handoff | Build a `compiled` replacement before committing, or defer | `src/index.ts:537-595` |
| `src/checkpoint.ts` | Two replacement variants: checkpoint and handoff-document | Add the `compiled` variant and its text builder | `src/checkpoint.ts:43-80` |
| `src/rollover.ts` | Summary carries `provider: dsh-context-rollover` and `model: deterministic/window-N` for every mode | Encode the replacement mode in the model marker | `src/rollover.ts:622-623` |
| `src/tools.ts` | Registers notes, history, new_context, get_context_remaining | Register recall and search beside them | `src/tools.ts:573-584` |
| `src/handoff.ts` | Never lists or scans a directory | Unchanged, and the forced path must not call it | `src/handoff.ts:15-17` |
| `src/compat.ts` | Host event accessors only; no derived-message adapter (`Session.deriveEventMessage` supplies messages) | Reused by projection and read-back cores | `src/compat.ts:29-50`, `dsh-session/lib/types/index.d.ts:286-310` |

## Verification hooks

| Contract | Check | Command |
|----------|-------|---------|
| C1 | vendored compiler unit tests, plus a provenance check for imports and the MIT notice | `npx vitest run tests/vcc-compiler.spec.ts tests/vendored-provenance.spec.ts` |
| C2 | projection unit test | `npx vitest run tests/vcc-project.spec.ts` |
| C3 | composition unit test, guide ordering, deferral, shrink assertion | `npx vitest run tests/compiled-fallback.spec.ts` |
| C5 | summary marker assertion in the forced test | `npx vitest run tests/automatic-rollover.spec.ts` |
| C6 | recall and search tests, including registry gating | `npx vitest run tests/recall-search.spec.ts` |
| C7 | config validation tests | `npx vitest run tests/config.spec.ts` |
| C8, C9 | no-read assertion under the handoff directory, and journal mode line, in the forced test | `npx vitest run tests/automatic-rollover.spec.ts` |
| C10 | meter preflight miss defers with no transaction; a commit-time rejection after a passing preflight returns the same deferral with no compaction bracket; unrelated meter or surface errors propagate; includes the compiler-fits/meter-rejects case | `npx vitest run tests/automatic-rollover.spec.ts` |
| all | typecheck and build | `npm run typecheck && npm run build` |

## Traceability

| Requirement | Contracts | Tickets |
|-------------|-----------|---------|
| R1 | C1, C3, C8 | sycr, b61t, 4fne, 42ka |
| R2 | C1, C2 | sycr, b61t, 42ka |
| R3 | C6 | 2zex, 42ka |
| R4 | C4 | 4fne |
| R5 | C8 | 4fne, 42ka |
| R6 | C3, C4 | b61t, 4fne |
| R7 | C1, C3, C10 | sycr, b61t, 42ka |
| R8 | C5, C9 | 4fne |
| R9 | C1 | sycr |
| R10 | C7 | 4fne |
| R11 | C3, C10 | b61t |
| R12 | C3 | b61t, 42ka |

## Uncertainties and tradeoffs

| Id | Uncertainty | Why unresolved | Settle by | Owner |
|----|-------------|----------------|-----------|-------|
| U2 | Whether VCC's compiler tests run under the fork's vitest setup unchanged | VCC ships node:test style tests | probe: adapt one fixture test and run it | implementer |
| U3 | Whether the shrink guard accepts a span smaller than the minimum useful checkpoint | guard reads `src/rollover.ts:590-598` | probe: unit test with a tiny span, deferral expected | implementer |

## Revision log

| Date | Change | Trigger | Approved by |
|------|--------|---------|-------------|
| 2026-11-14 | Round 1: R12, C3 guide-before-entries, M10 added, M2/M8 edges, C1 wording, C5/C9 split, C7 flag removed | Review round 1 findings | wilder |
| 2026-11-14 | Round 2: guide-first order in C3 and data flow, C10 meter preflight, M5/M6 edges, M10 event accessors only, C2 strict projection, C8 scoped to the handoff directory, U1 removed | Review round 2 findings | wilder |
| 2026-11-14 | Round 3: M4 responsibility states guide-first then notes header, C8 example comment scoped to the handoff directory | Review round 3 findings | wilder |
| 2026-11-14 | Round 4: C7 rejects an overlapping notes/handoff base directory, C8 precondition requires notes outside the handoff directory, M7 responsibility extended | Review round 4 finding | wilder |
| 2026-11-14 | Round 5: per-session containment moves from M7 to the C8 precondition on M5 with documented resolutions and realpath roots; 4fne meter wording corrected | Review round 5 findings | wilder |
| 2026-11-14 | Round 6: canonical notes root defined for a missing leaf with fail-closed comparison, C10 hook and 4fne AC added for the commit-time rejection fallback | Review round 6 findings | wilder |
| 2026-11-14 | Implementation, b61t: M11 cap module added and M4/M5 deps extended; M8 split into M8/M12 so each module row names one path; module Path cells made plain so drift_check resolves them; C3 takes the config as a second argument and names `RolloverConfig`/`ResolvedRolloverConfig`; config budget keys landed early by b61t, with `4fne` owning resolution wiring and config-readers tests | `559b2ba` report; tier 2 revision pending delta review | wilder |
| 2026-11-14 | Implementation, 2zex: M8 and M12 surface rows list the exported helpers and refusals; M9 names the model-surface gate and the VCC-default recall budget; C6 carries the optional per-call `max_tokens`; `recall` takes `ref`; `search` scopes itself to original conversation records, with generated checkpoints reached through `recall({ type: "checkpoint" })`; the history predicate added by 2zex was reverted as redundant and out of scope | `6a02ba9` report plus review round 8 findings | orchestrator |
