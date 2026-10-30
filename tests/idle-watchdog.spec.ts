/**
 * The idle rollover watchdog, end to end through the real engine, harness, and
 * agent loop.
 *
 * Each gate of the fire decision has a test that fails only when that gate
 * blocks. Each test that expects silence is paired with a control in which the
 * same session fires once the blocking condition is lifted, so silence cannot
 * come from a stopped timer or a broken setup.
 *
 * Only `Date`, `setInterval`, and `clearInterval` are faked. Each tick is driven
 * by `vi.advanceTimersByTimeAsync`, so the cadence is exact. `setImmediate` stays
 * real, so the async agent loop can settle between ticks.
 *
 * @module tests/idle-watchdog
 */

import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { createScope } from '@deepseek-ai/dsh-scope'
import type { Session, UserMessage } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import SkillRegistry from '@deepseek-ai/dsh-skill'
import type { RolloverConfig } from '../src/config.ts'
import { hasSlashGesture, slashGestureNames } from '../src/idle.ts'
import { ContextRolloverEngine } from '../src/index.ts'
import { countRollovers } from '../src/rollover.ts'
import {
  CONTEXT_WINDOW,
  followup,
  MODEL,
  mountTestContext,
  ScriptedAdapter,
  seedExchanges,
  tempNotesDir,
  textResponse,
  usageResponse,
} from './harness.ts'

const T0 = Date.parse('2026-10-30T12:00:00Z')
const MINUTE = 60_000
const HOUR = 60 * MINUTE
/** The watchdog's defaults, spelled out so each test's timing reads on its face. */
const AFTER_MS = 2_400_000
const FLOOR = 90_000
const TICK_MS = MINUTE
/** A usage figure above the default floor and far below the rollover point. */
const ABOVE_FLOOR = 100_000
/** A rollover point that no test reaches unless it lowers it. */
const FAR_POINT = { thresholdTokens: 1_000_000, reminderThresholdTokens: 500_000 }

/** Every context a test mounted, disposed after it. */
const contexts: Context[] = []

/** Scratch directories for handoff documents, removed after each test. */
const scratchDirs: string[] = []

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(T0)
})

afterEach(async () => {
  // Dispose while the fake clear is still installed, so each interval is cleared by its owner.
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const dir of scratchDirs.splice(0)) await rm(dir, { recursive: true, force: true })
  vi.useRealTimers()
  vi.restoreAllMocks()
})

/** Mount the standard stack and track it for disposal. */
async function mount(): Promise<Context> {
  const ctx = await mountTestContext()
  contexts.push(ctx)
  return ctx
}

/** Engine configuration with the watchdog on and a rollover point no test reaches by accident. */
async function configFor(overrides: Partial<RolloverConfig> = {}): Promise<RolloverConfig> {
  return {
    notesDir: await tempNotesDir(),
    idleRollover: true,
    idleRolloverAfterMs: AFTER_MS,
    idleRolloverTokens: FLOOR,
    idleRolloverTickMs: TICK_MS,
    modelThresholds: { [MODEL]: { ...FAR_POINT } },
    ...overrides,
  }
}

/**
 * Provide the agent-preset roster the engine reads at construction. Its presence
 * decides whether an engine that does not own the model surface stays out of it.
 */
function provideRoster(ctx: Context, roster: { serviceFor(agent: unknown, name: string): unknown }): void {
  (ctx as unknown as { provide(name: string, value: unknown): void }).provide('agentPresets', roster)
}

/** Options for one rig: a session id, optional config, roster, adapter, and whether the skill is mounted. */
interface RigOptions {
  readonly id: string
  readonly config?: Partial<RolloverConfig>
  readonly roster?: { serviceFor(agent: unknown, name: string): unknown }
  readonly adapter?: LlmAdapter
  /** Mounted by default, because the watchdog's skill gate fails closed without it. */
  readonly skill?: boolean
}

/**
 * One engine on a fresh root context with one root agent. A roster, when given,
 * is provided before the engine is built, because the engine reads it at
 * construction to decide whether it owns the model-facing tools.
 */
