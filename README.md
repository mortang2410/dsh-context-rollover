# dsh-context-rollover

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) bundle for
**model-driven context self-management**: the model can deliberately end one
working context window and continue in a fresh one while preserving durable
state — with **no summarization**.

```text
fresh working context = standing instructions + the durable handoff document you wrote; nothing else
(model-driven path; the automatic rollover keeps a recent tail and the notes checkpoint)
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
"summary" is the **handoff document's own bytes** on the model-driven path, the
deterministic notes checkpoint on the manual and automatic paths, and never an
LLM call. Raw session events stay persisted and the session id is unchanged;
`deriveMessages()` rebuilds automatically.

After a rollover the model-visible context is the standing system/developer
instructions plus the replacement. On the model-driven path **no recent tail, no
prior messages and no tool calls carry over** — including the `new_context` call
that requested the boundary, and including the workspace `AGENTS.md` chain, which
`dsh-agent-instructions` re-injects from disk because the surface no longer
carries it. The automatic rollover is the exception: its replacement is the notes
checkpoint and it keeps a recent tail (see [Rollover paths](#rollover-paths)).

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
  Two guards refuse a call with a normal result whose text opens with `Warning:`
  and gives the reason; the refusal is not a tool error, because the host
  prefixes every thrown error with `Error:`. A second accepted call within five
  minutes of the first is refused. A handoff document last modified more than
  five minutes ago, or dated later than now, is refused. Refused calls start no
  clock. The clock is kept in process memory and rebuilt from the
  session's durable log when that memory is gone, so a host restart does not
  clear it.
- **`get_context_remaining()`** — honest headroom: tokens left before the hard
  window and before the rollover point (with `automaticRollover` off, only the
  model's `new_context` and `/compact` roll over; with it on, the engine rolls
  over there too), or "not measured yet".
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
2. **Pressure** (reminders, then an optional automatic rollover): once measured
   usage is at or above the reminder point, the reminder tells the model, by
   default, to run `/handoff-doc` and then call `new_context`. The reminder point
   is `reminderThresholdRatio` (default 0.40) of the context window, or, for a
   model with a `modelThresholds` entry (its own, or the `'*'` fallback), that
   entry's token count. The first
   reminder in a window is delivered at the next step after usage reaches the
   point. After that, a repeat is delivered no sooner than `reminderRepeatMs`
   (default 300000, five minutes) after the previous reminder, and only while
   usage stays at or above the point. A rollover opens a new window, and that
   window's first reminder is not held back by the old one. At or above the
   rollover point (`thresholdRatio`, default 0.90 of the window, or the model's
   `modelThresholds` entry, or the `'*'` fallback entry) the engine sends a separate hard reminder once per
   turn, `rolloverReminderMessage`, unless that step already committed a
   rollover. The journal warning is the gate-off signal: one `logger.warn` per
   turn fires only while `automaticRollover` is off. The hard reminder is not
   gated on that key: the model reads it whenever usage is at or above the
   rollover point, in both gate states, and while the gate is on it is the only
   one of the two signals. With `automaticRollover` on (default
   `false`), the engine also rolls over by itself at the next `agent/pre-step`,
   whether or not the model complied. That automatic rollover commits the notes
   checkpoint, which carries the model's own handoff when the model wrote one
   into the notes tool and the notes snapshot when it did not, plus a recent tail;
   it never reads a handoff file.
   When another backend owns compaction for a session, this engine does not send
   the reminder and does not log the pressure warnings for that session.
3. **Overflow** (never a rollover): the engine does not roll over on a
   provider-confirmed `CONTEXT_WINDOW_EXCEEDED` and does not retry. The provider
   error reaches the user unchanged. The model usually cannot reach
   `new_context` after an overflow: nothing is committed, so the next request is
   at least as large and fails too. The user runs `/compact`.
4. **Manual**: `/compact` keeps working on an idle agent.

Under `handoffOnly` (what the shipped preset sets) every path except the automatic
rollover, including manual `/compact`, replaces the span from the first
non-system surface node through the **last** surface node, so no priced tail
survives unless `retainTokens` is set.
When it is set, the replacement leads the recent tail that budget selects, by the
same rule `handoffOnly: false` uses. A budget of `0` still keeps the last
node there, as it does without `handoffOnly`. `retainRatio` is never read under
`handoffOnly`; use `handoffOnly: false` for a ratio-sized tail. The automatic
rollover is the one exception to a zero tail: it always keeps the tail its own
`automaticRolloverRetainTokens` floor selects (default 10000), whatever the row's
`retainTokens` says.

The replaced span leaves nothing old behind, in every case, including a rollover
that fires while a step is mid-tool-call with no result yet. The host requires a
tool-pairing balanced cut, so a pre-step whose tail cut is unbalanced does not
roll over at all: it defers, the host appends the missing `tool/result` (a
skipped or aborted call gets a synthetic one), and the **next** pre-step crosses
with the whole prior surface inside the span. A deferred pre-step is logged at
info level, not as a failure, and it leaves the model's request pending so the
rollover is retried rather than lost.

Manual `/compact` has no model in the loop and therefore no document to name;
it composes the deterministic notes checkpoint.
No engine path reads a handoff directory: `handoffDir` and `handoffPattern` are
accepted configuration keys that nothing reads.

### Idle rollover watchdog

The watchdog rolls over a session that nobody is using, so the next request
after you return does not resend its whole context. It runs only in the live
host, once a minute by default. It sends one message into a session when all of
these hold: the session has been idle for at least 40 minutes (the threshold is
inclusive), its measured context is more than 90,000 tokens (strictly above, so
exactly 90,000 does not fire), and its context is still below its own rollover
point. The idle clock restarts on any event in the session, including a tool
result or a queued message. The watchdog also waits while the session's agent is
running or holds queued work, skips subagent sessions, and sends only where
`new_context` and the rollover skill are available to that session.

On this bundle the message is exactly `/rollover`, with no marker and no other
text. The harness injects a skill body only into a direct user message whose
`/name` gesture names a registered, user-invocable skill, and `/rollover` is the
gesture for the rollover skill. The model therefore reads the same instructions
it reads when you type the command: it writes a handoff document and calls
`new_context` itself. The watchdog writes no handoff and commits no rollover.

Each committed rollover opens a new stretch, and each stretch allows one
watchdog message in its session. Once a `/rollover` message sits in the session
log after the newest committed rollover, the watchdog stays quiet for that
session until the next committed rollover. A message that was queued but never
ran still counts. Two cases allow a second message in the same stretch; both are
listed under Accepted residuals below.

One fire costs one full-context turn for that session and, when the model follows
the skill, leaves one handoff document in the session's working directory.

The engine runs one timer per host, however many rollover presets or host rows
are mounted, and preset rows never start it. This bundle ships the watchdog
enabled on its host row (`cordis.patch.yml`, with the values above). The
engine's own default is off, so a deployment that uses the engine without that
row stays inert until it sets `idleRollover: true`. A deployment that restates
this row's config without that key turns the watchdog off.

Accepted residuals:

- A `/rollover` that you type by hand is indistinguishable from the watchdog's
  message, so it uses up the attempt for its stretch. If it does not roll the
  session over, the watchdog stays quiet until the next committed rollover.
- Changing `idleRolloverMessage` between restarts means earlier messages no
  longer match the configured text. They stop counting toward the stretch's one
  attempt, so one further message can be sent in that stretch.
- A message whose send fails before it is recorded is not retried until the host
  restarts. After a restart, that session can receive one message in that stretch.
- If the host unloads the instance that owns the timer without loading a
  successor, the watchdog stays off until the next host start. Reloading the
  plugin in place releases the slot, and the replacement claims it.
- A session idle at or above its own rollover point gets no message. It keeps
  its large context until its next turn.
- Each message resets the auto-continue plugin's consecutive-recovery counter,
  because that plugin counts any user message it did not send as human
  intervention. One message therefore grants that plugin one fresh recovery
  burst of up to three continuations.

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

### Crossing the rollover point picks no handoff

`thresholdRatio` (0.90) marks a context that is too full to keep going. With
`automaticRollover` off (the default), the engine does not compact there: only
the model can write the handoff, so crossing the point sends the hard per-turn
reminder, logs one warning per turn, and waits for the model's own `new_context`
call. With `automaticRollover` on, the engine commits a rollover at the next
pre-step whether or not the model complied. That rollover carries the
deterministic notes checkpoint, which holds the model's own handoff when the
model wrote one into the notes tool and the notes snapshot when it did not, plus
a recent tail floored by `automaticRolloverRetainTokens` (default 10000, so the
automatic path keeps a tail even on a row with `retainTokens: 0`).

An earlier design rolled over at 0.90 with no model in the loop. It scanned
`handoffDir` (default `.scratch/handoff`, relative to the session working
directory) for `handoffPattern` files (default `HANDOFF-*.md`) and took the
**newest by modification time**. Handoff files in a shared folder are not tied to
a session, so that path could load another session's document into the current
context. No engine path reads a handoff file today: the automatic rollover
commits the notes checkpoint instead.


Configuration (cordis.yml `config` on the plugin row):

```yaml
- insert:
    - id: context-rollover
      name: dsh-context-rollover
      config:
        thresholdRatio: 0.9          # rollover point (fraction of window); the engine rolls over here only with automaticRollover on
        reminderThresholdRatio: 0.4  # /handoff-doc reminder point, repeated no sooner than reminderRepeatMs apart
        automaticRollover: false     # true: the engine rolls over at the rollover point whether or not the model complied
        automaticRolloverRetainTokens: 10000 # recent-tail floor the automatic rollover always keeps, even with retainTokens 0
        reminderRepeatMs: 300000     # minimum gap between cadence reminders, in milliseconds
        # rolloverReminderMessage: hard reminder delivered to the model once per turn at or above the rollover
        # point. The shipped default is the full order text; set it to restate the wording.
        handoffOnly: true            # the handoff document replaces the surface
        # retainTokens (recent verbatim tail) is read under handoffOnly too; without it no tail
        # is kept. retainRatio is read only when handoffOnly is false: with handoffOnly true the
        # generator refuses it and the engine warns when constructed.
        handoffMaxChars: 20000       # max accepted handoff document size
        handoffDir: .scratch/handoff # accepted for compatibility; no engine path reads it
        handoffPattern: 'HANDOFF-*.md' # accepted for compatibility; no engine path reads it
        notesEnabled: true
        historyEnabled: true
        notesDir: null               # base dir override; default <dsh home>/notes
        modelSurface: auto           # auto (host rows) | always (preset rows)
        modelThresholds:             # optional absolute points per routed model
          'strata/qwen-strata':
            thresholdTokens: 200000        # rollover point; the engine rolls over here only with automaticRollover on
            reminderThresholdTokens: 157286 # reminder point, repeated no sooner than reminderRepeatMs apart; must not exceed thresholdTokens
          '*':                             # fallback for every model with no entry of its own
            thresholdTokens: 350000
            reminderThresholdTokens: 300000
