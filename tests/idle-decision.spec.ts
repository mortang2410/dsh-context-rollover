/**
 * The idle rollover watchdog's configuration and fire decision. The decision is
 * asserted on its returned value and the configuration on its thrown error, so
 * no private helper is under test. Each gate has a case that makes the decision
 * fail when that gate is removed.
 *
 * @module tests/idle-decision
 */

import { describe, expect, it } from 'vitest'
import { Config as RolloverConfigSchema, resolveConfig } from '../src/config.ts'
import type { RolloverConfig } from '../src/config.ts'
import { decideIdleFire, hasSlashGesture } from '../src/idle.ts'
import type { IdleFireInputs, IdleSkipReason } from '../src/idle.ts'
import { ContextRolloverEngine } from '../src/index.ts'
import { mountTestContext, tempNotesDir } from './harness.ts'

/** Record every warning the engine logs, while still forwarding it. */
function captureWarnings(ctx: { logger: { warn: (message: string) => void } }): string[] {
  const warnings: string[] = []
  const original = ctx.logger.warn.bind(ctx.logger)
  ctx.logger.warn = (message: string): void => {
    warnings.push(message)
    original(message)
  }
  return warnings
}

/** The value a call throws, or a failure when the call throws nothing. */
function thrownBy(call: () => unknown): unknown {
  try {
    call()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw')
}

describe('idle watchdog configuration defaults', () => {
  it('resolves each idle key to its documented default when absent', () => {
    expect(resolveConfig({})).toMatchObject({
      idleRollover: false,
      idleRolloverAfterMs: 2_400_000,
      idleRolloverTokens: 90_000,
      idleRolloverMessage: '/rollover',
      idleRolloverTickMs: 60_000,
    })
  })

  it('takes configured values for each idle key', () => {
    expect(resolveConfig({
      idleRollover: true,
      idleRolloverAfterMs: 1_000,
      idleRolloverTokens: 5_000,
      idleRolloverMessage: '/rollover',
      idleRolloverTickMs: 250,
    })).toMatchObject({
      idleRollover: true,
      idleRolloverAfterMs: 1_000,
      idleRolloverTokens: 5_000,
      idleRolloverMessage: '/rollover',
      idleRolloverTickMs: 250,
    })
  })
})

describe('idle watchdog configuration validation', () => {
  it.each(['idleRolloverAfterMs', 'idleRolloverTokens', 'idleRolloverTickMs'] as const)(
    'rejects a non-positive or non-integer %s with the plugin prefix',
    (key) => {
      for (const bad of [0, -1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
        const error = thrownBy(() => resolveConfig({ [key]: bad } as RolloverConfig))
        expect(error).toBeInstanceOf(TypeError)
        expect((error as TypeError).message)
          .toMatch(new RegExp(`^context-rollover: ${key} must be a positive integer, got `))
      }
    },
  )

  it('accepts the longest timer delay and rejects one millisecond more', () => {
    expect(resolveConfig({ idleRolloverTickMs: 2_147_483_647 }).idleRolloverTickMs).toBe(2_147_483_647)
    const error = thrownBy(() => resolveConfig({ idleRolloverTickMs: 2_147_483_648 }))
    expect(error).toBeInstanceOf(TypeError)
    expect((error as TypeError).message)
      .toBe('context-rollover: idleRolloverTickMs must be at most 2147483647, got 2147483648')
  })

  it('rejects an empty or whitespace-only message', () => {
    for (const bad of ['', '   ', '\n\t']) {
      const error = thrownBy(() => resolveConfig({ idleRolloverMessage: bad }))
      expect(error).toBeInstanceOf(TypeError)
      expect((error as TypeError).message)
        .toMatch(/^context-rollover: idleRolloverMessage must be a non-empty string/)
    }
  })

  it('rejects a non-boolean idleRollover with the plugin prefix', () => {
    const error = thrownBy(() => resolveConfig({ idleRollover: 'yes' as unknown as boolean }))
    expect(error).toBeInstanceOf(TypeError)
    expect((error as TypeError).message).toMatch(/^context-rollover: idleRollover must be a boolean/)
  })

  it('declares the five keys in the load-time schema, which refuses values the resolver would refuse', () => {
    expect(() => RolloverConfigSchema({ idleRolloverAfterMs: 0 })).toThrow()
    expect(() => RolloverConfigSchema({ idleRolloverTokens: 1.5 })).toThrow()
    expect(() => RolloverConfigSchema({ idleRolloverTickMs: 2_147_483_648 })).toThrow()
    expect(() => RolloverConfigSchema({ idleRollover: 'yes' as unknown as boolean })).toThrow()
    expect(() => RolloverConfigSchema({ idleRolloverMessage: 42 as unknown as string })).toThrow()
    expect(RolloverConfigSchema({ idleRollover: true, idleRolloverTickMs: 1_000 }))
      .toMatchObject({ idleRollover: true, idleRolloverTickMs: 1_000 })
  })
})

describe('hasSlashGesture', () => {
  it.each([
    '/rollover',
    'please /rollover now',
    '/rollover-now',
    '/a1',
  ])('finds a gesture in %j', (text) => {
    expect(hasSlashGesture(text)).toBe(true)
  })

  it.each([
    '',
    'rollover',
    '/',
    '/Rollover',
    '/rollover-',
    '/roll--over',
    'path/to/file',
    '/usr/bin',
    '5/8',
  ])('finds no gesture in %j', (text) => {
    expect(hasSlashGesture(text)).toBe(false)
  })

  it('gives the same answer on repeated calls with the same text', () => {
    expect([hasSlashGesture('/rollover'), hasSlashGesture('/rollover')]).toEqual([true, true])
  })
})

describe('decideIdleFire', () => {
  const config = { idleRolloverAfterMs: 2_400_000, idleRolloverTokens: 90_000 }

  /** Inputs where every gate passes, so each case can fail exactly one gate. */
  const passing: IdleFireInputs = {
    enabled: true,
    status: 'idle',
    queuedWork: false,
    idleMs: 3_000_000,
    baselineKnown: true,
    totalTokens: 90_001,
    rolloverPointTokens: 180_000,
    foreignBackendOwnsCompaction: false,
    newContextAvailable: true,
    skillAvailable: true,
    rolloverPending: false,
    epochArmed: true,
  }

  it('fires when every gate passes', () => {
    expect(decideIdleFire(config, passing)).toEqual({ fire: true })
  })

  it.each<[IdleSkipReason, Partial<IdleFireInputs>]>([
    ['disabled', { enabled: false }],
    ['not-idle', { status: 'running' }],
    ['queued-work', { queuedWork: true }],
    ['idle-too-short', { idleMs: 2_399_999 }],
    ['tokens-not-above-floor', { totalTokens: 90_000 }],
    ['tokens-not-above-floor', { baselineKnown: false }],
    ['above-rollover-point', { totalTokens: 180_000 }],
    ['backend-not-rollover', { foreignBackendOwnsCompaction: true }],
    ['no-new-context-tool', { newContextAvailable: false }],
    ['skill-unavailable', { skillAvailable: false }],
    ['rollover-pending', { rolloverPending: true }],
    ['already-fired-this-epoch', { epochArmed: false }],
  ])('skips with %s when only that gate fails', (reason, override) => {
    expect(decideIdleFire(config, { ...passing, ...override })).toEqual({ fire: false, reason })
  })

  it.each<[IdleSkipReason, IdleSkipReason, Partial<IdleFireInputs>]>([
    ['disabled', 'not-idle', { enabled: false, status: 'running' }],
    ['not-idle', 'queued-work', { status: 'running', queuedWork: true }],
    ['queued-work', 'idle-too-short', { queuedWork: true, idleMs: 0 }],
    ['idle-too-short', 'tokens-not-above-floor', { idleMs: 0, totalTokens: 0 }],
    ['tokens-not-above-floor', 'above-rollover-point', { totalTokens: 50_000, rolloverPointTokens: 40_000 }],
    ['above-rollover-point', 'backend-not-rollover', { rolloverPointTokens: 90_001, foreignBackendOwnsCompaction: true }],
    ['backend-not-rollover', 'no-new-context-tool', { foreignBackendOwnsCompaction: true, newContextAvailable: false }],
    ['no-new-context-tool', 'skill-unavailable', { newContextAvailable: false, skillAvailable: false }],
    ['skill-unavailable', 'rollover-pending', { skillAvailable: false, rolloverPending: true }],
    ['rollover-pending', 'already-fired-this-epoch', { rolloverPending: true, epochArmed: false }],
  ])('reports %s rather than %s when both fail', (earlier, _later, override) => {
    expect(decideIdleFire(config, { ...passing, ...override })).toEqual({ fire: false, reason: earlier })
  })

  it('counts exactly the idle threshold as long enough', () => {
    expect(decideIdleFire(config, { ...passing, idleMs: 2_400_000 })).toEqual({ fire: true })
  })

  it('fires an idle session whose inboxes are empty', () => {
    expect(decideIdleFire(config, { ...passing, queuedWork: false })).toEqual({ fire: true })
  })

  it('fires only when the tokens are strictly above the floor', () => {
    expect(decideIdleFire(config, { ...passing, totalTokens: 89_999 }))
      .toEqual({ fire: false, reason: 'tokens-not-above-floor' })
    expect(decideIdleFire(config, { ...passing, totalTokens: 90_000 }))
      .toEqual({ fire: false, reason: 'tokens-not-above-floor' })
    expect(decideIdleFire(config, { ...passing, totalTokens: 90_001 })).toEqual({ fire: true })
  })

  it('refuses exactly the rollover point and fires one token below it', () => {
    expect(decideIdleFire(config, { ...passing, totalTokens: 179_999 })).toEqual({ fire: true })
    expect(decideIdleFire(config, { ...passing, totalTokens: 180_000 }))
      .toEqual({ fire: false, reason: 'above-rollover-point' })
  })
})

describe('construction-time warning for a gestureless message', () => {
  it('stays quiet for the default message, which carries a skill gesture', async () => {
    const ctx = await mountTestContext()
    const warnings = captureWarnings(ctx)
    const notesDir = await tempNotesDir()
    new ContextRolloverEngine(ctx, { notesDir })
    expect(warnings).toEqual([])
  })

  it('warns once when the configured message carries no skill gesture', async () => {
    const ctx = await mountTestContext()
    const warnings = captureWarnings(ctx)
    const notesDir = await tempNotesDir()
    new ContextRolloverEngine(ctx, { notesDir, idleRolloverMessage: 'roll over now' })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('idleRolloverMessage')
  })
})
