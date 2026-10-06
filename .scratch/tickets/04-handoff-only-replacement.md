# 04: new_context replaces the whole surface with the handoff document only

**What to build:** `new_context({ handoff_path })` crosses the boundary by replacing the entire
prior conversational surface with the durable handoff document's bytes. No recent tail, no prior
messages, no tool calls, no summaries, no other old-session material reach the fresh context.

**Blocked by:** 01, 03 (both done: `ec4758b`, `6af85fc`).

**Verify:** `pnpm test -- tests/engine.spec.ts tests/handoff-only.spec.ts tests/rollover.spec.ts tests/safety.spec.ts`

**Status:** ready-for-agent

Starting point (all verified on the committed tree):

- `tests/harness.ts` `engineHarness(id, config)` already takes a third `meta` argument for `cwd`
  (added by ticket 03) and `config` accepts any `RolloverConfig`.
- Ticket 03 added `src/handoff.ts` with `readHandoffFile` (non-throwing, closed `HandoffFailureReason`
  union) and `readHandoffFileOrThrow`.
- `PendingRollover` already carries `handoff: string | null` holding ALREADY-RESOLVED TEXT plus an
  optional `handoffPath?: string`.
- `new_context` already accepts an OPTIONAL `handoff_path` alongside the legacy `handoff` string.
  This ticket makes `handoff_path` required, removes the legacy `handoff` string, and rewrites the
  tool description.
- `selectRolloverRange` currently retains a priced tail. Ticket 01's summary recorded this
  measurement: with `retainTokens: 0` and a 10-node surface it returned `startIdx 0, endIdx 8`, i.e.
  the final `assistant/message` was retained, and the loop backs the cut up further for tool pairing.

Acceptance criteria:

- [ ] `new_context` takes a required `handoff_path`. The legacy `handoff` string parameter is gone
      from the tool, and its description plus the parameter description state the `/handoff-doc`
      workflow.
- [ ] A new `handoffOnly: boolean` config (default `false`), validated, is what disables tail
      retention. Do NOT try to express this as `retainTokens: 0`; that was measured to keep a tail.
- [ ] In `handoffOnly` mode the replaced span runs from the first non-`system/message` surface node
      through the LAST surface node whenever the cut after that node is tool-pairing balanced
      (measured: it is, when the last node is a matched `tool/result`), walking back to the nearest
      earlier balanced cut only when it is not.
- [ ] In `handoffOnly` mode, no pre-rollover `user/message`, `assistant/message` or `tool/result`
      remains on the surface, INCLUDING the `new_context` tool call and its result.
- [ ] The replacement `user/message` contains exactly the handoff file text as one text block, with
      no added preamble, provenance paragraph, notes section or checkpoint wrapper marker.
- [ ] The replaced span never includes a `system/message` at surface node 0.
- [ ] The session id is unchanged; no new session is created.
- [ ] The transaction stays a normal one: `compaction/start`, `compaction/summary`, replacement
      `user/message` with source provenance, `compaction/end`.
- [ ] The shrink guard still refuses a replacement that is not smaller than what it replaces.
- [ ] The `notes`, `history` and `get_context_remaining` tools stay mounted and behave as before.
- [ ] `buildCheckpointText` in `src/checkpoint.ts` and/or its callers stop composing the old
      narration + Durable notes + Handoff text on the handoff path. Decide whether the notes+handoff
      composition is still reachable at all; if ticket 05 keeps it as the emergency fallback, keep
      the function and add the handoff-only composition beside it rather than replacing it.
- [ ] The shipped preset sets `handoffOnly: true`. The preset is GENERATED: change
      `scripts/make-web-preset.mjs` and re-run it, never hand-edit
      `presets/standard-rollover/agent.cordis.yml` (a test byte-compares the committed preset with a
      fresh generation).
- [ ] Test: the derived messages contain the handoff file's distinctive content.
- [ ] Test: every pre-rollover exchange carries a unique sentinel, and after the rollover none of
      those sentinels appears in the derived messages.
- [ ] Test: no prior `assistant/message` carrying a tool call and no prior `tool/result` remains on
      the surface. Asserted by node type, because a sentinel-only check misses a surviving tool-call
      block.
- [ ] Test: the surface after a `handoffOnly` rollover is exactly two nodes, the `system/message`
      head and the replacement handoff message, when no further turn has started.
- [ ] Test: the session id is identical before and after, and `countRollovers` advanced by one on
      that same session.
- [ ] Test: the mid-call scenario is separate. A rollover fired while a tool call is genuinely in
      flight with no result yet backs the span up to the nearest earlier balanced cut, and the only
      retained material is that incomplete call/result unit.
- [ ] Test: an explicit `new_context` whose handoff cannot shrink the selected span is refused,
      leaves the surface unchanged, and does NOT substitute the notes checkpoint.
- [ ] Test: the `handoffOnly` selector keeps no priced tail. Revert-sensitive: it must fail if the
      mode is removed.
- [ ] Test: an explicit `new_context` whose `handoff_path` is missing, empty or unreadable leaves
      the old context intact, throws where the model can read it, and writes no `compaction/start`.
- [ ] The test context mounts `dsh-agent-instructions` so instruction re-injection is exercised
      rather than assumed (its only injected service is `sessionProjections`, which the testkit
      already mounts; the tsconfig path exists).
- [ ] Test: the FIRST post-rollover model request carries the system prompt, the restored workspace
      instruction text, and the current tool catalogue. Asserted on the recorded adapter request, not
      on `deriveMessages` alone.
- [ ] The README's rollover-path description is updated. README is yours from this ticket onward
      (ticket 01 and 02/03 did not take it).

Notes:

- Do not implement ticket 05. The emergency scan (newest file in `handoffDir` matching
  `handoffPattern`) is ticket 05's, and `handoffDir`/`handoffPattern` are already validated config
  keys that nothing reads yet. Leave the 0.90 path and the overflow/manual paths behaviorally as they
  are, except that they must keep compiling and passing once the tail mode exists.
- `tests/safety.spec.ts:176-178` casts the pending map to `{ handoff: string | null }`. If making
  `handoff_path` required changes that shape, update that cast, but do not weaken the test.
- No `checkout`/`switch`/`reset`/`clean`/`restore` in any command or commit-message text. Do not
  write to `~/.dsh`, `~/.npm-global`, or `/home/wilder/git-repos/deepseek-harness`. Leave no probe
  files in `tests/`. Stage only your own paths and never `.scratch/`. Do not push.
