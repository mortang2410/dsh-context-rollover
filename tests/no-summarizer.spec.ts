/**
 * No summarizer runs on any rollover path, and the model-visible guidance
 * teaches the `/handoff-doc` then `new_context` workflow.
 *
 * The central claim is a NEGATIVE about ordering: no model request starts
 * inside a rollover's compaction bracket. It is proven per path, because a
 * single happy-path check cannot see a path-specific regression, and the
 * bracket is the scope rather than the whole turn, because the model
 * legitimately calls the LLM while it writes the handoff document. A test that
 * asserted "zero requests in the turn" would be false on the model-requested
 * path, where the model's own turns straddle the rollover.
 *
 * The measurement is the harness's per-stream ordinal: a request is placed
 * against a `compaction/start`/`compaction/end` pair by comparing its ordinal
 * with the number of streams the process had started when each edge event was
 * appended. `session.append` invokes `session/event` observers synchronously,
 * so that count is exact at the edge.
 *
 * @module tests/no-summarizer
 */

import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { symbols } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { ContextRolloverEngine } from '../src/index.ts'
import { NotesStore } from '../src/notes.ts'
import { countRollovers, ROLLOVER_PROVIDER } from '../src/rollover.ts'
import { sessionEventAt } from '../src/compat.ts'
import {
  engineHarness,
  errorFinish,
  followup,
  newContextCall,
  type RecordedRequest,
  ScriptedAdapter,
  seedExchanges,
  startedStreamCount,
  startedStreams,
  textResponse,
  toolCall,
  usageResponse,
} from './harness.ts'

/** Scratch directories these tests create, removed after the run. */
const scratchDirs: string[] = []

