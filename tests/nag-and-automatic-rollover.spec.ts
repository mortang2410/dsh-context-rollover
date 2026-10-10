/**
 * Structured-handoff rollover end to end through the real agent loop: the
 * reminder at 40 percent, the automatic rollover at 90 percent, and the
 * model-requested rollover with no argument. Each path is checked for the
 * checkpoint it commits, the recent tail it keeps, and the model requests the
 * scripted adapter records.
 *
 * Fixture choices:
 * - The window is the scripted adapter's advertised CONTEXT_WINDOW (100,000
 *   tokens, tests/harness.ts). Every test sets thresholdRatio 0.9,
 *   reminderThresholdRatio 0.4, and retainRatio 0.1 explicitly, and leaves
 *   retainTokens unset, so the tail budget comes from retainRatio alone.
 * - The scripted replies carry no provider usage. The token meter then prices
 *   the surface with its heuristic, so each total follows the surface, and the
 *   reading after a rollover drops to the new, smaller surface. The stale-reading
 *   limit from ticket 04 needs a usage reading that the text cannot account for.
 *   None is supplied here, so that limit does not arise in these tests. The live
 *   host normally reports provider usage; this file does not exercise that baseline.
 *
 * @module tests/nag-and-automatic-rollover.spec
 */

import { utimes } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { sessionEventAt } from '../src/compat.ts'
import type { RolloverConfig } from '../src/config.ts'
import { ContextRolloverEngine } from '../src/index.ts'
import { NotesStore } from '../src/notes.ts'
import { countRollovers, rolloverSummarySeqs } from '../src/rollover.ts'
import {
  CONTEXT_WINDOW,
  derivedTexts,
  followup,
  MODEL,
  mountTestContext,
  newContextCall,
  reminderTexts,
  ScriptedAdapter,
  tempNotesDir,
  textResponse,
} from './harness.ts'
import type { EngineHarness } from './harness.ts'

type Harness = EngineHarness
interface Run extends Harness {
  readonly adapter: ScriptedAdapter
}

/** Thresholds and tail ratio, set explicitly in every test. */
const AUTOMATIC_RATIO = 0.9
const NAG_RATIO = 0.4
const RETAIN_RATIO = 0.1

/**
 * The engine configuration every test uses. `retainTokens` is absent on
 * purpose: a value there would replace the ratio-based tail budget. The
 * harness's default `retainTokens` is therefore not used here, and this
 * object is passed to the engine directly.
 */
const CONFIG: Partial<RolloverConfig> = {
  mode: 'structured-handoff',
  thresholdRatio: AUTOMATIC_RATIO,
  reminderThresholdRatio: NAG_RATIO,
  retainRatio: RETAIN_RATIO,
}

/** The automatic and nag points in tokens, derived from the explicit window. */
const AUTOMATIC_POINT = Math.floor(CONTEXT_WINDOW * AUTOMATIC_RATIO)
const NAG_POINT = Math.floor(CONTEXT_WINDOW * NAG_RATIO)

const CHECKPOINT_OPEN = '<context-rollover checkpoint>'

/** Notes seeded before the rollover. Names and bodies are fixed so checks can match exact text. */
const OLDER = 'HANDOFF-2026-10-09-09-15-first.md'
const NEWER = 'HANDOFF-2026-10-10-14-30-second.md'
const OLDER_BODY = 'OLDER HANDOFF BODY'
const NEWER_BODY = 'NEWER HANDOFF BODY'
const STATE_BODY = 'STATE BODY'

/** Base instant for pinned modification times, so ordering never depends on the clock. */
const BASE = Date.UTC(2026, 9, 10, 12, 0, 0)

/** Text the meter prices at about `tokens` tokens (four characters per token). */
function filler(tokens: number): string {
  return 'x'.repeat(tokens * 4)
}

