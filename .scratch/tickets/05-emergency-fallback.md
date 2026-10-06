# 05: Emergency fallback at 90% when the 40% reminder was ignored

**What to build:** When the model ignored the 40% reminder and usage reaches 90%, the automatic
pressure rollover still commits and still lands on a handoff-only continuation context.

**Blocked by:** 04.

**Depends on:** ticket 04's `handoffOnly` mode. The emergency path uses the same replacement rule;
it must not reintroduce a verbatim tail.

**Verify:** `pnpm test -- tests/safety.spec.ts tests/handoff-only.spec.ts`

**Status:** ready-for-agent

What ticket 04 leaves you (verify in the code before relying on it):

- a `handoffOnly` config mode and a replacement path that puts only document text into the
  replacement `user/message`, with no tail and no checkpoint wrapper;
- `src/handoff.ts` with `readHandoffFile` returning a structured result (non-throwing) over a
  closed `HandoffFailureReason` union, so a bad candidate can be skipped;
- `handoffDir` and `handoffPattern` validated config keys that NOTHING reads yet. This ticket makes
  them live.

Acceptance criteria:

- [ ] `handoffDir` defaults to `.scratch/handoff` and is resolved against the session working
      directory (`session.header.cwd`), not the process working directory.
- [ ] `handoffPattern` defaults to `HANDOFF-*.md`.
- [ ] At `thresholdRatio` (0.90), the engine scans `handoffDir` for `handoffPattern` and selects the
      NEWEST by modification time.
- [ ] Candidate selection is shrink-aware and ordered: newest eligible handoff that passes the
      shrink check, else the deterministic notes checkpoint, else no rollover. A readable handoff
      that is NOT smaller than the span must not consume the single emergency attempt while a
      smaller notes checkpoint was available.
- [ ] The sizing decision happens BEFORE `compaction/start`, so a rejected candidate leaves no
      failed transaction in the log. Sizing is a pure preflight estimate over the selected span and
      the candidate text.
- [ ] When no eligible file exists, the engine falls back to the deterministic notes checkpoint so
      context is still reduced rather than stalling.
- [ ] Unreadable, empty, oversized and not-a-file candidates are SKIPPED, not fatal: a bad candidate
      must not abort the emergency rollover.
- [ ] When the session has no working directory, the scan has nothing to resolve against; fall back
      to the notes checkpoint rather than reading anywhere else.
- [ ] The overflow (`CONTEXT_WINDOW_EXCEEDED`) and manual `/compact` paths keep working and follow
      the same replacement rule as ticket 04.
- [ ] Test: with the reminder threshold raised so no reminder fires, usage crossing 0.90 commits
      exactly one rollover.
- [ ] Test: when a handoff file exists in the scanned directory, the emergency rollover's derived
      messages contain that file's content and zero pre-rollover sentinels.
- [ ] Test: when no handoff file exists, the emergency rollover still commits and the deterministic
      notes checkpoint is what lands.
- [ ] Test: an unreadable or empty candidate file is skipped and does not abort the rollover.
- [ ] Test: a candidate handoff that is not smaller than the selected span causes the notes
      checkpoint to be used instead, and the rollover still commits. Revert-sensitive: it must fail
      if the shrink-aware ordering is removed.
- [ ] Test: the fallback produces exactly one successful compaction transaction and no
      `compaction/end` carrying an error, proving the sizing happened before the lock was taken.
- [ ] Test: two candidate files with different modification times select the newer one.

Ownership: this ticket owns the emergency scan and its tests. Do not change ticket 04's
`handoffOnly` selector semantics or the `new_context` tool contract.

Constraints: no `checkout`/`switch`/`reset`/`clean`/`restore` in any command or commit-message text;
do not write to `~/.dsh`, `~/.npm-global`, or `/home/wilder/git-repos/deepseek-harness`; leave no
probe files in `tests/`; stage only your own paths and never `.scratch/`; do not push.
