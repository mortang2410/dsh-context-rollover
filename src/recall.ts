/**
 * Same-session recall: the lossless read-back half of the vendored VCC
 * compiler (ticket 2zex, contract C6).
 *
 * A compiled checkpoint marks every elision with a `(seq N)` / `(seqs A-B)`
 * pointer into the durable session log; this module expands those pointers
 * back into VCC's complete textual projection of the named records. The log is
 * append-only, so every token the compiler truncated or elided is still
 * present and recoverable.
 *
 * Adapted from `dsh-compaction-vcc@0.7.4` (`src/recall.js`): the projection,
 * the seq-selection parser, and the budget bookkeeping are VCC's, and the log
 * is read through the fork's own accessors (`sessionEvents`, `sessionEventAt`)
 * and the session's `deriveEventMessage`. The reference argument is the record
 * a pointer names, so an unknown one is reported rather than recalled.
 *
 * @module dsh-context-rollover/recall
 */

import type { Message } from '@deepseek-ai/dsh-llm'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { sessionEventAt, sessionEvents } from './compat.ts'
import { estimateEntryTokens, isCheckpointSource, projectToolResultText, sanitize, truncateTokens } from './vcc/compiler.ts'

/** Default total budget for one recall operation, in density-aware tokens. */
export const DEFAULT_MAX_RECALL_TOKENS = 16000

/** A recall request whose reference names no record in this session. */
export class RecallMissError extends Error {
  /**
   * @param message - what was requested and what the log holds instead.
   */
  constructor(message: string) {
    super(message)
    this.name = 'RecallMissError'
  }
}

/** One block of a derived message, as the projection reads it. */
interface ProjectedBlock {
  readonly type: string
  readonly text?: string
  readonly name?: string
  readonly arguments?: string
  readonly content?: readonly unknown[] | unknown
}

/** One recalled record and its projection. */
interface RecallEntry {
  readonly seq: number
  readonly text: string
}

/** The visible outcome of one recall operation. */
export interface RecallResult {
  /** Every entry's projection, joined in request order. */
  readonly text: string
  /** The seqs whose projection is included, cut copies included. */
  readonly seqs: readonly number[]
  /** Whether any kept entry was cut by the budget. */
  readonly truncated: boolean
  /** The budget the recall ran under, in density-aware tokens. */
  readonly maxTokens: number
}

/**
 * Project one derived message into plain text, keeping everything: text,
 * reasoning, raw tool-call arguments, and nested tool-result content. Recall is
 * the lossless layer, so nothing is elided here except media, which renders as
 * labels (their bytes live in the attachment service).
 * @param message - the session's derived message for the event.
 * @returns the full plain-text projection.
 */
export function projectMessageText(message: Message): string {
  const parts: string[] = []
  for (const block of message.content as unknown as readonly ProjectedBlock[]) {
    switch (block.type) {
      case 'text':
        if (block.text !== undefined && block.text.length > 0) parts.push(sanitize(block.text))
        break
      case 'reasoning':
        if (block.text !== undefined && block.text.length > 0) parts.push(`[reasoning]\n${sanitize(block.text)}`)
        break
      case 'tool-call':
        parts.push(`[tool-call ${block.name ?? 'unknown'}]\n${sanitize(block.arguments ?? '')}`)
        break
      case 'tool-result':
        parts.push(`[tool-result]\n${projectToolResultText(block.content ?? [])}`)
        break
      case 'image':
        parts.push('[image]')
        break
      case 'file':
        parts.push('[file]')
        break
      default:
        parts.push(`[${block.type}]`)
    }
  }
  return parts.join('\n')
}

/**
 * The body recall shows for one log position: the derived message's
 * projection, or a labeled data dump for a log-only event that derives no
 * message.
 * @param event - the logged event.
 * @param derive - the session's message derivation.
 * @returns the header line and the body.
 */
function recordProjection(
  event: SessionEvent,
  derive: (event: SessionEvent) => Message | null,
): string {
  const message = derive(event)
  if (message !== null) return `[seq ${event.seq}: ${message.role}]\n${projectMessageText(message)}`
  return `[seq ${event.seq}: ${event.type}]\n${JSON.stringify(event.data ?? null)}`
}

/**
 * The position a `seq N` (`[seq N]`, `(seq N)`) or bare-number pointer names,
 * or `undefined` when the text carries no such pointer.
 * @param ref - reference text.
 * @returns the parsed seq.
 */
function pointerSeq(ref: string): number | undefined {
  const token = ref.replace(/^\((.*)\)$/u, '$1').trim()
  const prefixed = /^seqs?\s+(\d+)$/iu.exec(token)
  const bare = /^(\d+)$/u.exec(token)
  const digits = prefixed?.[1] ?? bare?.[1]
  if (digits === undefined) return undefined
  const seq = Number(digits)
  return Number.isSafeInteger(seq) ? seq : undefined
}

