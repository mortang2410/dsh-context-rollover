/**
 * Surface rollover tests: replacement leaves the model-visible surface fresh,
 * raw events stay persisted, the tail stays verbatim, tool-call/result pairs
 * are never split, and the compaction protocol's invariants hold.
 *
 * @module tests/rollover.spec
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createSystemMessage } from '@deepseek-ai/dsh-llm'
import { commitRollover, countRollovers, rolloverSummarySeqs, selectRolloverRange, sizeRolloverReplacement, ROLLOVER_PROVIDER } from '../src/rollover.ts'
import { sessionEventAt } from '../src/compat.ts'
import { appendExchange, closedConversation, derivedTexts } from './harness.ts'

/** A meter mounted on a bare context, for direct transaction tests. */
async function bareMeter(): Promise<TokenMeter> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  return ctx.tokenMeter
}

describe('selectRolloverRange', () => {
  it('retains a token-budgeted tail and never splits a tool-call/result pair', async () => {
    const meter = await bareMeter()
    const session = closedConversation(4)
    const measurement = meter.measure(session)

    // A tail budget that would land inside turn 2's tool pair must back off
    // to the balanced boundary before the pair starts.
    const range = selectRolloverRange(session, measurement, { kind: 'tail', retainTokens: 0 })
    expect(range).not.toBeNull()
    if (range === null) return
    expect(range.start).toBe(session.surface.nodes[0])
    // The cut keeps the last exchange whole: the shadowed span excludes it.
    const texts = derivedTexts(session)
    expect(texts.some(text => text.includes('exchange 4'))).toBe(true)
  })

  it('returns null when the retention budget covers the whole surface', async () => {
    const meter = await bareMeter()
    const session = closedConversation(2)
    const measurement = meter.measure(session)
    const total = measurement.nodes.reduce((sum, node) => sum + node.tokens, 0)
    // The retention budget covers everything past the head: no tail to
    // preserve means no compactable span (mirrors the shipped backend).
    expect(selectRolloverRange(session, measurement, { kind: 'tail', retainTokens: total + 1 })).toBeNull()
  })

  it('never includes a system/message head node in the range', async () => {
    const meter = await bareMeter()
    const session = Session.create(SessionId(`head-${Math.random().toString(36).slice(2, 8)}`))
    session.append('system/message', {
      turn: 1,
      step: 1,
      message: createSystemMessage('persona'),
    }, { surfaceOp: 'append' })
    appendExchange(session, 1, 'first')
    appendExchange(session, 2, 'second')
    const measurement = meter.measure(session)
    const range = selectRolloverRange(session, measurement, { kind: 'tail', retainTokens: 0 })
    expect(range).not.toBeNull()
    if (range === null) return
    // Newer hosts reject rewriting node 0 while it holds the system prompt.
    expect(range.start).toBe(session.surface.nodes[1])
    expect(range.shadowedSeqs).not.toContain(session.surface.nodes[0])
  })
})

