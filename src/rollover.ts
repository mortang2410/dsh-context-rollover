/**
 * The rollover surface transaction. A rollover is a genuine DSH compaction:
 * the same `compaction/start` lock, `compaction/summary` record, replacement
 * `user/message` with full source provenance, and `compaction/end` close as
 * `dsh-compaction-basic` — but the replacement is either the durable handoff
 * document's own bytes or a deterministic notes checkpoint, never an LLM call.
 * Raw events stay persisted; under `handoffOnly` no part of the old
 * conversation stays on the surface either.
 *
 * @module dsh-context-rollover/rollover
 */

import { randomUUID } from 'node:crypto'
import {
  CompactionId,
  ManualCompactionError,
  compactCheckpointSource,
  toolPairingBalancedAfter,
  toolPairingBalancedBefore,
} from '@deepseek-ai/dsh-compaction'
import type { CompactionResult } from '@deepseek-ai/dsh-compaction'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ContextFormed } from '@deepseek-ai/dsh-llm'
import type TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { TokenMeasurement } from '@deepseek-ai/dsh-token-meter'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { nodeHeuristicTokens, replaceSurfaceOp, sessionEventAt, sessionEvents } from './compat.ts'
import type { Seq } from './compat.ts'
import { buildReplacementText, replacementWindowNumber } from './checkpoint.ts'
import type { RolloverReplacement } from './checkpoint.ts'
import type { ResolvedRolloverConfig } from './config.ts'

/**
 * Cordis plugin name this engine registers under, and the message-source
 * `kind` every message this engine injects carries. The host has no catch-all
 * `plugin` kind: a producer declares its own through the `MessageSourceMap`
 * merge point below, so this one constant names the engine in loader
 * diagnostics *and* attributes its injected messages.
 */
export const PLUGIN_NAME = 'context-rollover'

// The engine is a message producer, so it declares its own source kind at the
// host's documented merge point (the pattern shipped plugins use). The
// declaration is keyed and typed by PLUGIN_NAME, so the sender in index.ts and
// isPressureReminder below cannot disagree about the kind.
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    [PLUGIN_NAME]: { kind: typeof PLUGIN_NAME } & ContextFormed
  }
}

/**
 * Prefix of the pressure reminder's message summary.
 *
 * One constant serves both the sender and {@link isPressureReminder}, so the
 * two can never disagree about what a reminder looks like. The engine's own
 * plugin name is part of the test, and the package name is not: a predicate
 * keyed on `dsh-context-rollover` matches nothing the engine writes.
 */
export const REMINDER_SUMMARY_PREFIX = 'context pressure reminder'

/** The compaction/summary `provider` value written by this backend. */
export const ROLLOVER_PROVIDER = 'dsh-context-rollover'

/** Transaction inputs the engine resolves before committing. */
export interface RolloverDependencies {
  readonly meter: TokenMeter
}

/** One validated inclusive span of current surface positions. */
interface SurfaceSelection {
  readonly start: Seq
  readonly end: Seq
  readonly startIdx: number
  readonly endIdx: number
  readonly shadowedSeqs: readonly Seq[]
}

/** One selector-chosen inclusive span of current surface positions. */
export interface RolloverRange {
  readonly start: Seq
  readonly end: Seq
  readonly shadowedSeqs: readonly Seq[]
}

/**
 * The read-only sizing answer for one candidate replacement over one span.
 *
 * Every number here comes from the running meter and the session surface, so a
 * caller can make the same accept/refuse decision the transaction's shrink
 * guard makes, before any durable event is written.
 */
export interface RolloverSizing {
  /** Route price of the shadowed span: what the guard compares against. */
  readonly shadowedRouteTokens: number
  /** Heuristic price of the candidate replacement text as a committed message. */
  readonly replacementTokens: number
  /** True when the replacement is strictly smaller than the span it replaces. */
  readonly fits: boolean
}

