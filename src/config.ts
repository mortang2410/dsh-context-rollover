/**
 * Plugin configuration: validated once at load, resolved against model context
 * windows at runtime. Ratios scale defaults across models; absolute overrides
 * stay available for stable experiments.
 *
 * @module dsh-context-rollover/config
 */

import z from '@deepseek-ai/schemastery'

/**
 * The shipped cadence reminder text: the absolute numbers for the routed model,
 * then the model's instruction to write the durable handoff and cross the
 * boundary. It repeats no sooner than `reminderRepeatMs` apart while usage
 * stays at or above the handoff point and below the rollover point. At or above
 * the rollover point {@link DEFAULT_ROLLOVER_REMINDER_MESSAGE} is the text the
 * model reads, and a pre-step that committed a rollover carries no hard
 * reminder. That step carries this cadence text only when the commit brought
 * the measurement back below the rollover point, so this text is never
 * delivered with nothing left before the point.
 *
 * Placeholders, filled at send time from {@link ReminderValues}:
 * - `{percent}`: tokens used as a percent of the routed model's context window.
 * - `{used_tokens}`: tokens used by the latest measured request.
 * - `{window_tokens}`: the routed model's context window, in tokens.
 * - `{handoff_point_tokens}`: the handoff point, where reminders start.
 * - `{rollover_point_tokens}`: the rollover point, where the hard per-turn
 *   reminder starts and the automatic rollover commits when
 *   {@link RolloverConfig.automaticRollover} is on.
 * - `{tokens_to_rollover}`: tokens left before the rollover point, never below 0.
 *
 * Any other `{...}` text is not a placeholder and is delivered verbatim. A
 * deployment that restates the value takes over the wording entirely.
 */
export const DEFAULT_REMINDER_MESSAGE =
  'Context is {percent}% full. {used_tokens} of {window_tokens} tokens are used. '
  + 'The percent is measured against the whole window of this model, so a low percent on a large window is expected. '
  + 'The handoff point, where these reminders start, is {handoff_point_tokens} tokens. '
  + 'The rollover point is {rollover_point_tokens} tokens, leaving {tokens_to_rollover} tokens before the rollover point. '
  + 'Crossing the rollover point is not silent: the engine sends a hard reminder every turn from there, '
  + 'and with `automaticRollover` on it rolls the context over by itself. '
  + 'Run `/handoff-doc` (the `handoff-doc` skill) to create/update the durable handoff document. '
  + 'Make it fully sufficient for a fresh context to continue the work. After it succeeds, call '
  + '`new_context` with the path of that document as `handoff_path`. The handoff document, plus any recent '
  + 'chat kept after the rollover, will be the continuation context.'

/**
 * The shipped hard reminder text: the order delivered once per turn at or above
 * the rollover point, whatever the cadence, until the model crosses the
 * boundary itself.
 *
 * Placeholders are the {@link ReminderValues} names, filled at send time; this
 * text uses `{percent}`, `{used_tokens}`, `{window_tokens}` and
 * `{rollover_point_tokens}`. Any other `{...}` text is delivered verbatim.
 */
export const DEFAULT_ROLLOVER_REMINDER_MESSAGE =
  'You are at or above the rollover point: {used_tokens} of {window_tokens} tokens are used, '
  + '{percent}% of the window, and the rollover point is {rollover_point_tokens} tokens. '
  + 'This is the final order and it repeats every turn until you comply: stop the current task now, '
  + 'write the handoff document with `/handoff-doc` (the `handoff-doc` skill), make it fully sufficient '
  + 'for a fresh context to continue the work, and call `new_context` with the path of that document as '
  + '`handoff_path`. Start no other work before that call. If you do not roll over, the engine rolls over '
  + 'for you when `automaticRollover` is on, keeping only the notes snapshot and a recent tail, so '
  + 'anything you left out of the handoff is lost.'

/**
 * The shipped minimum gap between two cadence reminders in one window, in
 * milliseconds: the default of the `reminderRepeatMs` configuration key.
 */
export const DEFAULT_REMINDER_REPEAT_MS = 5 * 60 * 1000

