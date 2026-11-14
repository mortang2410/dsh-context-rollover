/**
 * The idle reopen end to end.
 *
 * A candidate whose agent is not live is resumed through the real agent loop
 * and the harness persistence backend: the stored session is opened for write,
 * its log is replayed, the preset composition mounts, the configured message is
 * sent as a direct user message, the turn runs against the scripted adapter,
 * and the resumed agent is disposed again. Only the three services that name a
 * preset and a default model are stubbed, because the host mounts them from its
 * own composition.
 *
 * @module tests/idle-reopen
 */

import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { CandidateStore } from '../src/candidates.ts'
import {
  ABOVE_FLOOR,
  AFTER_MS,
  FLOOR,
  T0,
  TICK_MS,
  advance,
  cleanupReopen,
  openRig,
  openStoredTurn,
  recordAt,
  settle,
  storedEvents,
  useReopenClock,
  userTexts,
} from './reopen-rig.ts'
import { MODEL, ScriptedAdapter, followup, usageResponse } from './harness.ts'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'

/** A scripted adapter whose second and later requests wait for the test to release them. */
class GatedScriptedAdapter extends ScriptedAdapter {
  readonly released = Promise.withResolvers<void>()
  private requestCount = 0

  override stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.recordRequest(options)
    this.requestCount += 1
    return this.answerOnce(this.requestCount > 1)
  }

  private async *answerOnce(gated: boolean): AsyncIterable<StreamChunk> {
    if (gated) await this.released.promise
    yield* usageResponse('answer', ABOVE_FLOOR)
  }
}

beforeEach(useReopenClock)
afterEach(cleanupReopen)

