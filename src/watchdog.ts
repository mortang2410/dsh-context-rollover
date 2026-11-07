/**
 * The idle rollover watchdog. One timer per host composition ticks two passes.
 * The marking pass walks the live root agents and writes the durable candidate
 * file: every session above the floor gets a record with its log-derived
 * activity time, and a record whose session fell to the floor or committed a
 * rollover leaves the file. The fire pass reads that file, never the table of
 * open agents, so the candidates are the same after a restart.
 *
 * A live candidate is decided and fired directly: a session that has been idle
 * past the configured time and carries a context above the configured floor
 * receives the configured message (`/rollover` by default) as a direct user
 * message. A candidate with no live agent is reopened first: its stored session
 * is loaded through the resume composition, decided against the live session,
 * sent to, and disposed again, so a restart does not lose the wake-up. The model
 * then writes its handoff and calls `new_context` as it would after a typed
 * command. The fire decision is {@link decideIdleFire}; this module measures its
 * inputs and sends.
 *
 * @module dsh-context-rollover/watchdog
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ResolvedRolloverConfig } from './config.ts'
import { armedFromLog } from './epoch.ts'
import { markCandidate } from './candidates.ts'
import type { CandidateRecord, CandidateStore } from './candidates.ts'
import { composeResume, isSessionNotFound } from './resume.ts'
import { committedRollovers, lastRealActivityAt } from './epoch.ts'
import { decideIdleFire, slashGestureNames } from './idle.ts'
import type { IdleFireInputs } from './idle.ts'

/** The host-wide claim on the agent registry: one watchdog timer per host composition. */
const CLAIM = Symbol.for('dsh-context-rollover.idle-watchdog')

/**
 * Sessions whose fire threw before its message was queued. The set lasts for the
 * process, so a send that always fails costs one warning instead of one per tick.
 */
const failedSessions = new Set<string>()

/** Sessions whose reopen task is in flight, so one sweep cannot open a session twice. */
const reopening = new Set<string>()

/** Sessions whose failed reopen already warned in this process. */
const warnedReopens = new Set<string>()

/** How long the reopen waits for the fired turn to finish. */
const REOPEN_TURN_TIMEOUT_MS = 10 * 60 * 1000

/** The part of a rollover engine that serves one session, as the watchdog reads it. */
export interface IdleServingEngine {
  /** The engine's resolved configuration, whose rollover point applies to the session. */
  readonly config: ResolvedRolloverConfig
  /** Whether the engine holds an accepted model-requested rollover for the session that is not yet committed. */
  hasPendingRollover(sessionId: string): boolean
}

/** What the engine supplies to the watchdog, because only the engine can answer these. */
export interface IdleWatchdogOptions {
  /** The resolved configuration of the host row: whether the watchdog is armed, and its thresholds. */
  readonly config: ResolvedRolloverConfig
  /** The durable candidate file the sweep refreshes before it fires. */
  readonly candidates: CandidateStore
  /** The routed model and context window that a session reports. */
  readonly routeOf: (session: Session) => ReturnType<Session['requestContext']>
  /** Whether a compaction backend other than this plugin's engine owns the agent's session. */
  readonly compactionOwnedByForeignEngine: (agent: Agent) => boolean
  /** The engine that serves the agent's session, whose rollover point and pending request decide the fire. */
  readonly servingEngineOf: (agent: Agent) => IdleServingEngine
}

/** One skill as the skills service summarizes it. */
interface SkillEntry {
  readonly name: string
  readonly invocation: { readonly userInvocable: boolean }
}

/** The part of the skills service the watchdog reads. */
interface SkillLookup {
  list(options: { cwd?: string | undefined; scope: Agent }): Promise<readonly SkillEntry[]>
}

/**
 * Start the idle watchdog for this composition. It starts nothing unless the
 * configuration arms it, the context is the host root (no scope key), and no
 * other watchdog holds the agent registry. The timer is created inside a context
 * effect, so unloading the owning plugin clears it and releases the claim.
 * @param ctx - the engine's own context.
 * @param options - the configuration and the three closures the engine supplies.
 * @returns nothing; the timer and the claim are owned by the context effect.
 */
