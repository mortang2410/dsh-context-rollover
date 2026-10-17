/**
 * Automatic pressure never rolls over, and the model's own handoff is the only
 * handoff a window adopts.
 *
 * The contract held down here:
 *
 * - crossing the rollover point by pressure only logs one warning per turn and
 *   commits nothing, even when a newer HANDOFF-*.md from another session sits in
 *   the shared handoff directory;
 * - the model's own `new_context` call lands exactly the document it names, never
 *   the newest file in the directory (the regression this file guards);
 * - a provider-confirmed context overflow never rolls over, so it commits no
 *   checkpoint and no handoff, and the provider error reaches the turn unchanged;
 * - a manual `/compact` composes the deterministic notes checkpoint and never
 *   reads a handoff file;
 * - `handoffDir` and `handoffPattern` stay accepted configuration, so presets
 *   that set them keep validating, even though no engine path reads them.
 *
 * Every foreign and own document carries a sentinel string, so each assertion
 * checks which document actually reached the surface.
 *
 * @module tests/emergency-fallback
 */

import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { DEFAULT_HANDOFF_DIR, DEFAULT_HANDOFF_PATTERN, resolveConfig } from '../src/config.ts'
import { NotesStore } from '../src/notes.ts'
import { countRollovers } from '../src/rollover.ts'
import {
  derivedTexts,
  engineHarness,
  errorFinish,
  followup,
  newContextCall,
  reminderTexts,
  ScriptedAdapter,
  seedExchanges,
  textResponse,
  toolCall,
  usageResponse,
} from './harness.ts'

/** Scratch directories these tests create, removed after the run. */
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

/** Create the session-relative handoff directory inside one workspace. */
async function handoffDirIn(cwd: string): Promise<string> {
  const dir = join(cwd, DEFAULT_HANDOFF_DIR)
  await mkdir(dir, { recursive: true })
  return dir
}

/** Write one handoff document with an explicit modification time. */
async function writeHandoff(dir: string, name: string, text: string, modifiedAt: Date): Promise<string> {
  const path = join(dir, name)
  await writeFile(path, text, 'utf8')
  await utimes(path, modifiedAt, modifiedAt)
  return path
}

/** One compaction transaction's shape, read from a session's durable log. */
function transactionFacts(session: Session): {
  starts: number
  summaries: number
  ends: number
  failedEnds: string[]
} {
  let starts = 0
  let summaries = 0
  let ends = 0
  const failedEnds: string[] = []
  for (const raw of session.snapshotEvents()) {
    const event = raw as { type: string; data: { error?: unknown } }
    if (event.type === 'compaction/start') starts += 1
    if (event.type === 'compaction/summary') summaries += 1
    if (event.type === 'compaction/end') {
      ends += 1
      if (event.data.error !== undefined) failedEnds.push(String(event.data.error))
    }
  }
  return { starts, summaries, ends, failedEnds }
}

/**
 * The text of every replacement the durable log committed, including one that a
 * later rollover shadowed. The model-visible surface cannot show a shadowed
 * replacement, so a regression that commits foreign text is only visible here.
 */
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

