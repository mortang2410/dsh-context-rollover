/**
 * Runtime-driven safety tests: crossing the rollover point by pressure only
 * warns, a provider context overflow passes through without a rollover or a
 * retry, rollover requested at the turn-stop boundary, and the refused
 * forced-span `compactRegion` call.
 *
 * @module tests/safety.spec
 */

import { describe, expect, it } from 'vitest'

/** Capture the engine's swallowed warnings and failed compaction closes. */
function captureDiagnostics(ctx: { logger: { warn: (message: string) => void } }, session: { snapshotEvents(): readonly unknown[] }): { warnings: string[]; compactionErrors: string[] } {
  const warnings: string[] = []
  const original = ctx.logger.warn.bind(ctx.logger)
  ctx.logger.warn = (message: string): void => {
    warnings.push(message)
    original(message)
  }
  const compactionErrors: string[] = []
  for (const event of session.snapshotEvents()) {
    const data = (event as { type: string; data: { error?: string } }).data
    if ((event as { type: string }).type === 'compaction/end' && typeof data?.error === 'string') {
      compactionErrors.push(data.error)
    }
  }
  return { warnings, compactionErrors }
}

import { CONTEXT_WINDOW_EXCEEDED_CODE, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { countRollovers } from '../src/rollover.ts'
import {
  closedConversation,
  derivedTexts,
  engineHarness,
  errorFinish,
  followup,
  toolCall,
  ScriptedAdapter,
  seedExchanges,
  textResponse,
  usageResponse,
} from './harness.ts'

/** The once-per-turn warning the engine logs when pressure crosses the rollover point. */
function isPressureWarning(message: string): boolean {
  return message.includes('automatic rollover is disabled')
}

describe('pressure above the rollover point', () => {
  it('does not roll over on its own, and keeps the surface as it is', async () => {
    const { ctx, agent, session } = await engineHarness('pressure-auto', {
      // 100 tokens of a 100k window: the first honest reading crosses it.
      thresholdRatio: 0.001,
      reminderThresholdRatio: 0.001,
      retainTokens: 0,
    })
    // Long answers so the surface is large enough to matter. Turn two opens
    // with a tool call, so it makes two model requests.
    const adapter = new ScriptedAdapter([
      usageResponse(`research answer one ${'detail '.repeat(600)}`, 5000),
      toolCall('get_context_remaining', '{}', 'c1'),
      usageResponse(`research answer two ${'detail '.repeat(600)}`, 6000),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'turn one')
    expect(countRollovers(session)).toBe(0)

    const diagnostics = captureDiagnostics(ctx, session)
    await followup(agent, 'turn two')

    // Only the model's own new_context call or manual /compact may roll the
    // context over. Pressure warns once and leaves the surface alone.
    expect(countRollovers(session)).toBe(0)
    const texts = derivedTexts(session).join('\n')
    expect(texts).not.toContain('reason: pressure')
    expect(texts).toContain('turn one')
    expect(texts).toContain('research answer two')
    expect(diagnostics.warnings.filter(isPressureWarning)).toHaveLength(1)
  })
})

describe('pressure warning cadence', () => {
  it('warns at most once per turn when usage stays above the rollover point', async () => {
    const { ctx, agent, session } = await engineHarness('pressure-thrash', {
      // Threshold (200) far below usage: every pre-step is above it.
      thresholdRatio: 0.002,
      reminderThresholdRatio: 0.001,
      retainTokens: 40,
    })
    // Turn 1 anchors usage (2000 >= the ~1100 heuristic estimate, so the
    // meter trusts it). Turn 2 makes TWO model requests (a get_context_remaining
    // call, then a text answer): two pre-steps inside one turn.
    const adapter = new ScriptedAdapter([
      usageResponse(`step answer 0 ${'context '.repeat(80)}`, 2000),
      toolCall('get_context_remaining', '{}', 'c1'),
      usageResponse(`step answer 1 ${'context '.repeat(80)}`, 2100),
      usageResponse(`step answer 2 ${'context '.repeat(80)}`, 2200),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    const diagnostics = captureDiagnostics(ctx, session)

    await followup(agent, 'turn one')
    expect(countRollovers(session)).toBe(0)

    await followup(agent, 'turn two')
    // Two pre-steps in one turn produce one warning, and still no rollover.
    expect(countRollovers(session)).toBe(0)
    expect(diagnostics.warnings.filter(isPressureWarning)).toHaveLength(1)

    // The warning is per turn: the next turn warns once more.
    await followup(agent, 'turn three')
    expect(countRollovers(session)).toBe(0)
    expect(diagnostics.warnings.filter(isPressureWarning)).toHaveLength(2)
    expect(derivedTexts(session).join('\n')).toContain('step answer 2')
  })
})

/** The reason the session's most recent turn recorded when it ended. */
function lastTurnEndReason(session: { snapshotEvents(): readonly unknown[] }): unknown {
  let reason: unknown
  for (const event of session.snapshotEvents()) {
    const typed = event as { type: string; data?: { reason?: unknown } }
    if (typed.type === 'turn/end') reason = typed.data?.reason
  }
  return reason
}

describe('provider context overflow', () => {
  it('passes the error through unchanged: no rollover and no retry', async () => {
    const { ctx, agent, session } = await engineHarness('overflow')
    const adapter = new ScriptedAdapter([
      ...Array.from({ length: 20 }, (_unused, index) => textResponse(`finding ${index} details`)),
      errorFinish('request too large for model context window', CONTEXT_WINDOW_EXCEEDED_CODE),
      textResponse('unreachable: the engine must not retry'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 20)
    await followup(agent, 'next request should overflow')

    // The engine commits nothing, so every earlier exchange stays on the surface.
    expect(countRollovers(session)).toBe(0)
    const texts = derivedTexts(session).join('\n')
    expect(texts).not.toContain('<context-rollover checkpoint>')
    expect(texts).toContain('finding 0 details')
    expect(texts).toContain('next request should overflow')
    // The host ends the turn with the provider's own error code ...
    expect(lastTurnEndReason(session)).toMatchObject({
      kind: 'error',
      error: { code: CONTEXT_WINDOW_EXCEEDED_CODE },
    })
    // ... after exactly one request: the 20 seeded answers plus the overflowing one.
    expect(adapter.requests).toHaveLength(21)
  })
})

describe('rollover at the turn-stop boundary', () => {
  it('consumes a pending request when the turn ends without a further pre-step', async () => {
    const { ctx, agent, engine } = await engineHarness('turn-stopping', { retainTokens: 0 })

    // A session with a closed history and one still-open turn, outside the
    // agent loop: the turn-stopping listener must roll it over on its own.
    const session = closedConversation(12)
    session.append('turn/start', { turn: 7 })
    session.append('step/start', { turn: 7, step: 1 })
    session.append('request/header', {
      header: { config: { provider: 'mock', model: 'mock' } },
      reason: 'resume',
    })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'final exchange before stop' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    session.append('step/end', { turn: 7, step: 1 })
    // Turn 7 stays open: this is the stop boundary under test.
    const fakeAgent = { session, options: {} } as Agent
    const stopHandoff = '# Handoff\n\nStop here and continue from this document.\n'
    const pending = (engine as unknown as {
      pendingRollovers: Map<string, { handoff: string; handoffPath: string }>
    }).pendingRollovers
    pending.set(session.id, { handoff: stopHandoff, handoffPath: '/workspace/HANDOFF-stop.md' })

    // Dispatch through the real agent fiber as the scope carrier, the way
    // the agent loop itself serially dispatches the stop boundary.
    await (ctx as unknown as {
      serial: (carrier: unknown, name: string, payload: unknown) => Promise<void>
    }).serial(agent, 'agent/turn-stopping', {
      agent: fakeAgent,
      turn: 7,
      signal: new AbortController().signal,
    })

    const diagnostics = captureDiagnostics(ctx, session)
    const rolloverCount = countRollovers(session)
    if (rolloverCount !== 1) {
      throw new Error(
        `expected one committed rollover, got ${rolloverCount}; `
        + `warnings: ${diagnostics.warnings.join('; ')}; `
        + `compaction errors: ${diagnostics.compactionErrors.join('; ')}`,
      )
    }
    const texts = derivedTexts(session).join('\n')
    // The pending document is the replacement, with no checkpoint wrapper.
    expect(texts).toContain('Stop here and continue from this document.')
    expect(texts).not.toContain('<context-rollover checkpoint>')
    expect(pending.has(session.id)).toBe(false)
  })
})

describe('forced-span compaction is refused', () => {
  it('throws on a live span and leaves the log and the surface untouched', async () => {
    const { engine } = await engineHarness('compact-region')
    const session = closedConversation(8)
    session.append('turn/start', { turn: 5 })
    const fakeAgent = { session, options: {} } as Agent
    const nodes = session.surface.nodes
    const start = nodes[0]
    const end = nodes[nodes.length - 1]
    if (start === undefined || end === undefined) throw new Error('expected surface nodes')
    const surfaceBefore = [...nodes]
    const textsBefore = derivedTexts(session)
    const refusalMessage = 'context rollover refused: forced span compaction is disabled; '
      + 'the model\'s own new_context call is the only handoff rollover'

    const refusal = await engine.compactRegion(start, end, fakeAgent).then(
      () => null,
      (error: unknown) => error,
    )

    expect(refusal).toBeInstanceOf(Error)
    expect((refusal as Error).message).toBe(refusalMessage)
    expect(countRollovers(session)).toBe(0)
    expect(session.snapshotEvents().map(event => event.type).filter(type => type.startsWith('compaction/')))
      .toEqual([])
    expect(session.surface.nodes).toEqual(surfaceBefore)
    expect(derivedTexts(session)).toEqual(textsBefore)
  })
})
