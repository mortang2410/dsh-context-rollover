/**
 * Projection of the shadowed surface positions into the vendored compiler's
 * node shape (contract C2).
 *
 * The compiler is only useful if it sees exactly what the model saw, so this
 * module asks the session for the derived message of each selected log
 * position instead of rebuilding a message from event payloads. A selected
 * position with no logged event is a broken precondition, not a case to paper
 * over: a partial node array would compile a copy that silently drops part of
 * the conversation it claims to carry.
 *
 * @module dsh-context-rollover/vcc/project
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { sessionEventAt } from '../compat.ts'
import type { CompileMessage, CompileNode } from './compiler.ts'

/** A selected sequence has no session event, so no node can be projected for it. */
export class ProjectionError extends Error {
  /** The log position that carried no session event. */
  readonly seq: number

  /**
   * @param seq - the selected log position with no session event.
   */
  constructor(seq: number) {
    super(`vcc projection: selected seq ${seq} has no session event; the compiled region would be partial`)
    this.name = 'ProjectionError'
    this.seq = seq
  }
}

/** The core fields the projection hands the compiler for every role. */
interface ProjectedCore extends Pick<CompileMessage, 'role' | 'content' | 'source'> {
  readonly id: unknown
}

/**
 * Copy the fields every message carries, so the projection keeps the derived
 * identity, content and source and adds only the role the compiler reads.
 * @param message - the derived message.
 * @returns the shared core fields.
 */
function pickCore(message: Message): ProjectedCore {
  return {
    role: message.role,
    id: message.id,
    content: message.content,
    source: message.source,
  } as ProjectedCore
}

/**
 * The derived message as the compiler reads it. The host's message types carry
 * roles the compiler does not name (a developer message), so the projection
 * keeps every derived field and names the role the compiler renders; a tool
 * result keeps role `tool` and carries its tool-call id.
 * @param message - the message `Session.deriveEventMessage` returned.
 * @returns the compiler's message shape, or null when the event derived nothing.
 */
function projectMessage(message: ReturnType<Session['deriveEventMessage']>): CompileMessage | null {
  if (message === null) return null
  const core = pickCore(message)
  switch (message.role) {
    case 'system':
      return { ...core, role: 'system' }
    case 'user':
      return { ...core, role: 'user' }
    case 'assistant':
      return { ...core, role: 'assistant' }
    case 'tool':
      return { ...core, role: 'tool', toolCallId: message.toolCallId }
    default:
      // A developer message (tool additions and removals) is injected context
      // the model saw in a non-conversation role; the compiler renders it as a
      // system-role row so it is neither dropped nor mistaken for a user turn.
      return { ...core, role: 'system' }
  }
}

/**
 * Project the selected surface positions into compiler nodes.
 * @param session - the session whose log and derivation supply the messages.
 * @param shadowedSeqs - the selected log positions, in any order.
 * @returns one node per selected position, ascending, each carrying the derived message or null.
 * @throws ProjectionError when a selected position has no session event.
 */
export function projectShadowedNodes(session: Session, shadowedSeqs: readonly number[]): CompileNode[] {
  const seqs = [...shadowedSeqs].sort((left, right) => left - right)
  const nodes: CompileNode[] = []
  for (const seq of seqs) {
    const event = sessionEventAt(session, seq)
    if (event === undefined) throw new ProjectionError(seq)
    nodes.push({ seq, message: projectMessage(session.deriveEventMessage(event)) })
  }
  return nodes
}
