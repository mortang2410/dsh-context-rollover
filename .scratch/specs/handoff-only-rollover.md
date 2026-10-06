# Spec: handoff-only context rollover

Fork under change: `dsh-context-handoff` (a clone of `athif23/dsh-context-rollover`, npm name
`dsh-context-rollover`).

## Problem Statement

A coding agent's context window fills up and the agent loses the thread. Today this fork
solves that by replacing the old conversation with an engine-composed checkpoint (durable notes
plus an optional short handoff) and by keeping a verbatim recent tail on the surface. That
mechanism has two problems for this user:

1. The continuation state is written by the engine in its own shape, so it is thin and
   inconsistent: a fresh context gets a narration line plus whatever the model happened to
   put in a short handoff string, and it silently keeps a verbatim slice of the old
   conversation.
2. There is no durable, human-readable artifact that a person or a fresh agent can read to
   understand the task. The `/handoff-doc` skill already produces exactly that artifact: a
   structured Markdown handoff in the workspace with a receiver protocol and thirteen required
   sections.

The user wants the durable `/handoff-doc` document to be the whole continuation context, and
wants to be nagged at 40% context usage rather than at 75%.

## Solution

Retarget the rollover so that:

- At 40% context usage the engine sends one configurable reminder telling the model to run
  `/handoff-doc` and then call `new_context`. The reminder fires once per context window.
- `new_context` takes the path of the durable handoff file. The engine reads that file and
  replaces the entire prior conversational surface with its bytes. Nothing else from the old
  session is injected: no recent tail, no prior messages, no tool calls, no summaries.
- The model-visible context after the rollover is the standing system/developer instructions
  plus the handoff document (plus whatever fresh infrastructure DSH provides to start a turn).
- `thresholdRatio` stays at 0.90 as an emergency fallback for when the 40% reminder was ignored.
- No summarizer model is ever called. The `/handoff-doc` output is authoritative.
- The DSH session id is unchanged, and the original event history stays on disk and reachable
  through the `history` tool for manual retrieval only.
- The preset keeps the name `standard-rollover`.

## User Stories

1. As a coding agent, I want to be reminded at 40% context usage, so that I start the handoff
   while I still have room to write it.
2. As a coding agent, I want the reminder to name the exact command to run (`/handoff-doc`) and
   the exact tool to call afterwards (`new_context`), so that I do not have to guess the
   workflow.
3. As a coding agent, I want the reminder to tell me the handoff must be fully sufficient for a
   fresh context, so that I write for a reader with zero context rather than for myself.
4. As a coding agent, I want to be reminded only once per context window, so that the reminder
   does not become noise I learn to ignore.
5. As a coding agent, I want to pass the durable handoff file's path to `new_context`, so that
   the exact file I wrote is the one that becomes my continuation context.
6. As a coding agent, I want `new_context` to fail loudly when the handoff file is missing,
   empty, or unreadable, so that I never lose my task state to a silent empty rollover.
7. As a coding agent, I want the fresh context to contain the handoff document and nothing of
   the old conversation, so that stale requests and dead ends cannot steer me.
8. As a coding agent, I want the fresh context to still carry my system and developer
   instructions, so that I keep the rules and tool catalogue I am supposed to follow.
9. As a coding agent, I want the session id to stay the same across a rollover, so that my
   session history, transcripts and any external references to the session still resolve.
10. As a coding agent, I want the old events retained on disk and searchable through the
    `history` tool, so that I can recover one specific detail when I need it.
11. As a coding agent, I want nothing to inject old events into my fresh context automatically,
    so that reading history stays my explicit decision.
12. As a coding agent, I want no summarizer model to run on my conversation, so that the
    continuation context is exactly the document I wrote rather than a lossy paraphrase of it.
13. As a coding agent, I want a 90% emergency rollover to still work when I ignored the 40%
    reminder, so that I do not hit a hard context overflow and stall.
14. As a coding agent, I want the emergency rollover to prefer a handoff document that exists,
    so that the emergency path also lands on a complete continuation context.
15. As an operator, I want the reminder text configurable, so that I can change the wording or
    the workflow it points at without editing plugin source.
16. As an operator, I want the 40% and 90% points to be plain configuration values, so that I can
    retune this deployment without a rebuild.
17. As an operator, I want a deployment that does not configure anything to get the documented
    behavior, so that the shipped defaults are the intended experience.
18. As an operator, I want the plugin to keep the preset name `standard-rollover`, so that
    existing notes, docs and muscle memory keep working.
