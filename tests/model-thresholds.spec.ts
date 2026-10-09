/**
 * Per-model absolute rollover points.
 *
 * A `modelThresholds` entry keyed by a routed model id replaces the ratio-based
 * reminder and rollover points for that model only. Every other model keeps
 * `reminderThresholdRatio` and `thresholdRatio`, measured against its own
 * context window.
 *
 * @module tests/model-thresholds
 */

import { describe, expect, it } from 'vitest'
import { resolveConfig, rolloverPointsFor } from '../src/config.ts'
import type { RolloverConfig } from '../src/config.ts'
import { countRollovers } from '../src/rollover.ts'

/** Record every warning the engine logs, while still forwarding it. */
function captureWarnings(ctx: { logger: { warn: (message: string) => void } }): string[] {
  const warnings: string[] = []
  const original = ctx.logger.warn.bind(ctx.logger)
  ctx.logger.warn = (message: string): void => {
    warnings.push(message)
    original(message)
  }
  return warnings
}

/** The once-per-turn warning logged when pressure crosses the rollover point. */
function isPressureWarning(message: string): boolean {
  return message.includes('automatic rollover is disabled')
}
import {
  engineHarness,
  followup,
  MODEL,
  reminderTexts,
  ScriptedAdapter,
  toolCall,
  usageResponse,
} from './harness.ts'

// Every case is an independent session; these ids must not collide in one process.
let caseId = 0
const sessionId = (label: string): string => `model-thresholds-${label}-${(caseId += 1)}`

const QWEN = 'strata/qwen-strata'

/**
 * A tool-call response that reports its own usage, as every real model response
 * does. Without the usage figure the token meter falls back to a text estimate
 * for that step, and the estimate sits far below the points under test.
 */
function toolCallWithUsage(name: string, argumentsJson: string, inputTokens: number): ReturnType<typeof toolCall> {
  const chunks = toolCall(name, argumentsJson)
  return [...chunks.slice(0, -1), { type: 'usage', usage: { inputTokens, outputTokens: 5 } }, ...chunks.slice(-1)]
}

describe('rolloverPointsFor', () => {
  it('derives both points from the ratios when the routed model has no entry', () => {
    const config = resolveConfig({})
    expect(rolloverPointsFor(config, 262_144, QWEN)).toEqual({
      reminderTokens: 104_857,
      rolloverTokens: 235_929,
    })
  })

  it('uses the entry verbatim for its own model, whatever the window', () => {
    const config = resolveConfig({
      modelThresholds: { [QWEN]: { thresholdTokens: 200_000, reminderThresholdTokens: 157_286 } },
    })
    expect(rolloverPointsFor(config, 262_144, QWEN)).toEqual({
      reminderTokens: 157_286,
      rolloverTokens: 200_000,
    })
  })

  it('keeps the ratio points for every other model, including prototype-style names', () => {
    const config = resolveConfig({
      modelThresholds: { [QWEN]: { thresholdTokens: 200_000, reminderThresholdTokens: 157_286 } },
    })
    const ratioPoints = { reminderTokens: 400_000, rolloverTokens: 900_000 }
    expect(rolloverPointsFor(config, 1_000_000, 'glm')).toEqual(ratioPoints)
    expect(rolloverPointsFor(config, 1_000_000, 'constructor')).toEqual(ratioPoints)
  })
})

describe('modelThresholds validation', () => {
  it('rejects a reminder point above the rollover point for the same model', () => {
    expect(() => resolveConfig({
      modelThresholds: { [QWEN]: { thresholdTokens: 100, reminderThresholdTokens: 200 } },
    })).toThrow(/reminderThresholdTokens .* must not exceed thresholdTokens/)
  })

  it('rejects token points that are not positive integers', () => {
    for (const bad of [0, -5, 1.5, Number.NaN]) {
      expect(() => resolveConfig({
        modelThresholds: { [QWEN]: { thresholdTokens: bad, reminderThresholdTokens: 1 } },
      })).toThrow(/thresholdTokens must be a positive integer/)
    }
  })

  it('rejects a blank model id', () => {
    expect(() => resolveConfig({
      modelThresholds: { ' ': { thresholdTokens: 10, reminderThresholdTokens: 5 } },
    })).toThrow(/modelThresholds key must be a non-empty string/)
  })
})

