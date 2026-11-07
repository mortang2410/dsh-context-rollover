/**
 * The idle rollover candidate file. One durable record per session this feature
 * may fire: its last real activity time, its measured size, and its committed
 * rollover count. The file is the only source of candidates, so it is what
 * survives a host restart and what the sweep reads instead of the table of open
 * agents.
 *
 * A record is valid only when all five fields are present and well-typed. One
 * invalid record makes the whole file invalid: the store loads an empty set and
 * warns once per path for the lifetime of the process, so a file that stays
 * corrupt does not warn on every sweep. Writes are atomic: the full document
 * goes to `<path>.tmp`, is flushed, then renamed over the file, so a crash
 * before the rename leaves the previous file intact.
 *
 * @module dsh-context-rollover/candidates
 */

import type { Session } from '@deepseek-ai/dsh-session'
import { committedRollovers, lastRealActivityAt } from './epoch.ts'
import {
  closeSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeSync,
} from 'node:fs'
import { dirname } from 'node:path'

/** What happened to a candidate on its last observation. */
export type CandidateOutcome = 'marked' | 'blocked' | 'sent' | 'reopen-failed'

/** The four accepted `lastOutcome` values, in one place. */
export const CANDIDATE_OUTCOMES: readonly CandidateOutcome[] = ['marked', 'blocked', 'sent', 'reopen-failed']

/** One durable candidate record. */
export interface CandidateRecord {
  /** The host session id string. */
  readonly sessionId: string
  /** Millisecond time of the newest real activity, or null when the log holds load artifacts only. */
  readonly lastRealActivityAt: number | null
  /** The measured context size, never negative. */
  readonly totalTokens: number
  /** The committed rollover count read at the same moment as `totalTokens`. */
  readonly committedRolloverCount: number
  /** What happened to this candidate on its last observation. */
  readonly lastOutcome: CandidateOutcome
}

/** What the store needs to run. */
export interface CandidateStoreOptions {
  /** The absolute path of the candidate file. */
  readonly path: string
  /** Sink for the one warning a corrupt, invalid, or unwritable file produces per path. */
  readonly warn: (line: string) => void
}

/** The fixed prefix of every candidate-file warning. */
const WARNING_PREFIX = 'context rollover (candidates): the candidate file is unreadable'

/** Paths whose unreadable file already warned in this process. */
const warnedPaths = new Set<string>()

/** Paths whose failed write already warned in this process. */
const warnedWrites = new Set<string>()

/** Whether a value is a non-negative integer. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Whether a value is one of the four outcomes. */
function isOutcome(value: unknown): value is CandidateOutcome {
  return typeof value === 'string' && (CANDIDATE_OUTCOMES as readonly string[]).includes(value)
}

/**
 * Read one record from a parsed file value. A record is valid only when all five
 * fields are present, the id is a non-empty string, the activity time is null or
 * a finite number, both counts are non-negative integers, and the outcome is one
 * of the four strings.
 * @param value - one element of the file's `entries` array.
 * @returns the record, or undefined when the value is not a valid record.
 */
function parseRecord(value: unknown): CandidateRecord | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  const activity = record.lastRealActivityAt
  if (typeof record.sessionId !== 'string' || record.sessionId === '') return undefined
  if (activity !== null && (typeof activity !== 'number' || !Number.isFinite(activity))) return undefined
  if (!isCount(record.totalTokens) || !isCount(record.committedRolloverCount)) return undefined
  if (!isOutcome(record.lastOutcome)) return undefined
  return {
    sessionId: record.sessionId,
    lastRealActivityAt: activity,
    totalTokens: record.totalTokens,
    committedRolloverCount: record.committedRolloverCount,
    lastOutcome: record.lastOutcome,
  }
}

/** One candidate store over one file. */
export class CandidateStore {
  private readonly path: string
  private readonly warn: (line: string) => void
  private records: Map<string, CandidateRecord> | undefined

  /**
   * @param options - the file path and the warning sink.
   */
  constructor(options: CandidateStoreOptions) {
    this.path = options.path
    this.warn = options.warn
  }

  /** The path this store owns, for logging. */
  get filePath(): string {
    return this.path
  }

  /**
   * Every candidate, newest observation order of first appearance.
   * @returns the records currently held.
   */
  all(): readonly CandidateRecord[] {
    return [...this.load().values()]
  }

