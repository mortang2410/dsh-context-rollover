/**
 * Plugin configuration: validated once at load, resolved against model context
 * windows at runtime. Ratios scale defaults across models; absolute overrides
 * stay available for stable experiments.
 *
 * @module dsh-context-rollover/config
 */

import z from '@deepseek-ai/schemastery'

/**
 * The shipped reminder text: the model's one-per-window instruction to write
 * the durable handoff and then cross the boundary.
 *
 * `{percent}` is the only placeholder. A deployment that restates the value
 * takes over the wording entirely; the engine substitutes nothing else.
 */
export const DEFAULT_REMINDER_MESSAGE =
  'Context is {percent}% full. Use `/handoff-doc` to create/update the durable handoff document. '
  + 'Make it fully sufficient for a fresh context to continue the work. After it succeeds, call '
  + '`new_context`. The handoff document will be the entire continuation context.'

/** Default base directory, relative to the session working directory, holding durable handoffs. */
export const DEFAULT_HANDOFF_DIR = '.scratch/handoff'

/** Default glob for durable handoff files inside {@link DEFAULT_HANDOFF_DIR}. */
export const DEFAULT_HANDOFF_PATTERN = 'HANDOFF-*.md'

/**
 * Substitute the measured percentage into a reminder template.
 *
 * `{percent}` is deliberately the only placeholder: this is not a template
 * language, so an unknown placeholder survives verbatim rather than silently
 * expanding to nothing.
 * @param template - configured reminder text.
 * @param percent - measured percentage of the context window, already rounded.
 * @returns the text to deliver as the reminder.
 */
export function renderReminderMessage(template: string, percent: number): string {
  return template.replaceAll('{percent}', String(percent))
}

/** Model-facing configuration surface for the rollover engine. */
export interface RolloverConfig {
  /**
   * Rollover point as a fraction of the routed model's context window.
   * Defaults to `0.9`.
   *
   * Crossing it does not roll the context over by itself. It logs one warning
   * per turn, because only the model can write the handoff a rollover needs.
   * The model's own `new_context` call still rolls over, and a provider-rejected
   * overflow still rolls over to notes.
   */
  thresholdRatio?: number
  /**
   * One-time handoff-reminder point as a fraction of the context window, well
   * below {@link thresholdRatio} so the handoff is written while there is
   * still room for it. Defaults to `0.4`.
   */
  reminderThresholdRatio?: number
  /**
   * Text of the one-per-window reminder. `{percent}` is substituted with the
   * measured percentage at send time and is the only placeholder.
   * Defaults to {@link DEFAULT_REMINDER_MESSAGE}.
   */
  reminderMessage?: string
  /**
   * Recent verbatim tail retained across a rollover, as a fraction of the
   * context window. Defaults to `0.1`.
   */
  retainRatio?: number
  /**
   * Absolute recent-tail budget in tokens; overrides `retainRatio` when set.
   */
  retainTokens?: number
  /**
   * Replace the whole prior surface with the handoff document, keeping no
   * priced recent tail at all. Defaults to `false`.
   *
   * This is deliberately NOT `retainTokens: 0`: a zero budget still retains the
   * last surface node (and walks further back for tool pairing), which is
   * exactly the old-session material this mode exists to drop. When true the
   * replaced span runs from the first non-`system/message` node through the
   * last surface node, and only when the cut after that node is tool-pairing
   * balanced. A pre-step whose tail cut is unbalanced (a tool call with no
   * result yet) selects nothing and defers to the next pre-step rather than
   * retaining the incomplete unit.
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
  /** Automatic rollover point in tokens. */
  thresholdTokens: number
  /** One-time reminder point in tokens; must not exceed {@link thresholdTokens}. */
  reminderThresholdTokens: number
}

/** Schemastery validation for {@link RolloverConfig}. */
export const Config: z<RolloverConfig> = z.object({
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

/** Resolved and validated rollover configuration. */
export interface ResolvedRolloverConfig {
  readonly thresholdRatio: number
  readonly reminderThresholdRatio: number
  readonly reminderMessage: string
  readonly retainRatio: number
  /** `null` keeps the ratio-based tail budget. */
  readonly retainTokens: number | null
  /** Replace the whole prior surface with the handoff document; keep no tail. */
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
  const reminderMessage = config.reminderMessage ?? DEFAULT_REMINDER_MESSAGE
  validateNonEmptyString('reminderMessage', reminderMessage)
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
    reminderThresholdRatio,
    reminderMessage,
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
