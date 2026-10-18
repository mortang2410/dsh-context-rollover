/**
 * The automatic rollover (`automaticRollover`): the engine's own safety net at
 * the rollover point, for the session that never calls `new_context`.
 *
 * The contract held down here:
 *
 * - with the gate on, a session at or above the rollover point commits a
 *   deterministic notes-checkpoint rollover at the next pre-step, with no model
 *   request pending and no `new_context` call;
 * - the committed replacement is exactly `buildCheckpointText`, so it carries
 *   the notes snapshot and never the bytes of a handoff file: no engine path
 *   scans `handoffDir` (the regression commit `ef63415` removed);
 * - with the gate off (the default) nothing changes: no rollover, one warning;
 * - at most one committed automatic rollover per turn, while a deferral is
 *   retried at the next pre-step and consumes nothing;
 * - the automatic path keeps a recent tail floored by
 *   `automaticRolloverRetainTokens`, even on a row configured with
 *   `retainTokens: 0`, and `selectionFor` is unchanged for the other paths;
 * - a deferral or a refusal never wipes the window: the session id and the
 *   durable log stay intact and the turn continues.
 *
 * One branch is deliberately defensive and cannot be reached through the
 * engine: `checkpointCarriesNothing` (empty notes AND an empty tail) needs a
 * selected span that ends at the last surface node, and tail selection always
 * leaves at least one node behind. Its predicate is pinned directly here; the
 * engine-level empty-notes case (notes empty, tail present) commits, and that is
 * asserted on the real path.
 *
 * @module tests/automatic-rollover
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type { Session } from '@deepseek-ai/dsh-session'
import { buildCheckpointText, checkpointCarriesNothing } from '../src/checkpoint.ts'
import { resolveConfig } from '../src/config.ts'
import { CONTEXT_MANAGEMENT_GUIDANCE, contextManagementGuidance } from '../src/guidance.ts'
import { NotesStore } from '../src/notes.ts'
import { countRollovers, selectionFor } from '../src/rollover.ts'
import {
  derivedTexts,
  engineHarness,
  followup,
  ScriptedAdapter,
  textResponse,
  toolCall,
} from './harness.ts'

/** Scratch workspaces these tests create, removed after the run. */
const scratchDirs: string[] = []

