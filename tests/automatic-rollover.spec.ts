/**
 * The automatic rollover (`automaticRollover`): the engine's own safety net at
 * the rollover point, for the session that never calls `new_context`.
 *
 * The contract held down here:
 *
 * - with the gate on, a session at or above the rollover point commits a
 *   compiled replacement at the next pre-step, with no model request pending
 *   and no `new_context` call;
 * - the committed replacement is the composer's own text for that span: the
 *   recall guide first, the durable notes header after it when notes exist,
 *   then the framed entries, so it never carries the bytes of a handoff file
 *   and no engine path scans `handoffDir` (the regression commit `ef63415`
 *   removed);
 * - a pending `new_context` handoff still commits its document byte for byte
 *   before the forced branch runs, and its summary marker names the handoff
 *   mode;
 * - the summary `model` marker and the automatic journal line name the mode
 *   derived from the committed replacement, so handoff, compiled and notes-only
 *   rollovers cannot be confused;
 * - the engine prices the compiled candidate with the transaction meter before
 *   the lock: a non-shrinking candidate defers with no compaction transaction,
 *   and a size refusal from the commit-time recheck after a passing preflight
 *   returns the same deferral while unrelated meter failures propagate;
 * - the notes/handoff roots are proven disjoint before any notes read, and an
 *   equal, nested or symlinked handoff root is refused with a TypeError naming
 *   `notesDir`;
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
 * leaves at least one node behind. The automatic path now composes compiled
 * entries instead of that checkpoint; the predicate stays pinned directly here
 * because manual `/compact` still composes the notes checkpoint.
 *
 * @module tests/automatic-rollover
 */

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import type { Session } from '@deepseek-ai/dsh-session'
import { checkpointCarriesNothing } from '../src/checkpoint.ts'
import { buildCompiledReplacement } from '../src/compiled-fallback.ts'
import { resolveConfig } from '../src/config.ts'
import type { RolloverConfig } from '../src/config.ts'
import { CONTEXT_MANAGEMENT_GUIDANCE, contextManagementGuidance } from '../src/guidance.ts'
import { NotesStore } from '../src/notes.ts'
import { countRollovers, selectionFor } from '../src/rollover.ts'
import { CHECKPOINT_OPEN_TAG, RECALL_GUIDE } from '../src/vcc/compiler.ts'
import {
  derivedTexts,
  engineHarness,
  followup,
  newContextCall,
  ScriptedAdapter,
  seedExchanges,
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

afterEach(() => {
  vi.restoreAllMocks()
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

/** The facts one committed summary carries: marker, span and heuristic span price. */
interface SummaryFacts {
  readonly model: string
  readonly shadowedSeqs: readonly number[]
  readonly shadowedTokenCount: number
}

/** The committed summaries, in commit order. */
function summaryFacts(session: Session): SummaryFacts[] {
  const summaries: SummaryFacts[] = []
  for (const raw of session.snapshotEvents()) {
    const event = raw as {
      type: string
      data: {
        model?: string
        shadowedSeqs?: readonly number[]
        shadowedTokenCount?: number
      }
    }
    if (event.type !== 'compaction/summary') continue
    summaries.push({
      model: event.data.model ?? '',
      shadowedSeqs: event.data.shadowedSeqs ?? [],
      shadowedTokenCount: event.data.shadowedTokenCount ?? 0,
    })
  }
  return summaries
}

/**
 * The compiled text the composer builds for the last committed summary's span.
 *
 * Recomputed after the commit from the summary's own shadowed positions, so the
 * assertion checks the replacement the engine committed rather than a text the
 * test hand-wrote. The composer's defaults are the resolved defaults these
 * tests configure (no compiler key is overridden).
 */
async function expectedCompiledText(
  session: Session,
  notesBase: string,
  windowNumber = 1,
): Promise<string> {
  const summary = summaryFacts(session).at(-1)
  if (summary === undefined) throw new Error('expected a committed rollover summary')
  const notes = await new NotesStore(NotesStore.directoryFor(session.id, notesBase)).renderAll(20_000)
  const built = buildCompiledReplacement({
    session,
    shadowedSeqs: summary.shadowedSeqs,
    shadowedTokens: summary.shadowedTokenCount,
    windowNumber,
    notes,
  }, {})
  if ('defer' in built) throw new Error('expected the committed span to compose a compiled replacement')
  if (built.kind !== 'compiled') throw new Error('expected a compiled replacement variant')
  return built.text
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
 * node after the compiled replacement message.
 *
 * The replacement is found by its own checkpoint marker text rather than by
 * event seq, so the count cannot drift with the append order of the
 * transaction. The priced nodes and the derived messages are the same surface
 * in the same order, and a mismatch is reported rather than silently
 * mis-indexed.
 */
function retainedTailTokens(ctx: Context, session: Session): number {
  const texts = derivedTexts(session)
  const nodes = ctx.tokenMeter.measure(session).nodes
  if (texts.length !== nodes.length) {
    throw new Error(`expected one priced node per derived message, got ${nodes.length} and ${texts.length}`)
  }
  const replacement = texts.findIndex(text => text.includes(CHECKPOINT_OPEN_TAG))
  if (replacement === -1) throw new Error('expected a committed compiled replacement on the surface')
  return nodes.slice(replacement + 1).reduce((total, node) => total + node.tokens, 0)
}

/** The user messages still on the surface, identified by the `turn N` label. */
function keptTurns(session: Session): string[] {
  return derivedTexts(session)
    .map(text => /^turn (\d+) /.exec(text)?.[0])
    .filter((label): label is string => label !== undefined)
    .map(label => label.trim())
}

describe('the automatic rollover commits when the model never rolls over', () => {
  it('commits the compiled text at the next pre-step above the point, with no new_context call', async () => {
    const cwd = await scratch('dsh-auto-rollover-')
    const handoffDir = join(cwd, '.scratch', 'handoff')
    await mkdir(handoffDir, { recursive: true })
    // A newer foreign handoff in the shared directory: the removed design took
    // the newest file here, so its bytes must never reach this surface.
    await writeFile(join(handoffDir, 'HANDOFF-foreign-session.md'), 'FOREIGN-HANDOFF-SENTINEL\n', 'utf8')

    const { ctx, agent, session, notesBase } = await engineHarness('auto-commits', AUTOMATIC, { cwd })
    const warnings = captureWarnings(ctx)
    const infos = captureInfos(ctx)
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
    // The replacement is the composer's compiled text for the committed span,
    // byte for byte. The span's own seqs make the recomputation honest: it is
    // the text the engine committed, not one the test wrote.
    expect(committedReplacementTexts(session)).toEqual([await expectedCompiledText(session, notesBase)])
    // The order of the committed text, read from markers the test names itself
    // rather than from the composer that produced it: this fixture has no
    // notes, so the recall guide leads and the first compiled entry of the
    // replaced span follows it directly.
    const compiled = committedReplacementTexts(session)[0] ?? ''
    const guideAt = compiled.indexOf(RECALL_GUIDE)
    const entryAt = compiled.indexOf('[user]\nturn 1')
    expect(guideAt).toBeGreaterThan(-1)
    expect(compiled).not.toContain('## Durable notes')
    expect(entryAt).toBeGreaterThan(guideAt)
    const summary = summaryFacts(session).at(-1)
    expect(summary?.model).toBe('deterministic/compiled-window-1')
    // The mode word in the journal comes from the same replacement variant as
    // the summary marker, so the two cannot disagree.
    expect(infos.filter(message => message.includes('compiled mode; window 1 started'))).toHaveLength(1)
    const visible = derivedTexts(session).join('\n')
    expect(visible).toContain(CHECKPOINT_OPEN_TAG)
    expect(visible).toContain(RECALL_GUIDE)
    expect(visible).not.toContain('<context-rollover checkpoint>')
    // Empty notes do not stop it: the retained tail is turn 2's exchange, and
    // turn 3 is the message this pre-step entered with. Turn 1 lives on only
    // inside the compiled copy, not as a raw surface message.
    expect(keptTurns(session)).toEqual(['turn 2', 'turn 3'])
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
    expect(committedReplacementTexts(session)).toEqual([await expectedCompiledText(session, notesBase)])
    expect(summaryFacts(session).at(-1)?.model).toBe('deterministic/compiled-window-1')
    const visible = derivedTexts(session).join('\n')
    // C3's order, asserted from the committed text and markers the test names
    // itself, so a reordering inside the production composer cannot satisfy
    // this assertion: the recall guide, then the durable notes header, then
    // the first compiled entry of the replaced span.
    const compiled = committedReplacementTexts(session)[0] ?? ''
    const guideAt = compiled.indexOf(RECALL_GUIDE)
    const notesAt = compiled.indexOf('## Durable notes')
    const entryAt = compiled.indexOf('[user]\nturn one')
    expect(guideAt).toBeGreaterThan(-1)
    expect(notesAt).toBeGreaterThan(guideAt)
    expect(entryAt).toBeGreaterThan(notesAt)
    expect(visible).toContain('AUTOMATIC-NOTES-SENTINEL')
    expect(visible).not.toContain('FOREIGN-HANDOFF-SENTINEL')
  })
})

describe('a pending handoff still commits before the forced branch', () => {
  it('commits the handoff document byte for byte and names the handoff marker', async () => {
    const cwd = await scratch('dsh-auto-pending-handoff-')
    const document = '# Handoff\n\nContinue from this document, byte for byte.\n'
    const documentPath = join(cwd, 'HANDOFF-pending.md')
    await writeFile(documentPath, document, 'utf8')

    const { ctx, agent, session } = await engineHarness('auto-pending-handoff', {
      automaticRollover: true,
      handoffOnly: true,
      // Well above the pressure this fixture builds, so the forced branch
      // cannot preempt the request the model is about to make.
      thresholdRatio: 0.9,
      reminderThresholdRatio: 0.5,
      reminderMessage: 'pending-handoff test reminder, not asserted',
    }, { cwd })
    const infos = captureInfos(ctx)
    const adapter = new ScriptedAdapter([
      ...Array.from({ length: 12 }, (_unused, index) => textResponse(`pending filler ${index}`)),
      newContextCall(JSON.stringify({ handoff_path: documentPath })),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 12)
    await followup(agent, 'cross the boundary with the pending handoff')

    expect(countRollovers(session)).toBe(1)
    // Byte for byte: no compiled wrapper, no notes header, no narration.
    expect(committedReplacementTexts(session)).toEqual([document])
    expect(summaryFacts(session).at(-1)?.model).toBe('deterministic/handoff-window-1')
    // The forced branch never ran, so its compiled journal line never appeared.
    expect(infos.filter(message => message.includes('context rollover (automatic)'))).toEqual([])
  })

  it('commits the handoff when the automatic threshold is also met at that pre-step', async () => {
    // Control first: the same surface with a plain tool call instead of a
    // pending request commits the compiled branch at that pre-step, so the
    // automatic rollover really is eligible there. A fixture where the
    // automatic branch could not run would not discriminate the priority.
    const control = await priorityCrossing('auto-priority-control', 'tool')
    expect(countRollovers(control.session)).toBe(1)
    expect(summaryFacts(control.session).at(-1)?.model).toBe('deterministic/compiled-window-1')
    expect(control.infos.filter(message => message.includes('compiled mode; window 1 started'))).toHaveLength(1)

    // The same arrangement with the model's pending handoff: the request wins
    // over the eligible automatic branch, byte for byte, and the compiled
    // branch never runs.
    const pending = await priorityCrossing('auto-priority-handoff', 'handoff')
    expect(committedReplacementTexts(pending.session)).toEqual([pending.document])
    expect(summaryFacts(pending.session).at(-1)?.model).toBe('deterministic/handoff-window-1')
    expect(pending.infos.filter(message => message.includes('context rollover (automatic)'))).toEqual([])
  })
})

describe('the summary marker names the replacement variant', () => {
  it('writes notes-window-N for a manual notes checkpoint', async () => {
    const { ctx, engine, agent, session } = await engineHarness('marker-notes-window')
    const adapter = new ScriptedAdapter(
      Array.from({ length: 25 }, (_unused, index) => textResponse(`marker filler ${index}`)),
    )
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 20)
    await followup(agent, 'background work before the manual rollover')
    const compacted = await engine.compactNow(agent, new AbortController().signal)
    expect(compacted).not.toBeNull()

    expect(summaryFacts(session).at(-1)?.model).toBe('deterministic/notes-window-1')
    // The notes checkpoint is the replacement this marker names.
    expect(committedReplacementTexts(session)[0]).toContain('<context-rollover checkpoint>')
  })
})

describe('the notes and handoff roots are proven disjoint before notes are read', () => {
  it('rejects a relative handoff root equal to the per-session notes root', async () => {
    const cwd = await scratch('dsh-auto-containment-equal-')
    const refusal = await containmentRefusal('relative-equal', {
      notesDir: cwd,
      handoffDir: 'relative-equal',
    }, cwd)

    expect(refusal.warnings.some(message => message.includes('notesDir') && message.includes('overlaps')))
      .toBe(true)
    expect(refusal.compactions).toBe(0)
    expect(refusal.starts).toBe(0)
    expect(refusal.renderCalls).toBe(0)
  })

  it('rejects a notes root nested under the handoff root', async () => {
    const cwd = await scratch('dsh-auto-containment-nested-')
    const refusal = await containmentRefusal('nested', {
      notesDir: join(cwd, 'handoff-root', 'notes'),
      handoffDir: join(cwd, 'handoff-root'),
    }, cwd)

    expect(refusal.warnings.some(message => message.includes('notesDir') && message.includes('overlaps')))
      .toBe(true)
    expect(refusal.compactions).toBe(0)
    expect(refusal.starts).toBe(0)
    expect(refusal.renderCalls).toBe(0)
  })

  it('rejects a symlinked handoff root that resolves onto the notes base', async () => {
    const cwd = await scratch('dsh-auto-containment-symlink-')
    const notesBase = join(cwd, 'notes-base')
    const sessionId = 'symlinked-handoff'
    await mkdir(join(notesBase, sessionId), { recursive: true })
    await writeFile(join(notesBase, sessionId, 'state.md'), 'NOTE-READ-SENTINEL', 'utf8')
    await symlink(notesBase, join(cwd, 'linked-handoff'))

    const refusal = await containmentRefusal(sessionId, {
      notesDir: notesBase,
      handoffDir: 'linked-handoff',
    }, cwd)

    expect(refusal.warnings.some(message => message.includes('notesDir') && message.includes('overlaps')))
      .toBe(true)
    expect(refusal.compactions).toBe(0)
    expect(refusal.starts).toBe(0)
    expect(refusal.renderCalls).toBe(0)
  })

  it('fails closed when the handoff root cannot be resolved', async () => {
    const cwd = await scratch('dsh-auto-containment-loop-')
    // A self-referential symlink: the handoff root exists as a directory entry
    // but its realpath cannot establish a relationship with the notes root.
    await symlink('loop', join(cwd, 'loop'))

    const refusal = await containmentRefusal('unprovable', {
      notesDir: join(cwd, 'notes'),
      handoffDir: 'loop',
    }, cwd)

    expect(refusal.warnings.some(message =>
      message.includes('notesDir') && message.includes('cannot be proven disjoint'))).toBe(true)
    expect(refusal.compactions).toBe(0)
    expect(refusal.starts).toBe(0)
    expect(refusal.renderCalls).toBe(0)
  })

  it('refuses a missing handoff leaf below a symlink alias of the notes root', async () => {
    const cwd = await scratch('dsh-auto-containment-alias-')
    const notesBase = join(cwd, 'notes-base')
    const sessionId = 'alias-absent-leaf'
    await mkdir(join(notesBase, sessionId), { recursive: true })
    await writeFile(join(notesBase, sessionId, 'state.md'), 'NOTE-READ-SENTINEL', 'utf8')
    // The handoff root names a leaf that does not exist below a link resolving
    // onto the notes root. Neither spelling lies under the other, and the leaf
    // itself has no realpath, so only canonicalizing both roots through their
    // nearest existing ancestors can prove the containment.
    await symlink(join(notesBase, sessionId), join(cwd, 'notes-alias'))

    const refusal = await containmentRefusal(sessionId, {
      notesDir: notesBase,
      handoffDir: join(cwd, 'notes-alias', 'absent-leaf'),
    }, cwd)

    expect(refusal.warnings.some(message => message.includes('notesDir') && message.includes('overlaps')))
      .toBe(true)
    expect(refusal.compactions).toBe(0)
    expect(refusal.starts).toBe(0)
    expect(refusal.renderCalls).toBe(0)
  })

  it('refuses a dangling notes-root symlink', async () => {
    const cwd = await scratch('dsh-auto-containment-dangling-')
    // The notes base is a symbolic link whose target does not exist. The
    // nearest resolvable ancestor cannot say where the notes store lives, so
    // the relationship to the handoff root stays unprovable.
    await symlink(join(cwd, 'missing-target'), join(cwd, 'notes-link'))
    const refusal = await containmentRefusal('dangling-notes-root', {
      notesDir: join(cwd, 'notes-link'),
      handoffDir: join(cwd, 'handoff'),
    }, cwd)

    expect(refusal.warnings.some(message =>
      message.includes('notesDir') && message.includes('cannot be proven disjoint'))).toBe(true)
    expect(refusal.compactions).toBe(0)
    expect(refusal.starts).toBe(0)
    expect(refusal.renderCalls).toBe(0)
  })

  it('refuses a relative handoff root when the session has no working directory', async () => {
    const cwd = await scratch('dsh-auto-containment-no-cwd-')
    // A relative handoff root resolves against the session working directory,
    // and the handoff reader refuses a relative document path without one. The
    // check cannot substitute the process cwd and prove a relationship the
    // handoff path contract will never use.
    const refusal = await containmentRefusal('no-session-cwd', {
      notesDir: join(cwd, 'notes'),
      handoffDir: 'relative-handoff',
    }, undefined)

    expect(refusal.warnings.some(message =>
      message.includes('notesDir') && message.includes('cannot be proven disjoint'))).toBe(true)
    expect(refusal.compactions).toBe(0)
    expect(refusal.starts).toBe(0)
    expect(refusal.renderCalls).toBe(0)
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
    const cwd = await scratch('dsh-auto-once-per-turn-')
    const { ctx, agent, session } = await engineHarness('auto-once-per-turn', {
      ...AUTOMATIC,
      automaticRolloverRetainTokens: 1,
    }, { cwd })
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
    const cwd = await scratch('dsh-auto-defer-retry-')
    const { ctx, agent, session } = await engineHarness('auto-defer-retry', {
      ...AUTOMATIC,
      automaticRolloverRetainTokens: 3000,
    }, { cwd })
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

  it('retries a size-refused candidate and commits at the next pre-step of the same turn', async () => {
    const cwd = await scratch('dsh-auto-size-retry-')
    const { ctx, agent, session } = await engineHarness('auto-size-retry', AUTOMATIC, { cwd })
    const infos = captureInfos(ctx)
    const warnings = captureWarnings(ctx)
    const startsAtDeferral: number[] = []
    const infoBefore = ctx.logger.info.bind(ctx.logger)
    ctx.logger.info = (message: string): void => {
      if (message.includes('not smaller than the selected span')) {
        // How many brackets existed when the size deferral was logged: zero
        // proves the refused first attempt committed nothing.
        startsAtDeferral.push(
          session.snapshotEvents().filter(event => event.type === 'compaction/start').length,
        )
      }
      infoBefore(message)
    }
    const original = ctx.tokenMeter.estimateMessage.bind(ctx.tokenMeter)
    let prices = 0
    vi.spyOn(ctx.tokenMeter, 'estimateMessage').mockImplementation((message) => {
      prices += 1
      // The first candidate the composer builds is priced above its span; every
      // later price is the meter's own, so the retry at the next pre-step fits.
      return prices === 1 ? 1_000_000 : original(message)
    })
    // Turn two makes three requests: two tool calls, then an answer. The size
    // refusal at the second pre-step consumes nothing, and the third pre-step
    // retries and commits in the same turn.
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      textResponse('seed answer'),
      toolCall('get_context_remaining', '{}', 'c1'),
      toolCall('get_context_remaining', '{}', 'c2'),
      textResponse('final answer'),
    ]))

    await followup(agent, longMessage('seed'))
    await followup(agent, longMessage('crossing', 200))

    expect(startsAtDeferral).toEqual([0])
    expect(infos.filter(message => message.includes('not smaller than the selected span'))).toHaveLength(1)
    expect(warnings.filter(message => message.includes('context rollover failed'))).toEqual([])
    // The later pre-step opened the only bracket, and it committed.
    expect(startsByTurn(session)).toEqual(new Map([[2, 1]]))
    expect(countRollovers(session)).toBe(1)
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

describe('a non-shrinking automatic candidate defers', () => {
  it('commits nothing, logs the deferral, and continues the turn', async () => {
    const cwd = await scratch('dsh-auto-refused-')
    const { ctx, agent, session } = await engineHarness('auto-refused', {
      ...AUTOMATIC,
      // The tail floor is met by the long answer alone, so the only span left is
      // the short user message, which is smaller than the compiled framing.
      automaticRolloverRetainTokens: 1000,
    }, { cwd })
    const infos = captureInfos(ctx)
    const warnings = captureWarnings(ctx)
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      textResponse(longMessage('answer one')),
      textResponse('answer two'),
    ]))

    await followup(agent, 'turn one')
    const generation = session.surface.replaceGeneration
    await followup(agent, 'turn two')

    // The preflight refused the candidate before any transaction opened, so
    // this is a deferral, not the old warning path.
    expect(infos.filter(message => message.includes('not smaller than the selected span'))).toHaveLength(1)
    expect(warnings.filter(message => message.includes('context rollover failed'))).toEqual([])
    expect(countRollovers(session)).toBe(0)
    expect(session.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)
    expect(session.surface.replaceGeneration).toBe(generation)
    // The turn continued to its answer instead of ending on the refusal.
    expect(derivedTexts(session).join('\n')).toContain('answer two')
  })

  it('defers when the meter refuses a candidate the compiler composed', async () => {
    const cwd = await scratch('dsh-auto-meter-preflight-')
    const { ctx, agent, session } = await engineHarness('auto-meter-preflight', AUTOMATIC, { cwd })
    const infos = captureInfos(ctx)
    const warnings = captureWarnings(ctx)
    // The call boundary is the assertion, not only the missing bracket: the
    // commit function itself must never be entered, because its own size
    // recheck also returns before opening `compaction/start`. A regression that
    // called it after a preflight miss would leave the no-bracket assertions
    // green, so this counts calls at the seam.
    const rolloverModule = await import('../src/rollover.ts')
    const commitRollover = vi.spyOn(rolloverModule, 'commitRollover')
    // The compiler's own cap accepts this span, so the composer builds a
    // candidate; the live meter prices it above the span and the preflight
    // returns the deferral before commitRollover can open a bracket.
    vi.spyOn(ctx.tokenMeter, 'estimateMessage').mockReturnValue(1_000_000)
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([textResponse('short answer')]))

    await followup(agent, longMessage('turn one'))
    await followup(agent, longMessage('turn two'))
    await followup(agent, longMessage('turn three'))

    // The count, not the recorded arguments: Vitest's printer cannot render
    // this module-namespace spy or the objects it was passed in a failure diff.
    expect(commitRollover.mock.calls.length).toBe(0)
    expect(countRollovers(session)).toBe(0)
    expect(session.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)
    expect(infos.filter(message => message.includes('not smaller than the selected span'))).toHaveLength(1)
    expect(warnings.filter(message => message.includes('context rollover failed'))).toEqual([])
  })
})

describe('a commit-time size recheck keeps the deferral', () => {
  it('returns the same deferral when the recheck rejects a preflight-passing candidate', async () => {
    const cwd = await scratch('dsh-auto-commit-recheck-')
    const { ctx, agent, session } = await engineHarness('auto-commit-recheck', AUTOMATIC, { cwd })
    const infos = captureInfos(ctx)
    const warnings = captureWarnings(ctx)
    const original = ctx.tokenMeter.estimateMessage.bind(ctx.tokenMeter)
    let calls = 0
    vi.spyOn(ctx.tokenMeter, 'estimateMessage').mockImplementation((message) => {
      calls += 1
      // The preflight passes; the transaction's own recheck refuses.
      return calls === 1 ? original(message) : 1_000_000
    })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([textResponse('short answer')]))

    await followup(agent, longMessage('turn one'))
    await followup(agent, longMessage('turn two'))
    await followup(agent, longMessage('turn three'))

    expect(calls).toBe(2)
    expect(countRollovers(session)).toBe(0)
    // The transaction refused before its compaction/start; no bracket exists.
    expect(session.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)
    expect(infos.filter(message => message.includes('not smaller than the selected span'))).toHaveLength(1)
    expect(warnings.filter(message => message.includes('context rollover failed'))).toEqual([])
  })

  it('propagates an unrelated meter failure from the commit instead of deferring', async () => {
    const cwd = await scratch('dsh-auto-commit-meter-error-')
    const { ctx, agent, session } = await engineHarness('auto-commit-meter-error', AUTOMATIC, { cwd })
    const infos = captureInfos(ctx)
    const warnings = captureWarnings(ctx)
    const original = ctx.tokenMeter.estimateMessage.bind(ctx.tokenMeter)
    let calls = 0
    vi.spyOn(ctx.tokenMeter, 'estimateMessage').mockImplementation((message) => {
      calls += 1
      if (calls === 1) return original(message)
      throw new Error('meter surface exploded')
    })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([textResponse('short answer')]))

    await followup(agent, longMessage('turn one'))
    await followup(agent, longMessage('turn two'))
    await followup(agent, longMessage('turn three'))

    expect(countRollovers(session)).toBe(0)
    expect(session.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)
    // The failure is a warning through the lifecycle's error path, not a
    // silently converted deferral.
    expect(warnings.filter(message => message.includes('meter surface exploded'))).toHaveLength(1)
    expect(infos.filter(message => message.includes('not smaller than the selected span'))).toEqual([])
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
    expect(on).toContain('compiled copy of the conversation')
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
  const cwd = await scratch('dsh-auto-tail-floor-')
  const { ctx, agent, session } = await engineHarness(id, {
    ...AUTOMATIC,
    automaticRolloverRetainTokens: floor,
  }, { cwd })
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

/** What one branch-priority fixture produced: its session, journal, and document. */
interface PriorityCrossing {
  readonly session: Session
  readonly infos: readonly string[]
  /** The handoff document the pending variant must commit byte for byte. */
  readonly document: string
}

/**
 * Drive one automatic crossing whose committing pre-step carries a tool call
 * the engine can act on.
 *
 * Turn one seeds a replaceable exchange. Turn two makes two requests: the first
 * request's tool call lands, and at the next pre-step (the second of the same
 * turn) the automatic threshold is met and a span of turn one is selectable.
 * With `kind: 'handoff'` that pre-step also carries the model's pending
 * `new_context` request; with `kind: 'tool'` it carries a plain tool call and
 * nothing pending.
 * @param id - harness session id.
 * @param kind - the tool call the model makes at that step.
 */
async function priorityCrossing(id: string, kind: 'tool' | 'handoff'): Promise<PriorityCrossing> {
  const cwd = await scratch(`dsh-auto-priority-${kind}-`)
  const document = '# Handoff\n\nCommit this pending document, not a compiled copy.\n'
  const documentPath = join(cwd, 'HANDOFF-priority.md')
  await writeFile(documentPath, document, 'utf8')
  const { ctx, agent, session } = await engineHarness(id, AUTOMATIC, { cwd })
  const infos = captureInfos(ctx)
  const request = kind === 'handoff'
    ? newContextCall(JSON.stringify({ handoff_path: documentPath }))
    : toolCall('get_context_remaining', '{}', 'c1')
  ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
    textResponse('seed answer'),
    request,
    textResponse('crossing answer'),
  ]))

  await followup(agent, longMessage('seed'))
  await followup(agent, longMessage('crossing', 200))
  return { session, infos, document }
}

/** What one overlapping notes/handoff fixture produced. */
interface ContainmentRefusal {
  readonly warnings: readonly string[]
  readonly compactions: number
  readonly starts: number
  /** Calls to the notes store's reader; zero proves the refusal ran first. */
  readonly renderCalls: number
}

/**
 * Drive one automatic crossing whose notes and handoff roots overlap, and
 * report whether the containment check refused it before any notes read.
 * @param id - session id, which becomes the per-session notes leaf.
 * @param config - notesDir and handoffDir for the fixture.
 * @param cwd - session working directory the relative handoff root resolves against,
 *   or `undefined` to mount a session that has none.
 */
async function containmentRefusal(
  id: string,
  config: Partial<RolloverConfig>,
  cwd: string | undefined,
): Promise<ContainmentRefusal> {
  const renderAll = vi.spyOn(NotesStore.prototype, 'renderAll')
  const { ctx, agent, session } = await engineHarness(
    id,
    { ...AUTOMATIC, ...config },
    cwd === undefined ? {} : { cwd },
  )
  const warnings = captureWarnings(ctx)
  ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([textResponse('short answer')]))

  await followup(agent, longMessage('turn one'))
  await followup(agent, longMessage('turn two'))
  await followup(agent, longMessage('turn three'))

  return {
    warnings,
    compactions: countRollovers(session),
    starts: session.snapshotEvents().filter(event => event.type === 'compaction/start').length,
    renderCalls: renderAll.mock.calls.length,
  }
}
