# 04: new_context replaces the whole surface with the handoff document only

**What to build:** `new_context({ handoff_path })` crosses the boundary by replacing the entire
prior conversational surface with the durable handoff document's bytes. No recent tail, no prior
messages, no tool calls, no summaries, no other old-session material reach the fresh context.

**Blocked by:** 01, 03.

**Verify:** `pnpm test -- tests/engine.spec.ts tests/handoff-only.spec.ts tests/rollover.spec.ts`

**Status:** ready-for-agent

- [ ] `new_context` takes a required `handoff_path` argument; its description and parameter
      description state the `/handoff-doc` workflow.
- [ ] The replacement `user/message` contains exactly the handoff file text as one text block,
      with no added preamble, provenance paragraph or checkpoint wrapper markers.
- [ ] The replaced span covers the whole surface except a `system/message` at surface node 0.
- [ ] A new `handoffOnly: true` mode makes the range selector retain no priced tail at all,
      instead of relying on `retainTokens: 0` (which was measured to keep the final surface node
      and to back off further for tool pairing; see the spec's "Verified defect" note). The span
      runs through the LAST surface node whenever the cut after that node is tool-pairing
      balanced, walking back only when it is not.
- [ ] In `handoffOnly` mode, no pre-rollover `user/message`, `assistant/message` or `tool/result`
      remains on the surface, INCLUDING the `new_context` tool call and its result. Measured: on
      a 16-node surface whose last node is that turn's `tool/result`, the resulting surface is
      exactly the `system/message` head plus the replacement handoff message.
- [ ] The session id is unchanged; no new session is created.
- [ ] The compaction transaction is a normal one: `compaction/start`, `compaction/summary`,
      replacement `user/message` with source provenance, `compaction/end`.
- [ ] The shrink guard still refuses a replacement that is not smaller than what it replaces.
- [ ] The `notes` tool, the `history` tool and `get_context_remaining` stay mounted and behave as
      before.
- [ ] Test: after a successful `new_context`, the derived messages contain the handoff file's
      distinctive content.
- [ ] Test: every pre-rollover exchange carries a unique sentinel, and after the rollover none
      of those sentinels appears in the derived messages. This is the zero-tail proof.
- [ ] Test: no prior `assistant/message` carrying a tool call and no prior `tool/result` remains
      on the surface after the rollover. Asserted explicitly, because the naive tail selector
      leaves both behind and a sentinel-only check would not catch the tool-call block.
- [ ] Test: the surface after a `handoffOnly` rollover is exactly two nodes: the `system/message`
      head and the replacement handoff message, when no further turn has started.
- [ ] Test: the `handoffOnly` selector keeps no priced tail. Revert-sensitive: it must fail if
      the mode is removed.
- [ ] Test: a rollover fired while a tool call is genuinely in flight (no result yet) backs the
      span up to the nearest earlier balanced cut, and the retained material is only that
      incomplete call/result unit. This is the mid-call scenario, kept separate from the normal
      `new_context` path test above, which permits no survivor at all.
- [ ] Test: the session id is identical before and after.
- [ ] The test context mounts `dsh-agent-instructions` so instruction re-injection is exercised
      rather than assumed.
- [ ] Test: the FIRST post-rollover model request carries the system prompt, the restored
      workspace instruction text, and the current tool catalogue. Asserted on the recorded
      adapter request, not on `deriveMessages` alone.
- [ ] Test: the derived messages after the rollover still contain the system-prompt head.
- [ ] Test: the tool reports a refusal and the old context is intact when `handoff_path` is
      missing, empty or unreadable. No `compaction/start` is left behind.
- [ ] Test: an explicit `new_context` whose handoff cannot shrink the selected span is refused,
      leaves the surface unchanged, and does NOT silently substitute the notes checkpoint (unlike
      the emergency path in ticket 05). No `compaction/start` is left behind.