afterAll(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

/** Create one scratch workspace, removed after the run. */
async function scratch(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  scratchDirs.push(dir)
  return dir
}

/**
 * One long user message. The token meter prices a surface node at one token per
 * four characters, so `repeats: 3000` is a node of roughly 5250 tokens: large
 * enough that the automatic path's tail floor is met by recent nodes alone.
 */
function longMessage(label: string, repeats = 3000): string {
  return `${label} ${'detail '.repeat(repeats).trimEnd()}`
}

/**
 * The shipped pressure configuration with the automatic gate on. The 100,000
 * token harness window puts the rollover point at 200 tokens, so the first
 * honest measurement is above it; the reminder text is replaced so no assertion
 * here depends on the shipped wording.
 */
const AUTOMATIC = {
  automaticRollover: true,
  thresholdRatio: 0.002,
  reminderThresholdRatio: 0.001,
  retainTokens: 0,
  automaticRolloverRetainTokens: 200,
  reminderMessage: 'automatic-rollover test reminder, not asserted',
} as const

/** The same pressure configuration with the automatic gate left at its default. */
const GATE_OFF = {
  thresholdRatio: 0.002,
  reminderThresholdRatio: 0.001,
  retainTokens: 0,
  reminderMessage: 'automatic-rollover test reminder, not asserted',
} as const

/** Install a fake preset roster whose composition owns `compaction`. */
function provideRoster(ctx: Context, owner: CompactionEngine | undefined): void {
  (ctx as unknown as { provide(name: string, value: unknown): void })
    .provide('agentPresets', { serviceFor: () => owner })
}

/** Record every warning the engine logs, while still forwarding it. */
function captureWarnings(ctx: { logger: { warn: (message: string) => void } }): string[] {
  const warnings: string[] = []
  const original = ctx.logger.warn.bind(ctx.logger)
  ctx.logger.warn = (message: string): void => {
    warnings.push(message)
    original(message)
  }
  return warnings
}

/** Record every info line the engine logs, while still forwarding it. */
function captureInfos(ctx: { logger: { info: (message: string) => void } }): string[] {
  const infos: string[] = []
  const original = ctx.logger.info.bind(ctx.logger)
  ctx.logger.info = (message: string): void => {
    infos.push(message)
    original(message)
  }
  return infos
}

/** The text of every replacement the durable log committed, shadowed ones included. */
function committedReplacementTexts(session: Session): string[] {
  const texts: string[] = []
  for (const raw of session.snapshotEvents()) {
    const event = raw as { type: string; data: { summary?: Array<{ type: string; text?: string }> } }
    if (event.type !== 'compaction/summary') continue
    for (const block of event.data.summary ?? []) {
      if (block.type === 'text' && block.text !== undefined) texts.push(block.text)
    }
  }
  return texts
}

/** How many committed rollovers each turn owns, from the durable bracket's turn field. */
function startsByTurn(session: Session): Map<number, number> {
  const byTurn = new Map<number, number>()
  for (const raw of session.snapshotEvents()) {
    const event = raw as { type: string; data?: { turn?: number | null } }
    if (event.type !== 'compaction/start') continue
    const turn = event.data?.turn
    if (typeof turn !== 'number') continue
    byTurn.set(turn, (byTurn.get(turn) ?? 0) + 1)
  }
  return byTurn
}

/** Every durable event as `seq:type`, for the append-only check. */
function eventKeys(session: Session): string[] {
  return session.snapshotEvents().map(event => `${event.seq}:${event.type}`)
}

/**
 * What the first committed rollover kept: the priced tokens of every surface
 * node after the checkpoint message.
 *
 * The checkpoint is found by its own marker text rather than by event seq, so
 * the count cannot drift with the append order of the transaction. The priced
 * nodes and the derived messages are the same surface in the same order, and a
 * mismatch is reported rather than silently mis-indexed.
 */
function retainedTailTokens(ctx: Context, session: Session): number {
  const texts = derivedTexts(session)
  const nodes = ctx.tokenMeter.measure(session).nodes
  if (texts.length !== nodes.length) {
    throw new Error(`expected one priced node per derived message, got ${nodes.length} and ${texts.length}`)
  }
  const checkpoint = texts.findIndex(text => text.includes('<context-rollover checkpoint>'))
  if (checkpoint === -1) throw new Error('expected a committed checkpoint on the surface')
  return nodes.slice(checkpoint + 1).reduce((total, node) => total + node.tokens, 0)
}

/** The user messages still on the surface, identified by the `turn N` label. */
function keptTurns(session: Session): string[] {
  return derivedTexts(session)
    .map(text => /^turn (\d+) /.exec(text)?.[0])
    .filter((label): label is string => label !== undefined)
    .map(label => label.trim())
}

describe('the automatic rollover commits when the model never rolls over', () => {
  it('commits a checkpoint at the next pre-step above the point, with no new_context call', async () => {
    const cwd = await scratch('dsh-auto-rollover-')
    const handoffDir = join(cwd, '.scratch', 'handoff')
    await mkdir(handoffDir, { recursive: true })
    // A newer foreign handoff in the shared directory: the removed design took
    // the newest file here, so its bytes must never reach this surface.
    await writeFile(join(handoffDir, 'HANDOFF-foreign-session.md'), 'FOREIGN-HANDOFF-SENTINEL\n', 'utf8')

    const { ctx, agent, session } = await engineHarness('auto-commits', AUTOMATIC, { cwd })
    const warnings = captureWarnings(ctx)
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([textResponse('short answer')]))

    await followup(agent, longMessage('turn 1'))
    await followup(agent, longMessage('turn 2'))
    // The surface at each pre-step holds only closed exchanges, and the tail
    // floor cannot be met by one short answer plus one long user message, so the
    // first two pre-steps have no selectable span and commit nothing.
    expect(countRollovers(session)).toBe(0)
    const eventsBefore = eventKeys(session)
    const idBefore = session.id

    await followup(agent, longMessage('turn 3'))

    // The acceptance criterion: at or above the point, with no model request
    // pending and no new_context call, the next pre-step commits the rollover.
    expect(countRollovers(session)).toBe(1)
    expect(startsByTurn(session)).toEqual(new Map([[3, 1]]))
    // The replacement is the deterministic checkpoint, byte for byte: empty
    // notes (the store is empty) plus the recent tail, and no handoff text.
    expect(committedReplacementTexts(session)).toEqual([
      buildCheckpointText({ reason: 'automatic', windowNumber: 1, notes: null, handoff: null }),
    ])
    const visible = derivedTexts(session).join('\n')
    expect(visible).toContain('<context-rollover checkpoint>')
    expect(visible).toContain('reason: automatic')
    expect(visible).toContain('No notes were saved for this rollover.')
    // Empty notes do not stop it: the retained tail is turn 2's exchange, and
    // turn 3 is the message this pre-step entered with. Turn 1 is gone.
    expect(keptTurns(session)).toEqual(['turn 2', 'turn 3'])
    expect(visible).not.toContain('turn 1')
    expect(visible).not.toContain('FOREIGN-HANDOFF-SENTINEL')
    expect(visible).not.toContain('## Handoff')

    // Session id and log: the rollover appends events only.
    expect(session.id).toBe(idBefore)
    expect(eventKeys(session).slice(0, eventsBefore.length)).toEqual(eventsBefore)
    expect(warnings.filter(message => message.includes('context rollover failed'))).toEqual([])
  })

  it('carries the notes snapshot and never reads a handoff file', async () => {
    const cwd = await scratch('dsh-auto-notes-')
    const handoffDir = join(cwd, '.scratch', 'handoff')
    await mkdir(handoffDir, { recursive: true })
    await writeFile(join(handoffDir, 'HANDOFF-foreign-session.md'), 'FOREIGN-HANDOFF-SENTINEL\n', 'utf8')

    const { ctx, agent, session, notesBase } = await engineHarness('auto-notes', AUTOMATIC, { cwd })
    const noteText = 'AUTOMATIC-NOTES-SENTINEL: the migration is the next step.\n'
    await new NotesStore(NotesStore.directoryFor(session.id, notesBase)).write('state.md', noteText)
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([textResponse('short answer')]))

    await followup(agent, longMessage('turn one'))
    await followup(agent, longMessage('turn two'))
    await followup(agent, longMessage('turn three'))

    expect(countRollovers(session)).toBe(1)
    expect(committedReplacementTexts(session)).toEqual([
      buildCheckpointText({
        reason: 'automatic',
        windowNumber: 1,
        notes: `### state.md\n${noteText}`,
        handoff: null,
      }),
    ])
    const visible = derivedTexts(session).join('\n')
    expect(visible).toContain('AUTOMATIC-NOTES-SENTINEL')
    expect(visible).not.toContain('FOREIGN-HANDOFF-SENTINEL')
  })
})