/**
 * Build the not-found message for one reference.
 * @param session - the session whose log was searched.
 * @param ref - the reference text the caller supplied.
 * @returns the message naming what was not found and what the log holds.
 */
function positionMiss(session: Session, ref: string): string {
  return `seq(s) ${ref} not found in this session log; this log ends at seq ${Number(session.seq) - 1}`
}

/**
 * Project the record at one log position.
 * @param session - the session whose log holds it.
 * @param seq - the log position.
 * @returns the record's header line and projected body, joined by a newline.
 */
function positionBody(session: Session, seq: number): string {
  const event = sessionEventAt(session, seq)
  if (event === undefined || Number(event.seq) !== seq) throw new RecallMissError(positionMiss(session, String(seq)))
  return recordProjection(event, each => session.deriveEventMessage(each))
}

/**
 * Resolve a tool-result reference: the `result N` pointer of a tool-call
 * one-liner, its `seq N` form, or the bare seq.
 * @param session - the session whose log holds the result.
 * @param ref - reference text.
 * @returns the tool result's log position.
 */
function resultSeqFor(session: Session, ref: string): number {
  const token = ref.replace(/^\((.*)\)$/u, '$1').trim()
  const fromResult = /^result\s+(\d+)$/iu.exec(token)?.[1]
  const seq = fromResult === undefined ? pointerSeq(token) : Number(fromResult)
  if (seq === undefined) {
    throw new RecallMissError(
      `invalid result reference "${ref}": expected a seq like "3" or "result 3"`,
    )
  }
  const event = sessionEventAt(session, seq)
  if (event === undefined || Number(event.seq) !== seq) throw new RecallMissError(positionMiss(session, String(seq)))
  if (event.type !== 'tool/result') throw new RecallMissError(`seq ${seq} is not a tool result in this session log (it is ${event.type})`)
  return seq
}

/**
 * The log positions of every projected checkpoint node, oldest first. A
 * checkpoint node is the message whose source is a landed compaction, never a
 * user message that merely mentions one.
 * @param session - the session whose log to scan.
 * @returns the checkpoint positions.
 */
export function findCheckpointSeqs(session: Session): number[] {
  const seqs: number[] = []
  for (const event of sessionEvents(session)) {
    if (event.type === 'user/message' && isCheckpointSource(event.data.source)) seqs.push(Number(event.seq))
  }
  return seqs
}

/**
 * Resolve a checkpoint reference: an ordinal (`1` = oldest, as in the
 * `[checkpoint N]` elision marker), or a `seq N` pointer to a checkpoint node.
 * @param session - the session whose log holds the checkpoint.
 * @param ref - reference text.
 * @returns the checkpoint's log position.
 */
function checkpointSeqFor(session: Session, ref: string): number {
  const token = ref.replace(/^\((.*)\)$/u, '$1').trim()
  const bySeq = /^seqs?\s+(\d+)$/iu.exec(token)?.[1]
  if (bySeq !== undefined) {
    const seq = Number(bySeq)
    const event = sessionEventAt(session, seq)
    if (event === undefined || Number(event.seq) !== seq) throw new RecallMissError(positionMiss(session, String(seq)))
    if (!isCheckpointEvent(event)) throw new RecallMissError(`seq ${seq} is not a checkpoint node in this session log`)
    return seq
  }
  const ordinalText = token.replace(/^checkpoints?\s+/iu, '')
  const digits = /^(\d+)$/u.exec(ordinalText)?.[1]
  const ordinal = digits === undefined ? undefined : Number(digits)
  if (ordinal === undefined || !Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new RecallMissError(
      `invalid checkpoint reference "${ref}": expected an ordinal like "1" or "checkpoint 1", or a "seq N" pointer`,
    )
  }
  const checkpointSeqs = findCheckpointSeqs(session)
  const seq = checkpointSeqs[ordinal - 1]
  if (seq === undefined) {
    throw new RecallMissError(
      `checkpoint ${ordinal} not found in this session log (this session has ${checkpointSeqs.length} checkpoint(s))`,
    )
  }
  return seq
}

/** Whether one event is a checkpoint node. */
function isCheckpointEvent(event: SessionEvent): boolean {
  return event.type === 'user/message' && isCheckpointSource((event.data as { source?: unknown }).source)
}

/**
 * Project one list of log positions under one budget. Each kept entry is cut
 * to what the budget leaves, and a cut carries VCC's `...(truncated from
 * recall budget)` marker plus the pointer that names what was cut, so the
 * caller can ask again for the full record.
 * @param session - the session whose log to read.
 * @param seqs - the positions to project, in request order.
 * @param maxTokens - the recall budget.
 * @returns the entries and the budget outcome.
 */
