# 05: Emergency fallback at 90% when the 40% reminder was ignored

**What to build:** When the model ignored the 40% reminder and usage reaches 90%, the automatic
pressure rollover still commits and still lands on a handoff-only continuation context.

**Blocked by:** 04.

**Verify:** `pnpm test -- tests/safety.spec.ts tests/handoff-only.spec.ts`

**Depends on:** ticket 04's `handoffOnly` mode. The emergency path uses the same replacement
rule; it must not reintroduce a verbatim tail.

**Status:** ready-for-agent

- [ ] New `handoffDir` config, default `.scratch/handoff`, resolved against the session working
      directory.
- [ ] New `handoffPattern` config, default `HANDOFF-*.md`.
- [ ] At `thresholdRatio`, the engine scans `handoffDir` for `handoffPattern` and selects the
      newest by modification time.
- [ ] A selected file that is readable, non-empty, and passes the shrink check becomes the
      replacement content under the same handoff-only rule as ticket 04.
- [ ] Candidate selection is shrink-aware and ordered: newest eligible handoff that passes the
      shrink check, else the deterministic notes checkpoint, else no rollover. A readable handoff
      that is NOT smaller than the span must not consume the single emergency attempt while a
      smaller notes checkpoint was available.
- [ ] When no eligible file exists, the engine falls back to the deterministic notes checkpoint
      so context is still reduced rather than stalling.
- [ ] The unreadable, empty or oversized cases fall back rather than throwing out of the
      pressure path.
- [ ] The overflow and manual `/compact` paths keep working and follow the same replacement rule.
- [ ] Test: with the reminder threshold raised so no reminder fires, usage crossing 90% commits
      exactly one rollover.
- [ ] Test: when a handoff file exists in the scanned directory, the emergency rollover's
      derived messages contain that file's content and zero pre-rollover sentinels.
- [ ] Test: when no handoff file exists, the emergency rollover still commits and the
      deterministic notes checkpoint is what lands.
- [ ] Test: an unreadable or empty candidate file is skipped and does not abort the rollover.
- [ ] Test: a candidate handoff that is not smaller than the selected span causes the notes
      checkpoint to be used instead, and the rollover still commits. Revert-sensitive: it must
      fail if the shrink-aware ordering is removed.
- [ ] Test: two candidate files with different modification times select the newer one.
