/**
 * The resume composition of the idle reopen, one branch per rule: the stored
 * preset is read through the session query service and mounted inside the
 * resume setup, the default model travels in the resume options, and every
 * missing or unresolvable piece refuses the resume instead of guessing.
 *
 * @module tests/resume
 */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import { composeResume, isSessionNotFound } from '../src/resume.ts'

const SESSION = SessionId('composed')

/** Provide one service the composition reads, the way the host mounts it. */
function provide(ctx: Context, name: string, value: unknown): void {
  (ctx as unknown as { provide(name: string, value: unknown): void }).provide(name, value)
}

/** What one observation hands back, with a flag the test can read afterwards. */
interface Observed {
  readonly header: { readonly id: SessionId; readonly origin?: string; readonly delegationDepth?: number }
  readonly projections?: { readonly values: { readonly agentPreset?: string } }
  /** Set by the lease's own disposer; the composition must call it. */
  disposed: boolean
  readonly [Symbol.dispose]: () => void
}

/** A session query stub that records its disposal and returns one observation. */
function queryReturning(observation: Partial<Observed> = {}): {
  observeSession: (id: SessionId) => Promise<Observed>
  observed: Observed[]
} {
  const observed: Observed[] = []
  return {
    observed,
    observeSession: async (id: SessionId) => {
      const value = {
        header: observation.header ?? { id },
        projections: observation.projections ?? { values: { agentPreset: 'stored-preset' } },
        disposed: false,
        [Symbol.dispose]() {
          value.disposed = true
        },
      }
      observed.push(value)
      return value
    },
  }
}

/** A preset registry stub: one resolved id and a mount spy. */
function registryFor(resolvedId = 'stored-preset'): {
  resolve: ReturnType<typeof vi.fn>
  mount: ReturnType<typeof vi.fn>
} {
  return {
    resolve: vi.fn(async () => ({ id: resolvedId })),
    mount: vi.fn(async () => {}),
  }
}

/** A context with the default model and, optionally, the query and registry services. */
function contextWith(options: {
  readonly query?: unknown
  readonly registry?: unknown
  readonly selection?: { provider?: string; model?: string }
}): Context {
  const ctx = new Context()
  if (options.query !== undefined) provide(ctx, 'sessionQuery', options.query)
  if (options.registry !== undefined) provide(ctx, 'agentPresets', options.registry)
  if (options.selection !== undefined) provide(ctx, 'agentDefaultModel', { currentSelection: () => options.selection })
  return ctx
}

/** Collect warnings from one composition call. */
async function compose(ctx: Context): Promise<{ composition: Awaited<ReturnType<typeof composeResume>>; warnings: string[] }> {
  const warnings: string[] = []
  const composition = await composeResume(ctx, SESSION, line => { warnings.push(line) })
  return { composition, warnings }
}

describe('composeResume', () => {
  it('mounts the stored preset in the setup and carries the default model', async () => {
    const query = queryReturning()
    const registry = registryFor('standard')
    const ctx = contextWith({
      query,
      registry,
      selection: { provider: 'mock-provider', model: 'mock-model' },
    })

    const { composition, warnings } = await compose(ctx)

    expect(warnings).toEqual([])
    expect(composition?.agentOptions).toEqual({ provider: 'mock-provider', model: 'mock-model' })
    expect(composition?.presetId).toBe('standard')
    expect(composition?.setup).toBeDefined()
    await composition?.setup?.(new Context(), {})
    expect(registry.resolve).toHaveBeenCalledWith('stored-preset')
    expect(registry.mount).toHaveBeenCalledWith(expect.anything(), 'standard')
    expect(query.observed[0]?.disposed).toBe(true)
  })

  it('resolves the registry default when the session stores no preset', async () => {
    const query = queryReturning({ projections: { values: {} } })
    const registry = registryFor('default-preset')
    const ctx = contextWith({ query, registry, selection: { provider: 'p', model: 'm' } })

    const { composition } = await compose(ctx)

    expect(registry.resolve).toHaveBeenCalledWith(undefined)
    expect(composition?.presetId).toBe('default-preset')
  })

  it('refuses a stored preset that does not resolve and substitutes no other', async () => {
    const query = queryReturning({ projections: { values: { agentPreset: 'missing-preset' } } })
    const registry = registryFor()
    registry.resolve.mockRejectedValueOnce(new Error('agent-preset/not-found: missing-preset'))
    const ctx = contextWith({ query, registry, selection: { provider: 'p', model: 'm' } })

    const { composition, warnings } = await compose(ctx)

    expect(composition).toBeUndefined()
    expect(registry.mount).not.toHaveBeenCalled()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('missing-preset')
    expect(warnings[0]).toContain('agent-preset/not-found')
  })

  it('resumes without a preset when no registry is mounted, and still carries the model', async () => {
    const query = queryReturning()
    const ctx = contextWith({ query, selection: { provider: 'p', model: 'm' } })

    const { composition, warnings } = await compose(ctx)

    expect(composition?.agentOptions).toEqual({ provider: 'p', model: 'm' })
    expect(composition?.setup).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('without its preset')
  })

  it('refuses when no session query service is mounted', async () => {
    const ctx = contextWith({ selection: { provider: 'p', model: 'm' } })

    const { composition, warnings } = await compose(ctx)

    expect(composition).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('no session query service')
  })

  it('refuses when no default model selection is available', async () => {
    const ctx = contextWith({ query: queryReturning(), registry: registryFor() })

    const { composition, warnings } = await compose(ctx)

    expect(composition).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('no default model selection')
  })

  it.each([
    ['a subagent origin', { id: SESSION, origin: 'subagent' }],
    ['a nonzero delegation depth', { id: SESSION, delegationDepth: 2 }],
  ])('never reopens a session whose header carries %s', async (_label, header) => {
    const query = queryReturning({ header })
    const registry = registryFor()
    const ctx = contextWith({ query, registry, selection: { provider: 'p', model: 'm' } })

    const { composition, warnings } = await compose(ctx)

    expect(composition).toBeUndefined()
    expect(registry.resolve).not.toHaveBeenCalled()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('subagent')
  })
})

describe('isSessionNotFound', () => {
  it('reads the session query service signal by code', () => {
    expect(isSessionNotFound(Object.assign(new Error('not found'), { code: 'SESSION_QUERY_SESSION_NOT_FOUND' }))).toBe(true)
  })

  it('reads the controller signal by name', () => {
    expect(isSessionNotFound(Object.assign(new Error('not found'), { name: 'ApiSessionNotFound' }))).toBe(true)
  })

  it.each([
    ['a plain error', new Error('boom')],
    ['another code', Object.assign(new Error('boom'), { code: 'SESSION_QUERY_INVALID_CONFIG' })],
    ['a non-error value', 'boom'],
    ['null', null],
  ])('is false for %s', (_label, value) => {
    expect(isSessionNotFound(value)).toBe(false)
  })
})
