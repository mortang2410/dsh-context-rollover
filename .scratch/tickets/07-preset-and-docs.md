# 07: Preset keeps the standard-rollover name and documents the new contract

**What to build:** The shipped preset is still named `standard-rollover`, carries the new
configuration, and the repository's own documentation describes the handoff-only contract and
the recorded limitation.

**Blocked by:** 02, 04, 05, 06.

**Verify:** `pnpm test -- tests/web-preset.spec.ts tests/preset-deferral.spec.ts`

**Status:** done (delivered by ticket 08, `4959c17`, plus the emergency-fallback section added in the follow-up commit)

- [x] The preset directory and preset id remain `standard-rollover`; its display name and
      description are updated to describe the handoff-only behavior.
- [x] The preset's engine row carries `reminderThresholdRatio: 0.40`, `thresholdRatio: 0.9`,
      `handoffOnly: true`, the reminder message, and the handoff directory settings.
- [x] The preset generator's flags can express every value the shipped preset carries, and the
      committed preset matches a fresh generation.
- [x] The README documents: the 40% reminder, the `/handoff-doc` then `new_context` workflow,
      that the handoff document is the entire continuation context, that no summarizer runs,
      that the same session id is kept, that history is manual retrieval only, and that 0.90 is
      the emergency fallback.
- [x] The README records the emergency fallback's limitation: at 90% no model is in the loop, so
      the handoff file is selected by newest-modified scan in the configured directory.
- [x] The README names the host line the shipped preset targets and the steps a deployment on a
      different host line must take. It no longer describes the running host's preset format as
      an unresolved limitation, because ticket 08 fixes that.
- [x] The README warns that a patch whose target row id is absent only warns and is skipped
      (`dsh-app-boot/lib/index.js:61-110`), so a silently ineffective install is possible and must
      not be mistaken for a working one.
- [x] Verification performed on the delivered artifacts, with the results stated.
      Evidence: `pnpm typecheck` exit 0; `pnpm test` exit 0 with 15 suites / 126 tests;
      `pnpm build` exit 0. Preset id `standard-rollover` in
      `presets/standard-rollover/declaration.patch.yml`; engine row parsed from the committed
      artifact carries thresholdRatio 0.9, reminderThresholdRatio 0.4, the shipped reminder
      message, handoffOnly true, handoffDir .scratch/handoff and handoffPattern HANDOFF-*.md.
      The real-registry test resolves that preset's session compaction service to this engine.
