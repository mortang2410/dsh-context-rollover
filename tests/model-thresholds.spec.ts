/**
 * Per-model absolute rollover points.
 *
 * A `modelThresholds` entry keyed by a routed model id replaces the ratio-based
 * reminder and rollover points for that model only. Every other model keeps
 * `reminderThresholdRatio` and `thresholdRatio`, measured against its own
 * context window. The table does not depend on the rollover mode, so the
 * qwen-strata cases run in both modes.
 *
 * Every case that asserts a ratio point sets `thresholdRatio` 0.9 and
 * `reminderThresholdRatio` 0.4 explicitly. The plugin defaults are 0.9 and 0.75,
 * so no assertion depends on the default reminder ratio.
 *
 * @module tests/model-thresholds
 */

import { describe, expect, it } from 'vitest'
import { resolveConfig, rolloverPointsFor } from '../src/config.ts'
import type { ModelThresholds, RolloverConfig, RolloverMode } from '../src/config.ts'
import { ContextRolloverEngine } from '../src/index.ts'
import { countRollovers } from '../src/rollover.ts'
import {
  engineHarness,
  followup,
  MODEL,
  mountTestContext,
  reminderTexts,
  ScriptedAdapter,
  toolCall,
  usageResponse,
} from './harness.ts'
import type { StreamScript } from './harness.ts'

// Every case is an independent session; these ids must not collide in one process.
let caseId = 0
const sessionId = (label: string): string => `model-thresholds-${label}-${(caseId += 1)}`

const QWEN = 'strata/qwen-strata'
const MODES: readonly RolloverMode[] = ['upstream', 'structured-handoff']
const CHECKPOINT_OPEN = '<context-rollover checkpoint>'

/** The fixture ratios, set explicitly in every case that asserts a ratio point. */
const RATIOS = { thresholdRatio: 0.9, reminderThresholdRatio: 0.4 } as const

/** qwen-strata's context window in tokens. */
const QWEN_WINDOW = 262_144
/** qwen-strata's absolute points: nag at 200,000 tokens, automatic rollover at 250,000 tokens. */
const QWEN_POINTS: ModelThresholds = { thresholdTokens: 250_000, reminderThresholdTokens: 200_000 }
/** qwen-strata's ratio points in its own window: floor(262144 * 0.4) and floor(262144 * 0.9). */
const QWEN_RATIO_NAG = 104_857
const QWEN_RATIO_AUTO = 235_929

/** The fixture ratios plus a per-model table. */
function withEntries(modelThresholds: Record<string, ModelThresholds>): Partial<RolloverConfig> {
  return { ...RATIOS, modelThresholds }
}

/**
 * A tool-call response that reports its own usage, as a host usage report
 * normally does. Without the usage figure the token meter falls back to a text estimate
 * for that step, and the estimate sits far below the points under test.
 */
function toolCallWithUsage(name: string, argumentsJson: string, inputTokens: number): ReturnType<typeof toolCall> {
  const chunks = toolCall(name, argumentsJson)
  return [...chunks.slice(0, -1), { type: 'usage', usage: { inputTokens, outputTokens: 5 } }, ...chunks.slice(-1)]
}

/**
 * One text reply that reports `inputTokens` of usage. The text is long enough
 * that a rollover over these replies replaces a span larger than its checkpoint,
 * which the rollover's shrink guard requires.
 */
function reply(label: string, inputTokens: number): ReturnType<typeof usageResponse> {
  return usageResponse(`${label} ${'detail '.repeat(300)}`, inputTokens)
}

/**
 * The two figures `get_context_remaining` printed in one request: the used
 * tokens and the headroom before the automatic rollover. Their sum is the
 * automatic point, as long as the headroom is not clamped at zero.
 */
function reportedHeadroom(request: readonly unknown[] | undefined): { used: number, remaining: number } {
  const text = JSON.stringify(request ?? [])
  const used = /Context used: ~(\d+) tokens/.exec(text)
  const remaining = /Remaining before the automatic rollover: ~(\d+) tokens/.exec(text)
  if (used === null || remaining === null) throw new Error('the request carries no get_context_remaining report')
  return { used: Number(used[1]), remaining: Number(remaining[1]) }
}