19. As a maintainer, I want the plugin to typecheck against the running host, so that the test
    suite is meaningful evidence rather than a stale measurement.
20. As a maintainer, I want an end-to-end test that proves zero old conversational material
    reaches the fresh context, so that the central claim of this change cannot silently regress.
21. As a maintainer, I want a test that proves no model call happens on the rollover path, so
    that a future refactor cannot quietly reintroduce summarization.
22. As a maintainer, I want a test that the 90% fallback still commits a rollover, so that the
    emergency path stays alive.
23. As a maintainer, I want the reminder predicate shared between sender and reader, so that the
    "fired once" test cannot disagree with the code about what a reminder is.

## Implementation Decisions

### Configuration

- New `reminderMessage: string`. Text sent as the one-per-window reminder. Supports `{percent}`
  as its only placeholder, substituted with the measured percentage at send time.
- Default `reminderMessage` is the user's required sentence, with `{percent}` in place of the
  literal `40`:
  `Context is {percent}% full. Use \`/handoff-doc\` to create/update the durable handoff document. Make it fully sufficient for a fresh context to continue the work. After it succeeds, call \`new_context\`. The handoff document will be the entire continuation context.`
- `reminderThresholdRatio` default changes `0.75` -> `0.40`.
- `thresholdRatio` default stays `0.90`, and its role is restated in docs as the emergency
  fallback.
- New `handoffDir: string`, default `.scratch/handoff`, resolved against the session working
  directory. Only used by the emergency path.
- New `handoffPattern: string`, default `HANDOFF-*.md`. Only used by the emergency path.
- New `handoffOnly: boolean`, default `false`. When true the range selector retains no tail at
  all: the replaced span runs from the first non-system surface node through the LAST surface
  node, backing off to the nearest earlier node only if the cut after the last node is not
  tool-pairing balanced.
- `retainRatio` / `retainTokens` stay as engine capability for deployments that want a tail.

**Verified defect in the first draft of this spec, now corrected (twice).** The draft claimed that
setting `retainTokens: 0` yields "no verbatim tail". That is false, and a probe against the real
code proved it:

- `selectRolloverRange` (`src/rollover.ts:105-126`) accumulates node prices from the tail
  backwards and breaks as soon as `accumulated >= retainTokens`. With `retainTokens: 0` the
  first backwards iteration already satisfies the comparison, so `keepFromIdx` lands on the
  last surface node and the replaced span stops one node short of the end. Measured on a
  10-node surface: `startIdx 0, endIdx 8, KEPT 1`, the kept node being the final
  `assistant/message`.
- The loop then walks `keepFromIdx` further backwards until the cut is tool-pairing balanced
  (`src/rollover.ts:121-125`), so a trailing tool-call/result pair is retained as a unit too.
- End to end through the real agent loop with `retainTokens: 0`, the post-rollover derived
  messages were: the system head, the replacement checkpoint, `[tool-call]`, the `new_context`
  tool result text, and the post-rollover answer. The old `new_context` assistant tool-call
  (log seq 104) and its `tool/result` (log seq 106) had survived on the surface as the retained
  tail. That is exactly the old-session conversational material the requirement forbids.

Therefore `handoffOnly` is a distinct mode rather than a reuse of `retainTokens: 0`, and the
zero-tail claim gets its own test (ticket 04) because it is the requirement's central claim.

**Second correction, same area.** An intermediate revision of this spec then claimed that a
tool-pairing-balanced cut forces the requesting turn's `new_context` tool call and its result to
survive. A further probe refuted that: on a 16-node surface ending in that turn's `tool/result`,
`toolPairingBalancedAfter(lastNode)` is `true`, so the span can legally cover the last node, and
after committing it the surface held exactly two nodes, the `system/message` head and the
replacement handoff message. The tool call and its result were gone. The exception is removed;
the only real constraint is the mid-call case described above.

### Handoff discovery and validation

- `new_context` gains a required `handoff_path` argument: an absolute path, or a path relative
  to the session working directory.
- The engine resolves and reads that exact file at the moment it crosses the boundary.
- The engine refuses to cross the boundary when the file is missing, is not a regular file,
  cannot be read, or is empty/whitespace-only. On refusal the tool reports the failure and the
  old context stays intact. The refusal happens before `compaction/start`, so no partial
  transaction is left behind.
- A new module owns resolution and reading, so the tool and the engine agree on one rule.

### The replacement content

