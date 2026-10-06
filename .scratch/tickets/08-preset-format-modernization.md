# 08: Modernize the standard-rollover preset declaration to the running host's format

**What to build:** A session on the running DSH host (0.2.0-rc.2) can actually select a preset
named `standard-rollover` and get this engine as its compaction backend, with the new
configuration. Today that is impossible, so nothing in tickets 02 to 06 reaches a real session.

**Blocked by:** 01.

**Verify:** `pnpm test -- tests/web-preset.spec.ts tests/preset-deferral.spec.ts`

**Status:** ready-for-agent

Read this before starting. On the running host, three things differ from what this repo assumes,
each verified from the installed packages:

- The roster row is `agent-preset-registry`
  (`~/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-web-app/cordis.patch.yml:562-566`),
  not `agent-presets`, and its Config schema is only `{ default, selectedDefault }`
  (`dsh-agent-preset-registry/lib/index.js:471-474`). The `roots` / `includeShippedRoot` /
  `includeUserRoot` fields this repo's `cordis.patch.yml` targets do not exist there.
- A preset is declared as a `@deepseek-ai/dsh-agent-preset` row carrying an inline
  `config.plugins` array inside a `.patch.yml` file
  (`dsh-web-app/presets/standard.patch.yml:1-12`), not as a `presets/<id>/agent.cordis.yml`
  directory read from a root.
- The shipped `standard` roster names `compaction-basic` inside its own per-preset `compaction`
  isolate group (`dsh-web-app/presets/standard.patch.yml:62-74`), and this engine defers to any
  preset-owned backend. So the preset must replace that row, not merely sit beside it.

Acceptance criteria:

- [ ] The shipped preset is still named `standard-rollover`; a session selecting that id gets this
      engine and not `compaction-basic`.
- [ ] The preset declaration matches the running host's format, derived from the host's own
      shipped `standard` declaration rather than hand-written from memory.
- [ ] The bundle patch stops targeting roster fields the running host does not have. Note the
      failure mode this fixes: an unmatched patch id only WARNS and is skipped
      (`dsh-app-boot/lib/index.js:61-110`), so the current patch installs and boots clean while
      doing nothing at all.
- [ ] The bundle patch cannot silently no-op. Either the row it targets is asserted to exist, or
      the preset is declared by a mechanism that fails loudly when its anchor is absent. State in
      the ticket which of the two you implemented and how a future drift is caught.
- [ ] The bundle patch fails loudly if the host's preset declaration shape drifts, the way the
      preset generator already fails loudly on an unexpected `compaction-basic` row.
- [ ] The preset's engine row carries `reminderThresholdRatio: 0.40`, `thresholdRatio: 0.9`,
      `handoffOnly: true`, the reminder message, and the handoff directory settings.
- [x] RESOLVED: the engine row's `name` must be the BARE package specifier `dsh-context-rollover`.
      Verified in the host source: the boot installs runtime module-resolution interception
      (`dsh-app-boot/lib/index.js:1641`) and `routeScoped` (`:1408`) resolves a bare name through
      `resolution.entries` (`:1426`), which `collectInstallationScopePackages` (`:681`) fills from the
      install anchor's closure. A plain `createRequire(<profile>/...).resolve()` probe is NOT the
      authority and wrongly reports MODULE_NOT_FOUND. Measured end to end: `dsh-context-rollover`
      mounts; `@deepseek-ai/dsh-context-rollover` and a repo-relative path do not.
- [ ] The engine row's `name` RESOLVES on the running host, proven by test. This is the most likely way to get a
      preset that registers but whose engine row never mounts, so prove it rather than assuming.
      The currently committed preset names the engine `'../../lib/index.js'`, a path relative to the
      old per-preset directory. In the inline format there is no preset directory: the registry
      mounts a preset's rows with `prepareProfileEntries(ctx, plugins, ctx.baseUrl)` and
      `mountPreset` passes `record.context.baseUrl`, which is the composition's base, not a preset
      folder (`dsh-agent-preset-registry/lib/index.js:262-269,534`). So a relative path now resolves
      against a different base and may not reach this package at all. Determine the correct form
      empirically. The shipped presets name their plugins by bare package specifier
      (`dsh-web-app/presets/standard.patch.yml` names `@deepseek-ai/dsh-compaction-basic`), which is
      the strongest candidate; a `!!js` profile-relative expression is the other. Whichever you
      choose, a test must show the row actually resolves from the running profile layout.
- [ ] The committed preset matches a fresh generation from the host's shipped declaration.
- [ ] Test: the generated preset contains this engine's row and not `compaction-basic`.
- [ ] Test: the generator fails loudly when the host declaration's anchor row is absent or gains
      an unexpected block.
- [ ] Test: the generated host-format declaration actually loads through the real preset registry,
      and selecting `standard-rollover` resolves that session's compaction service to THIS engine
      rather than to `compaction-basic`. Checking the generated text alone does not prove the
      ticket's outcome; the preset must be shown to register and resolve.
- [ ] The repo's documentation states exactly which host line the shipped preset targets, and the
      steps a deployment on a different host line must take.

Note for the implementer: verify each claim above against the installed packages before coding.
The line numbers are from the `0.2.0-rc.2` installation on this machine and are admitted to drift.
