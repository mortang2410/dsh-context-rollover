/**
 * Host/preset ownership: the host engine stands down when the session's agent
 * preset provides its own compaction backend, so two backends never race one
 * pressure signal. Rosterless deployments keep the host behavior (covered by
 * the engine suite's no-roster tests).
 *
 * @module tests/preset-deferral
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import { claimReminder, countRollovers, reminderDelivered } from '../src/rollover.ts'
import { ContextRolloverEngine } from '../src/index.ts'
import { resolveConfig } from '../src/config.ts'
import {
  engineHarness,
  followup,
  mountTestContext,
  newContextCall,
  MODEL,
  reminderTexts,
  ScriptedAdapter,
  seedExchanges,
  tempNotesDir,
  textResponse,
  usageResponse,
} from './harness.ts'

/** Install a fake preset roster whose composition owns `compaction`. */
function provideRoster(ctx: Context, owner: CompactionEngine | undefined): void {
  (ctx as unknown as { provide(name: string, value: unknown): void })
    .provide('agentPresets', { serviceFor: () => owner })
}

describe('preset ownership', () => {
  it('stands down manual and automatic compaction for a preset-owned session', async () => {
    const { ctx, engine, agent, session } = await engineHarness('defer-other')
    const adapter = new ScriptedAdapter(
      Array.from({ length: 20 }, (_unused, index) => textResponse(`background ${index}`)),
    )
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 20)
    await followup(agent, 'background work')
    provideRoster(ctx, {} as CompactionEngine)

    const compacted = await engine.compactNow(agent, new AbortController().signal)
    expect(compacted).toBeNull()
    const pressured = await engine.compactIfNeeded(agent, 'pressure')
    expect(pressured).toBeNull()
    expect(countRollovers(session)).toBe(0)
    expect(session.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)
  })

  it('refuses forced span compaction whatever the session ownership', async () => {
    // The refusal runs before any span or ownership check, so the empty
    // surface and every roster state must refuse the same way.
    const start = 0 as unknown as SessionSeq
    const end = 1 as unknown as SessionSeq
    const refusal = /forced span compaction is disabled/
    const noRoster = await engineHarness('defer-none')
    await expect(noRoster.engine.compactRegion(start, end, noRoster.agent)).rejects.toThrow(refusal)

    const owned = await engineHarness('defer-region')
    provideRoster(owned.ctx, {} as CompactionEngine)
    await expect(owned.engine.compactRegion(start, end, owned.agent)).rejects.toThrow(refusal)
  })

  it('answers new_context honestly instead of promising a boundary', async () => {
    const { ctx, agent, session } = await engineHarness('defer-honest')
    provideRoster(ctx, {} as CompactionEngine)
    const adapter = new ScriptedAdapter([
      newContextCall('{"handoff_path":"HANDOFF-deferred.md"}'),
      textResponse('noted'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'Roll over, please.')

    // Nothing was recorded and nothing committed; the model-visible result
    // points at the preset that actually rolls over. The ownership gate runs
    // before any file is read, so the named path need not exist: a deferring
    // session must not be refused for a handoff the preset engine never uses.
    expect(countRollovers(session)).toBe(0)
    expect(session.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)
    const tailResultSeq = session.surface.nodes
      .map(seq => session.eventAt(seq))
      .filter(event => event?.type === 'tool/result')
      .map(event => event?.seq)
      .pop()
    const tailResult = tailResultSeq === undefined ? undefined : session.eventAt(tailResultSeq)
    const resultText = JSON.stringify(tailResult?.data)
    expect(resultText).toContain('agent preset')
    expect(resultText).not.toContain('no handoff document')
  })

  it('gives a preset-owned session no pressure reminder from this engine', async () => {
    // The reminder names this engine's tools. A session whose compaction
    // another backend owns must not receive it from this row, or the reminder
    // would arrive with a threshold this row computed from the default ratio.
    const { ctx, agent, session } = await engineHarness('defer-reminder-owned', {
      thresholdRatio: 0.5,
      reminderThresholdRatio: 0.01,
    })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponse('answer 1', 5000),
      usageResponse('answer 2', 6000),
    ]))
    provideRoster(ctx, {} as CompactionEngine)

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')
    expect(reminderTexts(session)).toHaveLength(0)
    expect(reminderDelivered(session)).toBe(false)
  })

  it('still gives a rosterless session its pressure reminder', async () => {
    // Control for the case above: the same usage without a roster must still
    // produce one reminder, so the owned case cannot pass by never reminding.
    const { ctx, agent, session } = await engineHarness('defer-reminder-rosterless', {
      thresholdRatio: 0.5,
      reminderThresholdRatio: 0.01,
    })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponse('answer 1', 5000),
      usageResponse('answer 2', 6000),
    ]))

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')
    expect(reminderTexts(session)).toHaveLength(1)
  })

  it('reminds a preset-owned session at its own entry point, not the ratio point', async () => {
    // The 100,000-token harness window gives a 40,000-token ratio reminder. The
    // entry point is 20,000 tokens, and usage stays below 40,000, so a reminder
    // here can only come from the entry point of the engine that owns the session.
    const { ctx, engine, agent, session } = await engineHarness('defer-reminder-entry', {
      modelThresholds: { [MODEL]: { thresholdTokens: 30_000, reminderThresholdTokens: 20_000 } },
    })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponse('answer 1', 25_000),
      usageResponse('answer 2', 26_000),
    ]))
    provideRoster(ctx, engine)

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')
    expect(reminderTexts(session)).toHaveLength(1)
  })

  it('leaves the window claim free for a non-owning row above its reminder point', async () => {
    // The stood-down row must not take the window's claim: the owning row
    // decides in the same waterfall, and a claim taken here would refuse it.
    const { ctx, agent, session } = await engineHarness('defer-claim-free', {
      thresholdRatio: 0.5,
      reminderThresholdRatio: 0.01,
    })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponse('answer 1', 5000),
      usageResponse('answer 2', 6000),
    ]))
    provideRoster(ctx, {} as CompactionEngine)

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')
    expect(reminderTexts(session)).toHaveLength(0)
    expect(claimReminder(session, Date.now())).toBe(true)
  })

  it('reminds a preset-owned session through a proxy-wrapped owner at its entry point', async () => {
    // The roster hands back a traced proxy whose original is the real engine
    // (cordis `symbols.original`, Symbol.for('cordis.original')). The owner
    // check must unwrap it to this engine, or the owner stands down silently.
    const { ctx, engine, agent, session } = await engineHarness('defer-reminder-proxy', {
      modelThresholds: { [MODEL]: { thresholdTokens: 30_000, reminderThresholdTokens: 20_000 } },
    })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponse('answer 1', 25_000),
      usageResponse('answer 2', 26_000),
    ]))
    const proxy = { [Symbol.for('cordis.original')]: engine } as unknown as CompactionEngine
    provideRoster(ctx, proxy)

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')
    expect(reminderTexts(session)).toHaveLength(1)
  })

  it('registers no global tools where a preset roster exists', async () => {
    const ctx = await mountTestContext()
    provideRoster(ctx, undefined)
    const engine = new ContextRolloverEngine(ctx, { notesDir: await tempNotesDir() })
    expect(engine).toBeDefined()
    // Preset deployments surface these tools from their own composition;
    // globals would leak rollover-framed tools into unopted presets.
    for (const name of ['new_context', 'get_context_remaining', 'notes', 'history']) {
      expect(ctx.tools.get(name)).toBeUndefined()
    }
    const prompt = await ctx.systemPrompt.assemble({})
    expect(prompt.sections.some(section => section.text.includes('temporary working memory'))).toBe(false)
  })

  it('registers global tools on rosterless deployments', async () => {
    const { ctx } = await engineHarness('defer-tools-present')
    for (const name of ['new_context', 'get_context_remaining', 'notes', 'history']) {
      expect(ctx.tools.get(name)).toBeDefined()
    }
  })

  it(`registers model surface for the preset role even where a roster exists`, async () => {
    const ctx = await mountTestContext()
    provideRoster(ctx, undefined)
    // The generated preset row sets `modelSurface: 'always'`: this engine
    // owns its composition, so the roster must not suppress its tools or
    // guidance.
    const engine = new ContextRolloverEngine(ctx, {
      notesDir: await tempNotesDir(),
      modelSurface: 'always',
    })
    expect(engine).toBeDefined()
    for (const name of ['new_context', 'get_context_remaining', 'notes', 'history']) {
      expect(ctx.tools.get(name)).toBeDefined()
    }
    const prompt = await ctx.systemPrompt.assemble({})
    expect(prompt.sections.some(section => section.text.includes('temporary working memory'))).toBe(true)
  })

  it('fails loud on an unknown model-surface role', () => {
    expect(() => resolveConfig({ modelSurface: 'sometimes' as unknown as 'auto' }))
      .toThrow(/modelSurface must be/)
    expect(resolveConfig({}).modelSurface).toBe('auto')
  })
})
