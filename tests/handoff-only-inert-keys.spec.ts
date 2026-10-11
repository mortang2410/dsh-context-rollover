/**
 * `handoffOnly` reads `retainTokens` as its tail budget but never reads
 * `retainRatio`. A configuration that sets `retainRatio` under handoffOnly is
 * accepted, so the engine must say at construction that the ratio has no
 * effect. `retainTokens` is not inert there and must not be reported as such.
 *
 * @module tests/handoff-only-inert-keys
 */

import { describe, expect, it } from 'vitest'
import type { RolloverConfig } from '../src/config.ts'
import { ContextRolloverEngine } from '../src/index.ts'
import { mountTestContext } from './harness.ts'

/** The construction warning for a retainRatio that handoffOnly never reads. */
const RATIO_WARNING = 'handoffOnly ignores retainRatio'

/** Construct one engine on a fresh test context and return what it logged as warnings. */
async function constructionWarnings(config: RolloverConfig): Promise<string[]> {
  const ctx = await mountTestContext()
  const warnings: string[] = []
  ctx.logger.warn = (message: string): void => {
    warnings.push(message)
  }
  new ContextRolloverEngine(ctx, config)
  return warnings
}

describe('handoffOnly and the tail keys', () => {
  it('warns at construction when handoffOnly makes retainRatio inert, even with retainTokens set', async () => {
    const warnings = await constructionWarnings({ handoffOnly: true, retainTokens: 10000, retainRatio: 0.1 })
    expect(warnings.filter(message => message.includes(RATIO_WARNING))).toHaveLength(1)
  })

  it('stays silent when handoffOnly reads retainTokens, which is not inert there', async () => {
    const warnings = await constructionWarnings({ handoffOnly: true, retainTokens: 10000 })
    expect(warnings.filter(message => message.includes('handoffOnly'))).toHaveLength(0)
  })

  it('stays silent when the ratio is set without handoffOnly, where it is read', async () => {
    const warnings = await constructionWarnings({ handoffOnly: false, retainTokens: 10000, retainRatio: 0.1 })
    expect(warnings.filter(message => message.includes(RATIO_WARNING))).toHaveLength(0)
  })

  it('stays silent when the tail keys are null, which resolveConfig treats as unset', async () => {
    const warnings = await constructionWarnings({
      handoffOnly: true,
      retainTokens: null as unknown as number,
      retainRatio: null as unknown as number,
    })
    expect(warnings.filter(message => message.includes(RATIO_WARNING))).toHaveLength(0)
  })

  it('stays silent for handoffOnly alone', async () => {
    const warnings = await constructionWarnings({ handoffOnly: true })
    expect(warnings.filter(message => message.includes('handoffOnly'))).toHaveLength(0)
  })
})
