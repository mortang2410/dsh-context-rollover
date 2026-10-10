/**
 * The pressure reminder's placeholders and wording, per rollover mode.
 *
 * Structured mode fills three placeholders at the nag point: the percentage,
 * the window number (countRollovers + 1), and the automatic point in tokens
 * (floor(contextWindow * thresholdRatio)). Upstream mode keeps the upstream
 * wording. Every case runs through the real engine and the scripted model
 * adapter, and reads the reminders the durable log actually carries.
 *
 * Window script: turn one's reply anchors the meter at 45,005 tokens, so the
 * window-1 reminder fires at turn two's first request. Turn two's reply reads
 * 46,005 tokens, so window 1 is still above the nag point at turn three, where
 * no second reminder may appear. Turn three's reply asks for a rollover with
 * `new_context`, and the rollover commits. The next reply reads 45,005 tokens
 * again, so the window-2 reminder fires at turn four.
 *
 * Fixture choices that keep the readings honest:
 * - The opening reply is padded to about 40,000 tokens to match its reading.
 *   The token meter prices text at four characters per token, and a reading
 *   the text cannot account for leaves a stale total after a rollover.
 * - The rollover is the model's `new_context` call, not the 90% pressure path.
 *   A pressure rollover runs before the newest message is logged, and the
 *   retained tail keeps the newest logged message whole, so a padded reply
 *   there would survive and set the window-2 percentage. A `new_context`
 *   rollover runs after the reply, so the padded opening reply is removed.
 * - `retainTokens: 0` keeps only the newest message in the tail, so the
 *   post-rollover total stays far below the nag point.
 * - The usage readings are declared, so the percentage is 45 in both windows:
 *   the few heuristic tokens added after each reading move the total by far
 *   less than half a percent.
 *
 * @module tests/reminder-wording.spec
 */

import { describe, expect, it } from 'vitest'
import { countRollovers } from '../src/rollover.ts'
import {
  CONTEXT_WINDOW,
  engineHarness,
  followup,
  newContextCall,
  reminderTexts,
  ScriptedAdapter,
  usageResponse,
} from './harness.ts'

/** The approved structured-handoff wording, window 1, with its placeholder values. */
const WINDOW_ONE_REMINDER = 'Context is 45% full, in window 1. '
  + 'Write your handoff as a new note with the notes tool, at HANDOFF-YYYY-MM-DD-HH-MM-<task-description>.md, '
  + 'using the current date and time to the minute. Follow the /handoff-doc sections, keep the note under 20,000 characters, '
  + 'and state window 1 at its top. '
  + 'To register it, call the notes tool with action "write", path "HANDOFF-YYYY-MM-DD-HH-MM-<task-description>.md", '
  + 'and text set to the complete handoff. Write replaces any file with the same name, so use a new name each window. '
  + 'Example: action "write", path "HANDOFF-2026-10-10-14-30-parser-fix.md", text "Window 2. Goal: fix the parser null check. Next: add the regression test." '
  + 'Then call new_context. An automatic rollover starts around 90000 tokens.'

/** The same approved wording in window 2, after one rollover. */
const WINDOW_TWO_REMINDER = 'Context is 45% full, in window 2. '
  + 'Write your handoff as a new note with the notes tool, at HANDOFF-YYYY-MM-DD-HH-MM-<task-description>.md, '
  + 'using the current date and time to the minute. Follow the /handoff-doc sections, keep the note under 20,000 characters, '
  + 'and state window 2 at its top. '
  + 'To register it, call the notes tool with action "write", path "HANDOFF-YYYY-MM-DD-HH-MM-<task-description>.md", '
  + 'and text set to the complete handoff. Write replaces any file with the same name, so use a new name each window. '
  + 'Example: action "write", path "HANDOFF-2026-10-10-14-30-parser-fix.md", text "Window 2. Goal: fix the parser null check. Next: add the regression test." '
  + 'Then call new_context. An automatic rollover starts around 90000 tokens.'

/** The upstream reminder wording; only the measured token count varies. */
const UPSTREAM_REMINDER_PATTERN = new RegExp(
  '^Context window: 45% used \\(~\\d+ of 100000 tokens\\)\\. '
  + 'An automatic rollover starts around 90000 tokens\\. '
  + 'If a task boundary is near, save what matters to notes and call new_context with a short handoff; '
  + 'otherwise checkpoint soon\\.$',
)

/** The deployment thresholds and a one-message tail, set explicitly in every case. */
const CONFIG = {
  thresholdRatio: 0.9,
  reminderThresholdRatio: 0.4,
  retainTokens: 0,
} as const

/** Text the token meter prices at roughly `tokens` tokens (four characters per token). */
function padding(tokens: number): string {
  return 'x'.repeat(tokens * 4)
}

