# dsh-context-rollover

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle for
**model-driven context self-management**: the model can deliberately end one
working context window and continue in a fresh one while preserving durable
state — with **no summarization**.

```text
fresh working context = standing instructions + the durable handoff document you wrote; nothing else
```

Inspired by the context-management architecture in `openai/codex` (the
`new_context` tool, token-budget compaction without a summarizer, history/notes
separation) and `pi-posthorse`. Codex is the architectural reference; DSH is the
implementation authority — everything runs through DSH's own surface-replace
protocol and compaction transaction.

> **Web profile: rollover only runs in the `standard-rollover` preset.**
>
> Installing this bundle is not enough on its own. The Web profile composes
> compaction from the session's **agent preset**, and the default preset
> (`standard`) stays exactly as shipped: it keeps the built-in summarizer and
> gets **no rollover tools and no rollover guidance** — no `new_context`, no
> `get_context_remaining`, no `notes`, no `history`. A `standard` session
> cannot roll over at all.
>
> To use it, open a **new** session and select **"Standard + rollover
> (experimental)"** in the preset picker *before sending the first message* —
> a session's preset is frozen once its first turn runs.
>
> Headless and other rosterless profiles are the exception: they have no preset
> roster, so the host engine serves every session and there is nothing to pick.

## How it works

