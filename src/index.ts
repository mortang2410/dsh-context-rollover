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
import { boundContextSummary, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
// Type-only: makes the optional sibling service available to `ctx.get()`, and
// loads the system-prompt Context merge for the `ctx.systemPrompt` key.
import type {} from '@deepseek-ai/dsh-compaction-tool-result-pruner'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { Seq } from './compat.ts'
import { renderReminderMessage, resolveConfig, rolloverPointsFor } from './config.ts'
import type { RolloverConfig, ResolvedRolloverConfig } from './config.ts'
import type { RolloverReplacement } from './checkpoint.ts'
import { CONTEXT_MANAGEMENT_GUIDANCE } from './guidance.ts'
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
} from './rollover.ts'
import type { RolloverSelection } from './rollover.ts'
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
  readHandoffFile,
  readHandoffFileOrThrow,
  resolveHandoffPath,
} from './handoff.ts'
export type {
  HandoffFailure,
  HandoffFailureReason,
  HandoffReadRequest,
  HandoffResult,
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
 * checkpoint + token-budgeted recent verbatim tail. The only rollovers are the
 * model's own `new_context` request, which replaces context with its handoff
 * document, and manual `/compact`, which composes the notes checkpoint. The
 * engine never rolls over by itself: crossing the rollover point by pressure
 * only warns, and a provider-rejected overflow ends the turn with the
 * provider's own error.
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
    modelThresholds: z.dict(z.object({
      thresholdTokens: z.number().step(1).min(1),
      reminderThresholdTokens: z.number().step(1).min(1),
    })),
  })

  /** Resolved and validated configuration. */
  readonly config: ResolvedRolloverConfig

  private readonly pendingRollovers = new Map<string, PendingRollover>()
  /** Turns that already logged the above-rollover-point warning. */
  private readonly pressureWarnedTurns = new Set<string>()

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

  /** Register the pending-rollover and pressure lifecycle listeners. */
  private registerLifecycle(): void {
    const { ctx } = this

    // Cross the boundary before the next model request when the model asked
    // for it, then fall through to the pressure evaluation.
    ctx.on('agent/pre-step', async (
      { agent, turn, signal },
      next,
    ): Promise<PreStepDecision> => {
      // A preset-owned session belongs to that preset's backend. Without this
      // guard, the host engine would also log its pressure warning and commit
      // any pending handoff rollover into that session.
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
              handoff: pendingHandoff(pending),
              handoffPath: pending.handoffPath,
            }, signal)
            if (result !== null) this.pendingRollovers.delete(agent.session.id)
          } else {
            this.warnAboveRolloverPoint(agent, turn)
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
      try {
        // Same rule as the pre-step path: the request is cleared only once it
        // has been honoured. This event fires once per turn, so clearing a
        // request that deferred here would lose it for good rather than
        // retrying; leaving it pending lets the next turn's pre-step cross.
        const result = await this.performRollover(agent, {
          handoff: pendingHandoff(pending),
          handoffPath: pending.handoffPath,
        }, signal)
        if (result !== null) this.pendingRollovers.delete(agent.session.id)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`context rollover at turn stop failed: ${message}`)
      }
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
    const route = session.requestContext()
    if (route?.contextWindow === undefined) return undefined
    const contextWindow = route.contextWindow
    const measurement = this.ctx.tokenMeter.measure(session)
    if (measurement.baseline.kind === 'none') return undefined
    const { reminderTokens } = rolloverPointsFor(this.config, contextWindow, route.model)
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
   * Pressure evaluation: one reminder per window below the rollover point, and
   * a warning above it. The engine never rolls over on pressure by itself.
   *
   * An automatic rollover has no model to name its handoff, so it could only
   * take the newest handoff file in a shared directory, which may belong to a
   * different session. The model is the only party that knows which handoff is
   * its own, so above the rollover point the engine says so, once per turn, and
   * waits for the model's own `new_context` call.
   * @param agent - agent whose latest routed request is measured.
   * @param turn - the turn the measurement belongs to, for the once-per-turn warning.
   */
  private warnAboveRolloverPoint(agent: Agent, turn: number): void {
    const route = agent.session.requestContext()
    if (route?.contextWindow === undefined) return
    const measurement = this.ctx.tokenMeter.measure(agent.session)
    if (measurement.baseline.kind === 'none') return
    const { rolloverTokens } = rolloverPointsFor(this.config, route.contextWindow, route.model)
    if (measurement.totalTokens < rolloverTokens) return
    const key = turnKey(agent.session.id, turn)
    if (this.pressureWarnedTurns.has(key)) return
    this.pressureWarnedTurns.add(key)
    this.ctx.logger.warn(
      'context rollover: usage is above the rollover point, and automatic rollover is disabled; '
      + 'the model must write its handoff document and call new_context',
    )
  }

  /**
   * Perform one model-requested rollover: select the replacement range, make
   * the model's handoff document the replacement, and commit the compaction
   * transaction.
   * @param agent - agent whose session surface is rolled over.
   * @param request - the handoff document the model named, already read.
   * @param signal - live turn cancellation signal.
   * @returns the compaction result, or `null` when no useful range exists.
   */
  private async performRollover(
    agent: Agent,
    request: { handoff: string; handoffPath: string },
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
    // The transaction's own shrink guard refuses a replacement that is not
    // smaller than the selected span, so a refused handoff leaves the context
    // unchanged and surfaces as the caller's logged failure.
    const replacement = this.replacementFor(session, request)
    const windowNumber = replacementWindowNumber(replacement)
    const result = await commitRollover(
      { meter: this.ctx.tokenMeter },
      session,
      range.start,
      range.end,
      { owner: 'current-turn', replacement },
    )
    this.ctx.logger.info(
      `context rollover (model-requested): window ${windowNumber} started; `
      + `shadowed ${result.shadowedSeqs.length} surface nodes (~${result.shadowedTokenCount} tokens)`,
    )
    return result
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
   * The replacement content one model-requested rollover writes.
   *
   * The model names one durable handoff document, and that document's bytes
   * become the entire continuation context: no narration, no notes section and
   * no wrapper is added around it. Manual `/compact` never reaches this method.
   * It has no model in the loop and no document to name, so it composes the
   * deterministic notes checkpoint itself.
   * @param session - session whose window number is being started.
   * @param request - the handoff document text and the path it was read from.
   * @returns the replacement to commit.
   */
  private replacementFor(
    session: Session,
    request: { handoff: string; handoffPath: string },
  ): RolloverReplacement {
    return {
      kind: 'handoff-document',
      windowNumber: countRollovers(session) + 1,
      text: request.handoff,
      path: request.handoffPath,
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
   * manual) so exactly one backend acts per session. Rosterless
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
   * Automatic-compaction entry point, which never rolls over. Above the
   * rollover point a pressure trigger logs one warning per turn, because the
   * model owns the handoff. A context-overflow trigger does nothing here, so
   * the provider's error reaches the turn unchanged.
   * @param agent - agent whose latest routed request is measured.
   * @param trigger - step-boundary pressure or provider-confirmed overflow.
   * @returns always `null`: no rollover is performed from this entry point.
   */
  override async compactIfNeeded(agent: Agent, trigger: CompactionTrigger): Promise<CompactionResult | null> {
    if (this.compactionOwnedElsewhere(agent)) return null
    if (trigger === 'pressure') this.warnAboveRolloverPoint(agent, this.openTurnNumber(agent.session))
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
   * Always refuses: a caller-named span would roll the context over without the
   * model's own `new_context` call, which is the only handoff rollover. The
   * parameters are unused; the override exists to satisfy the abstract base
   * method.
   * @throws always, with the forced span compaction refusal message.
   */
  override async compactRegion(
    _start: Seq,
    _end: Seq,
    _agent: Agent,
    _signal?: AbortSignal,
  ): Promise<CompactionResult> {
    throw new Error(
      'context rollover refused: forced span compaction is disabled; '
      + 'the model\'s own new_context call is the only handoff rollover',
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