/** Default base directory, relative to the session working directory, holding durable handoffs. */
export const DEFAULT_HANDOFF_DIR = '.scratch/handoff'

/** Default glob for durable handoff files inside {@link DEFAULT_HANDOFF_DIR}. */
export const DEFAULT_HANDOFF_PATTERN = 'HANDOFF-*.md'

/**
 * The figures a reminder template can name. Each key is a placeholder:
 * `{percent}` stands for `percent`, and so on. {@link DEFAULT_REMINDER_MESSAGE}
 * documents what each one means.
 */
export interface ReminderValues {
  /** Tokens used as a percent of the context window, already rounded and capped at 100. */
  readonly percent: number
  /** Tokens used by the latest measured request. */
  readonly used_tokens: number
  /** The routed model's context window, in tokens. */
  readonly window_tokens: number
  /** The handoff point for the routed model, in tokens. */
  readonly handoff_point_tokens: number
  /** The rollover point for the routed model, in tokens. */
  readonly rollover_point_tokens: number
  /** Tokens left before the rollover point, never below 0. */
  readonly tokens_to_rollover: number
}

/**
 * Substitute the measured figures into a reminder template.
 *
 * Only the {@link ReminderValues} names are placeholders. This is deliberately
 * not a template language: an unknown placeholder survives verbatim rather than
 * silently expanding to nothing.
 * @param template - configured reminder text.
 * @param values - the measured figures for this model, one per placeholder.
 * @returns the text to deliver as the reminder.
 */
export function renderReminderMessage(template: string, values: ReminderValues): string {
  let text = template
  for (const [name, value] of Object.entries(values)) {
    text = text.replaceAll(`{${name}}`, String(value))
  }
  return text
}

