/**
 * The plugin's model-facing tools: `new_context`, `get_context_remaining`,
 * `notes`, and `history`. The tools only request or report; the rollover
 * boundary itself is crossed by the engine at a safe lifecycle point.
 *
 * @module dsh-context-rollover/tools
 */

import { resolve } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type TokenMeter from '@deepseek-ai/dsh-token-meter'
import { rolloverPointsFor } from './config.ts'
import type { ResolvedRolloverConfig } from './config.ts'
import { readHandoffFileOrThrow } from './handoff.ts'
import { readHistoryItem, searchHistory } from './history.ts'
import { NotesStore } from './notes.ts'
import { sessionEvents } from './compat.ts'
import { countRollovers, preflightRolloverReplacement, replacementSubject, rolloverSummarySeqs, rolloverTooLargeMessage } from './rollover.ts'
import type { PendingRollover } from './state.ts'

/** Runtime collaborators the tool bodies need. */
export interface RolloverToolDependencies {
  readonly config: ResolvedRolloverConfig
  readonly meter: TokenMeter
  /** Pending rollover requests keyed by session id, owned by the engine. */
  readonly pendingRollovers: Map<string, PendingRollover>
  /**
   * Whether another backend owns compaction for an agent's session (a preset
   * session reaching this host-registered tool). The engine wires its own
   * ownership check here so `new_context` stays honest everywhere.
   */
  readonly compactionOwnedElsewhere: (agent: { ctx: Context }) => boolean
}

/** Require the session an execution is running for. */
function requireSession(exec: ToolRunContext): Session {
  const session = exec.agent?.session
  if (session === undefined) {
    throw new Error('this tool requires an owning agent session')
  }
  return session
}

/** Resolve the notes store for one session. */
function notesStoreFor(config: ResolvedRolloverConfig, session: Session): NotesStore {
  return new NotesStore(NotesStore.directoryFor(session.id, config.notesDir))
}

/**
 * The least gap between two accepted `new_context` calls in one session. A
 * call inside the gap is refused, so a repeated call cannot start a second
 * rollover on top of the first.
 */
const NEW_CONTEXT_MIN_GAP_MS = 5 * 60 * 1000

/**
 * The oldest handoff document `new_context` accepts, by modification time. An
 * older file may describe a context that has since moved on, so it is refused.
 */
const HANDOFF_MAX_AGE_MS = 5 * 60 * 1000

/**
 * Epoch milliseconds of each session's last accepted `new_context` call. It is
 * stored on the session object under a global symbol, the same channel the
 * pressure-reminder claims use, so every engine row that shares the session
 * reads one record. A host restart clears it, so the record is rebuilt from the
 * session's durable log when it is missing. Refused calls are never recorded.
 */
export const NEW_CONTEXT_CLOCK = Symbol.for('dsh.context-rollover.new-context-clock')

/** Fallback for a session that refuses the symbol property, in this module instance only. */
const newContextFallback = new WeakMap<Session, number>()

/**
 * The newest accepted `new_context` call in one session's durable log, as the
 * logged time of its result. A call counts when its `tool/call` names
 * `new_context` and its `tool/result` is not an error and carries the accepted
 * text. The log outlives a host restart, so the gap rule still holds after one.
 * @param session - the session whose log to read.
 * @returns epoch ms of the accepted result, or undefined when the log has none.
 */
function lastAcceptedInLog(session: Session): number | undefined {
  const newContextCalls = new Set<string>()
  let accepted: number | undefined
  for (const event of sessionEvents(session)) {
    if (event.type === 'tool/call') {
      if (event.data.name === 'new_context') newContextCalls.add(event.data.callId)
    } else if (event.type === 'tool/result') {
      const { message } = event.data
      if (message.isError === true || !newContextCalls.has(message.toolCallId)) continue
      const isAccepted = message.content.some(
        block => block.type === 'text' && block.text === NEW_CONTEXT_ACCEPTED_TEXT,
      )
      if (isAccepted) accepted = event.time
    }
  }
  return accepted
}

/**
 * Epoch ms of the session's last accepted `new_context` call, or undefined when
 * none. The in-memory record is the newest whenever it exists, because this
 * process wrote it at each accepted call. After a restart it is gone, and the
 * durable log answers instead.
 */
