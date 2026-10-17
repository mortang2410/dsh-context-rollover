/**
 * Tool rendering tests: every `notes` and `history` branch returns the stable
 * `{ action, text }` shape the renderer reads, verified through the actual DSH
 * tool runtime (execute + render), not only the underlying stores — so the
 * assertions cover the final model-visible content.
 *
 * @module tests/tools.spec
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Context } from '@deepseek-ai/cordis'
import { CONTEXT_MANAGEMENT_GUIDANCE } from '../src/guidance.ts'
import { NotesStore } from '../src/notes.ts'
import { countRollovers } from '../src/rollover.ts'
import {
  engineHarness,
  followup,
  ScriptedAdapter,
  seedExchanges,
  tempNotesDir,
  textResponse,
} from './harness.ts'

/** Execute one tool through the registry and require success. */
async function executeTool(
  ctx: Context,
  agent: Agent,
  name: string,
  args: Record<string, unknown>,
  callId: string,
) {
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(callId),
    name,
    arguments: args,
    agent,
  })
  if (result.isError) throw new Error(`tool ${name} failed: ${JSON.stringify(result.content)}`)
  return result
}

/** The final model-visible text of a successful tool result. */
function renderedText(result: { content: readonly { type: string; text?: string }[] }): string {
  return result.content
    .map(block => block.type === 'text' ? block.text ?? '' : `[${block.type}]`)
    .join('\n')
}

describe('notes tool rendering', () => {
  it('renders write, append, read, and a non-empty list', async () => {
    const { ctx, agent } = await engineHarness('tools-notes-list')
    await executeTool(ctx, agent, 'notes', { action: 'write', path: 'state.md', text: 'goal: prove rendering' }, 'n1')
    await executeTool(ctx, agent, 'notes', { action: 'append', path: 'state.md', text: 'next: tests' }, 'n2')
    await executeTool(ctx, agent, 'notes', { action: 'write', path: 'plans/rollout.md', text: 'step 1' }, 'n3')

    const read = await executeTool(ctx, agent, 'notes', { action: 'read', path: 'state.md' }, 'n4')
    expect(renderedText(read)).toContain('goal: prove rendering')
    expect(renderedText(read)).toContain('next: tests')

    const list = await executeTool(ctx, agent, 'notes', { action: 'list' }, 'n5')
    const listText = renderedText(list)
    expect(listText).toContain('state.md')
    expect(listText).toContain('plans/rollout.md')
    expect(listText).not.toContain('undefined')
    expect(list.value).toMatchObject({ action: 'list' })
    expect((list.value as { text?: unknown }).text).toContain('state.md')
  })

  it('renders search hits', async () => {
    const { ctx, agent } = await engineHarness('tools-notes-search')
    await executeTool(ctx, agent, 'notes', { action: 'write', path: 'state.md', text: 'decided: no summary' }, 's1')

    const search = await executeTool(ctx, agent, 'notes', { action: 'search', query: 'SUMMARY' }, 's2')
    const searchText = renderedText(search)
    expect(searchText).toContain('state.md')
    expect(searchText).toContain('decided: no summary')
    expect(searchText).not.toContain('undefined')
  })
})

describe('history tool rendering', () => {
  it('renders search hits from earlier windows', async () => {
    const { ctx, engine, agent, session } = await engineHarness('tools-history-search')
    const adapter = new ScriptedAdapter(
      Array.from({ length: 30 }, (_unused, index) => textResponse(`background detail ${index}`)),
    )
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 20)
    await followup(agent, 'orchard harvest plan')
    const compacted = await engine.compactNow(agent, new AbortController().signal)
    expect(compacted).not.toBeNull()
    expect(countRollovers(session)).toBe(1)

    const search = await executeTool(ctx, agent, 'history', { action: 'search', query: 'research question 0' }, 'h1')
    const searchText = renderedText(search)
    expect(searchText).toContain('research question 0')
    expect(searchText).toContain('[seq ')
    expect(searchText).not.toContain('undefined')
  })

  it('renders a full read of a shadowed item', async () => {
    const { ctx, engine, agent } = await engineHarness('tools-history-read')
    const adapter = new ScriptedAdapter(
      Array.from({ length: 30 }, (_unused, index) => textResponse(`background detail ${index}`)),
    )
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 20)
    await followup(agent, 'orchard harvest plan')
    const compacted = await engine.compactNow(agent, new AbortController().signal)
    expect(compacted).not.toBeNull()

    const search = await executeTool(ctx, agent, 'history', { action: 'search', query: 'research question 1' }, 'h1')
    const seqMatch = /\[seq (\d+)\]/.exec(renderedText(search))
    if (seqMatch?.[1] === undefined) throw new Error('expected a history search hit with a seq')
    const read = await executeTool(ctx, agent, 'history', { action: 'read', seq: Number(seqMatch[1]) }, 'h2')
    const readText = renderedText(read)
    expect(readText).toContain('research question 1')
    expect(readText).toContain('[seq ')
    expect(readText).not.toContain('undefined')
    expect(read.value).toMatchObject({ action: 'read' })
  })
})

