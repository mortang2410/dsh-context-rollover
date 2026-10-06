# 06: No summarizer on any rollover path, and guidance that teaches the workflow

**What to build:** No model call happens on any rollover path, and the model-visible guidance
teaches the `/handoff-doc` then `new_context` workflow instead of the old short-handoff one.

**Blocked by:** 04.

**Note:** the reminder predicate shared by sender and reader (`isPressureReminder`) is asserted by
test under ticket 02; this ticket owns only the no-model-call and guidance criteria.

**Verify:** `pnpm test -- tests/no-summarizer.spec.ts tests/engine.spec.ts`

**Status:** ready-for-agent

- [ ] `ctx.compaction` is this engine; the bundle patch keeps `compaction-basic` disabled.
- [ ] No rollover path (model-requested, pressure, overflow, manual) invokes the LLM.
- [ ] The `compaction/summary` event carries this engine's provider and its deterministic model
      string on every path.
- [ ] The system-prompt guidance section leads with: run `/handoff-doc`, make the document fully
      sufficient for a fresh context, then call `new_context` with its path.
- [ ] The guidance states the handoff document is the entire continuation context.
- [ ] The guidance states that old history is manual recovery through `history` only, and that it
      is never injected automatically.
- [ ] The old instruction telling the model to pass a short `handoff` string is gone from both
      the guidance and the `new_context` tool description.
- [ ] The test harness records adapter invocation order (a monotonically increasing sequence
      number per stream call) so a request can be placed relative to the compaction events.
- [ ] Test: no stream starts between `compaction/start` and `compaction/end`, asserted for each
      rollover path separately: model-requested, pressure, overflow and manual. The scope is the
      rollover window, not the whole turn, because the model legitimately calls the LLM while
      writing the handoff.
- [ ] Test: the summary event's provider and model identify this engine's deterministic path
      rather than a summarizer route.
- [ ] Test: the assembled system prompt contains the `/handoff-doc` workflow text and does not
      contain the removed short-handoff instruction.