/** The model-visible text of one derived conversation, joined. */
function visibleTexts(session: Session): string {
  return derivedTexts(session).join('\n')
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

/** The once-per-turn warning logged when pressure crosses the rollover point. */
function isPressureWarning(message: string): boolean {
  return message.includes('automatic rollover is disabled')
}

/**
 * A tool-call response that reports its own usage. Without the usage figure the
 * token meter prices only the text, which sits far below the rollover point.
 */
function toolCallWithUsage(name: string, argumentsJson: string, inputTokens: number): ReturnType<typeof toolCall> {
  const chunks = toolCall(name, argumentsJson)
  return [...chunks.slice(0, -1), { type: 'usage', usage: { inputTokens, outputTokens: 5 } }, ...chunks.slice(-1)]
}

/**
 * The shipped 0.90 rollover point, with the reminder point level with it. The
 * context window the harness advertises is 100,000 tokens, so 95,000 measured
 * input tokens is above the point, and 40,000 would be the ratio default.
 */
const SHIPPED_POINT = { thresholdRatio: 0.9, reminderThresholdRatio: 0.9, handoffOnly: true } as const

/** Sentinels: each one identifies exactly one document or notes block. */
const FOREIGN_PRESSURE = 'FOREIGN-PRESSURE-SENTINEL'
const OWN_IMAGE = 'IMAGE-FIX-OWN-SENTINEL'
const FOREIGN_MPD = 'MPD-FOREIGN-SENTINEL'
const FOREIGN_OVERFLOW = 'FOREIGN-OVERFLOW-SENTINEL'
const FOREIGN_MANUAL = 'FOREIGN-MANUAL-SENTINEL'

describe('crossing the rollover point by pressure only warns', () => {
  it('commits no rollover above the point, even with a newer foreign handoff in the directory', async () => {
    const cwd = await scratch('dsh-rollover-pressure-')
    const dir = await handoffDirIn(cwd)
    await writeHandoff(
      dir,
      'HANDOFF-foreign-session.md',
      `# Handoff\n\n${FOREIGN_PRESSURE}: another session's work.\n`,
      new Date('2024-09-01T00:00:00Z'),
    )

    const { ctx, engine, agent, session } = await engineHarness('pressure-warns-only', SHIPPED_POINT, { cwd })
    const warnings = captureWarnings(ctx)
    const generation = session.surface.replaceGeneration
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      toolCallWithUsage('get_context_remaining', '{}', 95_000),
      usageResponse('answer one', 95_000),
      toolCallWithUsage('get_context_remaining', '{}', 95_000),
      usageResponse('answer two', 95_000),
    ]))

    // Turn one's first step has no measured usage yet, so its warning comes from
    // the second step, after the tool result.
    await followup(agent, 'turn one')
    expect(warnings.filter(isPressureWarning)).toHaveLength(1)
    // Turn two's first step warns, and its second step does not warn again.
    await followup(agent, 'turn two')
    expect(warnings.filter(isPressureWarning)).toHaveLength(2)

    // Positive control: pressure was measured, and the reminder point delivered
    // one reminder. A window may carry more than one, each at least five minutes
    // after the previous one (REMINDER_REPEAT_MS, src/rollover.ts:844). The
    // harness has no clock control, so turn two's reminder is held back only
    // because turn two runs less than five minutes after turn one.
    expect(reminderTexts(session)).toHaveLength(1)
    expect(countRollovers(session)).toBe(0)
    expect(session.surface.replaceGeneration).toBe(generation)
    expect(visibleTexts(session)).not.toContain(FOREIGN_PRESSURE)
    expect(visibleTexts(session)).not.toContain('<context-rollover checkpoint>')

    // The pressure trigger, called directly, commits nothing either.
    const compacted = await engine.compactIfNeeded(agent, 'pressure')
    expect(compacted).toBeNull()
    expect(countRollovers(session)).toBe(0)
    expect(session.surface.replaceGeneration).toBe(generation)
  })

  it('keeps a surface-priced run on the surface after it crosses the shipped 0.90 point', async () => {
    const cwd = await scratch('dsh-rollover-shipped-')
    const dir = await handoffDirIn(cwd)
    await writeHandoff(
      dir,
      'HANDOFF-foreign-session.md',
      `# Handoff\n\n${FOREIGN_PRESSURE}\n`,
      new Date('2024-09-01T00:00:00Z'),
    )

    // No usage chunk is scripted, so the token meter prices the real surface as
    // it grows turn by turn.
    const { ctx, agent, session, notesBase } = await engineHarness('shipped-point-warns', SHIPPED_POINT, { cwd })
    const store = new NotesStore(NotesStore.directoryFor(session.id, notesBase))
    await store.write('state.md', 'SHIPPED-NOTES-SENTINEL: no rollover should compose this.\n')
    const warnings = captureWarnings(ctx)
    const generation = session.surface.replaceGeneration
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      textResponse(`research answer ${'detail '.repeat(3000)}`),
    ]))

    // Each turn is one request, so each turn's pre-step warns at most once.
    let round = 0
    while (round < 40 && warnings.filter(isPressureWarning).length === 0) {
      await followup(agent, `research question ${round}`)
      round += 1
    }
    // The loop must actually reach the point, or the checks below pass vacuously.
    expect(warnings.filter(isPressureWarning)).toHaveLength(1)
    for (let extra = 0; extra < 3; extra += 1) await followup(agent, `past the point ${extra}`)
    expect(warnings.filter(isPressureWarning)).toHaveLength(4)

    expect(countRollovers(session)).toBe(0)
    expect(session.surface.replaceGeneration).toBe(generation)
    expect(visibleTexts(session)).not.toContain(FOREIGN_PRESSURE)
    expect(visibleTexts(session)).not.toContain('<context-rollover checkpoint>')
  })
})

