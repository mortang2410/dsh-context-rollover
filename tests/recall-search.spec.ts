/**
 * The read-back tools (ticket 2zex, contract C6): `recall` restores VCC's
 * complete textual projection of one log record within the recall budget, and
 * `search` reports where a matching record sits in the log, so a hit can go
 * straight back to `recall`.
 *
 * The fixtures are one real session log read through the plugin's own accessors:
 * a text turn, a tool call with its result carrying an image block, a checkpoint
 * node built by the host's own `compactCheckpointSource`, a long verbose
 * instruction for the budget case, and a record appended after an earlier read
 * for the search cursor case. Every tool assertion goes through `ctx.tools`
 * (registration, argument validation, execute, render), so it covers the
 * model-visible content, and the registry-gating cases run the real engine
 * mount.
 *
 * @module tests/recall-search
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import { compactCheckpointSource } from '@deepseek-ai/dsh-compaction'
import {
  createAssistantMessage,
  createToolResultMessage,
  createUserMessage,
  ToolCallId,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { ContextRolloverEngine } from '../src/index.ts'
import { DEFAULT_MAX_RECALL_TOKENS, recallByCheckpoint, recallByResult, recallBySeq } from '../src/recall.ts'
import { searchLog } from '../src/search.ts'
import { engineHarness, MODEL, mountTestContext, tempNotesDir } from './harness.ts'

const CALL_ID = ToolCallId('recall-search-call-1')

/** A phrase that appears in the fixture only inside the tool result. */
const RESULT_ONLY_PHRASE = 'calibration-ledger-7f3a'

/** The tool result text: plain lines followed by an image block. */
const RESULT_TEXT = ['measured drift 0.4 mm', `ledger entry ${RESULT_ONLY_PHRASE}`, 'sample count 12'].join('\n')

/** The assistant's own text, which must never stand in for the tool result. */
const ASSISTANT_TEXT = 'ASSISTANT-TEXT reading the calibration table'

/** The prior checkpoint body, which fits the default recall budget. */
const CHECKPOINT_BODY = 'checkpoint body: the seam was verified on 2026-11-14 and the fixture is bound'

/** The stored image the tool result carries the reference of. */
const IMAGE_REF: ImageAttachmentRef = {
  attachmentId: AttachmentId(`sha256:${'2'.repeat(64)}`),
  mediaType: 'image/png',
  bytes: 8,
  width: 1,
  height: 1,
}

/** One fixture session with its interesting positions. */
interface Fixture {
  readonly ctx: Context
  readonly agent: Agent
  readonly session: Session
  /** Seq of the direct user message. */
  readonly userSeq: number
  /** Seq of the assistant message carrying the tool call. */
  readonly assistantSeq: number
  /** Seq of the tool result carrying an image. */
  readonly resultSeq: number
  /** Seq of the rollover checkpoint node. */
  readonly checkpointSeq: number
  /** Seq of the long verbose instruction. */
  readonly verboseSeq: number
}

/** Every context a fixture mounted, disposed after the test. */
const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

/** Append one event and return its seq. */
function appendSeq(session: Session, append: () => void): number {
  append()
  return Number(session.seq) - 1
}

/** Open one turn and step, so a message and its result land inside a turn the invariants accept. */
function openTurn(session: Session, turn: number): void {
  session.append('turn/start', { turn })
  session.append('step/start', { turn, step: 1 })
}

/** Append one direct user message and return its seq. */
function appendUserText(session: Session, text: string): number {
  return appendSeq(session, () => {
    session.append(
      'user/message',
      createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }),
      { surfaceOp: 'append' },
    )
  })
}

/**
 * Build the fixture log, then mount the engine at the end of it: only a log
 * appended before the engine loads reaches the loaded session, and on this
 * rosterless harness context the engine owns the model surface.
 * @param id - session id.
 * @returns the mounted context and the fixture positions.
 */
