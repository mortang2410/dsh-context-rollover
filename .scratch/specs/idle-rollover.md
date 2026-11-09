# Spec: idle rollover that survives a restart, covers closed sessions, and never refuses a candidate above the floor

## Problem Statement

The idle rollover watchdog has three holes in the way it selects sessions. Each one costs the user a rollover, by which I mean the `/rollover` message never reaches the session and the watchdog never wakes it.

A candidate is one record in the candidate file: a session this feature may fire, with its last real activity time and its measured size. The floor is the idle-rollover token minimum of 90,000 tokens, and a session becomes a candidate only when it measures strictly above the floor. A fire is one `/rollover` message the watchdog sent, which the host journal records as the line `context rollover (idle watchdog): sent /rollover to session <id>`. An epoch is the interval from one committed rollover to the next. The epoch is the unit of the once-only guarantee: one fire per epoch.

Two more terms carry the rest of this spec. The forced-commit point, also called the rollover point, is the token point at which the engine compacts the session on its own. `rolloverPointsFor` in `src/config.ts:519-537` resolves it in three steps. It takes the `modelThresholds` entry for the routed model when that entry exists, else the `*` entry, and either entry supplies `thresholdTokens` and `reminderThresholdTokens` as absolute numbers. With neither entry it multiplies the model's context window by `thresholdRatio` and by `reminderThresholdRatio`, and rounds each product down with `Math.floor`. A pre-step is the work the engine does before it calls the model for its next request. When `automaticRollover` is true and the measured size reaches the rollover point, the engine commits a rollover in that pre-step (`src/index.ts:283-323`). `automaticRollover` defaults to false, and the `web` agent preset sets it true at `/home/wilder/.dsh/profiles/web/cordis.patch.yml:678`.

Every `src/` path in this spec is relative to the plugin repository at `/home/wilder/git-repos/dsh-context-handoff`. Every path that starts with a package directory name, such as `dsh-session/lib/index.js`, is relative to the installed host's package directory at `/home/wilder/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai`. `ctx` in this spec is the plugin's host context, the object a Cordis plugin receives for the services it composes. It is not the separate `ctx` command line tool that searches local session history.

The first hole is that the watchdog only looks at the host's in-memory table of open agents, which it reaches through `ctx.agents`. A session whose tab was closed is not in that table, so the watchdog never sees it and never wakes it. With no active turn there is no step for the engine to run, so the watchdog never sends the message and the engine never compacts. The case this spec exists for, a session nobody is using, is the one case the current watchdog structurally cannot reach.

The second hole is that reopening a session resets the idle clock. When the host loads a stored session it appends a `session/end-seed` marker stamped at load time, and a resume appends the interrupted turn's closing events immediately before that marker, also stamped at load time. The watchdog measures idle time as the distance from now to the newest line in the log, so an untouched session reads as freshly active the instant it is opened and the 40 minutes start over. Three fires show that the idle clock ran from the load marker alone. The figures below were measured on the machine that serves this profile, from two records: the journal line, which prints whole seconds, and the session's own log, where an event carries its own millisecond time. The journal query is `journalctl --user -u dsh-web --since "2026-11-06 00:00" | grep "idle watchdog"`, and the session logs are under `/home/wilder/.dsh/sessions/--home-wilder-.dsh--/`, one `session.v4.jsonl.zstd` per session directory. All times below are +07:00.

| Session log | Last `session/end-seed` | Next logged event, the `/rollover` splice | Gap |
| --- | --- | --- | --- |
| `session-a19dfbe9-3c1b-4b62-8d47-572bd0c53bcb` | seq 485, 2026-11-06T21:32:35.606 | seq 486, 2026-11-06T22:13:16.597 | 2,441.0 s |
| `session-c0f83ab9-389b-4f02-8c76-477fa72c0e94` | seq 1262, 2026-11-07T00:40:42.923 | seq 1263, 2026-11-07T01:21:19.410 | 2,436.5 s |
| `session-d1c1f3c3-79a6-467c-8c14-3d547e0757ca` | seq 3717, 2026-11-06T23:35:59.693 | seq 3718, 2026-11-07T00:16:17.157 | 2,417.5 s |

The fire event is the `agent/inbox/spliced` that carries the configured message, logged when the message is queued, so the gap is the message's own arrival time minus the load time. The journal prints 22:13:16, 01:21:19, and 00:16:17 for those three sends, which is each fire event truncated to the second. Because the splice is the very next event after each marker, nothing was logged between the load and the fire, so the idle clock in each case ran from the marker alone.