/**
 * What one refusal calls the candidate it refused.
 *
 * A handoff document names itself: the model chose that exact file, so a
 * refusal has to say which file was too large rather than leaving the model to
 * guess which candidate lost. Only `kind` and `path` are read, so a caller that
 * has not finished composing a full replacement (the `new_context` preflight
 * reads a document before it has a window number) can still name it.
 * @param replacement - the replacement being priced, or its kind and path.
 * @returns the sentence subject for a size refusal.
 */
export function replacementSubject(
  replacement: Pick<RolloverReplacement, 'kind'> & { readonly path?: string },
): string {
  return replacement.kind === 'handoff-document' && replacement.path !== undefined
    ? `handoff document ${replacement.path}`
    : 'rollover replacement'
}

/**
 * The one sentence a size refusal carries, for the tool's preflight and the
 * transaction's own guard.
 *
 * One formatter means the refusal the model reads is the refusal the durable
 * `compaction/end` carries, so the two can never describe the same refusal
 * differently.
 * @param subject - what was refused, phrased as the sentence subject.
 * @param sizing - the measured span price and replacement price.
 * @returns one actionable sentence naming the cause.
 */
export function rolloverTooLargeMessage(
  subject: string,
  sizing: Pick<RolloverSizing, 'replacementTokens' | 'shadowedRouteTokens'>,
): string {
  return `the ${subject} is not smaller than the shadowed content `
    + `(${sizing.replacementTokens} estimated tokens >= ${sizing.shadowedRouteTokens}); `
    + 'the active context is too small for a useful rollover'
}

/** Options for one rollover transaction. */
export interface CommitRolloverOptions {
  /** `current-turn` derives the open turn's number; `null` writes a standalone bracket. */
  readonly owner: 'current-turn' | null
  /** What the replaced span becomes: a notes checkpoint, or the handoff document. */
  readonly replacement: RolloverReplacement
  /** Manual command that initiated this rollover, when present. */
  readonly sourceCommandId?: CommandId
  /** Optional durability checkpoint after a successfully closed bracket. */
  readonly flush?: () => Promise<void>
}

/** How one rollover selects the span it replaces. */
export type RolloverSelection =
  | {
      /** Retain a token-budgeted recent verbatim tail. */
      readonly kind: 'tail'
      /** Minimum recent tail budget retained verbatim. */
      readonly retainTokens: number
    }
  | {
      /**
       * Retain no tail: replace everything but a `system/message` at surface
       * node 0, and only when the cut after the LAST node is tool-pairing
       * balanced. Otherwise no range is returned for this pre-step (a
       * deferral). See {@link selectRolloverRange}.
       */
      readonly kind: 'handoff-only'
    }

/**
 * The recent-tail budget used when a session has no context window to scale by.
 *
 * A session without a routed request window cannot compute `retainRatio` of
 * anything, and retaining nothing would silently turn tail mode into
 * handoff-only mode, so the same absolute fallback every host line uses is
 * applied instead.
 */
const DEFAULT_TAIL_TOKENS = 4096

/**
 * How one resolved configuration selects the span a rollover replaces.
 *
 * Both the engine and the `new_context` size preflight call this, so the span
 * the tool prices is the span the engine will replace. Two copies of this rule
 * would let the preflight approve a document against a span the transaction
 * never selects.
 * @param config - the engine's resolved configuration.
 * @param session - session whose context window prices the tail budget.
 * @returns the retention rule for this deployment.
 */
export function selectionFor(
  config: ResolvedRolloverConfig,
  session: Session,
): RolloverSelection {
  if (config.handoffOnly) return { kind: 'handoff-only' }
  if (config.retainTokens !== null) return { kind: 'tail', retainTokens: config.retainTokens }
  const contextWindow = session.requestContext()?.contextWindow
  return {
    kind: 'tail',
    retainTokens: contextWindow === undefined
      ? DEFAULT_TAIL_TOKENS
      : Math.floor(contextWindow * config.retainRatio),
  }
}

/**
 * The first surface position a rollover may replace.
 *
 * A `system/message` at surface node 0 is never inside the range: newer hosts
 * reject rewriting it with anything but a single-node system rewrite. Without
 * one the range starts at node 0, which keeps this identical to the old
 * behavior on hosts without a system head.
 * @param session - session supplying the surface events.
 * @param surfaceNodes - the current surface positions, in order.
 * @returns `1` when a `system/message` occupies node 0, else `0`.
 */
