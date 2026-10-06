# Plan: handoff-only context rollover

Repo: `/home/wilder/git-repos/dsh-context-handoff`, branch `handoff-only-rollover` (do not create or
switch branches; `git checkout`/`switch`/`reset`/`clean`/`restore` are forbidden on this machine).

Spec: `.scratch/specs/handoff-only-rollover.md`. Tickets: `.scratch/tickets/`. Gates:
`.scratch/GATES.md`. Review transcripts: `.scratch/codex/` (gitignored).

## Path ownership (one writer per path per wave)

| Ticket | Owns |
|---|---|
| 01 done (`ec4758b`) | `src/rollover.ts`, `src/index.ts`, `tests/harness.ts`, `tests/fixtures/standard/agent.cordis.yml`, `scripts/make-web-preset.mjs`, `README.md`, `.gitattributes` |
| 02 + 03 running | `src/config.ts`, `src/handoff.ts` (new), `src/index.ts`, `src/rollover.ts`, `scripts/make-web-preset.mjs`, `presets/standard-rollover/*`, `tests/reminder-delivery.spec.ts`, `tests/engine.spec.ts`, `tests/handoff.spec.ts` (new), `tests/harness.ts` |
| 04 | `src/rollover.ts`, `src/tools.ts`, `src/state.ts`, `src/checkpoint.ts`, `tests/handoff-only.spec.ts` (new) |
| 02+03 (running) additionally owns | `src/handoff.ts` (new), and the ADDITIVE first step of the `src/tools.ts` / `src/state.ts` change: an optional `handoff_path` parameter plus a `PendingRollover` that carries already-resolved text. Ticket 04 still owns making the path required, removing the old `handoff` string, and rewriting the tool description. |
| 05 | `src/handoff.ts`, `src/index.ts`, `tests/safety.spec.ts`, `tests/handoff-only.spec.ts` |
| 06 | `src/guidance.ts`, `src/tools.ts`, `tests/no-summarizer.spec.ts` (new) |
| 07 | `README.md`, `presets/standard-rollover/preset.yml`, `scripts/make-web-preset.mjs` |
| 08 | `cordis.patch.yml`, `scripts/make-web-preset.mjs`, `presets/standard-rollover/*`, `tests/web-preset.spec.ts`, `tests/preset-deferral.spec.ts` |

04, 05, 06 all touch `src/rollover.ts` (and 04/06 both touch `src/tools.ts`), and 07/08 both touch
`scripts/make-web-preset.mjs` and the preset directory. Those must not run concurrently.

## Waves

- Wave 1: ticket 01. DONE, commit `ec4758b`, G1 verified independently.
- Wave 2: tickets 02 and 03 together (one agent, because both edit `src/config.ts` and
  `src/index.ts`). Running. It also takes the additive first half of `src/tools.ts` / `src/state.ts`
  because the handoff read must live in the tool's `execute`; ticket 04 owns the rest of that file
  set. One recorded contract change: `tests/engine.spec.ts:81` asserts the reminder contains
  `'automatic rollover'`, which the configurable default message legitimately removes; that
  assertion is replaced with one on the new required content, not deleted.
- Wave 3: ticket 04 alone (the core replacement change; rewrites the range selector and the tool).
- Wave 4: ticket 05 and ticket 06 together ONLY if their file sets are disjoint; otherwise
  sequential. 05 edits `src/index.ts` and `src/handoff.ts`; 06 edits `src/guidance.ts` and
  `src/tools.ts`. Confirm disjointness at dispatch time.
- Wave 5: tickets 07 and 08 together, since 08 changes what 07 documents. If they collide on
  `scripts/make-web-preset.mjs`, run 08 first, then 07.
- Wave 6: whole-objective verification against G1-G8, then codex review of the implementation.

## Dispatch rules learned in this session

- State in every brief: no `checkout`/`switch`/`reset`/`clean`/`restore` in any command or in
  commit-message text; do not touch `~/.dsh` or `~/.npm-global`; do not write to
  `/home/wilder/git-repos/deepseek-harness` (read-only for resolution); no probe files left in
  `tests/` (two separate agents blocked the shared suite this way); stage only your own paths and
  never `.scratch/`.
- Give each agent the baseline numbers and the exact gate command, and require the raw output back.
- Require a mutation check on at least one new test, since a passing test proves nothing about
  whether it can fail.
