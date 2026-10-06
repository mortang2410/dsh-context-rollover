/**
 * Context-window rollover engine: the active `ctx.compaction` backend that
 * crosses context boundaries without summarization.
 *
 * Responsibilities stay split (the Codex lesson): the `new_context` tool only
 * requests a boundary, the pre-step / turn-stopping listeners decide when the
 * boundary is actually crossed, the token meter measures pressure and delivers
 * one reminder per window, and {@link commitRollover} performs the surface
 * replacement inside DSH's normal compaction transaction.
 *
 * @module dsh-context-rollover
 */

import { Context, symbols } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CompactionEngine, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import type { CompactionResult, CompactionTrigger } from '@deepseek-ai/dsh-compaction'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { CommandId } from '@deepseek-ai/dsh-commands/brand'
import { CONTEXT_WINDOW_EXCEEDED_CODE, boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: makes the optional sibling service available to `ctx.get()`, and
// loads the system-prompt Context merge for the `ctx.systemPrompt` key.
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { Seq } from './compat.ts'
import { renderReminderMessage, resolveConfig } from './config.ts'
import type { RolloverConfig, ResolvedRolloverConfig } from './config.ts'
import type { RolloverReason, RolloverReplacement } from './checkpoint.ts'
import { CONTEXT_MANAGEMENT_GUIDANCE } from './guidance.ts'
import { readHandoffFile, scanHandoffDir } from './handoff.ts'
import { NotesStore } from './notes.ts'
import { sessionEventAt } from './compat.ts'
import {
  claimReminder,
  commitRollover,
  countRollovers,
  PLUGIN_NAME,
  REMINDER_SUMMARY_PREFIX,
  selectRolloverRange,
  selectionFor,
  sizeRolloverReplacement,
} from './rollover.ts'
import type { RolloverRange, RolloverSelection, RolloverSizing } from './rollover.ts'
import { replacementWindowNumber } from './checkpoint.ts'
import { createRolloverTools } from './tools.ts'
import type { PendingRollover } from './state.ts'

/** Cordis plugin name used by loader diagnostics and message-source attribution. */
export const name = PLUGIN_NAME

/** Identity of one agent turn for per-turn engine bookkeeping. */
function turnKey(sessionId: string, turn: number): string {
  return `${sessionId}#${turn}`
}

/**
 * Minimal agent-preset roster shape, read without a peer dependency on the
 * preset package (the published package mirror does not carry it): resolved
 * at call time through the service store, so rosterless deployments simply
 * observe no roster. Only the `serviceFor` read is used.
 */
interface AgentPresetRoster {
  serviceFor(agent: { ctx: Context }, name: 'compaction'): CompactionEngine | undefined
}

/** Read the agent-preset roster when this deployment has one. */
function rosterOf(ctx: Context): AgentPresetRoster | undefined {
  const roster = (ctx as unknown as { get(name: string): unknown }).get('agentPresets')
  if (roster === undefined || roster === null
    || typeof (roster as AgentPresetRoster).serviceFor !== 'function') return undefined
  return roster as AgentPresetRoster
}

/** Resolve a Cordis traced service proxy to the concrete registered instance. */
function concreteCompaction(engine: CompactionEngine): CompactionEngine {
  return (engine as CompactionEngine & { [symbols.original]?: CompactionEngine })[symbols.original] ?? engine
}

/**
 * The handoff text one pending request will commit, with its internal
 * invariant asserted.
 *
 * `new_context` already read and validated the document inside its own
 * `execute`, so a pending request always carries non-empty text. A violation
 * here is an engine bug, not a user mistake, which is why it is an assertion
 * rather than a refusal the model has to read: the pre-step listener logs it as
 * a warning, and the old context correctly stays put.
 * @param pending - the model's recorded rollover request.
 * @returns the handoff text to commit.
 */
function pendingHandoff(pending: PendingRollover): string {
  if (pending.handoff.trim().length === 0) {
    throw new Error(
      `context-rollover: internal invariant violated: the rollover read ${pending.handoffPath} but `
      + 'recorded no handoff text',
    )
  }
  return pending.handoff
}

export type { RolloverConfig, ResolvedRolloverConfig } from './config.ts'
export {
  DEFAULT_HANDOFF_DIR,
  DEFAULT_HANDOFF_PATTERN,
  DEFAULT_REMINDER_MESSAGE,
  renderReminderMessage,
  resolveConfig,
} from './config.ts'
export { buildCheckpointText, buildReplacementText, replacementWindowNumber } from './checkpoint.ts'
export type { CheckpointInput, RolloverReason, RolloverReplacement } from './checkpoint.ts'
export {
  HandoffError,
  matchesHandoffPattern,
  readHandoffFile,
  readHandoffFileOrThrow,
  resolveHandoffPath,
  scanHandoffDir,
} from './handoff.ts'
export type {
  HandoffCandidate,
  HandoffFailure,
  HandoffFailureReason,
  HandoffReadRequest,
  HandoffResult,
  HandoffScanRequest,
  HandoffSuccess,
} from './handoff.ts'
export { NotesStore, resolveNotePath } from './notes.ts'
export { collectHistory, readHistoryItem, searchHistory } from './history.ts'
export {
  commitRollover,
  countRollovers,
  rolloverSummarySeqs,
  selectRolloverRange,
  sizeRolloverReplacement,
  ROLLOVER_PROVIDER,
} from './rollover.ts'
export type { RolloverRange, RolloverSelection, RolloverSizing } from './rollover.ts'
export { createRolloverTools } from './tools.ts'
export { CONTEXT_MANAGEMENT_GUIDANCE } from './guidance.ts'

/**
 * Summarization-free compaction backend: durable notes + handoff/recovery
 * checkpoint + token-budgeted recent verbatim tail, with model-requested
 * rollover via the `new_context` tool and runtime-driven rollover as the
 * pressure/overflow safety net.
 */
export class ContextRolloverEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions', 'tools', 'systemPrompt']

  static Config: z<RolloverConfig> = z.object({
    thresholdRatio: z.number(),
    reminderThresholdRatio: z.number(),
    reminderMessage: z.string(),
    retainRatio: z.number(),
    retainTokens: z.number().step(1).min(0),
    handoffOnly: z.boolean(),
    handoffMaxChars: z.number().step(1).min(0),
    notesEnabled: z.boolean(),
    historyEnabled: z.boolean(),
    notesDir: z.string(),
    handoffDir: z.string(),
    handoffPattern: z.string(),
    modelSurface: z.union(['auto', 'always'] as const),
  })

  /** Resolved and validated configuration. */
  readonly config: ResolvedRolloverConfig

  private readonly pendingRollovers = new Map<string, PendingRollover>()
  /** Turns (session + seq at crossing time) that already had a pressure rollover. */
  private readonly pressureRolledTurns = new Set<string>()
  private readonly overflowRetries = new WeakMap<Agent, number>()

  constructor(ctx: Context, config: RolloverConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    this.registerTools()
    this.registerGuidance()
    this.registerLifecycle()
  }

  /** Mount the model-facing tools. */
  private registerTools(): void {
    if (!this.registersModelSurface()) return
    const deps = {
      config: this.config,
      meter: this.ctx.tokenMeter,
      pendingRollovers: this.pendingRollovers,
      compactionOwnedElsewhere: (agent: { ctx: Context }) => this.compactionOwnedElsewhere(agent as Agent),
    }
    for (const tool of createRolloverTools(deps, this.config.notesEnabled, this.config.historyEnabled)) {
      this.ctx.tools.register(tool)
    }
  }

  /** Mount the stable context-management guidance section. */
  private registerGuidance(): void {
    if (!this.registersModelSurface()) return
    this.ctx.systemPrompt.section({
      name: 'context:rollover',
      order: 2350,
      text: CONTEXT_MANAGEMENT_GUIDANCE,
    })
  }

  /** Whether this row owns the model-facing tools and guidance. */
  private registersModelSurface(): boolean {
    return this.config.modelSurface === 'always' || rosterOf(this.ctx) === undefined
  }

  /** Register the pending-rollover, pressure, and overflow lifecycle listeners. */
  private registerLifecycle(): void {
    const { ctx } = this

    // Cross the boundary before the next model request when the model asked
    // for it, then fall through to the pressure evaluation.
    ctx.on('agent/pre-step', async (
      { agent, turn, signal },
      next,
    ): Promise<PreStepDecision> => {
      // A preset-owned session is that preset's backend's responsibility;
      // without this guard the host engine and the preset backend would race
      // the same pressure signal and the loser would fail on the lock.
      if (!signal.aborted && !this.compactionOwnedElsewhere(agent)) {
        try {
          const pending = this.pendingRollovers.get(agent.session.id)
          if (pending !== undefined) {
            // The request is only cleared once it has actually been honoured.
            // Under `handoff-only` a pre-step whose tail cut is unbalanced
            // (the model's own `new_context` call has no result yet) selects no
            // span and defers; clearing the request first would silently drop
            // the boundary the model asked for, and the next pre-step, which is
            // the one that can cross, would never try.
            const result = await this.performRollover(agent, {
              reason: 'model-requested',
              handoff: pendingHandoff(pending),
              handoffPath: pending.handoffPath,
            }, signal)
            if (result !== null) this.pendingRollovers.delete(agent.session.id)
          } else {
            await this.rollOverOnPressure(agent, turn, signal)
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`context rollover failed: ${message}; continuing the turn`)
        }
      }
      const decision = await next()
      if (decision.kind === 'reject') return decision
      const reminder = this.pendingReminder(agent.session)
      if (reminder === undefined) return decision
      return { kind: 'enter', messages: [...decision.messages, reminder] }
    })

    // A rollover requested as the turn's last action still happens before the
    // next turn starts.
    ctx.on('agent/turn-stopping', async ({ agent, signal }) => {
      if (this.compactionOwnedElsewhere(agent)) return
      const pending = this.pendingRollovers.get(agent.session.id)
      if (pending === undefined || signal.aborted) return
      this.pendingRollovers.delete(agent.session.id)
      try {
        await this.performRollover(agent, {
          reason: 'model-requested',
          handoff: pendingHandoff(pending),
          handoffPath: pending.handoffPath,
        }, signal)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`context rollover at turn stop failed: ${message}`)
      }
    })

    ctx.on('agent/status', ({ agent, status }) => {
      if (status === 'idle') this.overflowRetries.delete(agent)
    })

    // Provider-confirmed context overflow: roll over and let the loop resend
    // the request against the checkpoint and retained tail.
    ctx.on('agent/request-error', async (
      { agent, failure, signal },
      next,
    ) => {
      if (failure.code !== CONTEXT_WINDOW_EXCEEDED_CODE || signal.aborted) return next()
      if (this.compactionOwnedElsewhere(agent)) return next()
      const generation = agent.session.surface.replaceGeneration
      const retries = this.overflowRetries.get(agent) ?? 0
      try {
        await this.performRollover(agent, { reason: 'overflow', handoff: null }, signal)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`context-overflow rollover failed: ${message}; preserving the original request error`)
        return next()
      }
      if (signal.aborted || agent.session.surface.replaceGeneration <= generation) return next()
      this.overflowRetries.set(agent, retries + 1)
      return { kind: 'retry' }
    })
  }

  /**
   * The one-per-window handoff reminder, when this step crosses the reminder
   * threshold for the first time in the current window.
   *
   * The text is the configured {@link RolloverConfig.reminderMessage} with
   * `{percent}` replaced by the measured percentage. The threshold is what
   * gates delivery: nothing about the text is hardcoded here.
   */
  private pendingReminder(session: Session): UserMessage | undefined {
    const contextWindow = session.requestContext()?.contextWindow
    if (contextWindow === undefined) return undefined
    const measurement = this.ctx.tokenMeter.measure(session)
    if (measurement.baseline.kind === 'none') return undefined
    const reminderTokens = Math.floor(contextWindow * this.config.reminderThresholdRatio)
    if (measurement.totalTokens < reminderTokens) return undefined
    // Claimed synchronously: on a preset deployment the host row and the
    // preset row both observe this pre-step, and neither delivery is in the
    // log yet when the second one decides.
    if (!claimReminder(session)) return undefined
    const percent = Math.min(100, Math.round((measurement.totalTokens / contextWindow) * 100))
    return createUserMessage({
      content: [{
        type: 'text',
        text: renderReminderMessage(this.config.reminderMessage, percent),
      }],
      source: {
        kind: PLUGIN_NAME,
        form: 'notice',
        summary: boundContextSummary(`${REMINDER_SUMMARY_PREFIX} (${percent}% used)`),
      },
    })
  }

  /**
   * Pressure evaluation: one reminder per window below the rollover point,
   * automatic rollover above it. Automatic pressure rollover happens at most
   * once per turn: crossing the threshold again within the same turn means
   * per-step re-injection plus tail exceed the threshold (a config/tail
   * mismatch), which no rollover fixes — rolling over again would burn the
   * prefix cache every step. Model-requested and overflow rollovers are exempt.
   *
   * Only a COMMITTED rollover consumes the turn's one attempt. A pre-step whose
   * span has no candidate that would shrink it (the preflight below rejects one)
   * leaves the attempt unspent on purpose: that pre-step measured a span too
   * small to hold anything useful, and the next pre-step of the same turn
   * measures a larger span that the checkpoint does fit. Spending the attempt on
   * the refusal would strand the context above the threshold with the notes
   * checkpoint still available, which is the exact harm the ordering prevents.
   */
  private async rollOverOnPressure(agent: Agent, turn: number, signal: AbortSignal): Promise<void> {
    const contextWindow = agent.session.requestContext()?.contextWindow
    if (contextWindow === undefined) return
    const measurement = this.ctx.tokenMeter.measure(agent.session)
    if (measurement.baseline.kind === 'none') return
    const rolloverTokens = Math.floor(contextWindow * this.config.thresholdRatio)
    if (measurement.totalTokens < rolloverTokens) return
    if (this.pressureRolledTurns.has(turnKey(agent.session.id, turn))) {
      this.ctx.logger.warn(
        `context rollover: usage is still above the automatic threshold after this turn's pressure `
        + `rollover (tail + per-step context likely exceed thresholdRatio * contextWindow); `
        + 'skipping further automatic rollovers this turn',
      )
      return
    }
    const result = await this.performRollover(
      agent,
      { reason: 'pressure', handoff: null, emergency: true },
      signal,
    )
    if (result !== null) this.pressureRolledTurns.add(turnKey(agent.session.id, turn))
  }

  /**
   * Perform one rollover: select the replacement range, resolve the
   * replacement content for the reason, and commit the compaction transaction.
   * @param agent - agent whose session surface is rolled over.
   * @param request - rollover reason and the already-read handoff document text,
   *   when the model requested this rollover.
   * @param signal - live turn cancellation signal.
   * @returns the compaction result, or `null` when no useful range exists.
   */
  private async performRollover(
    agent: Agent,
    request: { reason: RolloverReason; handoff: string | null; handoffPath?: string; emergency?: true },
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    const session = agent.session
    const range = selectRolloverRange(session, this.ctx.tokenMeter.measure(session), this.selection(session))
    if (range === null) {
      // A deferral is not a failure and is not logged as one: the surface has
      // no selectable span at this pre-step, which under `handoff-only` means
      // the tail cut is still unbalanced and the next pre-step retries.
      this.ctx.logger.info('context rollover skipped: no compactable surface span (context is already minimal)')
      return null
    }
    // The emergency path decides which candidate to write BEFORE the lock is
    // taken, because a refused candidate must leave no failed transaction in
    // the durable log. It hands its accepted sizing to the transaction, so the
    // guard decides with the numbers that were accepted rather than re-pricing
    // the same span after `compaction/start` is already durable. Every other
    // path resolves one replacement by construction and keeps the transaction's
    // own shrink guard as the check.
    const chosen = request.emergency === true
      ? await this.emergencyReplacement(session, request.reason, range)
      : null
    const replacement = request.emergency === true
      ? chosen?.replacement ?? null
      : await this.replacementFor(session, request)
    if (replacement === null) {
      this.ctx.logger.info(
        'context rollover skipped: no candidate replacement is smaller than the selected span',
      )
      return null
    }
    const windowNumber = replacementWindowNumber(replacement)
    const result = await commitRollover(
      { meter: this.ctx.tokenMeter },
      session,
      range.start,
      range.end,
      {
        owner: 'current-turn',
        replacement,
        ...chosen === null ? {} : { pinnedSizing: chosen.sizing },
      },
    )
    this.ctx.logger.info(
      `context rollover (${request.reason}): window ${windowNumber} started; `
      + `shadowed ${result.shadowedSeqs.length} surface nodes (~${result.shadowedTokenCount} tokens)`,
    )
    return result
  }

  /**
   * Choose the emergency path's replacement: newest eligible handoff document
   * that passes the shrink check, else the deterministic notes checkpoint, else
   * nothing.
   *
   * The order is the whole point. A readable handoff that is NOT smaller than
   * the span it would replace must not consume the one automatic rollover a
   * turn gets and leave the context unchanged while a smaller notes checkpoint
   * was available, so each candidate is priced against the selected span here,
   * before {@link commitRollover} takes the compaction lock. A candidate that
   * cannot be turned into document text (missing by a race, not a regular file,
   * unreadable, empty, oversized) is skipped rather than fatal: the scan is a
   * fallback of last resort, and one bad file must not abort the rollover.
   *
   * A session with no working directory cannot resolve a relative
   * `handoffDir`, so {@link scanHandoffDir} returns no candidates and this falls
   * straight through to the notes checkpoint rather than reading anywhere else.
   * @param session - session whose window number is being started.
   * @param reason - the rollover reason, carried into a notes checkpoint.
   * @param range - the selected span every candidate is priced against.
   * @returns the replacement to commit with the sizing that accepted it, or
   *   `null` when nothing would shrink.
   */
  private async emergencyReplacement(
    session: Session,
    reason: RolloverReason,
    range: RolloverRange,
  ): Promise<{ readonly replacement: RolloverReplacement; readonly sizing: RolloverSizing } | null> {
    const windowNumber = countRollovers(session) + 1
    const cwd = session.header.cwd
    const candidates = await scanHandoffDir({
      dir: this.config.handoffDir,
      pattern: this.config.handoffPattern,
      cwd,
    })
    if (candidates.length === 0) {
      this.ctx.logger.info(
        `context rollover: no handoff document matched ${this.config.handoffPattern} under `
        + `the session handoff directory; using the notes checkpoint`,
      )
    }
    for (const candidate of candidates) {
      const read = await readHandoffFile({
        path: candidate.path,
        cwd,
        maxChars: this.config.handoffMaxChars,
      })
      if (read.ok === false) {
        this.ctx.logger.info(
          `context rollover: skipping handoff candidate ${candidate.path}: ${read.message}`,
        )
        continue
      }
      const replacement: RolloverReplacement = {
        kind: 'handoff-document',
        windowNumber,
        text: read.text,
        path: read.path,
      }
      const sizing = sizeRolloverReplacement({ meter: this.ctx.tokenMeter }, session, range, replacement)
      if (!sizing.fits) {
        this.ctx.logger.info(
          `context rollover: skipping handoff candidate ${read.path}: `
          + `${sizing.replacementTokens} estimated tokens >= ${sizing.shadowedRouteTokens} shadowed`,
        )
        continue
      }
      return { replacement, sizing }
    }
    const checkpoint: RolloverReplacement = {
      kind: 'checkpoint',
      checkpoint: {
        reason,
        windowNumber,
        notes: await this.renderNotes(session),
        handoff: null,
      },
    }
    const sizing = sizeRolloverReplacement({ meter: this.ctx.tokenMeter }, session, range, checkpoint)
    return sizing.fits ? { replacement: checkpoint, sizing } : null
  }

  /**
   * How this deployment selects the span one rollover replaces.
   *
   * The rule itself lives in `selectionFor` so the engine and the
   * `new_context` size preflight cannot disagree about which span a document is
   * priced against. `handoffOnly` is a distinct mode rather than
   * `retainTokens: 0`: a zero token budget still keeps the last surface node,
   * and walks further back for tool pairing, which is exactly the old-session
   * material the handoff-only contract forbids.
   * @param session - session whose configured tail budget is priced.
   * @returns the retention rule for this deployment.
   */
  private selection(session: Session): RolloverSelection {
    return selectionFor(this.config, session)
  }

  /**
   * The replacement content one rollover writes.
   *
   * The model names one durable handoff document, and that document's bytes
   * become the entire continuation context: no narration, no notes section and
   * no wrapper is added around it. The engine-driven paths (pressure,
   * overflow, manual) have no model in the loop and no document to read, so
   * they keep the deterministic notes checkpoint; ticket 05 teaches the
   * pressure path to prefer a scanned handoff document.
   * @param session - session whose window number is being started.
   * @param request - rollover reason and the handoff document text, when any.
   * @returns the replacement to commit.
   */
  private async replacementFor(
    session: Session,
    request: { reason: RolloverReason; handoff: string | null; handoffPath?: string },
  ): Promise<RolloverReplacement> {
    const windowNumber = countRollovers(session) + 1
    if (request.handoff !== null) {
      return {
        kind: 'handoff-document',
        windowNumber,
        text: request.handoff,
        ...request.handoffPath === undefined ? {} : { path: request.handoffPath },
      }
    }
    return {
      kind: 'checkpoint',
      checkpoint: {
        reason: request.reason,
        windowNumber,
        notes: await this.renderNotes(session),
        handoff: null,
      },
    }
  }

  /** Render the durable notes snapshot, or `null` when notes are disabled. */
  private async renderNotes(session: Session): Promise<string | null> {
    if (!this.config.notesEnabled) return null
    return this.notesStore(session).renderAll(this.config.handoffMaxChars)
  }

  /**
   * The session's open turn number, or `-1` when none is open (the guard key
   * then falls back to one-shot-per-call semantics).
   */
  private openTurnNumber(session: Session): number {
    for (let seq = session.seq - 1; seq >= 0; seq -= 1) {
      const event = sessionEventAt(session, seq)
      if (event === undefined) continue
      if (event.type === 'turn/start') return event.data.turn
      if (event.type === 'turn/end') return -1
    }
    return -1
  }

  /** Resolve the notes store for one session. */
  private notesStore(session: Session): NotesStore {
    return new NotesStore(NotesStore.directoryFor(session.id, this.config.notesDir))
  }

  /**
   * Whether another backend owns compaction for this agent's session.
   *
   * Sessions composed from an agent preset resolve `ctx.compaction` to that
   * preset's backend; the host engine then stands down everywhere (pressure,
   * overflow, manual) so exactly one backend acts per session. Rosterless
   * deployments (headless, base-only profiles) have no roster and this
   * backend stays active.
   * @param agent - agent whose composition to inspect.
   * @returns true when a different backend owns the session.
   */
  private compactionOwnedElsewhere(agent: Agent): boolean {
    const roster = rosterOf(this.ctx)
    if (roster === undefined) return false
    const owned = roster.serviceFor(agent, 'compaction')
    return owned !== undefined && concreteCompaction(owned) !== concreteCompaction(this)
  }

  /**
   * Compact when the model failed to manage context: pressure rolls over
   * above the threshold, while context overflow forces the same deterministic
   * reduction before retry.
   * @param agent - agent whose latest routed request is measured.
   * @param trigger - step-boundary pressure or provider-confirmed overflow.
   * @param signal - live turn cancellation signal.
   * @returns the rollover result, or `null` when no rollover was warranted.
   */
  override async compactIfNeeded(
    agent: Agent,
    trigger: CompactionTrigger,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    if (this.compactionOwnedElsewhere(agent)) return null
    if (trigger === 'context-overflow') {
      return this.performRollover(agent, { reason: 'overflow', handoff: null }, signal)
    }
    await this.rollOverOnPressure(agent, this.openTurnNumber(agent.session), signal)
    return null
  }

  /**
   * Manual rollover behind the `/compact` command: the same deterministic
   * notes checkpoint and the same retention rule as every other path, run
   * exclusively on an idle agent. No model is in the loop, so no handoff
   * document is named: this path composes notes.
   * @param agent - idle agent whose next-turn admission this call reserves.
   * @param signal - cancellation scoped to this rollover request.
   * @param sourceCommandId - initiating command identity for presentation.
   * @returns the committed result, or `null` when no safe useful range exists.
   */
  override compactNow(
    agent: Agent,
    signal: AbortSignal,
    sourceCommandId?: CommandId,
  ): Promise<CompactionResult | null> {
    signal.throwIfAborted()
    if (this.compactionOwnedElsewhere(agent)) {
      this.ctx.logger.info('context rollover skipped: session compaction is owned by its agent preset')
      return Promise.resolve(null)
    }
    const run = async (): Promise<CompactionResult | null> => {
      const session = agent.session
      const range = selectRolloverRange(
        session,
        this.ctx.tokenMeter.measure(session),
        this.selection(session),
      )
      if (range === null) return null
      const windowNumber = countRollovers(session) + 1
      return commitRollover(
        { meter: this.ctx.tokenMeter },
        session,
        range.start,
        range.end,
        {
          owner: null,
          ...(sourceCommandId === undefined ? {} : { sourceCommandId }),
          replacement: {
            kind: 'checkpoint',
            checkpoint: {
              reason: 'manual',
              windowNumber,
              notes: await this.renderNotes(session),
              handoff: null,
            },
          },
          flush: async () => {
            await this.ctx.sessions.flush(session)
          },
        },
      )
    }
    return this.runMaintained(agent, run, signal)
  }

  /**
   * Replace one inclusive surface-position span with a rollover checkpoint.
   * The caller names the span, so the retention rule does not apply; no model
   * is in the loop, so this path composes notes.
   * @param start - inclusive first surface-node seq.
   * @param end - inclusive last surface-node seq.
   * @param agent - owner of the target session.
   * @param signal - optional cancellation signal.
   * @returns the durable rollover result.
   */
  override async compactRegion(
    start: Seq,
    end: Seq,
    agent: Agent,
    signal?: AbortSignal,
  ): Promise<CompactionResult> {
    signal?.throwIfAborted()
    if (this.compactionOwnedElsewhere(agent)) {
      throw new Error('context rollover refused: session compaction is owned by its agent preset')
    }
    const session = agent.session
    const windowNumber = countRollovers(session) + 1
    return commitRollover(
      { meter: this.ctx.tokenMeter },
      session,
      start,
      end,
      {
        owner: 'current-turn',
        replacement: {
          kind: 'checkpoint',
          checkpoint: {
            reason: 'manual',
            windowNumber,
            notes: await this.renderNotes(session),
            handoff: null,
          },
        },
      },
    )
  }

  /**
   * Run one idle-agent task under `runMaintenance`, mapping cancellation to
   * the manual-failure code `/compact` presents.
   */
  private async runMaintained<T>(
    agent: Agent,
    task: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    try {
      return await agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          return await task()
        } catch (error: unknown) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError('cancelled', 'manual rollover was cancelled', { cause: error })
          }
          throw error
        }
      })
    } catch (error: unknown) {
      if (error instanceof ManualCompactionError) throw error
      throw new ManualCompactionError(
        'busy',
        'manual rollover requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }
}

export default ContextRolloverEngine
