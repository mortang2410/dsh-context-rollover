/**
 * Engine integration tests over the real agent loop: model-requested rollover
 * through the `new_context` tool, notes carry-over, pressure reminders on their
 * five-minute repeat, and manual rollover behind the compaction command.
 *
 * @module tests/engine.spec
 */

import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { countRollovers } from '../src/rollover.ts'
import { NotesStore } from '../src/notes.ts'
import {
  derivedTexts,
  engineHarness,
  followup,
  newContextCall,
  reminderTexts,
  ScriptedAdapter,
  seedExchanges,
  textResponse,
  usageResponse,
} from './harness.ts'

/** A temp workspace holding one durable handoff document. */
async function workspaceWithHandoff(name: string, text: string): Promise<{ cwd: string; path: string }> {
  const cwd = await mkdtemp(join(tmpdir(), 'dsh-engine-handoff-'))
  await writeFile(join(cwd, name), text, 'utf8')
  return { cwd, path: join(cwd, name) }
}

describe('ContextRolloverEngine', () => {
  it('rolls over when the model calls new_context mid-turn and continues from the handoff document', async () => {
    const { cwd, path } = await workspaceWithHandoff(
      'HANDOFF-topic.md',
      '# Handoff\n\nImplement the notes next steps.\n',
    )
    // Deliberately NOT `handoffOnly`: the document replacement composes the
    // same way in either retention mode, and this case keeps the tail mode
    // covered so a deployment that opts out of handoffOnly still lands on the
    // document it named.
    const { ctx, agent, session, notesBase } = await engineHarness('model-requested', {}, { cwd })

    // Seed durable notes as if the model had saved its research. They are no
    // longer part of the continuation context: the handoff document is.
    const store = new NotesStore(NotesStore.directoryFor(session.id, notesBase))
    await store.write('state.md', 'goal: prove model-driven rollover\nnext: implement')

    const adapter = new ScriptedAdapter([
      ...Array.from({ length: 20 }, (_unused, index) => textResponse(`finding ${index} details`)),
      newContextCall(JSON.stringify({ handoff_path: path })),
      textResponse('implementing now'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 20)
    await followup(agent, 'Research is done; roll over and implement.')

    // The rollover committed exactly once and the fresh window carries the
    // handoff document's own content.
    expect(countRollovers(session)).toBe(1)
    const texts = derivedTexts(session).join('\n')
    expect(texts).toContain('Implement the notes next steps.')
    // The model-visible replacement is the document itself: no checkpoint
    // wrapper, no notes section and no narration.
    expect(texts).not.toContain('<context-rollover checkpoint>')
    expect(texts).not.toContain('reason: model-requested')
    expect(texts).not.toContain('prove model-driven rollover')
    // The assistant's post-rollover answer arrived on the fresh window.
    expect(texts).toContain('implementing now')
  })

  it('delivers the pressure reminder once, and a second turn inside the five-minute cadence does not repeat it', async () => {
    const { ctx, agent, session } = await engineHarness('reminder', {
      thresholdRatio: 0.5,
      reminderThresholdRatio: 0.01,
    })
    const adapter = new ScriptedAdapter([
      usageResponse('answer 1', 5000),
      usageResponse('answer 2', 6000),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')

    // The first post-usage pre-step crossed the 1% threshold and reminded
    // once; the second turn must not repeat it (same window, no rollover).
    const reminders = reminderTexts(session)
    expect(reminders).toHaveLength(1)
    // The delivered text is the configured handoff message, naming the
    // workflow the model must follow.
    expect(reminders[0]).toContain('/handoff-doc')
    expect(reminders[0]).toContain('new_context')
    expect(countRollovers(session)).toBe(0)
  })

  it('performs a manual rollover via compactNow on an idle agent', async () => {
    const { ctx, engine, agent, session } = await engineHarness('manual')
    const adapter = new ScriptedAdapter(
      Array.from({ length: 20 }, (_unused, index) => textResponse(`investigation step ${index} result`)),
    )
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 20)
    await followup(agent, 'investigate the thing')

    const compacted = await engine.compactNow(agent, new AbortController().signal)
    expect(compacted).not.toBeNull()
    expect(countRollovers(session)).toBe(1)
    // Manual rollover carries only notes plus the retained verbatim tail.
    const texts = derivedTexts(session).join('\n')
    expect(texts).not.toContain('Recovery record')
    expect(texts).toContain('investigate the thing')
  })

  it('mounts the context-management guidance section', async () => {
    const { ctx } = await engineHarness('guidance')
    const assembled = await ctx.systemPrompt.assemble({})
    expect(assembled.sections.some(section => section.text.includes('temporary working memory'))).toBe(true)
  })
})
