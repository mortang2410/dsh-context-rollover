/**
 * The deterministic VCC-style region compiler, vendored from
 * `dsh-compaction-vcc@0.7.4` (`src/compiler.js`, `types/compiler.d.ts`) at
 * <https://github.com/tingfeng-droid/dsh-compaction-vcc>.
 *
 * Copied under the MIT licence; the upstream copyright notice travels with
 * this file in `src/vcc/LICENSE`, which also records every local adaptation.
 *
 * It compiles one region of the durable session log into a compact,
 * reference-linked view using ONLY original tokens — no model call, no
 * paraphrase:
 *
 *   - the durable session event log is the lossless layer (VCC's `.txt`);
 *   - every truncation and elision keeps a `(seq N)` pointer back to the exact
 *     durable event, so nothing is unrecoverable;
 *   - noise handling mirrors VCC's brief-mode rules: sanitize control bytes,
 *     strip known noise XML wrappers, hide reasoning, collapse every tool call
 *     into ONE line (key argument for whitelisted tools, name-only for the rest,
 *     a `-> result N` pointer in place of the result entry), and render
 *     images/documents as labels.
 *
 * This module is dependency-free (no `@deepseek-ai` import, no node builtin)
 * and imports nothing from the harness, so it can be unit-tested on its own.
 * Messages are read as plain `{ role, content, source, toolCallId? }` values,
 * exactly what the host's `Session.deriveEventMessage` projects.
 *
 * @module src/vcc/compiler
 */

// ── tokenizer (VCC `_tokenize` / `_TOK_RE`) ────────────────────────────────

const TOKEN_RE = /[a-zA-Z]+|[0-9]+|[^\sa-zA-Z0-9]|\s+/g

/** Whether a UTF-16 code unit can be an unpaired high surrogate. */
function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/** Whether a UTF-16 code unit can be an unpaired low surrogate. */
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

/**
 * Move the end of a slice to a code-point boundary: a cut must never leave a
 * high surrogate without its low half (a lone surrogate renders as garbage for
 * the model and every UI). Only ASCII-derived budgets slice, so the adjustment
 * costs at most one code unit.
 * @param text - sliced text.
 * @returns the text without a trailing unpaired high surrogate.
 */
function completeCodePointAtEnd(text: string): string {
  return isHighSurrogate(text.charCodeAt(text.length - 1)) ? text.slice(0, -1) : text
}

/**
 * Move the start of a slice to a code-point boundary (a tail excerpt must never
 * begin inside a surrogate pair).
 * @param text - sliced text.
 * @returns the text without a leading unpaired low surrogate.
 */
function completeCodePointAtStart(text: string): string {
  return isLowSurrogate(text.charCodeAt(0)) ? text.slice(1) : text
}

const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g
const CTRL_RE = /[\x00-\x08\x0b-\x1f\x7f-\x9f]/g

/**
 * Split text into fixed-density tokens under the same character-class heuristic
 * VCC uses: letter runs, digit runs, single punctuation chars, and whitespace
 * runs. Deterministic and offline, so every budget decision agrees.
 * @param text - source text.
 * @returns the token list (whitespace tokens included, never counted).
 */
export function tokenize(text: string): string[] {
  return text.match(TOKEN_RE) ?? []
}

/**
 * DeepSeek's documented character→token conversion (quick_start/token_usage):
 * about 0.3 token per English character and 0.6 token per Chinese character.
 * The tokenizer still varies per model, so this is an estimate.
 * @param char - one code point.
 * @returns true when the character carries the 0.6 CJK weight.
 */
export function isCjkChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (
    (code >= 0x3400 && code <= 0x4dbf) || // CJK Extension A
    (code >= 0x4e00 && code <= 0x9fff) || // CJK Unified Ideographs
    (code >= 0xf900 && code <= 0xfaff) || // CJK Compatibility Ideographs
    (code >= 0x3000 && code <= 0x303f) || // CJK Symbols and Punctuation
    (code >= 0xff00 && code <= 0xffef) || // Fullwidth Forms
    // The ranges below are not ideographs, but they carry the same 0.6-token
    // character density as Chinese, so they belong in this density class.
    (code >= 0x3040 && code <= 0x30ff) || // Hiragana + Katakana
    (code >= 0x31f0 && code <= 0x31ff) || // Katakana Phonetic Extensions
    (code >= 0xac00 && code <= 0xd7af) || // Hangul Syllables
    (code >= 0x1100 && code <= 0x11ff) || // Hangul Jamo
    (code >= 0x0e00 && code <= 0x0e7f) || // Thai
    (code >= 0x0e80 && code <= 0x0eff) || // Lao
    (code >= 0x0900 && code <= 0x097f) || // Devanagari
    (code >= 0x0980 && code <= 0x09ff) || // Bengali
    (code >= 0x0a00 && code <= 0x0a7f) || // Gurmukhi
    (code >= 0x0a80 && code <= 0x0aff) || // Gujarati
    (code >= 0x0b00 && code <= 0x0b7f) || // Oriya
    (code >= 0x0b80 && code <= 0x0bff) || // Tamil
    (code >= 0x0c00 && code <= 0x0c7f) || // Telugu
    (code >= 0x0c80 && code <= 0x0cff) || // Kannada
    (code >= 0x0d00 && code <= 0x0d7f) || // Malayalam
    (code >= 0x0d80 && code <= 0x0dff) || // Sinhala
    (code >= 0x1000 && code <= 0x109f) || // Myanmar
    (code >= 0x1780 && code <= 0x17ff) // Khmer
  )
}

/**
 * Estimate tokens of a text under the DeepSeek docs conversion (0.3 per non-CJK
 * character, 0.6 per CJK character). Counts accumulate as integer tenths so
 * long inputs stay exact under ceil.
 * @param text - arbitrary text.
 * @returns the estimated token count (may be fractional).
 */
export function estimateDeepSeekTokens(text: string): number {
  let nonCjk = 0
  let cjk = 0
  for (const char of text) {
    if (isCjkChar(char)) cjk += 1
    else nonCjk += 1
  }
  return (nonCjk * 3 + cjk * 6) / 10
}

/** Count the non-whitespace tokens of a text under {@link tokenize}. */
export function countTokens(text: string): number {
  let count = 0
  for (const token of tokenize(text)) if (token.trim().length > 0) count += 1
  return count
}

/**
 * Size one emitted entry the way every budget in this module is enforced: the
 * VCC word-class token count, floored at the DeepSeek-doc character density
 * equivalent (0.3 token per non-CJK char, 0.6 per CJK char) so the total cap
 * also sees pathological long runs.
 * @param text - entry text.
 * @returns the budget-relevant size in tokens.
 */