/** Model-facing configuration surface for the rollover engine. */
export interface RolloverConfig {
  /**
   * Rollover point as a fraction of the routed model's context window.
   * Defaults to `0.9`.
   *
   * What crossing it does depends on {@link automaticRollover}. With that off
   * (the default) it logs one warning per turn and commits nothing, because
   * only the model can write the handoff a rollover needs; the only rollovers
   * are then the model's own `new_context` call and manual `/compact`. With it
   * on, the engine also rolls over by itself at the next pre-step. A
   * provider-rejected overflow does not roll over either way.
   */
  thresholdRatio?: number
  /**
   * Roll the context over by itself at the rollover point, whether or not the
   * model complied. Defaults to `false`, and off means nothing changes.
   *
   * With it on, the `agent/pre-step` listener commits the deterministic notes
   * checkpoint plus a recent verbatim tail once measured usage is at or above
   * the rollover point, with no model in the loop, no summarizer call, and no
   * handoff file read. It is a safety net, not a substitute for the model's own
   * handoff: the checkpoint carries the model's handoff document when the model
   * wrote one into the notes tool, and the notes snapshot when it did not.
   */
  automaticRollover?: boolean
  /**
   * Recent verbatim tail, in tokens, that the automatic rollover always keeps,
   * whatever {@link retainTokens} or {@link handoffOnly} says. Defaults to
   * `10000`. Read only by the automatic path, as that path's own tail floor, so
   * a row that keeps no tail (`retainTokens: 0`) cannot leave the automatic
   * rollover with no carry-over at all. The manual and model-requested paths
   * never read it.
   */
  automaticRolloverRetainTokens?: number
  /**
   * Handoff-reminder point as a fraction of the context window, well
   * below {@link thresholdRatio} so the handoff is written while there is
   * still room for it. Defaults to `0.4`.
   */
  reminderThresholdRatio?: number
  /**
   * Text of the cadence reminder, repeated no sooner than
   * {@link reminderRepeatMs} apart while usage stays below the rollover point.
   * Its placeholders are listed at {@link DEFAULT_REMINDER_MESSAGE} and are
   * filled at send time; any other `{...}` text is left as written. Defaults to
   * {@link DEFAULT_REMINDER_MESSAGE}.
   */
  reminderMessage?: string
  /**
   * Minimum wall-clock gap between two cadence reminders in one window, in
   * milliseconds. Defaults to `300000` (five minutes), the shipped value in
   * {@link DEFAULT_REMINDER_REPEAT_MS}. The hard
   * {@link rolloverReminderMessage} does not read it: that reminder is claimed
   * once per turn, not on a cadence.
   */
  reminderRepeatMs?: number
  /**
   * Text of the hard reminder, delivered to the model once per turn at or above
   * the rollover point whatever the cadence says, until the model crosses the
   * boundary. Its placeholders are the {@link ReminderValues} names and are
   * filled at send time; any other `{...}` text is left as written. Defaults to
   * {@link DEFAULT_ROLLOVER_REMINDER_MESSAGE}.
   */
  rolloverReminderMessage?: string
  /**
   * Recent verbatim tail retained across a rollover, as a fraction of the
   * context window. Defaults to `0.1`. Not read when `handoffOnly` is set.
   */
  retainRatio?: number
  /**
   * Absolute recent-tail budget in tokens; overrides `retainRatio` when set.
   * Under `handoffOnly` it sets the tail the handoff document leads.
   */
  retainTokens?: number
  /**
   * Replace the whole prior surface with the handoff document. Defaults to
   * `false`.
   *
   * With `retainTokens` unset, nothing of the prior surface is kept: the
   * replaced span runs from the first non-`system/message` node through the
   * last surface node, and only when the cut after that node is tool-pairing
   * balanced. A pre-step whose tail cut is unbalanced (a tool call with no
   * result yet) selects nothing and defers to the next pre-step rather than
   * retaining the incomplete unit.
   *
   * With `retainTokens` set, the handoff document leads the recent tail that
   * budget selects, by the same rule tail mode uses. `retainRatio` is not read
   * under this flag.
   */
  handoffOnly?: boolean
  /** Maximum accepted handoff document size in characters. Defaults to `20000`. */
  handoffMaxChars?: number
  /** Mount the `notes` tool and render notes into rollover checkpoints. */
  notesEnabled?: boolean
  /** Mount the `history` tool. */
  historyEnabled?: boolean
  /** Base directory for note files; defaults to `<dsh home>/notes/<session id>`. */
  notesDir?: string
  /**
   * Directory where the `/handoff-doc` skill writes durable handoff documents,
   * resolved against the session working directory. No engine path reads it: a
   * handoff is always the path the model names. Accepted so that existing
   * presets and profiles keep validating.
   */
  handoffDir?: string
  /**
   * File-name pattern for handoff documents inside {@link handoffDir}. Accepted
   * for configuration compatibility; no engine path reads it.
   */
  handoffPattern?: string
  /**
   * Model-surface registration: `auto` registers tools and guidance only
   * where no preset roster exists (the host row), while `always` registers
   * them unconditionally (the preset row, which owns its composition).
   * Defaults to `auto`.
   */
  modelSurface?: 'auto' | 'always'
  /**
   * Absolute rollover points keyed by routed model id (the session's
   * `RequestContext.model`). An entry replaces the ratio-based reminder and
   * rollover points for that model only; every other model keeps the ratios.
   */
  modelThresholds?: Record<string, ModelThresholds>
}

/** Absolute token points for one routed model, replacing its ratio-based points. */
export interface ModelThresholds {
  /** Rollover point in tokens; the engine rolls over here only with `automaticRollover` on. */
  thresholdTokens: number
  /** Reminder point in tokens; must not exceed {@link thresholdTokens}. */
  reminderThresholdTokens: number
}

