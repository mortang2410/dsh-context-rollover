/**
 * The 90% emergency fallback: when the 40% handoff reminder was ignored and
 * usage reaches `thresholdRatio`, the automatic pressure rollover still commits
 * and still lands on a durable continuation context.
 *
 * The claims held down here are about ORDER and TIMING, not just about a
 * rollover happening:
 *
 * - the replacement is the newest usable handoff document, else the
 *   deterministic notes checkpoint, else nothing;
 * - a candidate that is unreadable, empty, oversized or not a regular file is
 *   skipped rather than fatal;
 * - the sizing decision happens BEFORE the compaction lock, so a refused
 *   candidate leaves no failed transaction in the durable log;
 * - a session with no working directory scans nothing and falls back to notes;
 * - the model-requested and overflow paths do not substitute a scanned
 *   document, because no model named one on the overflow path and the model
 *   named a specific file on the requested path.
 *
 * @module tests/emergency-fallback
 */

import { chmod, mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CONTEXT_WINDOW_EXCEEDED_CODE } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import { DEFAULT_HANDOFF_DIR, DEFAULT_HANDOFF_PATTERN, resolveConfig } from '../src/config.ts'
import {
  compareHandoffCandidates,
  matchesHandoffPattern,
  readHandoffFile,
  resolveHandoffPath,
  scanHandoffDir,
} from '../src/handoff.ts'
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
async function handoffDirIn(cwd: string, relative = DEFAULT_HANDOFF_DIR): Promise<string> {
  const dir = join(cwd, relative)
  await mkdir(dir, { recursive: true })
  return dir
}

