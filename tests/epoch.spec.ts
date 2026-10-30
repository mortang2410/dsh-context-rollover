/**
 * Epoch reads for the idle rollover watchdog: the committed-rollover boundary,
 * the durable watchdog marker that disarms a session until the next committed
 * rollover, and the rebuild of a session from its own events.
 *
 * @module tests/epoch.spec
 */

import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent, UserMessage } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { armedFromLog, committedRollovers } from '../src/epoch.ts'
import { commitRollover, PLUGIN_NAME, ROLLOVER_PROVIDER, selectRolloverRange } from '../src/rollover.ts'
import { closedConversation } from './harness.ts'

/** The watchdog message the tests fire with. */
const MESSAGE = '/rollover'

/** A meter mounted on a bare context, for the real commit transaction. */
async function bareMeter(): Promise<TokenMeter> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  return ctx.tokenMeter
}

/** Append the `compaction/start` that opens a rollover transaction. */
function appendCompactionStart(session: Session, compactionId: CompactionId): void {
  session.append('compaction/start', { compactionId, turn: null })
}

/** Append this backend's `compaction/summary` for a transaction, shadowing the first surface node. */
function appendCompactionSummary(session: Session, compactionId: CompactionId, provider: string = ROLLOVER_PROVIDER): void {
  const first = session.surface.nodes[0]
  if (first === undefined) throw new Error('expected a surface node to shadow')
  session.append('compaction/summary', {
    compactionId,
    summary: [{ type: 'text', text: 'summary' }],
    shadowedRange: { start: first, end: first },
    shadowedSeqs: [first],
    shadowedTokenCount: 0,
    provider,
    model: 'deterministic/window-1',
  })
}

/**
 * Append the `compaction/end` that closes a rollover transaction. Pass an error
 * to write the end a failed attempt leaves behind.
 * @returns the appended end event, whose sequence the boundary is compared by.
 */
function appendCompactionEnd(session: Session, compactionId: CompactionId, error?: string): SessionEvent<'compaction/end'> {
  return session.append('compaction/end', error === undefined
    ? { compactionId, turn: null }
    : { compactionId, turn: null, error })
}

/**
 * Append one whole committed rollover transaction: start, this backend's
 * summary, and an end without an error.
 * @returns the appended end event.
 */
function appendCommittedRollover(session: Session): SessionEvent<'compaction/end'> {
  const compactionId = CompactionId(randomUUID())
  appendCompactionStart(session, compactionId)
  appendCompactionSummary(session, compactionId)
  return appendCompactionEnd(session, compactionId)
}

/** A user message with one text block from a person, the shape a watchdog fire is logged with. */
function directMessage(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** A user message with one text block from a plugin notice rather than a person. */
function pluginMessage(text: string) {
  return createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: PLUGIN_NAME, form: 'notice', summary: 'test notice' },
  })
}

/** Append a direct user message to the log. */
function appendDirectUserMessage(session: Session, text: string): void {
  session.append('user/message', directMessage(text), { surfaceOp: 'append' })
}

/** Append a user message from a plugin notice to the log. */
function appendPluginMessage(session: Session, text: string): void {
  session.append('user/message', pluginMessage(text), { surfaceOp: 'append' })
}

/**
 * Append an `agent/inbox/spliced` that queues one message in the pending next-turn
 * inbox. This is the log shape of a queued watchdog fire, written before any step
 * admits it.
 * @param session - the session to append to.
 * @param message - the message the splice inserts.
 */
function appendQueuedMessage(session: Session, message: UserMessage): void {
  session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
}

/**
 * Append an `agent/inbox/spliced` that removes one queued message. A cancel logs
 * this shape, and it carries no copy of the removed message.
 * @param session - the session to append to.
 */
function appendQueuedRemoval(session: Session): void {
  session.append('agent/inbox/spliced', {
    target: 'next-turn',
    start: 0,
    removedCount: 1,
    inserted: [],
    outcome: 'canceled',
  })
}

/**
 * Whether the log holds a `user/message` with a text block equal to the watchdog
 * message. Used to prove a test's marker is the only copy in its log.
 * @param session - the session to read.
 * @returns true when such a message is logged.
 */
