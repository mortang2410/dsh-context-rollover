/**
 * The forced rollover, end to end: what the automatic pre-step commits when a
 * handoff document is planted in the configured handoff directory.
 *
 * This file proves the whole chain through the engine's real pre-step, the
 * real token meter and the real compaction transaction, and it is the test the
 * mutation check (`tests/mutation-check.sh`) breaks in three places:
 *
 * - the committed replacement is the compiled variant: the composer's own text
 *   for the committed span, carrying every marker of the compiled format that a
 *   whole-path deletion would take with it (the checkpoint frame, the recall
 *   guide, the `(seq N)` log position, and the automatic journal's mode word);
 * - nothing of the planted handoff document reaches the surface, and the forced
 *   path never touched the configured handoff directory: no `readHandoffFile`
 *   or `resolveHandoffPath` call, and no read, stat or directory listing whose
 *   normalized path lies under that directory. A run that reads the document
 *   and discards it fails on the reach, not only on the content;
 * - the durable notes snapshot still renders inside the replacement, read
 *   through the store after the containment check;
 * - the committed replacement is smaller than the span it replaced, measured in
 *   the bytes it wrote against the span's own heuristic price, and every log
 *   position it carries resolves to a durable record inside that span;
 * - overlapping notes and handoff roots are refused with a TypeError naming
 *   `notesDir` before any notes read, stat or listing: equal or relative, nested,
 *   a symlinked handoff directory, and a symlinked notes base whose per-session
 *   leaf is absent;
 * - a copy composed for a span the per-entry budgets would fill outsizes the span
 *   unless the compiler cap keeps to half of it, which is the third guarantee the
 *   mutation check breaks (`const cap = checkpointCap`).
 *
 * The first three guarantees are broken by the mutation check, each one leaving
 * its named test red: the frame, the log position and the cap.
 *
 * Why the instrumented `node:fs/promises` module rather than a spy on the store's
 * own functions: the forced path reaches the store, the handoff reader and the
 * engine's own canonicalization through separate call sites, so a spy on one
 * helper would miss a read made by another. The test replaces the module with a
 * plain copy of its exports (`vi.spyOn` refuses a bare `node:` namespace) and
 * wraps every primitive that can read, stat or list a path. Each touched path
 * is compared with the planted directory and the configured notes base, in
 * every spelling the code could use. A root probe (`realpath` or `readlink`) of
 * a root the containment check compares is an entry point and allowed, because
 * it names the entry itself; a read, stat or listing of either root, and any
 * probe below it, is recorded and fails. The recorder
 * is proven live before the run, and again after it, through the same
 * primitive a broken path would use.
 *
 * @module tests/forced-rollover-e2e
 */