export function startIdleWatchdog(ctx: Context, options: IdleWatchdogOptions): void {
  const { config } = options
  if (!config.idleRollover) return
  /**
   * Report one watchdog event to the operator. The line goes to the context
   * logger and to the console, because the host keeps logger messages in a
   * memory buffer with no stdout sink: a journal that records the host's console
   * would otherwise never show the armed line or a fire.
   * @param level - the logger method the line uses.
   * @param line - the message.
   */
  const report = (level: 'info' | 'warn', line: string): void => {
    if (level === 'warn') {
      ctx.logger.warn(line)
      console.warn(line)
      return
    }
    ctx.logger.info(line)
    console.info(line)
  }
  if (scopeOf(ctx) !== undefined) {
    report('info', 'context rollover (idle watchdog): this is a scoped composition, so no watchdog starts here')
    return
  }
  const registry = ctx.get('agents')
  if (registry === undefined) {
    report('info', 'context rollover (idle watchdog): no agent registry is mounted, so no watchdog starts')
    return
  }
  const claims = registry as unknown as Record<symbol, unknown>
  let skillsAbsentLogged = false
  /** Set when the owning fiber unloads, so a sweep still waiting on a lookup sends nothing. */
  let disposed = false
  /** Set while a sweep runs, so a tick that arrives during a slow skill lookup is skipped. */
  let sweeping = false

  /**
   * Measure the decision inputs for one root agent. A candidate that is not
   * eligible at all (a subagent header, an empty log, no routed context window)
   * yields nothing and is skipped silently. The token measurement runs only for
   * an agent that is idle, has no queued work, and has been idle past the
   * threshold, so a busy session costs no measurement.
   * @param agent - a root agent of the registry.
   * @param skillAvailable - the skill check's result for this agent.
   * @param activityAt - the candidate record's last real activity time.
   * @returns the decision inputs, or undefined for an ineligible candidate.
   */
  const inputsFor = (agent: Agent, skillAvailable: boolean, activityAt: number): IdleFireInputs | undefined => {
    const { session } = agent
    const { header } = session
    if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return undefined
    const route = options.routeOf(session)
    if (route?.contextWindow === undefined) return undefined
    const queuedWork = agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0
    const idleMs = Date.now() - activityAt
    const measured = agent.status === 'idle' && !queuedWork && idleMs >= config.idleRolloverAfterMs
    const measurement = measured ? ctx.tokenMeter.measure(session) : undefined
    const serving = options.servingEngineOf(agent)
    return {
      enabled: config.idleRollover,
      status: agent.status,
      queuedWork,
      idleMs,
      baselineKnown: measurement !== undefined && measurement.baseline.kind !== 'none',
      totalTokens: measurement?.totalTokens ?? 0,
      foreignBackendOwnsCompaction: options.compactionOwnedByForeignEngine(agent),
      newContextAvailable: ctx.tools.get('new_context', agent) !== undefined,
      skillAvailable,
      rolloverPending: serving.hasPendingRollover(session.id),
      epochArmed: armedFromLog(session, config.idleRolloverMessage),
    }
  }

  /**
   * Whether the skill named by the message's gesture is available to the agent.
   * With no skills service mounted the check fails closed: no skill body would be
   * injected, so the attempt is not spent, and one info line says so.
   * @param agent - the agent whose skill scope is consulted.
   * @returns true when a gesture names a user-invocable skill of a mounted service.
   */
  const skillResolves = async (agent: Agent): Promise<boolean> => {
    const skills = ctx.get('skills') as unknown as SkillLookup | undefined
    if (skills === undefined) {
      if (!skillsAbsentLogged) {
        skillsAbsentLogged = true
        report('info', 'context rollover (idle watchdog): no skills service is mounted, so no session is woken')
      }
      return false
    }
    const names = slashGestureNames(config.idleRolloverMessage)
    const summaries = await skills.list({ cwd: agent.session.header.cwd, scope: agent })
    return summaries.some(skill => names.includes(skill.name) && skill.invocation.userInvocable)
  }

  /**
   * Wait for one resumed agent to go idle, bounded. A turn that does not settle
   * within the bound is a failed reopen, not a session to keep waiting on.
   * @param agent - the resumed agent.
   * @param boundMs - the longest wait.
   * @returns 'idle' when the turn finished, 'timeout' when the bound expired.
   */
  const waitForIdle = async (agent: Agent, boundMs: number): Promise<'idle' | 'timeout'> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        agent.whenIdle().then(() => 'idle' as const),
        new Promise<'timeout'>(resolve => { timer = setTimeout(() => { resolve('timeout') }, boundMs) }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }
  }

  /**
   * Reopen one closed candidate, check the fire decision against the live
   * session, send, wait for the turn, and dispose. The idle duration comes from
   * the record, because a resumed log ends in the load artifacts just written;
   * the size and the route come from the live session. A refusal keeps the
   * record as blocked. A session that does not exist removes the record. Any
   * other failure keeps the record for a later sweep and warns once per session.
   * @param candidate - the record whose agent is not live.
   */
  const reopen = async (candidate: CandidateRecord): Promise<void> => {
    const sessionId = SessionId(candidate.sessionId)
    if (reopening.has(sessionId)) return
    reopening.add(sessionId)
    try {
      let composition: Awaited<ReturnType<typeof composeResume>>
      try {
        composition = await composeResume(ctx, sessionId, warning => { report('warn', warning) })
      } catch (error: unknown) {
        // The session query service reports a stored session that no longer
        // exists; a record for it is dead weight, so it leaves the file.
        if (isSessionNotFound(error)) {
          options.candidates.remove(candidate.sessionId)
          return
        }
        reopenFailed(candidate, error)
        return
      }
      if (composition === undefined) return
      let handle: { readonly agent: Agent; dispose(): Promise<void> } | undefined
      try {
        handle = await ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: composition.agentOptions,
          ...(composition.setup === undefined ? {} : { setup: composition.setup }),
        })
      } catch (error: unknown) {
        if (isSessionNotFound(error)) {
          options.candidates.remove(candidate.sessionId)
          return
        }
        reopenFailed(candidate, error)
        return
      }
      try {
        const { agent } = handle
        if (candidate.lastRealActivityAt === null) {
          options.candidates.put({ ...candidate, lastOutcome: 'blocked' })
          return
        }
        const skillAvailable = await skillResolves(agent)
        const inputs = inputsFor(agent, skillAvailable, candidate.lastRealActivityAt)
        const decision = inputs === undefined ? undefined : decideIdleFire(config, inputs)
        if (decision === undefined || !decision.fire) {
          options.candidates.put({ ...candidate, lastOutcome: 'blocked' })
          report('info', `context rollover (idle watchdog): reopened ${candidate.sessionId} and sent nothing: ${decision === undefined ? 'no decision inputs' : decision.reason}`)
          return
        }
        try {
          agent.followup(createUserMessage({
            content: [{ type: 'text', text: config.idleRolloverMessage }],
            source: { kind: 'user' },
          }))
        } catch (error: unknown) {
          reopenFailed(candidate, error)
          return
        }
        report('info', `context rollover (idle watchdog): sent ${config.idleRolloverMessage} to reopened session ${candidate.sessionId}`)
        let outcome: 'idle' | 'timeout'
        try {
          outcome = await waitForIdle(agent, REOPEN_TURN_TIMEOUT_MS)
        } catch (error: unknown) {
          // The resumed turn failed; the record stays for a later sweep.
          reopenFailed(candidate, error)
          return
        }
        if (outcome === 'timeout') {
          reopenFailed(candidate, new Error(`the turn did not finish within ${REOPEN_TURN_TIMEOUT_MS} ms`))
          return
        }
        const measured = ctx.tokenMeter.measure(agent.session)
        const count = committedRollovers(agent.session).count
        if (count > candidate.committedRolloverCount || measured.totalTokens <= config.idleRolloverTokens) {
          options.candidates.remove(candidate.sessionId)
          return
        }
        options.candidates.put({
          ...candidate,
          lastRealActivityAt: lastRealActivityAt(agent.session) ?? candidate.lastRealActivityAt,
          totalTokens: measured.totalTokens,
          committedRolloverCount: count,
          lastOutcome: 'sent',
        })
      } finally {
        await handle.dispose()
      }
    } finally {
      reopening.delete(sessionId)
    }
  }

  /**
   * Record and report one failed reopen. The warning is one per session per host
   * process; the record stays so a later sweep may retry it.
   * @param candidate - the record that failed.
   * @param error - the failure.
   */
  const reopenFailed = (candidate: CandidateRecord, error: unknown): void => {
    const reason = error instanceof Error ? error.message : String(error)
    options.candidates.put({ ...candidate, lastOutcome: 'reopen-failed' })
    if (warnedReopens.has(candidate.sessionId)) return
    warnedReopens.add(candidate.sessionId)
    report('warn', `context rollover (idle watchdog): reopening session ${candidate.sessionId} failed: ${reason}`)
  }

  /**
   * Send the configured message into the session. The send is synchronous, so the
   * epoch guard reads the splice on the next tick. A send that throws before its
   * message is queued is remembered for the process, so it is not retried.
   * @param agent - the agent to wake.
   */
  const fire = (agent: Agent): void => {
    const { session } = agent
    const before = session.seq
    try {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text: config.idleRolloverMessage }],
        source: { kind: 'user' },
      }))
    } catch (error: unknown) {
      if (session.seq === before) failedSessions.add(session.id)
      const reason = error instanceof Error ? error.message : String(error)
      report('warn', `context rollover (idle watchdog): sending to session ${session.id} failed: ${reason}`)
      return
    }
    report('info', `context rollover (idle watchdog): sent ${config.idleRolloverMessage} to session ${session.id}`)
  }

  /**
   * Decide one root agent. The cheap gates run first, and the skill lookup is
   * awaited only when those gates would fire. The second decision re-evaluates
   * every gate against the state after the await, with no await between it and
   * the send, and the disposal flag and the failed-session set are read in that
   * pass too. With one sweep in flight no other send can run during the await,
   * so the failed-session read cannot change the outcome today. It stays because
   * it costs nothing, and it keeps a later change to the sweep serialization from
   * sending to a session whose send already failed.
   * @param agent - a root agent of the registry.
   * @param activityAt - the candidate record's last real activity time.
   */
  const consider = async (agent: Agent, activityAt: number): Promise<void> => {
    if (disposed || failedSessions.has(agent.session.id)) return
    const precheck = inputsFor(agent, true, activityAt)
    if (precheck === undefined || !decideIdleFire(config, precheck).fire) return
    const skillAvailable = await skillResolves(agent)
    if (disposed || failedSessions.has(agent.session.id)) return
    const inputs = inputsFor(agent, skillAvailable, activityAt)
    if (inputs === undefined || !decideIdleFire(config, inputs).fire) return
    fire(agent)
  }

  /**
   * One tick: every root agent, each isolated so one failure skips only that
   * session. At most one sweep runs at a time: a tick that arrives while a sweep
   * still awaits a skill lookup is skipped, so a slow lookup cannot stack
   * concurrent lookups. The walk stops once the owning fiber has unloaded. The
   * flag is cleared in a finally, because an error that escapes the walk (the
   * registry read sits outside the per-session isolation) must not leave the
   * watchdog skipping every later tick.
   */
  const sweep = async (): Promise<void> => {
    if (sweeping) return
    sweeping = true
    try {
      // Marking pass: every live root that measures above the floor is recorded,
      // and a record whose session fell to the floor or grew a committed rollover
      // leaves the file. This pass never fires; it only keeps the file equal to
      // the sessions it describes.
      for (const agent of registry.roots()) {
        if (disposed) return
        try {
          markCandidate(
            options.candidates,
            agent.session,
            ctx.tokenMeter.measure(agent.session).totalTokens,
            config.idleRolloverTokens,
          )
        } catch (error: unknown) {
          const reason = error instanceof Error ? error.message : String(error)
          report('warn', `context rollover (idle watchdog): skipped session ${agent.session.id} this tick: ${reason}`)
        }
      }
      // Fire pass: the candidate file is the only source of candidates. A live
      // candidate is decided and fired; a candidate with no live agent is left to
      // the reopen path.
      for (const candidate of options.candidates.all()) {
        if (disposed) return
        const agent = registry.get(SessionId(candidate.sessionId))
        if (agent !== undefined && reopening.has(SessionId(candidate.sessionId))) continue
        if (agent === undefined) {
          // Resume only a record that has already been idle long enough to
          // fire; a recent one cannot pass the decision, and a resume per tick
          // would pay a session load for a refusal the record already answers.
          const loaded = ctx.sessions.get(SessionId(candidate.sessionId))
          const idleMs = candidate.lastRealActivityAt === null
            ? undefined
            : Date.now() - candidate.lastRealActivityAt
          if (loaded === undefined && idleMs !== undefined && idleMs >= config.idleRolloverAfterMs) {
            void reopen(candidate).catch((error: unknown) => {
              const reason = error instanceof Error ? error.message : String(error)
              report('warn', `context rollover (idle watchdog): reopening session ${candidate.sessionId} threw: ${reason}`)
            })
          }
          continue
        }
        try {
          if (candidate.lastRealActivityAt !== null) await consider(agent, candidate.lastRealActivityAt)
        } catch (error: unknown) {
          const reason = error instanceof Error ? error.message : String(error)
          report('warn', `context rollover (idle watchdog): skipped session ${candidate.sessionId} this tick: ${reason}`)
        }
      }
    } finally {
      sweeping = false
    }
  }

  ctx.effect(() => {
    if (claims[CLAIM] !== undefined) {
      report('info', 'context rollover (idle watchdog): another watchdog already holds this host, so none starts')
      return () => {}
    }
    claims[CLAIM] = true
    report(
      'info',
      'context rollover (idle watchdog): armed; a session idle for '
      + `${config.idleRolloverAfterMs} ms above ${config.idleRolloverTokens} tokens is woken, `
      + `checked every ${config.idleRolloverTickMs} ms`,
    )
    const timer = setInterval(() => { void sweep() }, config.idleRolloverTickMs)
    timer.unref()
    return () => {
      disposed = true
      clearInterval(timer)
      delete claims[CLAIM]
    }
  })
}
