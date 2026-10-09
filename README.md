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

> **Web profile: rollover only runs in a rollover preset, and you must pick one.**
>
> Installing this bundle is not enough on its own. The Web profile composes
> compaction from the session's **agent preset**, and the shipped presets
> (`standard`, `cordis`, `ptc`) stay exactly as they are: they keep the built-in
> summarizer and get **no rollover tools and no rollover guidance** — no
> `new_context`, no `get_context_remaining`, no `notes`, no `history`. A
> `standard` or `cordis` session cannot roll over at all.
>
> This bundle ships **two** rollover presets, and a session uses exactly one:
>
> | Picker entry | Derived from | Use it when |
> |---|---|---|
> | **"Standard + rollover (experimental)"** (`standard-rollover`) | `standard` | you want the full coding agent plus rollover |
> | **"Local Cordis"** (`local-cordis`) | `cordis` (Creator Mode) | you want Creator Mode's tools and preset-authoring skills plus rollover |
>
> To use either, open a **new** session and select it in the preset picker
> *before sending the first message* — a session's preset is frozen once its
> first turn runs.
>
> Making one of them the default for new sessions is a separate deployment
> choice, and the only supported route is the profile patch or the picker's
> "Set as new task default".
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
  window and before the rollover point (warning only; `new_context` rolls over),
  or "not measured yet".
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
2. **Pressure** (warning only): above `thresholdRatio` (0.90) the engine logs
   one warning per turn and does not roll over. Below that, at
   `reminderThresholdRatio` (0.40), a **one-per-window** reminder tells the model
   to run `/handoff-doc` and then call `new_context`.
3. **Overflow** (never a rollover): the engine does not roll over on a
   provider-confirmed `CONTEXT_WINDOW_EXCEEDED` and does not retry. The provider
   error reaches the user unchanged. The user can run `/compact`, or the model
   can call `new_context`, before the next request.
4. **Manual**: `/compact` keeps working on an idle agent.

Under `handoffOnly` (what the shipped preset sets) every path replaces the span
from the first non-system surface node through the **last** surface node, so no
priced tail survives. `retainTokens: 0` is deliberately NOT how that is
expressed: a zero token budget still retains the last node and the tool-pairing
walk keeps more, which is exactly the old material the handoff-only rule exists
to drop. `retainRatio` / `retainTokens` remain available for a deployment that
wants a verbatim tail (`handoffOnly: false`).

Nothing old survives, in every case, including a rollover that fires while a
step is mid-tool-call with no result yet. The host requires a tool-pairing
balanced cut, so a pre-step whose tail cut is unbalanced does not roll over at
all: it defers, the host appends the missing `tool/result` (a skipped or aborted
call gets a synthetic one), and the **next** pre-step crosses with the whole
prior surface inside the span. A deferred pre-step is logged at info level, not
as a failure, and it leaves the model's request pending so the rollover is
retried rather than lost.

Manual `/compact` has no model in the loop and therefore no document to name;
it composes the deterministic notes checkpoint.
No engine path reads a handoff directory: `handoffDir` and `handoffPattern` are
accepted configuration keys that nothing reads.

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

The shipped `standard-rollover` preset targets the **DSH 0.2.0-rc.2 host line**.
That line declares an agent preset as a `@deepseek-ai/dsh-agent-preset` row
carrying an inline `config.plugins` array inside a `.patch.yml` file, listed in
the bundle's `dsh.bundle.patch` array, and exposes the preset roster as
`agent-preset-registry` with a Config of only `{ default, selectedDefault }`.
This bundle ships exactly that shape: two generated declarations,
`presets/standard-rollover/declaration.patch.yml` (from the host's
`dsh-web-app/presets/standard.patch.yml`) and
`presets/local-cordis/declaration.patch.yml` (from the host's
`dsh-web-app/presets/cordis.patch.yml`), both produced by
`scripts/make-web-preset.mjs` and both listed in this bundle's own
`dsh.bundle.patch` array.

