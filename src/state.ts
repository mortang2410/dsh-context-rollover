/**
 * Engine-side rollover request state, shared by the `new_context` tool and the
 * lifecycle listeners that consume it.
 *
 * @module dsh-context-rollover/state
 */

/** A pending model-requested rollover awaiting a safe lifecycle point. */
export interface PendingRollover {
  /**
   * The handoff text the next window starts from: the already-read document
   * text when the model named a file, or the model's own short string when it
   * passed one directly. The read happens in the `new_context` tool's own
   * `execute`, because the engine's pre-step listener turns every failure into
   * a warning the model never sees.
   */
  readonly handoff: string | null
  /**
   * The path the text was read from, when the model named a file. Diagnostics
   * only: the engine never re-reads it.
   */
  readonly handoffPath?: string
}
