/**
 * Structured-handoff checkpoint render: the newest valid handoff note comes
 * first and is selected by name, older handoff notes are left out, the budget
 * cuts the snapshot, and upstream mode keeps the upstream render. The last
 * tests drive a manual rollover through the engine to prove the resolved mode
 * reaches the checkpoint call site.
 *
 * @module tests/structured-handoff.spec
 */

import { mkdtemp, rm, utimes } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isHandoffNotePath, NotesStore } from '../src/notes.ts'
import { countRollovers } from '../src/rollover.ts'
import {
  derivedTexts,
  engineHarness,
  followup,
  newContextCall,
  ScriptedAdapter,
  seedExchanges,
  textResponse,
} from './harness.ts'

const cleanup: Array<() => Promise<void>> = []

afterEach(async () => {
  while (cleanup.length > 0) {
    const dispose = cleanup.pop()
    if (dispose !== undefined) await dispose()
  }
})

/** A store rooted at a fresh temp directory. */
async function tempStore(): Promise<NotesStore> {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-rollover-handoff-'))
  cleanup.push(() => rm(dir, { recursive: true, force: true }))
  return new NotesStore(dir)
}

/** Base instant for pinned modification times, in epoch milliseconds. */
const BASE = Date.UTC(2026, 9, 10, 12, 0, 0)

/** A modification time `minutes` after the base, so ordering never depends on the clock. */
function at(minutes: number): Date {
  return new Date(BASE + minutes * 60_000)
}

/** Write one note and pin its modification time. */
async function writeNote(store: NotesStore, path: string, text: string, minutes: number): Promise<void> {
  await store.write(path, text)
  await utimes(join(store.root, path), at(minutes), at(minutes))
}

const OLDER = 'HANDOFF-2026-10-09-09-15-first.md'
const NEWER = 'HANDOFF-2026-10-10-14-30-second.md'

describe('isHandoffNotePath', () => {
  it.each([
    ['HANDOFF-2026-10-10-14-30-task.md', true],
    ['HANDOFF-2026-10-10-23-59-task.md', true],
    ['HANDOFF-2000-02-29-00-00-task.md', true],
    ['HANDOFF-2028-02-29-10-00-task.md', true],
    ['HANDOFF-2026-02-29-10-00-task.md', false],
    ['HANDOFF-1900-02-29-10-00-task.md', false],
    ['HANDOFF-2026-02-30-10-00-task.md', false],
    ['HANDOFF-2026-04-31-10-00-task.md', false],
    ['HANDOFF-2026-13-40-10-61-task.md', false],
    ['HANDOFF-2026-13-40-10-30-task.md', false],
    ['HANDOFF-2026-00-10-10-10-task.md', false],
    ['HANDOFF-2026-10-10-24-00-task.md', false],
    ['HANDOFF-2026-10-10-14-60-task.md', false],
    ['HANDOFF-2026-10-10-14-30-Task.md', false],
    ['HANDOFF-2026-10-10-14-30-.md', false],
    ['HANDOFF-2026-10-10-14-30-task.txt', false],
    ['plans/HANDOFF-2026-10-10-14-30-task.md', false],
    ['handoff-2026-10-10-14-30-task.md', false],
  ])('%s is a handoff note: %s', (name, expected) => {
    expect(isHandoffNotePath(name)).toBe(expected)
  })
})

