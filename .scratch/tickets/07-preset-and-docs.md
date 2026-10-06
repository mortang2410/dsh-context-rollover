# 07: Preset keeps the standard-rollover name and documents the new contract

**What to build:** The shipped preset is still named `standard-rollover`, carries the new
configuration, and the repository's own documentation describes the handoff-only contract and
the recorded limitation.

**Blocked by:** 02, 04, 05, 06.

**Verify:** `pnpm test -- tests/web-preset.spec.ts tests/preset-deferral.spec.ts`

**Status:** ready-for-agent

- [ ] The preset directory and preset id remain `standard-rollover`; its display name and
      description are updated to describe the handoff-only behavior.
- [ ] The preset's engine row carries `reminderThresholdRatio: 0.40`, `thresholdRatio: 0.9`,
      `handoffOnly: true`, the reminder message, and the handoff directory settings.
- [ ] The preset generator's flags can express every value the shipped preset carries, and the
      committed preset matches a fresh generation.
- [ ] The README documents: the 40% reminder, the `/handoff-doc` then `new_context` workflow,
      that the handoff document is the entire continuation context, that no summarizer runs,
      that the same session id is kept, that history is manual retrieval only, and that 0.90 is
      the emergency fallback.
- [ ] The README records the emergency fallback's limitation: at 90% no model is in the loop, so
      the handoff file is selected by newest-modified scan in the configured directory.
- [ ] The README records the preset-declaration incompatibility found against the running host,
      with the evidence, as a known and separately-scoped limitation.
- [ ] Verification performed on the delivered artifacts, with the results stated.