async function fixture(id: string): Promise<Fixture> {
  const ctx = await mountTestContext()
  contexts.push(ctx)
  const agent = await ctx.agentLoop.create(SessionId(id), { provider: MODEL, model: MODEL })
  const session = agent.session
  openTurn(session, 1)
  const userSeq = appendUserText(session, 'read the calibration table')
  const assistantSeq = appendSeq(session, () => {
    session.append('assistant/message', {
      turn: 1,
      step: 1,
      stream: [],
      message: createAssistantMessage({
        source: { provider: MODEL, model: MODEL },
        content: [
          { type: 'text', text: ASSISTANT_TEXT },
          { type: 'tool-call', id: CALL_ID, name: 'read', arguments: '{"file_path":"calibration.txt"}' },
        ],
      }),
    }, { surfaceOp: 'append' })
  })
  const resultSeq = appendSeq(session, () => {
    session.append('tool/call', { turn: 1, step: 1, callId: CALL_ID, name: 'read', arguments: '{"file_path":"calibration.txt"}' })
    session.append('tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: CALL_ID,
        isError: false,
        content: [
          { type: 'text', text: RESULT_TEXT },
          { type: 'image', attachment: IMAGE_REF },
        ],
      }),
    }, { surfaceOp: 'append' })
  })
  const checkpointSeq = appendSeq(session, () => {
    session.append(
      'user/message',
      createUserMessage({
        content: [{ type: 'text', text: CHECKPOINT_BODY }],
        source: compactCheckpointSource('fixture-compaction' as never),
      }),
      { surfaceOp: 'append' },
    )
  })
  const verboseSeq = appendUserText(session, `VERBOSE-INSTRUCTION ${Array.from({ length: 60 }, () => 'word').join(' ')}`)
  session.append('step/end', { turn: 1, step: 1 })
  session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
  // Mount the read-back tools the way the host row does, last: one engine on a
  // rosterless context owns the model surface.
  expect(ctx.get('agentPresets')).toBeUndefined()
  new ContextRolloverEngine(ctx, { notesDir: await tempNotesDir() })
  return { ctx, agent, session, userSeq, assistantSeq, resultSeq, checkpointSeq, verboseSeq }
}

/** Execute one tool through the registry and return its model-visible text. */
async function runTool(
  fx: Fixture,
  name: string,
  args: Record<string, unknown>,
): Promise<{ text: string; isError: boolean }> {
  const result = await fx.ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`${name}-${Number(fx.session.seq)}`),
    name,
    arguments: args,
    agent: fx.agent,
  })
  return {
    isError: result.isError === true,
    text: result.content.map(block => block.type === 'text' ? block.text ?? '' : `[${block.type}]`).join('\n'),
  }
}

describe('recall by seq', () => {
  it('returns the complete text of the named position with its log position', async () => {
    const fx = await fixture('recall-seq-user')
    const { text, isError } = await runTool(fx, 'recall', { type: 'seq', ref: String(fx.userSeq) })
    expect(isError).toBe(false)
    expect(text).toContain(`[seq ${fx.userSeq}: user]`)
    expect(text).toContain('read the calibration table')
  })

  it('keeps the tool call, its raw arguments, and the result pointer', async () => {
    const fx = await fixture('recall-seq-assistant')
    const { text } = await runTool(fx, 'recall', { type: 'seq', ref: String(fx.assistantSeq) })
    expect(text).toContain(ASSISTANT_TEXT)
    expect(text).toContain('[tool-call read]')
    expect(text).toContain('calibration.txt')
  })

  it('names the requested position that does not exist', async () => {
    const fx = await fixture('recall-seq-missing')
    const { text, isError } = await runTool(fx, 'recall', { type: 'seq', ref: '99999' })
    expect(isError).toBe(true)
    expect(text).toContain('seq(s) 99999 not found')
    expect(text).toContain(`this log ends at seq ${Number(fx.session.seq) - 1}`)
  })
})

