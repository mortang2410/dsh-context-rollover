/**
 * Which stored notices count as this engine's pressure reminder.
 *
 * The current sender writes the engine's plugin name as the source kind. A
 * session written by the released engine, or migrated by the host's V3 to V4
 * session migration, can carry two other shapes for the same reminder. Both
 * must suppress a second reminder in their window. A notice from a different
 * plugin must not.
 *
 * @module tests/reminder-source-forms
 */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { MessageSource } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { describe, expect, it } from 'vitest'
import {
  isPressureReminder,
  PLUGIN_NAME,
  REMINDER_SUMMARY_PREFIX,
  reminderDelivered,
} from '../src/rollover.ts'
import {
  engineHarness,
  followup,
  reminderTexts,
  ScriptedAdapter,
  usageResponse,
} from './harness.ts'

/** Every case is an independent session, so ids must not collide in one process. */
let caseId = 0
const sessionId = (label: string): string => `reminder-forms-${label}-${(caseId += 1)}`

/** The three source shapes that name this engine's reminder, with their labels. */
const ENGINE_SOURCE_FORMS: ReadonlyArray<readonly [string, Readonly<Record<string, unknown>>]> = [
  ['current kind', { kind: PLUGIN_NAME }],
  ['migrated kind', { kind: `plugin:${PLUGIN_NAME}` }],
  ['legacy plugin wrapper', { kind: 'plugin', plugin: PLUGIN_NAME }],
]

/** A notice source of the given shape: the reminder form and summary the sender writes. */
function noticeSource(shape: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return { ...shape, form: 'notice', summary: `${REMINDER_SUMMARY_PREFIX} (40% used)` }
}

/** Append one notice carrying the given source, as a stored session would carry it. */
function storeNotice(session: Session, source: Readonly<Record<string, unknown>>): SessionEvent {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'Context window: 40% used (stored earlier)' }],
    source: source as unknown as MessageSource,
  }), { surfaceOp: 'append' })
  const stored = session.snapshotEvents().at(-1)
  if (stored === undefined) throw new Error('expected the stored notice in the log')
  return stored
}

/** Count every notice whose summary is the pressure reminder's, whatever its source kind. */
function reminderNoticeCount(session: Session): number {
  return session.snapshotEvents().filter((event) => {
    if (event.type !== 'user/message') return false
    const summary: unknown = Reflect.get(event.data.source, 'summary')
    return typeof summary === 'string' && summary.startsWith(REMINDER_SUMMARY_PREFIX)
  }).length
}

describe('pressure reminder source forms: suppression', () => {
  it.each(ENGINE_SOURCE_FORMS)(
    'a reminder stored with the %s source suppresses a second reminder in its window',
    async (_label, shape) => {
      const { ctx, agent, session } = await engineHarness(sessionId('suppress'), {
        thresholdRatio: 0.5,
        reminderThresholdRatio: 0.01,
      })
      ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
        usageResponse('answer 1', 5000),
        usageResponse('answer 2', 6000),
      ]))

      // Turn one closes first; the stored notice then sits in the current
      // window, and turn two would otherwise deliver the engine's own reminder.
      await followup(agent, 'turn one')
      const stored = storeNotice(session, noticeSource(shape))
      expect(isPressureReminder(stored)).toBe(true)

      await followup(agent, 'turn two')
      expect(reminderNoticeCount(session)).toBe(1)
      expect(reminderDelivered(session)).toBe(true)
    },
  )
})

describe('pressure reminder source forms: a notice from another plugin', () => {
  it('does not suppress the engine reminder when the plugin name only shares a prefix', async () => {
    const { ctx, agent, session } = await engineHarness(sessionId('foreign'), {
      thresholdRatio: 0.5,
      reminderThresholdRatio: 0.01,
    })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponse('answer 1', 5000),
      usageResponse('answer 2', 6000),
    ]))

    await followup(agent, 'turn one')
    const foreign = storeNotice(session, noticeSource({ kind: 'plugin:context-rollover-extra' }))
    expect(isPressureReminder(foreign)).toBe(false)

    await followup(agent, 'turn two')
    // The foreign notice and the engine's own reminder both sit in the log,
    // but only the engine's reminder counts as this engine's delivery.
    expect(reminderNoticeCount(session)).toBe(2)
    expect(reminderTexts(session)).toHaveLength(1)
  })
})

describe('pressure reminder source forms: shapes that must not match', () => {
  it.each([
    ['the plugin wrapper under a different plugin name', { kind: 'plugin', plugin: 'context-rollover-extra' }],
    ['the plugin wrapper under the package name', { kind: 'plugin', plugin: 'dsh-context-rollover' }],
    ['a migrated kind under a different plugin name', { kind: 'plugin:context-rollover-extra' }],
  ])("%s is not this engine's reminder", (_label, shape) => {
    const session = Session.create(SessionId(sessionId('nomatch')))
    const stored = storeNotice(session, noticeSource(shape))
    expect(isPressureReminder(stored)).toBe(false)
    expect(reminderDelivered(session)).toBe(false)
  })
})
