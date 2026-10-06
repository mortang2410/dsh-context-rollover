/**
 * Handoff-only rollover: `new_context({ handoff_path })` replaces the entire
 * prior conversational surface with the durable handoff document's bytes.
 *
 * These tests exist to hold one claim down: after the rollover the
 * model-visible context is the standing system prompt plus the handoff
 * document, and NOTHING else from the old conversation. A test that only
 * looked for surviving sentinel text would miss a surviving assistant
 * tool-call block, whose visible content is a tool name and JSON arguments, so
 * every claim about what survived is also asserted by surface node type.
 *
 * @module tests/handoff-only
 */

import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createAssistantMessage, createSystemMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { resolveConfig } from '../src/config.ts'
import { sessionEventAt, sessionEvents } from '../src/compat.ts'
import { commitRollover, countRollovers, selectRolloverRange } from '../src/rollover.ts'
import { NotesStore } from '../src/notes.ts'
import {
  appendExchange,
  closedConversation,
  derivedTexts,
  engineHarness,
  followup,
  newContextCall,
  ScriptedAdapter,
  seedExchanges,
  textResponse,
} from './harness.ts'

/** Temp directories these tests create. */
const scratchDirs: string[] = []

afterAll(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

/** Create one scratch directory under the OS temp dir. */
async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

/** A meter mounted on a bare context, for direct selector and transaction tests. */
async function bareMeter(): Promise<TokenMeter> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(TokenMeter)
  return ctx.tokenMeter
}

/** The durable event type at each current surface position, head to tail. */
function surfaceNodeTypes(session: Session): string[] {
  return session.surface.nodes.map(seq => sessionEventAt(session, seq)?.type ?? 'missing')
}

/**
 * Record the surface's node types at each `compaction/end` this session writes.
 *
 * The rollover's own append order is `compaction/start`, `compaction/summary`,
 * the replacement `user/message`, `compaction/end`, so the surface is final for
 * the transaction by the time this fires — and no later turn has added
 * anything to it yet.
 */
function surfaceAtRolloverEnd(ctx: Context, session: Session): string[][] {
  const snapshots: string[][] = []
  ctx.on('session/event', (observed: Session, event: SessionEvent) => {
    if (observed !== session || event.type !== 'compaction/end') return
    snapshots.push(surfaceNodeTypes(session))
  })
  return snapshots
}

/** The durable event types in log order. */
function logTypes(session: Session): string[] {
  return sessionEvents(session).map(event => event.type as string)
}

describe('handoffOnly configuration', () => {
  it('defaults to false and rejects a non-boolean at load', () => {
    expect(resolveConfig({}).handoffOnly).toBe(false)
    expect(resolveConfig({ handoffOnly: true }).handoffOnly).toBe(true)
    expect(() => resolveConfig({ handoffOnly: 'yes' as unknown as boolean }))
      .toThrow(/handoffOnly must be a boolean/)
  })
})

