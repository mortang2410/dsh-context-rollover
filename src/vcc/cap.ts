/**
 * The compiler cap one forced rollover runs under (contract C3).
 *
 * The shrink guard prices the framed replacement against the span it replaces,
 * so the compiler can never be allowed to build a body larger than that span.
 * Half the shadowed span leaves the other half for the recall guide, the notes
 * header and the checkpoint frame, and the configured cap keeps a user's own
 * ceiling in charge when the span is large.
 *
 * @module dsh-context-rollover/vcc/cap
 */

/** Tokens below which no compiled copy can fit inside half a span. */
const COMPILED_FRAME_FLOOR = 2

/**
 * The compiler cap for one span: never above the configured checkpoint cap and
 * never above half the span's tokens.
 * @param shadowedTokens - the shadowed span's heuristic token count.
 * @param checkpointCap - the configured ceiling, in compiler tokens.
 * @returns the cap in tokens, or null when half the span cannot hold the frame.
 */
export function checkpointCapFor(shadowedTokens: number, checkpointCap: number): number | null {
  const half = Math.floor(shadowedTokens / 2)
  const cap = Math.min(checkpointCap, half)
  // The cap bounds the compiled body only; the guide, notes header and frame
  // ride outside it. Below the frame's own size no compiled copy can be half
  // the span, so the caller defers instead of committing one that cannot shrink.
  if (cap < COMPILED_FRAME_FLOOR) return null
  return cap
}
