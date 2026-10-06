/**
 * Handoff document resolution and reading.
 *
 * The module owns one rule with two surfaces: a throwing read for
 * `new_context` (the refusal must reach the model as a tool result) and a
 * non-throwing probe for the emergency scan (a bad candidate is skipped, not
 * fatal). Both are asserted here, per failure case, with the specific failure
 * rather than "something threw".
 *
 * @module tests/handoff
 */

import { chmod, mkdir, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { readHandoffFile, readHandoffFileOrThrow, HandoffError } from '../src/handoff.ts'
import { resolveConfig } from '../src/config.ts'
import { engineHarness, followup, ScriptedAdapter, textResponse } from './harness.ts'

/** Scratch directories removed after the run, wherever a case creates one. */
const scratchDirs: string[] = []

/** Create one scratch directory under the OS temp dir, removed after the run. */
async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-handoff-'))
  scratchDirs.push(dir)
  return dir
}

afterAll(async () => {
  while (scratchDirs.length > 0) {
    const dir = scratchDirs.pop()
    if (dir !== undefined) await rm(dir, { recursive: true, force: true })
  }
})

/** A permission test cannot fail correctly while running as root. */
const runningAsRoot = typeof process.getuid === 'function' && process.getuid() === 0

describe('handoff path resolution', () => {
  it('resolves an absolute path and a cwd-relative path to the same file', async () => {
    const dir = await scratch()
    const absolute = join(dir, 'HANDOFF-topic.md')
    await writeFile(absolute, '# handoff\n\nbody\n', 'utf8')

    const viaAbsolute = await readHandoffFile({ path: absolute, cwd: dir, maxChars: 20000 })
    const viaRelative = await readHandoffFile({ path: 'HANDOFF-topic.md', cwd: dir, maxChars: 20000 })
    const viaNestedRelative = await readHandoffFile({ path: './HANDOFF-topic.md', cwd: dir, maxChars: 20000 })

    if (viaAbsolute.ok === false || viaRelative.ok === false || viaNestedRelative.ok === false) {
      throw new Error('expected all three resolutions to succeed')
    }
    expect(viaRelative.path).toBe(absolute)
    expect(viaNestedRelative.path).toBe(absolute)
    expect(viaRelative.text).toBe(viaAbsolute.text)
    expect(viaNestedRelative.text).toBe(viaAbsolute.text)
  })

  it('refuses a relative path when the session has no working directory', async () => {
    const result = await readHandoffFile({ path: 'HANDOFF-topic.md', cwd: undefined, maxChars: 20000 })
    expect(result.ok).toBe(false)
    if (result.ok !== false) return
    expect(result.reason).toBe('no-cwd')
    expect(result.message).toContain('HANDOFF-topic.md')
    expect(result.message).toContain('no working directory')
    // Nothing was resolved, so nothing can have been read or reported as read.
    expect(result.path).toBeNull()
  })

  it('reads only the named file, never a sibling candidate', async () => {
    const dir = await scratch()
    await writeFile(join(dir, 'HANDOFF-older.md'), 'OLDER DOCUMENT BODY\n', 'utf8')
    await writeFile(join(dir, 'HANDOFF-newer.md'), 'NEWER DOCUMENT BODY\n', 'utf8')

    const result = await readHandoffFile({ path: 'HANDOFF-older.md', cwd: dir, maxChars: 20000 })
    if (result.ok === false) throw new Error(`expected success, got ${result.reason}: ${result.message}`)
    expect(result.text).toBe('OLDER DOCUMENT BODY\n')
    expect(result.text).not.toContain('NEWER DOCUMENT BODY')
    // The module reads a named path only: it creates and scans nothing.
    expect((await readdir(dir)).sort()).toEqual(['HANDOFF-newer.md', 'HANDOFF-older.md'])
  })
})

