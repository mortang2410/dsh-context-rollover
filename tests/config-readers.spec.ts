/**
 * Configuration readers that change observable behavior and had no test that
 * would fail if the reader were broken: the recent-tail ratio, the handoff size
 * limit, the notes directory, and the two optional tool flags.
 *
 * @module tests/config-readers
 */

import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { resolveConfig } from '../src/config.ts'
import { NotesStore } from '../src/notes.ts'
import { selectionFor } from '../src/rollover.ts'
import { engineHarness, seedExchanges } from './harness.ts'

describe('retainRatio', () => {
  it('sizes the recent tail from the context window when retainTokens is unset', () => {
    const session = {
      requestContext: () => ({ contextWindow: 100_000, model: 'test' }),
    } as unknown as Session
    expect(selectionFor(resolveConfig({ retainRatio: 0.5 }), session)).toEqual({ kind: 'tail', retainTokens: 50_000 })
    expect(selectionFor(resolveConfig({ retainRatio: 0.2 }), session)).toEqual({ kind: 'tail', retainTokens: 20_000 })
  })
})

describe('retainTokens under handoffOnly', () => {
  const session = {
    requestContext: () => ({ contextWindow: 100_000, model: 'test' }),
  } as unknown as Session

  it('keeps a tail of that budget, through the same rule tail mode uses', () => {
    expect(selectionFor(resolveConfig({ handoffOnly: true, retainTokens: 10_000 }), session))
      .toEqual({ kind: 'tail', retainTokens: 10_000 })
  })

  it('hands a zero budget to the tail rule, which still keeps the last node', () => {
    expect(selectionFor(resolveConfig({ handoffOnly: true, retainTokens: 0 }), session))
      .toEqual({ kind: 'tail', retainTokens: 0 })
  })

  it('keeps no tail when handoffOnly names no retainTokens', () => {
    expect(selectionFor(resolveConfig({ handoffOnly: true }), session)).toEqual({ kind: 'handoff-only' })
  })

  it('still ignores retainRatio under handoffOnly', () => {
    expect(selectionFor(resolveConfig({ handoffOnly: true, retainRatio: 0.5 }), session))
      .toEqual({ kind: 'handoff-only' })
  })
})

describe('handoffMaxChars', () => {
  it('refuses a handoff document longer than the configured limit', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rollover-max-chars-'))
    await writeFile(join(dir, 'HANDOFF-big.md'), 'x'.repeat(2048))
    const { ctx, agent } = await engineHarness('config-max-chars', { handoffMaxChars: 100 }, { cwd: dir })
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('max-chars-1'),
      name: 'new_context',
      arguments: { handoff_path: 'HANDOFF-big.md' },
      agent,
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('handoffMaxChars')
  })
})

describe('notesDir', () => {
  it('writes session notes under the configured directory', async () => {
    const base = await mkdtemp(join(tmpdir(), 'rollover-notes-dir-'))
    const { ctx, agent, session } = await engineHarness('config-notes-dir', { notesDir: base })
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: ToolCallId('notes-dir-1'),
      name: 'notes',
      arguments: { action: 'write', path: 'state.md', text: 'configured directory marker' },
      agent,
    })
    expect(result.isError).toBeFalsy()
    const written = await readFile(join(NotesStore.directoryFor(session.id, base), 'state.md'), 'utf8')
    expect(written).toContain('configured directory marker')
  })
})

describe('notesEnabled and historyEnabled', () => {
  it('mounts both optional tools by default', async () => {
    const { ctx } = await engineHarness('config-tools-default', {})
    expect(ctx.tools.get('notes')).toBeDefined()
    expect(ctx.tools.get('history')).toBeDefined()
  })

  it('omits the notes tool when notesEnabled is false', async () => {
    const { ctx } = await engineHarness('config-notes-off', { notesEnabled: false })
    expect(ctx.tools.get('notes')).toBeUndefined()
    expect(ctx.tools.get('history')).toBeDefined()
  })

  it('omits the history tool when historyEnabled is false', async () => {
    const { ctx } = await engineHarness('config-history-off', { historyEnabled: false })
    expect(ctx.tools.get('history')).toBeUndefined()
    expect(ctx.tools.get('notes')).toBeDefined()
  })
})

describe('notesEnabled in a manual checkpoint', () => {
  /** Whether a manual checkpoint carries the session's notes text. */
  async function checkpointCarriesNotes(notesEnabled: boolean, id: string): Promise<boolean> {
    const { agent, engine, session, notesBase } = await engineHarness(id, { notesEnabled })
    const dir = NotesStore.directoryFor(session.id, notesBase)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'state.md'), 'NOTES-MARKER goal line')
    await seedExchanges(agent, 20)
    const result = await engine.compactNow(agent, new AbortController().signal)
    expect(result).not.toBeNull()
    return JSON.stringify(result).includes('NOTES-MARKER')
  }

  it('includes the notes in a manual checkpoint when notesEnabled is true', async () => {
    expect(await checkpointCarriesNotes(true, 'config-checkpoint-on')).toBe(true)
  })

  it('leaves the notes out of a manual checkpoint when notesEnabled is false', async () => {
    expect(await checkpointCarriesNotes(false, 'config-checkpoint-off')).toBe(false)
  })
})

describe('handoffMaxChars on a manual checkpoint', () => {
  /** Whether a manual checkpoint carries the notes' trailing marker, under a given size limit. */
  async function checkpointCarriesTail(handoffMaxChars: number, id: string): Promise<boolean> {
    const { agent, engine, session, notesBase } = await engineHarness(id, { handoffMaxChars })
    const dir = NotesStore.directoryFor(session.id, notesBase)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'state.md'), `${'x'.repeat(400)} TAIL-MARKER`)
    await seedExchanges(agent, 20)
    const result = await engine.compactNow(agent, new AbortController().signal)
    expect(result).not.toBeNull()
    return JSON.stringify(result).includes('TAIL-MARKER')
  }

  it('keeps the trailing notes when the limit is the default', async () => {
    expect(await checkpointCarriesTail(20000, 'config-checkpoint-cap-default')).toBe(true)
  })

  it('caps the notes in a manual checkpoint at handoffMaxChars', async () => {
    expect(await checkpointCarriesTail(120, 'config-checkpoint-cap-small')).toBe(false)
  })
})