/**
 * Reply texts. Turn one is about 40,120 tokens of total context, which crosses
 * 40 percent at turn two's first request. Turn two brings the total to about
 * 77,000. Each small reply adds about 2,020 tokens, so the total passes 85,000
 * after turn six, 89,359 after turn eight (below 90 percent), and 91,379 after
 * turn nine. The rollover runs before turn ten's first request.
 */
const OPENING = `reply 1 ${filler(39_000)}`
const SECOND = `reply 2 ${filler(37_000)}`
const small = (turn: number): string => `reply ${turn} ${filler(2_000)}`
const AFTER_AUTOMATIC = 'reply 10 after the automatic rollover'
const AFTER_MODEL_REQUEST = 'reply 9 after the model-requested rollover'

/** Write one note and pin its modification time. */
async function writeNote(store: NotesStore, path: string, text: string, minutes: number): Promise<void> {
  await store.write(path, text)
  const at = new Date(BASE + minutes * 60_000)
  await utimes(join(store.root, path), at, at)
}

/**
 * Seed the notes store. The older handoff is the most recently modified file,
 * so upstream's modification-time order would render it first. Structured mode
 * must ignore that order and render the newest handoff by name.
 */
async function seedNotes(harness: Harness): Promise<void> {
  const store = new NotesStore(NotesStore.directoryFor(harness.session.id, harness.notesBase))
  await writeNote(store, NEWER, NEWER_BODY, 0)
  await writeNote(store, 'state.md', STATE_BODY, 30)
  await writeNote(store, OLDER, OLDER_BODY, 60)
}

/**
 * One engine over the standard test stack, configured with {@link CONFIG}.
 * This mirrors the harness's engineHarness, minus its default retainTokens.
 */
async function engineForRatios(id: string): Promise<Harness> {
  const ctx = await mountTestContext()
  const notesBase = await tempNotesDir()
  const engine = new ContextRolloverEngine(ctx, { notesDir: notesBase, ...CONFIG })
  const agent = await ctx.agentLoop.create(SessionId(id), { provider: MODEL, model: MODEL })
  return { ctx, engine, agent, session: agent.session, notesBase }
}

/** Automatic-path run: ten turns, with the rollover at the pre-step of turn ten. */
async function automaticRun(id: string): Promise<Run> {
  const harness = await engineForRatios(id)
  await seedNotes(harness)
  const replies = [
    OPENING,
    SECOND,
    ...[3, 4, 5, 6, 7, 8, 9].map(small),
    AFTER_AUTOMATIC,
  ]
  const adapter = new ScriptedAdapter(replies.map(text => textResponse(text)))
  harness.ctx.llm.registerAdapter(['mock'], adapter)
  return { ...harness, adapter }
}

/**
 * Model-requested run: eight turns. Turn eight's first reply calls `new_context`
 * with no argument, and the rollover then happens before turn eight's second request.
 */
async function modelRequestedRun(id: string): Promise<Run> {
  const harness = await engineForRatios(id)
  await seedNotes(harness)
  const replies = [
    textResponse(OPENING),
    textResponse(SECOND),
    ...[3, 4, 5, 6, 7].map(turn => textResponse(small(turn))),
    newContextCall('{}'),
    textResponse(AFTER_MODEL_REQUEST),
  ]
  const adapter = new ScriptedAdapter(replies)
  harness.ctx.llm.registerAdapter(['mock'], adapter)
  return { ...harness, adapter }
}

/** Run the user turns from `first` through `last`, one followup each. */
async function runTurns(run: Harness, first: number, last: number): Promise<void> {
  for (let turn = first; turn <= last; turn += 1) {
    await followup(run.agent, `turn ${turn}`)
  }
}

/** The meter's total for the run's session right now. */
function totalTokens(run: Harness): number {
  return run.ctx.tokenMeter.measure(run.session).totalTokens
}

/** The one checkpoint message in the derived messages. */
function checkpointOf(run: Harness): string {
  const checkpoint = derivedTexts(run.session).find(text => text.includes(CHECKPOINT_OPEN))
  if (checkpoint === undefined) throw new Error('no rollover checkpoint in the derived messages')
  return checkpoint
}