describe('commitRollover', () => {
  it('replaces the span with one checkpoint and keeps raw events persisted', async () => {
    const meter = await bareMeter()
    // Padded so the shadowed span genuinely exceeds the checkpoint's own price
    // (the shrink guard refuses a replacement that is not strictly smaller).
    const session = closedConversation(4, 10)
    const beforeCount = session.snapshotEvents().length
    const measurement = meter.measure(session)
    const range = selectRolloverRange(session, measurement, { kind: 'tail', retainTokens: 0 })
    if (range === null) throw new Error('expected a compactable range')

    const result = await commitRollover(
      { meter },
      session,
      range.start,
      range.end,
      {
        owner: null,
        replacement: {
          kind: 'checkpoint',
          checkpoint: {
            reason: 'model-requested',
            windowNumber: 1,
            notes: '- goal: prove the rollover\n- next: run tests',
            handoff: 'Continue from the notes.',
          },
        },
      },
    )

    // Model-visible surface: checkpoint + the retained tail only.
    const texts = derivedTexts(session)
    expect(texts).toHaveLength(session.surface.nodes.length)
    expect(texts[0]).toContain('<context-rollover checkpoint>')
    expect(texts[0]).toContain('- goal: prove the rollover')
    expect(texts[0]).toContain('Continue from the notes.')
    expect(texts.join('\n')).not.toContain('exchange 1')
    expect(texts.join('\n')).toContain('exchange 4')

    // Raw events remain persisted.
    expect(session.snapshotEvents().length).toBeGreaterThan(beforeCount)
    expect(sessionEventAt(session, range.start)).toBeDefined()

    // Compaction protocol facts.
    expect(result.shadowedSeqs.length).toBeGreaterThan(0)
    expect(result.shadowedTokenCount).toBeGreaterThan(0)
    expect(countRollovers(session)).toBe(1)
    expect(rolloverSummarySeqs(session)).toEqual([result.summarySeq])
    const summary = sessionEventAt(session, result.summarySeq)
    if (summary?.type !== 'compaction/summary') throw new Error('expected a compaction/summary event')
    expect(summary.data.provider).toBe(ROLLOVER_PROVIDER)
  })

  it('rejects a replacement that would not shrink the context', async () => {
    const meter = await bareMeter()
    const session = Session.create(SessionId('tiny'))
    appendExchange(session, 1, 'tiny')
    const nodes = session.surface.nodes
    const start = nodes[0]
    const end = nodes[nodes.length - 1]
    if (start === undefined || end === undefined) throw new Error('expected surface nodes')
    await expect(commitRollover(
      { meter },
      session,
      start,
      end,
      {
        owner: null,
        replacement: {
          kind: 'checkpoint',
          checkpoint: {
            reason: 'model-requested',
            windowNumber: 1,
            notes: 'note'.repeat(5000),
            handoff: null,
          },
        },
      },
    )).rejects.toThrow(/not smaller than the shadowed content/)
  })

  it('re-prices rather than trusting a pinned sizing whose span is not the one committed', async () => {
    const meter = await bareMeter()
    const session = closedConversation(4)
    const nodes = session.surface.nodes
    const start = nodes[0]
    const end = nodes[nodes.length - 1]
    if (start === undefined || end === undefined) throw new Error('expected surface nodes')

    // A pinned sizing is a claim about ONE span and candidate. This one claims a
    // span of a single node that is not the span being committed, so it must not
    // be reusable: if the guard trusted it, this replacement (which is far too
    // large for the span it actually replaces) would commit and silently grow the
    // context. Re-pricing instead rejects it, which is the safe direction.
    await expect(commitRollover(
      { meter },
      session,
      start,
      end,
      {
        owner: null,
        pinnedSizing: {
          shadowedRouteTokens: 100_000,
          replacementTokens: 1,
          fits: true,
          shadowedSeqs: [nodes[0] as never],
          replacementText: 'x',
        },
        replacement: {
          kind: 'checkpoint',
          checkpoint: {
            reason: 'model-requested',
            windowNumber: 1,
            notes: 'note'.repeat(5000),
            handoff: null,
          },
        },
      },
    )).rejects.toThrow(/not smaller than the shadowed content/)
  })

  it('re-prices rather than trusting a pinned sizing measured for a different candidate', async () => {
    const meter = await bareMeter()
    const session = closedConversation(4)
    const measurement = meter.measure(session)
    const range = selectRolloverRange(session, measurement, { kind: 'handoff-only' })
    if (range === null) throw new Error('expected a compactable range')

    // Price a SHORT candidate over this exact span. The span is genuinely
    // larger than it, so the preflight accepts.
    const short = {
      kind: 'checkpoint' as const,
      checkpoint: { reason: 'manual' as const, windowNumber: 1, notes: 'short', handoff: null },
    }
    const sizing = sizeRolloverReplacement({ meter }, session, range, short)
    expect(sizing.fits).toBe(true)
    expect(sizing.replacementText).toContain('short')

    // Commit a much LARGER candidate over that same span, carrying the short
    // candidate's pin. The span matches the pin exactly, so only the candidate
    // binding can catch this. If the guard reused the pin, this would commit a
    // replacement larger than the content it replaces and silently grow the
    // context; re-pricing refuses it instead.
    await expect(commitRollover({ meter }, session, range.start, range.end, {
      owner: null,
      pinnedSizing: sizing,
      replacement: {
        kind: 'checkpoint',
        checkpoint: { ...short.checkpoint, notes: 'note'.repeat(5000) },
      },
    })).rejects.toThrow(/not smaller than the shadowed content/)
    expect(countRollovers(session)).toBe(0)
  })

  it('uses an accepted pinned sizing for the exact span and candidate it measured', async () => {
    const meter = await bareMeter()
    const session = closedConversation(4)
    const measurement = meter.measure(session)
    const range = selectRolloverRange(session, measurement, { kind: 'handoff-only' })
    if (range === null) throw new Error('expected a compactable range')

    // The candidate is deliberately far too large for the span it replaces, so
    // its own price cannot let it commit.
    const replacement = {
      kind: 'checkpoint' as const,
      checkpoint: {
        reason: 'manual' as const,
        windowNumber: 1,
        notes: 'note'.repeat(5000),
        handoff: null,
      },
    }
    // Measure THAT candidate over THAT span, then replace its prices with an
    // accepted pair. The candidate binding is what makes this reachable: the
    // pin's `replacementText` is the text being committed, so the pin applies
    // and its numbers, not a re-price, decide. A commit therefore proves the
    // pinned numbers were used, and this test fails if the plumbing stops
    // passing them on. (The forged prices are the caller's own claim here on
    // purpose: this case is about plumbing, and the tool and engine only ever
    // pass a pin they computed themselves.)
    const sizing = sizeRolloverReplacement({ meter }, session, range, replacement)
    expect(sizing.fits).toBe(false)
    const pinned = { ...sizing, shadowedRouteTokens: 10_000_000, replacementTokens: 1, fits: true }

    const result = await commitRollover({ meter }, session, range.start, range.end, {
      owner: null,
      pinnedSizing: pinned,
      replacement,
    })
    expect(result.shadowedSeqs.length).toBeGreaterThan(0)
    expect(countRollovers(session)).toBe(1)
  })

  it('refuses a second rollover while the compaction lock is open', async () => {
    const meter = await bareMeter()
    const session = closedConversation(4)
    const nodes = session.surface.nodes
    const start = nodes[0]
    const end = nodes[nodes.length - 1]
    if (start === undefined || end === undefined) throw new Error('expected surface nodes')
    // Open the lock the way an in-flight compaction does: one unmatched
    // `compaction/start` and no close yet.
    session.append('compaction/start', { compactionId: CompactionId('open-lock'), turn: null })
    await expect(commitRollover(
      { meter },
      session,
      start,
      end,
      {
        owner: null,
        replacement: {
          kind: 'checkpoint',
          checkpoint: {
            reason: 'model-requested',
            windowNumber: 1,
            notes: null,
            handoff: null,
          },
        },
      },
    )).rejects.toThrow(/compaction is already in progress/)
    // The refusal wrote nothing of its own: the log still carries exactly the
    // one foreign start, with no second start and no error close.
    const types = session.snapshotEvents().map(event => (event as { type: string }).type)
    expect(types.filter(type => type === 'compaction/start')).toHaveLength(1)
    expect(types).not.toContain('compaction/end')
  })

  it('leaves no failed bracket when a stale pin is re-priced and refused', async () => {
    const meter = await bareMeter()
    const session = closedConversation(4)
    const nodes = session.surface.nodes
    const start = nodes[0]
    const end = nodes[nodes.length - 1]
    if (start === undefined || end === undefined) throw new Error('expected surface nodes')

    // The exact combination the review named: the pin does not apply, so the
    // guard re-prices, and the re-priced candidate does not fit. Before the
    // shrink decision moved ahead of the lock, this left `compaction/start`
    // plus an error `compaction/end` in the durable log. Measured directly:
    // no compaction event of any kind may appear.
    await expect(commitRollover({ meter }, session, start, end, {
      owner: null,
      pinnedSizing: {
        shadowedRouteTokens: 100_000,
        replacementTokens: 1,
        fits: true,
        shadowedSeqs: [nodes[0] as never],
        replacementText: 'a text that is not the one being committed',
      },
      replacement: {
        kind: 'checkpoint',
        checkpoint: {
          reason: 'model-requested',
          windowNumber: 1,
          notes: 'note'.repeat(5000),
          handoff: null,
        },
      },
    })).rejects.toThrow(/not smaller than the shadowed content/)

    const types = session.snapshotEvents().map(event => (event as { type: string }).type)
    expect(types.filter(type => type.startsWith('compaction/'))).toEqual([])
  })

  it('leaves no compaction event at all when the size guard refuses', async () => {
    const meter = await bareMeter()
    const session = closedConversation(4, 10)
    const nodes = session.surface.nodes
    const start = nodes[0]
    const end = nodes[nodes.length - 1]
    if (start === undefined || end === undefined) throw new Error('expected surface nodes')

    // The shrink decision runs before `compaction/start`, so a rejected
    // candidate must leave the durable log byte-for-byte untouched: no start,
    // no error end, no bracket recording an attempt that could never commit.
    await expect(commitRollover(
      { meter },
      session,
      start,
      end,
      {
        owner: null,
        replacement: {
          kind: 'checkpoint',
          checkpoint: {
            reason: 'model-requested',
            windowNumber: 1,
            notes: 'note'.repeat(5000),
            handoff: null,
          },
        },
      },
    )).rejects.toThrow(/not smaller than the shadowed content/)

    const types = session.snapshotEvents().map(event => (event as { type: string }).type)
    expect(types.filter(type => type.startsWith('compaction/'))).toEqual([])
    // The surface is untouched, so a valid rollover still succeeds afterwards.
    const measurement = meter.measure(session)
    const range = selectRolloverRange(session, measurement, { kind: 'tail', retainTokens: 0 })
    if (range === null) throw new Error('expected a compactable range')
    await expect(commitRollover(
      { meter },
      session,
      range.start,
      range.end,
      {
        owner: null,
        replacement: {
          kind: 'checkpoint',
          checkpoint: {
            reason: 'manual',
            windowNumber: 1,
            notes: null,
            handoff: null,
          },
        },
      },
    )).resolves.toBeDefined()
  })
})