/** Write one candidate handoff document with an explicit modification time. */
async function writeCandidate(
  dir: string,
  name: string,
  text: string,
  modifiedAt: Date,
): Promise<string> {
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

/** The model-visible text of one derived conversation, joined. */
function visibleTexts(session: Session): string {
  return derivedTexts(session).join('\n')
}

/**
 * The script shape a committed emergency rollover needs, reused by the cases
 * below: a first turn whose priced answer dwarfs any checkpoint, then a second
 * turn that makes two requests (a tool call, then an answer).
 *
 * Two requests matter. The first pressure pre-step of the turn sees only the
 * first turn's tail closed and selects a span too small for any replacement;
 * the second pre-step, after the tool call and its result, selects the whole
 * closed conversation. An implementation that spends the turn's single
 * emergency attempt on the first pre-step strands the context above the
 * threshold, which is exactly the failure the shrink-aware ordering prevents.
 */
function pressureScript(): ScriptedAdapter {
  return new ScriptedAdapter([
    usageResponse(`research answer one ${'detail '.repeat(600)}`, 5000),
    toolCall('get_context_remaining', '{}', 'c1'),
    usageResponse(`research answer two ${'detail '.repeat(600)}`, 6000),
  ])
}

/** The engine configuration every emergency case below shares. */
const EMERGENCY_CONFIG = {
  thresholdRatio: 0.001,
  reminderThresholdRatio: 0.001,
  handoffOnly: true,
} as const

describe('the emergency handoff scan', () => {
  it('defaults the directory and pattern, and resolves the directory against the session cwd', async () => {
    const config = resolveConfig({})
    expect(config.handoffDir).toBe('.scratch/handoff')
    expect(config.handoffPattern).toBe('HANDOFF-*.md')

    const cwd = await scratch('dsh-emergency-scan-')
    const dir = await handoffDirIn(cwd)
    const document = await writeCandidate(
      dir,
      'HANDOFF-session.md',
      '# Handoff\n\nbody\n',
      new Date('2024-01-01T00:00:00Z'),
    )
    // A sibling that does not match the shipped pattern.
    await writeCandidate(dir, 'notes.md', 'not a handoff\n', new Date('2024-06-01T00:00:00Z'))

    const candidates = await scanHandoffDir({
      dir: DEFAULT_HANDOFF_DIR,
      pattern: DEFAULT_HANDOFF_PATTERN,
      cwd,
    })
    expect(candidates.map(candidate => candidate.path)).toEqual([document])

    // The scan and the explicit path agree about where the handoff directory
    // is, because both resolve it through one rule.
    expect(resolveHandoffPath(DEFAULT_HANDOFF_DIR, cwd)).toEqual({ ok: true, path: dir })
    const viaRelativePath = await readHandoffFile({
      path: `${DEFAULT_HANDOFF_DIR}/HANDOFF-session.md`,
      cwd,
      maxChars: 20000,
    })
    expect(viaRelativePath.ok).toBe(true)
    if (viaRelativePath.ok === false) return
    expect(viaRelativePath.path).toBe(document)

    // The one resolution rule refuses a relative directory with no session
    // working directory. The process working directory here is the repository
    // root, which HAS a `.scratch/handoff`; a scan that consulted it would
    // resolve. The refusal proves the session cwd is the only base.
    const unresolved = resolveHandoffPath(DEFAULT_HANDOFF_DIR, undefined)
    expect(unresolved.ok).toBe(false)
    if (unresolved.ok !== false) return
    expect(unresolved.reason).toBe('no-cwd')
    expect(unresolved.path).toBeNull()
  })

  it('selects only names matching the configured file-name glob', () => {
    expect(matchesHandoffPattern('HANDOFF-topic.md', 'HANDOFF-*.md')).toBe(true)
    expect(matchesHandoffPattern('HANDOFF-.md', 'HANDOFF-*.md')).toBe(true)
    expect(matchesHandoffPattern('handoff-topic.md', 'HANDOFF-*.md')).toBe(false)
    expect(matchesHandoffPattern('HANDOFF-topic.md.bak', 'HANDOFF-*.md')).toBe(false)
    expect(matchesHandoffPattern('HANDOFF-a.md', 'HANDOFF-?.md')).toBe(true)
    expect(matchesHandoffPattern('HANDOFF-ab.md', 'HANDOFF-?.md')).toBe(false)
    // `.` in a pattern is a literal, not any character.
    expect(matchesHandoffPattern('HANDOFF-xmd', 'HANDOFF-*.md')).toBe(false)
    // A glob is a file-name pattern, so it never spans a path separator.
    expect(matchesHandoffPattern('nested/HANDOFF-x.md', 'HANDOFF-*.md')).toBe(false)
    expect(matchesHandoffPattern('HANDOFF-x.md', 'nested/HANDOFF-*.md')).toBe(false)
  })

  it('returns the matching candidates newest-modified first', async () => {
    const cwd = await scratch('dsh-emergency-order-')
    const dir = await handoffDirIn(cwd)
    const older = await writeCandidate(dir, 'HANDOFF-older.md', 'OLDER\n', new Date('2024-01-01T00:00:00Z'))
    const newer = await writeCandidate(dir, 'HANDOFF-newer.md', 'NEWER\n', new Date('2024-05-01T00:00:00Z'))
    await writeCandidate(dir, 'unrelated.txt', 'IGNORED\n', new Date('2025-01-01T00:00:00Z'))

    const candidates = await scanHandoffDir({
      dir: DEFAULT_HANDOFF_DIR,
      pattern: DEFAULT_HANDOFF_PATTERN,
      cwd,
    })
    expect(candidates.map(candidate => candidate.path)).toEqual([newer, older])
  })

  it('scans nothing when the session has no working directory to resolve the directory against', async () => {
    // The configured directory is relative and there is no session workspace,
    // so it cannot be resolved. The scan reports no candidates rather than
    // guessing the process working directory.
    const candidates = await scanHandoffDir({
      dir: DEFAULT_HANDOFF_DIR,
      pattern: DEFAULT_HANDOFF_PATTERN,
      cwd: undefined,
    })
    expect(candidates).toEqual([])
  })

  it('reports no candidates for a directory that does not exist', async () => {
    const cwd = await scratch('dsh-emergency-absent-')
    const candidates = await scanHandoffDir({
      dir: DEFAULT_HANDOFF_DIR,
      pattern: DEFAULT_HANDOFF_PATTERN,
      cwd,
    })
    expect(candidates).toEqual([])
  })

  it('honors a configured directory and pattern instead of the shipped defaults', async () => {
    // The keys are only "live" if a deployment that sets them gets its own
    // directory and its own file-name pattern. A DEFAULT handoff placed in the
    // shipped location must then be invisible.
    const cwd = await scratch('dsh-emergency-configured-')
    const configuredDir = await handoffDirIn(cwd, 'handoffs')
    await handoffDirIn(cwd)
    const wanted = await writeCandidate(
      configuredDir,
      'handoff-current.md',
      '# Handoff\n\nCONFIGURED-DIR-PATTERN-SENTINEL: continue here.\n',
      new Date('2024-05-01T00:00:00Z'),
    )
    await writeCandidate(
      configuredDir,
      'HANDOFF-shipped-name.md',
      '# Handoff\n\nSHIPPED-PATTERN-SENTINEL: must not match the configured pattern.\n',
      new Date('2024-06-01T00:00:00Z'),
    )
    await writeCandidate(
      join(cwd, DEFAULT_HANDOFF_DIR),
      'HANDOFF-shipped-location.md',
      '# Handoff\n\nSHIPPED-LOCATION-SENTINEL: must not be scanned.\n',
      new Date('2024-07-01T00:00:00Z'),
    )

    const { ctx, agent, session } = await engineHarness(
      'emergency-configured',
      { ...EMERGENCY_CONFIG, handoffDir: 'handoffs', handoffPattern: 'handoff-*.md' },
      { cwd },
    )
    const adapter = pressureScript()
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')

    expect(countRollovers(session)).toBe(1)
    const visible = visibleTexts(session)
    expect(visible).toContain('CONFIGURED-DIR-PATTERN-SENTINEL')
    expect(visible).not.toContain('SHIPPED-PATTERN-SENTINEL')
    expect(visible).not.toContain('SHIPPED-LOCATION-SENTINEL')

    // And the scan itself agrees with what the engine did.
    const candidates = await scanHandoffDir({ dir: 'handoffs', pattern: 'handoff-*.md', cwd })
    expect(candidates.map(candidate => candidate.path)).toEqual([wanted])
  })

  it('answers a pathological multi-star pattern promptly and correctly', { timeout: 30_000 }, () => {
    // `handoffPattern` is operator configuration, and a mis-typed pattern used
    // to hang the pre-step it runs inside: the previous implementation expanded
    // every `*` into a non-atomic `[^/]*` group, so a pattern with several stars
    // separated by a literal that never matches backtracked exponentially. The
    // shape below is the worst case for that translation.
    //
    // The elapsed-time bound is a REGRESSION GUARD, not the primary claim: what
    // is asserted first is the ANSWER. A fast matcher that returned the wrong
    // boolean would fail the equality checks below. What no assertion here can
    // do is prove a wrong-but-fast matcher is impossible, so the correctness
    // half is pinned by the explicit cases, including the ones where the shape
    // of the name (a literal `*` character) is where a naive re-implementation
    // gets it wrong.
    // The fixture size is chosen so the bound is SOUND, and choosing it took
    // measurement, because the intuitive sizes are both wrong:
    //   - 30 characters: the exponential translation lands anywhere from 207 ms
    //     to 906 ms, so it can slip UNDER a 1000 ms bound and pass. V8 abandons
    //     its backtracking past an internal budget, so the old cost is not even
    //     monotonic in the name length (22 stars took 29 ms, 24 took 4 ms).
    //   - 100_000 characters: the old translation never finishes, and vitest
    //     cannot interrupt a synchronous loop, so the whole suite HANGS instead
    //     of reporting a failure. Measured: a 42-character name did not finish
    //     in 25 s.
    // 34 characters is the size where the old translation reliably completes and
    // reliably exceeds the bound: 5.3 s across five runs (~39_000x the linear
    // matcher's 0.004 ms). The 1000 ms bound therefore sits ~5x below the broken
    // cost and ~250_000x above the correct one, so it cannot flake under load and
    // cannot pass an exponential matcher.
    const name = 'a'.repeat(34)
    const pathological = `${'*a'.repeat(12)}b`
    const startedAt = Date.now()
    const result = matchesHandoffPattern(name, pathological)
    const elapsedMs = Date.now() - startedAt
    // `*a` twelve times followed by `b` cannot match a run of 'a's with no 'b'.
    expect(result).toBe(false)
    expect(elapsedMs).toBeLessThan(1000)

    // The same shape, matching: the trailing literal is present, so the stars
    // must consume the run and the pattern must succeed.
    expect(matchesHandoffPattern(`${name}b`, pathological)).toBe(true)
    // The cost tracks the NAME length, not the star count: a second star-heavy
    // pattern over the same name must also stay well inside the bound.
    const secondStartedAt = Date.now()
    expect(matchesHandoffPattern(name, `${'*a'.repeat(6)}${'*b'.repeat(6)}`)).toBe(false)
    expect(Date.now() - secondStartedAt).toBeLessThan(1000)

    // Correctness on the shapes a wrong-but-fast matcher gets wrong. A `*` in
    // the NAME is an ordinary character: the pattern `*` is a wildcard that
    // matches it, and the pattern `a*b` matches the literal-star name `a*b`
    // by wildcard, not by literal equality.
    expect(matchesHandoffPattern('*b', '*')).toBe(true)
    expect(matchesHandoffPattern('*', '*')).toBe(true)
    expect(matchesHandoffPattern('a*b', 'a*b')).toBe(true)
    expect(matchesHandoffPattern('axb', 'a*b')).toBe(true)
    expect(matchesHandoffPattern('ab', 'a*b')).toBe(true)
    expect(matchesHandoffPattern('axc', 'a*b')).toBe(false)
    // A name containing a path separator is never selected, whichever the
    // pattern: the previous translation excluded separators from `*`, and a
    // hand-written matcher must preserve that rather than treat `/` as ordinary.
    expect(matchesHandoffPattern('a/b', '*')).toBe(false)
    expect(matchesHandoffPattern('a\\b', '*')).toBe(false)
    expect(matchesHandoffPattern('nested/HANDOFF-x.md', 'HANDOFF-*.md')).toBe(false)
  })

  it('orders two candidates that share a modification time by a total order', async () => {
    // Modification time is the documented key, but two files can share one (a
    // copy preserves mtimes; a filesystem with coarse timestamps rounds them
    // together). The tiebreak must therefore be a TOTAL order. The previous
    // `localeCompare` tiebreak was not: it reports equality for distinct names
    // that collate together, such as a precomposed `é` (U+00E9) and a
    // decomposed `e` plus combining acute, so those two would tie and fall back
    // to whatever order the directory happened to return.
    //
    // The comparator is asserted DIRECTLY, because that is the only way to make
    // this deterministic: a tie is exactly the input a stable sort resolves from
    // its own input order, so the scan's output alone can agree with the correct
    // answer by luck.
    const sharedMtime = 1_700_000_000_000
    const precomposed = path.join('dir', 'HANDOFF-\u00e9.md')
    const decomposed = path.join('dir', 'HANDOFF-e\u0301.md')
    expect(precomposed).not.toBe(decomposed)
    // The name pair really does collate equal, which is what made the old
    // tiebreak non-total.
    expect(path.basename(precomposed).localeCompare(path.basename(decomposed))).toBe(0)

    const a = { path: precomposed, modifiedAtMs: sharedMtime }
    const b = { path: decomposed, modifiedAtMs: sharedMtime }
    // Anti-symmetry and non-equality for two distinct paths sharing an mtime:
    // the old comparator returned 0 in both directions here.
    expect(compareHandoffCandidates(a, b)).not.toBe(0)
    expect(compareHandoffCandidates(b, a)).not.toBe(0)
    expect(Math.sign(compareHandoffCandidates(a, b)))
      .toBe(-Math.sign(compareHandoffCandidates(b, a)))
    // Reflexivity, and mtime still outranks the path half.
    expect(compareHandoffCandidates(a, a)).toBe(0)
    const older = { path: decomposed, modifiedAtMs: sharedMtime - 1000 }
    const newer = { path: precomposed, modifiedAtMs: sharedMtime }
    expect(compareHandoffCandidates(newer, older)).toBeLessThan(0)
    expect(compareHandoffCandidates(older, newer)).toBeGreaterThan(0)

    // End to end as well: the scan returns both, and repeats agree.
    const cwd = await scratch('dsh-emergency-tie-')
    const dir = await handoffDirIn(cwd)
    await writeCandidate(dir, 'HANDOFF-\u00e9.md', '# Handoff\n\nTIE-A\n', new Date(sharedMtime))
    await writeCandidate(dir, 'HANDOFF-e\u0301.md', '# Handoff\n\nTIE-B\n', new Date(sharedMtime))

    const first = await scanHandoffDir({
      dir: DEFAULT_HANDOFF_DIR,
      pattern: DEFAULT_HANDOFF_PATTERN,
      cwd,
    })
    expect(first).toHaveLength(2)
    for (let round = 0; round < 5; round += 1) {
      const again = await scanHandoffDir({
        dir: DEFAULT_HANDOFF_DIR,
        pattern: DEFAULT_HANDOFF_PATTERN,
        cwd,
      })
      expect(again.map(candidate => candidate.path)).toEqual(first.map(candidate => candidate.path))
    }
    // Ascending code-unit order of the absolute paths, which is what the
    // comparator defines; `e` + combining acute precedes precomposed `é`.
    expect(first.map(candidate => candidate.path))
      .toEqual([join(dir, 'HANDOFF-e\u0301.md'), join(dir, 'HANDOFF-\u00e9.md')])
  })
})

describe('the emergency replacement order', () => {
  it('lands the newest handoff document with zero pre-rollover sentinels', async () => {
    const cwd = await scratch('dsh-emergency-handoff-')
    const dir = await handoffDirIn(cwd)
    const documentText = '# Handoff\n\nEMERGENCY-DOCUMENT-SENTINEL: continue the migration.\n'
    await writeCandidate(dir, 'HANDOFF-migration.md', documentText, new Date('2024-05-01T00:00:00Z'))
    // An older candidate exists too: the newest must be the one that lands.
    await writeCandidate(
      dir,
      'HANDOFF-earlier.md',
      '# Handoff\n\nSUPERSEDED-DOCUMENT-SENTINEL: an earlier draft.\n',
      new Date('2024-01-01T00:00:00Z'),
    )

    const { ctx, agent, session, notesBase } = await engineHarness(
      'emergency-handoff',
      EMERGENCY_CONFIG,
      { cwd },
    )
    // Durable notes exist and would be a valid, smaller replacement, so this
    // case shows the handoff wins over a working fallback rather than being
    // the only thing available.
    const store = new NotesStore(NotesStore.directoryFor(session.id, notesBase))
    await store.write('state.md', 'goal: NOTES-FALLBACK-SENTINEL\n')

    const adapter = pressureScript()
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'OLD-TURN-ONE-SENTINEL research request')
    expect(countRollovers(session)).toBe(0)
    await followup(agent, 'turn two')

    expect(countRollovers(session)).toBe(1)
    const visible = visibleTexts(session)
    expect(visible).toContain('EMERGENCY-DOCUMENT-SENTINEL')
    // Newest by modification time, not by name and not by scan order.
    expect(visible).not.toContain('SUPERSEDED-DOCUMENT-SENTINEL')
    // The handoff composition carries no notes and no checkpoint wrapper.
    expect(visible).not.toContain('NOTES-FALLBACK-SENTINEL')
    expect(visible).not.toContain('<context-rollover checkpoint>')
    // `handoffOnly` retention: nothing of the old conversation survives.
    expect(visible).not.toContain('OLD-TURN-ONE-SENTINEL')
    expect(visible).not.toContain('research answer one')
    // The document's own bytes are the replacement, with nothing added.
    expect(derivedTexts(session)).toContain(documentText)

    const facts = transactionFacts(session)
    expect(facts.starts).toBe(1)
    expect(facts.summaries).toBe(1)
    expect(facts.ends).toBe(1)
    expect(facts.failedEnds).toEqual([])
  })

  it('prefers the newer of two candidates that both pass the shrink check', async () => {
    const cwd = await scratch('dsh-emergency-two-files-')
    const dir = await handoffDirIn(cwd)
    // Both are small enough to pass; only modification time separates them.
    // The OLDER file sorts first by name, so a name-ordered scan would pick it.
    await writeCandidate(
      dir,
      'HANDOFF-a-first-by-name.md',
      '# Handoff\n\nNAME-FIRST-CANDIDATE-SENTINEL: older file.\n',
      new Date('2024-01-01T00:00:00Z'),
    )
    await writeCandidate(
      dir,
      'HANDOFF-z-newer-by-mtime.md',
      '# Handoff\n\nMTIME-NEWEST-CANDIDATE-SENTINEL: newer file.\n',
      new Date('2024-05-01T00:00:00Z'),
    )

    const { ctx, agent, session } = await engineHarness('emergency-two-files', EMERGENCY_CONFIG, { cwd })
    const adapter = pressureScript()
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')

    expect(countRollovers(session)).toBe(1)
    const visible = visibleTexts(session)
    expect(visible).toContain('MTIME-NEWEST-CANDIDATE-SENTINEL')
    expect(visible).not.toContain('NAME-FIRST-CANDIDATE-SENTINEL')
  })

  it('commits the deterministic notes checkpoint when no handoff document exists', async () => {
    const cwd = await scratch('dsh-emergency-notes-')
    await handoffDirIn(cwd)

    const { ctx, agent, session, notesBase } = await engineHarness(
      'emergency-notes',
      EMERGENCY_CONFIG,
      { cwd },
    )
    const store = new NotesStore(NotesStore.directoryFor(session.id, notesBase))
    await store.write('state.md', 'EMERGENCY-NOTES-SENTINEL: next step is the migration.\n')

    const adapter = pressureScript()
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'OLD-TURN-ONE-SENTINEL research request')
    await followup(agent, 'turn two')

    expect(countRollovers(session)).toBe(1)
    const visible = visibleTexts(session)
    expect(visible).toContain('<context-rollover checkpoint>')
    expect(visible).toContain('EMERGENCY-NOTES-SENTINEL')
    expect(visible).toContain('reason: pressure')
    expect(visible).not.toContain('OLD-TURN-ONE-SENTINEL')

    const facts = transactionFacts(session)
    expect(facts.starts).toBe(1)
    expect(facts.ends).toBe(1)
    expect(facts.failedEnds).toEqual([])
  })

  it('skips a directory and an empty candidate and lands the next usable one', async () => {
    const cwd = await scratch('dsh-emergency-skip-')
    const dir = await handoffDirIn(cwd)
    // The newest entry is a DIRECTORY whose name matches the pattern: the scan
    // lists it and the read refuses it, so it must be skipped.
    const nested = join(dir, 'HANDOFF-directory.md')
    await mkdir(nested)
    await utimes(nested, new Date('2024-09-01T00:00:00Z'), new Date('2024-09-01T00:00:00Z'))
    // The next-newest is whitespace-only.
    await writeCandidate(dir, 'HANDOFF-blank.md', '   \n\n', new Date('2024-08-01T00:00:00Z'))
    // The oldest usable document must be the one that lands.
    await writeCandidate(
      dir,
      'HANDOFF-usable.md',
      '# Handoff\n\nUSABLE-CANDIDATE-SENTINEL: continue here.\n',
      new Date('2024-07-01T00:00:00Z'),
    )

    const { ctx, agent, session } = await engineHarness('emergency-skip', EMERGENCY_CONFIG, { cwd })
    const adapter = pressureScript()
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')

    // The bad candidates aborted nothing: the rollover still committed, on the
    // one usable document.
    expect(countRollovers(session)).toBe(1)
    const visible = visibleTexts(session)
    expect(visible).toContain('USABLE-CANDIDATE-SENTINEL')
    expect(visible).not.toContain('<context-rollover checkpoint>')
    const facts = transactionFacts(session)
    expect(facts.starts).toBe(1)
    expect(facts.ends).toBe(1)
    expect(facts.failedEnds).toEqual([])
  })

  it('falls back to notes when every candidate is oversized, empty or not a file', async () => {
    const cwd = await scratch('dsh-emergency-all-bad-')
    const dir = await handoffDirIn(cwd)
    const oversized = 'x'.repeat(4000)
    await writeCandidate(dir, 'HANDOFF-oversized.md', oversized, new Date('2024-09-01T00:00:00Z'))
    await writeCandidate(dir, 'HANDOFF-blank.md', '\n\t \n', new Date('2024-08-01T00:00:00Z'))
    await mkdir(join(dir, 'HANDOFF-directory.md'))

    const { ctx, agent, session, notesBase } = await engineHarness(
      'emergency-all-bad',
      { ...EMERGENCY_CONFIG, handoffMaxChars: 1000 },
      { cwd },
    )
    const store = new NotesStore(NotesStore.directoryFor(session.id, notesBase))
    await store.write('state.md', 'ALL-BAD-NOTES-SENTINEL: notes carry the state.\n')

    const adapter = pressureScript()
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')

    expect(countRollovers(session)).toBe(1)
    const visible = visibleTexts(session)
    expect(visible).toContain('<context-rollover checkpoint>')
    expect(visible).toContain('ALL-BAD-NOTES-SENTINEL')
    expect(visible).not.toContain(oversized)

    const facts = transactionFacts(session)
    expect(facts.starts).toBe(1)
    expect(facts.ends).toBe(1)
    expect(facts.failedEnds).toEqual([])
  })

  it.skipIf(typeof process.getuid === 'function' && process.getuid() === 0)(
    'skips an unreadable newest candidate and lands the readable older one',
    async () => {
      const cwd = await scratch('dsh-emergency-unreadable-')
      const dir = await handoffDirIn(cwd)
      const locked = await writeCandidate(
        dir,
        'HANDOFF-locked.md',
        '# Handoff\n\nLOCKED-CANDIDATE-SENTINEL\n',
        new Date('2024-09-01T00:00:00Z'),
      )
      await chmod(locked, 0o000)
      await writeCandidate(
        dir,
        'HANDOFF-readable.md',
        '# Handoff\n\nREADABLE-CANDIDATE-SENTINEL: continue here.\n',
        new Date('2024-07-01T00:00:00Z'),
      )

      const { ctx, agent, session } = await engineHarness('emergency-unreadable', EMERGENCY_CONFIG, { cwd })
      const adapter = pressureScript()
      ctx.llm.registerAdapter(['mock'], adapter)

      await followup(agent, 'turn one')
      await followup(agent, 'turn two')

      expect(countRollovers(session)).toBe(1)
      const visible = visibleTexts(session)
      expect(visible).toContain('READABLE-CANDIDATE-SENTINEL')
      expect(visible).not.toContain('LOCKED-CANDIDATE-SENTINEL')
    },
  )

  it('uses the notes checkpoint when the newest handoff cannot shrink the span', async () => {
    const cwd = await scratch('dsh-emergency-too-big-')
    const dir = await handoffDirIn(cwd)
    // Readable and under the shipped size limit, but far larger than the span
    // it would replace: the shrink check must reject it and leave the notes
    // checkpoint available, rather than consuming the turn's one attempt.
    await writeCandidate(
      dir,
      'HANDOFF-too-big.md',
      `# Handoff\n\n${'detail line\n'.repeat(800)}`,
      new Date('2024-09-01T00:00:00Z'),
    )

    const { ctx, agent, session, notesBase } = await engineHarness(
      'emergency-too-big',
      EMERGENCY_CONFIG,
      { cwd },
    )
    const store = new NotesStore(NotesStore.directoryFor(session.id, notesBase))
    await store.write('state.md', 'SHRINK-AWARE-NOTES-SENTINEL: notes are smaller.\n')

    const adapter = pressureScript()
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')

    // The rollover still commits, on the notes checkpoint.
    expect(countRollovers(session)).toBe(1)
    const visible = visibleTexts(session)
    expect(visible).toContain('<context-rollover checkpoint>')
    expect(visible).toContain('SHRINK-AWARE-NOTES-SENTINEL')
    expect(visible).toContain('reason: pressure')
    // The oversized document was not substituted in and did not become the
    // continuation context.
    expect(visible).not.toContain('detail line')
  })

  it('decides the size before the lock, so a refused candidate leaves no failed transaction', async () => {
    const cwd = await scratch('dsh-emergency-preflight-')
    const dir = await handoffDirIn(cwd)
    await writeCandidate(
      dir,
      'HANDOFF-too-big.md',
      `# Handoff\n\n${'detail line\n'.repeat(800)}`,
      new Date('2024-09-01T00:00:00Z'),
    )

    const { ctx, agent, session } = await engineHarness('emergency-preflight', EMERGENCY_CONFIG, { cwd })

    // Keep every diagnostic the engine swallows. A rejection deferred to the
    // transaction would surface here as the shrink guard's own refusal instead.
    const diagnostics: string[] = []
    const originalInfo = ctx.logger.info.bind(ctx.logger)
    const originalWarn = ctx.logger.warn.bind(ctx.logger)
    ctx.logger.info = (message: string): void => {
      diagnostics.push(message)
      originalInfo(message)
    }
    ctx.logger.warn = (message: string): void => {
      diagnostics.push(message)
      originalWarn(message)
    }

    const adapter = pressureScript()
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')

    // Exactly one transaction, opened and closed once, carrying no error: the
    // rejected candidate never reached `compaction/start`.
    const facts = transactionFacts(session)
    expect(facts.starts).toBe(1)
    expect(facts.summaries).toBe(1)
    expect(facts.ends).toBe(1)
    expect(facts.failedEnds).toEqual([])
    expect(countRollovers(session)).toBe(1)
    // The refusal is a diagnostic line, never a failed transaction.
    expect(diagnostics.some(message => message.includes('not smaller than the shadowed content'))).toBe(false)
    expect(diagnostics.some(message => message.includes('skipping handoff candidate'))).toBe(true)
  })

  it('reuses the sizing it decided with, instead of re-pricing the candidate at commit time', async () => {
    const cwd = await scratch('dsh-emergency-pin-')
    const dir = await handoffDirIn(cwd)
    const documentText = '# Handoff\n\nPIN-REUSE-DOCUMENT-SENTINEL: continue the migration.\n'
    await writeCandidate(dir, 'HANDOFF-pin.md', documentText, new Date('2024-05-01T00:00:00Z'))

    const { ctx, agent, session } = await engineHarness('emergency-pin', EMERGENCY_CONFIG, { cwd })

    // Count how often the exact committed text is priced. The emergency path
    // prices its chosen candidate once, before the lock, and hands that sizing
    // to the transaction; if the transaction re-priced the same candidate there
    // would be a second call. Counting per-text calls makes that visible without
    // depending on the two numbers happening to agree.
    const meter = ctx.tokenMeter
    const originalEstimate = meter.estimateMessage.bind(meter)
    let documentPrices = 0
    ;(meter as unknown as { estimateMessage: typeof originalEstimate }).estimateMessage = (message) => {
      const value = originalEstimate(message)
      const text = message.content
        .map(block => block.type === 'text' ? block.text : '')
        .join('')
      if (text === documentText) documentPrices += 1
      return value
    }

    const adapter = pressureScript()
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')

    expect(countRollovers(session)).toBe(1)
    expect(visibleTexts(session)).toContain('PIN-REUSE-DOCUMENT-SENTINEL')
    // Exactly one price for the committed document text: the preflight's, reused
    // by the transaction. A commit-time re-price would make this two.
    expect(documentPrices).toBe(1)
  })

  it('does not scan for a handoff when the session has no working directory', async () => {
    // No `cwd` in the session header: the configured directory is relative, so
    // there is nothing to resolve it against. The engine must fall back to the
    // notes checkpoint instead of reading anywhere else.
    const { ctx, agent, session, notesBase } = await engineHarness('emergency-no-cwd', EMERGENCY_CONFIG)
    const store = new NotesStore(NotesStore.directoryFor(session.id, notesBase))
    await store.write('state.md', 'NO-CWD-NOTES-SENTINEL: notes carry the state.\n')

    const adapter = pressureScript()
    ctx.llm.registerAdapter(['mock'], adapter)

    await followup(agent, 'turn one')
    await followup(agent, 'turn two')

    expect(countRollovers(session)).toBe(1)
    const visible = visibleTexts(session)
    expect(visible).toContain('<context-rollover checkpoint>')
    expect(visible).toContain('NO-CWD-NOTES-SENTINEL')

    const facts = transactionFacts(session)
    expect(facts.starts).toBe(1)
    expect(facts.ends).toBe(1)
    expect(facts.failedEnds).toEqual([])
  })
})