describe('recall by result position', () => {
  it('returns the tool result projection as text, not a bare marker', async () => {
    const fx = await fixture('recall-result')
    const { text, isError } = await runTool(fx, 'recall', { type: 'result', ref: `result ${fx.resultSeq}` })
    expect(isError).toBe(false)
    expect(text).toContain(`[seq ${fx.resultSeq}: tool]`)
    expect(text).toContain(RESULT_ONLY_PHRASE)
    expect(text).toContain('measured drift 0.4 mm')
    expect(text).not.toContain(ASSISTANT_TEXT)
  })

  it('names a position that is not a tool result', async () => {
    const fx = await fixture('recall-result-wrong-kind')
    const { text, isError } = await runTool(fx, 'recall', { type: 'result', ref: String(fx.userSeq) })
    expect(isError).toBe(true)
    expect(text).toContain(`seq ${fx.userSeq} is not a tool result`)
    expect(text).toContain('user/message')
  })
})

describe('recall by checkpoint ordinal', () => {
  it('returns the prior checkpoint body when it fits', async () => {
    const fx = await fixture('recall-checkpoint')
    const { text, isError } = await runTool(fx, 'recall', { type: 'checkpoint', ref: '1' })
    expect(isError).toBe(false)
    expect(text).toContain(`[seq ${fx.checkpointSeq}: user]`)
    expect(text).toContain(CHECKPOINT_BODY)
  })

  it('names the ordinal that does not exist and counts the checkpoints', async () => {
    const fx = await fixture('recall-checkpoint-missing')
    const { text, isError } = await runTool(fx, 'recall', { type: 'checkpoint', ref: '2' })
    expect(isError).toBe(true)
    expect(text).toContain('checkpoint 2 not found')
    expect(text).toContain('this session has 1 checkpoint(s)')
  })
})

describe('media', () => {
  it('comes back as one label, never as the reference or invented text', async () => {
    const fx = await fixture('recall-media')
    const { text } = await runTool(fx, 'recall', { type: 'seq', ref: String(fx.resultSeq) })
    expect(text.split('[image]').length - 1).toBe(1)
    expect(text).not.toContain(IMAGE_REF.attachmentId)
  })
})

describe('recall budget', () => {
  it('cuts an over-budget record with a marker naming the cut', async () => {
    const fx = await fixture('recall-budget')
    const { text, isError } = await runTool(fx, 'recall', { type: 'seq', ref: String(fx.verboseSeq), max_tokens: 20 })
    expect(isError).toBe(false)
    expect(text).toContain('VERBOSE-INSTRUCTION')
    expect(text).toContain('truncated from recall budget')
    expect(text).toContain(`reply with recall({ type: "seq", ref: "${fx.verboseSeq}" })`)
  })

  it('cuts a record that is itself wider than its budget', async () => {
    // 20 tokens cannot hold the 62-token verbose instruction, and nothing cuts
    // this record before the budget does.
    const fx = await fixture('recall-budget-wider')
    const { text } = await runTool(fx, 'recall', {
      type: 'seq',
      ref: String(fx.verboseSeq),
      max_tokens: 22,
    })
    expect(text).toContain('truncated from recall budget')
    // The cut lands early: fewer words survive than the record holds.
    expect(text.split(' word').length - 1).toBeLessThan(20)
  })

  it('reads a selection of many positions only up to the budget', async () => {
    const fx = await fixture('recall-range-bound')
    const { text } = await runTool(fx, 'recall', {
      type: 'seq',
      ref: `${fx.userSeq}-${Number(fx.session.seq) + 1000}`,
      max_tokens: 10,
    })
    expect(text).toContain('call recall again for the remaining positions or raise max_tokens')
    expect(text.split('\n\n').length).toBeLessThanOrEqual(3)
  })
})