function hasUserMessageMarker(session: Session): boolean {
  return session.snapshotEvents().some(event => event.type === 'user/message'
    && event.data.content.some(block => block.type === 'text' && block.text === MESSAGE))
}

describe('committedRollovers', () => {
  it('counts a rollover once its non-error end lands, matched by compaction id', () => {
    const session = closedConversation(2)
    const compactionId = CompactionId(randomUUID())
    appendCompactionStart(session, compactionId)
    appendCompactionSummary(session, compactionId)
    expect(committedRollovers(session)).toEqual({ count: 0 })

    const end = appendCompactionEnd(session, compactionId)
    expect(committedRollovers(session)).toEqual({ count: 1, newestEndSeq: end.seq })
  })

  it('does not count an end whose compaction id differs from its summary', () => {
    const session = closedConversation(2)
    appendCompactionStart(session, CompactionId(randomUUID()))
    appendCompactionSummary(session, CompactionId('summary-id'))
    appendCompactionEnd(session, CompactionId('other-id'))
    expect(committedRollovers(session)).toEqual({ count: 0 })
  })

  it('does not count a summary followed by an error end, and the count does not move', () => {
    const session = closedConversation(2)
    const committed = appendCommittedRollover(session)
    expect(committedRollovers(session)).toEqual({ count: 1, newestEndSeq: committed.seq })

    const failedId = CompactionId(randomUUID())
    appendCompactionStart(session, failedId)
    appendCompactionSummary(session, failedId)
    appendCompactionEnd(session, failedId, 'simulated failure after the summary')
    expect(committedRollovers(session)).toEqual({ count: 1, newestEndSeq: committed.seq })
  })

  it('does not count a summary with no end', () => {
    const session = closedConversation(2)
    const compactionId = CompactionId(randomUUID())
    appendCompactionStart(session, compactionId)
    appendCompactionSummary(session, compactionId)
    expect(committedRollovers(session)).toEqual({ count: 0 })
  })

  it('does not count a summary and end that have no start', () => {
    const session = closedConversation(2)
    const compactionId = CompactionId(randomUUID())
    appendCompactionSummary(session, compactionId)
    appendCompactionEnd(session, compactionId)
    expect(committedRollovers(session)).toEqual({ count: 0 })
  })

  it('does not count a summary written by another backend', () => {
    const session = closedConversation(2)
    const compactionId = CompactionId(randomUUID())
    appendCompactionStart(session, compactionId)
    appendCompactionSummary(session, compactionId, 'another-backend')
    appendCompactionEnd(session, compactionId)
    expect(committedRollovers(session)).toEqual({ count: 0 })
  })

  it('recognises the rollover that the real commit transaction writes', async () => {
    const meter = await bareMeter()
    const session = closedConversation(4, 10)
    const measurement = meter.measure(session)
    const range = selectRolloverRange(session, measurement, { kind: 'tail', retainTokens: 0 })
    if (range === null) throw new Error('expected a compactable range')

    const result = await commitRollover(
      { meter },
      session,
      range.start,
      range.end,
      {
        owner: null,
        replacement: {
          kind: 'checkpoint',
          checkpoint: {
            reason: 'model-requested',
            windowNumber: 1,
            notes: '- goal: prove the boundary',
            handoff: 'Continue from the notes.',
          },
        },
      },
    )
    expect(committedRollovers(session)).toEqual({ count: 1, newestEndSeq: result.endSeq })
  })
})

