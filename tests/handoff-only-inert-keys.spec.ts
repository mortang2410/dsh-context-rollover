/**
 * `handoffOnly` keeps no recent tail, so the explicit tail budgets
 * (`retainTokens`, `retainRatio`) never reach the selection. A configuration
 * that sets both is accepted, so the engine must say at construction that
 * those values have no effect.
 *
 * @module tests/handoff-only-inert-keys
 */

import { describe, expect, it } from 'vitest'
import type { RolloverConfig } from '../src/config.ts'
import { ContextRolloverEngine } from '../src/index.ts'
import { mountTestContext } from './harness.ts'

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

describe('handoffOnly with inert tail keys', () => {
  it('warns at construction when handoffOnly makes retainTokens and retainRatio inert', async () => {
    const warnings = await constructionWarnings({ handoffOnly: true, retainTokens: 10000, retainRatio: 0.1 })
    expect(warnings.filter(message => message.includes('retainTokens'))).toHaveLength(1)
  })

  it('stays silent when the tail keys are set without handoffOnly', async () => {
    const warnings = await constructionWarnings({ handoffOnly: false, retainTokens: 10000, retainRatio: 0.1 })
    expect(warnings.filter(message => message.includes('retainTokens'))).toHaveLength(0)
  })

  it('stays silent for handoffOnly alone', async () => {
    const warnings = await constructionWarnings({ handoffOnly: true })
    expect(warnings.filter(message => message.includes('retainTokens'))).toHaveLength(0)
  })
})