async function rig(options: RigOptions) {
  const ctx = await mount()
  if (options.roster !== undefined) provideRoster(ctx, options.roster)
  if (options.skill !== false) await mountRolloverSkill(ctx)
  ctx.llm.registerAdapter(['mock'], options.adapter ?? new ScriptedAdapter([usageResponse('answer', ABOVE_FLOOR)]))
  const engine = new ContextRolloverEngine(ctx, await configFor(options.config))
  const agent = await ctx.agentLoop.create(SessionId(options.id), { provider: MODEL, model: MODEL })
  return { ctx, engine, agent, session: agent.session }
}

/** Every user message in a session's durable log whose only content is `text`, whatever its source. */
function sendsOf(session: Session, text: string): UserMessage[] {
  return session.snapshotEvents().flatMap(event => {
    if (event.type !== 'user/message') return []
    const [block] = event.data.content
    const isSend = event.data.content.length === 1 && block?.type === 'text' && block.text === text
    return isSend ? [event.data] : []
  })
}

/** Every `/rollover` user message in a session's durable log, whatever its source. */
function rolloverSends(session: Session): UserMessage[] {
  return sendsOf(session, '/rollover')
}

/** Let the tick and any promise chain it started reach their next wait. */
async function flush(): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    await new Promise<void>(resolve => { setImmediate(resolve) })
  }
}

/** Advance the fake clock, running each tick that falls inside the span. */
async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await flush()
}

/** The engine's own pending-request map, read through the private field. */
function pendingOf(engine: ContextRolloverEngine): Map<string, unknown> {
  return (engine as unknown as { pendingRollovers: Map<string, unknown> }).pendingRollovers
}

/** A handoff document modified now on the fake clock, so the freshness rule accepts it. */
async function freshHandoff(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-idle-watchdog-'))
  scratchDirs.push(dir)
  const path = join(dir, 'HANDOFF-idle.md')
  await writeFile(path, '# Handoff\n\nContinue from the notes.\n', 'utf8')
  const seconds = Date.now() / 1000
  await utimes(path, seconds, seconds)
  return path
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

/** A promise plus the call that settles it. */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve: () => void = () => {}
  const promise = new Promise<void>(done => { resolve = () => done() })
  return { promise, resolve }
}

/**
 * A model adapter whose second and later requests wait for the test to release
 * them, so the agent stays in its running state for as long as the test needs.
 */
class GatedAdapter extends LlmAdapter {
  readonly release = deferred()
  private requests = 0

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: CONTEXT_WINDOW } })
  }

  override stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests += 1
    return this.answer(this.requests > 1)
  }

  private async *answer(gated: boolean): AsyncIterable<StreamChunk> {
    if (gated) await this.release.promise
    yield* usageResponse('answer', ABOVE_FLOOR)
  }
}