describe('the handoffOnly selector', () => {
  it('keeps no priced tail, unlike retainTokens: 0', async () => {
    // The whole point of the mode: `retainTokens: 0` is NOT "no tail", because
    // the first backwards iteration already satisfies a zero budget. The two
    // rules must therefore disagree on the same measurement, and asserting the
    // disagreement is what makes this test fail if the mode is ever folded
    // back into the tail selector.
    const meter = await bareMeter()
    const session = closedConversation(4)
    const nodes = session.surface.nodes
    const last = nodes[nodes.length - 1]
    if (last === undefined) throw new Error('expected a surface tail')
    const measurement = meter.measure(session)

    const tail = selectRolloverRange(session, measurement, { kind: 'tail', retainTokens: 0 })
    const only = selectRolloverRange(session, measurement, { kind: 'handoff-only' })
    if (tail === null || only === null) throw new Error('expected both selectors to find a span')

    expect(tail.start).toBe(nodes[0])
    // A zero budget still retains the last node...
    expect(tail.end).not.toBe(last)
    expect(tail.shadowedSeqs).not.toContain(last)
    // ...while handoff-only covers it, one node further than the zero-budget cut.
    expect(only.end).toBe(last)
    expect(only.shadowedSeqs).toContain(last)
    expect(only.shadowedSeqs.length).toBe(tail.shadowedSeqs.length + 1)
    expect(only.start).toBe(nodes[0])
  })

  it('never includes a system/message at surface node 0 in the replaced span', async () => {
    const meter = await bareMeter()
    const session = Session.create(SessionId(`handoff-only-head-${Math.random().toString(36).slice(2, 8)}`))
    session.append('system/message', {
      turn: 1,
      step: 1,
      message: createSystemMessage('persona'),
    }, { surfaceOp: 'append' })
    appendExchange(session, 1, 'first')
    appendExchange(session, 2, 'second')
    const nodes = session.surface.nodes
    const range = selectRolloverRange(session, meter.measure(session), { kind: 'handoff-only' })
    if (range === null) throw new Error('expected a compactable range')
    // Newer hosts reject rewriting node 0 while it holds the system prompt.
    expect(range.start).toBe(nodes[1])
    expect(range.shadowedSeqs).not.toContain(nodes[0])
    // The span still runs to the last node: the head is excluded from the
    // span, not from the mode's no-tail rule.
    expect(range.end).toBe(nodes[nodes.length - 1])
  })

  it('returns null rather than a head-only span when the surface is just the system head', async () => {
    const meter = await bareMeter()
    const session = Session.create(SessionId(`handoff-only-empty-${Math.random().toString(36).slice(2, 8)}`))
    session.append('system/message', {
      turn: 1,
      step: 1,
      message: createSystemMessage('persona'),
    }, { surfaceOp: 'append' })
    expect(selectRolloverRange(session, meter.measure(session), { kind: 'handoff-only' })).toBeNull()
  })

  it('backs the cut up to the nearest earlier balanced cut while a tool call is in flight', async () => {
    const meter = await bareMeter()
    const session = closedConversation(6, 20)
    // An open turn whose assistant tool call has no result yet: the cut after
    // that node is tool-pairing UNBALANCED, so a span ending there would split
    // the call from its result. This is the one real host constraint, and it is
    // handled by walking back rather than by retaining a priced tail.
    session.append('turn/start', { turn: 7 })
    session.append('step/start', { turn: 7, step: 1 })
    session.append('assistant/message', {
      turn: 7,
      step: 1,
      stream: [],
      message: createAssistantMessage({
        content: [{ type: 'tool-call', id: ToolCallId('t7'), name: 'demo_tool', arguments: '{"x":1}' }],
        source: { provider: 'mock', model: 'mock' },
      }),
    }, { surfaceOp: 'append' })

    const nodes = session.surface.nodes
    const last = nodes[nodes.length - 1]
    if (last === undefined) throw new Error('expected a surface tail')

    const range = selectRolloverRange(session, meter.measure(session), { kind: 'handoff-only' })
    if (range === null) throw new Error('expected a compactable range')
    // The in-flight call is outside the span: the span ends one node earlier.
    expect(range.end).not.toBe(last)
    expect(range.end).toBe(nodes[nodes.length - 2])
    expect(range.shadowedSeqs).not.toContain(last)

    const documentText = '# Handoff\n\nContinue from the mid-call document.\n'
    await commitRollover(
      { meter },
      session,
      range.start,
      range.end,
      {
        owner: 'current-turn',
        replacement: {
          kind: 'handoff-document',
          windowNumber: 1,
          text: documentText,
          path: '/workspace/HANDOFF-mid-call.md',
        },
      },
    )
    expect(countRollovers(session)).toBe(1)

    // The only old material left is that single incomplete call unit; no other
    // pre-rollover exchange survived.
    expect(surfaceNodeTypes(session)).toEqual(['user/message', 'assistant/message'])
    const texts = session.deriveMessages().map(message => message.content
      .map(block => block.type === 'text' ? block.text : `[${block.type}]`)
      .join(''))
    expect(texts).toContain(documentText)
    expect(texts.join('\n')).toContain('[tool-call]')
    expect(texts.join('\n')).not.toContain('exchange 1')
    expect(texts.join('\n')).not.toContain('exchange 6')
  })
})

