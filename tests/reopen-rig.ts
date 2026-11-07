/**
 * The shared rig of the reopen and restart specs: a host-shaped context with the
 * in-memory persistence backend, the three services the reopen composition reads
 * (stubbed, because the host mounts them itself), the skill the watchdog message
 * names, and one engine over a temp candidate file. The helpers also drive the
 * fake clock and read the durable state back.
 *
 * Not a spec file: `vitest` collects only `tests/**` standards files named
 * `*.spec.ts`, so both reopen specs import this module.
 *
 * @module tests/reopen-rig
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { RolloverConfig } from '../src/config.ts'
import { ContextRolloverEngine } from '../src/index.ts'
import { CandidateStore } from '../src/candidates.ts'
import type { CandidateRecord } from '../src/candidates.ts'
import {
  MemorySessionPersistence,
  MODEL,
  ScriptedAdapter,
  followup,
  mountTestContext,
  tempNotesDir,
  usageResponse,
} from './harness.ts'
import type { MemoryStoredSession } from './harness.ts'

/** The instant every reopen test starts at. */
export const T0 = Date.parse('2026-10-30T12:00:00Z')
export const MINUTE = 60_000
/** The 40-minute idle threshold. */
export const AFTER_MS = 2_400_000
/** The 90,000-token floor. */
export const FLOOR = 90_000
/** One watchdog cadence. */
export const TICK_MS = MINUTE
/** A usage figure above the floor and far below the rollover point. */
export const ABOVE_FLOOR = 100_000

/** Every context a test mounted, disposed after it. */
const contexts: Context[] = []

/** Scratch directories a test created, removed after it. */
const scratchDirs: string[] = []

/** Install the fake clock the watchdog tests use: only `Date` and the interval functions run on it. */
export function useReopenClock(): void {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(T0)
}

/** Dispose every context and scratch directory a test left, then restore the real clock. */
export async function cleanupReopen(): Promise<void> {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of scratchDirs.splice(0)) await rm(dir, { recursive: true, force: true })
  vi.useRealTimers()
  vi.restoreAllMocks()
}

/** Dispose one context early, as a restart does, and stop tracking it. */
export async function disposeEarly(ctx: Context): Promise<void> {
  const index = contexts.indexOf(ctx)
  if (index !== -1) contexts.splice(index, 1)
  await ctx.fiber.dispose()
}

/** A fresh directory a test may keep across contexts, as a restart keeps its files. */
export async function scratchDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

/** Mount the skills service and one user-invocable skill named `rollover`. */
async function mountRolloverSkill(ctx: Context): Promise<void> {
  await ctx.plugin(SkillRegistry)
  ctx.skills.register({
    name: 'rollover',
    description: 'Write the handoff and call new_context.',
    source: 'runtime',
    content: 'Write the handoff.',
  })
}

/** Provide the three services the reopen composition reads from the host. */
function provideReopenServices(ctx: Context, presetId: string): void {
  const provide = (ctx as unknown as { provide(name: string, value: unknown): void }).provide.bind(ctx)
  provide('sessionQuery', {
    // The real service reports a session it cannot find the way the plugin's
    // not-found predicate expects, and hands back the stored header.
    observeSession: async (sessionId: SessionId) => {
      const store = ctx.sessionPersistence as MemorySessionPersistence
      const entry = store.entries.get(sessionId)
      if (entry === undefined) {
        const error = new Error(`session "${sessionId}" not found`) as Error & { code?: string }
        error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
        throw error
      }
      return {
        header: entry.header,
        projections: { values: { agentPreset: presetId } },
        [Symbol.dispose]: () => {},
      }
    },
  })
  provide('agentDefaultModel', { currentSelection: () => ({ provider: MODEL, model: MODEL }) })
  provide('agentPresets', {
    // The engine reads the roster to decide who owns the model surface; the
    // reopen reads resolve/mount. One stub serves both.
    serviceFor: () => undefined,
    resolve: async (preset: string | undefined) => ({ id: preset ?? presetId }),
    mount: async () => {},
  })
}

/** One rig: a context with the persistence backend, the stubs, and one engine. */
export interface ReopenRig {
  readonly ctx: Context
  readonly engine: ContextRolloverEngine
  readonly adapter: ScriptedAdapter
  readonly persistence: MemorySessionPersistence
  readonly candidatePath: string
  readonly config: RolloverConfig
}

