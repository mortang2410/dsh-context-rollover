/**
 * The hard rollover-point reminder (`rolloverReminderMessage`): the order the
 * model gets every turn at or above the rollover point, whatever the cadence
 * says, until it crosses the boundary itself.
 *
 * The contract held down here:
 *
 * - every measured turn at or above the rollover point carries the shipped hard
 *   text in the model request, and the `enter` decision the `agent/pre-step`
 *   listener returns is what carries it (the durable log alone would not prove
 *   the model saw it);
 * - below the rollover point nothing changes: the cadence reminder
 *   (`reminderMessage`) is the only reminder;
 * - the journal warning stays and is no longer the only signal;
 * - a pre-step that commits a rollover, the model's own request or the engine's
 *   automatic safety net, delivers no hard reminder for that step, because the
 *   boundary has just been crossed; a later step of the same turn, which cannot
 *   commit again, does remind. The measurement after such a commit is still at
 *   or above the point in these fixtures, so the suppression is pinned as the
 *   ordering rule and not as a measurement that fell below the point.
 *
 * @module tests/rollover-reminder
 */

import { describe, expect, it } from 'vitest'
import { agentEvents } from '@deepseek-ai/dsh-agent'
import type { PreStepDecision } from '@deepseek-ai/dsh-agent'
import {
  DEFAULT_ROLLOVER_REMINDER_MESSAGE,
  renderReminderMessage,
  rolloverPointsFor,
} from '../src/config.ts'
import { countRollovers } from '../src/rollover.ts'
import {
  engineHarness,
  followup,
  MODEL,
  reminderTexts,
  rolloverReminderTexts,
  ScriptedAdapter,
  textResponse,
  usageResponse,
} from './harness.ts'
import type { RecordedRequest } from './harness.ts'

/**
 * Output tokens `usageResponse` reports. The token meter counts input plus
 * output, so a 60,000-token reading measures 60,005.
 */
const REPORTED_OUTPUT_TOKENS = 5

/** The harness window: 100,000 tokens, so the shipped ratios give 40k and 90k. */
const WINDOW = 100_000

/** The shipped pressure ratios these cases run: a 40k handoff point and a 50k rollover point. */
const PRESSURE = { thresholdRatio: 0.5, reminderThresholdRatio: 0.4 } as const

/** The measured usage of every reading in these cases. */
const USED = 60_000 + REPORTED_OUTPUT_TOKENS

/** The rollover point under {@link PRESSURE}, in tokens. */
const ROLLOVER_POINT = 50_000

/** The percent the engine substitutes for {@link USED} on the 100k window. */
const PERCENT = 60

/** The shipped hard text with the figures this fixture measures. */
const EXPECTED_HARD_TEXT = renderReminderMessage(DEFAULT_ROLLOVER_REMINDER_MESSAGE, {
  percent: PERCENT,
  used_tokens: USED,
  window_tokens: WINDOW,
  handoff_point_tokens: 40_000,
  rollover_point_tokens: ROLLOVER_POINT,
  tokens_to_rollover: 0,
})

/** Whether one recorded model request carried `text` as a model-visible message. */
function carries(request: RecordedRequest | undefined, text: string): boolean {
  return request?.messages.some(message => message.content
    .some(block => block.type === 'text' && block.text.includes(text))) ?? false
}

/** Whether one pre-step decision carried `text` as a model-visible message. */
function decisionCarries(decision: PreStepDecision, text: string): boolean {
  if (decision.kind !== 'enter') return false
  return decision.messages.some(message => message.content
    .some(block => block.type === 'text' && block.text.includes(text)))
}

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

/**
 * One long user message. The token meter prices a surface node at one token per
 * four characters, so `repeats: 3000` is a node of roughly 5250 tokens: large
 * enough that the automatic path's tail floor is met by recent nodes alone.
 */
function longMessage(label: string, repeats = 3000): string {
  return `${label} ${'detail '.repeat(repeats).trimEnd()}`
}