- The replacement `user/message` contains exactly the handoff file's text as one text block.
  No prose preamble, no provenance paragraph and no old conversation are added to the
  model-visible content. Provenance stays in the compaction transaction metadata
  (`compaction/summary`, `provider`, `model`) and in the message `source`, both of which the
  transcript UI already reads and neither of which is model-visible conversation.
- The checkpoint wrapper markers used by the old engine are no longer applied on this path, so
  the fresh context reads as the document itself.
- The existing shrink guard stays: a replacement that is not smaller than the content it
  replaces is still refused.
- The system-prompt guidance section is where the model learns the workflow (run
  `/handoff-doc`, then call `new_context` with the path), so the replacement content does not
  need to carry that instruction itself.

### What the fresh context contains

- In `handoffOnly` mode the replaced span covers the whole surface except a `system/message` at
  surface node 0, which the host refuses to rewrite as part of a multi-node replace. The host
  rule, read from `packages/core/session/src/surface.ts:494-512`: a replacement covering node 0
  while that node is a `system/message` "must itself be a `system/message` over exactly that
  node"; later system nodes carry no protection.
- The span ends at a tool-pairing-balanced cut, because DSH's own invariant and the transaction
  both require it. That constraint costs nothing on the normal path. Measured: on a 16-node
  surface whose last node is the requesting turn's `tool/result`, `toolPairingBalancedAfter(last)`
  is true, so a span from the first non-system node through the last node commits and the
  resulting surface is exactly two nodes: the `system/message` head and the replacement handoff
  message. The requesting turn's assistant tool-call and its tool/result are both shadowed with
  everything else.
- The model-visible context is therefore: the system head (standing instructions) plus the
  handoff document, plus the fresh turn's own messages. Nothing from the old conversation
  survives, including the tool call that requested the rollover.
- A rollover that fires while a step is genuinely mid-tool-call (no result yet) backs off to the
  nearest earlier balanced cut and will therefore retain that incomplete call/result unit. That
  is a real host constraint and the only case where the fresh surface can carry a trace of the
  old turn; it is not the normal path, and the selector handles it by walking back rather than by
  retaining a priced tail.
- Standing instructions from `AGENTS.md` and the project chain are delivered as `user/message`
  surface nodes carrying source kind `agent-instructions`, and they sit inside the replaced span.
  They are expected back because `dsh-agent-instructions` re-injects them: its `agent/pre-step`
  listener recomposes the desired message from disk and re-enters it whenever the surface no
  longer carries an identical payload (`packages/context/agent-instructions/src/index.ts:227-250`,
  `:316-340`).
- That recovery is an expectation about another plugin's behavior, so the spec does not accept it
  on reasoning alone. Ticket 04 mounts `dsh-agent-instructions` on the test context and asserts
  the first post-rollover model request: the request must carry the system prompt, the restored
  workspace instruction text, and the current tool catalogue. Asserting only that the derived
  messages contain the system head is too weak, because the system head is the one thing the
  host preserves for free.
- Session id is untouched: the rollover mutates the surface of the same `Session` object and
  never creates a new session.

### No summarizer

- The engine keeps `CompactionEngine` as its transaction seam but composes the replacement text
  itself. No `llm` call is made on any rollover path (model-requested, pressure, overflow or
  manual). `ctx.compaction` remains this engine, and the bundle patch keeps
  `compaction-basic` disabled.

### Emergency fallback

- At `thresholdRatio` (0.90) the automatic pressure rollover runs. It resolves a handoff file
  by scanning `handoffDir` for `handoffPattern` and taking the newest by modification time.
- Candidate selection is shrink-aware, in this order: newest eligible handoff file that passes
  the shrink check; otherwise the deterministic notes checkpoint; otherwise no rollover. A
  readable handoff that is not smaller than the span it would replace must not consume the one
  emergency attempt and leave the context unchanged while a smaller notes checkpoint was
  available. This is why the choice cannot be "pick the newest file, then let the guard throw".
- The emergency path cannot use an explicit path: no model is in the loop at 90%. Documented
  limitation.
- The explicit `new_context` path has no such fallback by design: the model named one file, and
  substituting the notes checkpoint would give it a continuation context it did not choose. It
  refuses instead, and the refusal is tested.

### Model-facing tools and guidance

- `notes` tool is unchanged and stays mounted.
- `history` tool is unchanged and stays mounted for manual retrieval. Nothing in the engine
  injects history into the surface.