/** A checkpoint with its reason blanked, so the two rollover reasons can be compared. */
function withoutReason(checkpoint: string): string {
  return checkpoint.replace(/reason: [a-z-]+\)/, 'reason: <reason>)')
}

/** The seq of the `compaction/start` that opened the most recent rollover. */
function latestRolloverStartSeq(run: Harness): number {
  const summary = rolloverSummarySeqs(run.session).at(-1)
  if (summary === undefined) throw new Error('no rollover summary in the session')
  const start = run.session.snapshotEvents()
    .filter(event => event.type === 'compaction/start' && event.seq < summary)
    .at(-1)
  if (start === undefined) throw new Error('no compaction/start before the rollover summary')
  return start.seq
}

/**
 * Assert the retained tail sits at the retain boundary. The budget is
 * retainRatio of the explicit window, and the tail is the newest span whose
 * priced tokens reach it: the span reaches the budget, and dropping its oldest
 * node would fall short. Retained nodes are those that existed before the
 * rollover opened, so nodes appended after it (the post-rollover reply) do not count.
 */
function expectTailAtRetainBoundary(run: Harness): void {
  const budget = Math.floor(CONTEXT_WINDOW * RETAIN_RATIO)
  expect(budget).toBe(10_000)
  const startSeq = latestRolloverStartSeq(run)
  const retained = run.ctx.tokenMeter.measure(run.session).nodes
    .filter(node => node.seq < startSeq)
    .filter(node => (sessionEventAt(run.session, node.seq)?.type as string | undefined) !== 'system/message')
  const oldest = retained[0]
  if (oldest === undefined) throw new Error('the rollover retained no tail')
  const tailTokens = retained.reduce((sum, node) => sum + node.tokens, 0)
  expect(tailTokens).toBeGreaterThanOrEqual(budget)
  expect(tailTokens - oldest.tokens).toBeLessThan(budget)
}