describe('armedFromLog', () => {
  it('is armed in a session with no committed rollover and no marker', () => {
    expect(armedFromLog(closedConversation(2), MESSAGE)).toBe(true)
  })

  it('is not disarmed by a user/message marker written before the newest committed end', () => {
    const session = closedConversation(2)
    appendDirectUserMessage(session, MESSAGE)
    appendCommittedRollover(session)
    expect(armedFromLog(session, MESSAGE)).toBe(true)
  })

  it('is not disarmed by a queued marker written before the newest committed end', () => {
    const session = closedConversation(2)
    appendQueuedMessage(session, directMessage(MESSAGE))
    appendCommittedRollover(session)
    expect(armedFromLog(session, MESSAGE)).toBe(true)
  })

  it('is disarmed by a user/message marker after the newest committed end', () => {
    const session = closedConversation(2)
    appendCommittedRollover(session)
    appendDirectUserMessage(session, MESSAGE)
    expect(armedFromLog(session, MESSAGE)).toBe(false)
  })

  it('is disarmed by a queued marker after the newest committed end when the log has no user/message copy', () => {
    const session = closedConversation(2)
    appendCommittedRollover(session)
    appendQueuedMessage(session, directMessage(MESSAGE))
    expect(hasUserMessageMarker(session)).toBe(false)
    expect(armedFromLog(session, MESSAGE)).toBe(false)
  })

  it('stays disarmed when the queued marker is removed afterwards, because the attempt happened', () => {
    const session = closedConversation(2)
    appendCommittedRollover(session)
    appendQueuedMessage(session, directMessage(MESSAGE))
    appendQueuedRemoval(session)
    expect(armedFromLog(session, MESSAGE)).toBe(false)
  })

  it('is armed again by a later committed end', () => {
    const session = closedConversation(2)
    appendCommittedRollover(session)
    appendDirectUserMessage(session, MESSAGE)
    appendCommittedRollover(session)
    expect(armedFromLog(session, MESSAGE)).toBe(true)
  })

  it('is not re-armed by a summary followed by an error end', () => {
    const session = closedConversation(2)
    appendCommittedRollover(session)
    appendDirectUserMessage(session, MESSAGE)
    const failedId = CompactionId(randomUUID())
    appendCompactionStart(session, failedId)
    appendCompactionSummary(session, failedId)
    appendCompactionEnd(session, failedId, 'simulated failure after the summary')
    expect(armedFromLog(session, MESSAGE)).toBe(false)
  })

  it('is not disarmed by a direct user message whose text differs from the configured message', () => {
    const session = closedConversation(2)
    appendCommittedRollover(session)
    appendDirectUserMessage(session, 'a question typed by the owner')
    expect(armedFromLog(session, MESSAGE)).toBe(true)
  })

  it('is not disarmed by a user/message with the configured text that is not user-authored', () => {
    const session = closedConversation(2)
    appendCommittedRollover(session)
    appendPluginMessage(session, MESSAGE)
    expect(armedFromLog(session, MESSAGE)).toBe(true)
  })

  it('is not disarmed by a queued message with the configured text that is not user-authored', () => {
    const session = closedConversation(2)
    appendCommittedRollover(session)
    appendQueuedMessage(session, pluginMessage(MESSAGE))
    expect(armedFromLog(session, MESSAGE)).toBe(true)
  })

  it('is not disarmed by a user message that carries the configured text among other content', () => {
    const session = closedConversation(2)
    appendCommittedRollover(session)
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: MESSAGE }, { type: 'text', text: 'and more' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    expect(armedFromLog(session, MESSAGE)).toBe(true)
  })
})

describe('rebuild equivalence', () => {
  it('gives the same committed boundary and armed verdict for a session rebuilt from the same events', () => {
    const original = closedConversation(2)
    appendCommittedRollover(original)
    appendDirectUserMessage(original, MESSAGE)

    const rebuilt = Session.create(SessionId(`rebuilt-${randomUUID()}`), original.snapshotEvents())
    expect(committedRollovers(rebuilt)).toEqual(committedRollovers(original))
    expect(armedFromLog(rebuilt, MESSAGE)).toBe(armedFromLog(original, MESSAGE))
    expect(armedFromLog(rebuilt, MESSAGE)).toBe(false)
  })

  it('gives the same armed verdict for a rebuilt session whose marker is a queued splice that was later removed', () => {
    const original = closedConversation(2)
    appendCommittedRollover(original)
    appendQueuedMessage(original, directMessage(MESSAGE))
    appendQueuedRemoval(original)

    const rebuilt = Session.create(SessionId(`rebuilt-${randomUUID()}`), original.snapshotEvents())
    expect(armedFromLog(rebuilt, MESSAGE)).toBe(armedFromLog(original, MESSAGE))
    expect(armedFromLog(rebuilt, MESSAGE)).toBe(false)
  })
})