describe('a model-requested rollover lands the handoff the model names', () => {
  it('lands the older named image-fix handoff, not the newer foreign MPD handoff, after a pressure warning', async () => {
    const cwd = await scratch('dsh-rollover-named-')
    const dir = await handoffDirIn(cwd)
    const ownText = `# Handoff\n\n${OWN_IMAGE}: the image fix is verified; next, rerun the render check.\n`
    const ownPath = await writeHandoff(dir, 'HANDOFF-image-fix.md', ownText, new Date('2024-01-01T00:00:00Z'))
    // Newer by modification time, so a newest-file rule would pick this one.
    await writeHandoff(
      dir,
      'HANDOFF-mpd-foreign.md',
      `# Handoff\n\n${FOREIGN_MPD}: MPD playlist work.\n`,
      new Date('2024-06-01T00:00:00Z'),
    )

    const { ctx, agent, session } = await engineHarness('named-handoff-regression', SHIPPED_POINT, { cwd })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      usageResponse('answer one', 95_000),
      usageResponse('answer two', 95_000),
      newContextCall(JSON.stringify({ handoff_path: ownPath })),
      textResponse('continuing from the image fix'),
    ]))

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')
    // Usage is above the point, and nothing was committed. This reads the durable
    // log, because a later named rollover shadows a foreign replacement and hides
    // it from the surface.
    expect(countRollovers(session)).toBe(0)
    expect(committedReplacementTexts(session)).toEqual([])
    expect(derivedTexts(session)).not.toContain(ownText)

    await followup(agent, 'roll over to the image fix')
    // Every committed replacement, shadowed ones included: only the named own
    // handoff, with no foreign text and no checkpoint carrying the pressure reason.
    // Checked before the count, so a leak fails on the committed text itself.
    const committed = committedReplacementTexts(session)
    expect(committed.join('\n')).not.toContain(FOREIGN_MPD)
    expect(committed.join('\n')).not.toContain('reason: pressure')
    expect(committed).toEqual([ownText])

    expect(countRollovers(session)).toBe(1)
    // The replacement is exactly the named file's text: the older own handoff.
    expect(derivedTexts(session)).toContain(ownText)
    expect(visibleTexts(session)).not.toContain('<context-rollover checkpoint>')

    const facts = transactionFacts(session)
    expect(facts.starts).toBe(1)
    expect(facts.ends).toBe(1)
    expect(facts.failedEnds).toEqual([])
  })
})

