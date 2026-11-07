/**
 * The resume composition of the idle reopen. A candidate with no live agent is
 * resumed the way the host session controller resumes one: the stored preset is
 * read from the session's projection, resolved through the preset registry, and
 * mounted in the resume setup, and the default model's `provider` and `model`
 * travel in the resume options. The composition refuses to guess: an
 * unresolvable preset, a missing session query service, or a missing default
 * model means no resume rather than a substitute.
 *
 * @module dsh-context-rollover/resume
 */

import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** The projection the stored preset identifier is read from. */
interface SessionObservation {
  /** The stored header, whose subagent fields keep a worker session out of the reopen. */
  readonly header: { readonly origin?: unknown; readonly delegationDepth?: number }
  /** Projection values at the observation cut; absent when the projection registry did not run. */
  readonly projections?: { readonly values: { readonly agentPreset?: unknown } }
  /** Releases the observation lease; the session query service owns the resource. */
  readonly [Symbol.dispose]?: () => void
}

/** The part of the session query service the reopen reads. */
interface SessionQueryLookup {
  observeSession(sessionId: SessionId): Promise<SessionObservation>
}

/** The part of the preset registry the reopen reads. */
interface PresetRegistry {
  resolve(presetId: string | undefined): Promise<{ readonly id: string }>
  mount(ctx: Context, presetId: string): Promise<void>
}

/** The part of the default-model service the reopen reads. */
interface DefaultModelLookup {
  currentSelection(): { readonly provider?: string; readonly model?: string }
}

/** Where a reopen composition fails, for one warning line per session. */
export interface ResumeComposition {
  /** The options the resume carries: the default model's provider and model. */
  readonly agentOptions: AgentOptions
  /** The setup callback that mounts the resolved preset, when one resolves. */
  readonly setup?: (agentCtx: Context, agent: unknown) => Promise<void>
  /** The preset that was resolved, for the record and the log. */
  readonly presetId?: string
  /** A line to warn about when the session is resumed without its preset. */
  readonly warning?: string
}

/**
 * Whether an error is the host's not-found signal for a stored session. The
 * predicate reads both shapes: the session query service's own error carries
 * `code: 'SESSION_QUERY_SESSION_NOT_FOUND'`, and the controller rethrows it as
 * an error named `ApiSessionNotFound`. The two are matched by shape because the
 * plugin does not import the controller package.
 * @param error - the rejection to classify.
 * @returns true when the session does not exist.
 */
export function isSessionNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as { readonly name?: unknown; readonly code?: unknown }
  return candidate.name === 'ApiSessionNotFound' || candidate.code === 'SESSION_QUERY_SESSION_NOT_FOUND'
}

/**
 * Compose the resume of one stored session. It reads the stored preset id from
 * the session query service, resolves it through the preset registry, and
 * carries the default model's provider and model in the resume options. It
 * returns undefined, with a warning, when the turn cannot be composed: no
 * session query service, no default model selection, a preset that does not
 * resolve, or a stored header that marks a subagent session, which has no person
 * behind it to answer the message.
 * @param ctx - the plugin's host context.
 * @param sessionId - the stored session to resume.
 * @param warn - the warning sink, called once for a missing service.
 * @returns the composition, or undefined when the resume must be skipped.
 */
export async function composeResume(
  ctx: Context,
  sessionId: SessionId,
  warn: (line: string) => void,
): Promise<ResumeComposition | undefined> {
  const sessionQuery = ctx.get('sessionQuery') as unknown as SessionQueryLookup | undefined
  if (sessionQuery === undefined) {
    warn(`context rollover (idle watchdog): no session query service is mounted, so session ${sessionId} is not reopened`)
    return undefined
  }
  const defaultModel = ctx.get('agentDefaultModel') as unknown as DefaultModelLookup | undefined
  const selection = defaultModel?.currentSelection()
  if (selection?.provider === undefined || selection.model === undefined) {
    warn(`context rollover (idle watchdog): no default model selection is available, so session ${sessionId} is not reopened`)
    return undefined
  }
  const agentOptions: AgentOptions = { provider: selection.provider, model: selection.model }

  const observation = await sessionQuery.observeSession(sessionId)
  let stored: unknown
  let subagent = false
  try {
    subagent = observation.header.origin === 'subagent' || (observation.header.delegationDepth ?? 0) > 0
    stored = observation.projections?.values.agentPreset
  } finally {
    observation[Symbol.dispose]?.()
  }
  if (subagent) {
    warn(`context rollover (idle watchdog): session ${sessionId} is a subagent session, so it is not reopened`)
    return undefined
  }
  const presetId = typeof stored === 'string' ? stored : undefined
  const registry = ctx.get('agentPresets') as unknown as PresetRegistry | undefined
  if (registry === undefined) {
    warn(`context rollover (idle watchdog): no preset registry is mounted, so session ${sessionId} is resumed without its preset`)
    return { agentOptions }
  }
  let resolvedId: string
  try {
    resolvedId = (await registry.resolve(presetId)).id
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : String(error)
    warn(`context rollover (idle watchdog): the preset "${String(presetId)}" of session ${sessionId} does not resolve: ${reason}`)
    return undefined
  }
  return {
    agentOptions,
    presetId: resolvedId,
    setup: async (agentCtx: Context) => {
      await registry.mount(agentCtx, resolvedId)
    },
  }
}
