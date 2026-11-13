/**
 * The compiled forced replacement (ticket b61t, contracts C3 and C4): the
 * recall guide first, the durable notes header after it when notes exist, then
 * the framed entries, with the compiler cap bounded by the configured cap and
 * half the shadowed span.
 *
 * @module tests/compiled-fallback
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { RolloverConfig } from '../src/config.ts'
import { buildReplacementText, replacementWindowNumber, type RolloverReplacement } from '../src/checkpoint.ts'
import { buildCompiledReplacement } from '../src/compiled-fallback.ts'
import { checkpointCapFor } from '../src/vcc/cap.ts'
import {
  CHECKPOINT_CLOSE_TAG,
  CHECKPOINT_OPEN_TAG,
  RECALL_GUIDE,
  estimateEntryTokens,
} from '../src/vcc/compiler.ts'
import { closedConversation } from './harness.ts'

/** The notes header the composer places after the recall guide. */
const NOTES_HEADER = '## Durable notes'

/** The compiler cap the fixtures measure against: far above their span halves. */
const CHECKPOINT_CAP = 65_536

/** A resolved configuration with only the compiler keys this module reads set. */
const config: RolloverConfig = {
  thresholdRatio: 0.9,
  automaticRollover: true,
  automaticRolloverRetainTokens: 10_000,
  reminderThresholdRatio: 0.4,
  reminderMessage: 'reminder',
  reminderRepeatMs: 300_000,
  rolloverReminderMessage: 'rollover',
  retainRatio: 0.1,
  // Absent rather than null: the raw key is an optional number.

  handoffOnly: true,
  handoffMaxChars: 20_000,
  notesEnabled: true,
  historyEnabled: true,
  notesDir: '/tmp/notes',
  handoffDir: '.',
  handoffPattern: '*.md',
  modelSurface: 'auto',
  modelThresholds: {},
  idleRollover: false,
  idleRolloverAfterMs: 2_400_000,
  idleRolloverTokens: 90_000,
  idleRolloverMessage: '/rollover',
  idleRolloverTickMs: 60_000,
  idleRolloverCandidatesPath: '/tmp/candidates.json',
  checkpointCap: 65_536,
  assistantTextTokens: 1_500,
  userTextTokens: 2_000,
  toolCallTokens: 200,
  includeReasoning: false,
  toolArgTools: [],
  hideTools: [],
}

/** A span of plain user/assistant text, padded by `repeats` filler words per turn. */
function span(turns: number, repeats: number): Session {
  return closedConversation(turns, repeats)
}

/** What a replacement is priced at, for the fit assertion. */
function priced(text: string): number {
  return estimateEntryTokens(text)
}

/** The text of one replacement, or a failing marker. */
function textOf(replacement: RolloverReplacement | { defer: true }): string {
  if ('defer' in replacement) throw new Error('expected a compiled replacement, got a deferral')
  return buildReplacementText(replacement)
}

describe('checkpointCapFor', () => {
  it('never exceeds the configured cap nor half the shadowed span', () => {
    expect(checkpointCapFor(10_000, 65_536)).toBe(5_000)
    expect(checkpointCapFor(1_000_000, 65_536)).toBe(65_536)
  })

  it('returns null below two tokens, where half the span cannot hold the frame', () => {
    expect(checkpointCapFor(99, 65_536)).toBe(49)
    expect(checkpointCapFor(6, 65_536)).toBe(3)
    expect(checkpointCapFor(1, 65_536)).toBeNull()
  })
})

