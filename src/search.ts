/**
 * Keyword/regex search over the durable session log (ticket 2zex, contract C6).
 *
 * The retrieval counterpart of `recall`: the append-only session log is the
 * full transcript, so this module scans every record's projected content and
 * reports the matching records with their log positions. A caller then passes
 * any position straight to `recall` to restore the exact original tokens.
 *
 * Adapted from `dsh-compaction-vcc@0.7.4` (`src/search.js`) onto the fork's
 * accessors (`sessionEvents`) and the session's `deriveEventMessage`: the
 * pattern semantics and the bounded per-hit rendering are VCC's, and the
 * per-hit line budget is the recall budget. A record is a derived message or a
 * log-only event, never a compaction checkpoint node, whose body is generated
 * text rather than conversation.
 *
 * @module dsh-context-rollover/search
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { sessionEvents } from './compat.ts'
import { DEFAULT_MAX_RECALL_TOKENS, projectMessageText } from './recall.ts'
import { estimateEntryTokens, isCheckpointSource, sanitize, truncateTokens } from './vcc/compiler.ts'

/** A search pattern that cannot be compiled into a regular expression. */
export class InvalidSearchPatternError extends Error {
  /**
   * @param source - the raw pattern the caller supplied.
   * @param reason - the regex compiler's message.
   */
  constructor(source: string, reason: string) {
    super(`invalid search pattern ${JSON.stringify(source)}: ${reason}`)
    this.name = 'InvalidSearchPatternError'
  }
}

/** One matching record: its log position and the rendered matching lines. */
interface SearchHit {
  readonly seq: number
  readonly text: string
}

/** The visible outcome of one search. */
export interface SearchResult {
  /** The rendered result, ready for the model. */
  readonly text: string
  /** The pattern source that was searched. */
  readonly pattern: string
  /** Records with at least one matching line. */
  readonly totalMatches: number
  /** Matching records the budget kept out of the result. */
  readonly omitted: number
  /** Whether the budget cut a kept record or left one out. */
  readonly truncated: boolean
}

/** Lines shown per matching record, VCC's cap. */
const MAX_LINES_PER_HIT = 10

/**
 * Compile one pattern: case-insensitive, Unicode-aware, read as a regular
 * expression so a keyword works as written and an escaped pattern works as a
 * regex.
 * @param source - raw pattern text.
 * @returns the compiled pattern.
 * @throws InvalidSearchPatternError when the pattern is blank or uncompilable.
 */
function compileSearchPattern(source: string): RegExp {
  if (source.trim().length === 0) throw new InvalidSearchPatternError(source, 'pattern is empty')
  try {
    return new RegExp(source, 'iu')
  } catch (error: unknown) {
    throw new InvalidSearchPatternError(source, error instanceof Error ? error.message : String(error))
  }
}

/**
 * Search every record of one session's log by keyword or regular expression.
 * @param session - the session whose log to read.
 * @param query - the keyword or regular expression.
 * @param maxTokens - the recall budget the hit lines are bounded by.
 * @returns the matching records with their log positions.
 * @throws InvalidSearchPatternError for a blank or uncompilable pattern.
 */
export function searchLog(session: Session, query: string, maxTokens = DEFAULT_MAX_RECALL_TOKENS): SearchResult {
  const pattern = compileSearchPattern(query)
  const hits: SearchHit[] = []
  let totalMatches = 0
  let budget = maxTokens
  let truncated = false
  // One pattern is reused across records, so a `/g`-class stateful flag would
  // leak between lines; the compiled flags are none.
  for (const event of sessionEvents(session)) {
    if (event.type === 'user/message' && isCheckpointSource((event.data as { source?: unknown }).source)) continue
    const message = session.deriveEventMessage(event)
    const body = message === null
      ? `[${event.type}]\n${JSON.stringify(event.data ?? null)}`
      : projectMessageText(message)
    const matched: { line: number; text: string }[] = []
    for (const [index, line] of body.split('\n').entries()) {
      if (pattern.test(line)) matched.push({ line: index + 1, text: sanitize(line) })
    }
    if (matched.length === 0) continue
    totalMatches += 1
    if (budget <= 0) {
      truncated = true
      continue
    }
    const seq = Number(event.seq)
    const kind = message === null ? event.type : message.role
    const shown = matched.slice(0, MAX_LINES_PER_HIT)
    const more = matched.length - shown.length
    const block = [
      `[seq ${seq}: ${kind}]`,
      ...shown.map(entry => `  ${entry.line}: ${entry.text}`),
      ...(more > 0 ? [`  ...(${more} more matching lines in this record)`] : []),
    ].join('\n')
    const kept = truncateTokens(block, budget, 'search budget')
    budget -= estimateEntryTokens(kept.text)
    if (kept.truncated) truncated = true
    hits.push({ seq, text: kept.text })
  }
  const omitted = totalMatches - hits.length
  const lines = [
    `[search ${JSON.stringify(pattern.source)}: ${totalMatches} matching record(s) in this session log]`,
  ]
  if (hits.length === 0) {
    lines.push('[no matches in this session log]')
    return { text: lines.join('\n\n'), pattern: pattern.source, totalMatches, omitted, truncated }
  }
  lines.push(...hits.map(hit => hit.text))
  if (omitted > 0) lines.push(`[${omitted} more matching record(s) omitted; narrow the pattern or read them with recall]`)
  if (truncated) lines.push('[search budget exhausted; some hits were cut, so narrow the pattern or read them with recall]')
  lines.push('[use recall({ type: "seq", id: "<seq>" }) to restore any hit\'s full original content]')
  return { text: lines.join('\n\n'), pattern: pattern.source, totalMatches, omitted, truncated }
}