/**
 * One scripted model response per request, in order: turn one's padded reply,
 * turn two's reply, turn three's rollover request, the reply after the
 * rollover, then plain replies.
 */
const WINDOW_SCRIPT = [
  usageResponse(padding(40000), 45000),
  usageResponse('answer two', 46000),
  newContextCall('{"handoff":"Continue the work."}'),
  usageResponse('continuing', 45000),
  usageResponse('answer four', 46000),
  usageResponse('answer five', 47000),
  usageResponse('answer six', 48000),
]

describe('pressure reminder placeholders and wording', () => {
  it('structured mode: the nag reminder is the approved wording, exactly', async () => {
    const { ctx, agent, session } = await engineHarness('wording-exact', {
      mode: 'structured-handoff',
      ...CONFIG,
    })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponse('answer 1', 45000),
      usageResponse('answer 2', 46000),
    ]))

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')

    expect(reminderTexts(session)).toEqual([WINDOW_ONE_REMINDER])
  })

  it('window placeholder: window 1 before any rollover, window 2 after one rollover', async () => {
    const { ctx, agent, session } = await engineHarness('wording-window', {
      mode: 'structured-handoff',
      ...CONFIG,
    })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter(WINDOW_SCRIPT))

    await followup(agent, 'turn one')
    expect(countRollovers(session)).toBe(0)
    expect(reminderTexts(session)).toEqual([])

    // Turn two's first request carries the window-1 reminder, before any rollover.
    await followup(agent, 'turn two')
    expect(countRollovers(session)).toBe(0)
    expect(reminderTexts(session)).toEqual([WINDOW_ONE_REMINDER])

    // Turn three's reply asks for the rollover, which commits in that turn.
    await followup(agent, 'turn three')
    expect(countRollovers(session)).toBe(1)
    expect(reminderTexts(session)).toEqual([WINDOW_ONE_REMINDER])

    // The first request of window 2 carries the window-2 reminder.
    await followup(agent, 'turn four')
    expect(reminderTexts(session)).toEqual([WINDOW_ONE_REMINDER, WINDOW_TWO_REMINDER])
  })

  it('rollover placeholder: floor(contextWindow * thresholdRatio), not the reminder ratio', async () => {
    const { ctx, agent, session } = await engineHarness('wording-rollover', {
      mode: 'structured-handoff',
      ...CONFIG,
    })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponse('answer 1', 45000),
      usageResponse('answer 2', 46000),
    ]))

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')

    const [text] = reminderTexts(session)
    const automaticPoint = Math.floor(CONTEXT_WINDOW * CONFIG.thresholdRatio)
    const reminderPoint = Math.floor(CONTEXT_WINDOW * CONFIG.reminderThresholdRatio)
    expect(automaticPoint).toBe(90000)
    expect(reminderPoint).toBe(40000)
    expect(text).toContain(`An automatic rollover starts around ${automaticPoint} tokens.`)
    expect(text).not.toContain(`around ${reminderPoint} tokens`)
  })

  it('fires once per window: not repeated within a window, and again once after a rollover', async () => {
    const { ctx, agent, session } = await engineHarness('wording-once', {
      mode: 'structured-handoff',
      ...CONFIG,
    })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter(WINDOW_SCRIPT))

    // Window 1: turn two delivers the reminder, and turn two's reply keeps the
    // window above the nag point.
    await followup(agent, 'turn one')
    await followup(agent, 'turn two')
    expect(countRollovers(session)).toBe(0)
    expect(reminderTexts(session)).toEqual([WINDOW_ONE_REMINDER])

    // Turn three is still above the nag point in window 1: no repeat, then the rollover.
    await followup(agent, 'turn three')
    expect(countRollovers(session)).toBe(1)
    expect(reminderTexts(session)).toEqual([WINDOW_ONE_REMINDER])

    // Window 2: the next turn's first request carries the window-2 reminder once.
    await followup(agent, 'turn four')
    expect(reminderTexts(session)).toEqual([WINDOW_ONE_REMINDER, WINDOW_TWO_REMINDER])

    // Later turns above the nag point in window 2 add nothing.
    await followup(agent, 'turn five')
    await followup(agent, 'turn six')
    expect(reminderTexts(session)).toEqual([WINDOW_ONE_REMINDER, WINDOW_TWO_REMINDER])
  })

  it('upstream mode: the nag reminder keeps the upstream wording', async () => {
    const { ctx, agent, session } = await engineHarness('wording-upstream', {
      mode: 'upstream',
      ...CONFIG,
    })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponse('answer 1', 45000),
      usageResponse('answer 2', 46000),
    ]))

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')

    const texts = reminderTexts(session)
    expect(texts).toHaveLength(1)
    expect(texts[0]).toMatch(UPSTREAM_REMINDER_PATTERN)
    expect(texts[0]).not.toContain('in window')
  })
})
