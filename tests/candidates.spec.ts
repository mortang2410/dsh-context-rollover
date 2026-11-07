/**
 * The idle rollover candidate file: the durable record shape, the load and
 * atomic write rules, and the marking and removal rules that keep the file
 * equal to the sessions it describes.
 *
 * @module tests/candidates
 */

import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CompactionId } from '@deepseek-ai/dsh-compaction'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { CandidateStore, markCandidate } from '../src/candidates.ts'
import type { CandidateRecord } from '../src/candidates.ts'
import { resolveConfig } from '../src/config.ts'
import { committedRollovers, lastRealActivityAt } from '../src/epoch.ts'
import { ROLLOVER_PROVIDER } from '../src/rollover.ts'
import { closedConversation } from './harness.ts'

/** Candidate files written by this test file, removed after each case. */
const scratchDirs: string[] = []

afterEach(async () => {
  for (const dir of scratchDirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

/** A fresh directory that holds one test's candidate file. */
async function scratchPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-candidates-'))
  scratchDirs.push(dir)
  return join(dir, 'candidates.json')
}

/** A store over one path that collects its warnings. */
function storeAt(path: string): { store: CandidateStore; warnings: string[] } {
  const warnings: string[] = []
  return { store: new CandidateStore({ path, warn: line => { warnings.push(line) } }), warnings }
}

/** One valid record, so each case can vary the field it cares about. */
function record(overrides: Partial<CandidateRecord> = {}): CandidateRecord {
  return {
    sessionId: 'session-1',
    lastRealActivityAt: 1_700_000_000_000,
    totalTokens: 100_000,
    committedRolloverCount: 0,
    lastOutcome: 'marked',
    ...overrides,
  }
}

/** Append the `compaction/start` that opens a rollover transaction. */
function appendCompactionStart(session: Session, compactionId: CompactionId): void {
  session.append('compaction/start', { compactionId, turn: null })
}

/** Append this backend's `compaction/summary` for a transaction, shadowing the first surface node. */
function appendCompactionSummary(session: Session, compactionId: CompactionId): void {
  const first = session.surface.nodes[0]
  if (first === undefined) throw new Error('expected a surface node to shadow')
  session.append('compaction/summary', {
    compactionId,
    summary: [{ type: 'text', text: 'summary' }],
    shadowedRange: { start: first, end: first },
    shadowedSeqs: [first],
    shadowedTokenCount: 0,
    provider: ROLLOVER_PROVIDER,
    model: 'deterministic/window-1',
  })
}

/** Append one committed rollover transaction: start, this backend's summary, and a clean end. */
function appendCommittedRollover(session: Session): void {
  const compactionId = CompactionId(randomUUID())
  appendCompactionStart(session, compactionId)
  appendCompactionSummary(session, compactionId)
  session.append('compaction/end', { compactionId, turn: null })
}

/** A root session header, so a case can flip one field. */
function rootHeader(id: SessionId): SessionHeader {
  const header = closedConversation(1).header
  return { ...header, id, isSeeded: false }
}

describe('candidate store', () => {
  it('round-trips a record through a new store over the same file', async () => {
    const path = await scratchPath()
    const first = storeAt(path)
    first.store.put(record())

    const second = storeAt(path)
    expect(second.store.all()).toEqual([record()])
    expect(second.warnings).toEqual([])
  })

  it('reads a missing file as an empty set without a warning', async () => {
    const { store, warnings } = storeAt(await scratchPath())
    expect(store.all()).toEqual([])
    expect(warnings).toEqual([])
  })

  it('reads a corrupt file as an empty set and warns once per path', async () => {
    const path = await scratchPath()
    await writeFile(path, '{ not json', 'utf8')

    const first = storeAt(path)
    expect(first.store.all()).toEqual([])
    expect(first.warnings).toHaveLength(1)
    expect(first.warnings[0]).toContain('context rollover (candidates): the candidate file is unreadable')
    expect(first.warnings[0]).toContain(path)

    const second = storeAt(path)
    expect(second.store.all()).toEqual([])
    expect(second.warnings).toEqual([])
  })

  it('reads a file with one invalid record as an empty set', async () => {
    const path = await scratchPath()
    await writeFile(path, JSON.stringify({ entries: [record(), { sessionId: 'bad' }] }), 'utf8')

    const { store, warnings } = storeAt(path)
    expect(store.all()).toEqual([])
    expect(warnings).toHaveLength(1)
  })

  it('writes atomically and leaves no temporary file behind', async () => {
    const path = await scratchPath()
    const { store } = storeAt(path)
    store.put(record())

    expect(existsSync(`${path}.tmp`)).toBe(false)
    const written = JSON.parse(await readFile(path, 'utf8')) as { entries: CandidateRecord[] }
    expect(written.entries).toEqual([record()])
  })
})

describe('markCandidate', () => {
  it('marks a session above the floor with its log-derived activity time', async () => {
    const path = await scratchPath()
    const { store } = storeAt(path)
    const session = closedConversation(2)

    markCandidate(store, session, 100_000, 90_000)

    expect(store.get(session.id)).toEqual({
      sessionId: session.id,
      lastRealActivityAt: lastRealActivityAt(session) ?? null,
      totalTokens: 100_000,
      committedRolloverCount: 0,
      lastOutcome: 'marked',
    })
  })

  it('removes candidate at the idle floor', async () => {
    const path = await scratchPath()
    const { store } = storeAt(path)
    const session = closedConversation(2)
    markCandidate(store, session, 100_000, 90_000)
    expect(store.get(session.id)).toBeDefined()

    markCandidate(store, session, 90_000, 90_000)
    expect(store.get(session.id)).toBeUndefined()
  })

  it('removes candidate after a committed rollover', async () => {
    const path = await scratchPath()
    const { store } = storeAt(path)
    const session = closedConversation(2)
    markCandidate(store, session, 100_000, 90_000)
    expect(store.get(session.id)?.committedRolloverCount).toBe(0)

    appendCommittedRollover(session)
    expect(committedRollovers(session).count).toBe(1)
    markCandidate(store, session, 100_000, 90_000)
    expect(store.get(session.id)).toBeUndefined()
  })

  it('keeps the last outcome when an observation refreshes a record', async () => {
    const path = await scratchPath()
    const { store } = storeAt(path)
    const session = closedConversation(2)
    store.put(record({ sessionId: session.id, lastOutcome: 'sent' }))

    markCandidate(store, session, 120_000, 90_000)

    expect(store.get(session.id)?.lastOutcome).toBe('sent')
    expect(store.get(session.id)?.totalTokens).toBe(120_000)
  })

  it('never marks a subagent session', async () => {
    const path = await scratchPath()
    const { store } = storeAt(path)
    const id = SessionId(`subagent-${randomUUID()}`)
    const session = Session.create(id, [], { ...rootHeader(id), origin: 'subagent' })

    markCandidate(store, session, 200_000, 90_000)
    expect(store.all()).toEqual([])

    const deep = Session.create(id, [], { ...rootHeader(id), delegationDepth: 2 })
    markCandidate(store, deep, 200_000, 90_000)
    expect(store.all()).toEqual([])
  })
})

describe('candidate path', () => {
  it('defaults under the DSH home directory', () => {
    expect(resolveConfig({}).idleRolloverCandidatesPath).toBe(join(homedir(), '.dsh', 'idle-rollover-candidates.json'))
  })

  it('takes the configured path', () => {
    expect(resolveConfig({ idleRolloverCandidatesPath: '/tmp/candidates.json' }).idleRolloverCandidatesPath)
      .toBe('/tmp/candidates.json')
  })
})
