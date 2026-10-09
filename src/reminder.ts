/**
 * The pressure reminder's wording, keyed by rollover mode. Both modes emit the
 * upstream wording until the structured-handoff wording lands; the mode already
 * reaches this builder, so that wording becomes a table entry rather than a new
 * call path.
 *
 * @module dsh-context-rollover/reminder
 */

import type { RolloverMode } from './config.ts'

/** Measured inputs for one pressure reminder. */
export interface ReminderInput {
  readonly mode: RolloverMode
  /** Context used as a whole percentage of the window, capped at 100. */
  readonly percent: number
  /** Context tokens used by the latest measured request. */
  readonly totalTokens: number
  /** The routed model's context window in tokens. */
  readonly contextWindow: number
  /** Token point at which the automatic rollover starts. */
  readonly rolloverTokens: number
}

/** The upstream reminder wording. */
function upstreamReminderText(input: ReminderInput): string {
  return `Context window: ${input.percent}% used (~${input.totalTokens} of ${input.contextWindow} tokens). `
    + `An automatic rollover starts around ${input.rolloverTokens} tokens. If a task boundary is near, `
    + 'save what matters to notes and call new_context with a short handoff; otherwise checkpoint soon.'
}

/** Reminder wording keyed by rollover mode. */
const REMINDER_BY_MODE: Readonly<Record<RolloverMode, (input: ReminderInput) => string>> = {
  upstream: upstreamReminderText,
  'structured-handoff': upstreamReminderText,
}

/**
 * Build the pressure reminder's text for one mode.
 * @param input - the measured reminder inputs, including the resolved mode.
 * @returns the reminder text the model receives.
 */
export function buildReminderText(input: ReminderInput): string {
  return REMINDER_BY_MODE[input.mode](input)
}
