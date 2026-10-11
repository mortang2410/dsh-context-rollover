/**
 * Stable context-management guidance for the model. Kept deliberately small:
 * the same text ships with every request until a rollover replaces it.
 *
 * @module dsh-context-rollover/guidance
 */

/** System-prompt section text for the context-management plugin. */
export const CONTEXT_MANAGEMENT_GUIDANCE = `
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
- A reminder appears at most once per window when the context fills. Only your
  \`new_context\` call starts a handoff rollover.
`.trim()