function firstReplaceableIndex(session: Session, surfaceNodes: readonly Seq[]): number {
  const first = surfaceNodes[0]
  if (first === undefined) return 0
  const head = sessionEventAt(session, first)
  return head !== undefined && (head.type as string) === 'system/message' ? 1 : 0
}

/**
 * The span a handoff-only rollover would replace once any in-flight tool call
 * has settled: everything after a `system/message` head, through the tail.
 *
 * The `new_context` tool runs while the model's own tool call is the surface
 * tail and has no result yet (the host appends the assistant message and only
 * then runs the call: `packages/core/agent-loop/src/agent.ts`), so the trailing
 * cut is unbalanced and {@link selectRolloverRange} correctly defers. The tool
 * still has to answer the model about SIZE at that moment, so it prices this
 * prospective span instead.
 *
 * Pricing the prospective span is the conservative choice, and deliberately so.
 * The engine crosses later, on a surface that contains this one plus at least
 * the landed result, so the engine's span always CONTAINS this span and
 * therefore prices at least as high. A candidate that fits here (strictly
 * smaller than a smaller span) therefore fits there too, which is what makes a
 * tool-time acceptance safe to give. The reverse does not hold, so this can
 * refuse a candidate the engine would have accepted; that is the acceptable
 * direction, because a refusal is visible to the model and costs one retry with
 * a shorter document, while a false acceptance is the silent failure this
 * preflight exists to remove.
 * @param session - session supplying authoritative current surface positions.
 * @returns the prospective inclusive span, or `null` when the surface is only a
 *   system head (there is nothing to roll over).
 */
export function prospectiveHandoffOnlyRange(session: Session): RolloverRange | null {
  const surfaceNodes = session.surface.nodes
  const firstIdx = firstReplaceableIndex(session, surfaceNodes)
  if (surfaceNodes.length <= firstIdx) return null
  const start = surfaceNodes[firstIdx]
  const end = surfaceNodes[surfaceNodes.length - 1]
  if (start === undefined || end === undefined) return null
  return { start, end, shadowedSeqs: surfaceNodes.slice(firstIdx) }
}

/**
 * The answer to "would `new_context` be able to cross with this document?".
 *
 * A discriminated result rather than a throw, because the two refusals are
 * different facts and the caller phrases them differently: no usable span at
 * all, versus a span that this candidate cannot shrink.
 */
export type RolloverPreflight =
  | { readonly kind: 'no-span' }
  | { readonly kind: 'sized'; readonly sizing: RolloverSizing }

/**
 * Size one candidate exactly as the engine's own selection would price it, at a
 * moment when the engine cannot yet run its selector.
 *
 * `handoff-only` prices the prospective span from
 * {@link prospectiveHandoffOnlyRange}, because the live cut is unbalanced while
 * the requesting tool call is in flight. Every other mode prices the real
 * selection, because a retained tail keeps that in-flight call inside the tail
 * and the cut itself is balanced.
 * @param dependencies - the conversation meter used for pricing.
 * @param session - session supplying authoritative current surface positions.
 * @param config - the engine's resolved configuration, for the retention rule.
 * @param replacement - the candidate replacement to price.
 * @returns the sizing, or `{ kind: 'no-span' }` when nothing is selectable.
 */
export function preflightRolloverReplacement(
  dependencies: RolloverDependencies,
  session: Session,
  config: ResolvedRolloverConfig,
  replacement: RolloverReplacement,
): RolloverPreflight {
  const selection = selectionFor(config, session)
  const range = selection.kind === 'handoff-only'
    ? prospectiveHandoffOnlyRange(session)
    : selectRolloverRange(session, dependencies.meter.measure(session), selection)
  if (range === null) return { kind: 'no-span' }
  return { kind: 'sized', sizing: sizeRolloverReplacement(dependencies, session, range, replacement) }
}

