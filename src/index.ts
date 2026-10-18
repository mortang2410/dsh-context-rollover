/**
 * Context-window rollover engine: the active `ctx.compaction` backend that
 * crosses context boundaries without summarization.
 *
 * Responsibilities stay split (the Codex lesson): the `new_context` tool only
 * requests a boundary, the pre-step / turn-stopping listeners decide when the
 * boundary is actually crossed, the token meter measures pressure and paces the
 * reminder (see claimReminder), and {@link commitRollover} performs the surface
 * replacement inside DSH's normal compaction transaction.
 *
 * @module dsh-context-rollover
 */

import { Context, symbols } from '@deepseek-ai/cordis'
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
import { Config as RolloverConfigSchema, renderReminderMessage, resolveConfig, rolloverPointsFor } from './config.ts'
import type { ReminderValues, RolloverConfig, ResolvedRolloverConfig } from './config.ts'
import type { RolloverReplacement } from './checkpoint.ts'
import { contextManagementGuidance } from './guidance.ts'
import { NotesStore } from './notes.ts'
import { sessionEventAt } from './compat.ts'
import {
  claimReminder,
  claimRolloverReminder,
  commitRollover,
  countRollovers,
  PLUGIN_NAME,
  REMINDER_SUMMARY_PREFIX,
  ROLLOVER_REMINDER_SUMMARY_PREFIX,
  selectRolloverRange,
  selectionFor,
} from './rollover.ts'
import type { RolloverSelection } from './rollover.ts'
import { checkpointCarriesNothing, replacementWindowNumber } from './checkpoint.ts'
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

export type { RolloverConfig, ResolvedRolloverConfig, ReminderValues } from './config.ts'
export {
  DEFAULT_HANDOFF_DIR,
  DEFAULT_HANDOFF_PATTERN,
  DEFAULT_REMINDER_MESSAGE,
  renderReminderMessage,
  resolveConfig,
} from './config.ts'
export { buildCheckpointText, buildReplacementText, checkpointCarriesNothing, replacementWindowNumber } from './checkpoint.ts'
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
export { CONTEXT_MANAGEMENT_GUIDANCE, contextManagementGuidance } from './guidance.ts'

/**
 * Summarization-free compaction backend: durable notes + handoff/recovery
 * checkpoint + token-budgeted recent verbatim tail.
 *
 * The model's own `new_context` request replaces the context with its handoff
 * document, and manual `/compact` composes the notes checkpoint. Pressure is
 * announced to the model: a cadence reminder at or above the handoff point, and
 * a hard reminder every turn at or above the rollover point. Crossing the
 * rollover point also logs one journal warning per turn while
 * `automaticRollover` is off, and with it on the engine commits the notes
 * checkpoint plus a recent tail at the next pre-step instead. A
 * provider-rejected overflow ends the turn with the provider's own error.
 */
export class ContextRolloverEngine extends CompactionEngine {
  static inject = ['llm', 'tokenMeter', 'sessions', 'tools', 'systemPrompt']

  /** The one configuration schema, defined beside {@link RolloverConfig}. */
  static Config = RolloverConfigSchema

  /** Resolved and validated configuration. */
  readonly config: ResolvedRolloverConfig

  private readonly pendingRollovers = new Map<string, PendingRollover>()
  /** Turns that already logged the above-rollover-point warning. */
  private readonly pressureWarnedTurns = new Set<string>()
  /** Turns that already committed one automatic rollover. */
  private readonly automaticRolledTurns = new Set<string>()