describe('new_context replaces the whole surface with the handoff document', () => {
  it('leaves exactly the system head and the document, with no old surface node of any type', async () => {
    const cwd = await scratch('dsh-handoff-only-e2e-')
    const sentinel = 'HANDOFF-DOCUMENT-BODY-SENTINEL'
    const documentText = `# Handoff\n\n${sentinel}: continue the migration.\n`
    const documentPath = join(cwd, 'HANDOFF-migration.md')
    await writeFile(documentPath, documentText, 'utf8')

    const { ctx, agent, session } = await engineHarness('handoff-only-e2e', { handoffOnly: true }, { cwd })
    const snapshots = surfaceAtRolloverEnd(ctx, session)

    // Every pre-rollover exchange carries its own sentinel, so "nothing
    // survived" is a claim about all of the old content, not about one string.
    const sentinels = Array.from({ length: 20 }, (_unused, index) => `SENTINEL-${index}-OLD-RESEARCH`)
    const adapter = new ScriptedAdapter([
      ...sentinels.map((line, index) => textResponse(`${line} finding ${index}`)),
      newContextCall(JSON.stringify({ handoff_path: documentPath })),
      textResponse('continuing on the fresh window'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 20)
    await followup(agent, 'the last old request before the boundary')

    expect(countRollovers(session)).toBe(1)
    // The surface at the rollover's own `compaction/end`: the system head and
    // the replacement, and nothing else.
    expect(snapshots).toHaveLength(1)
    expect(snapshots[0]).toEqual(['system/message', 'user/message'])

    // Zero sentinels survive in what the model would actually receive.
    const texts = session.deriveMessages().map(message => message.content
      .map(block => block.type === 'text' ? block.text : `[${block.type}]`)
      .join(''))
    const visible = texts.join('\n')
    for (const line of sentinels) expect(visible).not.toContain(line)
    expect(visible).not.toContain('the last old request before the boundary')

    // Asserted by node type as well, because a sentinel check alone misses a
    // surviving assistant tool-call block (its text is a tool name and JSON).
    expect(visible).toContain(sentinel)
    expect(visible).not.toContain('[tool-call]')
    // No prior tool result of any kind survives, and the only assistant
    // message on the surface is the fresh window's own answer: the old
    // `new_context` call block, whose visible text is just the tool name and
    // its JSON arguments, is gone with everything else.
    expect(surfaceNodeTypes(session).filter(type => type === 'tool/result')).toEqual([])
    const assistantNodes = session.surface.nodes
      .map(seq => sessionEventAt(session, seq))
      .filter((event): event is SessionEvent<'assistant/message'> => event?.type === 'assistant/message')
    expect(assistantNodes).toHaveLength(1)
    expect(JSON.stringify(assistantNodes[0]?.data)).toContain('continuing on the fresh window')

    // The replacement is the document itself: no wrapper, no notes section,
    // no narration, and nothing was prepended to the document's own bytes.
    expect(texts).toContain(documentText)
    expect(visible).not.toContain('<context-rollover checkpoint>')
    expect(visible).not.toContain('## Durable notes')
    expect(visible).not.toContain('reason: model-requested')
    expect(visible).not.toContain('Context window rollover')

    // The post-rollover answer arrived on the fresh window.
    expect(visible).toContain('continuing on the fresh window')
  })

  it('keeps the same session id and advances countRollovers by one on it', async () => {
    const cwd = await scratch('dsh-handoff-only-id-')
    const documentPath = join(cwd, 'HANDOFF-id.md')
    await writeFile(documentPath, '# Handoff\n\nKeep the same session identity.\n', 'utf8')

    const { ctx, agent, session } = await engineHarness('handoff-only-identity', { handoffOnly: true }, { cwd })
    const idBefore = session.id
    const windowBefore = countRollovers(session)
    expect(windowBefore).toBe(0)

    const adapter = new ScriptedAdapter([
      ...Array.from({ length: 12 }, (_unused, index) => textResponse(`identity filler ${index}`)),
      newContextCall(JSON.stringify({ handoff_path: documentPath })),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 12)
    await followup(agent, 'roll over without changing who I am')

    expect(session.id).toBe(idBefore)
    expect(agent.session.id).toBe(idBefore)
    // The same Session object, mutated: no new session was created for it.
    expect(agent.session).toBe(session)
    expect(countRollovers(session)).toBe(windowBefore + 1)
  })

  it('refuses a handoff that cannot shrink the span, leaving the surface intact and not substituting notes', async () => {
    const cwd = await scratch('dsh-handoff-only-shrink-')
    const documentPath = join(cwd, 'HANDOFF-too-big.md')
    // Comfortably over the whole small surface's priced size (and under the
    // configured handoffMaxChars), so the shrink guard is what refuses.
    await writeFile(documentPath, `# Handoff\n\n${'detail line\n'.repeat(400)}`, 'utf8')

    const { ctx, agent, session, notesBase } = await engineHarness(
      'handoff-only-shrink',
      { handoffOnly: true },
      { cwd },
    )
    // Durable notes exist and would be a valid, smaller replacement: the point
    // of this case is that the engine does NOT fall back to them.
    const store = new NotesStore(NotesStore.directoryFor(session.id, notesBase))
    await store.write('state.md', 'goal: prove no notes substitution\n')

    const warnings: string[] = []
    const originalWarn = ctx.logger.warn.bind(ctx.logger)
    ctx.logger.warn = (message: string): void => {
      warnings.push(message)
      originalWarn(message)
    }

    const adapter = new ScriptedAdapter([
      textResponse('tiny answer one'),
      newContextCall(JSON.stringify({ handoff_path: documentPath })),
      textResponse('tiny answer two'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'small request one')
    const nodesBefore = surfaceNodeTypes(session)
    const textsBefore = session.deriveMessages()
      .map(message => message.content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join(''))
      .join('\n')
    await followup(agent, 'small request two')

    // No rollover committed, the surface kept every node it had, and the
    // notes checkpoint was not substituted for the document the model chose.
    expect(countRollovers(session)).toBe(0)
    expect(surfaceNodeTypes(session).slice(0, nodesBefore.length)).toEqual(nodesBefore)
    const visible = session.deriveMessages()
      .map(message => message.content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join(''))
      .join('\n')
    expect(visible).toContain(textsBefore)
    expect(visible).toContain('small request one')
    expect(visible).not.toContain('## Durable notes')
    expect(visible).not.toContain('prove no notes substitution')
    expect(visible).not.toContain('HANDOFF-too-big')
    // The refusal is reported, not swallowed silently...
    expect(warnings.some(message => message.includes('not smaller than the shadowed content'))).toBe(true)
    // The refusal names the exact document the model chose, not a generic
    // "replacement": the model named one file and must be told which one lost.
    expect(warnings.some(message => message.includes(documentPath))).toBe(true)
    // ...and the failed attempt still closed its bracket.
    const ends = sessionEvents(session).filter(event => event.type === 'compaction/end')
    expect(ends).toHaveLength(1)
    expect(JSON.stringify(ends[0]?.data)).toContain('not smaller than the shadowed content')
  })
})

describe('a handoff the model cannot supply', () => {
  it('refuses inside the tool so the model reads the cause, leaving the old context intact with no compaction/start', async () => {
    const cwd = await scratch('dsh-handoff-only-refusal-')
    const unreadable = join(cwd, 'HANDOFF-locked.md')
    await writeFile(unreadable, '# Handoff\n\nlocked\n', 'utf8')
    await chmod(unreadable, 0o000)

    const cases: { name: string; path: string; expected: RegExp }[] = [
      { name: 'missing', path: join(cwd, 'HANDOFF-absent.md'), expected: /no handoff document/ },
      { name: 'empty', path: join(cwd, 'HANDOFF-empty.md'), expected: /is empty/ },
    ]
    await writeFile(cases[1]?.path ?? '', '   \n\n', 'utf8')
    if (typeof process.getuid === 'function' && process.getuid() !== 0) {
      cases.push({ name: 'unreadable', path: unreadable, expected: /EACCES/ })
    }

    for (const testCase of cases) {
      const { ctx, agent, session } = await engineHarness(
        `handoff-only-refusal-${testCase.name}`,
        { handoffOnly: true },
        { cwd },
      )
      // Driven through the real loop, so the refusal travels the same path a
      // model's own call would: the tool throws inside its `execute`, and the
      // thrown message becomes the tool result the model reads. A refusal
      // deferred to the engine's pre-step listener would instead be a warning
      // the model never sees.
      const adapter = new ScriptedAdapter([
        textResponse('old answer one'),
        newContextCall(JSON.stringify({ handoff_path: testCase.path })),
        textResponse('post-refusal answer'),
      ])
      ctx.llm.registerAdapter(['mock'], adapter)

      await followup(agent, `old context for the ${testCase.name} case`)
      const nodesBefore = surfaceNodeTypes(session)
      const textsBefore = derivedTexts(session)

      await followup(agent, `request the boundary with a ${testCase.name} document`)

      // No transaction was opened at all, and the pre-existing context is
      // byte-for-byte what it was. Whitespace differences would show up in the
      // derived-text comparison, because a real rollover replaces messages.
      expect(logTypes(session)).not.toContain('compaction/start')
      expect(logTypes(session)).not.toContain('compaction/summary')
      expect(logTypes(session)).not.toContain('compaction/end')
      expect(surfaceNodeTypes(session).slice(0, nodesBefore.length)).toEqual(nodesBefore)
      const textsAfter = derivedTexts(session)
      for (const text of textsBefore) expect(textsAfter).toContain(text)
      expect(textsAfter).toContain('old context for the missing case'.replace('missing', testCase.name))
      expect(textsAfter.join('\n')).not.toContain('<context-rollover checkpoint>')

      // The refusal is readable by the model: an error tool result carrying
      // the specific cause, not a generic failure and not a silent success.
      const refusals = session.surface.nodes
        .map(seq => sessionEventAt(session, seq))
        .filter((event): event is SessionEvent<'tool/result'> => event?.type === 'tool/result')
        .filter(event => event.data.message.isError === true)
      expect(refusals).toHaveLength(1)
      const refusalText = JSON.stringify(refusals[0]?.data.message.content)
      expect(refusalText).toMatch(testCase.expected)
      // A successful rollover answer would have been promised here; the tool
      // result that follows the call must not be that promise.
      expect(refusalText).not.toContain('A new context window will start')
    }
  })

  it('refuses an empty handoff_path before touching the filesystem', async () => {
    const { ctx, agent, session } = await engineHarness('handoff-only-empty-path', { handoffOnly: true })
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'empty' as never,
      name: 'new_context',
      arguments: { handoff_path: '   ' },
      agent,
    })
    expect(result.isError).toBe(true)
    expect(JSON.stringify(result.content)).toContain('handoff_path')
    expect(logTypes(session)).not.toContain('compaction/start')
  })
})

describe('the tool surface after the change', () => {
  it('declares handoff_path as required and no longer accepts the legacy handoff string', async () => {
    const { ctx } = await engineHarness('handoff-only-tool-schema')
    const definition = ctx.tools.get('new_context')
    expect(definition).toBeDefined()
    const parameters = (definition as unknown as {
      parameters?: { properties?: Record<string, unknown>; required?: string[] }
    }).parameters
    expect(parameters?.properties).toHaveProperty('handoff_path')
    expect(parameters?.properties).not.toHaveProperty('handoff')
    expect(parameters?.required).toEqual(['handoff_path'])
    // The description teaches the /handoff-doc workflow rather than a short
    // inline handoff string.
    const description = definition?.description ?? ''
    expect(description).toContain('/handoff-doc')
    expect(description).toContain('entire continuation context')
    expect(description).not.toContain('recent verbatim')
    // `notes`, `history` and `get_context_remaining` stay mounted.
    for (const name of ['notes', 'history', 'get_context_remaining']) {
      expect(ctx.tools.get(name)).toBeDefined()
    }
  })
})

describe('the fresh context after the rollover', () => {
  it('carries the system prompt, the restored workspace instructions and the tool catalogue', async () => {
    const cwd = await scratch('dsh-handoff-only-instructions-')
    // A real git-free workspace: the instruction loader walks up from cwd for a
    // `.git` marker and loads `AGENTS.md` from every directory on the chain.
    const instructionSentinel = 'WORKSPACE-INSTRUCTION-SENTINEL'
    await writeFile(join(cwd, 'AGENTS.md'), `# Workspace rules\n\n${instructionSentinel}\n`, 'utf8')
    const documentPath = join(cwd, 'HANDOFF-instructions.md')
    const documentText = '# Handoff\n\nContinue with the workspace rules restored.\n'
    await writeFile(documentPath, documentText, 'utf8')

    const { ctx, agent, session } = await engineHarness(
      'handoff-only-instructions',
      { handoffOnly: true },
      { cwd },
      { workspaceInstructions: true },
    )
    const adapter = new ScriptedAdapter([
      ...Array.from({ length: 12 }, (_unused, index) => textResponse(`instruction filler ${index}`)),
      newContextCall(JSON.stringify({ handoff_path: documentPath })),
      textResponse('fresh window answer'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 12)
    await followup(agent, 'roll over and then answer')

    expect(countRollovers(session)).toBe(1)
    // The restored instructions come back as their own surface node, because
    // `dsh-agent-instructions` re-enters them when the surface no longer
    // carries an identical payload.
    const instructionNodes = session.surface.nodes
      .map(seq => sessionEventAt(session, seq))
      .filter(event => event?.type === 'user/message'
        && event.data.source.kind === 'agent-instructions')
    expect(instructionNodes.length).toBeGreaterThan(0)

    // The claim is about the RECORDED ADAPTER REQUEST, not `deriveMessages`
    // alone: the system head is the one thing the host preserves for free, so
    // only the request can show the instructions and the catalogue came back.
    // The boundary is crossed at the pre-step that follows the `new_context`
    // tool result, so the recorded requests that carry the handoff document are
    // exactly the fresh window's own. Asserting on the recorded ADAPTER REQUEST
    // (`GenerateOptions`), not `deriveMessages`, is what makes the tool
    // catalogue checkable at all.
    const marker = 'Continue with the workspace rules restored.'
    const postRollover = adapter.recorded
      .filter(recorded => JSON.stringify(recorded.messages).includes(marker))
    expect(postRollover).toHaveLength(1)
    const firstPostRollover = postRollover[0]
    if (firstPostRollover === undefined) throw new Error('expected a recorded post-rollover request')
    const requestText = JSON.stringify(firstPostRollover.messages)

    // 1. The standing system prompt.
    const systemMessage = firstPostRollover.messages.find(message => message.role === 'system')
    expect(systemMessage).toBeDefined()
    expect(JSON.stringify(systemMessage)).toContain('Context management')
    // 2. The restored workspace instruction text.
    expect(requestText).toContain(instructionSentinel)
    // 3. The current tool catalogue.
    const toolNames = firstPostRollover.tools.map(tool => tool.name)
    for (const name of ['new_context', 'notes', 'history', 'get_context_remaining']) {
      expect(toolNames).toContain(name)
    }
    // And nothing from the old conversation, still asserted on the request.
    expect(requestText).not.toContain('instruction filler')
  })
})

describe('the rollover transaction', () => {
  it('stays an ordinary compaction: start, summary with provenance, replacement, end', async () => {
    const cwd = await scratch('dsh-handoff-only-transaction-')
    const documentPath = join(cwd, 'HANDOFF-tx.md')
    await writeFile(documentPath, '# Handoff\n\nTransaction shape check.\n', 'utf8')

    const { ctx, agent, session } = await engineHarness('handoff-only-tx', { handoffOnly: true }, { cwd })
    const adapter = new ScriptedAdapter([
      ...Array.from({ length: 12 }, (_unused, index) => textResponse(`tx filler ${index}`)),
      newContextCall(JSON.stringify({ handoff_path: documentPath })),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 12)
    await followup(agent, 'cross the boundary cleanly')

    const types = logTypes(session)
    expect(types).toContain('compaction/start')
    expect(types).toContain('compaction/summary')
    expect(types).toContain('compaction/end')
    const summaryEvent = sessionEvents(session).find(event => event.type === 'compaction/summary')
    if (summaryEvent?.type !== 'compaction/summary') throw new Error('expected a compaction/summary')
    expect(summaryEvent.data.provider).toBe('dsh-context-rollover')
    expect(summaryEvent.data.model).toBe('deterministic/window-1')
    expect(summaryEvent.data.shadowedSeqs.length).toBeGreaterThan(0)

    // The replacement carries compaction provenance in its source, not in the
    // model-visible text.
    const replacement = session.surface.nodes
      .map(seq => sessionEventAt(session, seq))
      .find(event => event?.type === 'user/message' && event.data.source.kind === 'compact-checkpoint')
    if (replacement?.type !== 'user/message') throw new Error('expected the replacement user/message')
    expect(replacement.data.source).toMatchObject({
      kind: 'compact-checkpoint',
      compactionId: summaryEvent.data.compactionId,
    })
    // The model-visible block is exactly the document, with no wrapper text.
    expect(replacement.data.content).toHaveLength(1)
    expect(replacement.data.content[0]).toEqual({
      type: 'text',
      text: '# Handoff\n\nTransaction shape check.\n',
    })
  })

  it('leaves the notes composition intact for the paths that still use it', async () => {
    // Ticket 05 keeps the notes checkpoint as the emergency fallback, so the
    // composition must stay reachable and unchanged beside the handoff one.
    const meter = await bareMeter()
    const session = closedConversation(4, 10)
    const range = selectRolloverRange(session, meter.measure(session), { kind: 'handoff-only' })
    if (range === null) throw new Error('expected a compactable range')
    await commitRollover({ meter }, session, range.start, range.end, {
      owner: null,
      replacement: {
        kind: 'checkpoint',
        checkpoint: {
          reason: 'pressure',
          windowNumber: 1,
          notes: '- goal: keep the notes path alive',
          handoff: null,
        },
      },
    })
    const visible = session.deriveMessages()
      .map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''))
      .join('\n')
    expect(visible).toContain('<context-rollover checkpoint>')
    expect(visible).toContain('## Durable notes')
    expect(visible).toContain('keep the notes path alive')
    expect(visible).toContain('reason: pressure')
  })
})