The third hole is a deliberate refusal that is now wrong. The watchdog stands down when the session is at or above its own rollover point, on the reasoning that the automatic rollover would commit at the next pre-step and shadow the context before the model could write a handoff. In practice the largest, stalest sessions, the ones the engine is about to compact on its own, are the only ones never asked to write a handoff first.

## Solution

The feature is a durable candidate file plus a sweep whose decision reads that file.

Every session that a pre-step or a sweep measures strictly above the floor is recorded by the candidate store in a file that survives a restart. The record holds the session id, the time of its last real activity, its measured size, and its committed rollover count. The store removes the record when the context falls to or below the floor, when a rollover commits after the record was written, or when the session no longer exists.

Every minute the sweep walks that file rather than the table of open agents. The sweep passes a candidate idle for 40 minutes to `decideIdleFire`, the pure decision in `src/idle.ts`. When every gate passes, the watchdog sends the configured `/rollover` message. If an agent for the session is open, the watchdog sends through that agent and reopens nothing. If no agent is open, the sweep reopens the session, checks the gates again against the live session, sends the message through the reopened agent, waits for the turn to end, and disposes the agent.

The size gate is removed: a candidate is never refused for its size above the floor. The other gates stay, because each one protects a case the user named. The watchdog still sends the configured message to a session taken at or above its rollover point. The automatic commit is untouched: the watchdog neither suppresses it nor defers it.

A session with no next turn is not compacted by this feature, because the engine only commits in a pre-step. The watchdog's message wakes the session, and the reopened session's own pre-step commits when its turn runs.

The epoch reader measures idle time from the newest real activity in the log, with the lines the host writes when it loads a session excluded. Loading or reopening a session therefore cannot restart the 40 minutes. The activity time recorded in the candidate file carries the same clock across a restart, which is why a session that was idle for 30 minutes before a host restart is still 30 minutes idle after it.

An epoch runs from the newest committed rollover to the next committed rollover. Two logged shapes spend an epoch, and `armedFromLog` reads both from the log so a marker survives a restart. The first is a `user/message` whose `source.kind` is `user` and whose content is exactly one text block equal to the configured message. The second is an `agent/inbox/spliced` event whose `inserted` list holds such a message. The host writes the splice when `agent.followup` queues the message, before any step admits it, and the splice stays in the log after the message is withdrawn, so a fire that was queued and then removed still spends its epoch. Nothing else is a marker: a message from a plugin notice, and a message carrying any other content, does not spend the epoch. `isWatchdogMessage` and `armedFromLog` at `src/epoch.ts:69-101` read the two shapes, and `committedRollovers` at `src/epoch.ts:38-67` counts commits.

## User Stories

1. As the operator, I want a session that was above the floor to be remembered in a file after the host restarts, so that a restart does not lose track of it.
2. As the operator, I want the remembered candidate to be re-examined at the 40 minute mark, so that closing the tab does not stop the idle rollover.
3. As the operator, I want every candidate that passes the gates to be eligible, whatever its size, so that the largest sessions are not the ones skipped.
4. As the operator, I want the `/rollover` message to be sent at or above the session's rollover point, so that the model is asked for a handoff even when the automatic commit is about to happen.
5. As the operator, I want the automatic commit to keep happening on its own with no hold-off, so that a session which keeps running cannot drift above the forced-commit point, and a session that has gone quiet is woken by the message so its own commit can run.
6. As the operator, I want the floor to stay at 90,000 tokens and the nagging reminder to stay where it is, so that the two thresholds never get conflated.
7. As the operator, I want the idle clock measured from real activity rather than from the newest log line, so that loading a session cannot reset the 40 minutes.
8. As the operator, I want a session that was idle for 39 minutes before a restart to be woken a minute after the restart, so that a restart costs me nothing but the reload time.
9. As the operator, I want a candidate that falls back below the floor to be removed from the candidate file, so that small sessions are never reopened for nothing.
10. As the operator, I want a candidate that has just rolled over to be removed from the candidate file, so that a rolled-over session is not reopened 40 minutes later to be told to roll over again.
11. As the operator, I want a session whose tab is closed to be reopened only long enough to receive the message and finish its turn, so that the host does not accumulate loaded agents.
12. As the operator, I want the reopened session to use the agent preset stored on it, the named composition the host mounts for a session, and the default model, so that it behaves the way it did when the user was using it, and never under a guessed preset.
13. As the operator, I want a candidate that cannot be reopened to be logged once per session and retried on a later sweep, so that one broken session does not stop the others or spam the log.
14. As the operator, I want the watchdog to skip subagent sessions, the sessions a tool spawns to do work inside another session, so that a worker's transient context is never woken as if it were a person's session.
15. As the operator, I want a session with queued work or a running turn to be skipped, so that the message never lands in the middle of something the user is doing.
16. As the operator, I want the message sent at most once per epoch, so that a session that has already been asked is not asked again until it rolls over.
17. As the operator, I want the candidate file read without crashing the host when it is missing or corrupt, so that a bad file is a warning and not an outage.
18. As a maintainer, I want the decision that fires a session to stay a pure function over measured values, so that every gate stays testable without a timer.
19. As a maintainer, I want the reopen path exercised end to end through the host's resume call in a test, so that the riskiest call in the feature is not shipped on faith.
20. As a maintainer, I want the restart case covered by a test that disposes the engine and mounts a new one over the same file, so that "restarts do not affect idle rollovers" is evidence and not a claim.