describe('idle rollover watchdog', () => {
  it('sends exactly one /rollover to an idle root past the threshold and above the floor', async () => {
    const { agent, session } = await rig({ id: 'eligible' })
    await followup(agent, 'first question')

    await advance(AFTER_MS - TICK_MS)
    expect(rolloverSends(session)).toHaveLength(0)

    await advance(TICK_MS)
    await agent.whenIdle()
    const sends = rolloverSends(session)
    expect(sends).toHaveLength(1)
    expect(sends[0]?.source.kind).toBe('user')
  })

  it('sends nothing at exactly the token floor and fires one token above it', async () => {
    const { ctx, agent, session, engine } = await rig({ id: 'floor' })
    await followup(agent, 'first question')
    const total = ctx.tokenMeter.measure(session).totalTokens

    Object.assign(engine.config, { idleRolloverTokens: total })
    await advance(AFTER_MS + TICK_MS)
    await agent.whenIdle()
    expect(rolloverSends(session)).toHaveLength(0)

    Object.assign(engine.config, { idleRolloverTokens: total - 1 })
    await advance(TICK_MS)
    await agent.whenIdle()
    expect(rolloverSends(session)).toHaveLength(1)
  })

  it('sends nothing at the session rollover point and fires one token below it', async () => {
    const { ctx, agent, session, engine } = await rig({ id: 'rollover-point' })
    await followup(agent, 'first question')
    const total = ctx.tokenMeter.measure(session).totalTokens
    const points = engine.config.modelThresholds[MODEL]
    if (points === undefined) throw new Error('the test model has no rollover entry')

    points.thresholdTokens = total
    await advance(AFTER_MS + TICK_MS)
    await agent.whenIdle()
    expect(rolloverSends(session)).toHaveLength(0)

    points.thresholdTokens = total + 1
    await advance(TICK_MS)
    await agent.whenIdle()
    expect(rolloverSends(session)).toHaveLength(1)
  })

  it('sends nothing while the agent is running, and fires once it is idle again', async () => {
    const adapter = new GatedAdapter()
    const { agent, session } = await rig({ id: 'running', adapter })
    await followup(agent, 'first question')

    agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second question' }], source: { kind: 'user' } }))
    for (let index = 0; index < 100 && agent.status !== 'running'; index += 1) {
      await new Promise<void>(resolve => { setImmediate(resolve) })
    }
    expect(agent.status).toBe('running')

    await advance(AFTER_MS + TICK_MS)
    expect(rolloverSends(session)).toHaveLength(0)

    adapter.release.resolve()
    await agent.whenIdle()
    await advance(AFTER_MS)
    await agent.whenIdle()
    expect(rolloverSends(session)).toHaveLength(1)
  })

  it.each(['next-turn', 'next-step'] as const)(
    'sends nothing while the %s queue holds work, and measures idle from the splice that clears it',
    async target => {
      const { agent, session } = await rig({ id: `queued-${target}` })
      await followup(agent, 'first question')

      agent.inbox.append(target, createUserMessage({ content: [{ type: 'text', text: 'queued' }], source: { kind: 'user' } }))
      await advance(AFTER_MS + TICK_MS)
      expect(rolloverSends(session)).toHaveLength(0)

      agent.inbox.clear()
      await advance(AFTER_MS - TICK_MS)
      expect(rolloverSends(session)).toHaveLength(0)

      await advance(TICK_MS)
      await agent.whenIdle()
      expect(rolloverSends(session)).toHaveLength(1)
    },
  )

  it('sends nothing while another compaction backend owns the session, and fires once it is gone', async () => {
    let owner: unknown = {}
    const { agent, session } = await rig({
      id: 'foreign',
      roster: { serviceFor: () => owner },
      config: { modelSurface: 'always' },
    })
    await followup(agent, 'first question')

    await advance(AFTER_MS + TICK_MS)
    await agent.whenIdle()
    expect(rolloverSends(session)).toHaveLength(0)

    owner = undefined
    await advance(TICK_MS)
    await agent.whenIdle()
    expect(rolloverSends(session)).toHaveLength(1)
  })

  it('sends nothing when the new_context tool does not resolve for the agent', async () => {
    const { ctx, agent, session } = await rig({
      id: 'no-tool',
      roster: { serviceFor: () => undefined },
      config: { modelSurface: 'auto' },
    })
    await followup(agent, 'first question')
    expect(ctx.tools.get('new_context', agent)).toBeUndefined()

    await advance(AFTER_MS + TICK_MS)
    await agent.whenIdle()
    expect(rolloverSends(session)).toHaveLength(0)
  })

  it('sends nothing when the skill named by the message does not resolve, and fires once it does', async () => {
    const { ctx, agent, session } = await rig({ id: 'no-skill', skill: false })
    await ctx.plugin(SkillRegistry)
    await followup(agent, 'first question')

    await advance(AFTER_MS + TICK_MS)
    await agent.whenIdle()
    expect(rolloverSends(session)).toHaveLength(0)

    ctx.skills.register({
      name: 'rollover',
      description: 'Write the handoff and call new_context.',
      source: 'runtime',
      content: 'Write the handoff.',
    })
    await advance(TICK_MS)
    await agent.whenIdle()
    expect(rolloverSends(session)).toHaveLength(1)
  })

  it('sends nothing after a manual /rollover disarms the session, even three hours later', async () => {
    const { agent, session } = await rig({ id: 'manual-epoch' })
    await followup(agent, 'first question')
    await followup(agent, '/rollover')

    await advance(3 * HOUR)
    await agent.whenIdle()
    expect(rolloverSends(session)).toHaveLength(1)
  })

  it('sends nothing to a subagent child or a subagent runtime root, and fires for the live root', async () => {
    const { ctx, agent: root, session } = await rig({ id: 'live-root' })
    const child = await ctx.agents.create({
      sessionId: SessionId('child-of-live-root'),
      parentAgent: root,
      meta: { origin: 'subagent', delegationDepth: 1 },
      agentOptions: { provider: MODEL, model: MODEL },
    })
    const runtime = await ctx.agents.create({
      sessionId: SessionId('runtime-subagent'),
      meta: { origin: 'subagent' },
      agentOptions: { provider: MODEL, model: MODEL },
    })
    try {
      await followup(root, 'first question')
      await followup(child.agent, 'child question')
      await followup(runtime.agent, 'runtime question')

      // The runtime root is a root in the registry, so only the header check keeps it silent.
      const rootIds = ctx.agents.roots().map(agent => agent.session.id)
      expect(rootIds).toContain(runtime.agent.session.id)
      expect(rootIds).not.toContain(child.agent.session.id)

      await advance(AFTER_MS + TICK_MS)
      await root.whenIdle()
      expect(rolloverSends(session)).toHaveLength(1)
      expect(rolloverSends(child.agent.session)).toHaveLength(0)
      expect(rolloverSends(runtime.agent.session)).toHaveLength(0)
    } finally {
      await child.dispose()
      await runtime.dispose()
    }
  })

  it('starts no interval when the feature is off, and starts one when it is on', async () => {
    const offCtx = await mount()
    const offConfig = await configFor({ idleRollover: false })
    const onCtx = await mount()
    const onConfig = await configFor()
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')

    const off = new ContextRolloverEngine(offCtx, offConfig)
    expect(off.config.idleRollover).toBe(false)
    expect(setIntervalSpy).not.toHaveBeenCalled()

    const on = new ContextRolloverEngine(onCtx, onConfig)
    expect(on.config.idleRollover).toBe(true)
    expect(setIntervalSpy).toHaveBeenCalled()
  })

  it('stops ticking when the engine plugin is disposed, while the agent stays live', async () => {
    const ctx = await mount()
    // A routed context window is needed before any candidate is measured, so the model must resolve.
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([usageResponse('answer', ABOVE_FLOOR)]))
    await mountRolloverSkill(ctx)
    const fiber = ctx.isolate('compaction').plugin(ContextRolloverEngine, await configFor())
    await fiber
    const live = await ctx.agentLoop.create(SessionId('live-before-dispose'), { provider: MODEL, model: MODEL })
    await followup(live, 'first question')
    // Positive control: while the plugin is live, its tick finds this idle root and sends.
    await advance(AFTER_MS + TICK_MS)
    await live.whenIdle()
    expect(rolloverSends(live.session)).toHaveLength(1)

    await fiber.dispose()
    // A fresh idle root after disposal: a live timer would fire for it within three hours.
    const later = await ctx.agentLoop.create(SessionId('after-dispose'), { provider: MODEL, model: MODEL })
    await followup(later, 'first question')
    await advance(3 * HOUR)
    await later.whenIdle()
    expect(rolloverSends(later.session)).toHaveLength(0)
    expect(ctx.agents.roots().map(root => root.session.id)).toContain('after-dispose')
  })

  it('holds one timer per host: a second engine and a scoped engine start none, and the claim frees on dispose', async () => {
    const ctx = await mount()
    provideRoster(ctx, { serviceFor: () => undefined })
    const config = await configFor()
    const before = vi.getTimerCount()

    const first = ctx.isolate('compaction').plugin(ContextRolloverEngine, config)
    await first
    expect(vi.getTimerCount()).toBe(before + 1)

    const second = new ContextRolloverEngine(ctx.isolate('compaction'), config)
    expect(second.config.idleRollover).toBe(true)
    expect(vi.getTimerCount()).toBe(before + 1)

    const scoped = createScope(ctx.isolate('compaction'), {}).ctx
    const inScope = new ContextRolloverEngine(scoped, config)
    expect(inScope.config.idleRollover).toBe(true)
    expect(vi.getTimerCount()).toBe(before + 1)

    await first.dispose()
    expect(vi.getTimerCount()).toBe(before)

    const successor = new ContextRolloverEngine(ctx.isolate('compaction'), config)
    expect(successor.config.idleRollover).toBe(true)
    expect(vi.getTimerCount()).toBe(before + 1)
  })

  it('does not retry a send that threw before it queued, and warns once', async () => {
    const { ctx, agent, session } = await rig({ id: 'failed-send' })
    await followup(agent, 'first question')
    const warn = vi.spyOn(ctx.logger, 'warn')
    const send = vi.spyOn(agent, 'followup').mockImplementation(() => {
      throw new Error('boom')
    })

    await advance(AFTER_MS + 3 * TICK_MS)
    expect(send).toHaveBeenCalledTimes(1)
    const failures = warn.mock.calls.filter(([line]) => String(line).includes('failed'))
    expect(failures).toHaveLength(1)
    expect(rolloverSends(session)).toHaveLength(0)
  })

  it('fires once per epoch, however many idle hours pass after the fire', async () => {
    const { agent, session } = await rig({ id: 'one-per-epoch' })
    await followup(agent, 'first question')

    await advance(AFTER_MS + TICK_MS)
    await agent.whenIdle()
    expect(rolloverSends(session)).toHaveLength(1)

    await advance(3 * HOUR)
    await agent.whenIdle()
    expect(rolloverSends(session)).toHaveLength(1)
  })

  it('honors an engine built from another copy of the module, because the brand is shared', async () => {
    vi.resetModules()
    const copy = await import('../src/index.ts')
    const other = await mount()
    const foreign = new copy.ContextRolloverEngine(other.isolate('compaction'), {
      notesDir: await tempNotesDir(),
      idleRollover: false,
      // The watchdog reads the point from the engine that serves the session, and its default sits below the measured usage.
      modelThresholds: { [MODEL]: { ...FAR_POINT } },
    })
    expect(foreign instanceof ContextRolloverEngine).toBe(false)

    const { agent, session } = await rig({
      id: 'cross-copy',
      roster: { serviceFor: () => foreign },
      config: { modelSurface: 'always' },
    })
    await followup(agent, 'first question')

    await advance(AFTER_MS + TICK_MS)
    await agent.whenIdle()
    expect(rolloverSends(session)).toHaveLength(1)
  })

  it('sends nothing while the owning engine holds an uncommitted new_context request, and fires once a pre-step commits it', async () => {
    // Seven plain answers, one reporting usage above the floor, then the turn that commits the request, also above the floor.
    const adapter = new ScriptedAdapter([
      ...Array.from({ length: 7 }, (_unused, index) => textResponse(`answer ${index}`)),
      usageResponse('answer', ABOVE_FLOOR),
      usageResponse('continued', ABOVE_FLOOR),
    ])
    // handoffOnly keeps no tail, so the seven closed exchanges are the replaceable span; the default tail would keep them all.
    const { ctx, engine, agent, session } = await rig({ id: 'pending-request', adapter, config: { handoffOnly: true } })
    await seedExchanges(agent, 7)
    await followup(agent, 'last question')

    // Called outside a turn, so no turn-stop commit runs and the request stays pending.
    const accepted = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('pending-1'),
      name: 'new_context',
      arguments: { handoff_path: await freshHandoff() },
      agent,
    })
    expect(accepted.isError).toBeFalsy()
    expect(accepted.value).toMatchObject({ accepted: true })
    expect(pendingOf(engine).has(session.id)).toBe(true)
    // Above the floor, so the only gate left to hold the fire is the pending request.
    expect(ctx.tokenMeter.measure(session).totalTokens).toBeGreaterThan(FLOOR)

    await advance(AFTER_MS + TICK_MS)
    await agent.whenIdle()
    expect(rolloverSends(session)).toHaveLength(0)
    expect(pendingOf(engine).has(session.id)).toBe(true)

    // The commit is a real turn: its pre-step crosses the pending request before the model is asked.
    const rolloversBefore = countRollovers(session)
    await followup(agent, 'continue from the handoff')
    expect(countRollovers(session)).toBe(rolloversBefore + 1)
    expect(pendingOf(engine).has(session.id)).toBe(false)

    // Control: the commit lifted the only gate that held the fire.
    await advance(AFTER_MS + TICK_MS)
    await agent.whenIdle()
    expect(rolloverSends(session)).toHaveLength(1)
  })

  it('treats a message with no slash gesture as skill-unavailable at every tick: it warns once and never sends', async () => {
    const ctx = await mount()
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([usageResponse('answer', ABOVE_FLOOR)]))
    // The skills service is mounted, so the gate decides on the missing gesture rather than on a missing service.
    await mountRolloverSkill(ctx)
    // The engine warns at construction, so the spy is installed before it is built.
    const warn = vi.spyOn(ctx.logger, 'warn')
    const engine = new ContextRolloverEngine(ctx, await configFor({ idleRolloverMessage: 'rollover' }))
    const agent = await ctx.agentLoop.create(SessionId('no-gesture'), { provider: MODEL, model: MODEL })
    const { session } = agent
    expect(engine.config.idleRolloverMessage).toBe('rollover')
    await followup(agent, 'first question')

    // The first tick past the threshold, then three more: each one reaches the skill gate and stops there.
    await advance(AFTER_MS + TICK_MS)
    await agent.whenIdle()
    for (let tick = 0; tick < 3; tick += 1) {
      await advance(TICK_MS)
      await agent.whenIdle()
    }

    expect(sendsOf(session, 'rollover')).toHaveLength(0)
    expect(rolloverSends(session)).toHaveLength(0)
    const gestureWarnings = warn.mock.calls.filter(([line]) => String(line).includes('no /name skill gesture'))
    expect(gestureWarnings).toHaveLength(1)
  })

  it('fires the same session shape once the message carries a slash gesture naming the same skill', async () => {
    const { agent, session } = await rig({ id: 'gesture-control', config: { idleRolloverMessage: '/rollover' } })
    await followup(agent, 'first question')

    await advance(AFTER_MS + TICK_MS)
    await agent.whenIdle()
    expect(sendsOf(session, '/rollover')).toHaveLength(1)
  })

  it('sends nothing when no skills service is mounted, and fires once the rollover skill is mounted', async () => {
    const { ctx, agent, session } = await rig({ id: 'no-service', skill: false })
    expect(ctx.get('skills')).toBeUndefined()
    const info = vi.spyOn(ctx.logger, 'info')
    await followup(agent, 'first question')

    await advance(AFTER_MS + TICK_MS)
    await agent.whenIdle()
    expect(rolloverSends(session)).toHaveLength(0)
    expect(info.mock.calls.filter(([line]) => String(line).includes('no skills service'))).toHaveLength(1)

    await mountRolloverSkill(ctx)
    await advance(TICK_MS)
    await agent.whenIdle()
    expect(rolloverSends(session)).toHaveLength(1)
  })

  it('takes the rollover point from the engine that serves the session, not from the host row', async () => {
    let preset: ContextRolloverEngine | undefined
    const { ctx, agent, session } = await rig({
      id: 'served-by-preset',
      roster: { serviceFor: () => preset },
      config: { modelSurface: 'always' },
    })
    await followup(agent, 'first question')
    const total = ctx.tokenMeter.measure(session).totalTokens

    // The preset's point sits just below the measured usage; the host row's point is far above it.
    const presetEngine = new ContextRolloverEngine(ctx.isolate('compaction'), await configFor({
      modelThresholds: { [MODEL]: { thresholdTokens: total - 1, reminderThresholdTokens: total - 1 } },
    }))
    preset = presetEngine
    await advance(AFTER_MS + TICK_MS)
    await agent.whenIdle()
    expect(rolloverSends(session)).toHaveLength(0)

    // Control: lifting the preset's point above the usage lets the same session fire.
    const points = presetEngine.config.modelThresholds[MODEL]
    if (points === undefined) throw new Error('the test model has no rollover entry')
    points.thresholdTokens = total + 1
    await advance(TICK_MS)
    await agent.whenIdle()
    expect(rolloverSends(session)).toHaveLength(1)
  })

  it('sends nothing while the preset engine serving the session holds an uncommitted new_context request, and fires once a pre-step commits it', async () => {
    // Seven plain answers, one reporting usage above the floor, then the turn that commits the request, also above the floor.
    const adapter = new ScriptedAdapter([
      ...Array.from({ length: 7 }, (_unused, index) => textResponse(`answer ${index}`)),
      usageResponse('answer', ABOVE_FLOOR),
      usageResponse('continued', ABOVE_FLOOR),
    ])
    let preset: ContextRolloverEngine | undefined
    const { ctx, engine, agent, session } = await rig({
      id: 'preset-pending',
      adapter,
      roster: { serviceFor: () => preset },
    })
    // The preset owns the session's compaction and its model-facing tools, so it holds the request and sets the point.
    const presetEngine = new ContextRolloverEngine(
      ctx.isolate('compaction'),
      await configFor({ handoffOnly: true, modelSurface: 'always' }),
    )
    preset = presetEngine
    await seedExchanges(agent, 7)
    await followup(agent, 'last question')

    // Called outside a turn, so no turn-stop commit runs and the request stays pending on the preset.
    const accepted = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('pending-preset-1'),
      name: 'new_context',
      arguments: { handoff_path: await freshHandoff() },
      agent,
    })
    expect(accepted.isError).toBeFalsy()
    expect(accepted.value).toMatchObject({ accepted: true })
    expect(pendingOf(presetEngine).has(session.id)).toBe(true)
    // The host row holds no request, so a read of only the host's map would see nothing to wait for.
    expect(pendingOf(engine).has(session.id)).toBe(false)
    // Above the floor, so the only gate left to hold the fire is the pending request.
    expect(ctx.tokenMeter.measure(session).totalTokens).toBeGreaterThan(FLOOR)

    await advance(AFTER_MS + TICK_MS)
    await agent.whenIdle()
    expect(rolloverSends(session)).toHaveLength(0)
    expect(pendingOf(presetEngine).has(session.id)).toBe(true)

    // The commit is a real turn: the preset's pre-step crosses the pending request before the model is asked.
    const rolloversBefore = countRollovers(session)
    await followup(agent, 'continue from the handoff')
    expect(countRollovers(session)).toBe(rolloversBefore + 1)
    expect(pendingOf(presetEngine).has(session.id)).toBe(false)

    // Control: the commit lifted the only gate that held the fire.
    await advance(AFTER_MS + TICK_MS)
    await agent.whenIdle()
    expect(rolloverSends(session)).toHaveLength(1)
  })

  it('sends nothing when the engine is disposed while a skill lookup is still pending', async () => {
    const ctx = await mount()
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([usageResponse('answer', ABOVE_FLOOR)]))
    await mountRolloverSkill(ctx)
    const fiber = ctx.isolate('compaction').plugin(ContextRolloverEngine, await configFor())
    await fiber
    const agent = await ctx.agentLoop.create(SessionId('disposed-mid-lookup'), { provider: MODEL, model: MODEL })
    await followup(agent, 'first question')

    const skills = ctx.get('skills') as unknown as { list(options: unknown): Promise<unknown> }
    const real = skills.list.bind(skills)
    const release = deferred()
    const lookup = vi.spyOn(skills, 'list').mockImplementation(async options => {
      await release.promise
      return real(options)
    })

    await advance(AFTER_MS + TICK_MS)
    // Positive control: a tick reached the lookup, so the disposal below lands while a sweep waits on it.
    expect(lookup).toHaveBeenCalled()

    const warn = vi.spyOn(ctx.logger, 'warn')
    await fiber.dispose()
    release.resolve()
    await flush()
    await agent.whenIdle()
    expect(rolloverSends(agent.session)).toHaveLength(0)
    // The disposed sweep stops at its flag. Without it, the reads after the lookup hit the inactive context and log a skip.
    expect(warn.mock.calls.filter(([line]) => String(line).includes('skipped session'))).toHaveLength(0)
  })

  it('keeps one sweep in flight while a skill lookup is pending, and sends once when it is released', async () => {
    const { ctx, agent, session } = await rig({
      id: 'one-in-flight',
      config: { idleRolloverTickMs: 1, idleRolloverAfterMs: 1 },
    })
    await followup(agent, 'first question')

    const skills = ctx.get('skills') as unknown as { list(options: unknown): Promise<unknown> }
    const real = skills.list.bind(skills)
    const release = deferred()
    const lookup = vi.spyOn(skills, 'list').mockImplementation(async options => {
      await release.promise
      return real(options)
    })

    // Five one-millisecond ticks elapse while the first lookup waits.
    await advance(5)
    // One lookup in the window. The call is also the control that a tick reached the lookup.
    expect(lookup).toHaveBeenCalledTimes(1)

    release.resolve()
    await flush()
    await agent.whenIdle()
    expect(rolloverSends(session)).toHaveLength(1)
  })

  it('reads the skill gesture the same way the decision does, in message order', () => {
    expect(slashGestureNames('/rollover and /a-b-c')).toEqual(['rollover', 'a-b-c'])
  })

  it.each(['', '/', '/rollover', 'run /rollover now', 'x/rollover', '/Rollover', '/-x', '/x-', '/a-b-c'])(
    'agrees with the decision grammar on %j',
    text => {
      expect(hasSlashGesture(text)).toBe(slashGestureNames(text).length > 0)
    },
  )
})