```

`modelThresholds` is keyed by the routed model id, the `model` field of the session's request context. A model with an entry uses its two token points. The key `'*'` supplies the two points for every model that has no entry of its own; a model-specific key always wins over it. A model left out of both the `'*'` entry and any specific entry keeps `thresholdRatio` and `reminderThresholdRatio`, measured against its own window. A patch row replaces its whole config, so restate every other key when you add this one.

An entry is not checked against the model's window. A `thresholdTokens` at or above the window never fires the rollover before the window fills. With `automaticRollover` off (the default), only `new_context` and `/compact` roll over; with it on, the engine also rolls over at the entry's `thresholdTokens`.

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

- Under `handoffOnly` with no `retainTokens`, a model-driven rollover replacement
  contains the handoff document and nothing else: no notes, no narration, no older
  user prompts and no tail. With `retainTokens`, the recent tail that budget
  selects follows it. The automatic rollover is the exception: it composes the
  notes checkpoint and always keeps its `automaticRolloverRetainTokens` tail
  (default 10000).
- With `automaticRollover` off (the default), the only rollovers are the model's
  own `new_context` call and manual `/compact`; with it on, the engine also rolls
  over at the rollover point, committing the notes checkpoint plus a recent tail.
  Crossing the rollover point never picks a handoff file, and a provider-confirmed
  overflow does not roll over: the provider error reaches the user unchanged.
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
