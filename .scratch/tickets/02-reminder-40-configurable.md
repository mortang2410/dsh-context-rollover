# 02: Configurable reminder at 40% naming /handoff-doc and new_context

**What to build:** The one-per-window reminder fires at 40% context usage and carries a
configurable message that tells the model to run `/handoff-doc` and then call `new_context`.

**Blocked by:** 01 (the suite must measure the running host before its assertions mean anything).

**Verify:** `pnpm test -- tests/reminder-delivery.spec.ts tests/engine.spec.ts`

**Status:** ready-for-agent

- [ ] `reminderThresholdRatio` defaults to `0.40`.
- [ ] `thresholdRatio` still defaults to `0.90` and is documented as the emergency fallback.
- [ ] A new `reminderMessage` config value exists and is validated as a non-empty string.
- [ ] `reminderMessage` supports `{percent}` as its only placeholder, substituted with the
      measured percentage at send time.
- [ ] The default `reminderMessage` reads exactly:
      `Context is {percent}% full. Use \`/handoff-doc\` to create/update the durable handoff document. Make it fully sufficient for a fresh context to continue the work. After it succeeds, call \`new_context\`. The handoff document will be the entire continuation context.`
- [ ] The shipped `standard-rollover` preset sets `reminderThresholdRatio: 0.40` and states the
      reminder message, so a copy of the preset keeps the behavior.
- [ ] Test: the reminder fires exactly once after usage crosses 40%, and not again in the same
      window.
- [ ] Test: the reminder text contains `/handoff-doc` and `new_context`.
- [ ] Test: with the default config, the delivered text contains the substituted measured
      percent rather than a hardcoded 40.
- [ ] Test: a config that raises `reminderThresholdRatio` above the usage produces no reminder,
      proving the ratio is what gates delivery rather than a hardcoded constant.