describe('handoff refusal cases', () => {
  it('refuses an empty path', async () => {
    const dir = await scratch()
    const result = await readHandoffFile({ path: '   ', cwd: dir, maxChars: 20000 })
    expect(result.ok).toBe(false)
    if (result.ok !== false) return
    expect(result.reason).toBe('empty-path')
    expect(result.message).toContain('handoff_path is empty')
  })

  it('refuses a missing file, naming the path', async () => {
    const dir = await scratch()
    const missing = join(dir, 'HANDOFF-absent.md')
    const result = await readHandoffFile({ path: missing, cwd: dir, maxChars: 20000 })
    expect(result.ok).toBe(false)
    if (result.ok !== false) return
    expect(result.reason).toBe('missing')
    expect(result.path).toBe(missing)
    expect(result.message).toContain(missing)
    expect(result.message).toContain('no handoff document')
  })

  it('refuses a directory, naming it as not a regular file', async () => {
    const dir = await scratch()
    const nested = join(dir, 'handoff-dir')
    await mkdir(nested)
    const result = await readHandoffFile({ path: nested, cwd: dir, maxChars: 20000 })
    expect(result.ok).toBe(false)
    if (result.ok !== false) return
    expect(result.reason).toBe('not-a-file')
    expect(result.path).toBe(nested)
    expect(result.message).toContain('not a regular file')
    expect(result.message).toContain('directory')
  })

  it('refuses a symlink loop, naming the cause', async () => {
    const dir = await scratch()
    const loop = join(dir, 'HANDOFF-loop.md')
    await symlink(loop, loop)
    const result = await readHandoffFile({ path: loop, cwd: dir, maxChars: 20000 })
    expect(result.ok).toBe(false)
    if (result.ok !== false) return
    expect(result.reason).toBe('unreadable')
    expect(result.path).toBe(loop)
    // Actionable means the operator can look up the cause: name the OS code.
    expect(result.message).toContain('ELOOP')
    expect(result.message).toContain(loop)
  })

  it.skipIf(runningAsRoot)('refuses an unreadable file, naming the cause', async () => {
    const dir = await scratch()
    const unreadable = join(dir, 'HANDOFF-locked.md')
    await writeFile(unreadable, '# handoff\n', 'utf8')
    await chmod(unreadable, 0o000)
    const result = await readHandoffFile({ path: unreadable, cwd: dir, maxChars: 20000 })
    expect(result.ok).toBe(false)
    if (result.ok !== false) return
    expect(result.reason).toBe('unreadable')
    expect(result.path).toBe(unreadable)
    expect(result.message).toContain('EACCES')
    expect(result.message).toContain(unreadable)
  })

  it('refuses whitespace-only content', async () => {
    const dir = await scratch()
    const blank = join(dir, 'HANDOFF-blank.md')
    await writeFile(blank, '\n\t  \n\n', 'utf8')
    const result = await readHandoffFile({ path: blank, cwd: dir, maxChars: 20000 })
    expect(result.ok).toBe(false)
    if (result.ok !== false) return
    expect(result.reason).toBe('empty')
    expect(result.path).toBe(blank)
    expect(result.message).toContain('is empty')
  })

  it('refuses content over the limit, naming both the limit and the actual size', async () => {
    const dir = await scratch()
    const big = join(dir, 'HANDOFF-big.md')
    const text = 'x'.repeat(2048)
    await writeFile(big, text, 'utf8')

    const result = await readHandoffFile({ path: big, cwd: dir, maxChars: 1000 })
    expect(result.ok).toBe(false)
    if (result.ok !== false) return
    expect(result.reason).toBe('too-large')
    expect(result.path).toBe(big)
    expect(result.message).toContain('1000')
    expect(result.message).toContain(String(text.length))
    expect(result.message).toContain('handoffMaxChars')
  })

  it('accepts content exactly at the limit', async () => {
    const dir = await scratch()
    const exact = join(dir, 'HANDOFF-exact.md')
    const text = 'y'.repeat(1000)
    await writeFile(exact, text, 'utf8')
    const result = await readHandoffFile({ path: exact, cwd: dir, maxChars: 1000 })
    expect(result.ok).toBe(true)
    if (result.ok === false) return
    expect(result.text).toBe(text)
  })
})

describe('handoff success content', () => {
  it('returns the file text byte-identical to what was written', async () => {
    const dir = await scratch()
    const path = join(dir, 'HANDOFF-verbatim.md')
    // No trailing newline, CRLF, a BOM-free multibyte char and markdown that
    // the engine's own checkpoint framing would otherwise collide with.
    const text = '# Handoff — 移行\n\r\n<context-rollover checkpoint>\n\n- item  \n no trailing newline'
    await writeFile(path, text, 'utf8')

    const result = await readHandoffFileOrThrow({ path, cwd: dir, maxChars: 20000 })
    expect(result.text).toBe(text)
    // Byte identity, not just string equality: no normalization on the way in.
    expect(Buffer.byteLength(result.text, 'utf8')).toBe(Buffer.byteLength(text, 'utf8'))
    expect(result.path).toBe(path)
    // No wrapper, preamble or marker was added around the document.
    expect(result.text.startsWith('# Handoff')).toBe(true)
    expect(result.text.endsWith('no trailing newline')).toBe(true)
    expect(result.text).not.toContain('## Handoff')
  })
})