function recallSeqs(session: Session, seqs: readonly number[], maxTokens: number): RecallResult {
  const entries: RecallEntry[] = []
  let budget = maxTokens
  let truncated = false
  let skipped = 0
  for (const [index, seq] of seqs.entries()) {
    if (budget <= 0) {
      skipped = seqs.length - index
      truncated = true
      break
    }
    const projected = positionBody(session, seq)
    const kept = truncateTokens(projected, budget, 'recall budget')
    budget -= estimateEntryTokens(kept.text)
    if (kept.truncated) {
      truncated = true
      entries.push({
        seq,
        text: `${kept.text}\n[the record continues past the recall budget; `
          + `reply with recall({ type: "seq", ref: "${seq}" }) and a larger max_tokens to read it all]`,
      })
      continue
    }
    entries.push({ seq, text: kept.text })
  }
  const blocks = entries.map(entry => entry.text)
  if (skipped > 0) {
    const first = seqs[seqs.length - skipped]
    blocks.push(`[recall budget exhausted: ${skipped} further requested seq(s) not included, from seq ${first}]`)
  }
  return { text: blocks.join('\n\n'), seqs: entries.map(entry => entry.seq), truncated, maxTokens }
}

/**
 * Validate a recall budget: a positive integer, in density-aware tokens.
 * @param maxTokens - the candidate budget.
 * @returns the budget.
 */
function recallBudget(maxTokens: number): number {
  if (!Number.isSafeInteger(maxTokens) || maxTokens <= 0) {
    throw new TypeError(`max_tokens must be a positive integer, got ${String(maxTokens)}`)
  }
  return maxTokens
}

/**
 * Parse one seq selection into ordered inclusive ranges, accepting the
 * checkpoint marker forms per comma-separated part: `12`, `3-7`, `seq 12`,
 * `seqs 3-7`, with optional parentheses.
 * @param spec - raw selection text.
 * @returns the ranges.
 */
function parseSeqSpec(spec: string): { start: number; end: number }[] {
  const ranges: { start: number; end: number }[] = []
  for (const part of spec.split(',')) {
    const token = part.trim().replace(/^\((.*)\)$/u, '$1').trim()
    if (token.length === 0) continue
    const match = /^(?:seqs?\s+)?(\d+)(?:\s*-\s*(\d+))?$/iu.exec(token)
    if (match === null) throw new RecallMissError(`invalid seq selection "${part}": expected "12", "3-7", "seq 12", or "seqs 3-7"`)
    const start = Number(match[1])
    const end = match[2] === undefined ? start : Number(match[2])
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end)) {
      throw new RecallMissError(`seq selection "${part}" is outside the safe integer range`)
    }
    if (end < start) throw new RecallMissError(`invalid seq range "${part}": the end comes before the start`)
    ranges.push({ start, end })
  }
  if (ranges.length === 0) throw new RecallMissError(`missing seq selection in "${spec}"`)
  return ranges
}

/**
 * Project the records at one seq selection.
 * @param session - the session whose log to read.
 * @param ref - the selection text.
 * @param maxTokens - the recall budget.
 * @returns the recalled entries.
 */
export function recallBySeq(session: Session, ref: string, maxTokens = DEFAULT_MAX_RECALL_TOKENS): RecallResult {
  const budget = recallBudget(maxTokens)
  const seqs: number[] = []
  const seen = new Set<number>()
  let bounded = false
  for (const { start, end } of parseSeqSpec(ref)) {
    // A range wider than the budget cannot be shown whole: a kept record costs
    // at least one token, so the walk stops there instead of enumerating it.
    bounded ||= end - start + 1 > budget
    for (let seq = start; seq <= end && seqs.length < budget; seq += 1) {
      if (seen.has(seq)) continue
      seen.add(seq)
      seqs.push(seq)
    }
    if (seqs.length >= budget) {
      bounded = true
      break
    }
  }
  if (seqs.length === 0) throw new RecallMissError(`missing seq selection in "${ref}"`)
  const recalled = recallSeqs(session, seqs, budget)
  if (!bounded) return recalled
  return {
    ...recalled,
    text: `${recalled.text}\n\n[the selection names more seq(s) than one recall call reads; `
      + 'call recall again for the remaining positions or raise max_tokens]',
    truncated: true,
  }
}

/**
 * Project the tool result at one result reference.
 * @param session - the session whose log to read.
 * @param ref - the `result N` pointer, `seq N` form, or bare seq.
 * @param maxTokens - the recall budget.
 * @returns the recalled entry.
 */
export function recallByResult(session: Session, ref: string, maxTokens = DEFAULT_MAX_RECALL_TOKENS): RecallResult {
  const budget = recallBudget(maxTokens)
  return recallSeqs(session, [resultSeqFor(session, ref)], budget)
}

/**
 * Project the checkpoint at one ordinal or `seq N` pointer.
 * @param session - the session whose log to read.
 * @param ref - the ordinal or pointer text.
 * @param maxTokens - the recall budget.
 * @returns the recalled entry.
 */
export function recallByCheckpoint(session: Session, ref: string, maxTokens = DEFAULT_MAX_RECALL_TOKENS): RecallResult {
  const budget = recallBudget(maxTokens)
  return recallSeqs(session, [checkpointSeqFor(session, ref)], budget)
}