describe('rolloverPointsFor', () => {
  it('derives both points from the ratios when the routed model has no entry', () => {
    const config = resolveConfig({ ...RATIOS })
    expect(rolloverPointsFor(config, QWEN_WINDOW, QWEN)).toEqual({
      reminderTokens: QWEN_RATIO_NAG,
      rolloverTokens: QWEN_RATIO_AUTO,
    })
  })

  it('uses the entry verbatim for its own model, whatever the window', () => {
    const config = resolveConfig(withEntries({ [QWEN]: QWEN_POINTS }))
    expect(rolloverPointsFor(config, QWEN_WINDOW, QWEN)).toEqual({
      reminderTokens: 200_000,
      rolloverTokens: 250_000,
    })
    expect(rolloverPointsFor(config, 1_000_000, QWEN)).toEqual({
      reminderTokens: 200_000,
      rolloverTokens: 250_000,
    })
  })

  it('keeps the ratio points for every other model, including prototype-style names', () => {
    const config = resolveConfig(withEntries({ [QWEN]: QWEN_POINTS }))
    const ratioPoints = { reminderTokens: 400_000, rolloverTokens: 900_000 }
    expect(rolloverPointsFor(config, 1_000_000, 'glm')).toEqual(ratioPoints)
    expect(rolloverPointsFor(config, 1_000_000, 'constructor')).toEqual(ratioPoints)
  })
})

describe('modelThresholds validation', () => {
  it('accepts a reminder point equal to the rollover point', () => {
    expect(() => resolveConfig(withEntries({
      [QWEN]: { thresholdTokens: 100, reminderThresholdTokens: 100 },
    }))).not.toThrow()
  })

  it('rejects a reminder point above the rollover point, naming the key and both values', () => {
    expect(() => resolveConfig(withEntries({
      [QWEN]: { thresholdTokens: 100, reminderThresholdTokens: 200 },
    }))).toThrow(
      `context-rollover: modelThresholds[${QWEN}].reminderThresholdTokens (200) must not exceed thresholdTokens (100)`,
    )
  })

  it('refuses the same entry when the engine is constructed, so a bad row never mounts', async () => {
    const ctx = await mountTestContext()
    expect(() => new ContextRolloverEngine(ctx, withEntries({
      [QWEN]: { thresholdTokens: 100, reminderThresholdTokens: 200 },
    }))).toThrow(
      `context-rollover: modelThresholds[${QWEN}].reminderThresholdTokens (200) must not exceed thresholdTokens (100)`,
    )
  })

  it('rejects token points that are not positive integers, in either field', () => {
    for (const bad of [0, -5, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => resolveConfig(withEntries({
        [QWEN]: { thresholdTokens: bad, reminderThresholdTokens: 1 },
      }))).toThrow(
        `context-rollover: modelThresholds[${QWEN}].thresholdTokens must be a positive integer, got ${String(bad)}`,
      )
      expect(() => resolveConfig(withEntries({
        [QWEN]: { thresholdTokens: 10, reminderThresholdTokens: bad },
      }))).toThrow(
        `context-rollover: modelThresholds[${QWEN}].reminderThresholdTokens must be a positive integer, got ${String(bad)}`,
      )
    }
  })

  it('rejects a blank model id', () => {
    expect(() => resolveConfig({
      modelThresholds: { ' ': { thresholdTokens: 10, reminderThresholdTokens: 5 } },
    })).toThrow(/modelThresholds key must be a non-empty string/)
  })

  it('rejects an entry that is not an object, naming its key', () => {
    for (const bad of [5, 'lower', null, [1, 2]]) {
      expect(() => resolveConfig({
        modelThresholds: { [QWEN]: bad as unknown as ModelThresholds },
      })).toThrow(`context-rollover: modelThresholds[${QWEN}] must be an object`)
    }
  })

  it('rejects a table that is not an object', () => {
    expect(() => resolveConfig({
      modelThresholds: 5 as unknown as Record<string, ModelThresholds>,
    })).toThrow('context-rollover: modelThresholds must be an object keyed by model id, got 5')
  })
})