/**
 * Select the replacement range for a rollover.
 *
 * `tail` mode keeps a token-budgeted recent slice verbatim and moves the cut
 * backward until it does not split an assistant tool-call/result pair.
 *
 * `handoff-only` mode retains no tail at all. The span runs from the first
 * non-`system/message` surface node through the LAST surface node, and only
 * when the cut after that last node is tool-pairing balanced. There is no
 * fallback cut: an earlier cut would leave the material between it and the tail
 * on the fresh surface, which is exactly what this mode exists to prevent.
 *
 * A step genuinely mid-tool-call has no result yet, so the cut after its tool
 * call is unbalanced and this returns `null`: the rollover DEFERS to the next
 * pre-step instead of retaining that incomplete call/result unit. Deferring
 * cannot lose the rollover, because the host guarantees every started tool call
 * converges to exactly one durable result: a skipped call gets a synthetic
 * error result (`packages/core/agent-loop/src/tool-calls.ts`, `appendSkippedToolCall`),
 * and a call left open by a crash gets one from `interruptedTurnClosers` when
 * the session is resumed (`packages/core/agent-loop/src/index.ts`, the
 * `resumeWith` path). So the surface is balanced by the time the next pre-step
 * runs. The engine additionally keeps a model-requested rollover pending when a
 * pre-step returns no range, so a deferral is retried rather than dropped.
 * @param session - session supplying authoritative current surface positions.
 * @param measurement - unified pressure and surface measurement from the meter.
 * @param selection - which retention rule to apply.
 * @returns the inclusive positional seq range to replace, or `null` when no
 *   span is selectable at this pre-step: either a deferral for an unbalanced
 *   tail, or no usable compactable span (nothing would be freed).
 */
export function selectRolloverRange(
  session: Session,
  measurement: TokenMeasurement,
  selection: RolloverSelection,
): RolloverRange | null {
  const pricedNodes = measurement.nodes
  if (pricedNodes.length === 0) return null

  const surfaceNodes = session.surface.nodes
  if (surfaceNodes.length !== pricedNodes.length
    || surfaceNodes.some((seq, index) => seq !== pricedNodes[index]?.seq)) {
    throw new Error('context-rollover: token-meter surface does not match the current session surface')
  }

  const firstIdx = firstReplaceableIndex(session, surfaceNodes)

  if (selection.kind === 'handoff-only') {
    if (surfaceNodes.length <= firstIdx) return null
    // No walk back. A cut before the tail would leave old surface material on
    // the fresh context, so an unbalanced tail defers the rollover instead of
    // shrinking the span. The next pre-step sees the landed result and crosses.
    const cutoff = surfaceNodes[surfaceNodes.length - 1]
    if (cutoff === undefined || !toolPairingBalancedAfter(session, cutoff)) return null
    const start = surfaceNodes[firstIdx]
    if (start === undefined) return null
    return {
      start,
      end: cutoff,
      shadowedSeqs: surfaceNodes.slice(firstIdx),
    }
  }

  const retainTokens = selection.retainTokens
  let accumulated = 0
  let keepFromIdx: number | undefined
  for (let index = pricedNodes.length - 1; index >= 0; index -= 1) {
    accumulated += pricedNodes[index]?.tokens ?? 0
    keepFromIdx = index
    if (accumulated >= retainTokens) break
  }
  if (keepFromIdx === undefined || keepFromIdx <= firstIdx) return null

  while (keepFromIdx > firstIdx) {
    const candidate = surfaceNodes[keepFromIdx]
    if (candidate !== undefined && toolPairingBalancedBefore(session, candidate)) break
    keepFromIdx -= 1
  }
  if (keepFromIdx <= firstIdx) return null

  const start = surfaceNodes[firstIdx]
  const cutoff = surfaceNodes[keepFromIdx - 1]
  if (start === undefined || cutoff === undefined) return null
  return {
    start,
    end: cutoff,
    shadowedSeqs: surfaceNodes.slice(firstIdx, keepFromIdx),
  }
}