## Implementation Decisions

**Candidate store.** A new module `src/candidates.ts` owns the file. One record holds five fields:

- `sessionId`: the host session id string.
- `lastRealActivityAt`: a millisecond epoch number from the log-derived activity reader, or `null` when the log holds load artifacts only.
- `totalTokens`: a non-negative integer from `ctx.tokenMeter.measure(session).totalTokens`.
- `committedRolloverCount`: a non-negative integer from `committedRollovers(session).count` in `src/epoch.ts`.
- `lastOutcome`: one of `marked`, `blocked`, `sent`, `reopen-failed`.

The file holds an array of records under a top-level `entries` key. A record is valid only when all five fields are present, `sessionId` is a non-empty string, `lastRealActivityAt` is `null` or a finite number, `totalTokens` and `committedRolloverCount` are non-negative integers, and `lastOutcome` is one of the four strings. One invalid record, a non-object value, or unreadable JSON makes the whole file invalid: the store loads an empty set and logs exactly one warning through `ctx.logger.warn`, with the fixed prefix `context rollover (candidates): the candidate file is unreadable` followed by the path and the parse or shape error. A warning is deduplicated per absolute path for the lifetime of the host process, so a file that stays corrupt warns once, not once per sweep. A missing file is an empty set with no warning. The path comes from a new optional config key, `idleRolloverCandidatesPath`, and its default is `~/.dsh/idle-rollover-candidates.json`, which on this host resolves to `/home/wilder/.dsh/idle-rollover-candidates.json`. The store writes atomically: it writes the full document to `<path>.tmp` in the same directory, flushes that file, then renames it over `<path>`, so a crash before the rename leaves the previous file intact. Tests point the key at a temporary directory.

**Marking.** The store is fed from two places, because either alone has a hole. Every engine pre-step that measures tokens above the floor upserts the session, which catches the turn that pushed it over. Every sweep also upserts each live session it measures above the floor and refreshes the recorded activity time. The store records the log-derived last activity time, never the wall clock at write, and the `committedRolloverCount` it reads at that same moment from the live session.

The marking pass and the automatic commit may run in either order inside one pre-step, and the result converges either way. If the engine commits first, the session's tokens fall below the floor and the marking pass stores nothing. If the marking pass stores first, the count it recorded is the pre-commit count, and the next observation sees the grown count and removes the record. That removal observation is the next pre-step on that session, the next sweep, or the reopen's own post-resume check. No listener order is required, and no record can survive a rollover that committed after it was written.

Only top-level sessions are candidates. The store never marks a session whose header has `origin === 'subagent'` or whose `delegationDepth` is above zero, and the watchdog never reopens it, because there is no person behind it to answer the message.

**Removal.** The store removes a record on the next observation that measures tokens at or below the floor, or that sees the committed rollover count grow past the recorded count. A live session is observed by the sweep, by every pre-step, and by the reopen's post-resume check. A closed session is observed by the reopen itself. A reopen whose error is one of the host's two not-found signals removes the record, and a reopen that fails for any other reason keeps it for a later sweep. The predicate matches the session query service's error by `code` and the controller's error by `name`, because the plugin does not import the controller package: the error's `name` is `ApiSessionNotFound`, or the error is an object whose `code` is the string `SESSION_QUERY_SESSION_NOT_FOUND`. The query error is built by `notFound` at `dsh-session-query/lib/index.js:311` and reaches the caller through `ctx.sessionQuery.observeSession` at `:1062`, which delegates to the observation reader at `:348`. The controller rethrows the same error as `ApiSessionNotFound` at `dsh-api-session-controller/lib/index.js:173` and `:395`.

