# 01: Repair host-version drift so the suite measures the running host

**What to build:** The plugin typechecks and its existing test suite passes against the running
DSH host line, so that every later ticket's test evidence is trustworthy. No behavior change is
intended beyond making the plugin compile and its existing suites pass.

**Blocked by:** None (can start immediately).

**Verify:** `cd /home/wilder/git-repos/dsh-context-handoff && pnpm typecheck && pnpm test`

**Status:** ready-for-agent

- [ ] `pnpm typecheck` exits 0.
- [ ] `pnpm test` exits 0 with the pre-existing suites (notes, rollover, history, engine,
      safety, tools, tool-discovery, pressure-range, reminder-delivery, preset-deferral).
- [ ] The plugin declares its own `MessageSourceMap` entry through the host's documented merge
      point instead of relying on the removed catch-all `kind: 'plugin'`, and every site that
      broke under that removal is updated: `src/rollover.ts:429-433`, `src/index.ts:260`, and the
      test fixture at `tests/history.spec.ts:159`.
- [ ] `tests/rollover.spec.ts:60` is updated for the host's one-argument `createSystemMessage`
      (`packages/llm/llm/src/message.ts:279`).
- [ ] The test adapters implement the host's current `stream()` signature: `tests/harness.ts:51,79`,
      plus the call sites in `tests/engine.spec.ts`, `tests/preset-deferral.spec.ts`,
      `tests/pressure-range.spec.ts`, `tests/reminder-delivery.spec.ts`, `tests/safety.spec.ts`
      and `tests/tools.spec.ts`.
- [ ] The shrink-guard test failures are fixed by giving the fixture a span genuinely larger
      than its checkpoint, not by weakening the guard.
- [ ] The preset-sync test compares against a `standard` preset source the repo controls rather
      than a private fork directory layout.
- [ ] No test assertion was deleted or loosened to reach green.

Note: the pre-existing baseline is recorded here so the improvement is provable. Measured on the
pristine clone: `pnpm typecheck` reports 23 errors in the three groups listed above, and
`pnpm test` reports 3 failures and 49 passes. The three failures are two shrink-guard
rejections (`tests/rollover.spec.ts`, `tests/history.spec.ts`) and the preset-sync failure
(`tests/web-preset.spec.ts`, no `standard` source found).