/**
 * Price one candidate replacement against the span it would replace, without
 * writing anything.
 *
 * This is the comparison {@link commitRollover}'s shrink guard makes, run as a
 * pure read over the selected span and the candidate text, on the meter's
 * current route pricing. Every caller that must decide BEFORE taking the
 * compaction lock uses it: the `new_context` tool, so a candidate that cannot
 * shrink the span is refused while the model can still read the reason
 * ({@link preflightRolloverReplacement}), so a refused candidate leaves no failed
 * transaction behind.
 *
 * The answer is a prediction, not a reservation. {@link commitRollover} prices
 * the span and the candidate again when it commits, so a route change between
 * the preflight and the commit can flip the outcome, and the commit's guard is
 * the authority.
 * @param dependencies - the conversation meter used for pricing.
 * @param session - session supplying authoritative current surface positions.
 * @param range - the span selected by {@link selectRolloverRange}.
 * @param replacement - the candidate replacement to price.
 * @returns the span price, the replacement price, and whether the replacement fits.
 * @throws when the meter's surface does not match the current session surface.
 */
export function sizeRolloverReplacement(
  dependencies: RolloverDependencies,
  session: Session,
  range: RolloverRange,
  replacement: RolloverReplacement,
): RolloverSizing {
  const measurement = dependencies.meter.measure(session)
  const nodes = measurement.nodes
  const shadowedSeqs = session.surface.nodes
  if (nodes.length !== shadowedSeqs.length
    || nodes.some((node, index) => node.seq !== shadowedSeqs[index])) {
    throw new Error('context-rollover: token-meter surface does not match the current session surface')
  }
  const startIdx = nodes.findIndex(node => node.seq === range.start)
  const endIdx = nodes.findIndex(node => node.seq === range.end)
  if (startIdx === -1 || endIdx === -1 || startIdx > endIdx) {
    throw new Error('context-rollover: the selected span is no longer on the current surface')
  }
  const selectedNodes = nodes.slice(startIdx, endIdx + 1)
  const shadowedRouteTokens = selectedNodes.reduce((total, node) => total + node.tokens, 0)
  const replacementText = buildReplacementText(replacement)
  const replacementTokens = priceReplacementText(dependencies, replacementText)
  return {
    shadowedRouteTokens,
    replacementTokens,
    fits: replacementTokens < shadowedRouteTokens,
  }
}

/**
 * Price replacement text exactly as the committed message would be priced.
 *
 * The transaction wraps the same text in a `user/message` and prices that
 * message. Only `role` and `content` contribute to that price, so this builds
 * the same shape with a plain user source rather than minting a transaction
 * identity the preflight has not been given yet; the two numbers cannot differ.
 * @param dependencies - the conversation meter used for pricing.
 * @param text - the candidate replacement text.
 * @returns the token price of the replacement message.
 */
function priceReplacementText(dependencies: RolloverDependencies, text: string): number {
  return dependencies.meter.estimateMessage(createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }))
}

/** Validate one requested surface-position span before committing. */
function validateSurfaceRegion(session: Session, start: Seq, end: Seq): SurfaceSelection {
  const nodes = session.surface.nodes
  const startIdx = nodes.indexOf(start)
  const endIdx = nodes.indexOf(end)
  if (startIdx === -1) throw new Error(`rollover: start seq ${start} not found in surface`)
  if (endIdx === -1) throw new Error(`rollover: end seq ${end} not found in surface`)
  if (startIdx > endIdx) {
    throw new Error(
      `rollover: start seq ${start} (position ${startIdx}) is after end seq ${end} (position ${endIdx}) on the surface`,
    )
  }
  const startNode = nodes[startIdx]
  const endNode = nodes[endIdx]
  if (startNode === undefined || endNode === undefined) {
    throw new Error('rollover: span bounds vanished from the surface')
  }
  if (!toolPairingBalancedBefore(session, startNode)) {
    throw new Error(`rollover: start seq ${start} is not a balanced boundary (would split a tool-call/result pair)`)
  }
  if (!toolPairingBalancedAfter(session, endNode)) {
    throw new Error(`rollover: end seq ${end} is not a balanced boundary (would split an open step)`)
  }
  return { start, end, startIdx, endIdx, shadowedSeqs: nodes.slice(startIdx, endIdx + 1) }
}

