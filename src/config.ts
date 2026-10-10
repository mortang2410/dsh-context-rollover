/**
 * Plugin configuration: validated once at load, resolved against model context
 * windows at runtime. Ratios scale defaults across models; absolute overrides
 * stay available for stable experiments.
 *
 * @module dsh-context-rollover/config
 */

import z from '@deepseek-ai/schemastery'

/** The rollover modes a deployment may select. */
export const ROLLOVER_MODES = ['upstream', 'structured-handoff'] as const

/** One rollover mode: the upstream behavior or the structured-handoff behavior. */
export type RolloverMode = (typeof ROLLOVER_MODES)[number]

/** Model-facing configuration surface for the rollover engine. */
export interface RolloverConfig {
  /**
   * Automatic rollover pressure point as a fraction of the routed model's
   * context window. Defaults to `0.9`.
   */
  thresholdRatio?: number
  /**
   * One-time checkpoint reminder point as a fraction of the context window.
   * Defaults to `0.75`.
   */
  reminderThresholdRatio?: number
  /**
   * Recent verbatim tail retained across a rollover, as a fraction of the
   * context window. Defaults to `0.1`.
   */
  retainRatio?: number
  /**
   * Absolute recent-tail budget in tokens; overrides `retainRatio` when set.
   */
  retainTokens?: number
  /** Maximum accepted handoff text size in characters. Defaults to `20000`. */
  handoffMaxChars?: number
  /** Mount the `notes` tool and render notes into rollover checkpoints. */
  notesEnabled?: boolean
  /** Mount the `history` tool. */
  historyEnabled?: boolean
  /** Base directory for note files; defaults to `<dsh home>/notes/<session id>`. */
  notesDir?: string
  /**
   * Model-surface registration: `auto` registers tools and guidance only
   * where no preset roster exists (the host row), while `always` registers
   * them unconditionally (the preset row, which owns its composition).
   * Defaults to `auto`.
   */
  modelSurface?: 'auto' | 'always'
  /**
   * Rollover mode. `upstream` keeps the upstream reminder, guidance, and
   * checkpoint wording; `structured-handoff` selects the structured-handoff
   * wording and rule. Defaults to `upstream`. `structured-handoff` requires
   * `notesEnabled` to stay true; the pair is rejected at load otherwise.
   */
  mode?: RolloverMode
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
  /** One-time reminder point in tokens; must not exceed {@link ModelThresholds.thresholdTokens}. */
  reminderThresholdTokens: number
}

/** Schemastery validation for {@link RolloverConfig}. */
export const Config: z<RolloverConfig> = z.object({
  thresholdRatio: z.number(),
  reminderThresholdRatio: z.number(),
  retainRatio: z.number(),
  retainTokens: z.number().step(1).min(0),
  handoffMaxChars: z.number().step(1).min(0),
  notesEnabled: z.boolean(),
  historyEnabled: z.boolean(),
  notesDir: z.string(),
  modelSurface: z.union(['auto', 'always'] as const),
  mode: z.union(ROLLOVER_MODES),
  modelThresholds: z.dict(z.object({
    thresholdTokens: z.number().step(1).min(1),
    reminderThresholdTokens: z.number().step(1).min(1),
  })),
})

/** Resolved and validated rollover configuration. */
export interface ResolvedRolloverConfig {
  readonly thresholdRatio: number
  readonly reminderThresholdRatio: number
  readonly retainRatio: number
  /** `null` keeps the ratio-based tail budget. */
  readonly retainTokens: number | null
  readonly handoffMaxChars: number
  readonly notesEnabled: boolean
  readonly historyEnabled: boolean
  readonly notesDir: string | undefined
  readonly modelSurface: 'auto' | 'always'
  readonly mode: RolloverMode
  /** Absolute points per routed model id; an empty map keeps the ratios for every model. */
  readonly modelThresholds: Readonly<Record<string, ModelThresholds>>
}

/** Reject a ratio that cannot represent a fraction of a context window. */
function validateRatio(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value > 1) {
    throw new TypeError(`context-rollover: ${name} must be in (0, 1], got ${String(value)}`)
  }
}

/** Reject a blank name where a non-empty string is required. */
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
  const reminderThresholdRatio = config.reminderThresholdRatio ?? 0.75
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
  const retainTokens = config.retainTokens ?? null
  if (retainTokens !== null && (!Number.isSafeInteger(retainTokens) || retainTokens < 0)) {
    throw new TypeError(`context-rollover: retainTokens must be a non-negative integer, got ${String(retainTokens)}`)
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
  // An explicit undefined selects the default; any other value, including
  // null, must name a mode.
  const mode = config.mode === undefined ? 'upstream' : config.mode
  if (!ROLLOVER_MODES.includes(mode)) {
    throw new TypeError(
      `context-rollover: mode must be 'upstream' or 'structured-handoff', got ${String(mode)}`,
    )
  }
  // The structured handoff is a note the model writes and the notes tool
  // carries. With notes disabled the guidance would name a carrier that is
  // never mounted, so the pair is refused rather than run.
  const notesEnabled = config.notesEnabled ?? true
  if (mode === 'structured-handoff' && !notesEnabled) {
    throw new TypeError(
      `context-rollover: mode 'structured-handoff' cannot be combined with notesEnabled ${String(notesEnabled)}; `
      + "the structured handoff is carried in a note, so set notesEnabled to true or mode to 'upstream'",
    )
  }
  const modelThresholds = config.modelThresholds ?? {}
  if (typeof modelThresholds !== 'object' || Array.isArray(modelThresholds)) {
    throw new TypeError(
      `context-rollover: modelThresholds must be an object keyed by model id, got ${String(modelThresholds)}`,
    )
  }
  for (const [model, points] of Object.entries(modelThresholds)) {
    validateNonEmptyString('modelThresholds key', model)
    if (typeof points !== 'object' || points === null || Array.isArray(points)) {
      throw new TypeError(
        `context-rollover: modelThresholds[${model}] must be an object with thresholdTokens and `
        + `reminderThresholdTokens, got ${JSON.stringify(points)}`,
      )
    }
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
    retainRatio,
    retainTokens,
    handoffMaxChars,
    notesEnabled,
    historyEnabled: config.historyEnabled ?? true,
    notesDir: config.notesDir,
    modelSurface,
    mode,
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
