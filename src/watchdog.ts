/**
 * The idle rollover watchdog. One timer per host composition wakes the live
 * top-level sessions: a session that has been idle past the configured time,
 * with its context above the configured floor and below its own rollover point,
 * receives the configured message (`/rollover` by default) as a direct user
 * message. The model then writes its handoff and calls `new_context` as it
 * would after a typed command. The fire decision is {@link decideIdleFire}; this
 * module measures its inputs and sends.
 *
 * @module dsh-context-rollover/watchdog
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type { Session } from '@deepseek-ai/dsh-session'
import { sessionEvents } from './compat.ts'
import { rolloverPointsFor } from './config.ts'
import type { ResolvedRolloverConfig } from './config.ts'
import { armedFromLog } from './epoch.ts'
import { decideIdleFire, slashGestureNames } from './idle.ts'
import type { IdleFireInputs } from './idle.ts'

/** The host-wide claim on the agent registry: one watchdog timer per host composition. */
const CLAIM = Symbol.for('dsh-context-rollover.idle-watchdog')

/**
 * Sessions whose fire threw before its message was queued. The set lasts for the
 * process, so a send that always fails costs one warning instead of one per tick.
 */
const failedSessions = new Set<string>()

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
  if (scopeOf(ctx) !== undefined) {
    ctx.logger.info('context rollover (idle watchdog): this is a scoped composition, so no watchdog starts here')
    return
  }
  const registry = ctx.get('agents')
  if (registry === undefined) {
    ctx.logger.info('context rollover (idle watchdog): no agent registry is mounted, so no watchdog starts')
    return
  }
  const claims = registry as unknown as Record<symbol, unknown>
  let skillsAbsentLogged = false
  /** Set when the owning fiber unloads, so a sweep still waiting on a lookup sends nothing. */
  let disposed = false

  /**
   * Measure the decision inputs for one root agent. A candidate that is not
   * eligible at all (a subagent header, an empty log, no routed context window)
   * yields nothing and is skipped silently. The token measurement runs only for
   * an agent that is idle, has no queued work, and has been idle past the
   * threshold, so a busy session costs no measurement.
   * @param agent - a root agent of the registry.
   * @param skillAvailable - the skill check's result for this agent.
   * @returns the decision inputs, or undefined for an ineligible candidate.
   */
  const inputsFor = (agent: Agent, skillAvailable: boolean): IdleFireInputs | undefined => {
    const { session } = agent
    const { header } = session
    if (header.origin === 'subagent' || (header.delegationDepth ?? 0) > 0) return undefined
    const newest = sessionEvents(session).at(-1)
    if (newest === undefined) return undefined
    const route = options.routeOf(session)
    if (route?.contextWindow === undefined) return undefined
    const queuedWork = agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0
    const idleMs = Date.now() - newest.time
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
      rolloverPointTokens: rolloverPointsFor(serving.config, route.contextWindow, route.model).rolloverTokens,
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
        ctx.logger.info('context rollover (idle watchdog): no skills service is mounted, so no session is woken')
      }
      return false
    }
    const names = slashGestureNames(config.idleRolloverMessage)
    const summaries = await skills.list({ cwd: agent.session.header.cwd, scope: agent })
    return summaries.some(skill => names.includes(skill.name) && skill.invocation.userInvocable)
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
      ctx.logger.warn(`context rollover (idle watchdog): sending to session ${session.id} failed: ${reason}`)
      return
    }
    ctx.logger.info(`context rollover (idle watchdog): sent ${config.idleRolloverMessage} to session ${session.id}`)
  }

  /**
   * Decide one root agent. The cheap gates run first, and the skill lookup is
   * awaited only when those gates would fire. A sweep can be waiting on that
   * lookup while an earlier sweep fires or fails, so the disposal flag and the
   * failed-session set are read again after the await, and the decision is taken
   * again with no await between it and the send.
   * @param agent - a root agent of the registry.
   */
  const consider = async (agent: Agent): Promise<void> => {
    if (disposed || failedSessions.has(agent.session.id)) return
    const precheck = inputsFor(agent, true)
    if (precheck === undefined || !decideIdleFire(config, precheck).fire) return
    const skillAvailable = await skillResolves(agent)
    if (disposed || failedSessions.has(agent.session.id)) return
    const inputs = inputsFor(agent, skillAvailable)
    if (inputs === undefined || !decideIdleFire(config, inputs).fire) return
    fire(agent)
  }

  /**
   * One tick: every root agent, each isolated so one failure skips only that
   * session. The walk stops once the owning fiber has unloaded.
   */
  const sweep = async (): Promise<void> => {
    for (const agent of registry.roots()) {
      if (disposed) return
      try {
        await consider(agent)
      } catch (error: unknown) {
        const reason = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`context rollover (idle watchdog): skipped session ${agent.session.id} this tick: ${reason}`)
      }
    }
  }

  ctx.effect(() => {
    if (claims[CLAIM] !== undefined) {
      ctx.logger.info('context rollover (idle watchdog): another watchdog already holds this host, so none starts')
      return () => {}
    }
    claims[CLAIM] = true
    ctx.logger.info(
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
