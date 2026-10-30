/**
 * The idle rollover watchdog's fire decision. The decision is a pure function
 * over values the caller measured, so every gate is testable without a timer, a
 * registry, or a sent message.
 *
 * @module dsh-context-rollover/idle
 */

/** Why the watchdog skipped a candidate: the first gate, in evaluation order, that failed. */
export type IdleSkipReason =
  | 'disabled'
  | 'not-idle'
  | 'queued-work'
  | 'idle-too-short'
  | 'tokens-not-above-floor'
  | 'above-rollover-point'
  | 'backend-not-rollover'
  | 'no-new-context-tool'
  | 'skill-unavailable'
  | 'rollover-pending'
  | 'already-fired-this-epoch'

/** The values the caller measured for one candidate session. */
export interface IdleFireInputs {
  /** Whether the idle watchdog is configured on. */
  readonly enabled: boolean
  /** Whether the session's agent is idle or running. */
  readonly status: 'idle' | 'running'
  /** Whether either of the agent's inbox queues holds work. */
  readonly queuedWork: boolean
  /** Milliseconds since the session log's newest event. */
  readonly idleMs: number
  /** Whether a token measurement baseline exists for the session. */
  readonly baselineKnown: boolean
  /** The measured total tokens of the session's context. */
  readonly totalTokens: number
  /** The session's own rollover point in tokens, for its routed model. */
  readonly rolloverPointTokens: number
  /** Whether a compaction backend that is not this plugin's engine owns the session. */
  readonly foreignBackendOwnsCompaction: boolean
  /** Whether the `new_context` tool is available to the session's agent. */
  readonly newContextAvailable: boolean
  /** Whether the watchdog message's skill gesture names a registered skill. */
  readonly skillAvailable: boolean
  /** Whether the serving engine holds an accepted model-requested rollover for the session that is not yet committed. */
  readonly rolloverPending: boolean
  /** Whether the session is armed: no watchdog message since its newest committed rollover. */
  readonly epochArmed: boolean
}

/** The watchdog's decision for one candidate: fire, or skip with the first failing reason. */
export type IdleFireDecision = { readonly fire: true } | { readonly fire: false; readonly reason: IdleSkipReason }

/**
 * The skill gesture grammar the harness scans for in direct user messages,
 * global so that every gesture in a message is collected. {@link slashGestureNames}
 * reads it through `matchAll`, which works on a copy, so the shared expression
 * keeps no match position between calls.
 */
const SLASH_GESTURE_NAMES = /(?:^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g

/**
 * The skill names a message's gestures name, in the harness's grammar. The
 * watchdog's own gesture check and {@link hasSlashGesture} both read this one
 * grammar, so they cannot disagree.
 * @param text - the configured watchdog message.
 * @returns each `/name` gesture's name, in message order.
 */
export function slashGestureNames(text: string): string[] {
  return [...text.matchAll(SLASH_GESTURE_NAMES)].map(match => match[1] ?? '')
}

/**
 * Whether a message carries a `/name` skill gesture in the harness's grammar. A
 * message without one names no skill, so the harness injects no skill body for it.
 * @param text - the configured watchdog message.
 * @returns true when the text contains a skill gesture.
 */
export function hasSlashGesture(text: string): boolean {
  return slashGestureNames(text).length > 0
}

/**
 * Decide whether the watchdog fires for one candidate session. The gates run in
 * order and the first failing gate is the reason. The idle threshold is
 * inclusive. The tokens must be strictly above the floor. At or above the
 * session's rollover point the watchdog stands down, because the deployed
 * automatic rollover commits there at a pre-step and would shadow the context
 * before the model writes its handoff.
 * @param config - the two thresholds the watchdog reads.
 * @param inputs - the values the caller measured for the candidate.
 * @returns `{ fire: true }` when every gate passes, otherwise `{ fire: false, reason }`.
 */
export function decideIdleFire(
  config: { idleRolloverAfterMs: number; idleRolloverTokens: number },
  inputs: IdleFireInputs,
): IdleFireDecision {
  if (!inputs.enabled) return { fire: false, reason: 'disabled' }
  if (inputs.status !== 'idle') return { fire: false, reason: 'not-idle' }
  if (inputs.queuedWork) return { fire: false, reason: 'queued-work' }
  if (inputs.idleMs < config.idleRolloverAfterMs) return { fire: false, reason: 'idle-too-short' }
  if (!inputs.baselineKnown || inputs.totalTokens <= config.idleRolloverTokens) {
    return { fire: false, reason: 'tokens-not-above-floor' }
  }
  if (inputs.totalTokens >= inputs.rolloverPointTokens) return { fire: false, reason: 'above-rollover-point' }
  if (inputs.foreignBackendOwnsCompaction) return { fire: false, reason: 'backend-not-rollover' }
  if (!inputs.newContextAvailable) return { fire: false, reason: 'no-new-context-tool' }
  if (!inputs.skillAvailable) return { fire: false, reason: 'skill-unavailable' }
  if (inputs.rolloverPending) return { fire: false, reason: 'rollover-pending' }
  if (!inputs.epochArmed) return { fire: false, reason: 'already-fired-this-epoch' }
  return { fire: true }
}