- `get_context_remaining` is unchanged.
- The system-prompt guidance text is rewritten: it leads with the `/handoff-doc` then
  `new_context({handoff_path})` workflow, and stops instructing the model to pass a short
  handoff string. It states that the handoff document is the entire continuation context and
  that history is manual recovery only.
- `new_context`'s tool description and parameter description are rewritten to match.

### Host-version drift repair (prerequisite, not a feature)

The fork's last commit predates the running host (`0.2.0-rc.2`). Verified baseline on the
pristine clone:

- `pnpm typecheck`: 23 errors, in three groups. Six are the removed catch-all `MessageSourceMap`
  key `kind: 'plugin'`: `src/rollover.ts:429,431-433`, `src/index.ts:260`, and the test fixture at
  `tests/history.spec.ts:159`. Sixteen are the test adapters' drifted `stream()` signature
  (`GenerateOptions` versus `{ messages }`): `tests/harness.ts:51,79`, `tests/engine.spec.ts:37,72,90`,
  `tests/preset-deferral.spec.ts:40,80`, `tests/pressure-range.spec.ts:30`,
  `tests/reminder-delivery.spec.ts:53,87,116`, `tests/safety.spec.ts:65,111,137`,
  `tests/tools.spec.ts:87,107`. The remaining one is `tests/rollover.spec.ts:60`, which calls
  `createSystemMessage('persona', 'test')` with two arguments while the host signature takes one
  (`packages/llm/llm/src/message.ts:279`).
- `pnpm test`: 3 failures. Two are the shrink guard rejecting a checkpoint that is not smaller
  than the span it replaces, at the host's current pricing; one is the preset-sync test, which
  cannot find a shipped `standard` preset in the checkout.

Repair decisions:

- Declare this plugin's own message source kind through the host's documented merge point
  (`declare module '@deepseek-ai/dsh-llm' { interface MessageSourceMap { ... } }`), exactly as
  shipped producers such as `time-context` and `tool-goal` do, and key the reminder predicate
  on that kind. This is the host's own extension mechanism, not a new abstraction.
- Update the test harness adapters to the host's `stream()` shape.
- Fix the two shrink-guard failures by making the tests' fixtures produce a span that is
  genuinely larger than its checkpoint, which is what the guard is meant to require, rather
  than by weakening the guard.
- The preset-sync test is repaired by making the repo's own checked-in `standard` source of
  truth available to the generator, so the test compares generated output against a fixture the
  repo controls instead of a private fork's directory layout.

Verified fact that constrains this: on `0.2.0-rc.2` the agent-preset roster is declared with
`@deepseek-ai/dsh-agent-preset` rows carrying an inline `config.plugins` array
(`dsh-web-app/presets/standard.patch.yml`), and the registry's Config schema is only
`{ default, selectedDefault }`. The `roots` / `includeShippedRoot` / `includeUserRoot` roster
fields and the `presets/<id>/agent.cordis.yml` directory format are from the earlier `0.1.x`
line and are not read by the running host.

The consequence is not cosmetic, and the first draft of this spec wrongly filed it as out of
scope. On the running host:

- the bundle patch targets row id `agent-presets`, but the row that exists is
  `agent-preset-registry` (`dsh-web-app/cordis.patch.yml:562-566`), whose Config schema is only
  `{ default, selectedDefault }` (`dsh-agent-preset-registry/lib/index.js:471-474`);
- shipped presets are declared as `@deepseek-ai/dsh-agent-preset` rows carrying an inline
  `config.plugins` array inside `.patch.yml` files
  (`dsh-web-app/presets/standard.patch.yml:1-12`);
- `compaction` is isolated per preset, and the shipped `standard` roster still names
  `compaction-basic` inside its own compaction group
  (`dsh-web-app/presets/standard.patch.yml:62-74`), while this engine defers to any
  preset-owned backend.

So the rollout as currently written cannot deliver the documented behavior on the running host:
no `standard-rollover` preset would appear, and a session's compaction would still be the
summarizer. The preset NAME stays `standard-rollover`; the declaration FORMAT is modernized to
the running host's patch format. That is ticket 08, and it is the largest and riskiest piece of
this change.

## Testing Decisions

What makes a good test here: it must assert externally observable behavior of the real
components. This repo's existing suites already mount the real session store, token meter, tool
runtime, agent loop and DSH's own session/agent/compaction invariant companions, and drive a
scripted LLM adapter through `agent.followup()`. Every new test uses that same seam. Assertions
read `session.deriveMessages()` (what the model would actually receive), the durable event log,
and the adapter's recorded requests. No test asserts on a private field when a public
observation exists.