describe('the automatic rollover is off by default', () => {
  it('commits nothing and keeps the one warning per turn', async () => {
    expect(resolveConfig({}).automaticRollover).toBe(false)
    const { ctx, engine, agent, session } = await engineHarness('auto-off', GATE_OFF)
    expect(engine.config.automaticRollover).toBe(false)
    const warnings = captureWarnings(ctx)
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([textResponse('short answer')]))

    await followup(agent, longMessage('turn one'))
    await followup(agent, longMessage('turn two'))
    await followup(agent, longMessage('turn three'))
    await followup(agent, longMessage('turn four'))

    expect(countRollovers(session)).toBe(0)
    expect(session.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)
    expect(derivedTexts(session).join('\n')).toContain('turn one')
    expect(warnings.filter(message => message.includes('automatic rollover is disabled'))).toHaveLength(3)
  })
})

describe('one automatic rollover per turn', () => {
  it('suppresses a second viable attempt in the same turn, and commits in the next', async () => {
    const { ctx, agent, session } = await engineHarness('auto-once-per-turn', {
      ...AUTOMATIC,
      automaticRolloverRetainTokens: 1,
    })
    const warnings = captureWarnings(ctx)
    // Turn two makes two requests: a tool call, then an answer. Both pre-steps
    // are above the point and both have a span worth replacing, so the second
    // one is stopped only by the once-per-turn rule.
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      textResponse('short answer'),
      toolCall('get_context_remaining', '{}', 'c1'),
      textResponse('short answer two'),
      textResponse('short answer three'),
    ]))

    await followup(agent, longMessage('turn one'))
    await followup(agent, longMessage('turn two'))
    expect(startsByTurn(session)).toEqual(new Map([[2, 1]]))
    // Not a refused attempt: the surface supported it, the turn key stopped it.
    expect(warnings.filter(message => message.includes('context rollover failed'))).toEqual([])

    await followup(agent, longMessage('turn three'))
    // The same surface shape commits under the next turn's key, so the
    // suppression above was the per-turn rule and not a shrink refusal.
    expect(startsByTurn(session)).toEqual(new Map([[2, 1], [3, 1]]))
    expect(countRollovers(session)).toBe(2)
    expect(warnings.filter(message => message.includes('context rollover failed'))).toEqual([])
  })
})

