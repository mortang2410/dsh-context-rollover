/**
 * The handoff size limit that the structured-handoff wording states.
 *
 * The reminder and the guidance tell the model the configured handoffMaxChars,
 * which is the same limit the notes snapshot is cut at. The number is formatted
 * with comma thousands separators and comes from the configured value, never
 * from a fixed constant.
 *
 * @module tests/budget-wording.spec
 */

import { describe, expect, it } from 'vitest'
import type { RolloverConfig } from '../src/config.ts'
import { buildContextManagementGuidance } from '../src/guidance.ts'
import { buildReminderText, type ReminderInput } from '../src/reminder.ts'
import { engineHarness, followup, reminderTexts, ScriptedAdapter, usageResponse } from './harness.ts'

/** The reminder inputs for one window, without the budget, which each case supplies. */
const REMINDER_INPUT: Omit<ReminderInput, 'handoffMaxChars'> = {
  mode: 'structured-handoff',
  percent: 45,
  windowNumber: 1,
  totalTokens: 45000,
  contextWindow: 100000,
  rolloverTokens: 90000,
}

/**
 * Run two turns through the real engine in structured-handoff mode, so the
 * reminder is delivered at turn two, and read what the model receives.
 * @returns the pressure reminders the durable log carries, and the system text
 *   sent with the first request.
 */
async function deliveredWording(
  id: string,
  config: Partial<RolloverConfig>,
): Promise<{ reminders: string[]; system: string }> {
  const { ctx, agent, session } = await engineHarness(id, {
    mode: 'structured-handoff',
    thresholdRatio: 0.9,
    reminderThresholdRatio: 0.4,
    retainTokens: 0,
    ...config,
  })
  const adapter = new ScriptedAdapter([
    usageResponse('answer 1', 45000),
    usageResponse('answer 2', 46000),
  ])
  ctx.llm.registerAdapter(['mock'], adapter)
  await followup(agent, 'turn one')
  await followup(agent, 'turn two')
  const [first] = adapter.requests
  if (first === undefined) throw new Error('the scripted adapter recorded no request')
  const parts: string[] = []
  for (const message of first) {
    if (message.role !== 'system') continue
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text)
    }
  }
  return { reminders: reminderTexts(session), system: parts.join('\n') }
}

describe('structured-handoff budget wording from the builders', () => {
  it('the default budget reads 20,000 characters in the reminder and in the guidance', () => {
    expect(buildReminderText({ ...REMINDER_INPUT, handoffMaxChars: 20000 })).toContain('20,000 characters')
    expect(buildContextManagementGuidance('structured-handoff', 20000)).toContain('20,000 characters')
  })

  it('a configured 8000 budget reads 8,000 characters and never 20,000', () => {
    const reminder = buildReminderText({ ...REMINDER_INPUT, handoffMaxChars: 8000 })
    const guidance = buildContextManagementGuidance('structured-handoff', 8000)
    for (const text of [reminder, guidance]) {
      expect(text).toContain('8,000 characters')
      expect(text).not.toContain('20,000')
    }
  })

  it('takes the number from the configured value, not from a fixed constant', () => {
    expect(buildReminderText({ ...REMINDER_INPUT, handoffMaxChars: 12345 })).toContain('12,345 characters')
    expect(buildContextManagementGuidance('structured-handoff', 12345)).toContain('12,345 characters')
  })
})

describe('structured-handoff budget wording as the engine delivers it', () => {
  it('the default budget: the logged reminder and the system text both say 20,000 characters', async () => {
    const { reminders, system } = await deliveredWording('budget-default', {})
    const [reminder] = reminders
    expect(reminders).toHaveLength(1)
    expect(reminder).toContain('20,000 characters')
    expect(system).toContain('20,000 characters')
  })

  it('a configured 8000 budget: the logged reminder and the system text say 8,000 and never 20,000', async () => {
    const { reminders, system } = await deliveredWording('budget-8000', { handoffMaxChars: 8000 })
    const [reminder] = reminders
    expect(reminders).toHaveLength(1)
    for (const text of [reminder, system]) {
      expect(text).toContain('8,000 characters')
      expect(text).not.toContain('20,000')
    }
  })
})
