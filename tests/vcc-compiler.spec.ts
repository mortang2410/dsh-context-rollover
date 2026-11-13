/**
 * The vendored VCC compiler (ticket sycr, contract C1): tokenizer, block
 * budgets, elision passes, checkpoint framing, and the read-back helpers.
 *
 * Adapted from `dsh-compaction-vcc@0.7.4` `test/compiler.test.js`,
 * `test/cap-notice.test.js`, `test/elide-sources.test.js`,
 * `test/elide-checkpoint-bodies.test.js`, and `test/malformed-nodes.test.js`
 * (settles skeleton uncertainty U2). Upstream declares its cases with
 * `node:test` and `node:assert/strict`; here `test(...)` became `it(...)`
 * inside one `describe(...)` per upstream file, with an ordered upstream
 * inventory pinned so a dropped case fails, and `assert.equal` /
 * `assert.deepEqual` / `assert.match` / `assert.ok` / `assert.throws` became
 * their `expect` equivalents. Assertions were not relaxed, except where the
 * ticket's criteria ask for less than upstream's: a credential-blob assertion
 * whose fixture carried a JWT-shaped string now checks only that the call
 * line was cut and that its marker points at the durable row.
 *
 * Cases marked "fork" are new: the tool-result node shape the host derives
 * (role `tool`, message-level `toolCallId`), the declaration extension, the
 * read-back helpers, the dropped-row markers, and the published defaults.
 *
 * @module tests/vcc-compiler
 */

import { readFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'
import type { CompileBudgets, CompileConfig, CompileEntry, CompileNode, CompileRole } from '../src/vcc/compiler.ts'

// VCC landed with debug diagnostics that may reach `console.error`; the fork's
// suite loads this module in the same process as every other test file, so the
// stderr write is silenced here rather than removed from the vendored code.

vi.spyOn(console, 'error').mockImplementation(() => {})

import {
  CHECKPOINT_CLOSE_TAG,
  CHECKPOINT_OPEN_TAG,
  CHECKPOINT_PREAMBLE,
  DEFAULT_ARG_TOOLS,
  DEFAULT_NOISE_PATTERNS,
  DEFAULT_TOOL_KEY_FIELDS,
  RECALL_GUIDE,
  compileNodes,
  compileNoisePatterns,
  compileRegion,
  countTokens,
  elideCheckpointInjectedBodies,
  entryText,
  estimateDeepSeekTokens,
  estimateEntryTokens,
  excerptToolResult,
  frameCheckpoint,
  isCheckpointSource,
  isCjkChar,
  isElidableSource,
  joinCompiledEntries,
  oneLineArg,
  parseToolArguments,
  pickToolKeyArg,
  projectToolResultText,
  sanitize,
  stripNoiseXml,
  tokenize,
  truncateTokens,
} from '../src/vcc/compiler.ts'
/** Upstream `test/compiler.test.js` CONFIG. */
const CONFIG: CompileConfig = {
  maxTokens: 8192,
  textTokens: 512,
  userTextTokens: 1024,
  toolCallTokens: 128,
  toolResultExcerptTokens: 256,
  includeReasoning: false,
  stripNoiseXml: true,
  noisePatterns: compileNoisePatterns(DEFAULT_NOISE_PATTERNS),
  toolKeyFields: {},
  toolArgTools: ['read', 'write', 'edit', 'glob', 'grep', 'bash', 'shell', 'web_search', 'skill', 'subagent', 'subagent_fork', 'ralph', 'workflow'],
  hideTools: [],
}

/** Upstream `test/cap-notice.test.js` and `test/elide-sources.test.js` base. */
const SMALL_BASE: CompileConfig = {
  ...CONFIG,
  userTextTokens: 16384,
  toolArgTools: [],
  elideSourceKinds: [],
}

/** Upstream `test/elide-checkpoint-bodies.test.js` checkpoint node. */
function checkpointNode(text: string): CompileNode {
  return {
    seq: 1,
    message: { role: 'user', content: [{ type: 'text', text }], source: { kind: 'compact-checkpoint', compactionId: 'c1' } },
  }
}

/** Upstream `test/elide-sources.test.js` minimal user node. */
function userNode(seq: number, text: string, source: unknown): CompileNode {
  return { seq, message: { role: 'user', source, content: [{ type: 'text', text }] } }
}

/** Upstream `test/malformed-nodes.test.js` node factory. */
function malformedNode(seq: number, role: CompileRole, content: unknown): CompileNode {
  return { seq, message: { role, content: content as readonly unknown[], source: { kind: role === 'user' ? 'user' : 'agent' } } }
}

/** The VCC case titles carried from upstream, in file order. */
const UPSTREAM_CASE_TITLES = [
  'tokenize splits character classes like VCC',
  'sanitize strips ANSI and control bytes',
  'truncateTokens keeps original tokens and adds provenance',
  'truncateTokens enforces the character-density ceiling on token runs',
  'stripNoiseXml removes configured wrappers and unwraps command tags',
  'compileNoisePatterns rejects invalid regexes with the index',
  'pickToolKeyArg prefers the tool-specific field then any string',
  'estimateDeepSeekTokens applies the docs weights: 0.3 non-CJK, 0.6 CJK',
  'oneLineArg collapses multiline arguments to the first line plus a cap marker',
  'parseToolArguments tolerates invalid JSON',
  'projectToolResultText joins text and labels media',
  'excerptToolResult passes small results through and anchors the tail',
  'isCheckpointSource recognizes the seam marker',
  'compileNodes collapses a tool step and elides reasoning',
  'compileNodes renders multiline bash arguments as first line plus line count',
  'compileNodes renders name-only rows for non-whitelisted tools',
  'compileNodes drops hideTools rows entirely',
  'compileNodes treats an empty whitelist as unset and renders args',
  'compileNodes emits per-tool diagnostics when debug is on',
  'compileNodes strips noise and marks noise-only user messages',
  'compileNodes copies prior checkpoints verbatim',
  'compileNodes labels images and documents',
  'compileNodes keeps reasoning when configured',
  'compileRegion rescales budgets and front-elides under the cap',
  'compileRegion elides tool rows before conversation text',
  'compileRegion keeps a text floor when budgets collapse',
  'frameCheckpoint wraps entries with the durable tags and the recall guide',
  'compileRegion leaves a [checkpoint N] line when a prior checkpoint is elided',
  'joinCompiledEntries keeps tool runs compact and separates groups',
  'a checkpoint body keeps every conversational line',
  'checkpoint bodies are untouched while the switch is off (stock default)',
  'capped is false and no elision happens when the span fits',
  'a tiny cap forces capping and records what was dropped',
  'tool rows are sacrificed before conversation entries',
  'isElidableSource matches on structured kind only',
  'empty elideSourceKinds keeps instruction bodies verbatim (stock behavior)',
  'configured kinds collapse to a pointer carrying seq and size',
  'rules and memory elide independently; unmatched sources stay',
  'elision shrinks the compiled checkpoint substantially',
  'frameCheckpoint accepts multiple footer lines',
  'a null content node does not abort the whole compile',
  'a null block inside content does not abort the whole compile',
  'a missing content property is skipped, not thrown',
  'a non-array content is skipped, not iterated',
  'a null message node is skipped',
  'projectToolResultText tolerates non-arrays and null blocks',
  'tool-call pointer recovery survives a null first block',
] as const

describe('vendored VCC compiler', () => {
  it('pins every case carried from upstream, one per upstream title', async () => {
    const tree = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const readme = await readFile(resolve(tree, 'src/vcc/README.md'), 'utf8')
    // The attribution file and this file name the same upstream case count.
    expect(readme).toContain(`upstream case count (${UPSTREAM_CASE_TITLES.length})`)
    const own = await readFile(fileURLToPath(import.meta.url), 'utf8')
    for (const title of UPSTREAM_CASE_TITLES) expect(own).toContain(`it('${title}'`)
    expect(UPSTREAM_CASE_TITLES.length).toBe(47)
  })

  it('tokenize splits character classes like VCC', () => {
    expect(tokenize('let x = 42;')).toEqual(['let', ' ', 'x', ' ', '=', ' ', '42', ';'])
    expect(countTokens('let x = 42;')).toBe(5)
    expect(countTokens('')).toBe(0)
  })

  it('sanitize strips ANSI and control bytes', () => {
    expect(sanitize('a\x1b[31mred\x1b[0m\u0007b')).toBe('aredb')
    expect(sanitize('a\r\nb')).toBe('a\nb')
    expect(sanitize(undefined)).toBe('')
  })

  it('truncateTokens keeps original tokens and adds provenance', () => {
    const short = truncateTokens('one two three four five', 3, 'seq 7')
    expect(short.text).toBe('one two three...(truncated from seq 7)')
    expect(short.truncated).toBe(true)
    const intact = truncateTokens('one two', 3, 'seq 7')
    expect(intact.text).toBe('one two')
    expect(intact.truncated).toBe(false)
  })

  it('truncateTokens enforces the character-density ceiling on token runs', () => {
    const blob = 'B'.repeat(4000)
    const out = truncateTokens(blob, 100, 'seq 9')
    expect(out.truncated).toBe(true)
    expect(out.text.length).toBeLessThanOrEqual(400 + 32)
    expect(out.text).toMatch(/\.\.\.\(truncated from seq 9\)$/)
  })

  it('stripNoiseXml removes configured wrappers and unwraps command tags', () => {
    const text = 'keep me <system-reminder>drop this</system-reminder> tail <command-name>x</command-name><command-args>y</command-args>'
    expect(stripNoiseXml(text, CONFIG.noisePatterns ?? [])).toBe('keep me  tail xy')
  })

  it('compileNoisePatterns rejects invalid regexes with the index', () => {
    expect(() => compileNoisePatterns(['('])).toThrow(/noisePatterns\[0\].*not a valid regular expression/)
  })

  it('pickToolKeyArg prefers the tool-specific field then any string', () => {
    expect(pickToolKeyArg('read', { file_path: 'a.js', offset: 1 }, {})).toBe('a.js')
    expect(pickToolKeyArg('unknown', { pattern: '*.ts' }, {})).toBe('*.ts')
    expect(pickToolKeyArg('bash', { command: 'ls' }, {})).toBe('ls')
    expect(pickToolKeyArg('empty', { n: 5 }, {})).toBeUndefined()
    expect(pickToolKeyArg('empty', null, {})).toBeUndefined()
    expect(pickToolKeyArg('read', { file_path: 'x' }, { read: 'other' })).toBe('x')
  })

  it('estimateDeepSeekTokens applies the docs weights: 0.3 non-CJK, 0.6 CJK', () => {
    expect(estimateDeepSeekTokens('abc')).toBe(0.9)
    expect(estimateDeepSeekTokens('你好')).toBe(1.2)
    expect(estimateDeepSeekTokens('hi 你好!')).toBe(2.4)
    expect(estimateDeepSeekTokens('')).toBe(0)
    expect(isCjkChar('中')).toBe(true)
    expect(isCjkChar('a')).toBe(false)
    expect(isCjkChar('、')).toBe(true)
    expect(isCjkChar('Ａ')).toBe(true)
  })

  it('oneLineArg collapses multiline arguments to the first line plus a cap marker', () => {
    expect(oneLineArg('ls -la')).toBe('ls -la')
    expect(oneLineArg('grep -n foo bar/baz\n\ncat x\necho y')).toBe('grep -n foo bar/baz [+ 3 lines]')
    expect(oneLineArg('a\r\nb')).toBe('a [+ 1 lines]')
    expect(oneLineArg('\ncommand')).toBe('command [+ 1 lines]')
  })

  it('parseToolArguments tolerates invalid JSON', () => {
    expect(parseToolArguments('{"a":1}')).toEqual({ a: 1 })
    expect(parseToolArguments('{oops')).toBeNull()
  })

  it('projectToolResultText joins text and labels media', () => {
    expect(projectToolResultText([{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'text', text: 'b' }])).toBe('a\n[image]\nb')
  })

  it('excerptToolResult passes small results through and anchors the tail', () => {
    const small = 'short result'
    expect(excerptToolResult(small, 100, 'seq 2')).toBe(small)
    const long = 'HEAD_'.repeat(500) + 'TAIL_MARKER'
    const out = excerptToolResult(long, 100, 'seq 2')
    expect(out).toMatch(/^HEAD_/)
    expect(out).toMatch(/TAIL_MARKER$/)
    expect(out).toMatch(/\.\.\.\(elided from seq 2\)/)
  })

  it('isCheckpointSource recognizes the seam marker', () => {
    expect(isCheckpointSource({ kind: 'compact-checkpoint', compactionId: 'c1' })).toBe(true)
    expect(isCheckpointSource({ kind: 'compact-checkpoint', compactionId: 'c1', sourceCommandId: 'cmd-1' })).toBe(true)
    expect(isCheckpointSource({ kind: 'plugin', plugin: 'compact' })).toBe(true)
    expect(isCheckpointSource({ kind: 'plugin', plugin: 'other' })).toBe(false)
    expect(isCheckpointSource({ kind: 'user' })).toBe(false)
    expect(isCheckpointSource({ kind: 'compact-checkpoint-typo' })).toBe(false)
    expect(isCheckpointSource({})).toBe(false)
    expect(isCheckpointSource(undefined)).toBe(false)
    expect(isCheckpointSource(null)).toBe(false)
  })

  it('compileNodes collapses a tool step and elides reasoning', () => {
    const nodes: CompileNode[] = [
      { seq: 1, message: { role: 'user', content: [{ type: 'text', text: 'fix the bug' }], source: { kind: 'user' } } },
      {
        seq: 2,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'think think' },
            { type: 'text', text: 'on it' },
            { type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"a.js"}' },
          ],
        },
      },
      { seq: 3, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'file contents' }] }] } },
    ]
    const { entries, stats } = compileNodes(nodes, CONFIG)
    expect(stats.toolCalls).toBe(1)
    expect(stats.toolResults).toBe(1)
    expect(stats.reasoningElided).toBe(1)
    const text = entries.map((entry) => entry.text).join('\n')
    expect(text).toMatch(/\[user\]\nfix the bug/)
    expect(text).toMatch(/\[assistant\]\non it/)
    expect(text).toMatch(/\* read "a\.js" \(seq 2 -> result 3\)/)
    expect(text).not.toMatch(/-> read: ok/)
    expect(text).not.toMatch(/file contents/)
  })

  it('compileNodes renders multiline bash arguments as first line plus line count', () => {
    const nodes: CompileNode[] = [
      {
        seq: 1,
        message: {
          role: 'assistant',
          content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"grep -n foo src/index.js\\n\\ncat README.md\\necho done"}' }],
          source: { provider: 'p', model: 'm' },
        },
      },
      { seq: 2, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'c1', content: [{ type: 'text', text: 'ok' }] }] } },
    ]
    const { entries } = compileNodes(nodes, CONFIG)
    const text = entries.map((entry) => entry.text).join('\n')
    expect(text).toMatch(/\* bash "grep -n foo src\/index\.js \[\+\s*3 lines\]" \(seq 1 -> result 2\)/)
    expect(text).not.toMatch(/cat README\.md/)
    expect(text).not.toMatch(/echo done/)
  })

  it('compileNodes renders name-only rows for non-whitelisted tools', () => {
    const nodes: CompileNode[] = [
      { seq: 1, message: { role: 'user', content: [{ type: 'text', text: 'cleanup' }], source: { kind: 'user' } } },
      { seq: 2, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'j1', name: 'job_kill', arguments: '{"job_id":"job-9","reason":"done"}' }], source: { provider: 'p', model: 'm' } } },
      { seq: 3, message: { role: 'user', content: [{ type: 'tool-result', toolCallId: 'j1', content: [{ type: 'text', text: 'killed' }] }] } },
    ]
    const { entries, stats } = compileNodes(nodes, CONFIG)
    expect(stats.toolCalls).toBe(1)
    const text = entries.map((entry) => entry.text).join('\n')
    expect(text).toMatch(/\* job_kill \(seq 2 -> result 3\)/)
    expect(text).not.toMatch(/job-9/)
    expect(text).not.toMatch(/killed/)
  })

  it('compileNodes drops hideTools rows entirely', () => {
    const nodes: CompileNode[] = [
      { seq: 1, message: { role: 'user', content: [{ type: 'text', text: 'cleanup' }], source: { kind: 'user' } } },
      { seq: 2, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'j1', name: 'job_kill', arguments: '{"job_id":"job-9"}' }], source: { provider: 'p', model: 'm' } } },
    ]
    const { entries, stats } = compileNodes(nodes, { ...CONFIG, hideTools: ['job_kill'] })
    expect(stats.toolCalls).toBe(1)
    expect(entries.length).toBe(1)
    expect((entries[0])?.text).not.toMatch(/job_kill/)
  })

  it('compileNodes treats an empty whitelist as unset and renders args', () => {
    const nodes: CompileNode[] = [
      { seq: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"a.js"}' }], source: { provider: 'p', model: 'm' } } },
    ]
    const { entries } = compileNodes(nodes, { ...CONFIG, toolArgTools: [] })
    expect((entries[0])?.text).toMatch(/\* read "a\.js"/)
  })

  it('compileNodes emits per-tool diagnostics when debug is on', () => {
    const nodes: CompileNode[] = [
      { seq: 1, message: { role: 'user', content: [{ type: 'text', text: 'go' }], source: { kind: 'user' } } },
      { seq: 2, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'read', arguments: '{"file_path":"a.js"}' }], source: { provider: 'p', model: 'm' } } },
    ]
    const lines: string[] = []
    const { entries } = compileNodes(nodes, { ...CONFIG, debug: true, debugSink: (line) => lines.push(line) })
    expect(lines.some((line) => line.includes('rev=') && line.includes('nodes=2'))).toBe(true)
    expect(
      lines.some((line) => line.includes('name=read') && line.includes('whitelist=yes') && line.includes('argsType=string') && line.includes('arg=')),
    ).toBe(true)
    expect(entries.map((entry) => entry.text).join('\n')).toMatch(/\* read "a\.js"/)
    const off: string[] = []
    compileNodes(nodes, { ...CONFIG, debug: false, debugSink: (line) => off.push(line) })
    expect(off.length).toBe(0)
  })

  it('compileNodes strips noise and marks noise-only user messages', () => {
    const nodes: CompileNode[] = [
      { seq: 1, message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>only noise</system-reminder>' }], source: { kind: 'user' } } },
      { seq: 2, message: { role: 'user', content: [{ type: 'text', text: 'real question' }], source: { kind: 'user' } } },
    ]
    const { entries, stats } = compileNodes(nodes, CONFIG)
    expect(stats.noiseElided).toBe(1)
    expect((entries[0])?.text).toMatch(/user message elided: noise-only\] \(seq 1\)/)
    expect((entries[1])?.text).toMatch(/real question/)
  })

  it('compileNodes copies prior checkpoints verbatim', () => {
    const nodes: CompileNode[] = [
      { seq: 1, message: { role: 'user', content: [{ type: 'text', text: 'prior checkpoint body' }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'x' } } },
      { seq: 2, message: { role: 'user', content: [{ type: 'text', text: 'new work' }], source: { kind: 'user' } } },
    ]
    const { entries, stats } = compileNodes(nodes, CONFIG)
    expect(stats.checkpoints).toBe(1)
    expect((entries[0])?.text).toBe('[system]\nprior checkpoint body')
    expect((entries[1])?.text).toBe('[user]\nnew work')
  })

  it('compileNodes labels images and documents', () => {
    const nodes: CompileNode[] = [
      { seq: 1, message: { role: 'user', content: [{ type: 'image', attachment: { id: 'i1' } }], source: { kind: 'user' } } },
      { seq: 2, message: { role: 'assistant', content: [{ type: 'document', attachment: { id: 'd1' } }] } },
    ]
    const { stats } = compileNodes(nodes, CONFIG)
    expect(stats.images).toBe(1)
    expect(stats.documents).toBe(1)
  })

  it('compileNodes keeps reasoning when configured', () => {
    const nodes: CompileNode[] = [{ seq: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'chain of thought' }] } }]
    const { stats } = compileNodes(nodes, { ...CONFIG, includeReasoning: true })
    expect(stats.reasoningElided).toBe(0)
  })

  it('compileRegion rescales budgets and front-elides under the cap', () => {
    const nodes: CompileNode[] = []
    for (let seq = 1; seq <= 20; seq += 1) {
      nodes.push({ seq, message: { role: 'user', content: [{ type: 'text', text: `payload ${seq} ${'word '.repeat(80)}` }], source: { kind: 'user' } } })
    }
    const { entries, stats, capped } = compileRegion(nodes, { ...CONFIG, maxTokens: 2000 })
    expect(stats.tokens).toBeLessThanOrEqual(2000 + 64)
    expect(capped).toBe(true)
    expect((entries[0])?.text).toMatch(/earlier entries elided/)
    const last = entries[entries.length - 1]
    expect(last?.text).toMatch(/payload 20/)
  })

  it('compileRegion elides tool rows before conversation text', () => {
    const nodes: CompileNode[] = []
    for (let seq = 1; seq <= 8; seq += 1) {
      nodes.push({ seq: seq * 2 - 1, message: { role: 'user', content: [{ type: 'text', text: `question ${seq}` }], source: { kind: 'user' } } })
      nodes.push({
        seq: seq * 2,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: `answer ${seq} ${'word '.repeat(200)}` },
            { type: 'tool-call', id: `c${seq}`, name: 'read', arguments: '{"file_path":"a.js"}' },
          ],
          source: { provider: 'p', model: 'm' },
        },
      })
      nodes.push({
        seq: seq * 2 + 1,
        message: { role: 'user', content: [{ type: 'tool-result', toolCallId: `c${seq}`, content: [{ type: 'text', text: `${'data '.repeat(200)} end ${seq}` }] }] },
      })
    }
    const { entries, stats, capped } = compileRegion(nodes, { ...CONFIG, maxTokens: 565 })
    expect(capped).toBe(true)
    expect(stats.elidedToolRows).toBeGreaterThan(0)
    expect(stats.elidedRows).toBe(0)
    const text = entries.map((entry) => entry.text).join('\n')
    expect(text).toMatch(/tool\/result entries elided/)
    for (let seq = 1; seq <= 8; seq += 1) {
      expect(text).toMatch(new RegExp(`question ${seq}`))
      expect(text).toMatch(new RegExp(`answer ${seq}`))
    }
    // The dropped-row marker carries the log-position range of what went.
    // The dropped-row marker carries the log position of what went: a range when
    // several rows go, a single `seq N` when one does.
    expect(text).toMatch(/tool\/result entries elided: seqs? \d+(-\d+)?\]/)
  })

  it('compileRegion keeps a text floor when budgets collapse', () => {
    const nodes: CompileNode[] = []
    for (let seq = 1; seq <= 6; seq += 1) {
      nodes.push({ seq, message: { role: 'user', content: [{ type: 'text', text: `payload ${seq} ${'word '.repeat(200)}` }], source: { kind: 'user' } } })
    }
    const { entries, capped } = compileRegion(nodes, { ...CONFIG, maxTokens: 150 })
    expect(capped).toBe(true)
    const textEntries = entries.filter((entry) => /payload/.test(entry.text))
    expect(textEntries.length).toBeGreaterThan(0)
    for (const entry of textEntries) {
      expect(entry.text.length).toBeGreaterThanOrEqual(96)
      // A floored text row that was cut still names its durable row.
      if (entry.text.includes('...(truncated from ')) expect(entry.text).toMatch(/\(truncated from seq \d+\)/)
    }
  })

  it('frameCheckpoint wraps entries with the durable tags and the recall guide', () => {
    const blocks = frameCheckpoint(['a', 'b'], '## header')
    expect(blocks.length).toBe(3)
    expect(blocks[0]?.text).toMatch(/<compacted-checkpoint>$/)
    expect(blocks[2]?.text).toBe('</compacted-checkpoint>')
    expect(blocks[1]?.text).toMatch(/^RECALL: /)
    expect(blocks[1]?.text).toMatch(/recall/)
    expect(blocks[1]?.text).toMatch(/search/)
    expect(blocks[1]?.text).toMatch(/## header\n\na\n\nb$/)
  })

  it('compileRegion leaves a [checkpoint N] line when a prior checkpoint is elided', () => {
    const nodes: CompileNode[] = [
      { seq: 1, message: { role: 'user', content: [{ type: 'text', text: `prior checkpoint ${'word '.repeat(2000)}` }], source: { kind: 'plugin', plugin: 'compact', compactionId: 'x' } } },
      { seq: 2, message: { role: 'user', content: [{ type: 'text', text: 'new question' }], source: { kind: 'user' } } },
      { seq: 3, message: { role: 'assistant', content: [{ type: 'text', text: `new answer ${'word '.repeat(60)}` }], source: { provider: 'p', model: 'm' } } },
    ]
    const withOrdinals = compileRegion(nodes, { ...CONFIG, maxTokens: 60, checkpointOrdinals: new Map([[1, 1]]) })
    expect(withOrdinals.capped).toBe(true)
    expect(withOrdinals.stats.elidedRows).toBeGreaterThanOrEqual(1)
    expect(withOrdinals.entries[0]?.text).toMatch(/\[checkpoint 1\]/)
    expect(withOrdinals.entries[0]?.text).toMatch(/earlier entries elided/)
    const without = compileRegion(nodes, { ...CONFIG, maxTokens: 60 })
    expect(without.entries[0]?.text).toMatch(/\[checkpoint @ seq 1\]/)
    expect(withOrdinals.entries[0]?.text).not.toMatch(/prior checkpoint word/)
  })

  it('joinCompiledEntries keeps tool runs compact and separates groups', () => {
    const entries: CompileEntry[] = [
      { seq: 1, text: '[user]\nquestion', kind: 'text' },
      { seq: 2, text: '* read "a.js" (seq 2 -> result 3)', kind: 'tool' },
      { seq: 2, text: '* write "b.js" (seq 2 -> result 4)', kind: 'tool' },
      { seq: 5, text: '* bash (seq 5 -> result 6)', kind: 'tool' },
      { seq: 7, text: '[assistant]\ndone', kind: 'text' },
    ]
    expect(joinCompiledEntries(entries)).toBe(
      '[user]\nquestion\n\n* read "a.js" (seq 2 -> result 3)\n* write "b.js" (seq 2 -> result 4)\n* bash (seq 5 -> result 6)\n\n[assistant]\ndone',
    )
    expect(joinCompiledEntries(['guide', 'header', 'a', 'b'])).toBe('guide\n\nheader\n\na\n\nb')
    expect(joinCompiledEntries([])).toBe('')
  })

  it('capped is false and no elision happens when the span fits', () => {
    const nodes = manyNodes(3)
    const { capped, stats } = compileRegion(nodes, { ...SMALL_BASE, maxTokens: 100000 })
    expect(capped).toBe(false)
    expect(stats.elidedRows).toBe(0)
    expect(stats.elidedToolRows).toBe(0)
  })

  it('a tiny cap forces capping and records what was dropped', () => {
    const { capped, stats } = compileRegion(manyNodes(40), { ...SMALL_BASE, maxTokens: 400 })
    expect(capped).toBe(true)
    expect(stats.elidedRows).toBeGreaterThan(0)
  })

  it('tool rows are sacrificed before conversation entries', () => {
    const nodes: CompileNode[] = []
    for (let index = 0; index < 25; index += 1) {
      nodes.push({
        seq: index * 2 + 1,
        message: { role: 'assistant', content: [{ type: 'tool-call', toolCallId: `c${index}`, toolName: 'bash', name: 'bash', arguments: JSON.stringify({ command: 'x'.repeat(200) }) }] },
      })
      nodes.push({ seq: index * 2 + 2, message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `正文 ${index} `.repeat(50) }] } })
    }
    const { capped, stats } = compileRegion(nodes, { ...SMALL_BASE, maxTokens: 500 })
    expect(capped).toBe(true)
    expect(stats.elidedToolRows > 0 || stats.elidedRows > 0).toBe(true)
    // Both elision passes leave a marker naming the rows they dropped.
    const text = compileRegion(nodes, { ...SMALL_BASE, maxTokens: 500 }).entries.map((entry) => entry.text).join('\n')
    for (const line of text.split('\n')) {
      if (/entries elided/.test(line)) expect(line).toMatch(/entries elided: seqs? \d+(-\d+)?\]/)
    }
  })

  it('isElidableSource matches on structured kind only', () => {
    expect(isElidableSource({ kind: 'dsh-mnemon' }, ['dsh-mnemon'])).toBe(true)
    expect(isElidableSource({ kind: 'user' }, ['dsh-mnemon'])).toBe(false)
    expect(isElidableSource(undefined, ['dsh-mnemon'])).toBe(false)
    expect(isElidableSource({ kind: 'dsh-mnemon' }, [])).toBe(false)
    expect(isElidableSource({ kind: 'dsh-mnemon' }, undefined)).toBe(false)
  })

  it('empty elideSourceKinds keeps instruction bodies verbatim (stock behavior)', () => {
    const nodes = [userNode(1, MEMORY, { kind: 'dsh-mnemon' })]
    const { entries, stats } = compileNodes(nodes, { ...SMALL_BASE, elideSourceKinds: [] })
    expect(stats.elidedSourceRows).toBe(0)
    const joined = entries.map((entry) => entry.text).join('\n')
    expect(joined.includes('MNEMON RUNTIME MEMORY SNAPSHOT')).toBe(true)
    expect(joined.includes('compressed into a pointer')).toBe(false)
  })

  it('configured kinds collapse to a pointer carrying seq and size', () => {
    const nodes = [userNode(3595, MEMORY, { kind: 'dsh-mnemon' })]
    const { entries, stats } = compileNodes(nodes, { ...SMALL_BASE, elideSourceKinds: ['dsh-mnemon'] })
    expect(stats.elidedSourceRows).toBe(1)
    expect(stats.elidedSourceChars).toBe(MEMORY.length)
    const joined = entries.map((entry) => entry.text).join('\n')
    expect(joined.includes('memory snapshot')).toBe(true)
    expect(joined.includes('seq 3595')).toBe(true)
    expect(joined.includes(String(MEMORY.length))).toBe(true)
    expect(joined.includes('MNEMON RUNTIME MEMORY SNAPSHOT')).toBe(false)
  })

  it('rules and memory elide independently; unmatched sources stay', () => {
    const nodes = [userNode(1, RULES, { kind: 'agent-instructions' }), userNode(2, MEMORY, { kind: 'dsh-mnemon' }), userNode(3, '我打的字', { kind: 'user' })]
    const { entries, stats } = compileNodes(nodes, { ...SMALL_BASE, elideSourceKinds: ['dsh-mnemon'] })
    expect(stats.elidedSourceRows).toBe(1)
    const joined = entries.map((entry) => entry.text).join('\n')
    expect(joined.includes('Instructions from:')).toBe(true)
    expect(joined.includes('我打的字')).toBe(true)
    expect(joined.includes('MNEMON RUNTIME MEMORY SNAPSHOT')).toBe(false)
  })

  it('elision shrinks the compiled checkpoint substantially', () => {
    const nodes = [userNode(1, MEMORY, { kind: 'dsh-mnemon' }), userNode(2, RULES, { kind: 'agent-instructions' })]
    const off = compileNodes(nodes, { ...SMALL_BASE, elideSourceKinds: [] })
    const on = compileNodes(nodes, { ...SMALL_BASE, elideSourceKinds: ['dsh-mnemon', 'agent-instructions'] })
    expect(on.stats.elidedSourceRows).toBe(2)
    expect(on.stats.tokens).toBeLessThan(off.stats.tokens / 2)
  })

  it('frameCheckpoint accepts multiple footer lines', () => {
    const entries: CompileEntry[] = [{ seq: 1, text: '[user] hi', kind: 'text' }]
    const one = frameCheckpoint(entries, undefined, undefined, 'single footer')
    const many = frameCheckpoint(entries, undefined, undefined, ['first', 'second'])
    const textOf = (blocks: readonly { type: 'text'; text: string }[]): string => blocks.map((block) => block.text).join('')
    expect(textOf(one).includes('single footer')).toBe(true)
    expect(textOf(many).includes('first') && textOf(many).includes('second')).toBe(true)
    const none = frameCheckpoint(entries, undefined, undefined, undefined)
    expect(textOf(none).includes('footer')).toBe(false)
  })

  it('a null content node does not abort the whole compile', () => {
    for (const role of ['user', 'assistant'] as const) {
      const { entries } = compileNodes([malformedNode(1, role, null), malformedNode(2, 'user', [{ type: 'text', text: '存活' }])], CONFIG)
      expect(entries.length).toBe(1)
      expect(entries[0]?.text).toMatch(/存活/u)
    }
  })

  it('a null block inside content does not abort the whole compile', () => {
    const { entries } = compileNodes([malformedNode(1, 'user', [null, { type: 'text', text: '保住了' }])], CONFIG)
    expect(entries.length).toBe(1)
    expect(entries[0]?.text).toMatch(/保住了/u)
  })

  it('a missing content property is skipped, not thrown', () => {
    const { entries } = compileNodes([{ seq: 1, message: { role: 'user', source: { kind: 'user' } } }], CONFIG)
    expect(entries).toEqual([])
  })

  it('a non-array content is skipped, not iterated', () => {
    for (const content of ['字符串', 42, {}, { length: 1 }]) {
      const { entries } = compileNodes([malformedNode(1, 'user', content)], CONFIG)
      expect(entries).toEqual([])
    }
  })

  it('a null message node is skipped', () => {
    const { entries } = compileNodes([{ seq: 1, message: null }, { seq: 2, message: null }], CONFIG)
    expect(entries).toEqual([])
  })

  it('projectToolResultText tolerates non-arrays and null blocks', () => {
    expect(projectToolResultText(null)).toBe('')
    expect(projectToolResultText(undefined)).toBe('')
    expect(projectToolResultText('nope')).toBe('')
    expect(projectToolResultText([null, undefined, { type: 'text', text: 'ok' }])).toBe('ok')
    expect(projectToolResultText([{ type: 'image' }])).toBe('[image]')
  })

  it('tool-call pointer recovery survives a null first block', () => {
    const nodes: CompileNode[] = [
      { seq: 1, message: { role: 'tool', content: [null], toolCallId: 'call-1', source: { kind: 'agent' } } },
      malformedNode(2, 'assistant', [{ type: 'text', text: '后续正文' }]),
    ]
    const { entries } = compileNodes(nodes, CONFIG)
    expect(entries.length).toBe(1)
    expect(entries[0]?.text).toMatch(/后续正文/u)
  })

  it('checkpoint bodies collapse when the switch is on', () => {
    const text = `真实对话\n\n${SNAPSHOT}`
    const { stats, entries } = compileNodes([checkpointNode(text)], { ...SMALL_BASE, elideCheckpointInjectedBodies: true })
    expect(stats.elidedCheckpointSpans).toBe(1)
    expect(stats.elidedCheckpointChars).toBeGreaterThan(100)
    expect(entries[0]?.text.includes('<runtime-memory-file')).toBe(false)
    expect(entries[0]?.text.includes('真实对话')).toBe(true)
    expect(entries[0]?.text.includes('compressed into a pointer while the checkpoint crosses')).toBe(true)
  })

  it('checkpoint bodies are untouched while the switch is off (stock default)', () => {
    const text = `真实对话\n\n${SNAPSHOT}`
    const { stats, entries } = compileNodes([checkpointNode(text)], CONFIG)
    expect(stats.elidedCheckpointSpans).toBe(0)
    expect(stats.elidedCheckpointChars).toBe(0)
    expect(entries[0]?.text.includes('<runtime-memory-file')).toBe(true)
  })

  it('live user turns keep their full text even with the switch on', () => {
    const node: CompileNode = { seq: 11, message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: SNAPSHOT }] } }
    const { stats, entries } = compileNodes([node], { ...SMALL_BASE, elideCheckpointInjectedBodies: true })
    expect(stats.elidedCheckpointSpans).toBe(0)
    expect(entries[0]?.text.includes('用户偏好正文')).toBe(true)
  })

  it('a checkpoint body keeps every conversational line', () => {
    const body = `user: ask about the parser\nassistant: it lives in parser.ts\n${SNAPSHOT}`
    const { text } = elideCheckpointInjectedBodies(body)
    for (const line of body.split('\n')) {
      if (line.length === 0) continue
      // Memory-snapshot lines are the only ones the collapse removes.
      if (SNAPSHOT.split('\n').includes(line)) continue
      expect(text.includes(line)).toBe(true)
    }
    // The pointer carries no log position of its own: the enclosing checkpoint
    // row's (seq N) covers it, and the originals stay in the append-only log.
    expect(text).not.toMatch(/seq \d+/)
  })

  // ── fork cases: the shapes this host derives, the declaration, defaults ──

  it('fork: a tool-result node compiles with role tool and its message-level toolCallId', () => {
    const nodes: CompileNode[] = [
      { seq: 1, message: { role: 'user', content: [{ type: 'text', text: 'list the tree' }], source: { kind: 'user' } } },
      { seq: 2, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls src"}' }] } },
      { seq: 3, message: { role: 'tool', content: [{ type: 'text', text: 'compiler.ts\nproject.ts' }], toolCallId: 'call-1' } },
    ]
    const { entries, stats } = compileNodes(nodes, CONFIG)
    expect(entries.map((entry) => entry.kind)).toEqual(['text', 'tool', 'result'])
    expect(entries.map((entry) => entry.seq)).toEqual([1, 2, 3])
    expect(entries[1]?.text).toBe('[assistant]\n* bash "ls src" (seq 2 -> result 3)')
    expect(entries[2]?.text).toBe('[tool]\ncompiler.ts\nproject.ts')
    expect(stats.toolResults).toBe(1)
  })

  it('fork: a tool-result row over budget is cut and points at its row', () => {
    const nodes: CompileNode[] = [
      { seq: 1, message: { role: 'user', content: [{ type: 'text', text: 'run the suite' }], source: { kind: 'user' } } },
      { seq: 2, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"npm test"}' }] } },
      { seq: 3, message: { role: 'tool', content: [{ type: 'text', text: `${'HEAD_'.repeat(400)}TAIL_MARKER` }], toolCallId: 'call-1' } },
    ]
    const { entries } = compileNodes(nodes, { ...CONFIG, toolResultExcerptTokens: 40 })
    const row = entries[2]?.text ?? ''
    expect(row.startsWith('[tool]\nHEAD_')).toBe(true)
    expect(row.endsWith('TAIL_MARKER')).toBe(true)
    expect(row).toMatch(/\.\.\.\(truncated from seq 3\)/)
    expect(row).toMatch(/\.\.\.\(elided from seq 3\)/)
  })

  it('fork: an inline image renders as a media label carrying its row', () => {
    // The host derives inline image blocks, both in a tool result and in an
    // assistant message. The label keeps the row, so a media result that is
    // noticed but absent from the compiled copy is never silent.
    const nodes: CompileNode[] = [
      { seq: 1, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'view_image', arguments: '{"file_path":"shot.png"}' }] } },
      { seq: 2, message: { role: 'tool', content: [{ type: 'image', attachment: { id: 'i1' } }], toolCallId: 'c1' } },
      { seq: 3, message: { role: 'assistant', content: [{ type: 'text', text: 'reading the shot' }, { type: 'image', attachment: { id: 'i2' } }] } },
    ]
    const { entries, stats } = compileNodes(nodes, CONFIG)
    expect(stats.images).toBe(2)
    // The result row keeps upstream's shape, where a media-only block projects
    // a label into the excerpt; its own media row then names the row explicitly,
    // and the assistant image takes a row of its own.
    expect(entries.map((entry) => entry.kind)).toEqual(['tool', 'result', 'media', 'text', 'media'])
    // view_image is not a whitelisted tool, so its row is name-only, as upstream.
    expect(entries[0]?.text).toBe('[assistant]\n* view_image (seq 1 -> result 2)')
    expect(entries[1]?.text).toBe('[tool]\n[image]')
    expect(entries[2]?.text).toBe('[image] (seq 2)')
    expect(entries[3]?.text).toBe('[assistant]\nreading the shot')
    expect(entries[4]?.text).toBe('[image] (seq 3)')
  })

  it('fork: a tool call whose argument line is cut names its row', () => {
    const nodes: CompileNode[] = [
      { seq: 4, message: { role: 'assistant', content: [{ type: 'tool-call', id: 'c1', name: 'bash', arguments: JSON.stringify({ command: 'word '.repeat(200) }) }] } },
    ]
    const { entries } = compileNodes(nodes, { ...CONFIG, toolCallTokens: 20 })
    expect(entries[0]?.text).toMatch(/\.\.\.\(truncated from seq 4\)/)
    expect(entries[0]?.text).toMatch(/\(seq 4\)$/)
    expect(entries[0]?.text).toMatch(/word word word/)
  })

  it('fork: retained text comes from the source without paraphrase', () => {
    const asked = 'anchor the parse at this line'
    const answered = 'Rewriting the loop so it stops at the marker.'
    const output = 'built 12 modules; 0 errors'
    const nodes: CompileNode[] = [
      { seq: 1, message: { role: 'user', content: [{ type: 'text', text: asked }], source: { kind: 'user' } } },
      { seq: 2, message: { role: 'assistant', content: [{ type: 'text', text: answered }, { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{"command":"npm run build"}' }] } },
      { seq: 3, message: { role: 'tool', content: [{ type: 'text', text: output }], toolCallId: 'c1' } },
    ]
    const { entries } = compileNodes(nodes, CONFIG)
    // The configured budgets keep every word, so the rows must be the source text
    // behind only the generated role header and framing.
    expect(entries.map((entry) => entry.kind)).toEqual(['text', 'text', 'tool', 'result'])
    expect(entries[0]?.text).toBe(`[user]\n${asked}`)
    expect(entries[1]?.text).toBe(`[assistant]\n${answered}`)
    expect(entries[2]?.text).toBe('* bash "npm run build" (seq 2 -> result 3)')
    expect(entries[3]?.text).toBe(`[tool]\n${output}`)
    const framed = frameCheckpoint(entries)
    expect(framed[1]?.text).toContain(asked)
    expect(framed[1]?.text).toContain(answered)
    expect(framed[1]?.text).toContain(output)
  })

  it('fork: the vendored declaration accepts role tool and an optional tool-call id', async () => {
    const tree = resolve(dirname(fileURLToPath(import.meta.url)), '..')
    const declaration = await readFile(resolve(tree, 'src/vcc/compiler.ts'), 'utf8')
    // The published role union lists tool; the message carries toolCallId.
    expect(declaration).toMatch(/export type CompileRole = 'system' \| 'user' \| 'assistant' \| 'tool'/)
    expect(declaration).toMatch(/toolCallId\?: string/)
    const roleOnly: CompileRole[] = ['system', 'user', 'assistant', 'tool']
    expect(roleOnly).toHaveLength(4)
  })

  it('fork: the read-back helpers price and cut the way the budgets do', () => {
    // A long unbroken run counts as one word token but costs its character density.
    expect(estimateEntryTokens('B'.repeat(400))).toBeGreaterThan(countTokens('B'.repeat(400)))
    expect(countTokens('B'.repeat(400))).toBe(1)
    const entry: CompileEntry = { seq: 3, text: '[user]\nquestion', kind: 'text' }
    expect(entryText(entry)).toBe('[user]\nquestion')
    expect(entryText('[user]\nquestion')).toBe('[user]\nquestion')
    // A single unbroken run is one token; the character ceiling is what cuts it.
    expect(truncateTokens('abcdef', 3)).toEqual({ text: 'abcdef', truncated: false })
    expect(truncateTokens('abcdef', 0, 'seq 3')).toEqual({ text: '...(truncated from seq 3)', truncated: true })
    const media: unknown[] = [{ type: 'text', text: 'a' }, { type: 'image' }, { type: 'document' }, { type: 'custom' }]
    expect(projectToolResultText(media)).toBe('a\n[image]\n[document]\n[custom]')
  })

  it('fork: the published defaults are VCC 0.7.4 values', () => {
    expect({ ...DEFAULT_TOOL_KEY_FIELDS }).toEqual({
      read: 'file_path',
      edit: 'file_path',
      write: 'file_path',
      glob: 'pattern',
      grep: 'pattern',
      bash: 'command',
      web_search: 'query',
      skill: 'name',
      ralph: 'objective',
      subagent: 'description',
      subagent_fork: 'description',
      create_goal: 'objective',
      update_goal: 'objective',
      workflow: 'name',
      interrupt_agent: 'agent_id',
      job_kill: 'job_id',
      job_output: 'job_id',
      send_message: 'message',
    })
    expect([...DEFAULT_ARG_TOOLS]).toEqual(['read', 'write', 'edit', 'glob', 'grep', 'bash', 'shell', 'web_search', 'skill', 'subagent', 'subagent_fork', 'ralph', 'workflow'])
    expect([...DEFAULT_NOISE_PATTERNS]).toEqual([
      '<ide_opened_file>.*?</ide_opened_file>',
      '<ide_selection>.*?</ide_selection>',
      '<system-reminder>.*?</system-reminder>',
      '<command-message>.*?</command-message>',
      '<task-notification>.*?</task-notification>',
    ])
    expect(RECALL_GUIDE).toMatch(/^RECALL: /)
    expect(CHECKPOINT_OPEN_TAG).toBe('<compacted-checkpoint>')
    expect(CHECKPOINT_CLOSE_TAG).toBe('</compacted-checkpoint>')
    expect(CHECKPOINT_PREAMBLE).toMatch(/^This is an automatically generated checkpoint/)
    const budgets: CompileBudgets = { textTokens: 8192, userTextTokens: 16384, toolCallTokens: 128, toolResultExcerptTokens: 256 }
    expect(budgets).toEqual({ textTokens: 8192, userTextTokens: 16384, toolCallTokens: 128, toolResultExcerptTokens: 256 })
  })
})

/** Upstream `test/cap-notice.test.js` nodes: enough text that the cap must bite. */
function manyNodes(count: number): CompileNode[] {
  return Array.from({ length: count }, (_, index) => ({
    seq: index + 1,
    message: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `msg ${index + 1} `.repeat(60) }] },
  }))
}

/** Upstream `test/elide-sources.test.js` fixtures, kept small. */
const MEMORY = 'MNEMON RUNTIME MEMORY SNAPSHOT\n'.repeat(40)
const RULES = 'Instructions from: ~/.dsh/AGENTS.md\n'.repeat(30)

/** Upstream `test/elide-checkpoint-bodies.test.js` memory-snapshot fixture. */
const SNAPSHOT = [
  '[MNEMON] Search Documents for substantial project records.',
  '',
  'MNEMON RUNTIME MEMORY SNAPSHOT',
  '',
  'USER.md (user profile)',
  '<runtime-memory-file name="USER.md">',
  '用户偏好正文',
  '</runtime-memory-file>',
  '',
  'MEMORY.md (working reference)',
  '<runtime-memory-file name="MEMORY.md">',
  '工作事实正文',
  '</runtime-memory-file>',
].join('\n')