The plugin provides the active `ctx.compaction` engine (it disables
`dsh-compaction-basic` in its bundle patch). On the Web profile the engine
must additionally live in the session's agent preset — see
[Web profiles](#web-profiles-preset-sessions) below. A rollover is a real DSH
compaction: `compaction/start` → `compaction/summary` → one replacement
`user/message` with full source provenance → `compaction/end` — but the
"summary" is the **handoff document's own bytes**, never an LLM call. Raw
session events stay persisted and the session id is unchanged; `deriveMessages()`
rebuilds automatically.

After a rollover the model-visible context is the standing system/developer
instructions plus the handoff document. **No recent tail, no prior messages and
no tool calls carry over** — including the `new_context` call that requested the
boundary, and including the workspace `AGENTS.md` chain, which
`dsh-agent-instructions` re-injects from disk because the surface no longer
carries it.

Responsibilities stay split (the Codex lesson):

| Concern | Owner |
|---|---|
| Request a boundary | `new_context` tool (records a pending request only) |
| Cross the boundary | `agent/pre-step` (before the next model request) and `agent/turn-stopping` |
| Track windows | rollover count + summary seqs read from the durable log |
| Measure pressure | `ctx.tokenMeter` + the routed model's context window |
| Replace the surface | `commitRollover` inside DSH's compaction transaction |
| Preserve selected state | `notes` tool (markdown files per session) |
| Recover old details | `history` tool (search/read over shadowed surface events) |

### Model-facing tools

- **`new_context({ handoff_path })`** — request a context boundary at the next
  safe point. `handoff_path` is **required**: the durable handoff document the
  new window continues from, absolute or relative to the session working
  directory. It is read inside the tool, so a missing, unreadable, empty or
  oversized document is refused as the tool result the model reads instead of a
  boundary that silently never happens. The document's bytes become the entire
  new context. The boundary is crossed at a safe lifecycle point, never
  mid-tool-batch.
- **`get_context_remaining()`** — honest headroom: tokens left before the hard
  window and before the automatic rollover, or "not measured yet".
- **`notes`** — `list | read | write | append | search` over per-session
  markdown files under `<dsh home>/notes/<session id>/`. Nothing is written
  automatically; the model decides what survives.
- **`history`** — `search | read` over conversation that left the active
  surface. Targeted recovery, not wholesale reconstruction.

### Rollover paths

1. **Model-driven** (the intended path): the model runs `/handoff-doc`, writes
   the durable document, and calls `new_context({ handoff_path })` with its
   path. The document replaces the whole prior surface under the
   `handoffOnly` rule.
2. **Pressure** (safety net): above `thresholdRatio` (0.90) the engine rolls
   over automatically. Below that, at `reminderThresholdRatio` (0.40), a
   **one-per-window** reminder tells the model to run `/handoff-doc` and then
   call `new_context`.
3. **Overflow**: a provider-confirmed `CONTEXT_WINDOW_EXCEEDED` forces a
   rollover and retries the request.
4. **Manual**: `/compact` keeps working on an idle agent.

Under `handoffOnly` (what the shipped preset sets) every path replaces the span
from the first non-system surface node through the **last** surface node, so no
priced tail survives. `retainTokens: 0` is deliberately NOT how that is
expressed: a zero token budget still retains the last node and the tool-pairing
walk keeps more, which is exactly the old material the handoff-only rule exists
to drop. `retainRatio` / `retainTokens` remain available for a deployment that
wants a verbatim tail (`handoffOnly: false`).

The **only** case where old material can survive is a rollover that fires while
a step is genuinely mid-tool-call with no result yet: the host requires a
tool-pairing balanced cut, so the selector backs up to the nearest earlier
balanced cut and that incomplete call/result unit stays on the surface. That is
a host constraint, not a retained tail.

The engine-driven paths (pressure, overflow, manual) have no model in the loop
and therefore no document to read; they still compose the deterministic notes
checkpoint. Ticket 05 teaches the pressure path to prefer a scanned handoff
document; `handoffDir` and `handoffPattern` are already validated configuration
keys that nothing reads yet.

## What this plugin touches

- **Registers four model-facing tools** (`new_context`, `get_context_remaining`, `notes`, `history`)
  and one system-prompt section — on headless profiles in every session; on
  the Web profile only inside `standard-rollover` sessions (other presets stay
  exactly as shipped).
- **Writes files** in exactly one place: markdown notes under `<dsh home>/notes/<sessionId>/`.
  Nothing else on disk is written; no network calls, no telemetry.
- **Replaces the active compaction backend** (`compaction-basic` is disabled by the bundle patch).
  Session logs stay fully compatible in both directions.
- **No credentials, no cloud services, no data leaves the machine.**

## Host version compatibility

The plugin typechecks against **both** host lines: the development checkout and
its installed profiles (`0.1.6-alpha.1`, via generated tsconfig paths) and the
newest packages published to public npm (`0.0.1-rc.1`, the
`pnpm typecheck:compat` probe against `compat/node_modules`). Runtime
differences are bridged in `src/compat.ts`:

- the session log as `snapshotEvents()` (newer line) or `events` (published);
- `eventAt(seq)` versus indexing that array;
- per-node pricing as `heuristicTokens` (newer line) or `tokens`;
- the replacement operation as `{ startSeq, endSeq }` (newer line) or
  `{ start, end }`, probed once per process because each line rejects the
  other's field names.

Note the published `@deepseek-ai/dsh-*` packages are a *partial* mirror: some
of their peers reference packages that were never published publicly, so a
standalone npm-only host graph cannot be assembled. That is expected — the
plugin's peers resolve from the running dsh host's installation closure, and
installing the plugin itself into a profile fetches only this package.

## Install

From npm (recommended):

```sh
dsh plugin --profile <profile> add dsh-context-rollover
# or, without the dsh CLI:
pnpm --dir "$DSH_HOME/profiles/<profile>" add dsh-context-rollover
```

A custom profile initializes with just `dsh-base`; the bundle's patch applies
automatically because the package declares `dsh.bundle.patch`. After the first
install (a bundle-membership change is a boot-time composition), start the
profile once — the plugin's peer packages resolve from the running host's
installation closure, never from npm.

From GitHub instead of npm:

```sh
dsh plugin --profile <profile> add github:athif23/dsh-context-rollover
```

From a local checkout (development, see the HMR section below):

```sh
dsh plugin --profile <profile> add D:/path/to/dsh-context-rollover
```

**Windows note**: if the plugin loads but its `@deepseek-ai/*` imports fail at
runtime after an install from Git Bash, pnpm may have materialized broken
`link:` junctions (a Git Bash/Windows path-mangling bug). Recreate them with
`cmd /c mklink /J` as described in the HMR section below — the same fix
applies to any linked sibling package in the profile.

The bundle's `cordis.patch.yml` disables `dsh-compaction-basic` and mounts the
`context-rollover` engine itself. `command-compact`, the token meter, and the
compaction invariant companions need no changes — they depend only on
`ctx.compaction`.

### Web profiles (preset sessions)

Headless and other base-only profiles are done after the install above: the
host engine *is* the session's engine, no roster exists, and nothing stands
down. The Web profile is different — its sessions compose compaction from
their **agent preset**, not from the host — so the bundle additionally
registers a shipped `standard-rollover` preset ("Standard + rollover
(experimental)" in the picker) beside the deployment's own set. Restart the
host once after install, then open **new** sessions on it to try the
experiment; `standard` stays the default. Pick the preset while the session is
still **blank**: the creation header is deep-frozen, and a session may only
change preset before its first turn runs, so an already-started `standard`
session cannot be moved onto rollover.

No commands, no profile edits. Two behaviors make that hold:

- The host engine **defers to any preset-owned backend**: on a `standard`
  session the shipped summarizer runs alone (previously the two backends
  raced each pressure signal); on `standard-rollover` the preset's rollover
  engine runs alone; headless sessions keep the host engine.
- The preset's engine row sets `modelSurface: 'always'`, so it is the only
  source of rollover tools and guidance in its sessions. On preset
  deployments the host row (`modelSurface: 'auto'`) registers neither, so
  `standard` and `minimal` sessions never see rollover-framed instructions.

Custom thresholds belong to your own preset copy (the supported customization
flow: copy `standard-rollover` in the picker and edit the `context-rollover`
row) — the shipped preset carries the defaults below. If a deployment
restates the whole `agent-presets` config in a later patch layer, that layer
wins and hides the shipped preset; re-adding the bundle's root there
restores it. Uninstalling the bundle removes the preset: sessions already on
it keep running, new ones must pick another preset.

Maintainers: `presets/standard-rollover/` is generated, not authored —
re-run `pnpm preset:sync` after harness updates and commit the refresh. The
sync reads `tests/fixtures/standard/agent.cordis.yml`, which carries the
shipped `standard` rows this repo controls (the running host declares its
presets as `.patch.yml` files, not `standard/agent.cordis.yml` directories),
keeps everything else byte-identical, and fails loud when the `standard` shape
drifts.

Configuration (cordis.yml `config` on the plugin row):

```yaml
- insert:
    - id: context-rollover
      name: dsh-context-rollover
      config:
        thresholdRatio: 0.9          # emergency rollover point (fraction of window)
        reminderThresholdRatio: 0.4  # one-time /handoff-doc reminder point
        handoffOnly: true            # no tail: the handoff document replaces the surface
        retainRatio: 0.1             # recent verbatim tail when handoffOnly is false
        retainTokens: null           # absolute tail budget; overrides retainRatio
        handoffMaxChars: 20000       # max accepted handoff document size
        handoffDir: .scratch/handoff # emergency scan root (ticket 05; nothing reads it yet)
        handoffPattern: 'HANDOFF-*.md'
        notesEnabled: true
        historyEnabled: true
        notesDir: null               # base dir override; default <dsh home>/notes
        modelSurface: auto           # auto (host rows) | always (preset rows)
```

## Local development with HMR

The fast loop runs DSH from your checkout with the plugin linked from this
directory and Cordis HMR watching the source:

1. **Create a dedicated profile and link this package**

   ```sh
   dsh plugin --profile rollover-dev add D:/path/to/dsh-context-rollover
   ```

   (A custom profile initializes with just `dsh-base`; the bundle's patch
   applies automatically because the package declares `dsh.bundle.patch`.)

2. **Enable the `hmr` row** in `$DSH_HOME/profiles/rollover-dev/cordis.patch.yml`
   (patch rows replace whole configs, so restate `root`):

   ```yaml
   - id: hmr
     config:
       root: ['.', 'D:/path/to/dsh-context-rollover/src']
       debounce: 100
   ```

   The base bundle mounts `hmr` disabled by default; the `timer` row it needs
   is already active.

3. **Run DSH from source**

   ```sh
   cd /path/to/deepseek-harness
   pnpm run build          # once; Typert host artifacts are required
   pnpm dsh --profile rollover-dev
   ```

   Source launch runs through tsx (`node --import tsx/esm`), which is what makes
   hot reload of TypeScript plugin sources work.

4. **Edit `src/*.ts` in this package** — the affected plugin reloads in place;
   registrations (tools, system-prompt sections, event listeners) unwind and
   reapply through Cordis effects. Profile patch edits also recompose live
   (`patchReload: live` is the default for custom profiles).

5. **Restart is still required for**: initial bundle installation, bundle
   membership changes (`dsh.plugin add/remove`), framework-level dependency
   changes (Cordis falls back to `loader.exit()`), and anything HMR cannot
   safely swap.

### Windows: `link:` junctions and Git Bash

`pnpm install` in a profile run from Git Bash mangles `link:D:/...`
specifiers into junctions with invalid targets (the drive colon is treated
as relative). If a profile's linked plugins fail to load after an install,
recreate the junctions with the real targets:

```sh
cmd /c mklink /J "%DSH_HOME%\profiles\web\node_modules\dsh-context-rollover" "D:\path\to\dsh-context-rollover"
```

(or run the install from PowerShell/cmd). This package's own runtime peers
are junctions into the shared installation closure at
`$DSH_HOME/profiles/node_modules/@deepseek-ai/*`. That is what lets the
engine share the host's module instances: a service plugin that extends
`CompactionEngine` must import the exact classes the host loaded, so
resolving its `@deepseek-ai/*` imports through the same closure as the host
is load-bearing, not an optimization.

## Tests and typecheck (no DSH build needed)

The sibling DSH checkout is the source of truth: `tsconfig.base.json` paths are
generated into `tsconfig.dsh-paths.json` and vitest aliases execute everything
from TypeScript source — the same source plane DSH's own suites use. Vendored
packages typecheck against their built declarations so `skipLibCheck` absorbs
their relaxed strictness.

```sh
pnpm install
pnpm test        # surface, notes, history, engine integration, tool rendering
pnpm typecheck
```

Tests mount the real session store, token meter, tool runtime, agent loop,
`dsh-agent-instructions` with a real local filesystem, and **the compaction
invariant companions**, so every committed rollover is validated against DSH's
own invariants. `tests/handoff-only.spec.ts` proves the central claim end to
end: the model researches, calls `new_context` mid-turn with a handoff path, and
the surface at the transaction's own `compaction/end` is exactly the
`system/message` head plus the replacement document — asserted by node type, and
on the recorded adapter request for the first post-rollover model call.

## Scope and limits

- Under `handoffOnly` a rollover replacement contains the handoff document and
  nothing else: no notes, no narration, no older user prompts and no tail. The
  notes checkpoint still exists and is what the engine-driven paths compose.
- Notes survive context rollovers within a session; no cross-session sync,
  embeddings, or cloud storage.
- Notes are files, not session events: `Session.append` cannot mark a plugin's
  custom event types `ignorable`, so unknown plugin events on a session log
  would make that log unreadable by any DSH build without the plugin. Only
  known event types (`compaction/*`, `user/message`) are written.
- The generic `<compaction>` checkpoint provenance is reused, so transcript UIs
  recognize rollover checkpoints like any compaction.
- No DSH core was forked or patched; the plugin only consumes public seams.

## License

MIT
