/**
 * Pressure-reminder delivery across engine rows.
 *
 * On the Web profile the engine is mounted twice — the host bundle row and the
 * session's agent-preset row — and each row loads its **own module instance**
 * behind a preset `isolate` realm (they cannot share a Cordis container: the
 * `compaction` service may only be provided once). `modelSurface` decides which
 * row owns the model-facing tools, but both rows register `agent/pre-step`
 * unconditionally, and that event is a waterfall: the outer listener decides
 * while the inner one runs, so neither decision has reached the log when the
 * second one asks.
 *
 * A module-scoped claim therefore cannot be the whole answer, and a
 * per-instance Set is not an answer at all. The durable log is what both rows
 * share, so the logged time of the last reminder decides the cadence (see
 * `claimReminder`), and the synchronous claim covers one waterfall before either
 * delivery is logged.
 *
 * @module tests/reminder-delivery
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { DEFAULT_REMINDER_MESSAGE, renderReminderMessage, resolveConfig } from '../src/config.ts'
import type { ReminderValues, RolloverConfig } from '../src/config.ts'
import {
  claimReminder,
  countRollovers,
  isPressureReminder,
  REMINDER_REPEAT_MS,
  reminderDelivered,
  reminderWindowKey,
  resetReminderClaims,
} from '../src/rollover.ts'
import {
  engineHarness,
  followup,
  newContextCall,
  reminderTexts,
  ScriptedAdapter,
  seedExchanges,
  textResponse,
  usageResponse,
} from './harness.ts'

// Every case is an independent session; claims and delivered reminders are
// per session, and these ids must not collide across cases in one process.
let caseId = 0
const sessionId = (label: string): string => `reminder-${label}-${(caseId += 1)}`

/** Fake-clock start for the cases that drive the five-minute cadence (epoch ms). */
const T0 = Date.parse('2026-10-17T12:00:00.000Z')

// Cases that fake the clock restore real time afterwards.
afterEach(() => {
  vi.useRealTimers()
})

