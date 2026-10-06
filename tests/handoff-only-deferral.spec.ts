/**
 * The deferral contract under `handoffOnly`: a pre-step whose tail cut is
 * unbalanced selects no span instead of retaining an incomplete tool unit, and
 * that deferral must not lose the rollover the model asked for.
 *
 * The engine used to clear the pending request before it ran the rollover, so a
 * deferral dropped it silently. These cases pin the corrected ordering: the
 * request stays pending until a rollover actually commits.
 *
 * @module tests/handoff-only-deferral.spec
 */

import { describe, expect, it } from 'vitest'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createToolResultMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { appendExchange, engineHarness } from './harness.ts'
import { countRollovers } from '../src/rollover.ts'

/**
 * Drive one real `agent/pre-step` through the agent's own event dispatch, the
 * way the agent loop does, so the engine's listener runs exactly as it would.
 * @param ctx - mounted test context.
 * @param agent - agent whose pre-step is dispatched.
 * @returns the decision the waterfall resolved to.
 */
function preStep(ctx: Awaited<ReturnType<typeof engineHarness>>['ctx'], agent: Awaited<ReturnType<typeof engineHarness>>['agent']) {
  return agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [], turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
  )
}

/** The engine's own pending-request map, read through the private field. */
function pendingOf(engine: Awaited<ReturnType<typeof engineHarness>>['engine']): Map<string, unknown> {
  return (engine as unknown as { pendingRollovers: Map<string, unknown> }).pendingRollovers
}

describe('a deferred model-requested rollover', () => {
  it('keeps the request pending while the tail cut is unbalanced, then crosses on the next pre-step', async () => {
    const { ctx, engine, agent, session } = await engineHarness(
      'deferral-retains-request',
      { handoffOnly: true },
    )
    // Enough closed conversation that a rollover has a span worth replacing.
    for (let turn = 1; turn <= 8; turn += 1) appendExchange(session, turn, `exchange ${turn} ${'detail '.repeat(30)}`)

    // Simulate the model's own call being in flight: the assistant message that
    // carries the `new_context` call is on the surface with no result yet, which
    // is exactly the state the tool's own `execute` observes.
    session.append('turn/start', { turn: 9 })
    session.append('step/start', { turn: 9, step: 1 })
    session.append('assistant/message', {
      turn: 9,
      step: 1,
      stream: [],
      message: createAssistantMessage({
        content: [{ type: 'tool-call', id: ToolCallId('t9'), name: 'new_context', arguments: '{"handoff_path":"/workspace/HANDOFF-x.md"}' }],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })

    const pending = pendingOf(engine)
    pending.set(session.id, { handoff: '# Handoff\n\nThe document body.\n', handoffPath: '/workspace/HANDOFF-x.md' })

    const before = countRollovers(session)
    await preStep(ctx, agent)
    // The unbalanced tail deferred: no rollover happened...
    expect(countRollovers(session)).toBe(before)
    // ...and, critically, the model's request is still pending. Clearing it here
    // would lose the boundary the model asked for, because the next pre-step is
    // the one that can cross.
    expect(pending.has(session.id)).toBe(true)

    // The result the host guarantees lands, which needs the durable `tool/call`
    // the loop records before it executes the call.
    const call = session.append('tool/call', {
      turn: 9,
      step: 1,
      callId: ToolCallId('t9'),
      name: 'new_context',
      arguments: '{"handoff_path":"/workspace/HANDOFF-x.md"}',
    })
    session.append('tool/result', {
      turn: 9,
      step: 1,
      message: createToolResultMessage({
        callId: ToolCallId('t9'),
        content: [{ type: 'text', text: 'accepted' }],
        isError: false,
      }),
    }, { surfaceOp: 'append', sourceEventSeqs: [call.seq] })
    session.append('step/end', { turn: 9, step: 1 })

    await preStep(ctx, agent)
    expect(countRollovers(session)).toBe(before + 1)
    // Honoured, so now it is cleared.
    expect(pending.has(session.id)).toBe(false)
  })

})