function lastAcceptedNewContextAt(session: Session): number | undefined {
  const carrier = session as unknown as Record<symbol, unknown>
  const stored = carrier[NEW_CONTEXT_CLOCK] ?? newContextFallback.get(session)
  if (typeof stored === 'number') return stored
  return lastAcceptedInLog(session)
}

/** Record the session's accepted `new_context` call at `at` (epoch ms). */
function recordAcceptedNewContextAt(session: Session, at: number): void {
  try {
    Object.defineProperty(session, NEW_CONTEXT_CLOCK, {
      value: at,
      enumerable: false,
      configurable: true,
      writable: true,
    })
  } catch {
    // A frozen session cannot take the symbol property: keep the record in this module instance.
    newContextFallback.set(session, at)
  }
}

/**
 * A duration in plain words for a refusal: `42 s`, `7 min 12 s`, or `5 min`.
 * @param ms - the duration in milliseconds.
 * @returns the duration text.
 */
function describeDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  const rest = seconds % 60
  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`
}

/** The availability output of `get_context_remaining`. */
interface ContextRemainingResult {
  tokens_left: number | null
  used_tokens: number | null
  context_window: number | null
  auto_rollover_tokens_left: number | null
}

/**
 * The model-facing text of an accepted `new_context` result. The durable log
 * reader matches it, so the render and the reader share this one value.
 */
export const NEW_CONTEXT_ACCEPTED_TEXT = 'A new context window will start without summarizing conversation history.'

/**
 * A refused `new_context` call. It is a normal result, not a tool error: the
 * host prefixes every thrown error with `Error:`, so a thrown refusal could
 * never open with `Warning:`. The text opens with the warning and gives the reason.
 * @param reason - the reason and the next step, starting with `Reason:`.
 * @returns the output value; its `refusal` text is the model-visible result.
 */
function refusal(reason: string) {
  return {
    accepted: false as const,
    refusal: `Warning: new_context was refused, so this call does not start a new context window. ${reason}`,
  }
}

/** The `new_context` tool: request a context boundary at the next safe point. */
function newContextTool(deps: RolloverToolDependencies) {
  return defineTool({
    name: 'new_context',
    description:
      'Start a new context window at the next safe boundary, continuing from a durable handoff document. '
      + 'Does not clear, reset, or otherwise affect environment state. The handoff document you name becomes '
      + 'the start of the continuation context: earlier conversation leaves the active context, except any '
      + 'recent messages the rollover keeps. Write the document first (for example with '
      + '`/handoff-doc`) and make it fully sufficient for a reader with zero context. Only the document, and '
      + 'any recent messages kept, cross the boundary; full history stays recoverable via the history tool. '
      + 'It is refused if another new_context call was accepted less than five minutes ago, or if the handoff '
      + 'document was last modified more than five minutes ago or has a modification time later than now.',
    parameters: {
      handoff_path: {
        type: 'string',
        required: true,
        description:
          'Path of the durable handoff document the new window continues from: an absolute path, or one '
          + 'relative to the session working directory. Run `/handoff-doc` first and pass the file it wrote '
          + '(in a DSH session the handoff is a notes entry, so pass the absolute path that the notes tool\'s '
          + 'write or list reply gives; outside DSH it saves under `.scratch/handoff/HANDOFF-<topic-or-date>.md`). '
          + 'The file is read at the '
          + 'moment you call this tool, so a missing, unreadable, empty or oversized document is refused here '
          + 'instead of leaving you with a context that silently never rolled over.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accepted: { type: 'boolean', required: true },
          refusal: { type: 'string' },
        },
      },
      render: (_args, rawValue) => {
        const value = rawValue as unknown as { accepted?: boolean, refusal?: string }
        if (value.refusal !== undefined) return [{ type: 'text', text: value.refusal }]
        return [{
          type: 'text',
          text: value.accepted === false
            ? 'No new context window will start: this session compacts through its agent preset, '
            + 'not through context rollover. Open a new session on the standard-rollover preset to roll over; '
            + 'notes and history keep working here.'
            : NEW_CONTEXT_ACCEPTED_TEXT,
        }]
      },
    },
    isConcurrencySafe: () => false,
    async execute(args, exec) {
      const session = requireSession(exec)
      // A preset-owned session reaches this host-registered tool only when
      // the preset does not shadow it. Recording the request would promise a
      // boundary the deferring engine never crosses, so answer honestly.
      if (exec.agent !== undefined && deps.compactionOwnedElsewhere(exec.agent)) {
        return { accepted: false }
      }
      // The gap rule. A second accepted call inside the gap would start a second
      // rollover on top of the first, so it is refused before any file is read.
      const lastAcceptedAt = lastAcceptedNewContextAt(session)
      const now = Date.now()
      if (lastAcceptedAt !== undefined && now - lastAcceptedAt < NEW_CONTEXT_MIN_GAP_MS) {
        return refusal(
          `Reason: a new_context call was accepted ${describeDuration(now - lastAcceptedAt)} ago `
          + `(at ${new Date(lastAcceptedAt).toISOString()}), and a second accepted call is refused within `
          + `${describeDuration(NEW_CONTEXT_MIN_GAP_MS)} of the first. `
          + 'What to do: the first call already requested the new window. Do not call new_context again before '
          + `${new Date(lastAcceptedAt + NEW_CONTEXT_MIN_GAP_MS).toISOString()}.`,
        )
      }
      const handoffPath = args.handoff_path
      if (handoffPath.trim().length === 0) {
        throw new Error(
          'handoff_path is required: pass the path of the durable handoff document this window continues '
          + 'from (run `/handoff-doc` first if it does not exist yet).',
        )
      }
      // Read here, inside this tool's own `execute`. The engine crosses the
      // boundary later, in an `agent/pre-step` listener that converts every
      // failure into `ctx.logger.warn(... "continuing the turn")` — a warning
      // the model never sees. Deferring the read to that point would let the
      // model believe the rollover happened while its context stayed put.
      // Thrown from here, the refusal becomes the tool result the model reads.
      const document = await readHandoffFileOrThrow({
        path: handoffPath,
        cwd: session.header.cwd,
        maxChars: deps.config.handoffMaxChars,
      })
      // The freshness rule. A handoff saved long ago may describe a context that
      // has since moved on, so only a recently saved document is accepted.
      const handoffAge = Date.now() - document.mtimeMs
      // A modification time later than now has a negative age, which the age
      // test below would pass. It is refused on its own, so a stale document
      // cannot pass by carrying a future timestamp.
      if (handoffAge < 0) {
        return refusal(
          `Reason: the handoff document ${document.path} has a modification time later than the current time, `
          + 'so its age cannot be checked. What to do: save the handoff document again so its modification time '
          + 'is current, then call new_context again.',
        )
      }
      if (handoffAge > HANDOFF_MAX_AGE_MS) {
        return refusal(
          `Reason: the handoff document ${document.path} was last modified ${describeDuration(handoffAge)} ago, `
          + 'and new_context accepts only a handoff document modified within the last '
          + `${describeDuration(HANDOFF_MAX_AGE_MS)}. `
          + 'What to do: save the handoff document again so its modification time is current, then call new_context again.',
        )
      }
      // Size the candidate here too, for the same reason the read is here. The
      // engine crosses the boundary later and its shrink guard runs inside a
      // pre-step listener that turns every failure into `ctx.logger.warn(...)`,
      // which the model never reads. Answering `accepted: true` for a document
      // that guard will refuse would tell the model the rollover happened while
      // its context stayed exactly as it was. Thrown from `execute`, the
      // refusal becomes the model-visible `tool/result` with `isError: true`.
      // The engine's own guard stays as the authority for the commit.
      const preflight = preflightRolloverReplacement(
        { meter: deps.meter },
        session,
        deps.config,
        {
          kind: 'handoff-document',
          windowNumber: countRollovers(session) + 1,
          text: document.text,
          path: document.path,
        },
      )
      if (preflight.kind === 'no-span') {
        throw new Error(
          'there is nothing to roll over yet: the active context has no replaceable span '
          + 'beyond its standing instructions, so a new window would not free any space',
        )
      }
      if (!preflight.sizing.fits) {
        throw new Error(rolloverTooLargeMessage(
          replacementSubject({ kind: 'handoff-document', path: document.path }),
          preflight.sizing,
        )
          + '; shorten the handoff document and call new_context again')
      }
      deps.pendingRollovers.set(session.id, {
        handoff: document.text,
        handoffPath: document.path,
      })
      recordAcceptedNewContextAt(session, Date.now())
      return { accepted: true }
    },
  })
}

/** The `get_context_remaining` tool: report honest context headroom. */
function getContextRemainingTool(deps: RolloverToolDependencies) {
  return defineTool({
    name: 'get_context_remaining',
    description:
      'Get the remaining tokens in the current context window, and the headroom before the rollover point. '
      + 'Takes no arguments; call it to read the measured numbers. The current context state '
      + 'is not derivable from repository files or from the plugin source.',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render: (_args, rawValue) => {
        const value = rawValue as unknown as ContextRemainingResult
        const lines: string[] = []
        if (value.tokens_left === null || value.used_tokens === null) {
          lines.push('Context usage is not measured yet; no honest reading is available.')
        } else {
          lines.push(`Context used: ~${value.used_tokens} tokens.`)
          lines.push(`Remaining before the hard context window: ~${value.tokens_left} tokens.`)
          if (value.context_window !== null && value.used_tokens > 0) {
            const percent = Math.min(100, Math.round((value.used_tokens / value.context_window) * 100))
            lines.push(`Context window: ~${value.context_window} tokens (${percent}% used).`)
          }
          if (value.auto_rollover_tokens_left !== null) {
            // The sentence follows the resolved config: with the automatic
            // rollover on, the engine crosses at that point by itself, so
            // "crossing it only warns" would be false. With it off the hard
            // reminder repeats the order every turn from that point, so the
            // crossing is not a bare warning there either.
            const crossing = deps.config.automaticRollover
              ? 'crossing it makes the engine roll over at the next step; your new_context call rolls over sooner'
              : 'crossing it repeats the rollover order every turn; your new_context call rolls over'
            lines.push(
              `Remaining before the rollover point: ~${value.auto_rollover_tokens_left} tokens `
              + `(${crossing}).`,
            )
          }
        }
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute(_args, exec) {
      const session = requireSession(exec)
      const route = session.requestContext()
      const contextWindow = route?.contextWindow ?? null
      const thresholdTokens = contextWindow === null || route === undefined
        ? null
        : rolloverPointsFor(deps.config, contextWindow, route.model).rolloverTokens
      const measurement = deps.meter.measure(session)
      const hasReading = measurement.baseline.kind !== 'none'
      const usedTokens = hasReading ? measurement.totalTokens : null
      const tokensLeft = contextWindow === null || usedTokens === null
        ? null
        : Math.max(0, contextWindow - usedTokens)
      const autoRolloverLeft = thresholdTokens === null || usedTokens === null
        ? null
        : Math.max(0, thresholdTokens - usedTokens)
      return {
        tokens_left: tokensLeft,
        used_tokens: usedTokens,
        context_window: contextWindow,
        auto_rollover_tokens_left: autoRolloverLeft,
      }
    },
  })
}

/** The `notes` tool: read and maintain durable model-managed notes. */
function notesTool(deps: RolloverToolDependencies) {
  const noteActions = 'list | read | write | append | search'
  return defineTool({
    name: 'notes',
    description:
      'Read and maintain durable notes that survive context rollovers. Notes are your own working memory: '
      + `goal, verified progress, decisions, constraints, files involved, known failures, explicit hypotheses, next steps. Actions: ${noteActions}. `
      + 'Notes are never written automatically — persist what the next context actually needs before a rollover.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: `One of: ${noteActions}.`,
      },
      path: {
        type: 'string',
        description: 'Note file path (read/write/append), e.g. "state.md" or "plans/rollout.md".',
      },
      text: {
        type: 'string',
        description: 'Text to write (write) or append (append).',
      },
      query: {
        type: 'string',
        description: 'Literal case-insensitive substring to find (search).',
      },
      max_matches: {
        type: 'number',
        description: 'Maximum matches returned by search (default 20).',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, rawValue) => {
        const value = rawValue as unknown as { action: string; text: string }
        return [{ type: 'text', text: value.text }]
      },
    },
    isConcurrencySafe: args => args.action === 'list' || args.action === 'read' || args.action === 'search',
    async execute(args, exec) {
      const session = requireSession(exec)
      const store = notesStoreFor(deps.config, session)
      switch (args.action) {
        case 'list': {
          const listings = await store.list()
          if (listings.length === 0) return { action: 'list', text: 'No notes stored yet.' }
          return {
            action: 'list',
            text: listings
              .map(listing => `${listing.path} (${listing.size} bytes) at ${resolve(store.root, listing.path)}`)
              .join('\n'),
          }
        }
        case 'read': {
          if (args.path === undefined) throw new Error('read requires "path"')
          return { action: 'read', text: await store.read(args.path) }
        }
        case 'write': {
          if (args.path === undefined || args.text === undefined) {
            throw new Error('write requires "path" and "text"')
          }
          await store.write(args.path, args.text)
          const absolute = resolve(store.root, args.path)
          return { action: 'write', text: `Wrote ${args.path} (${args.text.length} characters) at ${absolute}.` }
        }
        case 'append': {
          if (args.path === undefined || args.text === undefined) {
            throw new Error('append requires "path" and "text"')
          }
          await store.append(args.path, args.text)
          const absolute = resolve(store.root, args.path)
          return { action: 'append', text: `Appended to ${args.path} at ${absolute}.` }
        }
        case 'search': {
          if (args.query === undefined) throw new Error('search requires "query"')
          const matches = await store.search(args.query, args.max_matches ?? 20)
          if (matches.length === 0) return { action: 'search', text: 'No matches.' }
          return {
            action: 'search',
            text: matches
              .map(match => `${match.path}:${match.line}: ${match.text}`)
              .join('\n'),
          }
        }
        default:
          throw new Error(`unknown notes action "${String(args.action)}"; expected one of: ${noteActions}`)
      }
    },
  })
}

/** The `history` tool: targeted recovery of conversation that left the active surface. */
function historyTool() {
  return defineTool({
    name: 'history',
    description:
      'Search and read older conversation that has left the active context (for example after a context '
      + 'rollover). Use it for a specific missing detail, never to reconstruct the previous context. '
      + 'Actions: search | read.',
    parameters: {
      action: {
        type: 'string',
        required: true,
        description: 'One of: search | read.',
      },
      query: {
        type: 'string',
        description: 'Literal case-insensitive substring to find (search).',
      },
      seq: {
        type: 'number',
        description: 'The event seq of the item to read, as returned by search (read).',
      },
      max_matches: {
        type: 'number',
        description: 'Maximum matches returned by search (default 10).',
      },
      max_chars: {
        type: 'number',
        description: 'Maximum characters returned by read (default 4000).',
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, rawValue) => {
        const value = rawValue as unknown as { action: string; text: string }
        return [{ type: 'text', text: value.text }]
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, exec) {
      const session = requireSession(exec)
      const windowCount = countRollovers(session)
      const rolloverSeqs = rolloverSummarySeqs(session)
      switch (args.action) {
        case 'search': {
          if (args.query === undefined) throw new Error('search requires "query"')
          const matches = searchHistory(
            session,
            windowCount,
            rolloverSeqs,
            args.query,
            args.max_matches ?? 10,
          )
          if (matches.length === 0) return { action: 'search', text: 'No matches in history.' }
          return {
            action: 'search',
            text: matches
              .map(match => `[seq ${match.seq}] (window ${match.window}, ${match.kind}) ${match.snippet}`)
              .join('\n---\n'),
          }
        }
        case 'read': {
          if (args.seq === undefined) throw new Error('read requires "seq"')
          const item = readHistoryItem(
            session,
            args.seq,
            windowCount,
            rolloverSeqs,
            args.max_chars ?? 4000,
          )
          if (item === null) {
            throw new Error(`no history item at seq ${args.seq} (it may still be on the active surface)`)
          }
          return { action: 'read', text: `[seq ${item.seq}] (window ${item.window}, ${item.kind})\n${item.text}` }
        }
        default:
          throw new Error(`unknown history action "${String(args.action)}"; expected search or read`)
      }
    },
  })
}

/**
 * Build the plugin's tools for one engine instance.
 * @param deps - runtime collaborators shared with the engine.
 * @param notesEnabled - whether the `notes` tool is mounted.
 * @param historyEnabled - whether the `history` tool is mounted.
 * @returns the tool definitions to register.
 */
export function createRolloverTools(
  deps: RolloverToolDependencies,
  notesEnabled: boolean,
  historyEnabled: boolean,
): ToolDefinition[] {
  const tools = [
    newContextTool(deps),
    getContextRemainingTool(deps),
    ...(notesEnabled ? [notesTool(deps)] : []),
    ...(historyEnabled ? [historyTool()] : []),
  ]
  return tools
}