describe('idle reopen', () => {
  it('reopens a stored candidate with no live agent, sends the message, and disposes the agent again', async () => {
    const rig = await openRig()
    const sessionId = SessionId('reopened')
    const handle = await openStoredTurn(rig.ctx, sessionId)
    await advance(TICK_MS)
    expect(recordAt(rig.candidatePath, sessionId)?.lastOutcome).toBe('marked')
    await handle.dispose()
    expect(rig.ctx.agents.get(sessionId)).toBeUndefined()

    await advance(AFTER_MS + TICK_MS)
    await settle(() => recordAt(rig.candidatePath, sessionId)?.lastOutcome === 'sent')

    const record = recordAt(rig.candidatePath, sessionId)
    expect(record?.lastOutcome).toBe('sent')
    expect(record?.totalTokens ?? 0).toBeGreaterThan(FLOOR)
    expect(record?.committedRolloverCount).toBe(0)

    // The message reached the model, not just the log.
    const carried = rig.adapter.recorded.some(request => request.messages.some(message =>
      message.content.some(block => block.type === 'text' && block.text.includes('/rollover'))))
    expect(carried).toBe(true)

    // The reopened agent was disposed again, so the sweep leaves no live agent behind.
    await settle(() => rig.ctx.agents.get(sessionId) === undefined)
    expect(rig.ctx.agents.get(sessionId)).toBeUndefined()
    const events = await storedEvents(rig.ctx, sessionId)
    expect(userTexts(events, '/rollover')).toBe(1)
  })

  it('stops reopening a session that no longer exists and removes its record', async () => {
    const rig = await openRig()
    const sessionId = SessionId('missing')
    // A record whose session was never stored: the first lookup must refuse, not warn forever.
    new CandidateStore({ path: rig.candidatePath, warn: () => {} }).put({
      sessionId,
      lastRealActivityAt: T0,
      totalTokens: ABOVE_FLOOR,
      committedRolloverCount: 0,
      lastOutcome: 'marked',
    })

    await advance(AFTER_MS + TICK_MS)
    await settle(() => recordAt(rig.candidatePath, sessionId) === undefined)
    expect(recordAt(rig.candidatePath, sessionId)).toBeUndefined()
  })

  it('never reopens a session while an agent with that id is live', async () => {
    const rig = await openRig()
    const sessionId = SessionId('live-agent')
    const handle = await openStoredTurn(rig.ctx, sessionId)
    await advance(TICK_MS)
    // Queued work keeps the live path silent, so any send would have to come from a reopen.
    handle.agent.inbox.append('next-turn', createUserMessage({
      content: [{ type: 'text', text: 'queued' }],
      source: { kind: 'user' },
    }))
    const resume = vi.spyOn(rig.ctx.agents, 'resume')

    await advance(AFTER_MS + TICK_MS)
    await settle(() => false, 20)

    expect(resume).not.toHaveBeenCalled()
    expect(rig.ctx.agents.get(sessionId)).toBe(handle.agent)
    expect(recordAt(rig.candidatePath, sessionId)?.lastOutcome).toBe('marked')
  })

  it('skips a session that exists without an agent and keeps its record', async () => {
    const rig = await openRig()
    const sessionId = SessionId('loaded-only')
    // A loaded session with no agent is what another consumer holds; the sweep must not resume over it.
    rig.ctx.sessions.create(sessionId)
    new CandidateStore({ path: rig.candidatePath, warn: () => {} }).put({
      sessionId,
      lastRealActivityAt: T0,
      totalTokens: ABOVE_FLOOR,
      committedRolloverCount: 0,
      lastOutcome: 'marked',
    })
    const resume = vi.spyOn(rig.ctx.agents, 'resume')

    await advance(AFTER_MS + TICK_MS)
    await settle(() => false, 20)

    expect(resume).not.toHaveBeenCalled()
    expect(recordAt(rig.candidatePath, sessionId)?.lastOutcome).toBe('marked')
  })

  it('never reopens a candidate whose stored header marks a subagent', async () => {
    const rig = await openRig()
    const sessionId = SessionId('subagent-worker')
    const handle = await rig.ctx.agents.create({
      sessionId,
      meta: { origin: 'subagent', delegationDepth: 1 },
      agentOptions: { provider: MODEL, model: MODEL },
    })
    await handle.dispose()
    new CandidateStore({ path: rig.candidatePath, warn: () => {} }).put({
      sessionId,
      lastRealActivityAt: T0,
      totalTokens: ABOVE_FLOOR,
      committedRolloverCount: 0,
      lastOutcome: 'marked',
    })
    const resume = vi.spyOn(rig.ctx.agents, 'resume')

    await advance(AFTER_MS + TICK_MS)
    await settle(() => false, 20)

    expect(resume).not.toHaveBeenCalled()
    expect(recordAt(rig.candidatePath, sessionId)?.lastOutcome).toBe('marked')
  })

  it('removes the record when the fired turn committed a rollover', async () => {
    const rig = await openRig({
      config: {
        automaticRollover: true,
        retainTokens: 0,
        automaticRolloverRetainTokens: 200,
        // The session has no working directory, so the notes/handoff
        // containment check can only prove the store safe with an absolute
        // handoff root. Nothing is written under it.
        handoffDir: join(tmpdir(), 'dsh-idle-reopen-handoff'),
      },
    })
    const sessionId = SessionId('committed')
    const handle = await rig.ctx.agents.create({
      sessionId,
      agentOptions: { provider: MODEL, model: MODEL },
    })
    // Several turns, so the seeded surface has a span before the retained tail.
    for (let index = 0; index < 5; index += 1) await followup(handle.agent, `question ${index} ${'detail '.repeat(80)}`)
    await advance(TICK_MS)
    expect(recordAt(rig.candidatePath, sessionId)?.lastOutcome).toBe('marked')
    // The fired turn crosses this point at its pre-step, so the commit lands during
    // the reopen; the point sits clearly below the measured size so the resumed
    // session's slightly different seed cannot fall short of it.
    const points = rig.engine.config.modelThresholds[MODEL]
    if (points === undefined) throw new Error('the test model has no rollover entry')
    points.thresholdTokens = Math.max(1, rig.ctx.tokenMeter.measure(handle.agent.session).totalTokens - 50_000)
    await handle.dispose()

    await advance(AFTER_MS + TICK_MS)
    await settle(() => recordAt(rig.candidatePath, sessionId) === undefined)
    const events = await storedEvents(rig.ctx, sessionId)
    expect(recordAt(rig.candidatePath, sessionId)).toBeUndefined()
    expect(events.filter(event => event.type === 'compaction/end').length).toBeGreaterThanOrEqual(1)
  })

  it('keeps the record when the stored preset does not mount, and warns once', async () => {
    const rig = await openRig()
    const sessionId = SessionId('preset-broken')
    const handle = await openStoredTurn(rig.ctx, sessionId)
    await advance(TICK_MS)
    expect(recordAt(rig.candidatePath, sessionId)?.lastOutcome).toBe('marked')
    await handle.dispose()

    // The registry resolves the stored preset and then refuses the mount, the
    // way a diagnostic-broken preset does with `agent-preset/invalid`.
    const registry = rig.ctx.get('agentPresets')
    if (registry === undefined) throw new Error('the rig provides the preset registry')
    const mount = vi.fn(async (): Promise<never> => {
      const error = new Error('agent preset "standard" is invalid') as Error & { code?: string }
      error.code = 'agent-preset/invalid'
      throw error
    })
    registry.mount = mount
    const warn = vi.spyOn(rig.ctx.logger, 'warn')

    // Exactly one tick crosses the threshold, so the assertion reads the failed
    // reopen itself and not a later, disarmed retry.
    await advance(AFTER_MS - TICK_MS + 1)
    await settle(() => recordAt(rig.candidatePath, sessionId)?.lastOutcome === 'reopen-failed')

    expect(mount).toHaveBeenCalledTimes(1)
    expect(recordAt(rig.candidatePath, sessionId)?.lastOutcome).toBe('reopen-failed')
    await settle(() => rig.ctx.agents.get(sessionId) === undefined)
    expect(rig.ctx.agents.get(sessionId)).toBeUndefined()
    const failures = warn.mock.calls.filter(([line]) => String(line).includes('reopening session'))
    expect(failures).toHaveLength(1)
  })

  it('keeps the record when the resumed turn fails, and disposes the handle', async () => {
    const rig = await openRig()
    const sessionId = SessionId('turn-failed')
    const handle = await openStoredTurn(rig.ctx, sessionId)
    await advance(TICK_MS)
    await handle.dispose()
    const real = rig.ctx.agents.resume.bind(rig.ctx.agents)
    vi.spyOn(rig.ctx.agents, 'resume').mockImplementation(async options => {
      const resumed = await real(options)
      vi.spyOn(resumed.agent, 'whenIdle').mockRejectedValue(new Error('the turn failed'))
      return resumed
    })

    // Exactly one tick crosses the threshold, so the assertion reads the outcome
    // of the failed reopen itself and not of a later, disarmed retry.
    await advance(AFTER_MS - TICK_MS + 1)
    await settle(() => recordAt(rig.candidatePath, sessionId)?.lastOutcome === 'reopen-failed')

    expect(recordAt(rig.candidatePath, sessionId)?.lastOutcome).toBe('reopen-failed')
    await settle(() => rig.ctx.agents.get(sessionId) === undefined)
    expect(rig.ctx.agents.get(sessionId)).toBeUndefined()
  })

  it('keeps the record when the send throws, and disposes the handle', async () => {
    const rig = await openRig()
    const sessionId = SessionId('send-failed')
    const handle = await openStoredTurn(rig.ctx, sessionId)
    await advance(TICK_MS)
    await handle.dispose()
    const real = rig.ctx.agents.resume.bind(rig.ctx.agents)
    vi.spyOn(rig.ctx.agents, 'resume').mockImplementation(async options => {
      const resumed = await real(options)
      vi.spyOn(resumed.agent, 'followup').mockImplementation(() => {
        throw new Error('the queue refused the message')
      })
      return resumed
    })

    await advance(AFTER_MS + TICK_MS)
    await settle(() => recordAt(rig.candidatePath, sessionId)?.lastOutcome === 'reopen-failed')

    expect(recordAt(rig.candidatePath, sessionId)?.lastOutcome).toBe('reopen-failed')
    await settle(() => rig.ctx.agents.get(sessionId) === undefined)
    expect(rig.ctx.agents.get(sessionId)).toBeUndefined()
  })

  it('treats a turn that outlives the ten-minute bound as a failed reopen', async () => {
    const adapter = new GatedScriptedAdapter([usageResponse('answer', ABOVE_FLOOR)])
    const rig = await openRig({ adapter })
    const sessionId = SessionId('turn-slow')
    const handle = await openStoredTurn(rig.ctx, sessionId)
    await advance(TICK_MS)
    await handle.dispose()
    // A ten-minute bound is too long to sit through: fire that timer at once and
    // leave every other timeout on the real clock.
    const realSetTimeout = globalThis.setTimeout
    vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      handler: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ) => {
      if (delay === 600_000) {
        return realSetTimeout(() => {
          if (typeof handler === 'function') handler(...args)
        }, 0)
      }
      return realSetTimeout(handler, delay, ...args)
    }) as typeof setTimeout)

    await advance(AFTER_MS - TICK_MS + 1)
    await settle(() => recordAt(rig.candidatePath, sessionId)?.lastOutcome === 'reopen-failed')

    expect(recordAt(rig.candidatePath, sessionId)?.lastOutcome).toBe('reopen-failed')
    // The dispose waits for the still-running turn, so release it; the handle then
    // finishes removing the agent, which is the disposal the contract promises.
    adapter.released.resolve()
    await settle(() => rig.ctx.agents.get(sessionId) === undefined)
    expect(rig.ctx.agents.get(sessionId)).toBeUndefined()
  })
})