**A patch whose target row id is absent only WARNS and is skipped.** The
bundle composition path (`dsh-app-boot`'s `applyEntryPatches`) logs
`patch: entry %C not found` for an `id`-targeted patch and
`patch insert: entry %C not found` for an insert into a missing group, then
continues. It never fails a boot. A bundle whose patch targets a row the host
does not define therefore installs, boots clean, and does **nothing at all** —
there is no error to notice. That is exactly what the earlier revision of this
bundle did on the running host: it wrote `roots` / `includeShippedRoot` /
`includeUserRoot` into a row id named `agent-presets`, which does not exist on
this host line, so no `standard-rollover` preset ever appeared. Do not read a
clean boot as proof that a bundle's patch applied; check for the preset in the
picker, or run the assertion this repo ships (see
[Testing the shipped preset](#testing-the-shipped-preset)).

**On a different host line**, a deployment must:

1. Find its own shipped `standard` declaration: the file listed in
   `@deepseek-ai/dsh-web-app`'s `dsh.bundle.patch` array under the profile's
   installed packages (`profiles/<name>/node_modules/@deepseek-ai/dsh-web-app/
   presets/standard.patch.yml`, or the installation's own copy under the `dsh`
   package's `node_modules`).
2. Regenerate the presets from it:
   `node scripts/make-web-preset.mjs --source-preset standard --preset-id standard-rollover`
   and
   `node scripts/make-web-preset.mjs --source-preset cordis --preset-id local-cordis`.
   Each command needs its own `--preset-id`: the default is `standard-rollover`,
   so omitting it on the cordis command would overwrite the standard-derived
   artifact and leave `local-cordis` stale. Both commands read from
   `tests/fixtures/host` by default, or from `--presets-dir <dir>`.
   The generator fails loud when that declaration's anchor row, compaction
   isolate group, or declaration identity is not the shape it anchors on, so a
   host whose format moved cannot silently produce a preset that never mounts.
   An unknown `--source-preset`, or any unknown flag, is an error rather than a
   silent fallback to `standard`.
3. If the generator reports a shape it does not recognize, update its anchors to
   the new shipped shape and re-run; do not hand-edit either generated
   `declaration.patch.yml`. The committed-preset tests fail if either artifact
   drifts from a fresh generation of its fixture, so a missed regeneration is
   loud rather than silent.
4. If the new host line does not route a bare package specifier through the
   installation closure (this line does: the boot's profile resolution adds every
   package in the install anchor's dependency closure), pass
   `--engine-name <specifier>` with a form that resolves from the profile
   directory, and verify with the registry test below.

On host lines that keep the older `roots` / `includeShippedRoot` /
`includeUserRoot` roster fields and the `presets/<id>/agent.cordis.yml`
directory format, this generated declaration is simply not read: the preset
does not appear, and the host boots clean with one warning (see above). Use the
host's own preset format for those lines.

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
`context-rollover` engine itself, so a profile with no preset roster (headless,
base-only) uses this engine for every session. `command-compact`, the token
meter, and the compaction invariant companions need no changes — they depend
only on `ctx.compaction`.

### Web profiles (preset sessions)

Headless and other base-only profiles are done after the install above: the
host engine *is* the session's engine, no roster exists, and nothing stands
down. The Web profile is different — its sessions compose compaction from
their **agent preset**, not from the host — so the bundle additionally ships
**two** presets beside the deployment's own set, declared the way the host
declares its own shipped presets:

- `standard-rollover` — "Standard + rollover (experimental)" in the picker,
  derived from the host's `standard`.
- `local-cordis` — "Local Cordis" in the picker, derived from the host's
  `cordis`, so it keeps Creator Mode's tools and preset-authoring skills.

A session uses exactly ONE preset, so pick `standard-rollover` or `local-cordis`
according to whether you want Creator Mode. Restart the host once after install,
then open **new** sessions on it to try the experiment; `standard` stays the
default. Pick the preset while the session is still **blank**: the creation
header is deep-frozen, and a session may only change preset before its first
turn runs, so an already-started `standard` session cannot be moved onto
rollover.

No commands, no profile edits. Two behaviors make that hold:

- The host engine **defers to any preset-owned backend**: on a `standard`
  session the shipped summarizer runs alone (previously the two backends
  raced each pressure signal); on `standard-rollover` or `local-cordis` the
  preset's rollover engine runs alone; headless sessions keep the host engine.
- Each rollover preset's engine row sets `modelSurface: 'always'`, so it is the
  only source of rollover tools and guidance in its sessions. On preset
  deployments the host row (`modelSurface: 'auto'`) registers neither, so
  `standard`, `cordis` and `minimal` sessions never see rollover-framed
  instructions.

The presets are declared by their own entries in this bundle's `dsh.bundle.patch`
array (the host's shipped-preset mechanism), not by patching the preset roster's
config. The bundle therefore leaves `default` and `selectedDefault` to the
deployment, and a deployment that restates the roster's `config` in a later
patch layer replaces that row's whole config without removing these presets.
Uninstalling the bundle removes them: sessions already on one keep running,
new ones must pick another preset.

Custom thresholds belong to your own preset copy (the supported customization
flow: copy `standard-rollover` or `local-cordis` in the picker and edit the
`context-rollover` row) — the shipped presets carry the defaults below.

Maintainers: both `presets/*/declaration.patch.yml` files are generated, not
authored — re-run `pnpm preset:sync` after host updates and commit the refresh.
That script regenerates both artifacts in one command; it is equivalent to
running the two explicit commands under
[Host version compatibility](#host-version-compatibility), and it exists because
`--preset-id` defaults to `standard-rollover`, so a bare generator run would
overwrite the standard-derived artifact with cordis-derived output.
The sync reads the byte-for-byte fixtures in `tests/fixtures/host/`, copies of
the running host's own shipped `standard` and `cordis` declarations, keeps every
other byte identical, and fails loud when either declaration's shape drifts. See
[Host version compatibility](#host-version-compatibility) for what a deployment
on a different host line must do, and why a patch that matches no row is a
silent no-op rather than an error.

### Crossing 0.90 never picks a handoff

`thresholdRatio` (0.90) marks a context that is too full to keep going. The
engine does not compact there. Only the model can write the handoff, so crossing
0.90 logs one warning per turn and waits for the model's own `new_context` call.

An earlier design rolled over at 0.90 with no model in the loop. It scanned
`handoffDir` (default `.scratch/handoff`, relative to the session working
directory) for `handoffPattern` files (default `HANDOFF-*.md`) and took the
**newest by modification time**. Handoff files in a shared folder are not tied to
a session, so that path could load another session's document into the current
context. The scan is removed.


Configuration (cordis.yml `config` on the plugin row):

```yaml
- insert:
    - id: context-rollover
      name: dsh-context-rollover
      config:
        thresholdRatio: 0.9          # warning point (fraction of window); never rolls over by itself
        reminderThresholdRatio: 0.4  # one-time /handoff-doc reminder point
        handoffOnly: true            # no tail: the handoff document replaces the surface
        retainRatio: 0.1             # recent verbatim tail when handoffOnly is false
        retainTokens: null           # absolute tail budget; overrides retainRatio
        handoffMaxChars: 20000       # max accepted handoff document size
        handoffDir: .scratch/handoff # accepted for compatibility; no engine path reads it
        handoffPattern: 'HANDOFF-*.md' # accepted for compatibility; no engine path reads it
        notesEnabled: true
        historyEnabled: true
        notesDir: null               # base dir override; default <dsh home>/notes
        modelSurface: auto           # auto (host rows) | always (preset rows)
        modelThresholds:             # optional absolute points per routed model
          'strata/qwen-strata':
            thresholdTokens: 200000        # rollover point (warning only; new_context rolls over)
            reminderThresholdTokens: 157286 # one-time reminder point; must not exceed thresholdTokens
```

`modelThresholds` is keyed by the routed model id, the `model` field of the session's request context. A model with an entry uses its two token points. Every other model keeps `thresholdRatio` and `reminderThresholdRatio`, measured against its own window. A patch row replaces its whole config, so restate every other key when you add this one.

An entry is not checked against the model's window. A `thresholdTokens` at or above the window never fires the warning before the window fills. The threshold itself never rolls over; only `new_context` and `/compact` do.

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

### Testing the shipped preset

`tests/web-preset.spec.ts` covers the shipped preset declaration, and it asserts
the observable outcome rather than the generated text:

- the generator produces the host's inline format, keeps every configuration
  flag working, and fails loud when the host declaration's anchor row, isolate
  group, or declaration identity drifts;
- this bundle's declared patch list composes over the **real host bundle tree**
  with every patch applied — a nonzero skipped-patch count fails the test, which
  is the check that catches the silent no-op described above — and every row id
  this bundle patches is asserted to exist in that tree;
- the generated declaration is **booted through the real preset registry**: the
  test composes the real `dsh-base` + `dsh-web-app` bundles plus this one over a
  temporary profile, boots them, and selects `standard-rollover` on a session.
  The assertion is that `serviceFor(agent, 'compaction')` returns *this* engine
  (`ContextRolloverEngine`, not `BasicCompactionEngine`) with the shipped
  configuration, and that the mounted composition carries this engine's row and
  no `compaction-basic` row.

That last test imports host plugins from disk, so it needs a **built** DSH: the
sibling checkout (`DSH_CHECKOUT_DIR`, what CI builds) or an installed host. It
fails loud when neither is present rather than degrading into a test that proves
nothing. It builds this package's engine from `src` into a temporary directory
first, so `pnpm test` works whether or not `pnpm build` has run.

## Scope and limits

- Under `handoffOnly` a rollover replacement contains the handoff document and
  nothing else: no notes, no narration, no older user prompts and no tail.
- The only rollovers are the model's own `new_context` call and manual `/compact`.
  Crossing `thresholdRatio` only warns, and a provider-confirmed overflow does not
  roll over: the provider error reaches the user unchanged.
- Manual `/compact` composes the deterministic notes checkpoint. The
  model-requested path never substitutes notes for the document the model named.
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