**Idle clock.** A pure function in `src/epoch.ts` returns the time of the newest log event that is not part of the load-artifact suffix. Every event outside that suffix counts as real activity, whatever its type: a model message, a tool call, a tool result, a compaction event, and an inbox splice alike. The suffix is a trailing `session/end-seed` marker, whose data is `{}` for an ordinary session and `{ inherited: true }` for an inherited seed, plus the interrupted-turn closers the resume path appends immediately before it: zero or more `tool/result` events, an optional `step/end`, and a `turn/end` whose reason is `interrupted`. A log that holds only load artifacts has no activity time, and the reader returns `null`.

**Epoch.** `committedRollovers` counts a rollover only when three events share one compaction id: a `compaction/start`, a `compaction/summary` whose `provider` is `ROLLOVER_PROVIDER`, the string `dsh-context-rollover` (`src/rollover.ts:64-65`), and a `compaction/end` whose `error` is undefined. Each id counts once, and `newestEndSeq` is the sequence of the last qualifying end. The initial state is armed: a session with no committed rollover, including an empty log, has no end to disarm it. A commit re-arms the session, because `armedFromLog` skips every event at or before `newestEndSeq` and looks for a marker after it. The two marker shapes are exactly these, with the configured message `/rollover`:

- Accepted: `{ "type": "user/message", "data": { "source": { "kind": "user" }, "content": [{ "type": "text", "text": "/rollover" }] } }`.
- Accepted: `{ "type": "agent/inbox/spliced", "data": { "inserted": [{ "source": { "kind": "user" }, "content": [{ "type": "text", "text": "/rollover" }] }] } }`.
- Rejected: `{ "type": "user/message", "data": { "source": { "kind": "plugin" }, "content": [{ "type": "text", "text": "/rollover" }] } }`.
- Rejected: `{ "type": "user/message", "data": { "source": { "kind": "user" }, "content": [{ "type": "text", "text": "/rollover please" }] } }`.

**One fire path.** The candidate file is the only source of candidates: the sweep reads it and no other walk supplies one. Whether a candidate fires is decided only by `decideIdleFire` in `src/idle.ts:94`, whose inputs are these, and each gate is true only when its condition holds:

- `enabled`: the plugin config has `idleRollover: true`.
- `status`: the agent's status is `idle`.
- `queuedWork`: false exactly when both `agent.inbox.nextTurn` and `agent.inbox.nextStep` are empty, and true when either holds an item (`src/watchdog.ts:128`).
- `idleMs`: `Date.now()` minus the candidate's activity time, and it must be at least `idleRolloverAfterMs`, which is 2,400,000 ms.
- `baselineKnown`: the token measurement exists and `measurement.baseline.kind` is not `'none'`.
- `totalTokens`: the measured total, which must be strictly above `idleRolloverTokens`, 90,000.
- `foreignBackendOwnsCompaction`: false. The check reads `rosterOf(ctx)`, calls `roster.serviceFor(agent, 'compaction')`, and is true only when a service is returned and it is not a rollover engine (`src/index.ts:710-730`). With no roster the gate is false.
- `newContextAvailable`: `ctx.tools.get('new_context', agent)` returns a value. The tool is the one the fired turn uses to write its handoff and start a fresh context, and this gate only checks that the agent can reach it.
- `skillAvailable`: the skills service resolves a user-invocable skill whose name matches a gesture in the configured message. `slashGestureNames` (`src/idle.ts:60-71`) maps each `/name` to `name`, so `/rollover` looks for a skill named `rollover`. The lookup is `ctx.get('skills').list({ cwd: agent.session.header.cwd, scope: agent })`, where `cwd` is the session's working directory, and a matching entry has `invocation.userInvocable === true`. With no skills service mounted the watchdog's skill check returns false and the watchdog logs one info line saying so.
- `rolloverPending`: false. The check is the serving engine's `hasPendingRollover(session.id)`.
- `epochArmed`: `armedFromLog(session, config.idleRolloverMessage)` returns true.

`decideIdleFire` declines a candidate whose activity time is `null`. It stays marked and silent until a real event supplies an activity time, because its idle duration is unknown rather than zero.

For a candidate whose agent is open, the existing send in `fire(agent)` at `src/watchdog.ts:176` applies unchanged: it builds one user message with source kind `user` and one text block equal to the configured message, passes it to `agent.followup`, and reports the journal line on success.

**Reopen.** With no agent open, the sweep looks the session up with `ctx.agents.get(sessionId)` and `ctx.sessions.get(sessionId)`. The order is fixed:

1. If `ctx.agents.get(sessionId)` returns an agent, send through it and reopen nothing.
2. Else if `ctx.sessions.get(sessionId)` returns the loaded session (`dsh-session/lib/index.js:1856-1863`), skip this pass and retain the record. Every later sweep repeats both lookups, and a session that gains an agent is fired by step 1.
3. Only when both return nothing does the sweep resume the session.

**Resume composition.** The reopen composes the resume the way the host session controller does, and it refuses to guess. It reads the stored preset identifier from `ctx.sessionQuery.observeSession(sessionId)` at `.projections.values.agentPreset`, which is `undefined` when the projection holds no value. The read goes through `ctx.sessionQuery`, which is the host's session query service. For a session that is not loaded, `SessionObservationReader.read` calls `stat(sessionId)`, reports not-found when it returns `undefined`, then opens a read handle, reads the whole log, and prepares a Session (`dsh-session-query/lib/index.js:329-418`). The reopen then gets the registry with `ctx.get('agentPresets')`, the host's agent preset registry, and resolves the identifier with `registry.resolve(presetId)`. That call returns the resolved id, using the registry's configured default when the identifier is `undefined`, and it rejects with an error whose `code` is `agent-preset/not-found` for an unknown identifier. A preset that loads but fails its own diagnostic comes back with a `broken` string; the reopen mounts it anyway and the registry logs the diagnostic, which is what the host's own composition does (`dsh-api-session-controller/lib/index.js:358-370`). The reopen passes `{ resumeSessionId, agentOptions, setup }` to `ctx.agents.resume`, which returns an agent handle `{ agent, dispose }` and rejects on failure.

`agentOptions` is the host's per-agent options object, and this reopen carries the default model in it: `provider` and `model` from `ctx.agentDefaultModel.currentSelection()`, the same two fields the host's own `agentOptions()` builds (`dsh-api-session-controller/lib/index.js:460-466`). The `setup(agentCtx, agent)` callback mounts the resolved preset with `registry.mount(agentCtx, resolvedId)` and installs no model selection of its own, because the host's per-agent selection cache is private to the session controller (`dsh-api-session-controller/lib/index.js:281-321`) and `agentOptions` is the public way to carry the model into a resume.

The combinations are fixed:

- Registry mounted, identifier present and resolvable: mount that preset.
- Registry mounted, identifier `undefined`: `resolve(undefined)` returns the configured default and that preset is mounted.
- Registry mounted, identifier present and unresolvable: failed reopen. One warning names the identifier and the error, the record stays, and no other preset is substituted.
- No registry mounted: no preset is mounted, `agentOptions` still carries the model, and the reopen logs one warning saying the session is resumed without its preset.
- No session query service, or no default model selection service: the turn cannot be composed. The reopen skips the session, logs one warning, and keeps the record.

**Post-resume decision.** After `ctx.agents.resume` returns, the sweep measures the live session and decides again before sending, so fitness is checked on real measurements rather than a stored snapshot. The idle duration comes from the record, `Date.now() - lastRealActivityAt`, because the resumed log's newest events are the load artifacts just written. The token count and the route come from the live session, `ctx.tokenMeter.measure(handle.agent.session)` and `routeOf(handle.agent.session)`. The route is the session's request context (`src/index.ts:214`), its `model` and `contextWindow` are inputs to the decision, and a session with no route, or a route without `contextWindow`, yields no decision inputs and is not fired (`src/watchdog.ts:126-127`). All gates in the fire path are evaluated with those inputs and that agent. A refusal disposes the handle, keeps the record with `lastOutcome` `blocked`, and logs one info line naming the gate that refused.

**Turn completion.** When the decision passes, the reopen calls `handle.agent.followup(message)`. That call returns nothing and queues the message; a throw is a failed reopen. After a successful queue, the detached task awaits `handle.agent.whenIdle()` with a bound of 10 minutes. The three failure modes are distinct:

- `followup` throws synchronously: the reopen logs one warning, the record keeps `lastOutcome` `reopen-failed`, and `finally` disposes the handle.
- `whenIdle()` rejects: the reopen logs one warning, the record keeps `lastOutcome` `reopen-failed`, and `finally` disposes the handle.
- `whenIdle()` does not settle within 10 minutes: the reopen logs one warning, the record keeps `lastOutcome` `reopen-failed`, and `finally` disposes the handle.

On idle the reopen refreshes the record from the live session: the log-derived activity time, the measured tokens, and the committed count. It removes the record when the count grew or the tokens are at or below the floor, and otherwise stores the refreshed values with `lastOutcome` `sent`. `handle.dispose()` runs in a `finally` block on every path after the handle exists, so a path that never got a handle, because `ctx.agents.resume` rejected, disposes nothing. The watchdog logs one failed reopen per session per host process: the deduplication key is the session id, and the set resets when the host process restarts.