describe('search', () => {
  it('finds a phrase that exists only inside a tool result and reports its position', async () => {
    const fx = await fixture('search-result')
    const { text, isError } = await runTool(fx, 'search', { query: RESULT_ONLY_PHRASE })
    expect(isError).toBe(false)
    expect(text).toContain(`[search "${RESULT_ONLY_PHRASE}": 1 matching record(s)`)
    expect(text).toContain(`[seq ${fx.resultSeq}: tool]`)
    expect(text).toContain(RESULT_ONLY_PHRASE)
  })

  it('reads a query as a case-insensitive regular expression', async () => {
    const fx = await fixture('search-regex')
    const keyword = await runTool(fx, 'search', { query: 'MEASURED\\s+DRIFT 0\\.4' })
    expect(keyword.text).toContain(`[seq ${fx.resultSeq}: tool]`)
    const pattern = await runTool(fx, 'search', { query: 'ledger-[0-9a-f]{4}' })
    expect(pattern.text).toContain(`[seq ${fx.resultSeq}: tool]`)
  })

  it('reports a record appended after an earlier search instead of serving a stale snapshot', async () => {
    const fx = await fixture('search-after-read')
    const first = await runTool(fx, 'search', { query: 'late-arrival' })
    expect(first.text).toContain('[no matches in this session log]')
    const lateSeq = appendUserText(fx.session, 'late-arrival record')
    const second = await runTool(fx, 'search', { query: 'late-arrival' })
    expect(second.text).toContain(`[seq ${lateSeq}: user]`)
  })

  it('never presents a checkpoint body as a searchable record', async () => {
    const fx = await fixture('search-checkpoint')
    const { text } = await runTool(fx, 'search', { query: 'the seam was verified' })
    expect(text).toContain('[no matches in this session log]')
    expect(text).not.toContain(`[seq ${fx.checkpointSeq}`)
  })

  it('names a pattern that does not compile', async () => {
    const fx = await fixture('search-bad-pattern')
    const { text, isError } = await runTool(fx, 'search', { query: 'ledger-(' })
    expect(isError).toBe(true)
    expect(text).toContain('invalid search pattern "ledger-("')
  })

  it('names a blank query', async () => {
    const fx = await fixture('search-empty')
    const { text, isError } = await runTool(fx, 'search', { query: '   ' })
    expect(isError).toBe(true)
    expect(text).toContain('invalid search pattern "   "')
  })
})

describe('the modules behind the tools', () => {
  it('defaults the recall budget to VCC\'s published value', () => {
    expect(DEFAULT_MAX_RECALL_TOKENS).toBe(16000)
  })

  it('bounds the projection by the budget it was given', async () => {
    const fx = await fixture('recall-module-budget')
    expect(recallBySeq(fx.session, String(fx.userSeq), 16).text).toContain('read the calibration table')
    const narrow = recallBySeq(fx.session, String(fx.userSeq), 3)
    expect(narrow.text).toContain('truncated from recall budget')
    expect(narrow.text).not.toContain('read the calibration table')
    expect(recallByResult(fx.session, String(fx.resultSeq), 16000).text).toContain(RESULT_ONLY_PHRASE)
    expect(recallByCheckpoint(fx.session, '1', 16000).text).toContain(CHECKPOINT_BODY)
    expect(searchLog(fx.session, RESULT_ONLY_PHRASE, 16000).text).toContain(`[seq ${fx.resultSeq}: tool]`)
  })
})

describe('the registry', () => {
  it('holds both tools when the model surface is enabled', async () => {
    const { ctx } = await engineHarness('registry-surface-on', { modelSurface: 'always' })
    expect(ctx.tools.get('recall')).toBeDefined()
    expect(ctx.tools.get('search')).toBeDefined()
  })

  it('holds neither when a preset roster exists and the row does not own the surface', async () => {
    const notesBase = await mkdtemp(join(tmpdir(), 'rollover-registry-off-'))
    const ctx = await mountTestContext()
    try {
      // The engine reads the roster through a typed service; a provider stub
      // with the one method it calls is the roster.
      const providerCtx = ctx as unknown as { provide(name: string, value: unknown): void }
      providerCtx.provide('agentPresets', { serviceFor: () => undefined })
      new ContextRolloverEngine(ctx, { notesDir: notesBase })
      expect(ctx.tools.get('new_context')).toBeUndefined()
      expect(ctx.tools.get('recall')).toBeUndefined()
      expect(ctx.tools.get('search')).toBeUndefined()
    } finally {
      await rm(notesBase, { recursive: true, force: true })
    }
  })
})
