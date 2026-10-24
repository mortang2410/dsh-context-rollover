/**
 * The `new_context` guard. A second accepted call within five minutes is
 * refused, and so is a handoff document last modified more than five minutes
 * ago, or one dated later than now. Each refusal is a normal result, not a tool
 * error, whose text opens with a warning and gives the reason. A refused call
 * starts no clock.
 *
 * Only `Date` is faked. Each handoff's modification time is set on the same
 * clock with `utimes`, so every boundary is exact to the millisecond.
 *
 * @module tests/new-context-guard
 */

import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { engineHarness, MODEL, ScriptedAdapter, seedExchanges, textResponse } from './harness.ts'
import { NEW_CONTEXT_ACCEPTED_TEXT, NEW_CONTEXT_CLOCK } from '../src/tools.ts'

const FIVE_MINUTES_MS = 5 * 60 * 1000

/** A fixed start time, a whole second, so every instant in a case is exact. */
const T0 = Date.parse('2026-10-24T15:00:00Z')

/** Scratch directories removed after the run. */
const scratchDirs: string[] = []

afterAll(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(T0)
})

afterEach(() => {
  vi.useRealTimers()
})

/** Call `new_context` through the registry, without requiring success. */
function callNewContext(ctx: Context, agent: Agent, handoffPath: string, callId: string) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name: 'new_context',
    arguments: { handoff_path: handoffPath },
    agent,
  })
}

/** The model-visible text of a tool result. */
function textOf(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content
    .map(block => (block.type === 'text' ? block.text ?? '' : ''))
    .join('\n')
}

/**
 * Assert that a call was refused and return its text. A refusal is a normal
 * result, not accepted, whose model-visible text opens with the warning.
 */
function refusedText(result: Awaited<ReturnType<typeof callNewContext>>): string {
  expect(result.isError).toBeFalsy()
  expect(result.value).toMatchObject({ accepted: false })
  const text = textOf(result)
  expect(text.startsWith('Warning: new_context was refused')).toBe(true)
  return text
}

/** Set a file's modification time to `at` (epoch ms). */
async function touch(path: string, at: number): Promise<void> {
  const seconds = at / 1000
  await utimes(path, seconds, seconds)
}

/** A handoff document whose modification time is `at` (epoch ms). */
async function handoffModifiedAt(at: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-new-context-guard-'))
  scratchDirs.push(dir)
  const path = join(dir, 'HANDOFF-guard.md')
  await writeFile(path, '# Handoff\n\nContinue from the notes.\n', 'utf8')
  await touch(path, at)
  return path
}

/** A session with closed exchanges, so a rollover has a span to replace. */
async function seededSession(id: string) {
  const harness = await engineHarness(id)
  harness.ctx.llm.registerAdapter(['mock'], new ScriptedAdapter(
    Array.from({ length: 12 }, (_unused, index) => textResponse(`guard filler ${index}`)),
  ))
  await seedExchanges(harness.agent, 12)
  return harness
}

describe('new_context gap rule', () => {
  it('refuses a second accepted call inside five minutes, with a warning that gives the next allowed time', async () => {
    const { ctx, agent } = await seededSession('guard-gap')
    const path = await handoffModifiedAt(T0)

    const first = await callNewContext(ctx, agent, path, 'g-1')
    expect(first.isError).toBeFalsy()
    expect(first.value).toMatchObject({ accepted: true })

    vi.setSystemTime(T0 + 60_000)
    const warning = refusedText(await callNewContext(ctx, agent, path, 'g-2'))
    expect(warning).toContain('accepted 1 min ago')
    expect(warning).toContain(new Date(T0 + FIVE_MINUTES_MS).toISOString())
  })

  it('accepts a call again once exactly five minutes have passed', async () => {
    const { ctx, agent } = await seededSession('guard-boundary')
    const path = await handoffModifiedAt(T0)
    expect((await callNewContext(ctx, agent, path, 'b-1')).isError).toBeFalsy()

    vi.setSystemTime(T0 + FIVE_MINUTES_MS)
    await touch(path, T0 + FIVE_MINUTES_MS)
    const again = await callNewContext(ctx, agent, path, 'b-2')
    expect(again.isError).toBeFalsy()
    expect(again.value).toMatchObject({ accepted: true })
  })

  it('a gap refusal does not extend the gap: the next call is allowed five minutes after the accepted one', async () => {
    const { ctx, agent } = await seededSession('guard-no-extend')
    const path = await handoffModifiedAt(T0)
    expect((await callNewContext(ctx, agent, path, 'x-1')).isError).toBeFalsy()

    vi.setSystemTime(T0 + 4 * 60_000)
    refusedText(await callNewContext(ctx, agent, path, 'x-2'))

    vi.setSystemTime(T0 + FIVE_MINUTES_MS)
    await touch(path, T0 + FIVE_MINUTES_MS)
    const later = await callNewContext(ctx, agent, path, 'x-3')
    expect(later.isError).toBeFalsy()
    expect(later.value).toMatchObject({ accepted: true })
  })
})