describe('NotesStore.renderCheckpoint in structured-handoff mode', () => {
  it('renders only the newest valid handoff note, and first', async () => {
    const store = await tempStore()
    await writeNote(store, OLDER, 'OLDER BODY', -10)
    await writeNote(store, NEWER, 'NEWER BODY', 0)
    await writeNote(store, 'state.md', 'STATE BODY', 5)
    expect(await store.renderCheckpoint(1000, 'structured-handoff')).toBe(
      `### ${NEWER}\nNEWER BODY\n\n### state.md\nSTATE BODY`,
    )
  })

  it('selects the newest handoff by name, not by modification time', async () => {
    const store = await tempStore()
    // The newer name is written first; the older name is then modified later.
    await writeNote(store, NEWER, 'NEWER BODY', 0)
    await store.write(OLDER, 'OLDER BODY')
    await utimes(join(store.root, OLDER), at(60), at(60))
    // The older handoff is modified later but is not a candidate, and it is not rendered.
    expect(await store.renderCheckpoint(1000, 'structured-handoff')).toBe(`### ${NEWER}\nNEWER BODY`)
  })

  it('leaves older handoff notes out of the snapshot', async () => {
    const store = await tempStore()
    await writeNote(store, 'HANDOFF-2026-10-08-08-00-oldest.md', 'ANCIENT BODY', 30)
    await writeNote(store, OLDER, 'OLDER BODY', 20)
    await writeNote(store, NEWER, 'NEWER BODY', 0)
    expect(await store.renderCheckpoint(1000, 'structured-handoff')).toBe(
      `### ${NEWER}\nNEWER BODY`,
    )
  })

  it('does not select a name that matches the shape but is not a real date', async () => {
    const store = await tempStore()
    await writeNote(store, OLDER, 'VALID BODY', 0)
    // Invalid by calendar only (month 13, day 40), so only the date check rejects it.
    await writeNote(store, 'HANDOFF-2026-13-40-10-30-task.md', 'IMPOSSIBLE BODY', 60)
    await writeNote(store, 'a.md', 'A BODY', 30)
    // The impossible name renders in upstream order, after the valid handoff.
    expect(await store.renderCheckpoint(1000, 'structured-handoff')).toBe(
      `### ${OLDER}\nVALID BODY\n\n### HANDOFF-2026-13-40-10-30-task.md\nIMPOSSIBLE BODY\n\n### a.md\nA BODY`,
    )
  })

  it('does not select a handoff-like name in a subfolder', async () => {
    const store = await tempStore()
    await writeNote(store, OLDER, 'VALID BODY', 0)
    await writeNote(store, 'plans/HANDOFF-2026-10-10-14-30-task.md', 'SUBFOLDER BODY', 10)
    await writeNote(store, 'b.md', 'B BODY', 20)
    expect(await store.renderCheckpoint(1000, 'structured-handoff')).toBe(
      `### ${OLDER}\nVALID BODY\n\n### b.md\nB BODY\n\n### plans/HANDOFF-2026-10-10-14-30-task.md\nSUBFOLDER BODY`,
    )
  })

  it('cuts an over-budget handoff at the budget with no marker and drops the other notes', async () => {
    const store = await tempStore()
    await writeNote(store, NEWER, 'x'.repeat(300), 0)
    await writeNote(store, 'other.md', 'OTHER BODY', 5)
    const header = `### ${NEWER}\n`
    expect(await store.renderCheckpoint(200, 'structured-handoff')).toBe(
      `${header}${'x'.repeat(200 - header.length)}`,
    )
  })

  it('cuts the note that crosses the budget and drops every note after it', async () => {
    const store = await tempStore()
    await writeNote(store, NEWER, 'h'.repeat(20), 0)
    await writeNote(store, 'middle.md', 'm'.repeat(500), 10)
    await writeNote(store, 'last.md', 'l'.repeat(10), 5)
    // The handoff section uses 59 characters and the middle header 14, so
    // 27 characters of the middle body fit in a 100-character budget.
    const snapshot = await store.renderCheckpoint(100, 'structured-handoff')
    expect(snapshot).toContain(`### middle.md\n${'m'.repeat(27)}`)
    expect(snapshot).not.toContain('m'.repeat(28))
    expect(snapshot).not.toContain('last.md')
    expect(snapshot).not.toContain('l'.repeat(10))
  })

  it('renders upstream order with no handoff first when no handoff note is valid', async () => {
    const store = await tempStore()
    await writeNote(store, 'a.md', 'A BODY', 0)
    await writeNote(store, 'HANDOFF-2026-13-40-10-30-task.md', 'INVALID BODY', 10)
    await writeNote(store, 'b.md', 'B BODY', 20)
    const snapshot = await store.renderCheckpoint(1000, 'structured-handoff')
    expect(snapshot).toBe(
      '### b.md\nB BODY\n\n### HANDOFF-2026-13-40-10-30-task.md\nINVALID BODY\n\n### a.md\nA BODY',
    )
    expect(snapshot).toBe(await store.renderAll(1000))
  })

  it('returns null when the store is empty', async () => {
    const store = await tempStore()
    expect(await store.renderCheckpoint(1000, 'structured-handoff')).toBeNull()
  })
})

