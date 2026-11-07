/**
 * The restart proof: the candidate file is what carries an idle session across a
 * host restart, and the restarted host reopens the stored session to wake it.
 *
 * Each case builds a full host-shaped context, marks a candidate, disposes that
 * context entirely, then mounts a new engine over the same candidate file and
 * the same stored sessions. The clock picks up where the first host stopped, so
 * the idle time is never reset by the restart itself.
 *
 * @module tests/idle-restart
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  AFTER_MS,
  MINUTE,
  T0,
  TICK_MS,
  advance,
  cleanupReopen,
  disposeEarly,
  openRig,
  openStoredTurn,
  recordAt,
  seedOf,
  settle,
  storedEvents,
  useReopenClock,
  userTexts,
} from './reopen-rig.ts'

beforeEach(useReopenClock)
afterEach(cleanupReopen)

describe('idle restart', () => {
  it('fires from the candidate file after the owning context is recreated over the same files', async () => {
    const first = await openRig()
    const sessionId = SessionId('restarted')
    const handle = await openStoredTurn(first.ctx, sessionId)
    await advance(TICK_MS)
    expect(recordAt(first.candidatePath, sessionId)?.lastOutcome).toBe('marked')
    await handle.dispose()
    // The whole host goes away: engine, agents, persistence handles, and every
    // in-memory watchdog set. The candidate file and the stored log are all
    // that survives into the successor, which is what a real restart leaves.
    const seed = seedOf(first)
    await disposeEarly(first.ctx)

    const second = await openRig({ candidatePath: first.candidatePath, seed })
    expect(second.ctx.agents.get(sessionId)).toBeUndefined()

    await advance(AFTER_MS + TICK_MS)
    await settle(() => recordAt(first.candidatePath, sessionId)?.lastOutcome === 'sent')

    expect(recordAt(first.candidatePath, sessionId)?.lastOutcome).toBe('sent')
    const carried = second.adapter.recorded.some(request => request.messages.some(message =>
      message.content.some(block => block.type === 'text' && block.text.includes('/rollover'))))
    expect(carried).toBe(true)
    const events = await storedEvents(second.ctx, sessionId)
    expect(userTexts(events, '/rollover')).toBe(1)
  })

  it('wakes a session that was idle 39 minutes before the restart one minute after it', async () => {
    const first = await openRig()
    const sessionId = SessionId('just-under')
    const handle = await openStoredTurn(first.ctx, sessionId)
    await advance(TICK_MS)
    expect(recordAt(first.candidatePath, sessionId)?.lastOutcome).toBe('marked')
    // The host lives on for 39 idle minutes, then restarts one minute short of the threshold.
    vi.setSystemTime(T0 + 39 * MINUTE)
    await handle.dispose()
    const seed = seedOf(first)
    await disposeEarly(first.ctx)

    const second = await openRig({ candidatePath: first.candidatePath, seed })
    // The successor mounted one minute early: the record still reads as marked, nothing fired.
    expect(recordAt(first.candidatePath, sessionId)?.lastOutcome).toBe('marked')
    expect(second.ctx.agents.get(sessionId)).toBeUndefined()

    // The first tick of the successor crosses the 40-minute mark.
    await advance(MINUTE)
    await settle(() => recordAt(first.candidatePath, sessionId)?.lastOutcome === 'sent')

    expect(recordAt(first.candidatePath, sessionId)?.lastOutcome).toBe('sent')
    const events = await storedEvents(second.ctx, sessionId)
    expect(userTexts(events, '/rollover')).toBe(1)
  })
})