describe('per-model points in the live pipeline', () => {
  // The harness advertises a 100,000-token window for the session's model. The
  // ratio points for that window are a 40,000-token reminder and a 90,000-token
  // rollover, so each case below sits between an entry point and a ratio point.

  it('reminds at the entry point for the configured model, below the ratio point', async () => {
    const { ctx, agent, session } = await engineHarness(sessionId('remind-own'), {
      modelThresholds: { [MODEL]: { thresholdTokens: 30_000, reminderThresholdTokens: 20_000 } },
    })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponse('answer 1', 25_000),
      usageResponse('answer 2', 26_000),
    ]))

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')
    expect(reminderTexts(session)).toHaveLength(1)
  })

  it('does not apply an entry keyed to a different model', async () => {
    const { ctx, agent, session } = await engineHarness(sessionId('remind-other'), {
      modelThresholds: { [QWEN]: { thresholdTokens: 30_000, reminderThresholdTokens: 20_000 } },
    })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponse('answer 1', 25_000),
      usageResponse('answer 2', 26_000),
    ]))

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')
    expect(reminderTexts(session)).toHaveLength(0)
  })

  it('warns at the entry point for the configured model, and never rolls over on pressure', async () => {
    const { ctx, agent, session } = await engineHarness(sessionId('roll-own'), {
      retainTokens: 0,
      modelThresholds: { [MODEL]: { thresholdTokens: 30_000, reminderThresholdTokens: 20_000 } },
    })
    const warnings = captureWarnings(ctx)
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponse(`research answer one ${'detail '.repeat(600)}`, 35_000),
      toolCallWithUsage('get_context_remaining', '{}', 35_500),
      usageResponse(`research answer two ${'detail '.repeat(600)}`, 36_000),
    ]))

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')
    // 35,000 is above the 30,000 entry point. Both pre-steps of turn two share
    // one turn, so exactly one warning fires, and nothing rolls over on pressure.
    expect(countRollovers(session)).toBe(0)
    expect(warnings.filter(isPressureWarning)).toHaveLength(1)
  })

  it('keeps the ratio rollover point when no entry matches', async () => {
    // The same usage as the case above: 35,000 is below the 90,000 ratio point.
    const { ctx, agent, session } = await engineHarness(sessionId('roll-ratio'), {
      retainTokens: 0,
    })
    const warnings = captureWarnings(ctx)
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponse(`research answer one ${'detail '.repeat(600)}`, 35_000),
      toolCallWithUsage('get_context_remaining', '{}', 35_500),
      usageResponse(`research answer two ${'detail '.repeat(600)}`, 36_000),
    ]))

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')
    expect(countRollovers(session)).toBe(0)
    expect(warnings.filter(isPressureWarning)).toHaveLength(0)
  })

  it('reports headroom to the entry rollover point in get_context_remaining', async () => {
    // Identical script and usage in both arms, so the used-token figure is the
    // same; only the rollover point differs (30,000 entry, 90,000 ratio).
    const headroom = async (label: string, config: Partial<RolloverConfig>): Promise<number> => {
      const { ctx, agent } = await engineHarness(sessionId(label), config)
      const adapter = new ScriptedAdapter([
        usageResponse('answer 1', 5_000),
        toolCallWithUsage('get_context_remaining', '{}', 5_500),
        usageResponse('answer 2', 6_000),
      ])
      ctx.llm.registerAdapter(['mock'], adapter)
      await followup(agent, 'turn one')
      await followup(agent, 'turn two')
      const lastRequest = JSON.stringify(adapter.recorded.at(-1)?.messages ?? [])
      const match = /rollover point: ~(\d+) tokens/.exec(lastRequest)
      expect(match).not.toBeNull()
      return Number(match?.[1])
    }

    const ratio = await headroom('headroom-ratio', {})
    const entry = await headroom('headroom-entry', {
      modelThresholds: { [MODEL]: { thresholdTokens: 30_000, reminderThresholdTokens: 20_000 } },
    })
    expect(ratio - entry).toBe(60_000)
  })
})