describe('structured-handoff rollover, end to end', () => {
  it('rolls over at 90 percent: not below it, and before the next model request once crossed', async () => {
    const run = await automaticRun('nag-auto-threshold')
    await runTurns(run, 1, 8)
    expect(run.session.requestContext()?.contextWindow).toBe(CONTEXT_WINDOW)

    // Below the automatic point: no rollover. Under a lower threshold this
    // would already have rolled over at turn five's first request.
    const beforeCrossing = totalTokens(run)
    expect(beforeCrossing).toBeGreaterThanOrEqual(85_000)
    expect(beforeCrossing).toBeLessThan(AUTOMATIC_POINT)
    expect(countRollovers(run.session)).toBe(0)

    // Crossing at the end of turn nine does not roll over by itself: the
    // rollover waits for the next step boundary.
    await runTurns(run, 9, 9)
    expect(totalTokens(run)).toBeGreaterThanOrEqual(AUTOMATIC_POINT)
    expect(countRollovers(run.session)).toBe(0)

    // Turn ten's first request is after the rollover, so it carries the checkpoint.
    await runTurns(run, 10, 10)
    expect(countRollovers(run.session)).toBe(1)
    expect(JSON.stringify(run.adapter.requests[8])).not.toContain(CHECKPOINT_OPEN)
    expect(JSON.stringify(run.adapter.requests[9])).toContain(CHECKPOINT_OPEN)
  })

  it('the automatic checkpoint carries the newest handoff first, then the other notes, and no older turn beyond the tail', async () => {
    const run = await automaticRun('nag-auto-checkpoint')
    await runTurns(run, 1, 10)
    expect(countRollovers(run.session)).toBe(1)

    const checkpoint = checkpointOf(run)
    expect(checkpoint).toContain('(window 1 started; reason: pressure)')
    expect(checkpoint).toContain(`## Durable notes\n### ${NEWER}\n${NEWER_BODY}\n\n### state.md\n${STATE_BODY}`)
    expect(checkpoint).not.toContain(OLDER)
    expect(checkpoint).not.toContain(OLDER_BODY)
    expect(checkpoint).not.toContain('## Handoff')

    // The checkpoint leads the retained surface, the tail follows it, and the
    // replaced turns are gone.
    const texts = derivedTexts(run.session)
    const at = texts.indexOf(checkpoint)
    expect(at).toBeGreaterThanOrEqual(0)
    expect(at).toBeLessThanOrEqual(1)
    const afterCheckpoint = texts.slice(at + 1).join('\n')
    expect(afterCheckpoint).toContain('reply 9 ')
    expect(afterCheckpoint).toContain(AFTER_AUTOMATIC)
    for (const replaced of ['reply 1 ', 'reply 2 ', 'reply 3 ']) {
      expect(texts.join('\n')).not.toContain(replaced)
    }
  })

  it('the retained tail sits at the exact retain boundary: retainRatio of the explicit window', async () => {
    const run = await automaticRun('nag-auto-tail')
    await runTurns(run, 1, 10)
    expect(countRollovers(run.session)).toBe(1)
    expectTailAtRetainBoundary(run)
  })

  it('the model-requested rollover with no argument commits the same checkpoint, with no handoff section', async () => {
    const automatic = await automaticRun('nag-cmp-auto')
    await runTurns(automatic, 1, 10)
    const model = await modelRequestedRun('nag-cmp-model')
    await runTurns(model, 1, 8)

    expect(countRollovers(model.session)).toBe(1)
    const modelCheckpoint = checkpointOf(model)
    expect(modelCheckpoint).toContain('(window 1 started; reason: model-requested)')
    expect(modelCheckpoint).not.toContain('## Handoff')
    expect(withoutReason(modelCheckpoint)).toBe(withoutReason(checkpointOf(automatic)))
    expectTailAtRetainBoundary(model)
  })

  it('no model request is made inside the rollover: the adapter records only the turns own requests', async () => {
    const automatic = await automaticRun('nag-req-auto')
    await runTurns(automatic, 1, 10)
    // Ten turns, one request each. The rollover added none.
    expect(automatic.adapter.requests).toHaveLength(10)

    const model = await modelRequestedRun('nag-req-model')
    await runTurns(model, 1, 8)
    // Seven single-request turns, then turn eight: the request that called
    // new_context, and the request after the rollover. Nothing else.
    expect(model.adapter.requests).toHaveLength(9)
    expect(JSON.stringify(model.adapter.requests[7])).not.toContain(CHECKPOINT_OPEN)
    expect(JSON.stringify(model.adapter.requests[8])).toContain(CHECKPOINT_OPEN)
  })

  it('the reminder fires once in the window, at the 40 percent point, and the model receives it', async () => {
    const run = await automaticRun('nag-reminder-flow')
    await runTurns(run, 1, 1)
    // Turn one already reads above 40 percent, but no step boundary has run
    // since, so the reminder waits for turn two's first request.
    expect(totalTokens(run)).toBeGreaterThanOrEqual(NAG_POINT)
    expect(reminderTexts(run.session)).toEqual([])

    await runTurns(run, 2, 2)
    const reminders = reminderTexts(run.session)
    expect(reminders).toHaveLength(1)
    expect(JSON.stringify(run.adapter.requests[1])).toContain('in window 1')
    expect(reminders[0]).toMatch(/^Context is 40% full, in window 1\. /)
    expect(reminders[0]).toContain('An automatic rollover starts around 90000 tokens.')

    // Later turns above the point in the same window add no second reminder.
    await runTurns(run, 3, 9)
    expect(reminderTexts(run.session)).toHaveLength(1)

    // After the automatic rollover the new window starts well below 40
    // percent, so no reminder is due in it.
    await runTurns(run, 10, 10)
    expect(countRollovers(run.session)).toBe(1)
    expect(totalTokens(run)).toBeLessThan(NAG_POINT)
    expect(reminderTexts(run.session)).toHaveLength(1)
  })
})