/** Schemastery validation for {@link RolloverConfig}. */
export const Config: z<RolloverConfig> = z.object({
  thresholdRatio: z.number(),
  automaticRollover: z.boolean(),
  automaticRolloverRetainTokens: z.number().step(1).min(1),
  reminderThresholdRatio: z.number(),
  reminderMessage: z.string(),
  reminderRepeatMs: z.number().step(1).min(1),
  rolloverReminderMessage: z.string(),
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

/** Resolved and validated rollover configuration. */
export interface ResolvedRolloverConfig {
  readonly thresholdRatio: number
  /** Roll the context over by itself at the rollover point; off changes nothing. */
  readonly automaticRollover: boolean
  /** Tail floor, in tokens, the automatic rollover keeps whatever `retainTokens` says. */
  readonly automaticRolloverRetainTokens: number
  readonly reminderThresholdRatio: number
  readonly reminderMessage: string
  /** Minimum gap between two cadence reminders in one window, in milliseconds. */
  readonly reminderRepeatMs: number
  /** Hard per-turn reminder delivered at or above the rollover point. */
  readonly rolloverReminderMessage: string
  readonly retainRatio: number
  /** `null` keeps the ratio-based tail budget. */
  readonly retainTokens: number | null
  /** Replace the whole prior surface with the handoff document; keep no tail unless `retainTokens` is set. */
  readonly handoffOnly: boolean
  readonly handoffMaxChars: number
  readonly notesEnabled: boolean
  readonly historyEnabled: boolean
  readonly notesDir: string | undefined
  readonly handoffDir: string
  readonly handoffPattern: string
  readonly modelSurface: 'auto' | 'always'
  /** Absolute points per routed model id; an empty map keeps the ratios for every model. */
  readonly modelThresholds: Readonly<Record<string, ModelThresholds>>
}

/** Reject a ratio that cannot represent a fraction of a context window. */
function validateRatio(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new TypeError(`context-rollover: ${name} must be in (0, 1], got ${String(value)}`)
  }
}

/** Reject a blank string where the engine needs a usable value. */
function validateNonEmptyString(name: string, value: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`context-rollover: ${name} must be a non-empty string, got ${JSON.stringify(value)}`)
  }
}

/** Reject a token point that is not a positive integer. */
function validateTokenCount(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`context-rollover: ${name} must be a positive integer, got ${String(value)}`)
  }
}

/**
 * Validate and fill configuration defaults. Invalid values fail plugin load
 * (misconfiguration fails loud).
 * @param config - raw configuration from the plugin's cordis.yml row.
 * @returns the resolved configuration.
 */