/** Entry state: open turn, unmatched compaction lock, and latest end-seed boundary. */
interface RolloverEntryState {
  readonly openTurn: number | null
  readonly unmatchedCompactionStart: SessionEvent<'compaction/start'> | undefined
  readonly latestEndSeedSeq: Seq | undefined
}

/** Inspect open-turn, unmatched-compaction, and latest seed-boundary state. */
function inspectEntryState(session: Session): RolloverEntryState {
  let openTurn: number | null = null
  let openTurnStateKnown = false
  let unmatchedCompactionStart: SessionEvent<'compaction/start'> | undefined
  let compactionEntryStateKnown = false
  let latestEndSeedSeq: Seq | undefined
  for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
    const event = sessionEventAt(session, seq)
    if (event === undefined) continue
    if (latestEndSeedSeq === undefined && event.type === 'session/end-seed') {
      latestEndSeedSeq = event.seq
    }
    if (!compactionEntryStateKnown) {
      if (event.type === 'compaction/start') {
        unmatchedCompactionStart = event
        compactionEntryStateKnown = true
      } else if (event.type === 'compaction/end') {
        compactionEntryStateKnown = true
      }
    }
    if (!openTurnStateKnown) {
      if (event.type === 'turn/start') {
        openTurn = event.data.turn
        openTurnStateKnown = true
      } else if (event.type === 'turn/end') {
        openTurnStateKnown = true
      }
    }
    if (openTurnStateKnown && compactionEntryStateKnown && latestEndSeedSeq !== undefined) break
  }
  return { openTurn, unmatchedCompactionStart, latestEndSeedSeq }
}

/**
 * Commit one rollover over a validated span. Selection, validation and the
 * shrink decision are read-only and happen before the lock; `compaction/start`
 * then opens the transaction, which appends the summary and the replacement
 * message synchronously, so the body commits without yielding between the lock
 * and the replacement. A refusal therefore writes nothing at all, and only a
 * failure after the lock leaves the bracket paired with an error close, as the
 * shared compaction protocol expects.
 * @param dependencies - the conversation meter used for pricing.
 * @param session - session whose surface is mutated.
 * @param start - inclusive first surface-node seq of the replaced span.
 * @param end - inclusive last surface-node seq of the replaced span.
 * @param options - bracket owner, replacement content, flush, and command provenance.
 * @returns the durable compaction result.
 */