describe('a deferral commits nothing and is retried', () => {
  it('defers when the tail floor cannot be met, then commits later in the same turn', async () => {
    const { ctx, agent, session } = await engineHarness('auto-defer-retry', {
      ...AUTOMATIC,
      automaticRolloverRetainTokens: 3000,
    })
    const infos = captureInfos(ctx)
    const warnings = captureWarnings(ctx)
    // Turn two: the first pre-step sees one closed exchange, too small for a
    // 3000-token tail, so it defers. The tool call then lands, the second
    // pre-step has two exchanges, and the retry commits.
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      textResponse('short answer'),
      toolCall('get_context_remaining', '{}', 'c1'),
      textResponse('short answer two'),
    ]))

    await followup(agent, longMessage('turn one'))
    await followup(agent, longMessage('turn two'))

    expect(infos.filter(message => message.includes('no compactable surface span for the automatic rollover')))
      .toHaveLength(1)
    expect(startsByTurn(session)).toEqual(new Map([[2, 1]]))
    expect(countRollovers(session)).toBe(1)
    expect(warnings.filter(message => message.includes('context rollover failed'))).toEqual([])
  })

  it('never selects a span that would leave nothing behind', async () => {
    const { ctx, agent, session } = await engineHarness('auto-defer-huge-floor', {
      ...AUTOMATIC,
      // Larger than any surface these turns build, so no span can leave the
      // configured tail behind.
      automaticRolloverRetainTokens: 10_000_000,
    })
    const infos = captureInfos(ctx)
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([textResponse('short answer')]))

    await followup(agent, longMessage('turn one'))
    await followup(agent, longMessage('turn two'))
    await followup(agent, longMessage('turn three'))

    expect(countRollovers(session)).toBe(0)
    expect(session.surface.replaceGeneration).toBe(0)
    expect(infos.filter(message => message.includes('no compactable surface span for the automatic rollover')))
      .toHaveLength(2)
  })
})

describe('the automatic path keeps its own tail floor', () => {
  it('keeps automaticRolloverRetainTokens of tail under retainTokens: 0', async () => {
    const withFloor = await firstAutomaticRollover('auto-tail-floor', 10000)
    const withoutFloor = await firstAutomaticRollover('auto-tail-bare', 1)

    // The floor is what the automatic path keeps; the bare run keeps only what
    // `retainTokens: 0` selects, which is the single newest surface node.
    expect(withFloor.retained).toBeGreaterThanOrEqual(10000)
    expect(withoutFloor.retained).toBeLessThan(10000)
    expect(withFloor.retained).toBeGreaterThan(withoutFloor.retained)
    // The floor keeps whole recent exchanges, not just the newest node.
    expect(withFloor.keptTurns.length).toBeGreaterThan(withoutFloor.keptTurns.length)

    // `selectionFor` is untouched: the manual and model-requested paths still
    // see the configured zero budget, not the automatic floor.
    const fakeSession = {
      requestContext: () => ({ contextWindow: 100_000, model: 'test' }),
    } as unknown as Session
    expect(selectionFor(resolveConfig({
      retainTokens: 0,
      handoffOnly: true,
      automaticRollover: true,
      automaticRolloverRetainTokens: 10_000,
    }), fakeSession)).toEqual({ kind: 'tail', retainTokens: 0 })
  })
})

describe('the automatic rollover stands down for another backend', () => {
  it('commits nothing when the session compaction is owned by its agent preset', async () => {
    const { ctx, engine, agent, session } = await engineHarness('auto-owned', AUTOMATIC)
    provideRoster(ctx, {} as CompactionEngine)
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([textResponse('short answer')]))

    await followup(agent, longMessage('turn one'))
    await followup(agent, longMessage('turn two'))
    await followup(agent, longMessage('turn three'))
    await followup(agent, longMessage('turn four'))

    expect(countRollovers(session)).toBe(0)
    expect(session.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)
    expect(await engine.compactIfNeeded(agent, 'pressure')).toBeNull()
    expect(countRollovers(session)).toBe(0)
  })
})