afterAll(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

/** Create one scratch workspace, removed after the run. */
async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

/**
 * One rollover bracket as the durable log recorded it, plus the stream count
 * the process had reached when each edge was appended.
 */
interface RolloverWindow {
  readonly startSeq: number
  readonly summarySeq: number
  readonly endSeq: number
  readonly provider: string
  readonly model: string
  /** Streams started by the moment `compaction/start` was appended. */
  readonly streamsAtStart: number
  /** Streams started by the moment `compaction/end` was appended. */
  readonly streamsAtEnd: number
  /** The failure recorded by `compaction/end`, when the attempt failed. */
  readonly endError: string | undefined
}

/** One open bracket while its three events arrive. */
interface OpenWindow {
  readonly startSeq: number
  readonly streamsAtStart: number
  summarySeq?: number
  provider?: string
  model?: string
}

/**
 * Observe every rollover bracket on one session, sampling the process's stream
 * count at each edge.
 *
 * The observable is registered before the run so the sample is taken while the
 * engine appends the event, which is the only moment the ordering is exact.
 */
function observeRollovers(ctx: Context, session: Session): RolloverWindow[] {
  const windows: RolloverWindow[] = []
  const open = new Map<string, OpenWindow>()
  ctx.on('session/event', (observed: Session, event: SessionEvent) => {
    if (observed !== session) return
    if (event.type === 'compaction/start') {
      open.set(event.data.compactionId, {
        startSeq: event.seq,
        streamsAtStart: startedStreamCount(),
      })
      return
    }
    if (event.type === 'compaction/summary') {
      const bracket = open.get(event.data.compactionId)
      if (bracket === undefined) return
      bracket.summarySeq = event.seq
      bracket.provider = event.data.provider
      bracket.model = event.data.model
      return
    }
    if (event.type === 'compaction/end') {
      const bracket = open.get(event.data.compactionId)
      if (bracket === undefined) return
      open.delete(event.data.compactionId)
      windows.push({
        startSeq: bracket.startSeq,
        summarySeq: bracket.summarySeq ?? -1,
        endSeq: event.seq,
        provider: bracket.provider ?? '',
        model: bracket.model ?? '',
        streamsAtStart: bracket.streamsAtStart,
        streamsAtEnd: startedStreamCount(),
        endError: event.data.error,
      })
    }
  })
  return windows
}

/** The recorded adapter streams that started strictly inside one bracket. */
function streamsInside(window: RolloverWindow): readonly RecordedRequest[] {
  return startedStreams().filter(stream => (
    stream.ordinal >= window.streamsAtStart && stream.ordinal < window.streamsAtEnd
  ))
}

/** The recorded adapter streams that started before one bracket opened. */
function streamsBefore(window: RolloverWindow): readonly RecordedRequest[] {
  return startedStreams().filter(stream => stream.ordinal < window.streamsAtStart)
}

/** The recorded adapter streams that started after one bracket closed. */
function streamsAfter(window: RolloverWindow): readonly RecordedRequest[] {
  return startedStreams().filter(stream => stream.ordinal >= window.streamsAtEnd)
}

/**
 * The measurement's own integrity, asserted on every case.
 *
 * The proof below is only as good as its ordinal, so the ordinal itself is
 * checked: exactly one number per started stream, each one greater than the
 * last, starting at zero. A counter that stopped advancing, or that assigned
 * the same number twice, would make the window comparison meaningless, and
 * this assertion is what fails first.
 */
function assertOrdinalsAreInvocationOrder(): void {
  const ordinals = startedStreams().map(stream => stream.ordinal)
  expect(ordinals).toEqual(ordinals.map((_ordinal, index) => index))
}

/**
 * The central assertion for one path: no adapter stream started between this
 * rollover's `compaction/start` and its `compaction/end`.
 *
 * The window is cross-checked against the durable log by seq first, so the
 * measured bracket is the committed one and not a snapshot taken elsewhere.
 * The stream count at each edge was sampled inside the `session.event`
 * observer, and the comparison is on the recorded ordinal itself.
 */
function assertNoStreamInside(window: RolloverWindow, session: Session, windowNumber: number): void {
  expect(sessionEventAt(session, window.startSeq)?.type).toBe('compaction/start')
  expect(sessionEventAt(session, window.summarySeq)?.type).toBe('compaction/summary')
  expect(sessionEventAt(session, window.endSeq)?.type).toBe('compaction/end')

  // THE PROOF. This is what "do not ask a summarizer model to compact
  // anything" means as a measurement: no `stream` invocation began while the
  // transaction held the compaction lock.
  expect(streamsInside(window).map(stream => stream.ordinal)).toEqual([])

  // SUPPORTING evidence only, and deliberately not the proof: the summary's
  // provider and model name this engine's deterministic composition, but
  // metadata cannot show that no request was made — a backend that also called
  // a model while writing this summary would still record exactly these fields.
  expect(window.provider).toBe(ROLLOVER_PROVIDER)
  expect(window.model).toBe(`deterministic/window-${windowNumber}`)
}

/**
 * The non-vacuity checks that give the proof its teeth.
 *
 * `assertNoStreamInside` passes trivially against a window that covers the
 * whole run, so each case also asserts that requests really do straddle the
 * bracket: at least one before it (the request that triggered or preceded the
 * rollover) and at least one after it (the request that continued on the fresh
 * window). A widened window then has something to catch.
 */
function assertRequestsStraddle(window: RolloverWindow): void {
  expect(streamsBefore(window).length).toBeGreaterThan(0)
  expect(streamsAfter(window).length).toBeGreaterThan(0)
}

/** The single committed rollover window of one case, with its invariants. */
function soleCommittedWindow(
  windows: readonly RolloverWindow[],
  session: Session,
  windowNumber = 1,
): RolloverWindow {
  expect(windows).toHaveLength(1)
  const window = windows[0]
  if (window === undefined) throw new Error('expected one rollover window')
  // A rolled-back attempt would leave an `end` carrying an error and no
  // summary; the metadata assertion below would then fail with a confusing
  // message, so the failure is named here instead.
  expect(window.endError).toBeUndefined()
  expect(countRollovers(session)).toBe(windowNumber)
  return window
}

/** The text of every assembled system-prompt section, joined. */
async function assembledSystemPrompt(ctx: Context): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble({})
  return assembly.sections.map(section => section.text).join('\n')
}

/**
 * Resolve a Cordis traced service proxy to the concrete registered instance.
 *
 * `expect(proxy)` is not usable here: vitest probes `asymmetricMatch` and other
 * properties on whatever it is handed, and a service proxy answers those with
 * "cannot get property … without inject". Unwrapping first keeps the identity
 * assertion about the backend itself.
 */
function rawCompaction(engine: CompactionEngine): CompactionEngine {
  return (engine as CompactionEngine & { [symbols.original]?: CompactionEngine })[symbols.original] ?? engine
}

/**
 * One bundle-patch row's body lines, or `undefined` when the patch has no such
 * row.
 *
 * Comments are removed before the scan, so a commented-out row or an
 * explanatory mention of the id cannot satisfy an assertion about the row. The
 * body is every following line indented deeper than the row itself, which is
 * how a nested `insert:` entry and a top-level row are both read correctly.
 */