export async function commitRollover(
  dependencies: RolloverDependencies,
  session: Session,
  start: Seq,
  end: Seq,
  options: CommitRolloverOptions,
): Promise<CompactionResult> {
  const selection = validateSurfaceRegion(session, start, end)
  const entryState = inspectEntryState(session)
  if (entryState.unmatchedCompactionStart !== undefined
    && (entryState.latestEndSeedSeq === undefined
      || entryState.latestEndSeedSeq <= entryState.unmatchedCompactionStart.seq)) {
    throw new ManualCompactionError(
      'busy',
      'context-rollover: a compaction is already in progress; the session compaction lock is active',
    )
  }

  let owner: number | null
  if (options.owner === null) {
    if (entryState.openTurn !== null) {
      throw new ManualCompactionError('busy', 'manual rollover: the session already has an open turn')
    }
    owner = null
  } else {
    if (entryState.openTurn === null) {
      throw new Error('rollover: no open turn — automatic rollover events must be enclosed in a turn')
    }
    owner = entryState.openTurn
  }

  // The span is priced and the shrink decision is made BEFORE `compaction/start`
  // opens the transaction. Nothing between here and the lock yields, so the
  // surface cannot move; a refusal therefore leaves the durable log completely
  // untouched instead of a start/error-end bracket recording an attempt that
  // never had a chance of committing.
  const measurement = dependencies.meter.measure(session)
  const selectedNodes = measurement.nodes.slice(selection.startIdx, selection.endIdx + 1)
  if (selectedNodes.length !== selection.shadowedSeqs.length
    || selectedNodes.some((node, index) => node.seq !== selection.shadowedSeqs[index])) {
    throw new Error('rollover: the selected surface changed before the replacement committed')
  }
  const shadowedTokenCount = selectedNodes.reduce((total, node) => total + nodeHeuristicTokens(node), 0)

  const replacementText = buildReplacementText(options.replacement)
  const framedTokenCount = priceReplacementText(dependencies, replacementText)
  const shadowedRouteTokenCount = selectedNodes.reduce((total, node) => total + node.tokens, 0)
  if (framedTokenCount >= shadowedRouteTokenCount) {
    throw new Error(rolloverTooLargeMessage(
      replacementSubject(options.replacement),
      { replacementTokens: framedTokenCount, shadowedRouteTokens: shadowedRouteTokenCount },
    ))
  }

  const compactionId = CompactionId(randomUUID())
  const lifecycle = {
    compactionId,
    ...options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId },
    turn: owner,
  }
  const startEvent = session.append('compaction/start', lifecycle)

  let result: CompactionResult | undefined
  try {
    const checkpointMessage = createUserMessage({
      content: [{ type: 'text', text: replacementText }],
      source: compactCheckpointSource(compactionId, options.sourceCommandId),
    })
    const summaryBlocks: ContentBlock[] = [{ type: 'text', text: replacementText }]
    const summaryEvent = session.append('compaction/summary', {
      compactionId,
      ...options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId },
      summary: summaryBlocks,
      shadowedRange: { start, end },
      shadowedSeqs: [...selection.shadowedSeqs],
      shadowedTokenCount,
      provider: ROLLOVER_PROVIDER,
      model: `deterministic/window-${replacementWindowNumber(options.replacement)}`,
    })
    session.append('user/message', checkpointMessage, {
      // The op shape is host-versioned (see replaceSurfaceOp); the cast is
      // the single typed escape for the line this host does not declare.
      surfaceOp: replaceSurfaceOp(start, end) as never,
      sourceEventSeqs: [startEvent.seq, summaryEvent.seq, ...selection.shadowedSeqs],
    })
    const endEvent = session.append('compaction/end', lifecycle)
    result = {
      compactionId,
      ...options.sourceCommandId === undefined ? {} : { sourceCommandId: options.sourceCommandId },
      startSeq: startEvent.seq,
      summarySeq: summaryEvent.seq,
      endSeq: endEvent.seq,
      summary: summaryBlocks,
      shadowedRange: { start, end },
      shadowedSeqs: [...selection.shadowedSeqs],
      shadowedTokenCount,
    }
  } catch (error: unknown) {
    try {
      session.append('compaction/end', { ...lifecycle, error: errorChain(error) })
    } catch {
      // The unmatched start stays durable evidence of the failed attempt; the
      // original failure is the one callers must see.
    }
    throw error
  }

  if (result === undefined) throw new Error('rollover committed without a result')
  if (options.flush !== undefined) await options.flush()
  return result
}

/**
 * Count the rollovers this backend has committed on one session, from the
 * durable compaction/summary records it wrote.
 * @param session - session to inspect.
 * @returns the committed rollover count (0 = the first window is still active).
 */
export function countRollovers(session: Session): number {
  let count = 0
  for (const event of sessionEvents(session)) {
    if (event.type === 'compaction/summary' && event.data.provider === ROLLOVER_PROVIDER) {
      count += 1
    }
  }
  return count
}

/**
 * Collect the seqs of this backend's rollover summary events, ascending.
 * @param session - session to inspect.
 * @returns the summary event seqs in log order.
 */
export function rolloverSummarySeqs(session: Session): Seq[] {
  const seqs: Seq[] = []
  for (const event of sessionEvents(session)) {
    if (event.type === 'compaction/summary' && event.data.provider === ROLLOVER_PROVIDER) {
      seqs.push(event.seq)
    }
  }
  return seqs
}

