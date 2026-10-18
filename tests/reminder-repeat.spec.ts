/**
 * Pressure-reminder repeat cadence.
 *
 * Within one window a cadence reminder is delivered at most once per the
 * configured `reminderRepeatMs` of wall-clock time, and only while measured
 * usage is at or above the reminder point and below the rollover point. Every
 * case drives the real `agent/pre-step` path: each `followup` is one pre-step.
 * At or above the rollover point the hard per-turn reminder replaces the
 * cadence one; that branch is pinned in tests/rollover-reminder.spec.ts.
 *
 * Time is controlled with `vi.useFakeTimers({ toFake: ['Date'] })` and
 * `vi.setSystemTime`. Only `Date` is faked. The engine reads `Date.now()` once
 * per pre-step, and `session.append` stamps every logged event with
 * `Date.now()`, so both the cadence and the logged times follow the test clock.
 * Timers stay real, so the async agent loop is unaffected.
 *
 * @module tests/reminder-repeat
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { DEFAULT_REMINDER_REPEAT_MS, resolveConfig } from '../src/config.ts'
import type { RolloverConfig } from '../src/config.ts'
import { CONTEXT_MANAGEMENT_GUIDANCE } from '../src/guidance.ts'
import { ContextRolloverEngine } from '../src/index.ts'
import {
  claimReminder,
  countRollovers,
  isPressureReminder,
  REMINDER_REPEAT_MS,
  resetReminderClaims,
} from '../src/rollover.ts'
import {
  engineHarness,
  followup,
  newContextCall,
  reminderTexts,
  rolloverReminderTexts,
  ScriptedAdapter,
  seedExchanges,
  textResponse,
  usageResponse,
} from './harness.ts'

/** Fake-clock start for every case (epoch milliseconds). */
const T0 = Date.parse('2026-10-17T12:00:00.000Z')
const MINUTE = 60_000

let caseId = 0
const sessionId = (label: string): string => `reminder-repeat-${label}-${(caseId += 1)}`

/**
 * A pressure session on the shipped shape: a 100k window, a reminder point at
 * 40k tokens and a rollover point at 90k. `usage` gives the input-token reading
 * of each request in order, and the last reading repeats. A fresh session has
 * no reading before its first answer, so turn one only anchors the meter.
 * @param label - short case label for the session id.
 * @param usage - input-token readings, one per request.
 * @param config - rollover configuration overrides.
 */
async function pressureSession(label: string, usage: readonly number[], config: Partial<RolloverConfig> = {}) {
  const harness = await engineHarness(sessionId(label), {
    thresholdRatio: 0.9,
    reminderThresholdRatio: 0.4,
    ...config,
  })
  harness.ctx.llm.registerAdapter(['mock'], new ScriptedAdapter(
    usage.map((tokens, index) => usageResponse(`answer ${index + 1}`, tokens)),
  ))
  return harness
}

/**
 * Send one turn at a given fake time, so its pre-step reads that time.
 * @param agent - agent to message.
 * @param time - fake epoch milliseconds for this turn.
 * @param text - the user's message.
 */
async function turnAt(agent: Agent, time: number, text: string): Promise<void> {
  vi.setSystemTime(time)
  await followup(agent, text)
}

/**
 * The logged times of every delivered pressure reminder, in log order.
 * @param session - session to inspect.
 */
function reminderTimes(session: Session): number[] {
  return session.snapshotEvents().filter(isPressureReminder).map(event => event.time)
}

/**
 * A scripted tool-call response with a usage reading added before its finish chunk.
 * @param chunks - the tool-call response to extend.
 * @param inputTokens - the input-token reading to report.
 */
function withUsage(chunks: StreamChunk[], inputTokens: number): StreamChunk[] {
  return [
    ...chunks.slice(0, -1),
    { type: 'usage', usage: { inputTokens, outputTokens: 5 } },
    ...chunks.slice(-1),
  ]
}