describe('pressure reminder delivery', () => {
  it('is refused by a second module instance once the log carries the reminder', async () => {
    const { ctx, agent, session } = await engineHarness(sessionId('instance'), {
      thresholdRatio: 0.5,
      reminderThresholdRatio: 0.01,
    })
    const adapter = new ScriptedAdapter([
      usageResponse('answer 1', 5000),
      usageResponse('answer 2', 6000),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    // Turn one anchors the meter; the reminder is computed at turn two's
    // pre-step, from that honest reading.
    await followup(agent, 'turn one')
    await followup(agent, 'turn two')
    expect(reminderTexts(session)).toHaveLength(1)
    expect(reminderDelivered(session)).toBe(true)

    // A second row in a preset realm is a distinct module instance, so its
    // in-process claim is empty — exactly what a cache-busted import models.
    // @ts-expect-error a cache-busted specifier has no declaration; the shape
    // is the module's own, which is the point: a distinct module instance.
    const fresh = await import('../src/rollover.ts?fresh-module-instance') as typeof import('../src/rollover.ts')
    expect(fresh.claimReminder).not.toBe(claimReminder)
    expect(fresh.claimReminder(session, Date.now())).toBe(false)

    // Clearing the in-process claims does not reopen the window: the log is
    // the durable authority, and it still carries the delivered reminder.
    resetReminderClaims(session)
    expect(claimReminder(session, Date.now())).toBe(false)
    expect(fresh.claimReminder(session, Date.now())).toBe(false)
  })

  it('holds the five-minute cadence inside one window, not once per session', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    const { ctx, agent, session } = await engineHarness(sessionId('window'), {
      thresholdRatio: 0.5,
      reminderThresholdRatio: 0.01,
    })
    const adapter = new ScriptedAdapter([
      usageResponse('answer 1', 5000),
      usageResponse('answer 2', 6000),
      usageResponse('answer 3', 7000),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    // Turn one anchors the meter; turn two crosses the reminder threshold.
    await followup(agent, 'turn one')
    await followup(agent, 'turn two')
    expect(reminderTexts(session)).toHaveLength(1)

    // Same window, inside the cadence: a claim just short of five minutes is refused.
    const key = reminderWindowKey(session)
    expect(claimReminder(session, T0 + REMINDER_REPEAT_MS - 1)).toBe(false)
    vi.setSystemTime(T0 + 60_000)
    await followup(agent, 'turn three')
    expect(reminderTexts(session)).toHaveLength(1)
    expect(reminderWindowKey(session)).toBe(key)

    // Five minutes after the first delivery, the same window delivers again.
    vi.setSystemTime(T0 + REMINDER_REPEAT_MS)
    await followup(agent, 'turn four')
    expect(reminderTexts(session)).toHaveLength(2)
    expect(reminderWindowKey(session)).toBe(key)
  })

  it('opens a fresh claim slot when a rollover starts a new window', async () => {
    // A model-requested rollover: the model names a handoff document, the
    // rollover starts window #1, and the reminder identity must follow it.
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-reminder-window-'))
    const handoffPath = join(cwd, 'HANDOFF-window.md')
    await writeFile(handoffPath, '# Handoff\n\nContinue the window test.\n', 'utf8')
    const { ctx, agent, session } = await engineHarness(sessionId('rollover'), {}, { cwd })
    const adapter = new ScriptedAdapter([
      ...Array.from({ length: 20 }, (_unused, index) => textResponse(`finding ${index} details`)),
      newContextCall(JSON.stringify({ handoff_path: handoffPath })),
      textResponse('continuing in window one'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 20)
    expect(countRollovers(session)).toBe(0)
    const firstWindowKey = reminderWindowKey(session)

    await followup(agent, 'roll over now and continue')
    expect(countRollovers(session)).toBe(1)

    // The rollover advanced the window, so the reminder identity changed: a
    // reminder delivered in window #0 cannot suppress window #1's.
    expect(firstWindowKey).toBe(`${session.id}#0`)
    expect(reminderWindowKey(session)).toBe(`${session.id}#1`)
  })
})

/**
 * Read a `notice` source's one-line account.
 *
 * `MessageSource` is a merge-extensible sum type, so the `notice` variant's
 * `summary` is not reachable by discriminant alone; this narrows on the public
 * `form` field and reads nothing private.
 * @param source - the message source to read.
 * @returns the summary, or `undefined` when the source is not a notice.
 */
function noticeSummary(source: object): string | undefined {
  const candidate = source as { form?: unknown; summary?: unknown }
  if (candidate.form !== 'notice') return undefined
  return typeof candidate.summary === 'string' ? candidate.summary : undefined
}

/**
 * The percent the engine substituted into the delivered reminder, read from
 * the reminder's own summary line.
 *
 * The summary is written from the same measured value the body is rendered
 * from, so comparing the body against it proves the body carries the MEASURED
 * percent rather than a test-local recomputation of it. The event is selected
 * with the engine's own predicate, so this reader cannot disagree with the
 * engine about which event is a reminder.
 * @param session - session whose delivered reminders to inspect.
 * @returns the first reminder's percent, or `undefined` when none was delivered.
 */
function deliveredPercent(session: Session): number | undefined {
  const event = session.snapshotEvents().find(isPressureReminder)
  if (event === undefined) return undefined
  const summary = noticeSummary(event.data.source)
  const match = summary === undefined ? null : /\((\d+)% used\)/.exec(summary)
  return match?.[1] === undefined ? undefined : Number(match[1])
}

describe('the 40% handoff reminder', () => {
  it('fires once after usage crosses 40%, then repeats only after five minutes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
    // Deliberately no ratio overrides: this case measures the SHIPPED defaults,
    // where reminderThresholdRatio is 0.40 and thresholdRatio is 0.90, against
    // a 100k window. 45k of usage is past the reminder point and far below the
    // rollover point, so the only thing that can fire is the reminder.
    const { ctx, agent, session } = await engineHarness(sessionId('forty-once'), {})
    const adapter = new ScriptedAdapter([
      usageResponse('answer 1', 45_000),
      usageResponse('answer 2', 46_000),
      usageResponse('answer 3', 47_000),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    // Turn one only anchors the meter; there is no honest reading to gate on yet.
    await followup(agent, 'turn one')
    expect(reminderTexts(session)).toHaveLength(0)

    // Turn two's pre-step is the first measured one, and it crosses 40%.
    await followup(agent, 'turn two')
    expect(reminderTexts(session)).toHaveLength(1)
    expect(reminderDelivered(session)).toBe(true)

    // A minute later, same window: still inside the five-minute cadence.
    vi.setSystemTime(T0 + 60_000)
    await followup(agent, 'turn three')
    expect(reminderTexts(session)).toHaveLength(1)
    // No rollover happened, so the window never advanced.
    expect(countRollovers(session)).toBe(0)

    // Five minutes after the first delivery, the reminder repeats.
    vi.setSystemTime(T0 + REMINDER_REPEAT_MS)
    await followup(agent, 'turn four')
    expect(reminderTexts(session)).toHaveLength(2)
  })

  it('delivers text naming /handoff-doc and new_context, with the measured percent substituted', async () => {
    const { ctx, agent, session } = await engineHarness(sessionId('forty-text'), {})
    const adapter = new ScriptedAdapter([
      usageResponse('answer 1', 45_000),
      usageResponse('answer 2', 46_000),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')

    const reminders = reminderTexts(session)
    expect(reminders).toHaveLength(1)
    const text = reminders[0] ?? ''

    // The workflow the reminder exists to name, with the backticks the shipped
    // text carries so the model reads them as commands.
    expect(text).toContain('`/handoff-doc`')
    expect(text).toContain('`new_context`')
    // The obligation that makes the handoff sufficient for a cold reader.
    expect(text).toContain('The handoff document, plus any recent chat kept after the rollover, will be the continuation context.')

    // The percent in the body is the one the engine measured, read back from
    // the reminder's own summary rather than recomputed here.
    const percent = deliveredPercent(session)
    expect(percent).toBeDefined()
    expect(text).toContain(`Context is ${percent}% full.`)
    // Substituted, not left as a placeholder...
    expect(text).not.toContain('{percent}')
    // ...and not the literal 40 from the template: this fixture measures ~45%.
    // Asserting the fixture stays off 40 keeps the line above from passing
    // vacuously if the usage numbers ever drift.
    expect(percent).not.toBe(40)
    expect(text).not.toContain('Context is 40% full.')
  })

  it('gates delivery on reminderThresholdRatio, not on a hardcoded constant', async () => {
    // Identical usage in both sessions; only the configured ratio differs. If
    // delivery were gated on a constant, the raised-ratio session would still
    // remind and this test would fail.
    const raised = await engineHarness(sessionId('ratio-raised'), {
      // 45% usage is below this, so nothing may fire.
      reminderThresholdRatio: 0.7,
      thresholdRatio: 0.9,
    })
    const raisedAdapter = new ScriptedAdapter([
      usageResponse('answer 1', 45_000),
      usageResponse('answer 2', 46_000),
    ])
    raised.ctx.llm.registerAdapter(['mock'], raisedAdapter)
    await followup(raised.agent, 'turn one')
    await followup(raised.agent, 'turn two')
    expect(reminderTexts(raised.session)).toHaveLength(0)
    expect(reminderDelivered(raised.session)).toBe(false)

    // The contrast arm: the shipped 0.40 ratio and the same usage do remind.
    const shipped = await engineHarness(sessionId('ratio-shipped'), {})
    const shippedAdapter = new ScriptedAdapter([
      usageResponse('answer 1', 45_000),
      usageResponse('answer 2', 46_000),
    ])
    shipped.ctx.llm.registerAdapter(['mock'], shippedAdapter)
    await followup(shipped.agent, 'turn one')
    await followup(shipped.agent, 'turn two')
    expect(reminderTexts(shipped.session)).toHaveLength(1)
  })

  it('renders an operator-supplied message and leaves unknown placeholders alone', async () => {
    const { ctx, agent, session } = await engineHarness(sessionId('custom-text'), {
      reminderThresholdRatio: 0.01,
      reminderMessage: 'Rollover soon: {percent}% used. Run /handoff-doc then new_context. {not_a_placeholder}',
    })
    const adapter = new ScriptedAdapter([
      usageResponse('answer 1', 5000),
      usageResponse('answer 2', 6000),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')

    const text = reminderTexts(session)[0] ?? ''
    const percent = deliveredPercent(session)
    expect(percent).toBeDefined()
    expect(text).toBe(
      `Rollover soon: ${percent}% used. Run /handoff-doc then new_context. {not_a_placeholder}`,
    )
    // `{percent}` is the only placeholder: an unknown one is not expanded into
    // anything, it survives verbatim.
    expect(text).not.toContain('{percent}')
  })
})

/**
 * Output tokens that `usageResponse` reports. The token meter counts input plus
 * output (`usageTokens` in packages/llm/token-meter/src/index.ts), so a test
 * that wants `N` measured tokens scripts `N - REPORTED_OUTPUT_TOKENS` as input.
 */
const REPORTED_OUTPUT_TOKENS = 5

/**
 * The reminder a routed model gets at turn two, with `used` tokens measured on
 * turn one. The scripted adapter advertises `window` for that model, so each
 * case reads its own window and its own points.
 * @param label - distinct session label.
 * @param route - routed model id, the window it advertises, and the measured tokens used.
 * @param config - engine configuration overrides for this case.
 * @returns the one reminder the session delivered.
 */
async function reminderOn(
  label: string,
  route: { model: string; window: number; used: number },
  config: Partial<RolloverConfig> = {},
): Promise<string> {
  const { ctx, agent, session } = await engineHarness(sessionId(label), config, {}, {}, { model: route.model })
  const input = route.used - REPORTED_OUTPUT_TOKENS
  ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
    usageResponse('answer 1', input),
    usageResponse('answer 2', input),
  ], route.window))
  await followup(agent, 'turn one')
  await followup(agent, 'turn two')
  const reminders = reminderTexts(session)
  expect(reminders).toHaveLength(1)
  return reminders[0] ?? ''
}

describe('the reminder states the absolute numbers for the routed model', () => {
  // Case 1: a generic 1,000,000-token route with no entry, so the ratios apply.
  // Handoff point 400,000 and rollover point 900,000. Used: 400,000 tokens.
  it('a generic 1M route gets the ratio points and reads 40% of its window', async () => {
    const text = await reminderOn('nag-generic', { model: 'generic-1m', window: 1_000_000, used: 400_000 })
    expect(text).toBe(
      'Context is 40% full. 400000 of 1000000 tokens are used. '
      + 'The percent is measured against the whole window of this model, so a low percent on a large window is expected. '
      + 'The handoff point, where these reminders start, is 400000 tokens. '
      + 'The rollover point is 900000 tokens, leaving 500000 tokens before the rollover point. '
      + 'Nothing rolls over by itself: reaching the rollover point only logs a warning. '
      + 'Run `/handoff-doc` (the `handoff-doc` skill) to create/update the durable handoff document. '
      + 'Make it fully sufficient for a fresh context to continue the work. After it succeeds, call '
      + '`new_context` with the path of that document as `handoff_path`. The handoff document, plus any recent '
      + 'chat kept after the rollover, will be the continuation context.',
    )
  })

  // Case 2: strata/qwen-strata, a 262,144-token window, with its own entry:
  // handoff point 200,000 and rollover point 250,000. Used: 200,000 tokens.
  it('strata/qwen-strata gets its entry points and reads 76% of its window', async () => {
    const text = await reminderOn('nag-qwen', { model: 'strata/qwen-strata', window: 262_144, used: 200_000 }, {
      modelThresholds: { 'strata/qwen-strata': { thresholdTokens: 250_000, reminderThresholdTokens: 200_000 } },
    })
    expect(text).toBe(
      'Context is 76% full. 200000 of 262144 tokens are used. '
      + 'The percent is measured against the whole window of this model, so a low percent on a large window is expected. '
      + 'The handoff point, where these reminders start, is 200000 tokens. '
      + 'The rollover point is 250000 tokens, leaving 50000 tokens before the rollover point. '
      + 'Nothing rolls over by itself: reaching the rollover point only logs a warning. '
      + 'Run `/handoff-doc` (the `handoff-doc` skill) to create/update the durable handoff document. '
      + 'Make it fully sufficient for a fresh context to continue the work. After it succeeds, call '
      + '`new_context` with the path of that document as `handoff_path`. The handoff document, plus any recent '
      + 'chat kept after the rollover, will be the continuation context.',
    )
  })

  // Case 3: claude-haiku-5-5, a 1,000,000-token window, with the same entry
  // points as case 2. Used: 200,000 tokens. Cases 2 and 3 differ only in window.
  it('claude haiku gets the same entry points as strata and reads 20% of its window', async () => {
    const text = await reminderOn('nag-haiku', { model: 'claude-haiku-5-5', window: 1_000_000, used: 200_000 }, {
      modelThresholds: { 'claude-haiku-5-5': { thresholdTokens: 250_000, reminderThresholdTokens: 200_000 } },
    })
    expect(text).toBe(
      'Context is 20% full. 200000 of 1000000 tokens are used. '
      + 'The percent is measured against the whole window of this model, so a low percent on a large window is expected. '
      + 'The handoff point, where these reminders start, is 200000 tokens. '
      + 'The rollover point is 250000 tokens, leaving 50000 tokens before the rollover point. '
      + 'Nothing rolls over by itself: reaching the rollover point only logs a warning. '
      + 'Run `/handoff-doc` (the `handoff-doc` skill) to create/update the durable handoff document. '
      + 'Make it fully sufficient for a fresh context to continue the work. After it succeeds, call '
      + '`new_context` with the path of that document as `handoff_path`. The handoff document, plus any recent '
      + 'chat kept after the rollover, will be the continuation context.',
    )
  })
})

describe('renderReminderMessage', () => {
  const values: ReminderValues = {
    percent: 76,
    used_tokens: 200_000,
    window_tokens: 262_144,
    handoff_point_tokens: 200_000,
    rollover_point_tokens: 250_000,
    tokens_to_rollover: 50_000,
  }

  it('fills every named placeholder, repeats a repeated one, and leaves other braces verbatim', () => {
    expect(renderReminderMessage('{percent}% of {window_tokens} ({used_tokens}); {nope} {percent}', values))
      .toBe('76% of 262144 (200000); {nope} 76')
  })
})

describe('reminder configuration defaults and validation', () => {
  it('pins the shipped default message and the 40% / 90% defaults', () => {
    // The acceptance criterion is that the DEFAULT is exactly this text, so
    // the literal is pinned here rather than derived from the constant under
    // test. The backticks are part of the required text.
    expect(DEFAULT_REMINDER_MESSAGE).toBe(
      'Context is {percent}% full. {used_tokens} of {window_tokens} tokens are used. '
      + 'The percent is measured against the whole window of this model, so a low percent on a large window is expected. '
      + 'The handoff point, where these reminders start, is {handoff_point_tokens} tokens. '
      + 'The rollover point is {rollover_point_tokens} tokens, leaving {tokens_to_rollover} tokens before the rollover point. '
      + 'Nothing rolls over by itself: reaching the rollover point only logs a warning. '
      + 'Run `/handoff-doc` (the `handoff-doc` skill) to create/update the durable handoff document. '
      + 'Make it fully sufficient for a fresh context to continue the work. After it succeeds, call '
      + '`new_context` with the path of that document as `handoff_path`. The handoff document, plus any recent '
      + 'chat kept after the rollover, will be the continuation context.',
    )
    const config = resolveConfig({})
    expect(config.reminderMessage).toBe(DEFAULT_REMINDER_MESSAGE)
    expect(config.reminderThresholdRatio).toBe(0.4)
    expect(config.thresholdRatio).toBe(0.9)
  })

  it('rejects a blank reminder message at load', () => {
    expect(() => resolveConfig({ reminderMessage: '' })).toThrow(/reminderMessage must be a non-empty string/)
    expect(() => resolveConfig({ reminderMessage: '   \n' }))
      .toThrow(/reminderMessage must be a non-empty string/)
    expect(resolveConfig({ reminderMessage: 'Go.' }).reminderMessage).toBe('Go.')
  })
})