describe('NotesStore.renderCheckpoint in upstream mode', () => {
  it('renders the upstream snapshot unchanged, with the older handoff included', async () => {
    const store = await tempStore()
    await writeNote(store, OLDER, 'OLDER BODY', 0)
    await writeNote(store, NEWER, 'NEWER BODY', 10)
    await writeNote(store, 'state.md', 'STATE BODY', 20)
    expect(await store.renderCheckpoint(1000, 'upstream')).toBe(
      `### state.md\nSTATE BODY\n\n### ${NEWER}\nNEWER BODY\n\n### ${OLDER}\nOLDER BODY`,
    )
  })

  it('matches renderAll for the same contents at every budget', async () => {
    const store = await tempStore()
    await writeNote(store, OLDER, 'OLDER BODY', 0)
    await writeNote(store, NEWER, 'NEWER BODY', 10)
    await writeNote(store, 'state.md', 'STATE BODY', 20)
    for (const budget of [1000, 100, 30]) {
      expect(await store.renderCheckpoint(budget, 'upstream')).toBe(await store.renderAll(budget))
    }
  })
})

describe('rollover through the engine', () => {
  it('carries only the newest handoff, first, under structured-handoff', async () => {
    const { ctx, engine, agent, session, notesBase } = await engineHarness('structured-manual', {
      mode: 'structured-handoff',
    })
    const store = new NotesStore(NotesStore.directoryFor(session.id, notesBase))
    await writeNote(store, OLDER, 'OLDER BODY', 0)
    await writeNote(store, NEWER, 'NEWER BODY', 10)
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter(
      Array.from({ length: 20 }, (_unused, index) => textResponse(`investigation step ${index} result`)),
    ))
    await seedExchanges(agent, 20)

    const compacted = await engine.compactNow(agent, new AbortController().signal)
    expect(compacted).not.toBeNull()
    const texts = derivedTexts(session).join('\n')
    expect(texts).toContain(`## Durable notes\n### ${NEWER}\nNEWER BODY`)
    expect(texts).not.toContain(OLDER)
  })

  it('keeps the older handoff in the checkpoint under upstream', async () => {
    const { ctx, engine, agent, session, notesBase } = await engineHarness('upstream-manual', {
      mode: 'upstream',
    })
    const store = new NotesStore(NotesStore.directoryFor(session.id, notesBase))
    await writeNote(store, OLDER, 'OLDER BODY', 0)
    await writeNote(store, NEWER, 'NEWER BODY', 10)
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter(
      Array.from({ length: 20 }, (_unused, index) => textResponse(`investigation step ${index} result`)),
    ))
    await seedExchanges(agent, 20)

    const compacted = await engine.compactNow(agent, new AbortController().signal)
    expect(compacted).not.toBeNull()
    expect(derivedTexts(session).join('\n')).toContain(`### ${OLDER}\nOLDER BODY`)
  })

  it('carries only the newest handoff, first, on a model-requested rollover under structured-handoff', async () => {
    const { ctx, agent, session, notesBase } = await engineHarness('structured-model', {
      mode: 'structured-handoff',
    })
    const store = new NotesStore(NotesStore.directoryFor(session.id, notesBase))
    await writeNote(store, OLDER, 'OLDER BODY', 0)
    await writeNote(store, NEWER, 'NEWER BODY', 10)
    ctx.llm.registerAdapter(['mock'], new ScriptedAdapter([
      ...Array.from({ length: 20 }, (_unused, index) => textResponse(`finding ${index} details`)),
      newContextCall('{"handoff":"Implement the notes next steps."}'),
      textResponse('implementing now'),
    ]))
    await seedExchanges(agent, 20)
    await followup(agent, 'Research is done; roll over and implement.')

    expect(countRollovers(session)).toBe(1)
    const texts = derivedTexts(session).join('\n')
    expect(texts).toContain(`## Durable notes\n### ${NEWER}\nNEWER BODY`)
    expect(texts).not.toContain(OLDER)
  })
})