import {
  existsSync,
  mkdirSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'

/**
 * The filesystem primitives that can read, stat or list a path. `exists` is left
 * out on purpose: it is not an export of `node:fs/promises`, and Node implements
 * it over the wrapped `stat`.
 */
const PATH_PRIMITIVES = [
  'access',
  'lstat',
  'open',
  'opendir',
  'readFile',
  'readlink',
  'readdir',
  'realpath',
  'stat',
] as const

/**
 * Replace `node:fs/promises` with a plain object carrying the real module's
 * exports. `vi.spyOn` refuses a bare `node:` namespace ("Module namespace is
 * not configurable in ESM"), so the spies here wrap the exports of this
 * module-level object, which is also the object every importer of
 * `node:fs/promises` in this file's module graph receives.
 */
vi.mock(`node:fs/promises`, async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
// The mocked module: every wrapped primitive below is an export of this object.
import * as fs from 'node:fs/promises'
import { buildCompiledReplacement } from '../src/compiled-fallback.ts'
import { NotesStore } from '../src/notes.ts'
import { countRollovers } from '../src/rollover.ts'
import { CHECKPOINT_OPEN_TAG, RECALL_GUIDE } from '../src/vcc/compiler.ts'
import { projectShadowedNodes } from '../src/vcc/project.ts'
import {
  derivedTexts,
  engineHarness,
  followup,
  ScriptedAdapter,
  textResponse,
  type EngineHarness,
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

/** The character bound the harness's notes store renders under. */
const NOTES_MAX_CHARS = 20_000

/**
 * The shipped pressure configuration with the automatic gate on. The 100,000
 * token harness window puts the rollover point at 200 tokens, so the first
 * honest measurement is above it.
 */
const AUTOMATIC = {
  automaticRollover: true,
  thresholdRatio: 0.002,
  reminderThresholdRatio: 0.001,
  retainTokens: 0,
  automaticRolloverRetainTokens: 200,
  reminderMessage: 'forced-rollover e2e reminder, not asserted',
} as const

/** One long user message: the meter prices a node at about one token per four characters. */
function longMessage(label: string, repeats = 3000): string {
  return `${label} ${'detail '.repeat(repeats).trimEnd()}`
}

// ---- the path recorder -----------------------------------------------------

/** One filesystem touch of a monitored path: the primitive and the path it normalized to. */
interface PathTouch {
  readonly primitive: string
  readonly path: string
}

/** The paths one case monitors. */
const monitored: string[] = []

/** Every monitored path a case has touched, in call order. */
const touches: PathTouch[] = []

/** Whether one normalized path is at or under one monitored target. */
function isAtOrUnder(path: string, target: string): boolean {
  const step = relative(target, path)
  return step === '' || (!step.startsWith('..') && !isAbsolute(step))
}

/**
 * The names a case allows for root probes: the roots the containment check
 * compares, each in the spelling the configuration gives and the spelling it
 * resolves to. `realpath` and `readlink` of those names are entry points: they
 * name the root entry itself, so they reveal only whether it resolves and
 * whether it is a symbolic link, never a file inside it. A read, stat or
 * listing of any of them still fails, and so does a root probe of anything
 * below a monitored root.
 */
const allowedRootProbes = new Set<string>()

/**
 * The primitives allowed on a root's own name: entry points of the containment
 * check, not accesses inside the directory it guards.
 */
const ROOT_PROBE_PRIMITIVES = new Set(['realpath', 'readlink'])

/** Whether a touched path is one of the monitored paths. */
function isMonitoredPath(path: string): boolean {
  const resolved = resolve(path)
  return monitored.some(target => isAtOrUnder(resolved, target))
}

/**
 * Allow the root probes of the roots the containment check compares against
 * (contract C8): the handoff root, the notes root, and the directory holding an
 * absent notes leaf, in the spelling the configuration gives and in the
 * canonical spelling its absence resolves through. Every read, stat or listing
 * under them stays a recorded access.
 * @param names - each root, in the spelling the configuration or the store gives
 *   it and in the canonical spelling it resolves to.
 */
function allowRootProbe(...names: string[]): void {
  for (const name of names) allowedRootProbes.add(resolve(name))
}

/**
 * Monitor one path, counted two ways: the path as the code names it, and the
 * same file reached through its parent's realpath, so a configuration that
 * spells the directory through a symlink is monitored as well.
 * @param path - the path to monitor.
 * @param parentForm - whether to add the parent-realpath form of the path.
 */
function monitor(path: string, parentForm = true): void {
  const resolved = resolve(path)
  monitored.push(resolved)
  if (!parentForm) return
  const parent = dirname(resolved)
  if (!existsSync(parent)) return
  const realParent = realpathSync(parent)
  if (realParent !== parent) monitored.push(join(realParent, resolved.slice(parent.length + 1)))
}

/**
 * Start one case: clear the recorder, register the paths, and replace every
 * filesystem primitive on the mocked module with a recorder that delegates to
 * the real one.
 * @param notesRoot - the notes root the engine canonicalizes: a realpath of it
 *   is an allowed entry point, and its parent-realpath form is monitored so a
 *   read under it is still caught.
 * @param paths - the paths whose every form, parent realpath included, is a
 *   forbidden access.
 */
function startMonitoring(notesRoot: string, ...paths: string[]): void {
  monitored.length = 0
  touches.length = 0
  allowedRootProbes.clear()
  monitor(notesRoot, true)
  for (const path of paths) monitor(path, false)
  const module = fs as unknown as Record<string, unknown>
  for (const primitive of PATH_PRIMITIVES) {
    // The original is captured before the spy replaces it, so the wrapper
    // delegates to the real primitive rather than to itself.
    const original = module[primitive]
    // The mocked module's exports are spied through a widened view of the
    // object: `vi.spyOn`'s overloads give up on an index signature, and the
    // runtime key is exactly the export name this wrapper replaces.
    const spyOn = vi.spyOn as unknown as (
      target: Record<string, unknown>,
      key: string,
    ) => { mockImplementation: (implementation: unknown) => unknown }
    spyOn(module, primitive).mockImplementation(record(primitive, original))
  }
}

/** Wrap one primitive, recording each call on a monitored path, then delegating. */
function record(primitive: string, original: unknown): unknown {
  if (typeof original !== 'function') return original
  return function recorded(this: unknown, ...args: unknown[]): unknown {
    const target = args[0]
    if (typeof target === 'string' || target instanceof URL) {
      const path = resolve(String(target))
      const allowed = ROOT_PROBE_PRIMITIVES.has(primitive) && allowedRootProbes.has(path)
      if (isMonitoredPath(path) && !allowed) {
        touches.push({ primitive, path })
      }
    }
    return Reflect.apply(original, this, args)
  }
}

/**
 * Prove the recorder is live by statting a monitored path through the same
 * wrapped primitive the code under test would use. A spy that records nothing
 * here would also record nothing for a real read, so a caller asserts this
 * true both before and after the run.
 * @param path - one of the monitored paths.
 * @returns true when the call was recorded.
 */
async function recorderIsLive(path: string): Promise<boolean> {
  const before = touches.length
  await fs.stat(path)
  return touches.length > before
}

/** What one committed summary carries: its marker, the span positions, its price. */
interface SummaryFacts {
  readonly model: string
  readonly shadowedSeqs: readonly number[]
  readonly shadowedTokenCount: number
}

/** The committed summaries, in commit order, read from the durable log. */
function summaryFacts(session: EngineHarness['session']): SummaryFacts[] {
  const summaries: SummaryFacts[] = []
  for (const raw of session.snapshotEvents()) {
    const event = raw as {
      type: string
      data: { model?: string; shadowedSeqs?: readonly number[]; shadowedTokenCount?: number }
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
 * The compiled text the composer builds for the last committed summary's span,
 * recomputed through the production composer after the commit, so the assertion
 * compares the committed text with the text the composer builds now rather than
 * with one the test hand-wrote.
 * @param harness - the harness that owns the session and notes base.
 * @param config - the resolved compiler keys the engine passed to the composer.
 */
async function expectedCompiledText(
  harness: EngineHarness,
  config: Parameters<typeof buildCompiledReplacement>[1],
  committed: SummaryFacts | undefined = summaryFacts(harness.session).at(-1),
): Promise<string> {
  const summary = committed
  if (summary === undefined) throw new Error('expected a committed rollover summary')
  const noteStore = new NotesStore(NotesStore.directoryFor(harness.session.id, harness.notesBase))
  const notes = await noteStore.renderAll(NOTES_MAX_CHARS)
  const built = buildCompiledReplacement({
    session: harness.session,
    shadowedSeqs: summary.shadowedSeqs,
    shadowedTokens: summary.shadowedTokenCount,
    windowNumber: 1,
    notes,
  }, config)
  if ('defer' in built) throw new Error('expected the committed span to compose a compiled replacement')
  if (built.kind !== 'compiled') throw new Error('expected a compiled replacement variant')
  return built.text
}

/**
 * The replacement as the composer wrote it at compose time.
 *
 * The rollover appends its own events between composing the text and storing
 * it, so a log position the composer wrote (`seq 5`, `seqs 5-8` in a cut marker)
 * can name an event whose seq was still the surface's next number then. The
 * committed text therefore differs from a recomputation only in those digits;
 * every seq the composer would write now is mapped, in order, onto the one the
 * committed text carries. Any other difference survives the mapping and fails
 * the caller's comparison.
 * @param recomputed - the composer's text for the same span and window.
 * @param committed - the text the transaction stored.
 * @returns the recomputed text with its log positions replaced by the committed ones.
 */
function committedAtCompose(recomputed: string, committed: string): string {
  const seqs = [...committed.matchAll(/(?:seq |seqs |truncated from seq )(\d+)/g)].map(match => match[1])
  let index = 0
  return recomputed.replace(/seq (\d+)|seqs (\d+)/g, (whole: string, single?: string) => {
    const committedSeq = seqs[index]
    index += 1
    if (committedSeq === undefined) return whole
    return single === undefined ? `seqs ${committedSeq}` : `seq ${committedSeq}`
  })
}

/**
 * The log positions a compiled text carries: the `(seq N)` and `(seqs A-B)`
 * markers, with the single seq of a cut marker (`...(truncated from seq N)`).
 * @param text - the committed replacement text.
 * @returns each marker with its seq, in text order.
 */
function logPositionMarkers(text: string): { marker: string; seq: number }[] {
  const markers: { marker: string; seq: number }[] = []
  for (const match of text.matchAll(/\(seqs? (\d+)(?:-(\d+)?)?[^)]*\)|\.\.\.\(truncated from seq (\d+)\)/g)) {
    const whole = match[0]
    const seq = Number(match[1] ?? match[2] ?? match[3])
    markers.push({ marker: whole, seq })
  }
  return markers
}

/**
 * One crossing of the automatic rollover, driven through the engine's real
 * pre-step: three long turns, a planted handoff document nobody may read, a notes
 * snapshot, and the recorder armed on the handoff directory.
 * @param label - the harness's session label.
 * @param cwd - the scratch workspace the session runs in.
 * @returns the harness and everything the recorder and the logger saw.
 */
async function crossWithHandoff(
  label: string,
  cwd: string,
): Promise<{
  harness: EngineHarness
  handoffDir: string
  replacementText: string
  summary: SummaryFacts | undefined
  warnings: string[]
  infos: string[]
  readHandoffFile: { readonly mock: { readonly calls: readonly unknown[] } }
  resolveHandoffPath: { readonly mock: { readonly calls: readonly unknown[] } }
  renderAll: { readonly mock: { readonly calls: readonly unknown[] } }
  surface: string
}> {
  const handoffDir = join(cwd, 'handoff')
  mkdirSync(handoffDir, { recursive: true })
  // The planted document is what a broken design would adopt: newest, in the
  // directory the configuration names, and unique enough to find anywhere.
  const documentPath = join(handoffDir, 'HANDOFF-planted.md')
  writeFileSync(documentPath, '# Handoff planted by the test\n\nPLANTED-HANDOFF-SENTINEL: the document the forced path must never read.\n', 'utf8')
  // A second document proves a read is a read even when it is not the one a
  // design would have picked: nothing under this directory may be opened.
  writeFileSync(join(handoffDir, 'HANDOFF-older.md'), 'OLDER-PLANTED-SENTINEL\n', 'utf8')

  startMonitoring(handoffDir, documentPath)
  // The recorder is live before the run: a stat of the monitored directory
  // is reported, so a silent empty list below cannot be a broken spy.
  expect(await recorderIsLive(handoffDir)).toBe(true)

  const harness = await engineHarness(label, {
    ...AUTOMATIC,
    handoffDir,
  }, { cwd })
  const { ctx, agent, session, notesBase } = harness
  allowRootProbe(notesBase, realpathSync(notesBase), handoffDir)
  const warnings: string[] = []
  const infos: string[] = []
  const warn = ctx.logger.warn.bind(ctx.logger)
  const info = ctx.logger.info.bind(ctx.logger)
  ctx.logger.warn = (message: string): void => { warnings.push(message); warn(message) }
  ctx.logger.info = (message: string): void => { infos.push(message); info(message) }

  const noteText = 'E2E-NOTES-SENTINEL: the migration is the next step.\n'
  await new NotesStore(NotesStore.directoryFor(session.id, notesBase)).write('state.md', noteText)

  const handoffModule = await import('../src/handoff.ts')
  const readHandoffFile = vi.spyOn(handoffModule, 'readHandoffFile')
  const resolveHandoffPath = vi.spyOn(handoffModule, 'resolveHandoffPath')
  const renderAll = vi.spyOn(NotesStore.prototype, 'renderAll')
  ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([textResponse('short answer')]))

  // The crossing: turns one and two have no selectable span yet, turn three's
  // pre-step is above the rollover point and commits.
  touches.length = 0
  await followup(agent, longMessage('turn 1'))
  await followup(agent, longMessage('turn 2'))
  expect(countRollovers(session)).toBe(0)
  await followup(agent, longMessage('turn 3'))
  expect(countRollovers(session)).toBe(1)

  // The committed replacement, read from the durable summary event.
  const committed = session.snapshotEvents()
    .filter(event => event.type === 'compaction/summary')
    .flatMap(event => (event as { data: { summary?: Array<{ type: string; text?: string }> } }).data.summary ?? [])
    .filter(block => block.type === 'text' && block.text !== undefined)
    .map(block => block.text as string)
  expect(committed).toHaveLength(1)
  return {
    harness,
    handoffDir,
    replacementText: committed[0] as string,
    summary: summaryFacts(session).at(-1),
    warnings,
    infos,
    readHandoffFile,
    resolveHandoffPath,
    renderAll,
    surface: derivedTexts(session).join('\n'),
  }
}

describe('the forced path commits the compiled copy and never touches the handoff directory', () => {
  it('crosses the rollover point at the appending turn and commits one compiled copy', async () => {
    const cwd = await scratch('dsh-forced-e2e-')
    const run = await crossWithHandoff('forced-e2e-commit', cwd)
    const { harness, handoffDir, replacementText, summary, warnings, infos } = run

    const starts = harness.session.snapshotEvents().filter(event => event.type === 'compaction/start')
    expect(starts).toHaveLength(1)
    expect((starts[0] as { data: { turn?: unknown } }).data.turn).toBe(3)

    // The compiled variant: the text the production composer builds for the
    // same span after the commit differs from the committed text only where it
    // carries log positions, which are the markers a later append legitimately
    // moves (the rollover itself appends events, so a seq the composer wrote
    // when the engine composed it can point past the end by now).
    const expectedText = await expectedCompiledText(harness, {
      checkpointCap: harness.engine.config.checkpointCap,
      assistantTextTokens: harness.engine.config.assistantTextTokens,
      userTextTokens: harness.engine.config.userTextTokens,
      toolCallTokens: harness.engine.config.toolCallTokens,
      includeReasoning: harness.engine.config.includeReasoning,
      toolArgTools: [...harness.engine.config.toolArgTools],
      hideTools: [...harness.engine.config.hideTools],
    })
    expect(replacementText).toBe(committedAtCompose(expectedText, replacementText))

    // The compiled marker: the frame and guide only the compiled format carries.
    expect(replacementText).toContain(CHECKPOINT_OPEN_TAG)
    expect(replacementText).toContain(RECALL_GUIDE)
    expect(replacementText).not.toContain('<context-rollover checkpoint>')
    expect(summary?.model).toBe('deterministic/compiled-window-1')
    expect(infos.filter(message => message.includes('compiled mode; window 1 started'))).toHaveLength(1)

    // At least one log position: every compiled row that was cut or elided
    // carries the durable seq it can be recalled from.
    const logPositions = logPositionMarkers(replacementText)
    expect(logPositions.length).toBeGreaterThan(0)

    // The durable notes snapshot still appears; the planted handoff never does.
    expect(run.renderAll).toHaveBeenCalled()
    expect(replacementText).toContain('## Durable notes')
    expect(replacementText).toContain('E2E-NOTES-SENTINEL')
    expect(replacementText).not.toContain('PLANTED-HANDOFF-SENTINEL')
    expect(replacementText).not.toContain('OLDER-PLANTED-SENTINEL')
    expect(run.surface).toContain(CHECKPOINT_OPEN_TAG)
    expect(run.surface).toContain('E2E-NOTES-SENTINEL')
    expect(run.surface).not.toContain('PLANTED-HANDOFF-SENTINEL')
    expect(run.surface).not.toContain('OLDER-PLANTED-SENTINEL')

    // No handoff reading happened: no reader call, and no filesystem access of
    // the configured handoff directory or its documents by any primitive, the
    // root's own probe included (realpath or readlink, which the recorder
    // allows: a call naming the root cannot read anything inside it).
    expect(run.readHandoffFile.mock.calls).toEqual([])
    expect(run.resolveHandoffPath.mock.calls).toEqual([])
    expect(touches).toEqual([])
    expect(warnings.filter(message => message.includes('context rollover failed'))).toEqual([])

    // The shrink guard passed: the committed replacement is smaller than the
    // span it replaced, measured in the bytes it actually wrote against the
    // span's own heuristic price (one token per four characters).
    expect(summary).toBeDefined()
    expect(summary?.shadowedSeqs.length).toBeGreaterThan(0)
    expect(summary?.shadowedTokenCount).toBeGreaterThan(0)
    expect(replacementText.length).toBeLessThan((summary?.shadowedTokenCount ?? 0) * 4)
    // And the log position the cut marker names is inside that span, so the
    // marker points at a record the rollover really replaced.
    const span = summary?.shadowedSeqs ?? []
    for (const position of logPositions) {
      expect(position.seq).toBeGreaterThanOrEqual(Math.min(...span))
      expect(position.seq).toBeLessThanOrEqual(Math.max(...span))
      // The seq has a durable record, so `recall` can resolve it.
      expect(harness.session.eventAt(position.seq as never)).toBeDefined()
    }

    // The recorder is still live after the run, proven on the directory the
    // forced path was forbidden to touch.
    expect(await recorderIsLive(handoffDir)).toBe(true)
  })

  /**
   * The cap fallback, when the half-the-span ceiling is lifted: the composer
   * budgets the whole span, its copy is larger than the span it would replace,
   * and the engine's meter preflight defers instead of committing. The next turn
   * crosses again and commits a copy that does shrink.
   *
   * The mutation check installs exactly that cap (`const cap = checkpointCap`)
   * and runs this test; the crossing above cannot see it, because its crossing
   * happens before the surface grows past the configured cap.
   */
  it('compiles a copy that would outsize its span down to the half-the-span cap', async () => {
    // The half-the-span ceiling binds when the span is smaller than twice the
    // configured cap and the per-entry budgets alone would write more than half
    // the span. A composer without that ceiling hands the compiler the whole span
    // in tokens, it keeps every row whole, and its copy outsizes the span.
    const cwd = await scratch('dsh-forced-e2e-cap-')
    const harness = await engineHarness('forced-e2e-cap', {
      ...AUTOMATIC,
      handoffDir: join(cwd, 'handoff'),
    }, { cwd })
    const { agent, session, ctx, engine } = harness
    mkdirSync(join(cwd, 'handoff'), { recursive: true })
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([textResponse('short answer')]))
    for (let turn = 1; turn <= 3; turn += 1) await followup(agent, longMessage(`turn ${turn}`))
    const summary = summaryFacts(session).at(-1)
    expect(summary).toBeDefined()
    if (summary === undefined) return

    // The price of the span's source text, measured the way the shrink guard
    // measures a copy: one token per four characters of what the projection
    // rebuilds.
    const spanNodes = projectShadowedNodes(session, summary.shadowedSeqs)
    expect(spanNodes.length).toBeGreaterThan(1)
    const sourceTokens = spanNodes
      .map(node => JSON.stringify(node.message))
      .reduce((total, message) => total + Math.ceil(message.length / 4), 0)
    // The per-entry budgets are generous, so nothing but the ceiling shortens
    // these rows, and the configured cap sits a little above the span, so the
    // ceiling, not the user's own cap, is the bound the composer must respect.
    const config = {
      checkpointCap: sourceTokens + Math.floor(sourceTokens / 4),
      assistantTextTokens: 60_000,
      userTextTokens: 60_000,
      toolCallTokens: engine.config.toolCallTokens,
      includeReasoning: engine.config.includeReasoning,
      toolArgTools: [...engine.config.toolArgTools],
      hideTools: [...engine.config.hideTools],
    }
    const built = buildCompiledReplacement({
      session,
      shadowedSeqs: summary.shadowedSeqs,
      shadowedTokens: sourceTokens,
      windowNumber: 1,
      notes: null,
    }, config)
    expect('defer' in built).toBe(false)
    if ('defer' in built || built.kind !== 'compiled') return
    expect(built.text.length).toBeLessThan(sourceTokens * 4 / 2)
  })
})

describe('overlapping notes and handoff roots are refused before any notes access', () => {
  it('refuses an equal, relative handoff root', async () => {
    const cwd = await scratch('dsh-forced-overlap-relative-')
    const refusal = await overlapRefusal('relative-leaf', cwd, {
      handoffDir: 'relative-leaf',
      notesDir: cwd,
    })

    expect(refusal.refusal).toMatch(/^TypeError: context-rollover: notesDir /)
    expect(refusal.refusal).toContain(resolve(cwd))
    assertRefusedBeforeNotes(refusal)
  })

  it('refuses a notes root nested under the handoff root', async () => {
    const cwd = await scratch('dsh-forced-overlap-nested-')
    const handoffDir = join(cwd, 'handoff-root')
    mkdirSync(handoffDir, { recursive: true })
    const refusal = await overlapRefusal('overlap-nested-default-notes', cwd, {
      handoffDir,
      notesDir: join(handoffDir, 'notes'),
    })

    expect(refusal.refusal).toMatch(/^TypeError: context-rollover: notesDir /)
    expect(refusal.refusal).toContain(resolve(handoffDir))
    assertRefusedBeforeNotes(refusal)
  })

  it('refuses a symlinked handoff directory that resolves onto the notes base', async () => {
    const cwd = await scratch('dsh-forced-overlap-symlink-')
    const notesBase = join(cwd, 'notes-base')
    const sessionId = 'overlap-symlinked-handoff'
    await mkdir(join(notesBase, sessionId), { recursive: true })
    await writeFile(join(notesBase, sessionId, 'state.md'), 'NOTE-READ-SENTINEL\n', 'utf8')
    await symlink(notesBase, join(cwd, 'linked-handoff'))
    const refusal = await overlapRefusal(sessionId, cwd, {
      handoffDir: 'linked-handoff',
      notesDir: notesBase,
    })

    expect(refusal.refusal).toMatch(/^TypeError: context-rollover: notesDir /)
    expect(refusal.refusal).toContain(realpathSync(notesBase))
    assertRefusedBeforeNotes(refusal)
  })

  it('refuses a symlinked handoff root whose notes leaf is absent', async () => {
    const cwd = await scratch('dsh-forced-overlap-absent-leaf-')
    const notesBase = join(cwd, 'real-notes-base')
    mkdirSync(notesBase, { recursive: true })
    // The handoff root is a link to the notes base, and the notes root is a
    // directory inside that base. Neither name lies under the other as written,
    // so only the handoff root's own realpath shows the containment, and the
    // per-session leaf under it does not exist, which is the state the
    // note-before-read check must survive.
    await symlink(notesBase, join(cwd, 'handoff-link'))
    const sessionId = 'overlap-absent-leaf-session'
    const refusal = await overlapRefusal(sessionId, cwd, {
      handoffDir: 'handoff-link',
      notesDir: notesBase,
    })

    expect(refusal.refusal).toMatch(/^TypeError: context-rollover: notesDir /)
    expect(refusal.refusal).toContain(realpathSync(notesBase))
    assertRefusedBeforeNotes(refusal)
  })
})

describe('a note entry that resolves into the handoff tree is never read or rendered', () => {
  it('skips a symlinked note entry and never enters a symlinked directory entry', async () => {
    const cwd = await scratch('dsh-forced-e2e-note-symlink-')
    const handoffDir = join(cwd, 'handoff')
    mkdirSync(handoffDir, { recursive: true })
    const sentinelPath = join(handoffDir, 'HANDOFF-linked.md')
    writeFileSync(
      sentinelPath,
      'LINKED-HANDOFF-SENTINEL: no compiled copy may carry this.\n',
      'utf8',
    )

    const harness = await engineHarness('forced-e2e-note-symlink', { ...AUTOMATIC, handoffDir }, { cwd })
    const { ctx, agent, session, notesBase } = harness
    const store = new NotesStore(NotesStore.directoryFor(session.id, notesBase))
    await store.write('state.md', 'E2E-NOTES-SENTINEL: the migration is the next step.\n')
    await store.write('plans/rollout.md', 'E2E-PLAN-SENTINEL\n')
    // Two escaping entries: a regular note replaced by a link into the handoff
    // tree, and a directory link a recursive listing could follow. The notes
    // root is a real directory outside the handoff root, so the root check
    // passes and only the store's own enumeration decides.
    await symlink(sentinelPath, join(store.root, 'linked.md'))
    await symlink(handoffDir, join(store.root, 'handoff-link'))

    startMonitoring(handoffDir, sentinelPath)
    expect(await recorderIsLive(handoffDir)).toBe(true)
    // The liveness probe above is the last touch this test allows itself.
    touches.length = 0
    allowRootProbe(handoffDir)
    const warnings: string[] = []
    const warn = ctx.logger.warn.bind(ctx.logger)
    ctx.logger.warn = (message: string): void => { warnings.push(message); warn(message) }
    const renderAll = vi.spyOn(NotesStore.prototype, 'renderAll')
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([textResponse('short answer')]))

    await followup(agent, longMessage('turn 1'))
    await followup(agent, longMessage('turn 2'))
    await followup(agent, longMessage('turn 3'))

    expect(countRollovers(session)).toBe(1)
    expect(renderAll).toHaveBeenCalled()
    const committed = session.snapshotEvents()
      .filter(event => event.type === 'compaction/summary')
      .flatMap(event => (event as { data: { summary?: Array<{ type: string; text?: string }> } }).data.summary ?? [])
      .filter(block => block.type === 'text' && block.text !== undefined)
      .map(block => block.text as string)
    expect(committed).toHaveLength(1)
    // Only the real notes reached the compiled copy.
    expect(committed[0]).toContain('E2E-NOTES-SENTINEL')
    expect(committed[0]).toContain('E2E-PLAN-SENTINEL')
    expect(committed[0]).not.toContain('LINKED-HANDOFF-SENTINEL')
    expect(derivedTexts(session).join('\n')).not.toContain('LINKED-HANDOFF-SENTINEL')

    // The boundary was never crossed: the linked entry was never read, and the
    // symlinked directory was never listed or statted through its own path.
    expect(touches).toEqual([])
    expect(warnings.filter(message => message.includes('context rollover failed'))).toEqual([])
    expect(await recorderIsLive(handoffDir)).toBe(true)
  })
})

/**
 * The shared acceptance for every overlapping fixture: nothing under the notes
 * base was read, statted or listed, the store never rendered, listed or read,
 * and no rollover committed.
 * @param refusal - what the fixture observed.
 */
function assertRefusedBeforeNotes(refusal: OverlapRefusal): void {
  expect(refusal.notesTouches).toEqual([])
  expect(refusal.notesCalls).toBe(0)
  expect(refusal.compactions).toBe(0)
}

/** What one overlapping fixture produced. */
interface OverlapRefusal {
  /** The forwarded refusal the engine logged, as `Name: message`. */
  readonly refusal: string
  /** Recorded accesses under the notes base, for the whole run. */
  readonly notesTouches: readonly PathTouch[]
  /** Reads, stats or listings the notes store itself performed. */
  readonly notesCalls: number
  readonly compactions: number
}

/**
 * Drive one forced crossing whose notes and handoff roots overlap, and report
 * whether the containment check refused it before any notes access.
 * @param id - session id, which becomes the per-session notes leaf.
 * @param cwd - session working directory a relative handoff root resolves against.
 * @param fixture - the notes base and the handoff root the configuration names.
 * @returns what the fixture observed, after the three turns ran.
 */
async function overlapRefusal(
  id: string,
  cwd: string,
  fixture: { handoffDir: string; notesDir: string },
): Promise<OverlapRefusal> {
  const handoffAbsolute = isAbsolute(fixture.handoffDir) ? resolve(fixture.handoffDir) : resolve(cwd, fixture.handoffDir)
  const storeReads = ['renderAll', 'list', 'read'].map(method =>
    vi.spyOn(NotesStore.prototype, method as 'renderAll')) as unknown as ReturnType<typeof vi.spyOn>[]

  const harness = await engineHarness(id, {
    ...AUTOMATIC,
    handoffDir: fixture.handoffDir,
    notesDir: fixture.notesDir,
  }, { cwd })
  // The forced path reaches the notes store only when a span is worth
  // replacing, and it keeps retrying while no span is. The crossing is
  // arranged so the store directory is absent for the whole fixture: a
  // rendered snapshot would let the first turn commit, and the refusal would
  // never be reached.
  const absentStore = vi.spyOn(NotesStore, 'directoryFor').mockImplementation((sessionId, baseDir) =>
    join(baseDir ?? fixture.notesDir, sessionId))
  // The engine canonicalizes the store directory, so that name and the root
  // it resolves to are entry points of the check; the handoff root is the
  // forbidden directory, and everything below the store directory is watched.
  startMonitoring(resolve(fixture.notesDir, id), handoffAbsolute)
  allowRootProbe(resolve(fixture.notesDir))
  // An absent notes root has no realpath of its own; its canonical form is the
  // nearest existing ancestor's realpath with the missing name appended.
  allowRootProbe(resolve(fixture.notesDir, id), existsSync(resolve(fixture.notesDir, id))
    ? realpathSync(resolve(fixture.notesDir, id))
    : resolve(fixture.notesDir, id))
  allowRootProbe(handoffAbsolute)
  const { ctx, agent } = harness
  let refusal = ''
  const warn = ctx.logger.warn.bind(ctx.logger)
  ctx.logger.warn = (message: string): void => {
    // The lifecycle logs the thrown value's message and the words it adds; the
    // refusal this test asserts on is the message up to that suffix.
    if (refusal === '' && message.includes('notesDir')) refusal = refusalText(message)
    warn(message)
  }
  ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([textResponse('short answer')]))

  await followup(agent, longMessage('turn one'))
  await followup(agent, longMessage('turn two'))
  await followup(agent, longMessage('turn three'))

  const notesCalls = storeReads.reduce((total, spy) => total + (spy as unknown as { mock: { calls: unknown[] } }).mock.calls.length, 0)
  // The store directory was requested, so an empty observation below is the
  // refusal's own doing rather than a store that was never reached.
  expect(absentStore).toHaveBeenCalled()
  vi.restoreAllMocks()
  return { refusal, notesTouches: [...touches], notesCalls, compactions: countRollovers(harness.session) }
}

/**
 * The refusal text the engine logged: the lifecycle logs `error.message`, so a
 * thrown TypeError arrives without its name. Re-attach the class name the
 * containment checks throw, so a test can assert on the class as well.
 * @param message - the logged warning.
 * @returns the refusal as `TypeError: <message>`.
 */
function refusalText(message: string): string {
  const unwrapped = message.replace(/^context rollover failed: /, '').replace(/; continuing the turn$/, '')
  return unwrapped.startsWith('context-rollover: notesDir') ? `TypeError: ${unwrapped}` : unwrapped
}