Modules under test:

- the reminder builder and the once-per-window claim (existing `reminder-delivery` seam);
- handoff resolution and reading (new module, unit tested for the refusal cases);
- the rollover transaction's replacement content (through the real agent loop);
- the emergency fallback (through the real agent loop).

Required new tests, mapped to the user's list:

1. Reminder fires once after crossing 40%, and not again in the same window.
2. The reminder text names `/handoff-doc` and `new_context` (asserted against the configured
   default text, with the measured percent substituted).
3. A successful `new_context({handoff_path})` loads the durable handoff: the derived messages
   contain the handoff file's own distinctive content.
4. Zero previous conversational tail is injected: every pre-rollover exchange carries a unique
   sentinel, and none of those sentinels appears in the derived messages after the rollover. The
   one permitted survivor is the `new_context` tool call and its result when the boundary is
   crossed with a turn open, because the host requires a tool-pairing-balanced cut; the test
   asserts the tool call is the only non-fresh material and that it carries no conversation.
5. Same session id is retained across the rollover.
6. No summarizer-model call occurs. The measurement must be observable rather than inferred: the
   test harness records adapter invocation order with timestamps or sequence numbers, and the
   assertion is that no stream starts between the `compaction/start` and `compaction/end` events
   of a rollover. That is checked once per rollover path (model-requested, pressure, overflow,
   manual), because a path-specific regression is exactly what a single happy-path check misses.
   The summary event's provider and deterministic model string are asserted as supporting
   evidence, not as the proof, since metadata alone cannot show that no request was made.
7. The 90% emergency fallback still commits a rollover when the 40% reminder was ignored, with
   the reminder threshold raised past the usage so no reminder fires first.
8. Refusal: `new_context` with a missing, empty or unreadable path leaves the old context intact
   and reports the failure.

Prior art for these tests: `tests/engine.spec.ts` (model-requested rollover through the real
agent loop), `tests/safety.spec.ts` (automatic pressure rollover and overflow recovery),
`tests/reminder-delivery.spec.ts` (once-per-window claims), `tests/rollover.spec.ts` (the
transaction and the shrink guard).

## Out of Scope

- Publishing the fork, and any push to a remote.
- Installing the plugin into the live `web` profile, restarting the DSH host, or otherwise
  touching the running installation. All verification is in-repo.
- Removing the `notes` tool or the `history` tool.
- Cross-session handoff, handoff expiry or handoff garbage collection.
- Any change to DSH core.

## Ticket map

| Ticket | Covers | Blocked by |
|---|---|---|
| 01 repair host drift | story 19 | none |
| 02 reminder at 40%, configurable | stories 1-4, 15-17, 23 | 01 |
| 03 handoff resolution | stories 5, 6 | 01 |
| 04 handoff-only replacement | stories 7-11, 20 | 01, 03 |
| 05 emergency fallback | stories 13, 14 | 04 |
| 06 no summarizer and guidance | stories 3, 12, 21, 22 | 04 |
| 07 preset name and docs | stories 16-18 | 02, 04, 05, 06 |
| 08 preset format modernization | story 18 and the running-host preset load | 01 |

Every user story 1-23 is named by at least one ticket above. Story 23 (a shared reminder
predicate) is covered by ticket 02, which asserts delivery through the engine's own predicate
rather than a test-local copy.

## Further Notes

- The `/handoff-doc` skill's real contract, read from
  `/home/wilder/.agents/skills/handoff-doc/SKILL.md`: save into the current workspace under
  `.scratch/handoff/`, named `.scratch/handoff/HANDOFF-<topic-or-date>.md`; if the session has
  no real workspace, use `~/.hermes/handoffs/`. The document opens with a receiver protocol and
  then carries thirteen required sections. This is why `handoffDir` defaults to
  `.scratch/handoff` and the pattern to `HANDOFF-*.md`.
- The four grill-round decisions that shape the implementation: an explicit `handoff_path` beats
  scanning (a scan can load a stale document); the replacement content is the file's bytes with
  no preamble (a preamble would add non-handoff material to the "entire continuation context");
  the emergency scan is a fallback of last resort and is documented as such; and the
  no-summarizer test is scoped to the rollover path rather than to the whole turn.
- `handoffMaxChars` currently bounds the `new_context` handoff string. With the file-based
  design it bounds the accepted handoff file size, and the refusal message names the limit.
