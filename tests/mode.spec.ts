/**
 * The rollover `mode` setting: the upstream default, load-time rejection of an
 * unknown value, and the plumbing that carries the resolved mode to the
 * reminder, guidance, and checkpoint-render call sites.
 *
 * The structured-handoff wording lands in a later change, so both modes emit
 * the upstream text today. The plumbing is therefore proven by the inputs each
 * real builder receives, not by different output. Each builder is wrapped in a
 * pass-through spy: it still runs the real code, and the spy only records the
 * arguments of each call.
 *
 * @module tests/mode.spec
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { buildCheckpointText } from '../src/checkpoint.ts'
import { resolveConfig } from '../src/config.ts'
import type { RolloverMode } from '../src/config.ts'
import { buildContextManagementGuidance } from '../src/guidance.ts'
import { ContextRolloverEngine } from '../src/index.ts'
import { buildReminderText } from '../src/reminder.ts'
import { countRollovers } from '../src/rollover.ts'
import {
  closedConversation,
  engineHarness,
  followup,
  mountTestContext,
  newContextCall,
  reminderTexts,
  ScriptedAdapter,
  seedExchanges,
  textResponse,
  usageResponse,
} from './harness.ts'

vi.mock('../src/guidance.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/guidance.ts')>()
  return { ...actual, buildContextManagementGuidance: vi.fn(actual.buildContextManagementGuidance) }
})

vi.mock('../src/reminder.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/reminder.ts')>()
  return { ...actual, buildReminderText: vi.fn(actual.buildReminderText) }
})

vi.mock('../src/checkpoint.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/checkpoint.ts')>()
  return { ...actual, buildCheckpointText: vi.fn(actual.buildCheckpointText) }
})

const guidanceSpy = vi.mocked(buildContextManagementGuidance)
const reminderSpy = vi.mocked(buildReminderText)
const checkpointSpy = vi.mocked(buildCheckpointText)

describe('rollover mode setting', () => {
  beforeEach(() => {
    guidanceSpy.mockClear()
    reminderSpy.mockClear()
    checkpointSpy.mockClear()
  })

  it('defaults to upstream when the key is omitted', async () => {
    expect(resolveConfig({}).mode).toBe('upstream')

    const { engine } = await engineHarness('mode-default')
    expect(engine.config.mode).toBe('upstream')
    expect(guidanceSpy).toHaveBeenCalledWith('upstream')
  })

  it('rejects an unknown mode at load with a named TypeError', async () => {
    for (const value of ['bogus', 'structured_handoff', 'Upstream', null]) {
      const mode = value as unknown as RolloverMode
      expect(() => resolveConfig({ mode })).toThrow(TypeError)
      expect(() => resolveConfig({ mode })).toThrow(
        `context-rollover: mode must be 'upstream' or 'structured-handoff', got ${String(value)}`,
      )
    }

    // The engine refuses the same value at construction, so a bad row never mounts.
    const ctx = await mountTestContext()
    expect(() => new ContextRolloverEngine(ctx, { mode: 'bogus' as unknown as RolloverMode }))
      .toThrow(/^context-rollover: mode must be 'upstream' or 'structured-handoff', got bogus$/)
  })

  it('resolves structured-handoff and passes it to the guidance builder', async () => {
    const { engine } = await engineHarness('mode-guidance', { mode: 'structured-handoff' })

    expect(engine.config.mode).toBe('structured-handoff')
    expect(guidanceSpy).toHaveBeenCalledWith('structured-handoff')
  })

  it('passes structured-handoff to the reminder builder', async () => {
    const { ctx, agent, session } = await engineHarness('mode-reminder', {
      mode: 'structured-handoff',
      thresholdRatio: 0.5,
      reminderThresholdRatio: 0.01,
    })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponse('answer 1', 5000),
      usageResponse('answer 2', 6000),
    ]))

    // Turn one anchors the meter; turn two crosses the reminder threshold.
    await followup(agent, 'turn one')
    await followup(agent, 'turn two')

    expect(reminderTexts(session)).toHaveLength(1)
    expect(reminderSpy).toHaveBeenCalledTimes(1)
    expect(reminderSpy).toHaveBeenCalledWith(expect.objectContaining({ mode: 'structured-handoff' }))
  })

  it('passes structured-handoff to the checkpoint render on a model-requested rollover', async () => {
    const { ctx, agent, session } = await engineHarness('mode-model-requested', { mode: 'structured-handoff' })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      ...Array.from({ length: 20 }, (_unused, index) => textResponse(`finding ${index} details`)),
      newContextCall('{"handoff":"Continue the work."}'),
      textResponse('continuing'),
    ]))

    await seedExchanges(agent, 20)
    await followup(agent, 'Research is done; roll over and continue.')

    expect(countRollovers(session)).toBe(1)
    expect(checkpointSpy).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'structured-handoff',
      reason: 'model-requested',
    }))
  })

  it('passes structured-handoff to the checkpoint render on a manual rollover', async () => {
    const { ctx, engine, agent, session } = await engineHarness('mode-manual', { mode: 'structured-handoff' })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter(
      Array.from({ length: 20 }, (_unused, index) => textResponse(`investigation step ${index} result`)),
    ))

    await seedExchanges(agent, 20)
    await followup(agent, 'investigate the thing')
    const compacted = await engine.compactNow(agent, new AbortController().signal)

    expect(compacted).not.toBeNull()
    expect(countRollovers(session)).toBe(1)
    expect(checkpointSpy).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'structured-handoff',
      reason: 'manual',
    }))
  })

  it('passes structured-handoff to the checkpoint render on a forced-span rollover', async () => {
    const { engine } = await engineHarness('mode-region', { mode: 'structured-handoff' })
    const session = closedConversation(8)
    session.append('turn/start', { turn: 5 })
    const fakeAgent = { session, options: {} } as Agent
    const nodes = session.surface.nodes
    const start = nodes[0]
    const end = nodes[nodes.length - 1]
    if (start === undefined || end === undefined) throw new Error('expected surface nodes')

    await engine.compactRegion(start, end, fakeAgent)

    expect(countRollovers(session)).toBe(1)
    expect(checkpointSpy).toHaveBeenCalledWith(expect.objectContaining({
      mode: 'structured-handoff',
      reason: 'manual',
    }))
  })
})