describe('per-model points in the live pipeline', () => {
  // The harness advertises a 100,000-token window for the session's model. With
  // the fixture ratios, the ratio points for that window are a 40,000-token
  // reminder and a 90,000-token rollover. Each case below sits between an
  // entry point and a ratio point.

  it('reminds at the entry point for the configured model, below the ratio point', async () => {
    const { ctx, agent, session } = await engineHarness(sessionId('remind-own'), withEntries({
      [MODEL]: { thresholdTokens: 30_000, reminderThresholdTokens: 20_000 },
    }))
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponse('answer 1', 25_000),
      usageResponse('answer 2', 26_000),
    ]))

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')
    expect(reminderTexts(session)).toHaveLength(1)
  })

  it('does not apply an entry keyed to a different model', async () => {
    const { ctx, agent, session } = await engineHarness(sessionId('remind-other'), withEntries({
      [QWEN]: { thresholdTokens: 30_000, reminderThresholdTokens: 20_000 },
    }))
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponse('answer 1', 25_000),
      usageResponse('answer 2', 26_000),
    ]))

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')
    expect(reminderTexts(session)).toHaveLength(0)
  })

  it('rolls over at the entry point for the configured model, not at the ratio point', async () => {
    const { ctx, agent, session } = await engineHarness(sessionId('roll-own'), {
      retainTokens: 0,
      ...withEntries({
        [MODEL]: { thresholdTokens: 30_000, reminderThresholdTokens: 20_000 },
      }),
    })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponse(`research answer one ${'detail '.repeat(600)}`, 35_000),
      toolCallWithUsage('get_context_remaining', '{}', 35_500),
      usageResponse(`research answer two ${'detail '.repeat(600)}`, 36_000),
    ]))

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')
    expect(countRollovers(session)).toBe(1)
  })

  it('keeps the ratio rollover point when no entry matches', async () => {
    // The same usage as the case above: 35,000 is below the 90,000 ratio point.
    const { ctx, agent, session } = await engineHarness(sessionId('roll-ratio'), {
      retainTokens: 0,
      ...RATIOS,
    })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponse(`research answer one ${'detail '.repeat(600)}`, 35_000),
      toolCallWithUsage('get_context_remaining', '{}', 35_500),
      usageResponse(`research answer two ${'detail '.repeat(600)}`, 36_000),
    ]))

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')
    expect(countRollovers(session)).toBe(0)
  })

  it('reports headroom to the entry rollover point in get_context_remaining', async () => {
    // Identical script and usage in both arms, so the used-token figure is the
    // same; only the rollover point differs (30,000 entry, 90,000 ratio).
    const reportedPoint = async (label: string, config: Partial<RolloverConfig>): Promise<number> => {
      const { ctx, agent } = await engineHarness(sessionId(label), config)
      const adapter = new ScriptedAdapter([
        usageResponse('answer 1', 5_000),
        toolCallWithUsage('get_context_remaining', '{}', 5_500),
        usageResponse('answer 2', 6_000),
      ])
      ctx.llm.registerAdapter(['mock'], adapter)
      await followup(agent, 'turn one')
      await followup(agent, 'turn two')
      const { used, remaining } = reportedHeadroom(adapter.requests.at(-1))
      return used + remaining
    }

    const ratio = await reportedPoint('headroom-ratio', RATIOS)
    const entry = await reportedPoint('headroom-entry', withEntries({
      [MODEL]: { thresholdTokens: 30_000, reminderThresholdTokens: 20_000 },
    }))
    expect(ratio).toBe(90_000)
    expect(entry).toBe(30_000)
  })
})

describe('get_context_remaining with per-model points', () => {
  /** The automatic point the tool reports when the session is routed to `route` in qwen-strata's window. */
  async function reportedPointFor(route: string): Promise<number> {
    const { ctx, agent } = await engineHarness(
      sessionId(`tool-${route}`),
      withEntries({ [QWEN]: QWEN_POINTS }),
      route,
    )
    const adapter = new ScriptedAdapter([
      toolCallWithUsage('get_context_remaining', '{}', 5_000),
      usageResponse('answer', 6_000),
    ], QWEN_WINDOW)
    ctx.llm.registerAdapter(['mock'], adapter)
    await followup(agent, 'check the headroom')
    const { used, remaining } = reportedHeadroom(adapter.requests.at(-1))
    return used + remaining
  }

  it('reports the entry point for a listed model', async () => {
    expect(await reportedPointFor(QWEN)).toBe(250_000)
  })

  it('reports the ratio point for a model without an entry, in the same window', async () => {
    expect(await reportedPointFor('glm')).toBe(QWEN_RATIO_AUTO)
  })
})