/**
 * Claim registry for pressure reminders, hung on the session object itself.
 *
 * The key is a `Symbol.for(...)` — the global symbol registry — because the
 * two engine rows that observe one pre-step are **separate module instances**:
 * on the Web profile the host bundle row and the session's agent-preset row
 * load this module through different paths, behind a preset `isolate` realm
 * (they cannot share a Cordis container: `compaction` may be provided once).
 * A module-scoped Set or WeakMap is therefore invisible to the other row, and
 * the durable log cannot help either: `agent/pre-step` is a waterfall, and the
 * decisions of both rows are appended only after the dispatch returns, so both
 * rows decide before either delivery exists in the log.
 *
 * What both rows *do* share is the Session instance they are handed. A global
 * symbol property on it is readable by any module instance, is invisible to
 * serialization and to `Object.keys`, and dies with the session — which is
 * exactly the lifetime a claim needs.
 */
const CLAIM_KEY = Symbol.for('dsh.context-rollover.reminder-claims')

/** The claimed window numbers on one session, created on first use. */
function claimsOn(session: Session): Set<number> {
  const carrier = session as unknown as Record<symbol, unknown>
  const existing = carrier[CLAIM_KEY]
  if (existing instanceof Set) return existing as Set<number>
  const created = new Set<number>()
  try {
    Object.defineProperty(session, CLAIM_KEY, {
      value: created,
      enumerable: false,
      configurable: true,
      writable: false,
    })
  } catch {
    // A frozen session still works: fall back to a process-local set, which
    // covers single-row deployments and loses only the cross-row case.
    fallbackClaims.set(session, created)
  }
  return created
}

/** Claims for sessions that refuse the symbol property. */
const fallbackClaims = new WeakMap<Session, Set<number>>()

/**
 * Identity of the context window a reminder would belong to: the session plus
 * its rollover count, so a fresh window may remind again.
 * @param session - session to key.
 * @returns the window key, stable for the life of the window.
 */
export function reminderWindowKey(session: Session): string {
  return `${session.id}#${countRollovers(session)}`
}

/**
 * The one definition of "this event is a pressure reminder".
 *
 * The source carries the engine's own plugin name as its source kind, which is
 * not the package name: a predicate keyed on `dsh-context-rollover` never
 * matches anything the engine writes, and silently disables whatever depends
 * on it. Both the kind and the summary prefix come from the shared constants
 * the sender uses for the same reason. Every consumer — the delivery check
 * below and the test harness — reads this predicate, so the definition cannot
 * drift again.
 * @param event - one logged session event.
 * @returns true when the event is this engine's pressure reminder, narrowing
 *   the event to a `user/message` for the caller.
 */
export function isPressureReminder(event: SessionEvent): event is SessionEvent<'user/message'> {
  if (event.type !== 'user/message') return false
  const { source } = event.data
  if (source.kind !== PLUGIN_NAME) return false
  return source.form === 'notice'
    && source.summary.startsWith(REMINDER_SUMMARY_PREFIX)
}

/**
 * Whether a pressure reminder was already delivered in the session's current
 * window, according to the durable log.
 *
 * This is the authority for "once per window" across turns and restarts: every
 * engine row reads the same log, and an in-memory claim cannot survive a
 * process restart. It cannot cover two rows deciding within one waterfall —
 * see the claim registry above for that.
 * @param session - session to inspect.
 * @returns true when the current window already carries a reminder.
 */
export function reminderDelivered(session: Session): boolean {
  const windowStart = (rolloverSummarySeqs(session).at(-1) ?? -1) + 1
  return sessionEvents(session)
    .some(event => event.seq >= windowStart && isPressureReminder(event))
}

/**
 * Claim the current window's reminder slot, if nobody has yet.
 *
 * Claiming is synchronous on purpose: two engine rows can decide within one
 * waterfall, before either delivery reaches the log.
 * @param session - session whose window to claim.
 * @returns true when this caller owns the reminder for the window.
 */
export function claimReminder(session: Session): boolean {
  if (reminderDelivered(session)) return false
  const claimed = claimsOn(session)
  const windowNumber = countRollovers(session)
  if (claimed.has(windowNumber)) return false
  claimed.add(windowNumber)
  return true
}

/**
 * Drop every in-process claim for one session.
 *
 * Only tests need this: they reuse session ids across cases in one process,
 * while production scopes each claim to the session it was made on.
 * @param session - session whose claims to drop.
 */
export function resetReminderClaims(session: Session): void {
  claimsOn(session).clear()
  fallbackClaims.delete(session)
}