/** What a restart carries into the successor context. */
export interface RestartPaths {
  readonly candidatePath?: string
  /** The sessions the predecessor store held, as a durable backend would carry them. */
  readonly seed?: readonly MemoryStoredSession[]
  /** Extra config for a case that needs a different threshold, such as an automatic commit. */
  readonly config?: Partial<RolloverConfig>
  /** A scripted adapter other than the default, such as one that gates its second request. */
  readonly adapter?: ScriptedAdapter
}

/**
 * Mount one host-shaped context: the persistence backend with its stored
 * sessions, the three stubs the reopen composition reads, the skill the
 * watchdog message names, and one engine over a candidate file.
 * @param paths - a restart passes the candidate path and the stored sessions of
 * its predecessor; a fresh test gets both from its own scratch directory.
 * @returns the context, engine, adapter, store, and paths.
 */
export async function openRig(paths?: RestartPaths): Promise<ReopenRig> {
  const candidateDir = await scratchDir('dsh-reopen-candidates-')
  const candidatePath = paths?.candidatePath ?? join(candidateDir, 'candidates.json')
  const ctx = await mountTestContext()
  contexts.push(ctx)
  await ctx.plugin(MemorySessionPersistence, paths?.seed === undefined ? {} : { seed: paths.seed })
  provideReopenServices(ctx, 'standard')
  await mountRolloverSkill(ctx)
  const adapter = paths?.adapter ?? new ScriptedAdapter([usageResponse('answer', ABOVE_FLOOR)])
  ctx.llm.registerAdapter(['mock'], adapter)
  const config: RolloverConfig = {
    notesDir: await tempNotesDir(),
    idleRolloverCandidatesPath: candidatePath,
    idleRollover: true,
    idleRolloverAfterMs: AFTER_MS,
    idleRolloverTokens: FLOOR,
    idleRolloverTickMs: TICK_MS,
    // The preset roster is present, so the engine must be told to own the
    // model-facing tools; otherwise no `new_context` tool resolves for the
    // resumed agent and the fire decision refuses.
    modelSurface: 'always',
    modelThresholds: { [MODEL]: { thresholdTokens: 1_000_000, reminderThresholdTokens: 500_000 } },
    ...paths?.config,
  }
  const engine = new ContextRolloverEngine(ctx, config)
  return {
    ctx,
    engine,
    adapter,
    persistence: ctx.sessionPersistence as MemorySessionPersistence,
    candidatePath,
    config,
  }
}

/** The candidate record on disk, read through a fresh store so no cache hides a rewrite. */
export function recordAt(path: string, sessionId: string): CandidateRecord | undefined {
  return new CandidateStore({ path, warn: () => {} }).get(sessionId)
}

/** Let the microtask and real-timer queues run until `until` holds or the bound runs out. */
export async function settle(until: () => boolean, bound = 600): Promise<void> {
  for (let index = 0; index < bound; index += 1) {
    if (until()) return
    await new Promise<void>(resolve => { setImmediate(resolve) })
  }
}

/** Advance the fake clock and let everything the ticks started settle. */
export async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await settle(() => false, 30)
}

/** Read the stored log of one session through the backend's read access. */
export async function storedEvents(ctx: Context, sessionId: SessionId): Promise<readonly SessionEvent[]> {
  const handle = await ctx.sessionPersistence.open(sessionId, 'read')
  try {
    const { events } = await handle.read(0)
    return events
  } finally {
    await handle.close()
  }
}

/** The number of `user/message` events in a log whose only block is `text`. */
export function userTexts(events: readonly SessionEvent[], text: string): number {
  return events.filter(event => event.type === 'user/message'
    && event.data.content.length === 1
    && event.data.content[0]?.type === 'text'
    && event.data.content[0].text === text).length
}

/**
 * Create one stored agent and run one turn. The record is written by the next
 * sweep's marking pass, not by the pre-step, because a first turn's pre-step
 * runs before any usage is known; the caller advances one tick while the agent
 * is still live, then closes it.
 * @param ctx - the rig's context.
 * @param sessionId - the session to create and store.
 * @returns the live agent handle.
 */
export async function openStoredTurn(ctx: Context, sessionId: SessionId): Promise<{ agent: Agent; dispose(): Promise<void> }> {
  const handle = await ctx.agents.create({
    sessionId,
    agentOptions: { provider: MODEL, model: MODEL },
  })
  await followup(handle.agent, 'first question')
  return handle
}

/** The stored sessions of one rig, shaped the way a successor context would load them. */
export function seedOf(rig: ReopenRig): readonly MemoryStoredSession[] {
  return [...rig.persistence.entries.values()].map(entry => ({
    header: entry.header,
    inheritedEventCount: entry.inheritedEventCount,
    events: entry.events,
  }))
}