describe('pressure reminder repeat cadence', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('(a) the first reminder fires at the first pre-step at the point, and not below it', async () => {
    // Readings: 30k, 30k, then 45k. Pre-steps measure 30k, 30k, then 45k.
    const { agent, session } = await pressureSession('first', [30_000, 30_000, 45_000])
    await turnAt(agent, T0, 'turn one')
    expect(reminderTexts(session)).toHaveLength(0)
    await turnAt(agent, T0, 'turn two')
    expect(reminderTexts(session)).toHaveLength(0)
    await turnAt(agent, T0, 'turn three')
    expect(reminderTexts(session)).toHaveLength(0)
    await turnAt(agent, T0, 'turn four')
    expect(reminderTimes(session)).toEqual([T0])
  })

  it('rule case 1: with no earlier reminder in the window, delivery happens at the point', async () => {
    const { agent, session } = await pressureSession('rule-one', [45_000])
    await turnAt(agent, T0, 'turn one')
    await turnAt(agent, T0, 'turn two')
    expect(reminderTimes(session)).toEqual([T0])
  })

  it('(b) no repeat before five minutes: 299000 ms and 299999 ms after the first delivery deliver nothing', async () => {
    const { agent, session } = await pressureSession('before-five', [45_000])
    await turnAt(agent, T0, 'turn one')
    await turnAt(agent, T0, 'turn two')
    expect(reminderTimes(session)).toEqual([T0])
    await turnAt(agent, T0 + 299_000, 'turn three')
    expect(reminderTimes(session)).toEqual([T0])
    await turnAt(agent, T0 + 299_999, 'turn four')
    expect(reminderTimes(session)).toEqual([T0])
  })

  it('(c) repeats at exactly 300000 ms while usage stays at the point', async () => {
    const { agent, session } = await pressureSession('exactly-five', [45_000])
    await turnAt(agent, T0, 'turn one')
    await turnAt(agent, T0, 'turn two')
    expect(reminderTimes(session)).toEqual([T0])
    await turnAt(agent, T0 + REMINDER_REPEAT_MS, 'turn three')
    expect(reminderTimes(session)).toEqual([T0, T0 + REMINDER_REPEAT_MS])
  })

  it('(d) nothing below the point at any time, including after a delivery when usage drops', async () => {
    // Reading 45k lets the first delivery happen; then usage falls to 10k.
    const { agent, session } = await pressureSession('below-point', [45_000, 10_000])
    await turnAt(agent, T0, 'turn one')
    await turnAt(agent, T0, 'turn two')
    expect(reminderTimes(session)).toEqual([T0])
    // Ten and twenty minutes later the cadence allows it, but usage is below the point.
    await turnAt(agent, T0 + 10 * MINUTE, 'turn three')
    expect(reminderTimes(session)).toEqual([T0])
    await turnAt(agent, T0 + 20 * MINUTE, 'turn four')
    expect(reminderTimes(session)).toEqual([T0])
  })

  it('(e) two module instances claim one slot in one pre-step (claim layer)', async () => {
    const { session } = await pressureSession('two-rows', [45_000])
    // @ts-expect-error a cache-busted specifier has no declaration; the shape
    // is the module's own, which is the point: a distinct module instance.
    const other = await import('../src/rollover.ts?repeat-second-instance') as typeof import('../src/rollover.ts')
    expect(other.claimReminder).not.toBe(claimReminder)
    // Row A decides first at T0; neither delivery is in the log yet.
    expect(claimReminder(session, T0, REMINDER_REPEAT_MS)).toBe(true)
    expect(reminderTimes(session)).toEqual([])
    // Row B decides at the same instant in the same waterfall: the shared claim refuses it.
    expect(other.claimReminder(session, T0, REMINDER_REPEAT_MS)).toBe(false)

    // Through the real pre-step: the second row's check after the delivery is logged also refuses.
    const engine = await pressureSession('two-rows-engine', [45_000])
    await turnAt(engine.agent, T0, 'turn one')
    await turnAt(engine.agent, T0, 'turn two')
    expect(reminderTimes(engine.session)).toEqual([T0])
    expect(other.claimReminder(engine.session, T0, REMINDER_REPEAT_MS)).toBe(false)
  })

  it('(e2) two engine rows on one session reach agent/pre-step together and deliver exactly one reminder', async () => {
    const { ctx, engine, agent, session, notesBase } = await engineHarness(sessionId('two-engine-rows'), {
      thresholdRatio: 0.9,
      reminderThresholdRatio: 0.4,
    })
    const adapter = new ScriptedAdapter([
      usageResponse('answer 1', 45_000),
      usageResponse('answer 2', 45_000),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)
    // The first row's tools are registered already. A roster that names no
    // owner for this session keeps both rows active, and its presence stops the
    // second row from registering the same tools again.
    const provider = ctx as unknown as { provide(name: string, value: unknown): void }
    provider.provide('agentPresets', { serviceFor: () => undefined })
    // The second row is a second engine instance on an isolated child context.
    // On the root context a second engine fails with `service "compaction" has
    // been registered`, so the row gets its own `compaction` slot. Both rows
    // listen on the same agent/pre-step waterfall.
    const secondRow = new ContextRolloverEngine(ctx.isolate('compaction'), {

      notesDir: notesBase,
      thresholdRatio: 0.9,
      reminderThresholdRatio: 0.4,
    })
    expect(secondRow).not.toBe(engine)
    const measure = vi.spyOn(ctx.tokenMeter, 'measure')

    await turnAt(agent, T0, 'turn one')
    expect(reminderTexts(session)).toHaveLength(0)
    measure.mockClear()
    await turnAt(agent, T0, 'turn two')

    // Each row measures twice per pre-step (the rollover-point warning check and
    // the reminder check), and the agent loop does not measure. A single row
    // therefore makes two calls, so more than two shows that the second row ran
    // and reached the claim.
    expect(measure.mock.calls.length).toBeGreaterThan(2)
    // Exactly one reminder is logged for that pre-step...
    const reminders = reminderTexts(session)
    expect(reminders).toHaveLength(1)
    // ...and exactly one copy of it reached the model's messages for that request.
    const delivered = adapter.recorded.at(-1)?.messages.filter(message => message.content
      .some(block => block.type === 'text' && block.text === reminders[0])) ?? []
    expect(delivered).toHaveLength(1)
  })

  it('(f) restart survival: with the in-memory claims cleared, the log still holds the cadence', async () => {
    const { agent, session } = await pressureSession('restart', [45_000])
    await turnAt(agent, T0, 'turn one')
    await turnAt(agent, T0, 'turn two')
    expect(reminderTimes(session)).toEqual([T0])
    // Simulated restart: the process-local claims are gone, the log is kept.
    resetReminderClaims(session)
    await turnAt(agent, T0 + 4 * MINUTE, 'turn three')
    expect(reminderTimes(session)).toEqual([T0])
    await turnAt(agent, T0 + REMINDER_REPEAT_MS, 'turn four')
    expect(reminderTimes(session)).toEqual([T0, T0 + REMINDER_REPEAT_MS])
  })

  it('(g) above the rollover point the hard per-turn reminder replaces the cadence one', async () => {
    // A 50k rollover point sits below the 60k reading, so usage is above it throughout.
    const { agent, session } = await pressureSession('above-rollover', [60_000], { thresholdRatio: 0.5 })
    await turnAt(agent, T0, 'turn one')
    await turnAt(agent, T0, 'turn two')
    await turnAt(agent, T0 + 1_000, 'turn three')
    await turnAt(agent, T0 + 2_000, 'turn four')
    // One hard reminder per measured turn, inside the default five-minute gap:
    // the hard reminder is claimed per turn, not on the cadence clock.
    expect(rolloverReminderTexts(session)).toHaveLength(3)
    // The cadence reminder is replaced above the point, not delivered alongside.
    expect(reminderTimes(session)).toEqual([])
    // Nothing rolled over automatically: the gate is off, so the engine warns
    // and the model is told every turn, but the model still owns the rollover.
    expect(countRollovers(session)).toBe(0)
  })

  it('rule case 2: with the newest reminder six minutes old, delivery happens', async () => {
    const { agent, session } = await pressureSession('six-minutes', [45_000])
    await turnAt(agent, T0, 'turn one')
    await turnAt(agent, T0, 'turn two')
    expect(reminderTimes(session)).toEqual([T0])
    await turnAt(agent, T0 + 6 * MINUTE, 'turn three')
    expect(reminderTimes(session)).toEqual([T0, T0 + 6 * MINUTE])
  })

  it('(h) rule case 3: a rollover opens a new window, so its first delivery is not gated by the old window', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'dsh-reminder-repeat-'))
    const handoffPath = join(cwd, 'HANDOFF-repeat.md')
    await writeFile(handoffPath, '# Handoff\n\nContinue the cadence test.\n', 'utf8')
    const { ctx, agent, session } = await engineHarness(sessionId('new-window'), {
      thresholdRatio: 0.9,
      reminderThresholdRatio: 0.4,
    }, { cwd })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      // Twenty exchanges without a usage reading, so the rollover has content to replace.
      ...Array.from({ length: 20 }, (_unused, index) => textResponse(`finding ${index} details`)),
      usageResponse('turn A answer', 45_000),
      usageResponse('turn B answer', 45_000),
      withUsage(newContextCall(JSON.stringify({ handoff_path: handoffPath })), 45_000),
      usageResponse('continuing in window one', 45_000),
      usageResponse('turn D answer', 45_000),
    ]))

    await seedExchanges(agent, 20)
    await turnAt(agent, T0, 'turn A')
    expect(reminderTimes(session)).toEqual([])
    // Window 0 delivers at T0.
    await turnAt(agent, T0, 'turn B')
    expect(reminderTimes(session)).toEqual([T0])
    // One minute later, still inside window 0's cadence: the model rolls over in this turn.
    await turnAt(agent, T0 + MINUTE, 'turn C, roll over now and continue')
    expect(countRollovers(session)).toBe(1)
    await turnAt(agent, T0 + MINUTE + 1_000, 'turn D')

    // Window 1's first delivery happened less than five minutes after window 0's,
    // so the window boundary, not the cadence, allowed it.
    const times = reminderTimes(session)
    expect(times).toHaveLength(2)
    expect(times[0]).toBe(T0)
    expect(times[1]).toBeGreaterThanOrEqual(T0 + MINUTE)
    expect(times[1]).toBeLessThan(T0 + REMINDER_REPEAT_MS)
  })

  it('(i) negative elapsed: a reminder logged later than now refuses delivery until five minutes pass from it', async () => {
    const { agent, session } = await pressureSession('clock-back', [45_000])
    await turnAt(agent, T0, 'turn one')
    await turnAt(agent, T0, 'turn two')
    expect(reminderTimes(session)).toEqual([T0])
    // The clock moves a minute backward: now minus last is negative, so the gate refuses.
    await turnAt(agent, T0 - MINUTE, 'turn three')
    expect(reminderTimes(session)).toEqual([T0])
    expect(claimReminder(session, T0 - 1, REMINDER_REPEAT_MS)).toBe(false)
    // Still refused one millisecond before five minutes from the logged reminder.
    await turnAt(agent, T0 + REMINDER_REPEAT_MS - 1, 'turn four')
    expect(reminderTimes(session)).toEqual([T0])
    await turnAt(agent, T0 + REMINDER_REPEAT_MS, 'turn five')
    expect(reminderTimes(session)).toEqual([T0, T0 + REMINDER_REPEAT_MS])
  })

  it('(j) after a 20-minute idle gap, one pre-step delivers one reminder, not one per elapsed slot', async () => {
    const { agent, session } = await pressureSession('idle-gap', [45_000])
    await turnAt(agent, T0, 'turn one')
    await turnAt(agent, T0, 'turn two')
    expect(reminderTimes(session)).toEqual([T0])
    const resumed = T0 + 20 * MINUTE
    await turnAt(agent, resumed, 'turn three')
    expect(reminderTimes(session)).toEqual([T0, resumed])
    await turnAt(agent, resumed + 299_000, 'turn four')
    expect(reminderTimes(session)).toEqual([T0, resumed])
    await turnAt(agent, resumed + REMINDER_REPEAT_MS, 'turn five')
    expect(reminderTimes(session)).toEqual([T0, resumed, resumed + REMINDER_REPEAT_MS])
  })

  it('resetting claims only drops the in-memory record, not the log', async () => {
    const { agent, session } = await pressureSession('reset-only', [45_000])
    await turnAt(agent, T0, 'turn one')
    await turnAt(agent, T0, 'turn two')
    expect(reminderTexts(session)).toHaveLength(1)
    resetReminderClaims(session)
    expect(reminderTexts(session)).toHaveLength(1)
    expect(claimReminder(session, T0 + 1, REMINDER_REPEAT_MS)).toBe(false)
  })

  it('(k) reminderRepeatMs shortens the cadence, and the shipped default stays 300000', async () => {
    // The default the plan fixed, read from the resolver rather than restated.
    expect(resolveConfig({}).reminderRepeatMs).toBe(300_000)
    expect(DEFAULT_REMINDER_REPEAT_MS).toBe(300_000)
    // The old module constant is now that default under its old name.
    expect(REMINDER_REPEAT_MS).toBe(DEFAULT_REMINDER_REPEAT_MS)

    // Same usage and same turn times as case (c), with a one-minute configured
    // gap: the second reminder lands at T0 + 60s instead of T0 + 5min.
    const { agent, session } = await pressureSession('short-cadence', [45_000], { reminderRepeatMs: 60_000 })
    await turnAt(agent, T0, 'turn one')
    await turnAt(agent, T0, 'turn two')
    expect(reminderTimes(session)).toEqual([T0])
    await turnAt(agent, T0 + 59_999, 'turn three')
    expect(reminderTimes(session)).toEqual([T0])
    await turnAt(agent, T0 + 60_000, 'turn four')
    expect(reminderTimes(session)).toEqual([T0, T0 + 60_000])
    // The claim layer takes the same gap as a parameter.
    expect(claimReminder(session, T0 + 60_001, 60_000)).toBe(false)

    // The contrast arm: the identical turn times under the shipped default
    // deliver nothing after the first, so the short cadence above is the
    // configured value and not a change in the default.
    const shipped = await pressureSession('short-cadence-default', [45_000])
    await turnAt(shipped.agent, T0, 'turn one')
    await turnAt(shipped.agent, T0, 'turn two')
    expect(reminderTimes(shipped.session)).toEqual([T0])
    await turnAt(shipped.agent, T0 + 60_000, 'turn three')
    expect(reminderTimes(shipped.session)).toEqual([T0])
  })
})

describe('model-facing guidance', () => {
  it('states no fixed cadence, which reminderRepeatMs owns', () => {
    // The model reads this text, so it must not promise a repeat interval the
    // configuration can change. The shipped guidance names no number at all.
    expect(CONTEXT_MANAGEMENT_GUIDANCE).not.toContain('five minutes')
    expect(CONTEXT_MANAGEMENT_GUIDANCE).not.toContain('at most once per window')
  })
})
