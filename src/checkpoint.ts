/**
 * Deterministic rollover checkpoint content. The normal path never calls an
 * LLM to summarize: the checkpoint is composed from durable notes plus the
 * model's own handoff when provided, and the recent raw tail stays on the
 * surface outside the checkpoint.
 *
 * @module dsh-context-rollover/checkpoint
 */

/** Why a context window rolled over. */
export type RolloverReason = 'model-requested' | 'pressure' | 'overflow' | 'manual'

/** Inputs for one deterministic checkpoint. */
export interface CheckpointInput {
  readonly reason: RolloverReason
  /** 1-based number of the window the rollover starts. */
  readonly windowNumber: number
  /** Rendered durable notes snapshot, or `null` when notes are disabled or empty. */
  readonly notes: string | null
  /** The model's own handoff text, or `null` when absent. */
  readonly handoff: string | null
}

/** Wrap checkpoint text in the rollover markers. */
function checkpointText(text: string): string {
  return [
    '<context-rollover checkpoint>',
    text,
    '</context-rollover checkpoint>',
  ].join('\n')
}

/**
 * What one rollover writes in place of the replaced span.
 *
 * Two compositions exist because there are two continuation contracts, and
 * they are not interchangeable. The notes checkpoint surrounds the state it
 * carries with engine-authored narration and section headings. A handoff
 * document is a complete continuation contract written for a cold reader, so
 * its bytes must reach the fresh context unchanged, with nothing prepended,
 * appended or wrapped.
 */
export type RolloverReplacement =
  | {
      /** Deterministic checkpoint: narration, durable notes, optional short handoff. */
      readonly kind: 'checkpoint'
      readonly checkpoint: CheckpointInput
    }
  | {
      /** The handoff document itself, byte for byte, as the whole replacement. */
      readonly kind: 'handoff-document'
      /** 1-based number of the window the rollover starts (summary metadata). */
      readonly windowNumber: number
      /** The document text exactly as it was read from disk. */
      readonly text: string
      /** Path the text was read from; named by a refusal or a diagnostic. */
      readonly path?: string
    }

/**
 * The window number a rollover starts, whichever composition it uses.
 * @param replacement - the replacement the caller selected.
 * @returns the 1-based window number.
 */
export function replacementWindowNumber(replacement: RolloverReplacement): number {
  return replacement.kind === 'checkpoint'
    ? replacement.checkpoint.windowNumber
    : replacement.windowNumber
}

/**
 * Compose the replacement content for one rollover.
 * @param replacement - the composition the caller selected for this rollover.
 * @returns the exact text of the replacement user message.
 */
export function buildReplacementText(replacement: RolloverReplacement): string {
  return replacement.kind === 'checkpoint'
    ? buildCheckpointText(replacement.checkpoint)
    : replacement.text
}

/**
 * Compose the replacement checkpoint blocks. Content is deterministic for a
 * given input, so the shrink guard's pricing is reproducible.
 *
 * This is the notes composition the engine-driven paths (provider-confirmed
 * overflow and manual `/compact`) use. It is NOT the handoff composition: see
 * {@link buildReplacementText}.
 * @param input - the rollover's reason, window number, and retained state.
 * @returns the checkpoint content for the replacement user message.
 */
export function buildCheckpointText(input: CheckpointInput): string {
  const lines: string[] = [
    `Context window rollover: earlier conversation left your active context `
    + `(window ${input.windowNumber} started; reason: ${input.reason}). `
    + `The full conversation remains persisted and recoverable with the history tool — `
    + `search for a specific missing detail and read only that; do not reconstruct whole windows.`,
  ]
  lines.push('', '## Durable notes')
  lines.push(input.notes ?? 'No notes were saved for this rollover.')
  if (input.handoff !== null) {
    lines.push('', '## Handoff', input.handoff)
  }
  return checkpointText(lines.join('\n'))
}
