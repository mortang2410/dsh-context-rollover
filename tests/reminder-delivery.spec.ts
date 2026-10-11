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
 * share, so `reminderDelivered` decides, and `claimReminder` adds the
 * synchronous claim that the same module instance needs inside one waterfall.
 *
 * @module tests/reminder-delivery
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Session } from '@deepseek-ai/dsh-session'
import { DEFAULT_REMINDER_MESSAGE, resolveConfig } from '../src/config.ts'
import {
  claimReminder,
  countRollovers,
  isPressureReminder,
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
    expect(fresh.claimReminder(session)).toBe(false)

    // Clearing the in-process claims does not reopen the window: the log is
    // the durable authority, and it still carries the delivered reminder.
    resetReminderClaims(session)
    expect(claimReminder(session)).toBe(false)
    expect(fresh.claimReminder(session)).toBe(false)
  })

  it('claims once per window, not once per session', async () => {
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

    // Same window: neither a repeat call nor a later turn may claim again.
    const key = reminderWindowKey(session)
    expect(claimReminder(session)).toBe(false)
    await followup(agent, 'turn three')
    expect(reminderTexts(session)).toHaveLength(1)
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
  it('fires exactly once after usage crosses 40% and not again in the same window', async () => {
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

    // Same window, later turn: the reminder must not repeat.
    await followup(agent, 'turn three')
    expect(reminderTexts(session)).toHaveLength(1)
    // No rollover happened, so the window never advanced.
    expect(countRollovers(session)).toBe(0)
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

describe('reminder configuration defaults and validation', () => {
  it('pins the shipped default message and the 40% / 90% defaults', () => {
    // The acceptance criterion is that the DEFAULT is exactly this text, so
    // the literal is pinned here rather than derived from the constant under
    // test. The backticks are part of the required text.
    expect(DEFAULT_REMINDER_MESSAGE).toBe(
      'Context is {percent}% full. Use `/handoff-doc` to create/update the durable handoff document. '
      + 'Make it fully sufficient for a fresh context to continue the work. After it succeeds, call '
      + '`new_context`. The handoff document, plus any recent chat kept after the rollover, will be the '
      + 'continuation context.',
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