describe('a provider overflow never rolls over', () => {
  it('commits nothing, with a newer foreign handoff and notes present, and sends the request once', async () => {
    const cwd = await scratch('dsh-rollover-overflow-')
    const dir = await handoffDirIn(cwd)
    await writeHandoff(
      dir,
      'HANDOFF-foreign-session.md',
      `# Handoff\n\n${FOREIGN_OVERFLOW}\n`,
      new Date('2024-09-01T00:00:00Z'),
    )

    const { ctx, engine, agent, session, notesBase } = await engineHarness('overflow-no-rollover', {}, { cwd })
    const store = new NotesStore(NotesStore.directoryFor(session.id, notesBase))
    await store.write('state.md', 'OVERFLOW-NOTES-SENTINEL: the next step is the migration.\n')
    const adapter = new ScriptedAdapter([
      ...Array.from({ length: 20 }, (_unused, index) => textResponse(`finding ${index} details`)),
      errorFinish('request too large for model context window', CONTEXT_WINDOW_EXCEEDED_CODE),
      textResponse('unreachable: the engine must not retry'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 20)
    await followup(agent, 'next request should overflow')

    // No checkpoint was composed, so neither the foreign handoff nor the notes reached the surface.
    expect(countRollovers(session)).toBe(0)
    const visible = visibleTexts(session)
    expect(visible).not.toContain('<context-rollover checkpoint>')
    expect(visible).not.toContain(FOREIGN_OVERFLOW)
    expect(visible).not.toContain('OVERFLOW-NOTES-SENTINEL')
    // The overflow was sent once and never retried: 20 seeded answers plus the overflowing one.
    expect(adapter.requests).toHaveLength(21)
    // No compaction bracket opened in the durable log.
    const facts = transactionFacts(session)
    expect(facts.starts).toBe(0)
    expect(facts.ends).toBe(0)

    // The direct overflow trigger is accepted and also commits nothing.
    expect(await engine.compactIfNeeded(agent, 'context-overflow')).toBeNull()
    expect(countRollovers(session)).toBe(0)
  })
})

describe('manual compaction composes the notes checkpoint and never reads a handoff file', () => {
  it('composes the notes checkpoint on manual compaction with a newer foreign handoff present', async () => {
    const cwd = await scratch('dsh-rollover-manual-')
    const dir = await handoffDirIn(cwd)
    await writeHandoff(
      dir,
      'HANDOFF-foreign-session.md',
      `# Handoff\n\n${FOREIGN_MANUAL}\n`,
      new Date('2024-09-01T00:00:00Z'),
    )

    const { ctx, engine, agent, session, notesBase } = await engineHarness('manual-notes-only', {}, { cwd })
    const store = new NotesStore(NotesStore.directoryFor(session.id, notesBase))
    await store.write('state.md', 'MANUAL-NOTES-SENTINEL: the manual checkpoint carries these notes.\n')
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      textResponse('finding details'),
    ]))

    await seedExchanges(agent, 20)
    const compacted = await engine.compactNow(agent, new AbortController().signal)

    expect(compacted).not.toBeNull()
    expect(countRollovers(session)).toBe(1)
    const visible = visibleTexts(session)
    expect(visible).toContain('<context-rollover checkpoint>')
    expect(visible).toContain('reason: manual')
    expect(visible).toContain('MANUAL-NOTES-SENTINEL')
    expect(visible).not.toContain(FOREIGN_MANUAL)

    const facts = transactionFacts(session)
    expect(facts.starts).toBe(1)
    expect(facts.ends).toBe(1)
    expect(facts.failedEnds).toEqual([])
  })
})

describe('the handoff configuration keys', () => {
  it('still accepts handoffDir and handoffPattern, so existing presets keep validating', async () => {
    expect(resolveConfig({}).handoffDir).toBe(DEFAULT_HANDOFF_DIR)
    expect(resolveConfig({}).handoffPattern).toBe(DEFAULT_HANDOFF_PATTERN)

    const configured = { handoffDir: 'handoffs', handoffPattern: 'handoff-*.md' }
    expect(() => resolveConfig(configured)).not.toThrow()
    const resolved = resolveConfig(configured)
    expect(resolved.handoffDir).toBe('handoffs')
    expect(resolved.handoffPattern).toBe('handoff-*.md')

    // The engine mounts with the same keys, so a preset that sets them still loads.
    const { engine } = await engineHarness('config-keys-accepted', configured)
    expect(engine.config.handoffDir).toBe('handoffs')
    expect(engine.config.handoffPattern).toBe('handoff-*.md')
  })

  it('still rejects a blank handoffDir or handoffPattern', () => {
    expect(() => resolveConfig({ handoffDir: '  ' })).toThrow(/handoffDir must be a non-empty string/)
    expect(() => resolveConfig({ handoffPattern: '' })).toThrow(/handoffPattern must be a non-empty string/)
  })
})
