/**
 * The warning logged when a second automatic pressure check in one turn still
 * finds usage above the threshold.
 *
 * A routed model with no `modelThresholds` entry keeps the ratio wording. A
 * routed model whose entry supplied the point is named as the rollover point.
 *
 * @module tests/pressure-warning-text
 */

import { describe, expect, it } from 'vitest'
import { countRollovers } from '../src/rollover.ts'
import { engineHarness, followup, MODEL, ScriptedAdapter, toolCall, usageResponse } from './harness.ts'

/** The warning text for a ratio-based point, exactly as logged. */
const RATIO_WARNING = "context rollover: usage is still above the automatic threshold after this turn's pressure rollover (tail + per-step context likely exceed thresholdRatio * contextWindow); skipping further automatic rollovers this turn"

/** The warning text when a per-model entry supplied the point, exactly as logged. */
const MODEL_WARNING = "context rollover: usage is still above the automatic threshold after this turn's pressure rollover (tail + per-step context likely exceed the rollover point); skipping further automatic rollovers this turn"

/** Record every warning the engine logs through the mounted context's logger. */
function recordWarnings(ctx: { logger: { warn: (message: string) => void } }): string[] {
  const warnings: string[] = []
  ctx.logger.warn = (message: string): void => {
    warnings.push(message)
  }
  return warnings
}

/**
 * Drive the repeat-check shape. Turn two makes three requests, so three
 * pre-steps: the first is refused by the shrink guard, the second rolls over,
 * and the third is the repeat check that is still above the threshold.
 * The rollover count is asserted so the shape is known to be the intended one.
 */
async function runRepeatCheck(
  id: string,
  config: Parameters<typeof engineHarness>[1],
): Promise<string[]> {
  const { ctx, agent, session } = await engineHarness(id, config)
  const warnings = recordWarnings(ctx)
  ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
    usageResponse(`research answer one ${'detail '.repeat(600)}`, 5000),
    toolCall('get_context_remaining', '{}', 'c1'),
    toolCall('get_context_remaining', '{}', 'c2'),
    usageResponse(`research answer two ${'detail '.repeat(600)}`, 6000),
  ]))
  await followup(agent, 'turn one')
  await followup(agent, 'turn two')
  expect(countRollovers(session)).toBe(1)
  return warnings.filter(message => message.includes('still above'))
}

describe('pressure warning text on the repeat check', () => {
  it('logs the ratio wording exactly when no modelThresholds entry applies', async () => {
    const warnings = await runRepeatCheck('warning-ratio-default', {
      thresholdRatio: 0.001,
      reminderThresholdRatio: 0.001,
      retainTokens: 0,
    })
    expect(warnings).toEqual([RATIO_WARNING])
  })

  it('keeps the ratio wording when the modelThresholds entry is for another model', async () => {
    const warnings = await runRepeatCheck('warning-ratio-other-entry', {
      thresholdRatio: 0.001,
      reminderThresholdRatio: 0.001,
      retainTokens: 0,
      modelThresholds: {
        'other-model': { thresholdTokens: 5000, reminderThresholdTokens: 1000 },
      },
    })
    expect(warnings).toEqual([RATIO_WARNING])
  })

  it('names the rollover point when a modelThresholds entry supplied the point', async () => {
    // The entry sets the same 100-token point the ratio would give, so only the
    // source of the point differs between this case and the ratio cases.
    const warnings = await runRepeatCheck('warning-model-entry', {
      thresholdRatio: 0.001,
      reminderThresholdRatio: 0.001,
      retainTokens: 0,
      modelThresholds: {
        [MODEL]: { thresholdTokens: 100, reminderThresholdTokens: 50 },
      },
    })
    expect(warnings).toEqual([MODEL_WARNING])
  })
})
