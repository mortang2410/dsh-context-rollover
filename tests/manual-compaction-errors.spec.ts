/**
 * A manual rollover refused for size must report that refusal. The `busy`
 * code and the idle-agent message are for an agent that never became idle, not
 * for a failure inside the rollover itself.
 *
 * @module tests/manual-compaction-errors
 */

import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { engineHarness, seedExchanges } from './harness.ts'

describe('manual rollover failure reporting', () => {
  it('reports a size refusal with its own reason, not as a busy agent', async () => {
    const { ctx, agent, engine } = await engineHarness('manual-size-refusal', {})
    // A notes checkpoint larger than the shadowed exchanges makes the rollover
    // refuse to shrink the surface. That refusal is the failure under test.
    await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('manual-size-note'),
      name: 'notes',
      arguments: { action: 'write', path: 'state.md', text: 'n'.repeat(2000) },
      agent,
    })
    await seedExchanges(agent, 20)

    const failure = await engine.compactNow(agent, new AbortController().signal).then(
      () => undefined,
      (error: unknown) => error,
    )
    expect(failure).toBeInstanceOf(Error)
    const message = (failure as Error).message
    expect(message).toMatch(/not smaller than the shadowed content/)
    expect(message).not.toMatch(/requires an idle agent/)
  })
})