**Serialization.** The sweep never awaits a whole turn. Starting a reopen is awaited only as far as `ctx.agents.resume` returning; the reopen runs the wait for the turn and the disposal in a detached task, guarded by a set of the session ids currently being reopened, so a second sweep cannot open the same session twice. The detached task removes its id from that set in the same `finally` block that disposes the agent.

**Gate removal.** The implementer deletes the at-or-above-rollover-point gate from `decideIdleFire`, along with the input field that fed it, and the decision's comment stops claiming the watchdog stands down there. Everything else in the decision is untouched.

**Config.** One new optional key, `idleRolloverCandidatesPath`, names the candidate file. Nothing else about the idle configuration changes: the floor, the 40 minute threshold, the sweep interval, and the message keep their current values. Those values are `idleRolloverTokens: 90000`, `idleRolloverAfterMs: 2400000`, `idleRolloverTickMs: 60000`, and `idleRolloverMessage: /rollover` at `/home/wilder/git-repos/dsh-context-handoff/cordis.patch.yml:43-47`.

**Doc comments.** The module header of the watchdog and the doc comment of the decision describe the file-driven sweep and the reopen, and stop describing the walk over open agents as the source of fires.

## Testing Decisions

Good tests here assert behavior at the seams the plugin already has: the plugin's own engine mounted on a test `Context`, the host's agent loop and token meter mounted beside it, and a temporary directory. `tests/harness.ts:213-227` builds that `Context` and mounts the agent loop and token meter, `tests/harness.ts:370-392` mounts the real rollover engine, and `ScriptedAdapter` and the in-memory persistence service stand in for the model provider and the JSON Lines backend. The model in those tests is `ScriptedAdapter`, the request-recording test adapter in `tests/harness.ts`, which stores every request it receives in `recorded`. The test runner is Vitest, invoked through `npx vitest run <file>`.

The idle clock and the candidate store are pure enough to test directly: log shapes in, times and file contents out. The cases include a log that ends in the load artifacts, a log with activity after the load marker, a log that is load artifacts only, an empty file, and a corrupt file.

The reopen test runs end to end through the host's own resume call, `ctx.agents.resume`, with an in-memory test persistence service standing in for the JSON Lines backend. The JSON Lines backend is the published host package `@deepseek-ai/dsh-session-persistence-jsonl`, which stores one JSON event per line of a session file. The test service extends `SessionPersistence`, the host's abstract session storage service, and implements its five abstract members:

- `create(header, options?)` stores the header under `header.id` and returns a write handle.
- `open(id, access, options?)` returns a handle for access `read` or `write`, and rejects for an unknown id.
- `flush()` drains every write handle this service instance owns.
- `stat(id, options?)` returns `{ header, revision }` for a stored session and `undefined` for an unknown id.
- `list(options?)` returns one `{ header, revision }` per stored session.

Each optional `options` argument accepts `{ signal }`, an `AbortSignal` for cancellation. The handle exposes `id`, `header`, `inheritedEventCount`, `access`, and these members:

- `read(offset?, length?, options?)` returns `{ eventState, events }`, with every event from `offset` when `length` is omitted.
- `append(events, options?)` accepts the next contiguous sequence on a write handle.
- `flush(options?)` is the handle's own durability barrier, a separate member that shares its name with the service-level `flush()`.
- `close()` releases the handle.

The test service returns `eventState: 'detached'`, the value for events a storage backend owns independently, because it hands back independent copies. The other accepted value is `shared-frozen`, for values already frozen in place. The read result needs `eventState` because the host type declares it and the query layer passes it to `ctx.sessions.prepare`, which restores those two values, falls through to `Session.create` when the value is `undefined`, and throws `unreachable variant in SessionStore.prepare event state` only for an unknown non-undefined value (`dsh-session/lib/index.js:1688-1694`). The service must also preserve `inheritedEventCount`, the exact length of the event-log prefix inherited by a forked session, and report zero for a session that was not forked.