/** The absolute path a notes reply or list line names after " at ", when it has one. */
function absolutePathAfterAt(text: string): string | undefined {
  return / at (\/.+?)\.?$/.exec(text)?.[1]
}

describe('notes replies carry the absolute path new_context accepts', () => {
  const handoffName = 'HANDOFF-row-p.md'
  const handoffText = '# Handoff\n\nContinue from the notes entry.\n'

  /** A session with closed exchanges, so a rollover has a span to replace. */
  async function seededSession(id: string) {
    const harness = await engineHarness(id)
    harness.ctx.llm.registerAdapter(['mock'], new ScriptedAdapter(
      Array.from({ length: 12 }, (_unused, index) => textResponse(`notes filler ${index}`)),
    ))
    await seedExchanges(harness.agent, 12)
    return harness
  }

  it('a write reply names an absolute path that new_context accepts', async () => {
    const { ctx, agent, session, notesBase } = await seededSession('notes-accept-write')
    const expected = resolve(NotesStore.directoryFor(session.id, notesBase), handoffName)

    const write = await executeTool(
      ctx,
      agent,
      'notes',
      { action: 'write', path: handoffName, text: handoffText },
      'rp-a1',
    )
    expect(renderedText(write)).toContain(expected)
    const written = absolutePathAfterAt(renderedText(write))
    if (written === undefined) throw new Error('expected an absolute path in the write reply')
    expect(isAbsolute(written)).toBe(true)

    const accepted = await executeTool(ctx, agent, 'new_context', { handoff_path: written }, 'rp-a2')
    expect(accepted.value).toMatchObject({ accepted: true })
  })

  it('a relative notesDir still gives an absolute write reply that points at the written file', async () => {
    // The base is a temp directory reached through a path relative to the
    // process working directory, so the store root is relative too.
    const relativeBase = relative(process.cwd(), await tempNotesDir())
    expect(isAbsolute(relativeBase)).toBe(false)
    const { ctx, agent, session } = await engineHarness('notes-relative-dir', { notesDir: relativeBase })
    const expected = resolve(NotesStore.directoryFor(session.id, relativeBase), handoffName)

    const write = await executeTool(
      ctx,
      agent,
      'notes',
      { action: 'write', path: handoffName, text: handoffText },
      'rp-b1',
    )
    const written = absolutePathAfterAt(renderedText(write))
    if (written === undefined) throw new Error('expected an absolute path in the write reply')
    expect(isAbsolute(written)).toBe(true)
    expect(written).toBe(expected)
    expect(await readFile(written, 'utf8')).toBe(handoffText)
  })

  it('a list line carries the absolute path, and new_context accepts that path', async () => {
    const { ctx, agent, session, notesBase } = await seededSession('notes-accept-list')
    const expected = resolve(NotesStore.directoryFor(session.id, notesBase), handoffName)
    await executeTool(ctx, agent, 'notes', { action: 'write', path: handoffName, text: handoffText }, 'rp-c1')

    const list = await executeTool(ctx, agent, 'notes', { action: 'list' }, 'rp-c2')
    const line = renderedText(list).split('\n').find(candidate => candidate.startsWith(`${handoffName} (`))
    if (line === undefined) throw new Error('expected a list line for the handoff note')
    expect(line).toContain(expected)
    const listed = absolutePathAfterAt(line)
    if (listed === undefined) throw new Error('expected an absolute path on the list line')

    const accepted = await executeTool(ctx, agent, 'new_context', { handoff_path: listed }, 'rp-c3')
    expect(accepted.value).toMatchObject({ accepted: true })
  })

  it('an append reply names the absolute path of the note it appended to', async () => {
    const { ctx, agent, session, notesBase } = await seededSession('notes-accept-append')
    const expected = resolve(NotesStore.directoryFor(session.id, notesBase), handoffName)
    await executeTool(ctx, agent, 'notes', { action: 'write', path: handoffName, text: handoffText }, 'rp-d1')

    const append = await executeTool(
      ctx,
      agent,
      'notes',
      { action: 'append', path: handoffName, text: 'Next: run the tests.' },
      'rp-d2',
    )
    expect(renderedText(append)).toContain(expected)
  })

  it('the guidance tells the model to pass the absolute path its notes reply gave', () => {
    expect(CONTEXT_MANAGEMENT_GUIDANCE).toContain('absolute path')
    expect(CONTEXT_MANAGEMENT_GUIDANCE).toMatch(/notes[^.]*absolute path/)
  })

  it('the handoff_path description names the notes reply as the source of that absolute path', async () => {
    const { ctx } = await engineHarness('notes-accept-description')
    const definition = ctx.tools.get('new_context') as unknown as {
      parameters?: { properties?: Record<string, { description?: string }> }
    }
    const description = definition.parameters?.properties?.handoff_path?.description ?? ''
    expect(description).toContain('absolute path that the notes tool')
    expect(description).toContain('outside DSH it saves under `.scratch/handoff/HANDOFF-<topic-or-date>.md`')
  })
})
