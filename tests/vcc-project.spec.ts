/**
 * The projection (ticket b61t, contract C2): the shadowed surface positions
 * become the vendored compiler's node shape, carrying exactly the message the
 * model saw, and a selected sequence with no session event fails loudly instead
 * of yielding a partial array.
 *
 * @module tests/vcc-project
 */

import { describe, expect, it } from 'vitest'
import { Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import { createAssistantMessage, createToolResultMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { ProjectionError, projectShadowedNodes } from '../src/vcc/project.ts'
import { appendExchange } from './harness.ts'

/** A session whose turn 1 carries a tool call and its result. */
function toolExchangeSession(): Session {
  const session = Session.create(SessionId(`project-${Math.random().toString(36).slice(2, 8)}`))
  appendExchange(session, 1, 'first', true)
  appendExchange(session, 2, 'second')
  return session
}

describe('projectShadowedNodes', () => {
  it('projects one node per selected sequence, in ascending seq order, with the derived message', () => {
    const session = toolExchangeSession()
    const seqs = [...session.surface.nodes].reverse()
    const nodes = projectShadowedNodes(session, seqs)

    expect(nodes).toHaveLength(seqs.length)
    expect(nodes.map(node => node.seq)).toEqual([...session.surface.nodes])
    for (const node of nodes) {
      const event = session.eventAt(SessionSeq(node.seq))
      if (event === undefined) throw new Error(`no event at ${node.seq}`)
      const derived = session.deriveEventMessage(event)
      expect(node.message).toMatchObject(derived === null ? {} : {
        role: derived.role,
        id: derived.id,
        content: derived.content,
        ...(derived.role === 'tool' ? { toolCallId: derived.toolCallId } : {}),
      })
    }
    expect(nodes[0]?.message?.role).toBe('user')
    expect(nodes[0]?.message?.content?.[0]).toEqual({ type: 'text', text: 'user: first' })
  })

  it('keeps a tool-result node at role tool with its tool-call id', () => {
    const session = toolExchangeSession()
    const surface = session.surface.nodes
    const resultSeq = surface[surface.findIndex(seq => session.eventAt(SessionSeq(seq))?.type === 'tool/result')]
    if (resultSeq === undefined) throw new Error('expected a tool result on the surface')
    const [node] = projectShadowedNodes(session, [resultSeq])

    expect(node?.message?.role).toBe('tool')
    expect(node?.message?.toolCallId).toBe('t1')
    expect(node?.message?.content).toEqual([{ type: 'text', text: 'result: first' }])
  })

  it('projects an event that derives no message as a null message without failing', () => {
    const session = Session.create(SessionId(`empty-${Math.random().toString(36).slice(2, 8)}`))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'kept' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    // An empty assistant message keeps its surface position but derives nothing.
    session.append('assistant/message', {
      stream: [],
      turn: 1,
      step: 1,
      message: createAssistantMessage({ content: [], source: { provider: 'mock', model: 'mock' } }),
    }, { surfaceOp: 'append' })

    const nodes = projectShadowedNodes(session, session.surface.nodes)
    expect(nodes.map(node => node.message)).toEqual([
      session.deriveEventMessage(session.eventAt(session.surface.nodes[0]!)!),
      null,
    ])
  })

  it('raises a ProjectionError naming the seq when a selected sequence has no session event', () => {
    const session = toolExchangeSession()
    const missing = 10_000
    expect(session.eventAt(SessionSeq(missing))).toBeUndefined()

    let thrown: unknown
    try {
      // The valid seq first: a projection that skipped the missing one would
      // return a partial array instead of throwing.
      projectShadowedNodes(session, [...session.surface.nodes, missing])
    } catch (error: unknown) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ProjectionError)
    expect((thrown as Error).message).toContain(String(missing))
    expect((thrown as Error).name).toBe('ProjectionError')
  })

  it('projects a tool-result content of image blocks through the owner message unchanged', () => {
    const session = Session.create(SessionId(`media-${Math.random().toString(36).slice(2, 8)}`))
    const message = createToolResultMessage({
      callId: ToolCallId('media-1'),
      content: [
        { type: 'text', text: 'shot' },
        {
          type: 'image',
          attachment: {
            attachmentId: 'sha256:0000' as never,
            mediaType: 'image/png',
            bytes: 4,
            width: 1,
            height: 1,
          },
        },
      ],
      isError: false,
    })
    session.append('tool/result', { turn: 1, step: 1, message }, { surfaceOp: 'append' })
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'later' }],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    const nodes = projectShadowedNodes(session, session.surface.nodes)
    expect(nodes.every(node => node.message !== null)).toBe(true)
    expect(nodes[0]?.message?.toolCallId).toBe('media-1')
  })
})
