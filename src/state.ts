/**
 * Engine-side rollover request state, shared by the `new_context` tool and the
 * lifecycle listeners that consume it.
 *
 * @module dsh-context-rollover/state
 */

/** A pending model-requested rollover awaiting a safe lifecycle point. */
export interface PendingRollover {
  /**
   * The already-read handoff document text the next window starts from.
   *
   * The read happens in the `new_context` tool's own `execute`, because the
   * engine's pre-step listener turns every failure into a warning the model
   * never sees. The engine never re-reads or re-resolves the path: the model
   * named one file, and that exact file's bytes are what crosses the boundary.
   */
  readonly handoff: string
  /**
   * The absolute path the text was read from. Diagnostics only: the engine
   * never re-reads it.
   */
  readonly handoffPath: string
}
