/**
 * The structured-handoff mode needs notes. Its handoff is a note the model
 * writes, and the notes tool carries it. With notes disabled, the guidance
 * would name a carrier that is never mounted, so the combination is rejected at
 * load, and the engine constructor refuses it the same way. Upstream mode does
 * not depend on notes as its carrier, so it keeps accepting notes disabled.
 *
 * @module tests/mode-notes-combination
 */

import { describe, expect, it } from 'vitest'
import { resolveConfig } from '../src/config.ts'
import { ContextRolloverEngine } from '../src/index.ts'
import { mountTestContext } from './harness.ts'

/** The exact load-time message for structured-handoff with notes disabled. */
const REJECTION = "context-rollover: mode 'structured-handoff' cannot be combined with notesEnabled false; the structured handoff is carried in a note, so set notesEnabled to true or mode to 'upstream'"

/** The error a call throws. Fails the test when the call returns instead. */
function thrownBy(run: () => unknown): unknown {
  try {
    run()
  } catch (error) {
    return error
  }
  throw new Error('expected the call to throw')
}

describe('structured-handoff mode with notes disabled', () => {
  it('is rejected at load with a TypeError that names both keys and both values', () => {
    const error = thrownBy(() => resolveConfig({ mode: 'structured-handoff', notesEnabled: false }))
    expect(error).toBeInstanceOf(TypeError)
    expect((error as TypeError).message).toBe(REJECTION)
  })

  it('is refused by the engine constructor with the same message', async () => {
    const ctx = await mountTestContext()
    const error = thrownBy(() => new ContextRolloverEngine(ctx, { mode: 'structured-handoff', notesEnabled: false }))
    expect(error).toBeInstanceOf(TypeError)
    expect((error as TypeError).message).toBe(REJECTION)
  })
})

describe('notes combinations that stay valid', () => {
  it('accepts upstream mode with notes disabled, at load and in the engine', async () => {
    expect(resolveConfig({ mode: 'upstream', notesEnabled: false }).notesEnabled).toBe(false)
    const ctx = await mountTestContext()
    expect(() => new ContextRolloverEngine(ctx, { mode: 'upstream', notesEnabled: false })).not.toThrow()
  })

  it('accepts structured-handoff mode with notes enabled', async () => {
    expect(resolveConfig({ mode: 'structured-handoff', notesEnabled: true }).notesEnabled).toBe(true)
    const ctx = await mountTestContext()
    expect(() => new ContextRolloverEngine(ctx, { mode: 'structured-handoff', notesEnabled: true })).not.toThrow()
  })

  it('accepts structured-handoff mode when notesEnabled is left to its enabled default', async () => {
    expect(resolveConfig({ mode: 'structured-handoff' }).notesEnabled).toBe(true)
    const ctx = await mountTestContext()
    expect(() => new ContextRolloverEngine(ctx, { mode: 'structured-handoff' })).not.toThrow()
  })
})
