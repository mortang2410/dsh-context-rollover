/**
 * The pressure reminder's wording, keyed by rollover mode. `upstream` keeps the
 * upstream wording. `structured-handoff` asks the model to write its handoff as
 * one dated note and states the window number, the handoff size limit, and the
 * automatic point.
 *
 * @module dsh-context-rollover/reminder
 */

import { formatCharacterCount } from './character-count.ts'
import type { RolloverMode } from './config.ts'

/** Measured inputs for one pressure reminder. */
export interface ReminderInput {
  readonly mode: RolloverMode
  /** Context used as a whole percentage of the window, capped at 100. */
  readonly percent: number
  /** The current context window's number: 1 before any rollover, one more per rollover. */
  readonly windowNumber: number
  /** Context tokens used by the latest measured request. */
  readonly totalTokens: number
  /** The routed model's context window in tokens. */
  readonly contextWindow: number
  /** Token point at which the automatic rollover starts. */
  readonly rolloverTokens: number
  /** The configured handoff size limit in characters, which the structured-handoff wording states. */
  readonly handoffMaxChars: number
}

/** The upstream reminder wording. */
function upstreamReminderText(input: ReminderInput): string {
  return `Context window: ${input.percent}% used (~${input.totalTokens} of ${input.contextWindow} tokens). `
    + `An automatic rollover starts around ${input.rolloverTokens} tokens. If a task boundary is near, `
    + 'save what matters to notes and call new_context with a short handoff; otherwise checkpoint soon.'
}

/**
 * The approved structured-handoff wording. The text is fixed; only the
 * percentage, the window number, the handoff size limit, and the automatic
 * point are substituted. The angle-bracket task description and the
 * HANDOFF-YYYY-MM-DD-HH-MM pattern are literal text for the model to fill in,
 * not placeholders.
 */
function structuredHandoffReminderText(input: ReminderInput): string {
  return `Context is ${input.percent}% full, in window ${input.windowNumber}. `
    + 'Write your handoff as a new note with the notes tool, at HANDOFF-YYYY-MM-DD-HH-MM-<task-description>.md, '
    + `using the current date and time to the minute. Follow the /handoff-doc sections, keep the note under ${formatCharacterCount(input.handoffMaxChars)} characters, `
    + `and state window ${input.windowNumber} at its top. `
    + 'To register it, call the notes tool with action "write", path "HANDOFF-YYYY-MM-DD-HH-MM-<task-description>.md", '
    + 'and text set to the complete handoff. Write replaces any file with the same name, so use a new name each window. '
    + 'Example: action "write", path "HANDOFF-2026-10-10-14-30-parser-fix.md", text "Window 2. Goal: fix the parser null check. Next: add the regression test." '
    + 'Then call new_context. '
    + `An automatic rollover starts around ${input.rolloverTokens} tokens.`
}

/** Reminder wording keyed by rollover mode. */
const REMINDER_BY_MODE: Readonly<Record<RolloverMode, (input: ReminderInput) => string>> = {
  upstream: upstreamReminderText,
  'structured-handoff': structuredHandoffReminderText,
}

/**
 * Build the pressure reminder's text for one mode.
 * @param input - the measured reminder inputs, including the resolved mode.
 * @returns the reminder text the model receives.
 */
export function buildReminderText(input: ReminderInput): string {
  return REMINDER_BY_MODE[input.mode](input)
}