describe('buildCompiledReplacement', () => {
  it('frames the recall guide first, then the framed entries', () => {
    const session = span(4, 0)
    const replacement = buildCompiledReplacement({
      session,
      shadowedSeqs: session.surface.nodes,
      shadowedTokens: 6_000,
      windowNumber: 3,
      notes: null,
}, config)
    const text = textOf(replacement)
    expect(text).not.toContain(NOTES_HEADER)
    const guideAt = text.indexOf(RECALL_GUIDE)
    expect(guideAt).toBeGreaterThan(text.indexOf(CHECKPOINT_OPEN_TAG))
    expect(guideAt).toBeLessThan(text.indexOf('[user]'))
    expect(text.indexOf('[assistant]')).toBeGreaterThan(guideAt)
    expect(text.trimEnd().endsWith(CHECKPOINT_CLOSE_TAG)).toBe(true)
  })

  it('places the durable notes header after the guide and before the entries', () => {
    const session = span(4, 0)
    const replacement = buildCompiledReplacement({
      session,
      shadowedSeqs: session.surface.nodes,
      shadowedTokens: 6_000,
      windowNumber: 3,
      notes: '- goal: carry the conversation verbatim',
}, config)
    const text = textOf(replacement)
    const guideAt = text.indexOf(RECALL_GUIDE)
    const notesAt = text.indexOf(NOTES_HEADER)
    expect(guideAt).toBeGreaterThanOrEqual(0)
    expect(notesAt).toBeGreaterThan(guideAt)
    expect(text).toContain('- goal: carry the conversation verbatim')
    expect(notesAt).toBeLessThan(text.indexOf('[user]'))
    expect(notesAt).toBeLessThan(text.indexOf('[assistant]'))
  })

  it('returns a compiled variant the replacement builders read back', () => {
    const session = span(4, 0)
    const replacement = buildCompiledReplacement({
      session,
      shadowedSeqs: session.surface.nodes,
      shadowedTokens: 6_000,
      windowNumber: 7,
      notes: null,
}, config)
    if ('defer' in replacement || replacement.kind !== 'compiled') {
      throw new Error('expected a compiled replacement')
    }
    expect(replacement.windowNumber).toBe(7)
    expect(replacementWindowNumber(replacement)).toBe(7)
  })

  it('builds a text smaller than the span it replaces when the span exceeds the cap', () => {
    // Four turns of ~425 tokens each: a 3.4k span, where half the span still
    // covers the guide and the frame.
    const session = span(4, 200)
    const shadowedSeqs = session.surface.nodes
    // The span price is measured on the compiler's own sizing, and the
    // precondition that it exceeds the cap is asserted rather than assumed.
    const shadowedTokens = shadowedSeqs.reduce((total, seq) => {
      const event = session.eventAt(SessionSeq(seq))
      if (event === undefined) throw new Error(`no event at ${seq}`)
      const message = session.deriveEventMessage(event)
      const body = message === null
        ? ''
        : message.content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join('')
      return total + estimateEntryTokens(body)
    }, 0)
    expect(shadowedTokens).toBeGreaterThan(checkpointCapFor(shadowedTokens, CHECKPOINT_CAP) ?? 0)

    const replacement = buildCompiledReplacement({
      session,
      shadowedSeqs,
      shadowedTokens,
      windowNumber: 1,
      notes: null,
}, config)
    const text = textOf(replacement)
    expect(priced(text)).toBeLessThan(shadowedTokens)
  })

  it('defers when the projection raises its error', () => {
    const session = span(4, 0)
    const replacement = buildCompiledReplacement({
      session,
      shadowedSeqs: [...session.surface.nodes, 10_000],
      shadowedTokens: 6_000,
      windowNumber: 1,
      notes: 'notes',
}, config)
    expect(replacement).toEqual({ defer: true })
  })

  it('defers when the projection compiles to no entries', () => {
    const session = Session.create(SessionId(`empty-${Math.random().toString(36).slice(2, 8)}`))
    // An empty assistant message keeps a surface position but compiles to nothing.
    session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [], source: { provider: 'mock', model: 'mock' } }),
    }, { surfaceOp: 'append' })
    const replacement = buildCompiledReplacement({
      session,
      shadowedSeqs: session.surface.nodes,
      shadowedTokens: 6_000,
      windowNumber: 1,
      notes: null,
}, config)
    expect(replacement).toEqual({ defer: true })
  })

  it('keeps the handoff composition byte for byte in the replacement builder', () => {
    const document = '# Handoff\n\nexact bytes  '
    expect(buildReplacementText({ kind: 'handoff-document', windowNumber: 2, text: document })).toBe(document)
    expect(replacementWindowNumber({ kind: 'handoff-document', windowNumber: 2, text: document })).toBe(2)
  })
})