describe.each(MODES)('qwen-strata in %s mode', (mode) => {
  /** A qwen-strata session at its own window, scripted with `replies`. */
  async function qwenRun(label: string, replies: StreamScript) {
    const harness = await engineHarness(
      sessionId(`${label}-${mode}`),
      { ...withEntries({ [QWEN]: QWEN_POINTS }), mode },
      QWEN,
    )
    const adapter = new ScriptedAdapter(replies, QWEN_WINDOW)
    harness.ctx.llm.registerAdapter(['mock'], adapter)
    return { ...harness, adapter }
  }

  it('nags at 200,000 and rolls over at 250,000, not at the ratio points', async () => {
    const run = await qwenRun('points', [
      reply('reply 1', 150_000), // above the ratio nag, below the entry nag
      reply('reply 2', 190_000), // below the entry nag
      reply('reply 3', 210_000), // crosses the entry nag
      reply('reply 4', 240_000), // above the ratio rollover, below the entry rollover
      reply('reply 5', 260_000), // crosses the entry rollover
      reply('reply 6', 1_000),
    ])
    const reminders = (): string[] => reminderTexts(run.session)

    await followup(run.agent, 'turn one')
    await followup(run.agent, 'turn two')
    // Turn two's first request reads 150,000. The ratio nag would fire here; the entry nag does not.
    expect(reminders()).toHaveLength(0)
    await followup(run.agent, 'turn three')
    expect(reminders()).toHaveLength(0)
    await followup(run.agent, 'turn four')
    expect(reminders()).toHaveLength(1)
    expect(reminders()[0]).toContain('An automatic rollover starts around 250000 tokens.')
    expect(countRollovers(run.session)).toBe(0)

    await followup(run.agent, 'turn five')
    // Turn five's first request reads 240,000. The ratio rollover would fire here; the entry rollover does not.
    expect(countRollovers(run.session)).toBe(0)
    await followup(run.agent, 'turn six')
    expect(countRollovers(run.session)).toBe(1)
    // The reminder count is not asserted after this rollover. The meter keeps the
    // pre-rollover reading, so a window-2 reminder fires at that stale reading. The
    // ratio path does the same, so this limit predates the change (see the header of
    // tests/reminder-wording.spec.ts).
    expect(JSON.stringify(run.adapter.requests[4])).not.toContain(CHECKPOINT_OPEN)
    expect(JSON.stringify(run.adapter.requests[5])).toContain(CHECKPOINT_OPEN)
  })

  it('the reminder, the rollover, and get_context_remaining agree on the same points', async () => {
    const run = await qwenRun('agree', [
      toolCallWithUsage('get_context_remaining', '{}', 200_000),
      reply('reply 1', 200_000),
      reply('reply 2', 250_000),
      reply('reply 3', 1_000),
    ])

    await followup(run.agent, 'turn one')
    const { used, remaining } = reportedHeadroom(run.adapter.requests.at(-1))
    expect(used + remaining).toBe(250_000)

    await followup(run.agent, 'turn two')
    expect(reminderTexts(run.session)).toHaveLength(1)
    expect(reminderTexts(run.session)[0]).toContain('An automatic rollover starts around 250000 tokens.')
    expect(countRollovers(run.session)).toBe(0)

    await followup(run.agent, 'turn three')
    expect(countRollovers(run.session)).toBe(1)
  })

  it('the reminder names the entry point as its automatic rollover point, not the ratio point', async () => {
    const run = await qwenRun('reminder-text', [
      reply('reply 1', 210_000),
      reply('reply 2', 1_000),
    ])

    await followup(run.agent, 'turn one')
    await followup(run.agent, 'turn two')
    const reminders = reminderTexts(run.session)
    expect(reminders).toHaveLength(1)
    expect(reminders[0]).toContain('An automatic rollover starts around 250000 tokens.')
    expect(reminders[0]).not.toContain(`around ${QWEN_RATIO_AUTO} tokens`)
  })
})