describe('a refused automatic rollover is a warning, not a lost turn', () => {
  it('logs the shrink refusal and continues the turn with the surface intact', async () => {
    const { ctx, agent, session } = await engineHarness('auto-refused', {
      ...AUTOMATIC,
      // The tail floor is met by the long answer alone, so the only span left is
      // the short user message, which is smaller than the checkpoint framing.
      automaticRolloverRetainTokens: 1000,
    })
    const warnings = captureWarnings(ctx)
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      textResponse(longMessage('answer one')),
      textResponse('answer two'),
    ]))

    await followup(agent, 'turn one')
    const generation = session.surface.replaceGeneration
    await followup(agent, 'turn two')

    expect(warnings.filter(message => message.includes('context rollover failed'))).toHaveLength(1)
    expect(warnings.some(message => message.includes('continuing the turn'))).toBe(true)
    expect(countRollovers(session)).toBe(0)
    expect(session.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)
    expect(session.surface.replaceGeneration).toBe(generation)
    // The turn continued to its answer instead of ending on the refusal.
    expect(derivedTexts(session).join('\n')).toContain('answer two')
  })
})

describe('the automatic checkpoint never carries nothing', () => {
  it('defers only when there are no notes and no retained tail', () => {
    expect(checkpointCarriesNothing(null, false)).toBe(true)
    expect(checkpointCarriesNothing('', false)).toBe(true)
    expect(checkpointCarriesNothing('  \n', false)).toBe(true)
    // Empty notes alone do not defer: the tail carries the continuation, which
    // is the committed case asserted on the real path above.
    expect(checkpointCarriesNothing(null, true)).toBe(false)
    expect(checkpointCarriesNothing('', true)).toBe(false)
    expect(checkpointCarriesNothing('### state.md\nnotes', false)).toBe(false)
  })
})

describe('the model-facing guidance follows the gate', () => {
  it('does not promise an automatic rollover when the gate is off', () => {
    const off = contextManagementGuidance({ automaticRollover: false })
    expect(off).toContain('temporary working memory')
    expect(off).toContain('Only your `new_context` call starts a handoff rollover')
    expect(off).not.toContain('the engine also rolls the')
    // The repeat interval is reminderRepeatMs, so no cadence is hardcoded here.
    expect(off).not.toContain('five minutes')
  })

  it('states the engine rollover and keeps the model handoff primary when the gate is on', () => {
    const on = contextManagementGuidance({ automaticRollover: true })
    expect(on).toContain('temporary working memory')
    expect(on).toContain('the engine also rolls the')
    expect(on).toContain('notes checkpoint')
    expect(on).toContain('safety net, not a')
    expect(on).toContain('your document is what the fresh context')
    expect(on).not.toContain('Only your `new_context` call starts a handoff rollover')
    expect(on).not.toContain('five minutes')
  })

  it('ships the gate-off text as the exported default', () => {
    expect(CONTEXT_MANAGEMENT_GUIDANCE).toBe(contextManagementGuidance())
    expect(CONTEXT_MANAGEMENT_GUIDANCE).toBe(contextManagementGuidance({ automaticRollover: false }))
  })

  it('mounts the gate-on text as the engine section when the gate is on', async () => {
    const { ctx } = await engineHarness('auto-guidance-on', { automaticRollover: true })
    const prompt = await ctx.systemPrompt.assemble({})
    const section = prompt.sections.find(candidate => candidate.name === 'context:rollover')
    expect(section?.text).toContain('the engine also rolls the')
  })
})

/**
 * Run turns until the first automatic rollover commits, and report what it kept.
 * Each turn adds one long user message, so the surface grows until the tail
 * floor is met by recent nodes alone.
 */
async function firstAutomaticRollover(
  id: string,
  floor: number,
  maxTurns = 8,
): Promise<{ readonly retained: number; readonly keptTurns: string[]; readonly turns: number }> {
  const { ctx, agent, session } = await engineHarness(id, {
    ...AUTOMATIC,
    automaticRolloverRetainTokens: floor,
  })
  ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([textResponse('short answer')]))
  let turns = 0
  while (turns < maxTurns && countRollovers(session) === 0) {
    turns += 1
    await followup(agent, longMessage(`turn ${turns}`))
  }
  if (countRollovers(session) !== 1) {
    throw new Error(`expected one automatic rollover within ${maxTurns} turns, got ${countRollovers(session)}`)
  }
  return { retained: retainedTailTokens(ctx, session), keptTurns: keptTurns(session), turns }
}