function patchRow(patch: string, id: string): string[] | undefined {
  const lines = patch.split('\n').filter(line => !line.trimStart().startsWith('#'))
  const start = lines.findIndex(line => line.trim() === `- id: ${id}`)
  if (start === -1) return undefined
  const row = lines[start]
  if (row === undefined) return undefined
  const indent = row.length - row.trimStart().length
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    const lineIndent = line.length - line.trimStart().length
    if (line.trim().length > 0 && lineIndent <= indent) break
    body.push(line)
  }
  return body
}

describe('no summarizer on the model-requested rollover path', () => {
  it('starts no stream inside the compaction bracket while the model drives the boundary', async () => {
    const cwd = await scratch('dsh-no-summarizer-requested-')
    const documentPath = join(cwd, 'HANDOFF-requested.md')
    await writeFile(documentPath, '# Handoff\n\nContinue the migration from this document.\n', 'utf8')

    const { ctx, engine, agent, session } = await engineHarness(
      'no-summarizer-requested',
      { handoffOnly: true },
      { cwd },
    )
    const windows = observeRollovers(ctx, session)

    // The model writes its handoff (a real request per filler turn), then calls
    // `new_context` mid-turn, and answers again on the fresh window. Its own
    // turns straddle the rollover on both sides; the bracket between them is
    // what must contain no request.
    const adapter = new ScriptedAdapter([
      ...Array.from({ length: 12 }, (_unused, index) => textResponse(`requested filler ${index}`)),
      newContextCall(JSON.stringify({ handoff_path: documentPath })),
      textResponse('continuing on the fresh window'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 12)
    await followup(agent, 'write the handoff and cross the boundary')

    // Everything this case will ever do has happened, so a window that wrongly
    // extended past the rollover would have the later requests to catch.
    assertOrdinalsAreInvocationOrder()
    const window = soleCommittedWindow(windows, session)
    assertNoStreamInside(window, session, 1)
    assertRequestsStraddle(window)

    // And the backend that crossed the boundary is this engine, not the
    // summarizer backend it replaced.
    expect(rawCompaction(ctx.compaction)).toBe(rawCompaction(engine))

    // The document really did cross the boundary, so this case is exercising a
    // real rollover rather than a refused one.
    expect(session.deriveMessages().map(message => JSON.stringify(message)).join('\n'))
      .toContain('Continue the migration from this document.')
  })
})

describe('no summarizer on the pressure rollover path', () => {
  it('starts no stream inside the compaction bracket at the automatic threshold', async () => {
    const { ctx, agent, session, notesBase } = await engineHarness('no-summarizer-pressure', {
      thresholdRatio: 0.001,
      reminderThresholdRatio: 0.001,
      handoffOnly: true,
    })
    const windows = observeRollovers(ctx, session)
    // A working notes checkpoint, so the rollover commits rather than being
    // refused for want of a smaller replacement.
    const store = new NotesStore(NotesStore.directoryFor(session.id, notesBase))
    await store.write('state.md', 'goal: prove the pressure path calls no model\n')

    // Two requests in the second turn: the pre-step that crosses the threshold
    // rolls over, then the step's own request follows on the fresh window.
    const adapter = new ScriptedAdapter([
      usageResponse(`pressure answer one ${'detail '.repeat(600)}`, 5000),
      toolCall('get_context_remaining', '{}', 'c1'),
      usageResponse(`pressure answer two ${'detail '.repeat(600)}`, 6000),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')

    assertOrdinalsAreInvocationOrder()
    const window = soleCommittedWindow(windows, session)
    assertNoStreamInside(window, session, 1)
    assertRequestsStraddle(window)
    expect(session.deriveMessages().map(message => JSON.stringify(message)).join('\n'))
      .toContain('reason: pressure')
  })
})

describe('no summarizer on the overflow rollover path', () => {
  it('starts no stream inside the compaction bracket before the retry', async () => {
    const { ctx, agent, session } = await engineHarness('no-summarizer-overflow')
    const windows = observeRollovers(ctx, session)

    const adapter = new ScriptedAdapter([
      ...Array.from({ length: 20 }, (_unused, index) => textResponse(`overflow filler ${index}`)),
      errorFinish('request too large for model context window', CONTEXT_WINDOW_EXCEEDED_CODE),
      textResponse('recovered after rollover'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 20)
    await followup(agent, 'the next request overflows')

    assertOrdinalsAreInvocationOrder()
    const window = soleCommittedWindow(windows, session)
    assertNoStreamInside(window, session, 1)
    // The retry after the rollover is the request that proves the bracket does
    // not simply extend to the end of the run.
    assertRequestsStraddle(window)
    expect(session.deriveMessages().map(message => JSON.stringify(message)).join('\n'))
      .toContain('reason: overflow')
  })
})

describe('no summarizer on the manual rollover path', () => {
  it('starts no stream inside the compaction bracket of compactNow', async () => {
    const { ctx, engine, agent, session, notesBase } = await engineHarness('no-summarizer-manual')
    const windows = observeRollovers(ctx, session)
    const store = new NotesStore(NotesStore.directoryFor(session.id, notesBase))
    await store.write('state.md', 'goal: prove the manual path calls no model\n')

    const adapter = new ScriptedAdapter(
      Array.from({ length: 30 }, (_unused, index) => textResponse(`manual filler ${index}`)),
    )
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 20)
    await followup(agent, 'background work before the manual rollover')

    const compacted = await engine.compactNow(agent, new AbortController().signal)
    expect(compacted).not.toBeNull()

    // A request after the bracket, so the assertion has a later stream to catch
    // if the window is ever widened past the rollover. `compactNow` runs on an
    // idle agent, so no request is in flight while the bracket is open: the
    // non-vacuity here comes from the requests before it and this one after.
    await followup(agent, 'continue after the manual rollover')

    assertOrdinalsAreInvocationOrder()
    const window = soleCommittedWindow(windows, session)
    assertNoStreamInside(window, session, 1)
    assertRequestsStraddle(window)
    expect(session.deriveMessages().map(message => JSON.stringify(message)).join('\n'))
      .toContain('reason: manual')
  })
})

describe('the compaction backend this deployment resolves to', () => {
  it('resolves ctx.compaction to this engine on a rosterless deployment', async () => {
    const { ctx, engine } = await engineHarness('no-summarizer-backend')
    // `ctx.compaction` is the engine's Cordis service proxy, so identity is
    // read through the underlying instance. Reading it into `expect()` directly
    // would make vitest probe proxy properties the service does not inject.
    const resolved = rawCompaction(ctx.compaction)
    expect(resolved).toBe(rawCompaction(engine))
    expect(resolved).toBeInstanceOf(ContextRolloverEngine)
    // Named for the contrast that matters: the summarizer backend this engine
    // replaced. A deployment that resolved to it would stream a summarization
    // request inside the bracket, which is exactly what the path tests forbid.
    expect(resolved?.constructor.name).toBe('ContextRolloverEngine')
    expect(resolved?.constructor.name).not.toBe('BasicCompactionEngine')
  })
})

describe('the bundle patch keeps compaction-basic disabled', () => {
  it('carries a compaction-basic row disabled, and mounts this engine instead', () => {
    const patch = readFileSync(resolve(import.meta.dirname, '..', 'cordis.patch.yml'), 'utf8')
    const row = patchRow(patch, 'compaction-basic')
    expect(row).toBeDefined()
    expect(row?.map(line => line.trim())).toContain('disabled: true')
    // Exactly one row carries the id, so the disabled row cannot be a stray
    // duplicate beside an enabled one.
    expect(patch.split('\n').filter(line => line.trimEnd() === '- id: compaction-basic')).toHaveLength(1)

    const inserted = patchRow(patch, 'context-rollover')
    expect(inserted).toBeDefined()
    expect(inserted?.map(line => line.trim())).toContain('name: dsh-context-rollover')
  })
})

describe('the assembled guidance teaches the handoff workflow', () => {
  it('leads with /handoff-doc and new_context, and keeps the removed short-handoff text out', async () => {
    const { ctx } = await engineHarness('no-summarizer-guidance')
    const assembly = await ctx.systemPrompt.assemble({})
    const section = assembly.sections.find(candidate => candidate.name === 'context:rollover')
    expect(section).toBeDefined()
    const text = await assembledSystemPrompt(ctx)

    // The workflow the model must follow, in the prompt it actually receives.
    expect(text).toContain('/handoff-doc')
    expect(text).toContain('`new_context`')
    expect(text).toContain('handoff_path')
    expect(text).toContain('the entire continuation context')
    expect(text).toContain('never injected automatically')

    // The instruction ticket 04 removed: a short inline handoff at a natural
    // task boundary. None of its wording may survive anywhere in the prompt.
    expect(text).not.toContain('pass a short handoff')
    expect(text).not.toContain('natural task boundary')
    expect(text).not.toContain('continue primarily from your notes')
    expect(text).not.toContain('recent verbatim')
  })
})