The reopen exercises more than `create(header)` and `open(id, 'write')`. The preset lookup runs through `ctx.sessionQuery.observeSession`, and for a session that is not loaded that engine calls `stat(id)`, reports the session missing when it returns `undefined`, then opens a read handle with `open(id, 'read')` and reads the whole log before it projects the stored preset. A stub that answered `undefined` from `stat`, or that refused a read handle, would end the reopen as a not-found removal or a failed reopen instead of sending the message. The preset lookup never calls `list()`, because it names a session id and never enumerates. The test calls the handle's `flush()` after creating the session and before it disposes the agent, so the stored session is durable when the resume opens it. It then unloads the session, advances the clock past the threshold, and asserts that the sweep reopened it, that the `ScriptedAdapter.recorded` entry whose `messages` carry the configured message contains the `/rollover` text, and that the agent is disposed afterwards.

What that test proves is this plugin's own composition, decision, send, and disposal. The raw `ctx.agents.resume` call is proven separately by Probe A, recorded under Further Notes. Neither proves the other half, because Probe A starts no turn, so the chain is closed live in ticket `g515`: after the code is installed and the host restarted, a candidate entry written with an activity time 41 minutes in the past must produce a reopen line in the host journal and the configured message in that session's log within one sweep. "Within one sweep" means before the end of the first watchdog cycle whose start follows that write, and the journal line and the session-log message must both appear in that cycle.

That Vitest run cannot mount the real backend. Vitest runs from `/home/wilder/git-repos/dsh-context-handoff`, and there `@deepseek-ai/dsh-session-persistence-jsonl@0.2.0-rc.2` resolves to the `deepseek-harness` checkout at `/home/wilder/git-repos/deepseek-harness`. That checkout has no built native file-lock binding, so loading the backend fails.

The fire test asserts the message where the model sees it: it selects the `ScriptedAdapter.recorded` entry whose `messages` carry the configured message, asserts on that entry, and keeps the durable `user/message` assertion as a second check, so a logged message that never reaches a request cannot pass.

The suite tests the automatic commit with `automaticRollover: true`, its value in the `web` agent preset, by asserting that the compaction commits at the pre-step of the fired turn and that the message still reaches the model.

The composed-bundle test `tests/web-preset.spec.ts` keeps the two thresholds apart: the generated `context-rollover` row keeps `idleRolloverTokens: 90000`, and the profile row `context-rollover` at `/home/wilder/.dsh/profiles/web/cordis.patch.yml:675-680` keeps `reminderThresholdTokens: 300000` and `thresholdTokens: 350000` at lines 722-723. The generated row is produced by `scripts/make-web-preset.mjs`, which `package.json` names in the `preset:sync` script. Both files exist at HEAD `47806ca`.

The suite tests the restart case by disposing the engine's context and mounting a new engine over the same candidate file, then advancing the clock and asserting the fire still happens.

The suite gives each removal rule a test that fails only when that rule is missing, and pairs each silence test with a control in which the same session fires once the blocking condition is lifted. The existing cases these build on are in `tests/idle-watchdog.spec.ts`.

Mutation checks name the test that must fail. Omitting the load-artifact exclusion must fail `ignores load artifacts when finding activity time` in `tests/epoch.spec.ts`. Deleting below-floor removal must fail `removes candidate at the idle floor` in `tests/candidates.spec.ts`. Deleting rollover-count removal must fail `removes candidate after a committed rollover` in `tests/candidates.spec.ts`. Restoring the rollover-point gate must fail `fires at and above rollover point` in `tests/idle-decision.spec.ts`. The implementer records each mutation, its command, and the failing test as a comment on ticket `g515`.

## Out of Scope

No change to the reminder thresholds or the 300,000 nagging point. No wall-clock forced compaction: the engine commits only inside a pre-step, so this feature does not promise a commit for a session that runs no turn; such a session gets the message. No new UI, no new HTTP endpoint, no cross-host coordination, no changes to how sessions are stored. No change to the `/rollover` skill the user invokes, to the Markdown handoff document the model writes, or to the session log format.

## Further Notes

A successful fire costs one reopen per candidate per epoch at most, and only for candidates whose tab is closed. The reopened session is the actor that rolls over: it complies with the message, and its own pre-step commits when `automaticRollover` is enabled. On the next observation the store removes the record, because the committed rollover count grew past the recorded count or the measured tokens fell to the floor, so it costs one reopen in total. The watchdog may retry a failed reopen on later sweeps, so the once-per-epoch bound applies to fires, not to failed attempts.