describe('the hard reminder at or above the rollover point', () => {
  it('delivers the shipped text every measured turn, into the model request and through the enter decision', async () => {
    const { ctx, agent, session } = await engineHarness('hard-reminder-every-turn', PRESSURE)
    const warnings = captureWarnings(ctx)
    const adapter = new ScriptedAdapter([
      usageResponse('answer 1', 60_000),
      usageResponse('answer 2', 60_000),
      usageResponse('answer 3', 60_000),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    // Turn one only anchors the meter: a pre-step sees no honest reading, so its
    // request carries no reminder.
    await followup(agent, 'turn one')
    await followup(agent, 'turn two')
    await followup(agent, 'turn three')

    expect(adapter.recorded).toHaveLength(3)
    expect(carries(adapter.recorded[0], EXPECTED_HARD_TEXT)).toBe(false)
    // Every measured turn at or above the point carries the hard text, exactly
    // once, in the request the model actually received.
    expect(carries(adapter.recorded[1], EXPECTED_HARD_TEXT)).toBe(true)
    expect(carries(adapter.recorded[2], EXPECTED_HARD_TEXT)).toBe(true)
    const delivered = adapter.recorded[1]?.messages.filter(message => message.content
      .some(block => block.type === 'text' && block.text === EXPECTED_HARD_TEXT)) ?? []
    expect(delivered).toHaveLength(1)

    // The same two copies are in the durable log, through the engine's own
    // predicate, and no cadence reminder was delivered alongside them.
    expect(rolloverReminderTexts(session)).toEqual([EXPECTED_HARD_TEXT, EXPECTED_HARD_TEXT])
    expect(reminderTexts(session)).toEqual([])

    // The journal warning stays, once per measured turn, and is no longer the
    // only signal: the model was told as well.
    expect(warnings.filter(message => message.includes('automatic rollover is disabled'))).toHaveLength(2)

    // The `enter` decision itself carries the reminder: driven through the
    // agent's own event dispatch, the way the agent loop calls it, the engine
    // returns a message the request is built from rather than only a log entry.
    const decision = await agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn: 99, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )
    expect(decision.kind).toBe('enter')
    const carriedByDecision = decision.kind === 'enter'
      ? decision.messages.some(message => message.content
        .some(block => block.type === 'text' && block.text === EXPECTED_HARD_TEXT))
      : false
    expect(carriedByDecision).toBe(true)
  })

  it('never delivers it below the rollover point, where the cadence reminder stays', async () => {
    // The shipped ratios on the 100k window: 45k is past the 40% handoff point
    // and far below the 90% rollover point.
    const { ctx, agent, session } = await engineHarness('hard-reminder-below', {})
    const adapter = new ScriptedAdapter([
      usageResponse('answer 1', 45_000),
      usageResponse('answer 2', 45_000),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')

    expect(rolloverReminderTexts(session)).toEqual([])
    expect(reminderTexts(session)).toHaveLength(1)
  })

  it('reads rolloverReminderMessage from the config, leaving unknown braces verbatim', async () => {
    const { ctx, agent, session } = await engineHarness('hard-reminder-custom', {
      ...PRESSURE,
      rolloverReminderMessage: 'CUSTOM-HARD {percent}% of {window_tokens}, {not_a_placeholder}',
    })
    const adapter = new ScriptedAdapter([
      usageResponse('answer 1', 60_000),
      usageResponse('answer 2', 60_000),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')

    expect(rolloverReminderTexts(session)).toEqual([
      `CUSTOM-HARD ${PERCENT}% of ${WINDOW}, {not_a_placeholder}`,
    ])
  })
})

describe('a pre-step that commits a rollover delivers no hard reminder for that step', () => {
  it('suppresses it in the committing step and delivers it in the next step of the same turn', async () => {
    const { ctx, engine, agent, session } = await engineHarness('hard-reminder-ordering', {
      automaticRollover: true,
      thresholdRatio: 0.002,
      reminderThresholdRatio: 0.001,
      retainTokens: 0,
      automaticRolloverRetainTokens: 200,
      rolloverReminderMessage: 'ORDERING-HARD-SENTINEL {percent}% at {used_tokens} of {window_tokens}',
      reminderMessage: 'ORDERING-CADENCE leaving {tokens_to_rollover} before the rollover point at {percent}%',
    })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([textResponse('short answer')]))

    // Two closed long exchanges: enough surface for the automatic path's tail
    // floor, and no pre-step of these two turns can select a span yet.
    await followup(agent, longMessage('turn one'))
    await followup(agent, longMessage('turn two'))
    expect(countRollovers(session)).toBe(0)

    // Both steps of turn three are driven through the agent's own pre-step
    // waterfall, the way the agent loop calls it, so the decision each step
    // returns is exactly what the model's request would be built from. The turn
    // is opened first, because the agent loop opens it before its first
    // pre-step and a turn-owned rollover must be enclosed in a turn.
    session.append('turn/start', { turn: 3 })
    const step = (turn: number, stepNumber: number): Promise<PreStepDecision> => agentEvents(ctx, agent).waterfall(
      'agent/pre-step',
      { messages: [], turn, step: stepNumber, signal: new AbortController().signal },
      () => Promise.resolve({ kind: 'enter' as const, messages: [] }),
    )

    // Turn three, step one: the automatic safety net commits here. The
    // rollover-point branch is terminal, so this step carries no reminder at
    // all: not the hard order, because the engine just did the work the order
    // asks for, and not the cadence text either, whose tokens-left line would
    // read 0 while usage is still at or above the point.
    const committing = await step(3, 1)
    expect(countRollovers(session)).toBe(1)
    expect(decisionCarries(committing, 'ORDERING-HARD-SENTINEL')).toBe(false)
    expect(decisionCarries(committing, 'ORDERING-CADENCE')).toBe(false)
    expect(committing.kind === 'enter' ? committing.messages : []).toHaveLength(0)

    // The measurement after the commit is still at or above the point, so the
    // absent hard reminder above is the ordering rule and not a reading that
    // fell below the point.
    const { rolloverTokens } = rolloverPointsFor(engine.config, WINDOW, MODEL)
    expect(rolloverTokens).toBe(200)
    expect(ctx.tokenMeter.measure(session).totalTokens).toBeGreaterThanOrEqual(rolloverTokens)

    // Turn three, step two: one commit per turn, so this step cannot cross the
    // boundary again and it is the step that carries the hard reminder.
    const second = await step(3, 2)
    expect(countRollovers(session)).toBe(1)
    expect(decisionCarries(second, 'ORDERING-HARD-SENTINEL')).toBe(true)
    expect(rolloverReminderTexts(session)).toHaveLength(1)
    session.append('turn/end', { turn: 3, reason: { kind: 'completed' } })
  })
})