export function estimateEntryTokens(text: string): number {
  return Math.max(countTokens(text), Math.ceil(estimateDeepSeekTokens(text)))
}

/**
 * Strip carriage returns, ANSI escapes, and control bytes the way VCC's
 * `_sanitize` does — deterministic cleanup, never token-changing rewrites.
 * @param text - raw text.
 * @returns sanitized text.
 */
export function sanitize(text: unknown): string {
  if (typeof text !== 'string') return ''
  let out = text
  if (out.includes('\r')) out = out.replaceAll('\r', '')
  if (out.includes('\x1b')) out = out.replace(ANSI_RE, '')
  return out.replace(CTRL_RE, '')
}

// ── truncation (VCC `_trunc`) ──────────────────────────────────────────────

/**
 * Truncate text to a non-whitespace-token budget, preserving exact original
 * tokens and appending a VCC-style provenance note when something was cut.
 *
 * The tokenizer counts a whole unbroken run of letters or digits as one token,
 * so a pathological output (a 100 KB base64 blob, a minified file) could
 * otherwise pass any token budget; every budget is therefore enforced twice —
 * by token count AND by a `limit * 4` character ceiling.
 * @param text - text to bound.
 * @param limit - non-whitespace token budget; `0` keeps nothing.
 * @param ref - provenance appended as `...(truncated from {ref})` on a cut.
 * @returns `{ text, truncated }` — `truncated` is true when anything was cut.
 */
export function truncateTokens(text: string, limit: number, ref?: string): { text: string; truncated: boolean } {
  const tokens = tokenize(text)
  let count = 0
  let cut = tokens.length
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === undefined || token.trim().length === 0) continue
    count += 1
    if (count > limit) {
      cut = index
      break
    }
  }
  let out = cut >= tokens.length ? text : tokens.slice(0, cut).join('')
  let truncated = cut < tokens.length
  const maxChars = Math.max(32, limit * 4)
  if (out.length > maxChars) {
    out = completeCodePointAtEnd(out.slice(0, maxChars))
    truncated = true
  } else if (truncated) {
    out = completeCodePointAtEnd(out)
  }
  if (!truncated) return { text, truncated: false }
  out = out.replace(/\s+$/u, '')
  const note = ref === undefined ? '...(truncated)' : `...(truncated from ${ref})`
  return { text: out + note, truncated: true }
}

/**
 * Keep the LAST `limit` non-whitespace tokens of a text, additionally capped at
 * `limit * 4` characters. The end of the text is always preserved.
 * @param text - text to bound.
 * @param limit - non-whitespace token budget.
 * @param ref - provenance prepended as `...(elided before {ref})`.
 * @returns `{ text, truncated }`.
 */
function tailTokens(text: string, limit: number, ref?: string): { text: string; truncated: boolean } {
  const tokens = tokenize(text)
  let count = 0
  let startIdx = tokens.length
  for (let index = tokens.length - 1; index >= 0; index -= 1) {
    const token = tokens[index]
    if (token !== undefined && token.trim().length > 0) {
      count += 1
      if (count > limit) break
    }
    startIdx = index
  }
  let out = startIdx === 0 ? text : tokens.slice(startIdx).join('')
  let truncated = startIdx > 0
  const maxChars = Math.max(32, limit * 4)
  if (out.length > maxChars) {
    out = completeCodePointAtStart(out.slice(out.length - maxChars))
    truncated = true
  } else if (truncated) {
    out = completeCodePointAtStart(out)
  }
  if (!truncated) return { text, truncated: false }
  const note = ref === undefined ? '...(elided before)' : `...(elided before ${ref})`
  return { text: note + out, truncated: true }
}

// ── noise stripping (VCC `_BRIEF_STRIP_RE` family) ─────────────────────────

const NOISE_UNWRAP_RE = /<\/?(?:command-name|command-args)>/g

/**
 * The VCC brief-mode noise XML patterns, adapted to harness markup. Applied
 * with the `s` flag; the replacement set is configurable via
 * `CompileConfig.noisePatterns`.
 */
export const DEFAULT_NOISE_PATTERNS: readonly string[] = [
  '<ide_opened_file>.*?</ide_opened_file>',
  '<ide_selection>.*?</ide_selection>',
  '<system-reminder>.*?</system-reminder>',
  '<command-message>.*?</command-message>',
  '<task-notification>.*?</task-notification>',
]