The riskiest part is `ctx.agents.resume`. Probe A is a direct call to it from a plain plugin context, against the published `@deepseek-ai/dsh-session-persistence-jsonl@0.2.0-rc.2`, run from `/home/wilder/git-repos/dsh-context-handoff`. It creates a session, flushes it, disposes the agent, resumes it, and disposes again. Its recorded log lines are `# command: npx vitest run tests/zz-probe-a-published.spec.ts`, `✓ tests/zz-probe-a-published.spec.ts (1 test) 201ms`, and `Tests  1 passed (1)`, with the run at HEAD `47806ca`. The archived spec is `evidence/zz-probe-a-published.spec.ts` and the log is `evidence/probe-a-published.log`, both under `/home/wilder/Trash/idle-rollover/`. Probe A proves that the call is usable here. It starts no model turn, so it does not prove that a resumed agent routes its request to the configured model; the end-to-end reopen test is what proves that.

Probe B is the same call with the backend resolved from `/home/wilder/git-repos/deepseek-harness`. It fails while the backend module loads, before any session is opened, with `Error: Cannot find module '/home/wilder/git-repos/deepseek-harness/native/system/packages/linux-x64/bin/glibc/system.node'`, thrown by `loadBinding` at `native/system/packages/entry/src/flock.ts:30` and reached from `errno` at `flock.ts:48`. Its log is `evidence/probe-b-checkout.log`.

The archived probe specs import a harness file that is not present under the evidence directory, so treat them as archived sources and their logs as historical run records.

## Requirements copied from the user's request

Each row quotes the request that settled this design.

| The request, quoted | Resolved artifact | Where the design implements it |
| --- | --- | --- |
| "when a session is marked as possible candidates for idle rollover (context over some threshold), write it into a state file that survives restarts. When rollover happens or context goes down , the candidate leaves the state file." | The floor is `idleRolloverTokens: 90000` in the plugin's own row at `/home/wilder/git-repos/dsh-context-handoff/cordis.patch.yml:45`; the store is new in `src/candidates.ts`. | Candidate store, marking, and removal decisions above. |
| "the state file I proposed should re-open the candidates when 40 minute mark hits and check if the candidates are fit for a rollover." | `idleRolloverAfterMs: 2400000` at `cordis.patch.yml:44`; the decision is `decideIdleFire` in `src/idle.ts`. | One fire path, and the post-resume decision. |
| "is it not god damn obvious that I want /rollover message to be sent ? what the fuck else would I want ?" | `idleRolloverMessage: /rollover` at `cordis.patch.yml:46`; the send is `fire(agent)` in `src/watchdog.ts`. | The gate removal decision and user story 4. |
| "That would be extra mechanism. Just send rollover message. Forced commit would happen automatically. The point is that nothing ever goes above forced commit. It is final." | The automatic commit is the pre-step branch in `src/index.ts:283-323`, conditional on `automaticRollover`, which the `web` agent preset sets true at `/home/wilder/.dsh/profiles/web/cordis.patch.yml:678`. In this request, "extra mechanism" means suppressing the automatic commit for a fired turn, which the user rejected. | Gate removal decision, out of scope, user story 5. |
| "300k is the nagging threshold in normal use" / "90k is the threshold for idle rollover" / "do not fucking confuse the two" | `reminderThresholdTokens: 300000` and `thresholdTokens: 350000` in the profile preset at `/home/wilder/.dsh/profiles/web/cordis.patch.yml:722-723`; `idleRolloverTokens: 90000` at `cordis.patch.yml:45`. | Config decision, which changes nothing, and user story 6. |
| "I want to make sure that restarts do not affect idle rollovers. that idle sessions should still rollover after 40 minutes of idle." | The load marker is the `session/end-seed` event the `Session` constructor appends at `/home/wilder/.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js:1351-1352`, `{ inherited: true }` on line 1351 and `{}` on line 1352; the idle clock reader is new in `src/epoch.ts`. | Idle clock decision, the durable file, and the restart test. |

## Deliverables

- The plugin source: `src/watchdog.ts`, `src/idle.ts`, `src/epoch.ts`, `src/config.ts`, `src/index.ts`, a new `src/candidates.ts`, and a new `src/resume.ts` for the resume composition.
- Tests, all under `tests/` in that same repository: `tests/idle-watchdog.spec.ts`, `tests/idle-decision.spec.ts`, `tests/epoch.spec.ts`, a new `tests/candidates.spec.ts`, a new `tests/idle-reopen.spec.ts` for the reopen path, a new `tests/idle-restart.spec.ts` for the restart case, and the in-memory persistence service in `tests/harness.ts`.
- The bundle row comment in `cordis.patch.yml`.
- The six tickets: `kx39` (idle clock), `a6n1` (candidate file), `awvv` (file-driven sweep), `b7q1` (rollover-point message), `xz94` (closed-session reopen), `g515` (restart proof, config, docs), all in the local Kata issue ledger, project `personal`.