  constructor(ctx: Context, config: RolloverConfig = {}) {
    super(ctx)
    this.config = resolveConfig(config)
    // resolveConfig reads null as unset, so only a real value counts as set.
    // handoffOnly reads retainTokens but never retainRatio.
    if (this.config.handoffOnly && config.retainRatio !== undefined && config.retainRatio !== null) {
      ctx.logger.warn(
        'context-rollover: handoffOnly ignores retainRatio, so it has no effect; '
        + 'set retainTokens to keep a recent tail',
      )
    }
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
      // Composed from the resolved config: the section ships with every request,
      // so it must not promise an automatic rollover this row does not perform.
      text: contextManagementGuidance({ automaticRollover: this.config.automaticRollover }),
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
      // Whether this very pre-step committed a rollover, either the model's own
      // request or the engine's automatic safety net. A pre-step that crossed
      // the boundary has a fresh context and needs no hard reminder for that
      // step: the model just complied, or the engine already did the work the
      // reminder asks for. The flag is per pre-step, not per turn: a later step
      // of the same turn cannot commit again (one commit per turn) and does
      // remind.
      let crossedThisStep = false
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
            if (result !== null) {
              this.pendingRollovers.delete(agent.session.id)
              crossedThisStep = true
            }
          } else if (this.config.automaticRollover) {
            // No request is pending, so this is the engine's own safety net: at
            // or above the rollover point it crosses the boundary itself. A
            // deferral inside the attempt commits nothing and is retried at the
            // next pre-step, which is why it is not reported as a warning here:
            // the warning below belongs to the gate being off.
            crossedThisStep = await this.performAutomaticRollover(agent, turn, signal) !== null
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
      // The reminder names this engine's own tools, so a session whose
      // compaction another backend owns gets none from this row.
      if (this.compactionOwnedElsewhere(agent)) return decision
      const reminder = this.pendingReminder(agent.session, turn, Date.now(), crossedThisStep)
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
   * The model-visible reminder for this pre-step, when usage and the claim
   * gates allow one.
   *
   * The rollover point decides the branch, and that branch is terminal:
   * - at or above the rollover point, the hard
   *   {@link RolloverConfig.rolloverReminderMessage} with the measured figures
   *   filled in, claimed once per turn (see claimRolloverReminder). A pre-step
   *   that already committed a rollover (`crossedThisStep`) delivers no hard
   *   reminder: the engine did the work the order asks for, and the cadence
   *   text is not a substitute while the measurement is still at or above the
   *   rollover point, because its tokens-left line would read 0 in that state.
   *   If that commit brought the measurement back below the rollover point, the
   *   next branch delivers the cadence text with a positive tokens-left figure;
   * - below the rollover point and at or above the handoff point, the cadence
   *   {@link RolloverConfig.reminderMessage}, claimed on the configured
   *   `reminderRepeatMs` gap (see claimReminder).
   *
   * Both delivered texts are the same kind of message: a `user/message` with
   * the engine's notice source, appended to the `enter` decision the caller
   * returns, which is what puts them in the next model request. The handoff and
   * rollover points are what gate delivery; nothing about either text is
   * hardcoded here.
   * @param session - session whose latest routed request is measured.
   * @param turn - the turn of this pre-step, the hard reminder's claim key.
   * @param now - epoch milliseconds of this pre-step, read once by the caller.
   * @param crossedThisStep - whether this pre-step committed a rollover.
   */
  private pendingReminder(
    session: Session,
    turn: number,
    now: number,
    crossedThisStep: boolean,
  ): UserMessage | undefined {
    const route = session.requestContext()
    if (route?.contextWindow === undefined) return undefined
    const contextWindow = route.contextWindow
    const measurement = this.ctx.tokenMeter.measure(session)
    if (measurement.baseline.kind === 'none') return undefined
    const { reminderTokens, rolloverTokens } = rolloverPointsFor(this.config, contextWindow, route.model)
    const usedTokens = measurement.totalTokens
    const percent = Math.min(100, Math.round((usedTokens / contextWindow) * 100))
    const values = {
      percent,
      used_tokens: usedTokens,
      window_tokens: contextWindow,
      handoff_point_tokens: reminderTokens,
      rollover_point_tokens: rolloverTokens,
      tokens_to_rollover: Math.max(0, rolloverTokens - usedTokens),
    }
    if (usedTokens >= rolloverTokens) {
      if (crossedThisStep) return undefined
      // Claimed synchronously, like the cadence claim, so two engine rows that
      // observe one pre-step deliver one copy between them.
      if (!claimRolloverReminder(session, turn)) return undefined
      return this.noticeMessage(
        this.config.rolloverReminderMessage,
        values,
        `${ROLLOVER_REMINDER_SUMMARY_PREFIX} (${percent}% used)`,
      )
    }
    if (usedTokens < reminderTokens) return undefined
    // Claimed synchronously: on a preset deployment the host row and the
    // preset row both observe this pre-step, and neither delivery is in the
    // log yet when the second one decides.
    if (!claimReminder(session, now, this.config.reminderRepeatMs)) return undefined
    return this.noticeMessage(
      this.config.reminderMessage,
      values,
      `${REMINDER_SUMMARY_PREFIX} (${percent}% used)`,
    )
  }

  /**
   * One reminder message: the template with its placeholders filled, carrying
   * the engine's notice source so `isPressureReminder` and
   * `isRolloverReminder` can find it in the durable log.
   * @param template - the configured reminder text.
   * @param values - the measured figures for this model, one per placeholder.
   * @param summary - the one-line account, whose prefix names the reminder kind.
   */
  private noticeMessage(
    template: string,
    values: ReminderValues,
    summary: string,
  ): UserMessage {
    return createUserMessage({
      content: [{ type: 'text', text: renderReminderMessage(template, values) }],
      source: {
        kind: PLUGIN_NAME,
        form: 'notice',
        summary: boundContextSummary(summary),
      },
    })
  }

  /**
   * Pressure evaluation with the automatic rollover off: a journal warning
   * above the rollover point, once per turn.
   *
   * The warning is an operator signal, not the model's: the model is told by
   * the reminders (see pendingReminder), which the hard one repeats every turn
   * above this point. The warning stays because the log is where an operator
   * sees that a session crossed the point with the automatic rollover disabled.
   *
   * With no automatic rollover the model owns the handoff: only it knows which
   * document is its own, so above the rollover point the engine says so, once
   * per turn, and waits for the model's own `new_context` call. The warning is
   * reached only when {@link RolloverConfig.automaticRollover} is off, which is
   * what keeps its wording true. The automatic path commits the notes
   * checkpoint instead, and neither path reads a handoff file.
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
   * The automatic pressure rollover: the engine's own safety net at the
   * rollover point, with no model in the loop.
   *
   * It commits the deterministic notes checkpoint plus a recent verbatim tail,
   * floors that tail with {@link RolloverConfig.automaticRolloverRetainTokens}
   * so a row that keeps no tail still carries conversation into the new window,
   * and never reads a handoff file. It defers, committing nothing, when the
   * surface has no selectable span and when the checkpoint would carry neither
   * notes nor a tail; a deferral is retried at the next pre-step and does not
   * consume the turn's one commit.
   * @param agent - agent whose latest routed request is measured.
   * @param turn - the turn the measurement belongs to, for the once-per-turn rule.
   * @param signal - live turn cancellation signal.
   * @returns the compaction result, or `null` when this pre-step committed nothing.
   */
  private async performAutomaticRollover(
    agent: Agent,
    turn: number,
    signal: AbortSignal,
  ): Promise<CompactionResult | null> {
    const session = agent.session
    const route = session.requestContext()
    if (route?.contextWindow === undefined) return null
    const measurement = this.ctx.tokenMeter.measure(session)
    if (measurement.baseline.kind === 'none') return null
    const { rolloverTokens } = rolloverPointsFor(this.config, route.contextWindow, route.model)
    if (measurement.totalTokens < rolloverTokens) return null
    const key = turnKey(session.id, turn)
    if (this.automaticRolledTurns.has(key)) return null
    signal.throwIfAborted()
    const range = selectRolloverRange(session, measurement, this.automaticSelection(session))
    if (range === null) {
      this.ctx.logger.info(
        'context rollover deferred: no compactable surface span for the automatic rollover yet; '
        + 'retrying at the next pre-step',
      )
      return null
    }
    // An empty checkpoint is worse than a deferral, but empty notes alone are
    // fine: the retained tail carries the continuation, and a session that
    // complied already wrote its handoff into the notes snapshot.
    const lastNode = session.surface.nodes[session.surface.nodes.length - 1]
    const keepsTail = lastNode !== undefined && range.end !== lastNode
    const notes = await this.renderNotes(session)
    if (checkpointCarriesNothing(notes, keepsTail)) {
      this.ctx.logger.info(
        'context rollover deferred: the automatic checkpoint would carry neither notes nor a recent tail; '
        + 'retrying at the next pre-step',
      )
      return null
    }
    const windowNumber = countRollovers(session) + 1
    const result = await commitRollover(
      { meter: this.ctx.tokenMeter },
      session,
      range.start,
      range.end,
      {
        owner: 'current-turn',
        replacement: {
          kind: 'checkpoint',
          checkpoint: { reason: 'automatic', windowNumber, notes, handoff: null },
        },
      },
    )
    // Only a committed rollover consumes the turn: every deferral above retries
    // at the next pre-step of the same turn.
    this.automaticRolledTurns.add(key)
    this.ctx.logger.info(
      `context rollover (automatic): window ${windowNumber} started; `
      + `shadowed ${result.shadowedSeqs.length} surface nodes (~${result.shadowedTokenCount} tokens)`,
    )
    return result
  }

  /**
   * The automatic path's retention rule: the configured tail budget, raised to
   * the automatic floor.
   *
   * The floor is the automatic path's own key, read only here, so a row that
   * keeps no tail (`retainTokens: 0`, or `handoffOnly` with no `retainTokens`)
   * cannot leave an automatic rollover with nothing of the conversation in the
   * new window. `selectionFor` is untouched, so the manual and model-requested
   * paths keep their configured rule.
   * @param session - session whose configured tail budget is priced.
   * @returns the retention rule the automatic rollover uses.
   */
  private automaticSelection(session: Session): RolloverSelection {
    const configured = this.selection(session)
    const configuredTokens = configured.kind === 'tail' ? configured.retainTokens : 0
    return {
      kind: 'tail',
      retainTokens: Math.max(configuredTokens, this.config.automaticRolloverRetainTokens),
    }
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
   * priced against. Without `retainTokens`, `handoffOnly` is a distinct mode
   * rather than `retainTokens: 0`: a zero token budget still keeps the last
   * surface node, and walks further back for tool pairing, which is exactly the
   * old-session material that mode drops.
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
   * become the continuation context: no narration, no notes section and
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
   * Automatic-compaction entry point, which never rolls over. With
   * `automaticRollover` off, a pressure trigger above the rollover point logs
   * one warning per turn, because the model owns the handoff. With it on, the
   * pre-step listener is the path that commits, and this entry point stays
   * silent so the "automatic rollover is disabled" warning is never logged while
   * it is enabled. A context-overflow trigger does nothing here, so the
   * provider's error reaches the turn unchanged.
   * @param agent - agent whose latest routed request is measured.
   * @param trigger - step-boundary pressure or provider-confirmed overflow.
   * @returns always `null`: no rollover is performed from this entry point.
   */
  override async compactIfNeeded(agent: Agent, trigger: CompactionTrigger): Promise<CompactionResult | null> {
    if (this.compactionOwnedElsewhere(agent)) return null
    if (trigger === 'pressure' && !this.config.automaticRollover) {
      this.warnAboveRolloverPoint(agent, this.openTurnNumber(agent.session))
    }
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
   * the manual-failure code `/compact` presents. A failure inside the task
   * reaches the caller unchanged; only an agent that never became idle maps to
   * `busy`.
   */
  private async runMaintained<T>(
    agent: Agent,
    task: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    const progress = { started: false }
    try {
      return await agent.runMaintenance(async (agentSignal) => {
        const operationSignal = AbortSignal.any([agentSignal, signal])
        try {
          operationSignal.throwIfAborted()
          progress.started = true
          return await task()
        } catch (error: unknown) {
          if (agentSignal.aborted && operationSignal.reason === agentSignal.reason) {
            throw new ManualCompactionError('cancelled', 'manual rollover was cancelled', { cause: error })
          }
          throw error
        }
      })
    } catch (error: unknown) {
      if (error instanceof ManualCompactionError || progress.started) throw error
      throw new ManualCompactionError(
        'busy',
        'manual rollover requires an idle agent with no waking queued work',
        { cause: error },
      )
    }
  }
}

export default ContextRolloverEngine