describe('the emergency path at the shipped 0.90 threshold', () => {
  it('commits exactly one rollover and delivers no reminder when the reminder point is level with it', async () => {
    // The shipped 0.90 emergency point, with the reminder point raised level
    // with it so no reminder may fire below the rollover: everything the
    // crossing does must come from the emergency path.
    //
    // No `usage` chunk is scripted, so the meter prices the real surface. That
    // matters here: an honest provider usage anchor stays at its measured value
    // until the next request re-anchors it, which would keep reading as "over
    // the threshold" on the post-rollover surface. A surface-priced reading
    // genuinely falls once the checkpoint replaces the conversation, which is
    // what "usage crossing 0.90" has to mean for this claim to hold.
    const { ctx, agent, session, notesBase } = await engineHarness('emergency-ninety', {
      thresholdRatio: 0.9,
      reminderThresholdRatio: 0.9,
      handoffOnly: true,
    })
    const store = new NotesStore(NotesStore.directoryFor(session.id, notesBase))
    await store.write('state.md', 'NINETY-NOTES-SENTINEL: the emergency point was reached.\n')

    // One repeatable answer, large enough that the accumulated surface crosses
    // 0.90 of the mock adapter's 100k window in a bounded number of turns and
    // small enough that the post-rollover surface is far below the point.
    const adapter = new ScriptedAdapter([
      textResponse(`research answer ${'detail '.repeat(3000)}`),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    for (let round = 0; round < 40 && countRollovers(session) === 0; round += 1) {
      await followup(agent, `research question ${round}`)
    }

    // The crossing really happened; without this the length assertions below
    // would pass vacuously against a loop that ran out of rounds.
    expect(countRollovers(session)).toBe(1)
    expect(reminderTexts(session)).toHaveLength(0)
    const visible = visibleTexts(session)
    expect(visible).toContain('<context-rollover checkpoint>')
    expect(visible).toContain('NINETY-NOTES-SENTINEL')
    expect(visible).toContain('reason: pressure')

    const facts = transactionFacts(session)
    expect(facts.starts).toBe(1)
    expect(facts.ends).toBe(1)
    expect(facts.failedEnds).toEqual([])
  })
})

describe('the other rollover paths keep their replacement rule', () => {
  it('does not substitute a scanned handoff on the model-requested path', async () => {
    const cwd = await scratch('dsh-emergency-model-requested-')
    const dir = await handoffDirIn(cwd)
    // A document the emergency scan WOULD pick up. The model names a different
    // file, so the named one is what crosses the boundary.
    await writeCandidate(
      dir,
      'HANDOFF-scanned.md',
      '# Handoff\n\nSCANNED-DOCUMENT-SENTINEL: must not be substituted.\n',
      new Date('2024-05-01T00:00:00Z'),
    )
    const named = join(cwd, 'HANDOFF-named.md')
    await writeFile(named, '# Handoff\n\nNAMED-DOCUMENT-SENTINEL: the model chose this file.\n', 'utf8')

    const { ctx, agent, session } = await engineHarness(
      'emergency-model-requested',
      { handoffOnly: true },
      { cwd },
    )
    const adapter = new ScriptedAdapter([
      ...Array.from({ length: 12 }, (_unused, index) => textResponse(`filler ${index}`)),
      newContextCall(JSON.stringify({ handoff_path: named })),
      textResponse('done'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 12)
    await followup(agent, 'ask for the boundary')

    expect(countRollovers(session)).toBe(1)
    const visible = visibleTexts(session)
    expect(visible).toContain('NAMED-DOCUMENT-SENTINEL')
    expect(visible).not.toContain('SCANNED-DOCUMENT-SENTINEL')
  })

  it('keeps the notes checkpoint on the overflow path, with no scanned substitution', async () => {
    const cwd = await scratch('dsh-emergency-overflow-')
    const dir = await handoffDirIn(cwd)
    await writeCandidate(
      dir,
      'HANDOFF-scanned.md',
      '# Handoff\n\nOVERFLOW-SCANNED-SENTINEL: must not be substituted.\n',
      new Date('2024-05-01T00:00:00Z'),
    )

    const { ctx, agent, session } = await engineHarness('emergency-overflow', {}, { cwd })
    const adapter = new ScriptedAdapter([
      ...Array.from({ length: 20 }, (_unused, index) => textResponse(`finding ${index} details`)),
      errorFinish('request too large for model context window', CONTEXT_WINDOW_EXCEEDED_CODE),
      textResponse('recovered after rollover'),
    ])
    ctx.llm.registerAdapter(['mock'], adapter)

    await seedExchanges(agent, 20)
    await followup(agent, 'next request should overflow')

    expect(countRollovers(session)).toBe(1)
    const visible = visibleTexts(session)
    expect(visible).toContain('<context-rollover checkpoint>')
    expect(visible).toContain('recovered after rollover')
    // No model named a document on this path, so no document is substituted.
    expect(visible).not.toContain('OVERFLOW-SCANNED-SENTINEL')
  })
})
