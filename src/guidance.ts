/**
 * Stable context-management guidance for the model. Kept deliberately small:
 * the same text ships with every request until a rollover replaces it.
 *
 * @module dsh-context-rollover/guidance
 */

/**
 * Build the system-prompt section text for the context-management plugin.
 *
 * The last bullet is composed per engine, because this text ships with every
 * request: promising an automatic rollover on a deployment where
 * `automaticRollover` is off would be false, and the model acts on what it
 * reads. The reminder bullet states no cadence: the repeat interval is the
 * `reminderRepeatMs` configuration key, so a fixed number here would go stale
 * the moment a deployment sets it.
 * @param options - the resolved configuration this text describes.
 * @returns the section text.
 */
export function contextManagementGuidance(options: { automaticRollover?: boolean } = {}): string {
  const rolloverRule = options.automaticRollover === true
    ? '- A reminder appears while the context is filling and usage stays at or above\n'
      + '  the reminder point. At or above the rollover point the engine also rolls the\n'
      + '  context over by itself: it commits a notes checkpoint plus a recent tail of\n'
      + '  the conversation, with no summarizer call. That is a safety net, not a\n'
      + '  substitute for your own handoff. Write the document and call\n'
      + '  `new_context` as above anyway: your document is what the fresh context\n'
      + '  continues from, and the engine\'s checkpoint only carries the notes and the\n'
      + '  recent tail. At or above the rollover point the order repeats every turn\n'
      + '  until you comply, so do not wait for a second reminder.'
    : '- A reminder appears while the context is filling and usage stays at or above\n'
      + '  the reminder point. At or above the rollover point the order repeats every\n'
      + '  turn until you comply. Only your `new_context` call starts a handoff rollover.'
  return `
# Context management

Your active context is temporary working memory. Older conversation leaves your
active context at a context rollover; it stays recoverable through the history
tool.

- Keep goal, verified progress, important decisions, constraints, files
  involved, known failures, and next steps in notes. Update notes as facts
  change; explicitly mark unverified hypotheses as hypotheses.
- When a reminder tells you the context is filling, run \`/handoff-doc\` to write
  or update the durable handoff document, and make that document fully
  sufficient for a fresh context to continue the work. Then call
  \`new_context\` with the path of that document as its \`handoff_path\` argument.
  If you wrote the handoff with the notes tool, pass the absolute path its write
  reply gave, or the one \`notes list\` shows for it.
- The handoff document is the start of the continuation context: after the
  rollover your active context is the standing instructions, that document, and
  any recent messages the rollover keeps. Older conversation carries over only
  through the document, so anything the next context needs must be in the document.
- After a rollover, continue from the handoff document and live repository
  state. The earlier conversation is never injected automatically; use history
  only to recover one specific missing detail.
- get_context_remaining is a tool you invoke with no arguments; it returns the
  measured numbers. When you need to know how much context is left — or when
  you are asked about it — call it and report the numbers it returned. The
  current context state is not readable from repository files, from the plugin
  source, or from memory: only that tool reports it, and claiming a reading you
  did not receive is a fabrication even when the guess sounds plausible.
${rolloverRule}
`.trim()
}

/**
 * The shipped guidance text, with the automatic rollover off: the state every
 * deployment that does not set `automaticRollover` runs in.
 */
export const CONTEXT_MANAGEMENT_GUIDANCE = contextManagementGuidance()