  /**
   * One candidate by session id.
   * @param sessionId - the session to read.
   * @returns the record, or undefined when the session is not a candidate.
   */
  get(sessionId: string): CandidateRecord | undefined {
    return this.load().get(sessionId)
  }

  /**
   * Insert or replace one record and write the file. The write is atomic, so a
   * crash before the rename leaves the previous file intact.
   * @param record - the record to store.
   */
  put(record: CandidateRecord): void {
    this.load().set(record.sessionId, record)
    this.persist()
  }

  /**
   * Drop one record and write the file. Removing a session that is not stored
   * writes nothing.
   * @param sessionId - the session to drop.
   */
  remove(sessionId: string): void {
    if (!this.load().delete(sessionId)) return
    this.persist()
  }

  /**
   * Read the file once and hold it in memory. A missing file is an empty set
   * with no warning. An unreadable or invalid file is an empty set and one
   * warning per path per process.
   * @returns the in-memory record map.
   */
  private load(): Map<string, CandidateRecord> {
    if (this.records !== undefined) return this.records
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (error: unknown) {
      this.records = new Map()
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.warnOnce(describe(error))
      return this.records
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch (error: unknown) {
      this.records = new Map()
      this.warnOnce(describe(error))
      return this.records
    }
    const entries = typeof parsed === 'object' && parsed !== null
      ? (parsed as { entries?: unknown }).entries
      : undefined
    if (!Array.isArray(entries)) {
      this.records = new Map()
      this.warnOnce('the document has no entries array')
      return this.records
    }
    const loaded = new Map<string, CandidateRecord>()
    for (const entry of entries) {
      const record = parseRecord(entry)
      if (record === undefined) {
        this.records = new Map()
        this.warnOnce('one entry is not a valid candidate record')
        return this.records
      }
      loaded.set(record.sessionId, record)
    }
    this.records = loaded
    return this.records
  }

  /**
   * Write the whole document through `<path>.tmp`, flush it, and rename it into
   * place.
   */
  private persist(): void {
    const document = `${JSON.stringify({ entries: [...this.load().values()] }, null, 2)}\n`
    const temporary = `${this.path}.tmp`
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const handle = openSync(temporary, 'w')
      try {
        writeSync(handle, document)
        fsyncSync(handle)
      } finally {
        closeSync(handle)
      }
      renameSync(temporary, this.path)
    } catch (error: unknown) {
      if (!warnedWrites.has(this.path)) {
        warnedWrites.add(this.path)
        this.warn(`context rollover (candidates): writing the candidate file failed: ${this.path}: ${describe(error)}`)
      }
    }
  }

  /** Emit the unreadable-file warning once per path for this process. */
  private warnOnce(reason: string): void {
    if (warnedPaths.has(this.path)) return
    warnedPaths.add(this.path)
    this.warn(`${WARNING_PREFIX}: ${this.path}: ${reason}`)
  }
}

/**
 * Observe one session and bring its candidate record up to date. A session that
 * measures at or below the floor leaves the file, and so does one whose
 * committed rollover count grew past the recorded count: that growth is a
 * rollover the record was written before. A subagent session is never a
 * candidate. The recorded activity time is the log-derived time, never the wall
 * clock at write, so a restart keeps the same idle clock.
 * @param store - the candidate file to update.
 * @param session - the session that was just measured.
 * @param totalTokens - its measured context size.
 * @param floor - the idle-rollover token minimum; a record needs to be strictly above it.
 * @returns nothing; the store is written when the record changes.
 */
export function markCandidate(
  store: CandidateStore,
  session: Session,
  totalTokens: number,
  floor: number,
): void {
  const { header } = session
  if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return
  const existing = store.get(session.id)
  const committedRolloverCount = committedRollovers(session).count
  if (existing !== undefined && committedRolloverCount > existing.committedRolloverCount) {
    store.remove(session.id)
    return
  }
  if (totalTokens <= floor) {
    if (existing !== undefined) store.remove(session.id)
    return
  }
  store.put({
    sessionId: session.id,
    lastRealActivityAt: lastRealActivityAt(session) ?? null,
    totalTokens,
    committedRolloverCount,
    lastOutcome: existing?.lastOutcome ?? 'marked',
  })
}

/** One error's readable message. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