/** Compile untrusted noise-pattern sources, throwing on an invalid regex. */
export function compileNoisePatterns(sources: readonly string[]): RegExp[] {
  return sources.map((source, index) => {
    try {
      return new RegExp(source, 's')
    } catch (error) {
      throw new Error(
        `noisePatterns[${index}] (${JSON.stringify(source)}) is not a valid regular expression: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  })
}

/**
 * Strip configured noise XML blocks from user text and unwrap command-name /
 * command-args tags (VCC `_strip_noise_xml` + `_BRIEF_UNWRAP_RE`).
 * @param text - user text.
 * @param patterns - compiled noise regexes.
 * @returns the stripped text, trimmed.
 */
export function stripNoiseXml(text: string, patterns: readonly RegExp[]): string {
  let out = text
  for (const pattern of patterns) out = out.replace(pattern, '')
  out = out.replace(NOISE_UNWRAP_RE, '')
  return out.trim()
}

// ── tool-call one-liner (VCC `_tool_summary`) ──────────────────────────────

/** VCC's `_TOOL_SUMMARY_FIELDS`, extended for the DSH tool catalog. */
export const DEFAULT_TOOL_KEY_FIELDS: Readonly<Record<string, string>> = Object.freeze({
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

/**
 * Tools whose key argument is kept in the one-liner. Everything else renders
 * name-only (`* tool (seq N)`) — bookkeeping tools carry no semantic payload
 * worth the tokens.
 */
export const DEFAULT_ARG_TOOLS: readonly string[] = Object.freeze([
  'read',
  'write',
  'edit',
  'glob',
  'grep',
  'bash',
  'shell',
  'web_search',
  'skill',
  'subagent',
  'subagent_fork',
  'ralph',
  'workflow',
])

/**
 * First-line projection for a tool-call one-liner: multiline arguments collapse
 * to the first physical line plus a `[+ N lines]` marker, so scripted commands
 * stay one compact line instead of echoing the whole payload.
 * @param value - the key-argument string.
 * @returns the display value.
 */
export function oneLineArg(value: string): string {
  const lines = value.split(/\r?\n/u)
  if (lines.length === 1) return value
  const first = lines[0] !== '' || lines.every((line) => line.trim() === '') ? lines[0] : lines.find((line) => line.trim() !== '')
  return `${first} [+ ${lines.length - 1} lines]`
}

/**
 * Pick the key argument for a tool-call one-liner: the tool-specific field
 * first, then the first string-valued argument, else nothing.
 * @param name - tool name.
 * @param input - parsed arguments object (or null when unparseable).
 * @param keyFields - merged tool-name → preferred-field map.
 * @returns the display value, or undefined.
 */
export function pickToolKeyArg(name: string, input: unknown, keyFields: Readonly<Record<string, string>>): string | undefined {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return undefined
  const preferred = keyFields[name]
  if (preferred !== undefined) {
    const value = (input as Record<string, unknown>)[preferred]
    if (typeof value === 'string' && value.length > 0) return value
  }
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.length > 0) return value
  }
  return undefined
}

/**
 * Safely parse a tool call's raw JSON arguments string.
 * @param argumentsRaw - raw JSON as produced by the model.
 * @returns the parsed value, or null when it is not valid JSON.
 */
export function parseToolArguments(argumentsRaw: string | undefined): unknown {
  try {
    return JSON.parse(argumentsRaw ?? 'null')
  } catch {
    return null
  }
}

// ── content projection helpers ─────────────────────────────────────────────

/**
 * Project nested tool-result blocks into one plain-text string: text blocks are
 * joined, images and documents render as VCC-style labels. A missing or non-array
 * input and null blocks are tolerated, because this helper sits on the tool
 * result, memory-recall and search paths alike.
 * @param blocks - nested result content.
 * @returns projected text.
 */
export function projectToolResultText(blocks: readonly unknown[] | unknown): string {
  const parts: string[] = []
  if (!Array.isArray(blocks)) return ''
  for (const block of blocks) {
    if (block === null || block === undefined) continue
    const typed = block as { type?: unknown; text?: unknown }
    if (typed.type === 'text') {
      const text = sanitize(typed.text ?? '')
      if (text.length > 0) parts.push(text)
    } else if (typed.type === 'image') parts.push('[image]')
    else if (typed.type === 'document') parts.push('[document]')
    else parts.push(`[${String(typed.type)}]`)
  }
  return parts.join('\n')
}

/**
 * Whether a message source is a landed compaction checkpoint node.
 *
 * The host builds the marker with `compactCheckpointSource()`, which yields
 * `{ kind: "compact-checkpoint", compactionId, sourceCommandId? }`. The legacy
 * `{ kind: "plugin", plugin: "compact" }` shape from earlier hosts is still
 * accepted so checkpoints written by an older host stay recallable.
 * @param source - message source descriptor, possibly absent.
 * @returns true for a checkpoint source.
 */
export function isCheckpointSource(source: unknown): boolean {
  if (source === undefined || source === null || typeof source !== 'object') return false
  const typed = source as { kind?: unknown; plugin?: unknown }
  if (typed.kind === 'compact-checkpoint') return true
  return typed.kind === 'plugin' && typed.plugin === 'compact'
}

/**
 * Whether a message source is one of the harness-injected instruction blocks
 * the caller asked to elide (see `CompileConfig.elideSourceKinds`). Matching is
 * on the structured `source.kind` the harness records, never on message text:
 * a user quoting "Instructions from:" must not be mistaken for the real thing.
 * The default (`undefined`/empty) matches nothing.
 * @param source - message source descriptor, possibly absent.
 * @param kinds - configured exact `source.kind` values to elide.
 * @returns true when this node should collapse to a recall pointer.
 */
export function isElidableSource(source: unknown, kinds: readonly string[] | undefined): boolean {
  if (kinds === undefined || kinds.length === 0) return false
  const kind = (source as { kind?: unknown } | undefined)?.kind
  return typeof kind === 'string' && kinds.includes(kind)
}

/**
 * Display labels for elidable instruction sources. Anything not listed falls
 * back to its raw `source.kind`, so a new host source still gets a readable
 * pointer without a code change.
 */
const ELIDABLE_SOURCE_LABELS: Readonly<Record<string, string>> = Object.freeze({
  'dsh-mnemon': 'memory snapshot',
  'agent-instructions': 'rules and cold-store index',
  'skill-catalog': 'skill catalog',
  'runtime-context': 'runtime context',
  'time-context': 'time context',
})

/** Markers that open a hot-memory snapshot as the memory plugin renders it. */
const MEMORY_SNAPSHOT_MARKERS: readonly string[] = Object.freeze(['MNEMON RUNTIME MEMORY SNAPSHOT', '[MNEMON]'])
/** Closing tag of one memory file block inside a snapshot. */
const MEMORY_FILE_CLOSE = '</runtime-memory-file>'
/**
 * Text that may separate two consecutive memory file blocks of ONE snapshot
 * (`USER.md` then `MEMORY.md`), so the two are treated as a single span.
 */
const MEMORY_BLOCK_JOINER = /^\s*(?:MEMORY\.md \(working reference\)|USER\.md \(user profile\)|<runtime-memory-file )/
/**
 * One role header line of this compiler's own checkpoint format. Memory
 * snapshots never contain one, so finding it between a file block's opening and
 * its close means the close belongs to a LATER block and the span must stop
 * before it: a block cut mid-way loses its closing tag, and without this guard
 * the span would swallow the conversation that follows.
 */
const MEMORY_ROLE_HEAD = /\n\[(?:user|assistant|tool)\]\s*\n/

/**
 * Marker text the host puts inside a real rules/index wrapper. Prose that only
 * mentions `<system-reminder>` as a string must not qualify, so a candidate span
 * has to prove itself by carrying one of these phrases early on.
 */
const SYSTEM_REMINDER_BODY_MARKERS: readonly string[] = Object.freeze([
  'The following workspace instructions may be relevant',
  'Instructions from:',
])
/** How far into a candidate wrapper the proof phrase must appear. */
const SYSTEM_REMINDER_PROOF_WINDOW = 600
/** How close a memory marker must sit to the first file block to count. */
const MEMORY_MARKER_WINDOW = 800

/**
 * Locate injected memory snapshots embedded in a PRIOR checkpoint body.
 *
 * A snapshot is a run of consecutive `<runtime-memory-file …>…</…>` blocks. The
 * span starts at the nearest preceding snapshot marker so the routing hint and
 * the preamble go with it. The marker must sit close to the first file block, so
 * prose that merely quotes the marker text is not mistaken for a snapshot.
 * @param text - prior checkpoint body.
 * @returns `[start, end)` character spans, left to right.
 */
function findMemorySnapshotSpans(text: string): [number, number][] {
  const spans: [number, number][] = []
  let searchFrom = 0
  let markerAt = findNextMarker(text, searchFrom)
  while (markerAt !== undefined) {
    const firstFile = text.indexOf('<runtime-memory-file ', markerAt)
    if (firstFile === -1) break
    if (firstFile - markerAt > MEMORY_MARKER_WINDOW) {
      // Just prose quoting the marker — skip past it and keep looking.
      searchFrom = markerAt + 1
      markerAt = findNextMarker(text, searchFrom)
      continue
    }
    let end: number | undefined
    let cursor = firstFile
    for (;;) {
      const close = text.indexOf(MEMORY_FILE_CLOSE, cursor)
      if (close === -1) break
      const roleHead = MEMORY_ROLE_HEAD.exec(text.slice(cursor, close))
      if (roleHead !== null) {
        end = cursor + roleHead.index
        break
      }
      const after = close + MEMORY_FILE_CLOSE.length
      end = after
      cursor = after
      if (!MEMORY_BLOCK_JOINER.test(text.slice(after, after + 240))) break
    }
    if (end === undefined) break
    spans.push([markerAt, end])
    searchFrom = end
    markerAt = findNextMarker(text, searchFrom)
  }
  return spans
}

/** The earliest snapshot marker at or after `from`, or undefined. */
function findNextMarker(text: string, from: number): number | undefined {
  let lowest: number | undefined
  for (const marker of MEMORY_SNAPSHOT_MARKERS) {
    const index = text.indexOf(marker, from)
    if (index !== -1 && (lowest === undefined || index < lowest)) lowest = index
  }
  return lowest
}

/**
 * Locate `<system-reminder>…</system-reminder>` wrappers that really frame
 * workspace rules, the cold-store index or runtime context.
 *
 * The wrapper must open at a line start, be followed by the block body marker
 * within a short window, and close before the body repeats — the host emits one
 * wrapper per injection, never nested. A sentence that merely mentions the tag
 * name fails all three checks, which is what keeps live prose intact.
 * @param text - prior checkpoint body.
 * @returns `[start, end)` character spans, left to right.
 */
function findSystemReminderSpans(text: string): [number, number][] {
  const spans: [number, number][] = []
  const pattern = /(?:^|\n)<system-reminder>\n/g
  let match: RegExpExecArray | null = pattern.exec(text)
  while (match !== null) {
    const open = text.indexOf('<system-reminder>', match.index)
    const head = text.slice(open, open + SYSTEM_REMINDER_PROOF_WINDOW)
    match = pattern.exec(text)
    if (!SYSTEM_REMINDER_BODY_MARKERS.some((marker) => head.includes(marker))) continue
    const close = text.indexOf('</system-reminder>', open)
    if (close === -1) continue
    spans.push([open, close + '</system-reminder>'.length])
  }
  return spans
}

/**
 * Collapse harness-injected bodies embedded in a PRIOR checkpoint to one-line
 * pointers.
 *
 * Why this exists: those bodies are re-sent in full after every compaction, so
 * any copy kept inside a checkpoint body is a duplicate — the checkpoint grows
 * by one snapshot per compaction even though nothing new was said. The originals
 * stay in the append-only session log, so `recall` still restores them verbatim.
 *
 * Only checkpoint prose is touched; live conversation text is never scanned. The
 * pointer carries no log position of its own: the enclosing checkpoint row's
 * `(seq N)` marks the durable record the whole body came from.
 * @param text - prior checkpoint body.
 * @returns the rewritten body plus how many spans and characters were removed.
 */
export function elideCheckpointInjectedBodies(text: string): { text: string; spans: number; chars: number } {
  const spans = [...findMemorySnapshotSpans(text), ...findSystemReminderSpans(text)].sort((left, right) => left[0] - right[0])
  if (spans.length === 0) return { text, spans: 0, chars: 0 }
  let out = ''
  let cursor = 0
  let chars = 0
  let removed = 0
  for (const [start, end] of spans) {
    // Overlapping spans would otherwise duplicate text; keep the outer one.
    if (start < cursor) continue
    out += text.slice(cursor, start)
    const length = end - start
    chars += length
    removed += 1
    out += `[${SPAN_POINTER_LABEL}: ${length} chars]`
    cursor = end
  }
  out += text.slice(cursor)
  return { text: out, spans: removed, chars }
}

/**
 * Wording of a one-line pointer that stands in for an elided body. The
 * enclosing row always carries the log position, so the pointer never claims
 * one of its own.
 */
const SPAN_POINTER_LABEL =
  'instructions compressed into a pointer while the checkpoint crosses: the originals are re-injected after the next compaction and `recall` restores them'

/** Per-node reference marker: the durable seq is the lossless pointer. */
function seqRef(seq: number): string {
  return `seq ${seq}`
}

/**
 * One-line pointer standing in for an elided instruction block. Carries the seq
 * so the agent can `recall` the original, plus what it was and how big it was —
 * a bare `(seq N)` would read as content loss rather than a substitution.
 * @param label - human name of the block.
 * @param seq - source sequence of the elided message.
 * @param length - original character count.
 * @returns the marker line.
 */
function elidedSourceMarker(label: string, seq: number, length: number): string {
  return `[${label} compressed into a pointer (${seqRef(seq)}, ${length} chars): the original is one \`recall\` away`
}

/**
 * Head/tail excerpt of a tool result under one shared token budget. The tail is
 * anchored to the end of the text at character granularity, so a result whose
 * tail matters more than its head (file listings, logs) keeps its end.
 * @param text - projected result text.
 * @param budget - combined non-whitespace token budget for head + tail.
 * @param ref - provenance for the elision marker.
 * @returns the excerpt, or the full text when it already fits.
 */
export function excerptToolResult(text: string, budget: number, ref: string): string {
  const overBudget = countTokens(text) > budget || text.length > budget * 4
  if (budget <= 0 || !overBudget) return text
  const half = Math.floor(budget / 2)
  const headLimit = Math.max(8, half)
  const tailLimit = Math.max(8, budget - headLimit)
  const head = truncateTokens(text, headLimit, ref)
  const tail = tailTokens(text, tailLimit, ref)
  return `${head.text}\n...(elided from ${ref})\n${tail.text}`
}

// ── the region compiler ────────────────────────────────────────────────────

export const CHECKPOINT_PREAMBLE =
  'This is an automatically generated checkpoint condensing an earlier span of the conversation to free up context. Treat the captured context as established background and build on it without restating it. Continue the task directly from the messages that follow, without acknowledging this checkpoint.'
export const CHECKPOINT_OPEN_TAG = '<compacted-checkpoint>'
export const CHECKPOINT_CLOSE_TAG = '</compacted-checkpoint>'

/**
 * Model-facing guide framed into the head of every checkpoint: tells the agent
 * how to recover content the compiler elided or truncated, using the two recall
 * tools that read the append-only durable log.
 */
export const RECALL_GUIDE =
  'RECALL: append-only log — nothing is lost. `recall` restores original content: type "seq", id "3-7"; "result", id "3"; "checkpoint", id "1" (`[checkpoint N]` = dropped). `search` finds by keyword.'

/**
 * Build marker for this compiler revision. Bumped whenever the compiled output
 * format changes, so debug logs can prove which code version ran.
 */
export const COMPILER_REV = 'vcc-compiler-debug-2'

/**
 * Emit one debug line through the configured sink (and stderr). The sink is
 * installed by the caller when `debug` is enabled; the compiler itself stays
 * dependency-free.
 * @param config - resolved compiler configuration.
 * @param tag - short component tag for the line.
 * @param line - the diagnostic text.
 */
function debugLog(config: CompileConfig, tag: string, line: string): void {
  if (config.debug !== true) return
  const text = `[vcc-compiler] ${tag}: ${line}`
  if (typeof config.debugSink === 'function') {
    try {
      config.debugSink(text)
    } catch {
      // A failing debug sink must never break a compaction.
    }
  }
  try {
    console.error(text)
  } catch {
    // stderr may be unavailable in embedded contexts.
  }
}

/** One message as the host derived it for the model. */
export interface CompileMessage {
  role: CompileRole
  content?: readonly unknown[] | null
  source?: unknown
  /** Tool-call id on a tool-result message (the host's derived shape). */
  toolCallId?: string
}

/** One projected surface node: the durable seq plus its derived message. */
export interface CompileNode {
  seq: number
  message: CompileMessage | null | undefined
}

/**
 * The roles a compiled node may carry. `tool` is the extension over the
 * published VCC declaration: the host derives tool results as role `tool` with
 * `toolCallId` on the message, and the compiler reads exactly what the model saw.
 */
export type CompileRole = 'system' | 'user' | 'assistant' | 'tool'

/** Per-block budgets applied by one compile pass. */
export interface CompileBudgets {
  textTokens: number
  userTextTokens: number
  toolCallTokens: number
  toolResultExcerptTokens: number
}

/** Compiler-relevant configuration. */
export interface CompileConfig extends CompileBudgets {
  /** Total cap for one compiled region, in tokens. */
  maxTokens: number
  includeReasoning?: boolean
  stripNoiseXml?: boolean
  noisePatterns?: readonly RegExp[]
  toolKeyFields?: Readonly<Record<string, string>>
  /** Tools whose key argument is rendered in the one-liner; others are name-only. */
  toolArgTools?: readonly string[]
  /** Bookkeeping tools dropped from the checkpoint entirely. */
  hideTools?: readonly string[]
  /** Exact `source.kind` values collapsed to recall pointers. */
  elideSourceKinds?: readonly string[]
  /** Collapse injected snapshot bodies embedded in a prior checkpoint. */
  elideCheckpointInjectedBodies?: boolean
  /** Emit per-block diagnostics when true. */
  debug?: boolean
  /** Optional debug line sink installed by the caller. */
  debugSink?: (line: string) => void
  /** Session-wide checkpoint seq → ordinal map (1 = oldest), for `[checkpoint N]` elision lines. */
  checkpointOrdinals?: ReadonlyMap<number, number>
}

/**
 * One compiled entry: an ordered line-group with its source seq and its
 * elision-priority kind. Kinds order the cap-elision passes: `result`, `tool`,
 * `media`, and `note` rows are dropped before `text`, `reasoning`, and
 * `checkpoint` rows, so conversation text survives a shrinking checkpoint
 * before the tool logs do.
 */
export interface CompileEntry {
  seq: number
  text: string
  kind: 'text' | 'reasoning' | 'tool' | 'result' | 'media' | 'note' | 'checkpoint'
}

/** Counters describing one compiled region. */
export interface CompileStats {
  nodes: number
  entries: number
  toolCalls: number
  toolResults: number
  images: number
  documents: number
  reasoningElided: number
  noiseElided: number
  elidedSourceRows: number
  elidedSourceChars: number
  elidedCheckpointSpans: number
  elidedCheckpointChars: number
  checkpoints: number
  tokens: number
  /** Low-value rows (tool/result/media/note) dropped by the first elision pass. */
  elidedToolRows: number
  /** Remaining entries dropped by the second (oldest-first) elision pass. */
  elidedRows: number
}

/**
 * Whether a message's content blocks are all media, which is the image-only
 * tool result that carries no text of its own to excerpt.
 * @param content - message content blocks.
 * @returns true when there is at least one block and every block is an image.
 */
function mediaOnly(content: readonly unknown[]): boolean {
  let media = 0
  for (const block of content) {
    if (block === null || block === undefined) continue
    if ((block as { type?: unknown }).type !== 'image') return false
    media += 1
  }
  return media > 0
}

/**
 * Count image blocks in one content array.
 * @param content - message content blocks.
 * @param type - the block type to count.
 * @returns the number of matching blocks.
 */
function countMedia(content: readonly unknown[], type: string): number {
  let count = 0
  for (const block of content) {
    if (block === null || block === undefined) continue
    if ((block as { type?: unknown }).type === type) count += 1
  }
  return count
}

/** The tool-call id a message-level or legacy `content[0]` field carries. */
function messageToolCallId(message: CompileMessage): string | undefined {
  if (typeof message.toolCallId === 'string') return message.toolCallId
  const first: unknown = Array.isArray(message.content) ? message.content[0] : undefined
  if (first === null || first === undefined || typeof first !== 'object') return undefined
  const blockId = (first as { toolCallId?: unknown }).toolCallId
  return typeof blockId === 'string' ? blockId : undefined
}

/**
 * Compile one ordered region into compact entries.
 * @param nodes - ordered `{ seq, message }` projections of the shadowed surface
 *   nodes; `message` may be null (a non-projecting node).
 * @param config - resolved compiler-relevant configuration.
 * @param budgets - optional per-block budgets; defaults to the config values
 *   (the cap loop passes scaled budgets on a retry).
 * @returns `{ entries, stats }` where each entry is one line-group string.
 */
export function compileNodes(nodes: readonly CompileNode[], config: CompileConfig, budgets?: CompileBudgets): { entries: CompileEntry[]; stats: CompileStats } {
  const effective: CompileBudgets = budgets ?? {
    textTokens: config.textTokens,
    userTextTokens: config.userTextTokens,
    toolCallTokens: config.toolCallTokens,
    toolResultExcerptTokens: config.toolResultExcerptTokens,
  }
  const keyFields: Readonly<Record<string, string>> = { ...DEFAULT_TOOL_KEY_FIELDS, ...(config.toolKeyFields ?? {}) }
  const patterns = config.noisePatterns ?? []
  // Empty lists mean "unset": the cordis config pipeline injects `[]` for absent
  // array keys, so fall back to the defaults instead of rendering every tool call
  // name-only.
  const argTools = config.toolArgTools !== undefined && config.toolArgTools.length > 0 ? config.toolArgTools : DEFAULT_ARG_TOOLS
  const hiddenTools = new Set(config.hideTools ?? [])
  debugLog(
    config,
    'compile',
    `rev=${COMPILER_REV} nodes=${nodes.length} argTools=[${argTools.join(',')}] hideTools=[${[...hiddenTools].join(',')}] budgets=${JSON.stringify(effective)}`,
  )
  const entries: CompileEntry[] = []
  const stats: CompileStats = {
    nodes: nodes.length,
    entries: 0,
    toolCalls: 0,
    toolResults: 0,
    images: 0,
    documents: 0,
    reasoningElided: 0,
    noiseElided: 0,
    elidedSourceRows: 0,
    elidedSourceChars: 0,
    elidedCheckpointSpans: 0,
    elidedCheckpointChars: 0,
    checkpoints: 0,
    tokens: 0,
    elidedToolRows: 0,
    elidedRows: 0,
  }
  // Pre-pass over the ordered nodes: map each tool-call id to the seq of its
  // result node, so every call one-liner can carry a VCC-style result pointer
  // (`(seq N -> result M)`) even though results occupy their own rows.
  const resultSeqByCallId = new Map<string, number>()
  for (const node of nodes) {
    const message = node.message
    if (message === null || message === undefined) continue
    const callId = messageToolCallId(message)
    if (callId !== undefined) resultSeqByCallId.set(callId, node.seq)
  }
  let lastRole: string | undefined
  let open = false

  /**
   * Append one compiled entry carrying a deletion-priority kind.
   * @param seq - durable seq the entry derives from.
   * @param text - rendered entry text.
   * @param kind - entry kind.
   */
  const pushEntry = (seq: number, text: string, kind: CompileEntry['kind']): void => {
    entries.push({ seq, text, kind })
    stats.entries += 1
    stats.tokens += estimateEntryTokens(text)
  }
  const roleHeader = (role: string): string => {
    if (!open || lastRole !== role) {
      open = true
      lastRole = role
      return `[${role}]\n`
    }
    return ''
  }

  for (const node of nodes) {
    const message = node.message
    if (message === null || message === undefined) continue
    if (!Array.isArray(message.content)) continue
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block === null || block === undefined) continue
        const typed = block as { type?: unknown; text?: unknown; name?: unknown; id?: unknown; arguments?: unknown }
        if (typed.type === 'text') {
          const text = sanitize(typed.text ?? '')
          if (text.trim().length === 0) continue
          const header = roleHeader('assistant')
          const kept = truncateTokens(text, effective.textTokens, seqRef(node.seq))
          pushEntry(node.seq, header + kept.text, 'text')
          continue
        }
        if (typed.type === 'reasoning') {
          if (config.includeReasoning !== true) {
            stats.reasoningElided += 1
            continue
          }
          const text = sanitize(typed.text ?? '')
          if (text.trim().length === 0) continue
          const header = roleHeader('assistant')
          const kept = truncateTokens(text, effective.textTokens, seqRef(node.seq))
          pushEntry(node.seq, header + kept.text, 'reasoning')
          continue
        }
        if (typed.type === 'tool-call') {
          const name = typeof typed.name === 'string' ? typed.name : 'unknown'
          stats.toolCalls += 1
          if (hiddenTools.has(name)) {
            debugLog(config, 'tool', `seq=${node.seq} name=${name} HIDDEN (hideTools)`)
            continue
          }
          const header = roleHeader('assistant')
          // One line, always: key argument only for whitelisted tools, and a
          // VCC-style pointer to the result node (`* read "a.js" (seq 2 ->
          // result 3)`) so the result stays one recall away.
          let oneLine: string
          let diag: string
          if (argTools.includes(name)) {
            const parsed = parseToolArguments(typeof typed.arguments === 'string' ? typed.arguments : undefined)
            const arg = pickToolKeyArg(name, parsed, keyFields)
            oneLine = arg === undefined ? `* ${name}` : `* ${name} "${oneLineArg(arg)}"`
            diag = `whitelist=yes argsType=${typeof typed.arguments} argsLen=${typed.arguments === null || typed.arguments === undefined ? 0 : String(typed.arguments).length} argsHead=${JSON.stringify(String(typed.arguments).slice(0, 60))} parse=${parsed === null ? 'FAIL' : 'ok'} key=${keyFields[name] ?? '(fallback)'} arg=${arg === undefined ? '(none)' : JSON.stringify(String(arg).slice(0, 60))}`
          } else {
            oneLine = `* ${name}`
            diag = `whitelist=no argsType=${typeof typed.arguments} argsLen=${typed.arguments === null || typed.arguments === undefined ? 0 : String(typed.arguments).length} argsHead=${JSON.stringify(String(typed.arguments).slice(0, 60))}`
          }
          const resultSeq = typeof typed.id === 'string' ? resultSeqByCallId.get(typed.id) : undefined
          const ref = resultSeq === undefined ? seqRef(node.seq) : `${seqRef(node.seq)} -> result ${resultSeq}`
          const kept = truncateTokens(oneLine, effective.toolCallTokens, seqRef(node.seq))
          debugLog(config, 'tool', `seq=${node.seq} name=${name} ${diag} line=${JSON.stringify(oneLine.slice(0, 80))} truncated=${kept.truncated} ref=${ref}`)
          pushEntry(node.seq, header + `${kept.text} (${ref})`, 'tool')
          continue
        }
        if (typed.type === 'image') {
          stats.images += 1
          const header = roleHeader('assistant')
          pushEntry(node.seq, header + `[image] (${seqRef(node.seq)})`, 'media')
          continue
        }
        if (typed.type === 'document') {
          stats.documents += 1
          const header = roleHeader('assistant')
          pushEntry(node.seq, header + `[document] (${seqRef(node.seq)})`, 'media')
          continue
        }
        // Unknown merge-extensible block types render as labels.
        const header = roleHeader('assistant')
        pushEntry(node.seq, header + `[${String(typed.type)}] (${seqRef(node.seq)})`, 'media')
      }
      // Reasoning-only and empty assistant messages produce no entry.
      continue
    }
    // The host derives a tool result as `role: "tool"` with `toolCallId` on the
    // message and a plain text block as `content[0]`.
    if (message.role === 'tool') {
      stats.toolResults += 1
      // The first text block decides whether this result takes a row at all;
      // image, document and other non-text blocks after it render as labels.
      const body = projectToolResultText(message.content)
      if (body.length > 0) {
        const header = roleHeader('tool')
        // Excerpt to the configured budget: tool output is the bulk of a long
        // session, and the full text stays one `recall(type:"result")` away via
        // the call line's `-> result N` pointer.
        const kept = excerptToolResult(body, effective.toolResultExcerptTokens, seqRef(node.seq))
        pushEntry(node.seq, header + kept, 'result')
      }
      // A media-only result (a screenshot from an image tool) projects a label
      // into the excerpt above but still gets its own media row, so the view does
      // not record an image it never shows.
      if (mediaOnly(message.content)) {
        stats.images += 1
        pushEntry(node.seq, `[image] (${seqRef(node.seq)})`, 'media')
      }
      continue
    }
    if (message.role === 'user') {
      const first: unknown = message.content[0]
      if (first !== undefined && first !== null && typeof first === 'object' && (first as { type?: unknown }).type === 'tool-result') {
        // A legacy user-role tool-result carries no entry of its own: the call
        // line's `-> result N` pointer keeps the original one recall away. The
        // image count still records images the view does not show.
        stats.toolResults += 1
        stats.images += countMedia(message.content, 'image')
        continue
      }
      if (isCheckpointSource(message.source)) {
        stats.checkpoints += 1
        let text = projectToolResultText(message.content)
        if (text.length > 0 && config.elideCheckpointInjectedBodies === true) {
          // A prior checkpoint body still carries every memory snapshot and rules
          // block that was live when it was compiled, and those are re-sent in
          // full after this compaction, so keeping them here is a duplicate.
          const collapsed = elideCheckpointInjectedBodies(text)
          if (collapsed.spans > 0) {
            text = collapsed.text
            stats.elidedCheckpointSpans += collapsed.spans
            stats.elidedCheckpointChars += collapsed.chars
          }
        }
        if (text.length > 0) {
          // The checkpoint node is a user message in the durable protocol, but it
          // is harness-generated framing — display it as [system].
          const header = roleHeader('system')
          pushEntry(node.seq, header + text, 'checkpoint')
        }
        continue
      }
      if (isElidableSource(message.source, config.elideSourceKinds)) {
        // Harness-injected instruction blocks (hot memory, workspace rules, skill
        // catalog…) are re-injected in full after every compaction, so keeping
        // their body here duplicates them. Collapse to a recall pointer.
        const text = projectToolResultText(message.content)
        if (text.length === 0) continue
        const kind = (message.source as { kind: string }).kind
        const label = ELIDABLE_SOURCE_LABELS[kind] ?? kind
        stats.elidedSourceRows += 1
        stats.elidedSourceChars += text.length
        pushEntry(node.seq, `${roleHeader('user')}* ${elidedSourceMarker(label, node.seq, text.length)}`, 'note')
        continue
      }
      let surviving = 0
      for (const block of message.content) {
        if (block === null || block === undefined) continue
        const typed = block as { type?: unknown; text?: unknown }
        if (typed.type === 'text') {
          let text = sanitize(typed.text ?? '')
          if (config.stripNoiseXml !== false) text = stripNoiseXml(text, patterns)
          if (text.length === 0) continue
          surviving += 1
          const header = roleHeader('user')
          const kept = truncateTokens(text, effective.userTextTokens, seqRef(node.seq))
          pushEntry(node.seq, header + kept.text, 'text')
        } else if (typed.type === 'image') {
          stats.images += 1
          surviving += 1
          const header = roleHeader('user')
          pushEntry(node.seq, header + `[image] (${seqRef(node.seq)})`, 'media')
        } else if (typed.type === 'document') {
          stats.documents += 1
          surviving += 1
          const header = roleHeader('user')
          pushEntry(node.seq, header + `[document] (${seqRef(node.seq)})`, 'media')
        } else {
          const text = sanitize(typed.text ?? '')
          if (text.length === 0) continue
          surviving += 1
          const header = roleHeader('user')
          const kept = truncateTokens(text, effective.userTextTokens, seqRef(node.seq))
          pushEntry(node.seq, header + kept.text, 'text')
        }
      }
      if (surviving === 0) {
        stats.noiseElided += 1
        pushEntry(node.seq, `${roleHeader('user')}* [user message elided: noise-only] (${seqRef(node.seq)})`, 'note')
      }
    }
  }
  return { entries, stats }
}

/**
 * Per-budget elision floors: conversation text keeps a meaningful minimum even
 * when the total cap forces heavy rescaling, while tool one-liners and result
 * excerpts may collapse to near-nothing first.
 */
const BUDGET_FLOORS: Readonly<Record<keyof CompileBudgets, number>> = Object.freeze({
  textTokens: 32,
  userTextTokens: 32,
  toolCallTokens: 8,
  toolResultExcerptTokens: 8,
})

/** Entry kinds dropped by the first (low-value) elision pass. */
const LOW_VALUE_KINDS = new Set<CompileEntry['kind']>(['result', 'tool', 'media', 'note'])

/**
 * Scale ONLY the conversation-text budgets toward a total cap, never below the
 * per-key floor. Tool-call rows stay one-liners at their configured budget:
 * conversation shrinks first, tool rows are sacrificed whole by the elision
 * pass, so tool calls can never squeeze the dialogue out.
 * @param budgets - budget map to scale.
 * @param factor - uniform scale factor for text budgets.
 * @returns the scaled budget map (tool budgets untouched).
 */
function scaleBudgets(budgets: CompileBudgets, factor: number): CompileBudgets {
  const scaled = { ...budgets }
  for (const key of ['textTokens', 'userTextTokens'] as const) {
    scaled[key] = Math.max(BUDGET_FLOORS[key], Math.floor(budgets[key] * factor))
  }
  return scaled
}

/** Render the provenance range of one dropped-entry list. */
function seqRangeOf(dropped: readonly CompileEntry[]): string {
  const first = dropped[0]?.seq
  const last = dropped[dropped.length - 1]?.seq
  return first === last ? `seq ${first}` : `seqs ${first}-${last}`
}

/**
 * Compile a region to completion under the total checkpoint cap: budgets are
 * rescaled toward `config.maxTokens` up to a fixed number of attempts, then the
 * oldest low-value rows (tool/result/media/note) are front-elided first, and
 * only then the oldest remaining entries — so the conversation's words survive
 * elision before its logs do. The newest entry always survives; recency is the
 * value ranking, as in VCC chunking.
 * @param nodes - ordered `{ seq, message }` projections.
 * @param config - resolved compiler configuration.
 * @returns `{ entries, stats, capped }` — `capped` records cap enforcement.
 */
export function compileRegion(
  nodes: readonly CompileNode[],
  config: CompileConfig,
): { entries: CompileEntry[]; stats: CompileStats; capped: boolean } {
  let budgets: CompileBudgets = {
    textTokens: config.textTokens,
    userTextTokens: config.userTextTokens,
    toolCallTokens: config.toolCallTokens,
    toolResultExcerptTokens: config.toolResultExcerptTokens,
  }
  const result = compileNodes(nodes, config, budgets)
  let attempts = 0
  const maxAttempts = 4
  while (result.stats.tokens > config.maxTokens && attempts < maxAttempts) {
    budgets = scaleBudgets(budgets, (config.maxTokens / result.stats.tokens) * 0.95)
    const next = compileNodes(nodes, config, budgets)
    result.entries = next.entries
    result.stats = next.stats
    attempts += 1
  }
  let capped = false
  if (result.stats.tokens > config.maxTokens) {
    const entries = result.entries
    // Phase A: drop the oldest low-value rows (tool/result/media/note) anywhere in
    // the list first, so conversation text and prior-checkpoint knowledge survive
    // elision before the logs do. The marker's seq range is the dropped rows' span
    // (approximate: surviving text may sit inside it).
    const toolRows: CompileEntry[] = []
    while (entries.length > 1 && result.stats.tokens > config.maxTokens) {
      const index = entries.findIndex((entry, position) => position < entries.length - 1 && LOW_VALUE_KINDS.has(entry.kind))
      if (index === -1) break
      const dropped = entries.splice(index, 1)[0]
      if (dropped === undefined) break
      result.stats.tokens -= estimateEntryTokens(dropped.text)
      toolRows.push(dropped)
    }
    if (toolRows.length > 0) {
      capped = true
      result.stats.elidedToolRows += toolRows.length
      entries.unshift({ seq: toolRows[0]?.seq ?? 0, text: `[${toolRows.length} tool/result entries elided: ${seqRangeOf(toolRows)}]`, kind: 'note' })
      result.stats.tokens += estimateEntryTokens(entries[0]?.text ?? '')
    }
    const elided: CompileEntry[] = []
    const droppedCheckpoints: CompileEntry[] = []
    while (entries.length > 1 && result.stats.tokens > config.maxTokens) {
      const dropped = entries.shift()
      if (dropped === undefined) break
      result.stats.tokens -= estimateEntryTokens(dropped.text)
      elided.push(dropped)
      if (dropped.kind === 'checkpoint') droppedCheckpoints.push(dropped)
    }
    if (elided.length > 0) {
      capped = true
      result.stats.elidedRows += elided.length
      // Dropped prior checkpoints never vanish silently: each leaves a single
      // `[checkpoint N]` line the agent can restore in full via
      // recall(type:"checkpoint", id:"N").
      const markerLines = [`[${elided.length} earlier entries elided: ${seqRangeOf(elided)}]`]
      for (const dropped of droppedCheckpoints) {
        const ordinal = config.checkpointOrdinals?.get(dropped.seq)
        const ref = ordinal === undefined ? `@ seq ${dropped.seq}` : String(ordinal)
        markerLines.push(`[checkpoint ${ref}]`)
      }
      entries.unshift({ seq: elided[0]?.seq ?? 0, text: markerLines.join('\n'), kind: 'note' })
      result.stats.tokens += estimateEntryTokens(entries[0]?.text ?? '')
    }
    const only = entries[0]
    if (result.stats.tokens > config.maxTokens && entries.length === 1 && only !== undefined) {
      capped = true
      const hard = truncateTokens(only.text, Math.max(8, config.maxTokens - 4), 'total cap')
      entries[0] = { seq: only.seq, text: hard.text, kind: only.kind }
      result.stats.tokens = estimateEntryTokens(entries[0].text)
    }
  }
  return { entries: result.entries, stats: result.stats, capped }
}

/**
 * Normalize one compiled entry to its text: entries are `{ seq, text }` pairs,
 * but a custom compile hook may supply plain strings.
 * @param entry - entry value.
 * @returns the entry's text.
 */
export function entryText(entry: string | CompileEntry): string {
  return typeof entry === 'string' ? entry : entry.text
}

/**
 * Join compiled entries with separators that keep tool runs compact: consecutive
 * `tool` rows join with a single newline (no blank line), while every other
 * boundary keeps the blank line that separates entry groups. Strings (guide,
 * header, elision markers) behave like `text` entries.
 * @param entries - ordered entry texts (strings or `{ seq, text, kind }` pairs).
 * @returns the joined body text.
 */
export function joinCompiledEntries(entries: readonly (string | CompileEntry)[]): string {
  let out = ''
  let previousKind: string | undefined
  for (const entry of entries) {
    const kind = typeof entry === 'string' ? 'text' : entry.kind
    if (out.length > 0) out += previousKind === 'tool' && kind === 'tool' ? '\n' : '\n\n'
    out += entryText(entry)
    previousKind = kind
  }
  return out
}

/**
 * Frame compiled entries as the durable replacement checkpoint content: the
 * shared preamble, the recall guide, then one tagged block (guide first, then
 * the optional intro line, the optional header line, the entries, and the
 * optional retention footer). Prior-checkpoint text copied verbatim (with its
 * own backend's tags) nests inside harmlessly.
 * @param entries - ordered entry texts (strings or `{ seq, text, kind }` pairs).
 * @param headerLine - optional first line summarizing the compiled region.
 * @param introLine - optional first line summarizing the compaction itself.
 * @param footerLine - optional tail line, or an ordered list of trailing notes.
 * @returns plain text content blocks.
 */
export function frameCheckpoint(
  entries: readonly (string | CompileEntry)[],
  headerLine?: string,
  introLine?: string,
  footerLine?: string | readonly (string | undefined)[],
): { type: 'text'; text: string }[] {
  const body: (string | CompileEntry)[] = [RECALL_GUIDE]
  if (introLine !== undefined) body.push(introLine)
  if (headerLine !== undefined) body.push(headerLine)
  body.push(...entries)
  if (footerLine !== undefined) {
    if (typeof footerLine === 'string') body.push(footerLine)
    else body.push(...footerLine.filter((line): line is string => line !== undefined))
  }
  return [
    { type: 'text', text: `${CHECKPOINT_PREAMBLE}\n\n${CHECKPOINT_OPEN_TAG}` },
    { type: 'text', text: joinCompiledEntries(body) },
    { type: 'text', text: CHECKPOINT_CLOSE_TAG },
  ]
}
