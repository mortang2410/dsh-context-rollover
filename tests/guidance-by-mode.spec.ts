/**
 * The context-management guidance text, per rollover mode.
 *
 * Structured-handoff guidance is the upstream text with the approved changes:
 * three approved points are added, the upstream handoff sentence is replaced
 * by a statement that the rollover takes no handoff argument, and the upstream
 * history-reconstruction bullet is replaced by approved point 2. Upstream mode
 * emits the upstream text byte for byte.
 *
 * The model-facing cases read the system message that the scripted adapter
 * receives on the first request of a real turn. That message is the guidance
 * section after assembly and projection, so it is the text the model receives.
 *
 * @module tests/guidance-by-mode.spec
 */

import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { RolloverMode } from '../src/config.ts'
import { buildContextManagementGuidance, CONTEXT_MANAGEMENT_GUIDANCE } from '../src/guidance.ts'
import { engineHarness, followup, ScriptedAdapter, textResponse } from './harness.ts'

/** SHA-256 of the upstream guidance text, as committed at upstream commit ca8dc91. */
const UPSTREAM_SHA256 = 'c25eded037082664055f7708951c59aad3d888a91a8eb938ef53201eac9bca15'

/** The three approved structured-handoff guidance points, verbatim. */
const APPROVED_POINTS: readonly string[] = [
  'Your continuation is the newest HANDOFF note in your notes folder. Keep that note current, following the /handoff-doc sections.',
  'After a rollover you receive that note, your other notes, and the last part of the conversation. History stays available through the history tool.',
  'Keep each handoff note under 20,000 characters.',
]

/** The upstream sentence that structured-handoff mode removes. */
const UPSTREAM_HANDOFF_SENTENCE = 'Before rolling over, save what the next context actually needs to notes and pass a short handoff.'

/** The upstream history-reconstruction phrase that structured-handoff mode removes. */
const UPSTREAM_RECONSTRUCT_PHRASE = 'continue primarily from your notes'

/** The sentence that structured-handoff mode puts in place of the upstream handoff sentence. */
const HANDOFF_ARGUMENT_SENTENCE = 'The rollover takes no handoff argument: call new_context with no argument, and your handoff note is the carrier.'

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

/** Collapse each whitespace run to one space, so a sentence that the template literal wraps still matches. */
function flat(text: string): string {
  return text.replace(/\s+/g, ' ')
}

/** The upstream bullet that starts with `opener`, up to the next bullet, in upstream's exact bytes. */
function upstreamBullet(opener: string): string {
  const start = CONTEXT_MANAGEMENT_GUIDANCE.indexOf(opener)
  if (start < 0) throw new Error(`upstream guidance has no bullet starting "${opener}"`)
  const next = CONTEXT_MANAGEMENT_GUIDANCE.indexOf('\n- ', start + 1)
  return CONTEXT_MANAGEMENT_GUIDANCE.slice(start, next < 0 ? undefined : next)
}

/** The system text the model receives on the first request of one turn in the given mode. */
async function systemTextSentToModel(mode: RolloverMode): Promise<string> {
  const { ctx, agent } = await engineHarness(`guidance-sent-${mode}`, { mode })
  const adapter = new ScriptedAdapter([textResponse('answer')])
  ctx.llm.registerAdapter(['mock'], adapter)
  await followup(agent, 'hello')
  const [first] = adapter.requests
  if (first === undefined) throw new Error('the scripted adapter recorded no request')
  const parts: string[] = []
  for (const message of first) {
    if (message.role !== 'system') continue
    for (const block of message.content) {
      if (block.type === 'text') parts.push(block.text)
    }
  }
  return flat(parts.join('\n'))
}

describe('structured-handoff guidance text', () => {
  const structured = buildContextManagementGuidance('structured-handoff')
  const pointCases = APPROVED_POINTS.map((point, index): [number, string] => [index + 1, point])

  it.each(pointCases)('structured guidance contains approved point %i verbatim', (_number, point) => {
    expect(structured).toContain(`- ${point}`)
  })

  it('structured guidance drops the upstream handoff sentence and the history-reconstruction bullet', () => {
    const text = flat(structured)
    expect(text).not.toContain(UPSTREAM_HANDOFF_SENTENCE)
    expect(text).not.toContain('Before rolling over, save what the next context actually needs')
    expect(text).not.toContain('pass a short handoff')
    expect(text).not.toContain(UPSTREAM_RECONSTRUCT_PHRASE)
  })

  it('structured guidance says the rollover takes no handoff argument and names the handoff note as the carrier', () => {
    expect(flat(structured)).toContain(HANDOFF_ARGUMENT_SENTENCE)
  })

  it('structured guidance keeps the notes, get_context_remaining, and reminder bullets from upstream verbatim', () => {
    for (const opener of ['- Keep goal,', '- get_context_remaining is a tool', '- A reminder near']) {
      expect(structured).toContain(upstreamBullet(opener))
    }
  })
})

describe('upstream guidance text', () => {
  it('upstream guidance is byte-identical to the pinned upstream text', () => {
    const upstream = buildContextManagementGuidance('upstream')
    expect(upstream).toBe(CONTEXT_MANAGEMENT_GUIDANCE)
    expect(sha256(upstream)).toBe(UPSTREAM_SHA256)
  })
})

describe('guidance text the model receives, per mode', () => {
  it('structured-handoff: the approved points are sent and the upstream sentences are not', async () => {
    const sent = await systemTextSentToModel('structured-handoff')
    expect(sent).toContain('# Context management')
    for (const point of APPROVED_POINTS) expect(sent).toContain(`- ${point}`)
    expect(sent).not.toContain(UPSTREAM_HANDOFF_SENTENCE)
    expect(sent).not.toContain(UPSTREAM_RECONSTRUCT_PHRASE)
  })

  it('upstream: the upstream sentences are sent and no approved point is', async () => {
    const sent = await systemTextSentToModel('upstream')
    expect(sent).toContain('# Context management')
    expect(sent).toContain(UPSTREAM_HANDOFF_SENTENCE)
    expect(sent).toContain(UPSTREAM_RECONSTRUCT_PHRASE)
    for (const point of APPROVED_POINTS) expect(sent).not.toContain(point)
    expect(sent).not.toContain(HANDOFF_ARGUMENT_SENTENCE)
  })
})