describe('throwing and non-throwing callers share one rule', () => {
  it('throws a typed error carrying the same reason the probe reports', async () => {
    const dir = await scratch()
    const missing = join(dir, 'HANDOFF-absent.md')
    const request = { path: missing, cwd: dir, maxChars: 20000 }

    const probed = await readHandoffFile(request)
    expect(probed.ok).toBe(false)

    // The emergency scan needs the failure as data, so it can skip one bad
    // candidate instead of aborting the whole rollover.
    await expect(readHandoffFileOrThrow(request)).rejects.toBeInstanceOf(HandoffError)
    await expect(readHandoffFileOrThrow(request)).rejects.toThrow(/no handoff document/)
    const error = await readHandoffFileOrThrow(request).catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(HandoffError)
    expect((error as HandoffError).reason).toBe(probed.ok === false ? probed.reason : 'unreachable')
  })
})

describe('handoff configuration surface', () => {
  it('defaults handoffDir and handoffPattern to the /handoff-doc skill contract', () => {
    const config = resolveConfig({})
    expect(config.handoffDir).toBe('.scratch/handoff')
    expect(config.handoffPattern).toBe('HANDOFF-*.md')
  })

  it('rejects a blank handoff directory or pattern at load', () => {
    expect(() => resolveConfig({ handoffDir: '  ' })).toThrow(/handoffDir must be a non-empty string/)
    expect(() => resolveConfig({ handoffDir: '' })).toThrow(/handoffDir must be a non-empty string/)
    expect(() => resolveConfig({ handoffPattern: '\n' })).toThrow(/handoffPattern must be a non-empty string/)
    expect(resolveConfig({ handoffDir: 'handoffs', handoffPattern: '*.md' }).handoffDir).toBe('handoffs')
  })
})

describe('new_context refuses where the model can read it', () => {
  it('reports a missing relative handoff when the session has no working directory', async () => {
    const { ctx, agent, session } = await engineHarness('handoff-tool-no-cwd')
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'h1' as never,
      name: 'new_context',
      arguments: { handoff_path: '.scratch/handoff/HANDOFF-x.md' },
      agent,
    })

    // The refusal must be the tool result the model reads, not a swallowed
    // warning: the engine's pre-step listener logs every failure instead.
    expect(result.isError).toBe(true)
    const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('no working directory')
    // No transaction was opened and no boundary was recorded.
    expect(session.snapshotEvents().some(event => event.type === 'compaction/start')).toBe(false)
    expect(session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
  })

  it('refuses a path that is a directory, and a missing one, distinctly', async () => {
    const dir = await scratch()
    const { ctx, agent } = await engineHarness('handoff-tool-refusals', {}, { cwd: dir })

    const forDirectory = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'h2' as never,
      name: 'new_context',
      arguments: { handoff_path: '.' },
      agent,
    })
    expect(forDirectory.isError).toBe(true)
    expect(JSON.stringify(forDirectory.content)).toContain('not a regular file')

    const forMissing = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'h3' as never,
      name: 'new_context',
      arguments: { handoff_path: 'HANDOFF-absent.md' },
      agent,
    })
    expect(forMissing.isError).toBe(true)
    const missingText = JSON.stringify(forMissing.content)
    expect(missingText).toContain('no handoff document')
    expect(missingText).not.toContain('not a regular file')
  })

  it('records the resolved document text for a cwd-relative path', async () => {
    const dir = await scratch()
    await mkdir(join(dir, '.scratch', 'handoff'), { recursive: true })
    const documentText = '# Handoff\n\nGoal: prove the tool resolves a relative path.\n'
    await writeFile(join(dir, '.scratch', 'handoff', 'HANDOFF-topic.md'), documentText, 'utf8')

    const { ctx, agent, engine } = await engineHarness('handoff-tool-ok', {}, { cwd: dir })
    // A real conversation first. `new_context` refuses when the active context has no
    // replaceable span beyond its standing instructions, because a boundary there would
    // free nothing and the engine would decline the commit - so accepting the request
    // would report a rollover that never happens. An empty session is that case, which
    // the refusal test below covers; this case needs a span to price.
    const adapter = new ScriptedAdapter(
      Array.from({ length: 12 }, (_unused, index) => textResponse(`turn ${index} ${'detail '.repeat(60)}`)),
    )
    ctx.llm.registerAdapter(['mock'], adapter)
    for (let turn = 0; turn < 12; turn += 1) await followup(agent, `question ${turn}`)

    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: 'h4' as never,
      name: 'new_context',
      arguments: { handoff_path: '.scratch/handoff/HANDOFF-topic.md' },
      agent,
    })
    expect(result.isError).toBe(false)

    // The engine consumes already-read text: it never re-resolves the path.
    const pending = (engine as unknown as {
      pendingRollovers: Map<string, { handoff: string | null; handoffPath?: string }>
    }).pendingRollovers
    const recorded = [...pending.values()][0]
    expect(recorded?.handoff).toBe(documentText)
    expect(recorded?.handoffPath).toBe(join(dir, '.scratch', 'handoff', 'HANDOFF-topic.md'))
  })
})