export function resolveConfig(config: RolloverConfig): ResolvedRolloverConfig {
  const thresholdRatio = config.thresholdRatio ?? 0.9
  const reminderThresholdRatio = config.reminderThresholdRatio ?? 0.4
  const retainRatio = config.retainRatio ?? 0.1
  validateRatio('thresholdRatio', thresholdRatio)
  validateRatio('reminderThresholdRatio', reminderThresholdRatio)
  validateRatio('retainRatio', retainRatio)
  if (reminderThresholdRatio > thresholdRatio) {
    throw new TypeError(
      `context-rollover: reminderThresholdRatio (${reminderThresholdRatio}) must not exceed `
      + `thresholdRatio (${thresholdRatio})`,
    )
  }
  const automaticRollover = config.automaticRollover ?? false
  if (typeof automaticRollover !== 'boolean') {
    throw new TypeError(`context-rollover: automaticRollover must be a boolean, got ${String(automaticRollover)}`)
  }
  const automaticRolloverRetainTokens = config.automaticRolloverRetainTokens ?? 10000
  if (!Number.isSafeInteger(automaticRolloverRetainTokens) || automaticRolloverRetainTokens <= 0) {
    throw new TypeError(
      'context-rollover: automaticRolloverRetainTokens must be a positive integer, '
      + `got ${String(automaticRolloverRetainTokens)}`,
    )
  }
  const reminderMessage = config.reminderMessage ?? DEFAULT_REMINDER_MESSAGE
  validateNonEmptyString('reminderMessage', reminderMessage)
  const reminderRepeatMs = config.reminderRepeatMs ?? DEFAULT_REMINDER_REPEAT_MS
  if (!Number.isSafeInteger(reminderRepeatMs) || reminderRepeatMs <= 0) {
    throw new TypeError(`context-rollover: reminderRepeatMs must be a positive integer, got ${String(reminderRepeatMs)}`)
  }
  const rolloverReminderMessage = config.rolloverReminderMessage ?? DEFAULT_ROLLOVER_REMINDER_MESSAGE
  validateNonEmptyString('rolloverReminderMessage', rolloverReminderMessage)
  const handoffDir = config.handoffDir ?? DEFAULT_HANDOFF_DIR
  validateNonEmptyString('handoffDir', handoffDir)
  const handoffPattern = config.handoffPattern ?? DEFAULT_HANDOFF_PATTERN
  validateNonEmptyString('handoffPattern', handoffPattern)
  const retainTokens = config.retainTokens ?? null
  if (retainTokens !== null && (!Number.isSafeInteger(retainTokens) || retainTokens < 0)) {
    throw new TypeError(`context-rollover: retainTokens must be a non-negative integer, got ${String(retainTokens)}`)
  }
  const handoffOnly = config.handoffOnly ?? false
  if (typeof handoffOnly !== 'boolean') {
    throw new TypeError(`context-rollover: handoffOnly must be a boolean, got ${String(handoffOnly)}`)
  }
  const handoffMaxChars = config.handoffMaxChars ?? 20000
  if (!Number.isSafeInteger(handoffMaxChars) || handoffMaxChars <= 0) {
    throw new TypeError(`context-rollover: handoffMaxChars must be a positive integer, got ${String(handoffMaxChars)}`)
  }
  const modelSurface = config.modelSurface ?? 'auto'
  if (modelSurface !== 'auto' && modelSurface !== 'always') {
    throw new TypeError(
      `context-rollover: modelSurface must be 'auto' or 'always', got ${String(modelSurface)}`,
    )
  }
  const modelThresholds = config.modelThresholds ?? {}
  for (const [model, points] of Object.entries(modelThresholds)) {
    validateNonEmptyString('modelThresholds key', model)
    validateTokenCount(`modelThresholds[${model}].thresholdTokens`, points.thresholdTokens)
    validateTokenCount(`modelThresholds[${model}].reminderThresholdTokens`, points.reminderThresholdTokens)
    if (points.reminderThresholdTokens > points.thresholdTokens) {
      throw new TypeError(
        `context-rollover: modelThresholds[${model}].reminderThresholdTokens (${points.reminderThresholdTokens}) `
        + `must not exceed thresholdTokens (${points.thresholdTokens})`,
      )
    }
  }
  return {
    thresholdRatio,
    automaticRollover,
    automaticRolloverRetainTokens,
    reminderThresholdRatio,
    reminderMessage,
    reminderRepeatMs,
    rolloverReminderMessage,
    retainRatio,
    retainTokens,
    handoffOnly,
    handoffMaxChars,
    notesEnabled: config.notesEnabled ?? true,
    historyEnabled: config.historyEnabled ?? true,
    notesDir: config.notesDir,
    handoffDir,
    handoffPattern,
    modelSurface,
    modelThresholds,
  }
}

/** The reminder and rollover token points that apply to one routed model. */
export interface RolloverPoints {
  readonly reminderTokens: number
  readonly rolloverTokens: number
}

/**
 * Resolve the reminder and rollover points for the model a session is routed
 * to. A model with a `modelThresholds` entry uses that entry's absolute tokens.
 * Every other model derives both points from its own context window.
 * @param config - resolved configuration.
 * @param contextWindow - the routed model's advertised context window.
 * @param model - the routed model id, as the session's request context reports it.
 * @returns the reminder and rollover token points.
 */
export function rolloverPointsFor(
  config: ResolvedRolloverConfig,
  contextWindow: number,
  model: string,
): RolloverPoints {
  // `hasOwn`, not a bracket read: a model named like an Object.prototype key
  // must not pick up an inherited value.
  const entry = Object.hasOwn(config.modelThresholds, model) ? config.modelThresholds[model] : undefined
  if (entry !== undefined) {
    return { reminderTokens: entry.reminderThresholdTokens, rolloverTokens: entry.thresholdTokens }
  }
  return {
    reminderTokens: Math.floor(contextWindow * config.reminderThresholdRatio),
    rolloverTokens: Math.floor(contextWindow * config.thresholdRatio),
  }
}
