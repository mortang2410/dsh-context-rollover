/**
 * The compiled forced replacement (contracts C3 and C4).
 *
 * When the session crosses the rollover point with no handoff document, the
 * engine compiles the span it is about to replace instead of carrying the
 * notes alone. This module owns that composition: project the shadowed
 * positions through the session's own derived messages, compile them under a
 * cap derived from the span, and frame the recall guide first, the durable
 * notes header after it when notes exist, then the entries.
 *
 * Whether the sized text actually fits the span is the engine's meter
 * preflight (ticket `4fne`), and the commit is `commitRollover`; this module
 * neither prices nor commits. It reports `{ defer: true }` when the projection
 * throws or the compile yields no entries, so the caller commits nothing and
 * retries at the next pre-step.
 *
 * @module dsh-context-rollover/compiled-fallback
 */

import type { Session } from '@deepseek-ai/dsh-session'
import type { RolloverConfig } from './config.ts'
import type { RolloverReplacement } from './checkpoint.ts'
import { checkpointCapFor } from './vcc/cap.ts'
import { compileRegion, frameCheckpoint, type CompileNode } from './vcc/compiler.ts'
import { projectShadowedNodes } from './vcc/project.ts'

/**
 * VCC's published compiler defaults. `resolveConfig` fills the same numbers
 * into a resolved configuration, so these only cover a raw configuration that
 * skipped resolution (the unit fixtures here); the config test pins the two
 * sets together.
 */
const DEFAULT_CHECKPOINT_CAP = 65536
const DEFAULT_ASSISTANT_TEXT_TOKENS = 1500
const DEFAULT_USER_TEXT_TOKENS = 2000
const DEFAULT_TOOL_CALL_TOKENS = 200

/** Inputs for one compiled forced replacement. */
export interface CompiledReplacementInput {
  readonly session: Session
  /** The log positions of the span the rollover replaces. */
  readonly shadowedSeqs: readonly number[]
  /** The span's heuristic token count; it only bounds the compiler's budget. */
  readonly shadowedTokens: number
  /** 1-based number of the window the rollover starts. */
  readonly windowNumber: number
  /** Rendered durable notes snapshot, or `null` when there are none. */
  readonly notes: string | null
}

/**
 * The durable-notes header of a compiled replacement. It sits after the recall
 * guide so the recovery instructions read first.
 */
const NOTES_HEADER = '## Durable notes'

/**
 * The notes block placed after the recall guide in a compiled replacement.
 * @param notes - the rendered notes snapshot.
 * @returns the header and the notes text.
 */
function notesBlock(notes: string): string {
  return `${NOTES_HEADER}\n\n${notes}`
}

/**
 * Compose the compiled replacement for one forced rollover.
 * @param input - the session, the replaced span, its token count, the window number and the notes.
 * @param config - the resolved configuration supplying the cap and block budgets.
 * @returns a `compiled` replacement, or `{ defer: true }` when none can be built.
 */
export function buildCompiledReplacement(
  input: CompiledReplacementInput,
  config: RolloverConfig,
): RolloverReplacement | { defer: true } {
  const cap = checkpointCapFor(input.shadowedTokens, config.checkpointCap ?? DEFAULT_CHECKPOINT_CAP)
  if (cap === null) return { defer: true }
  let nodes: CompileNode[]
  try {
    nodes = projectShadowedNodes(input.session, input.shadowedSeqs)
  } catch {
    // The spec names the projection error as a deferral, not a failed rollover:
    // whether the span is wrong or the log moved, nothing is committed.
    return { defer: true }
  }
  const compiled = compileRegion(nodes, {
    maxTokens: cap,
    textTokens: config.assistantTextTokens ?? DEFAULT_ASSISTANT_TEXT_TOKENS,
    userTextTokens: config.userTextTokens ?? DEFAULT_USER_TEXT_TOKENS,
    toolCallTokens: config.toolCallTokens ?? DEFAULT_TOOL_CALL_TOKENS,
    toolResultExcerptTokens: config.toolCallTokens ?? DEFAULT_TOOL_CALL_TOKENS,
    // The compiler treats an unset list as VCC's default and an unset flag as
    // false, so undefined is passed through rather than replaced here.
    ...(config.includeReasoning === undefined ? {} : { includeReasoning: config.includeReasoning }),
    ...(config.toolArgTools === undefined ? {} : { toolArgTools: config.toolArgTools }),
    ...(config.hideTools === undefined ? {} : { hideTools: config.hideTools }),
  })
  if (compiled.entries.length === 0) return { defer: true }
  const body = input.notes === null ? compiled.entries : [notesBlock(input.notes), ...compiled.entries]
  // frameCheckpoint puts the recall guide ahead of every body line, so the
  // guide is first, the notes header next, and the entries last.
  const text = frameCheckpoint(body).map(block => block.text).join('\n\n')
  return { kind: 'compiled', windowNumber: input.windowNumber, text }
}
