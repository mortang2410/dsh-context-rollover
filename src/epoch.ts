/**
 * The idle rollover watchdog's epoch reads over one session's durable log: the
 * committed-rollover boundary, and the watchdog marker that disarms a session
 * until the next committed rollover. Both verdicts are reads of the log, so they
 * hold after a host restart and in a session rebuilt from its events.
 *
 * @module dsh-context-rollover/epoch
 */

import type { Session, SessionSeq, UserMessage } from '@deepseek-ai/dsh-session'
import { sessionEvents } from './compat.ts'
import { ROLLOVER_PROVIDER } from './rollover.ts'

/** The committed-rollover boundary of one session, read from its durable log. */
export interface CommittedRollovers {
  /** Committed rollovers so far (0 = the first window is still active). */
  readonly count: number
  /**
   * Log position of the newest committed `compaction/end`. Absent when no
   * rollover has committed.
   */
  readonly newestEndSeq?: SessionSeq
}

/**
 * Read the committed rollovers of one session. A rollover is committed when a
 * `compaction/start`, a `compaction/summary` from this backend, and a
 * `compaction/end` without an error carry the same compaction id, each logged
 * before the end. A summary whose end carries an error, and a summary with no
 * end, are not committed. The boundary is compared by log sequence, not by event
 * time, because two events can share a millisecond and only the log order decides
 * which end is newest.
 * @param session - the session to read.
 * @returns the committed count and the sequence of the newest committed end.
 */
export function committedRollovers(session: Session): CommittedRollovers {
  const started = new Set<string>()
  const summarized = new Set<string>()
  const committed = new Set<string>()
  let newestEndSeq: SessionSeq | undefined
  for (const event of sessionEvents(session)) {
    if (event.type === 'compaction/start') {
      started.add(event.data.compactionId)
    } else if (event.type === 'compaction/summary') {
      if (event.data.provider === ROLLOVER_PROVIDER) summarized.add(event.data.compactionId)
    } else if (event.type === 'compaction/end' && event.data.error === undefined) {
      const compactionId = event.data.compactionId
      if (started.has(compactionId) && summarized.has(compactionId)) {
        committed.add(compactionId)
        newestEndSeq = event.seq
      }
    }
  }
  return newestEndSeq === undefined
    ? { count: committed.size }
    : { count: committed.size, newestEndSeq }
}

/**
 * Whether one logged user message is the watchdog marker: a direct user message
 * whose only content is one text block equal to the configured message. A message
 * from a plugin notice, or one with any other content, is not the marker.
 * @param message - the logged user message.
 * @param text - the configured watchdog message text.
 * @returns true when the message is the watchdog marker.
 */
function isWatchdogMessage(message: UserMessage, text: string): boolean {
  const [block] = message.content
  return message.source.kind === 'user'
    && message.content.length === 1
    && block?.type === 'text'
    && block.text === text
}

/**
 * Whether the watchdog may fire in this session's current epoch. The session is
 * disarmed by a watchdog marker logged after the newest committed rollover end.
 * A marker is either a `user/message` that is the watchdog message, or an
 * `agent/inbox/spliced` that inserts such a message into a pending inbox. The
 * splice is logged when the message is queued, before any step admits it, and it
 * stays in the log after the message is later removed, so a removed fire still
 * counts: the attempt happened. Both shapes are read from the log, so the marker
 * survives a host restart.
 * @param session - the session to read.
 * @param message - the configured watchdog message text.
 * @returns true when no marker sits after the newest committed end.
 */
export function armedFromLog(session: Session, message: string): boolean {
  const { newestEndSeq } = committedRollovers(session)
  for (const event of sessionEvents(session)) {
    if (newestEndSeq !== undefined && event.seq <= newestEndSeq) continue
    if (event.type === 'user/message' && isWatchdogMessage(event.data, message)) return false
    if (event.type === 'agent/inbox/spliced' && event.data.inserted.some(inserted => isWatchdogMessage(inserted, message))) return false
  }
  return true
}