describe('new_context freshness rule', () => {
  it('refuses a handoff document last modified more than five minutes ago, with a warning', async () => {
    const { ctx, agent } = await seededSession('guard-stale')
    const path = await handoffModifiedAt(T0 - FIVE_MINUTES_MS - 1000)

    const warning = refusedText(await callNewContext(ctx, agent, path, 's-1'))
    expect(warning).toContain(path)
    expect(warning).toContain('last modified 5 min 1 s ago')
    expect(warning).toContain('within the last 5 min')
  })

  it('refuses a handoff document whose modification time is later than now, with a warning', async () => {
    const { ctx, agent } = await seededSession('guard-future')
    const path = await handoffModifiedAt(T0 + 60_000)

    const future = refusedText(await callNewContext(ctx, agent, path, 'f-1'))
    expect(future).toContain(path)
    expect(future).toContain('later than the current time')

    await touch(path, T0)
    const saved = await callNewContext(ctx, agent, path, 'f-2')
    expect(saved.isError).toBeFalsy()
    expect(saved.value).toMatchObject({ accepted: true })
  })

  it('accepts a handoff document modified exactly five minutes ago', async () => {
    const { ctx, agent } = await seededSession('guard-age-edge')
    const path = await handoffModifiedAt(T0 - FIVE_MINUTES_MS)

    const result = await callNewContext(ctx, agent, path, 'e-1')
    expect(result.isError).toBeFalsy()
    expect(result.value).toMatchObject({ accepted: true })
  })

  it('a refused call starts no clock: a fresh handoff is accepted at once after a stale refusal', async () => {
    const { ctx, agent } = await seededSession('guard-no-clock')
    const path = await handoffModifiedAt(T0 - FIVE_MINUTES_MS - 1000)
    refusedText(await callNewContext(ctx, agent, path, 'n-1'))

    await touch(path, T0)
    const fresh = await callNewContext(ctx, agent, path, 'n-2')
    expect(fresh.isError).toBeFalsy()
    expect(fresh.value).toMatchObject({ accepted: true })
  })
})

/** Drop the in-memory clock, as a host restart does. The durable log keeps its record. */
function forgetInMemoryClock(session: Session): void {
  delete (session as unknown as Record<symbol, unknown>)[NEW_CONTEXT_CLOCK]
}

/**
 * Append one `new_context` call and its result to a session's durable log, in
 * the shape the engine logs a model tool call. The turn numbers used here sit
 * far above the seeded exchanges.
 */
function logNewContextResult(session: Session, turn: number, text: string, isError: boolean): void {
  const callId = ToolCallId(`logged-${turn}`)
  session.append('turn/start', { turn })
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: `logged call ${turn}` }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  session.append('step/start', { turn, step: 1 })
  session.append('assistant/message', {
    stream: [],
    turn,
    step: 1,
    message: createAssistantMessage({
      content: [{ type: 'tool-call', id: callId, name: 'new_context', arguments: '{"handoff_path":"logged"}' }],
      source: { provider: MODEL, model: MODEL },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn, step: 1, callId, name: 'new_context', arguments: '{"handoff_path":"logged"}' })
  session.append('tool/result', {
    turn,
    step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text }], isError }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn, step: 1 })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
}

describe('new_context restart rule', () => {
  it('keeps the gap after a restart clears the in-memory clock, using the accepted result in the durable log', async () => {
    const { ctx, agent, session } = await seededSession('guard-restart')
    const path = await handoffModifiedAt(T0)
    expect((await callNewContext(ctx, agent, path, 'k-1')).isError).toBeFalsy()
    logNewContextResult(session, 13, NEW_CONTEXT_ACCEPTED_TEXT, false)

    forgetInMemoryClock(session)
    vi.setSystemTime(T0 + 60_000)
    const warning = refusedText(await callNewContext(ctx, agent, path, 'k-2'))
    expect(warning).toContain('accepted 1 min ago')
  })

  it('a refused call in the log starts no clock', async () => {
    const { ctx, agent, session } = await seededSession('guard-logged-refusal')
    logNewContextResult(session, 13, 'Warning: new_context was refused, so this call does not start a new context window. Reason: test.', false)

    vi.setSystemTime(T0 + 60_000)
    const path = await handoffModifiedAt(T0 + 60_000)
    const result = await callNewContext(ctx, agent, path, 'lr-1')
    expect(result.isError).toBeFalsy()
    expect(result.value).toMatchObject({ accepted: true })
  })

  it('an error result that carries the accepted text starts no clock', async () => {
    const { ctx, agent, session } = await seededSession('guard-logged-error')
    logNewContextResult(session, 13, NEW_CONTEXT_ACCEPTED_TEXT, true)

    vi.setSystemTime(T0 + 60_000)
    const path = await handoffModifiedAt(T0 + 60_000)
    const result = await callNewContext(ctx, agent, path, 'le-1')
    expect(result.isError).toBeFalsy()
    expect(result.value).toMatchObject({ accepted: true })
  })

  it('a result that did not accept the call (preset-owned session) starts no clock', async () => {
    const { ctx, agent, session } = await seededSession('guard-not-owned')
    logNewContextResult(
      session,
      13,
      'No new context window will start: this session compacts through its agent preset, not through context rollover.',
      false,
    )

    vi.setSystemTime(T0 + 60_000)
    const path = await handoffModifiedAt(T0 + 60_000)
    const result = await callNewContext(ctx, agent, path, 'no-1')
    expect(result.isError).toBeFalsy()
    expect(result.value).toMatchObject({ accepted: true })
  })

  it('the clock is per session: an accepted call logged in another session does not gate this one', async () => {
    const first = await seededSession('guard-isolation-a')
    const second = await seededSession('guard-isolation-b')
    logNewContextResult(first.session, 13, NEW_CONTEXT_ACCEPTED_TEXT, false)

    vi.setSystemTime(T0 + 60_000)
    const path = await handoffModifiedAt(T0 + 60_000)
    const result = await callNewContext(second.ctx, second.agent, path, 'iso-1')
    expect(result.isError).toBeFalsy()
    expect(result.value).toMatchObject({ accepted: true })
  })
})
