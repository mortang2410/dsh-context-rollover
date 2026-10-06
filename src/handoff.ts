/**
 * Handoff document resolution and reading.
 *
 * One module owns turning a model-supplied handoff path into the durable
 * handoff document's text, so `new_context` and the emergency scan cannot
 * disagree about what a usable handoff is. Two callers need two failure
 * behaviors over one rule:
 *
 * - {@link readHandoffFile} reports a failure as data, so an emergency scan can
 *   SKIP one unusable candidate instead of aborting the whole rollover;
 * - {@link readHandoffFileOrThrow} throws the same failure as an actionable
 *   error, so `new_context` can refuse inside its own `execute` and let the
 *   message reach the model as the tool result.
 *
 * The read is the whole contract: this module resolves exactly one named path
 * and reads it. It never lists or scans a directory (the emergency scan owns
 * that) and never touches a path the caller did not name.
 *
 * @module dsh-context-rollover/handoff
 */

import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

/** Why a handoff path could not be turned into usable document text. */
export type HandoffFailureReason =
  /** A relative path arrived with no session working directory to resolve it against. */
  | 'no-cwd'
  /** The caller supplied an empty or blank path. */
  | 'empty-path'
  /** Nothing exists at the resolved path. */
  | 'missing'
  /** The resolved path exists but is not a regular file (a directory, socket, FIFO, ...). */
  | 'not-a-file'
  /** The file exists but could not be read: permissions, a symlink loop, I/O. */
  | 'unreadable'
  /** The file read back empty or whitespace-only. */
  | 'empty'
  /** The file is longer than the configured character limit. */
  | 'too-large'

/** A refused handoff, carrying enough for a caller to act and to explain. */
export interface HandoffFailure {
  readonly ok: false
  readonly reason: HandoffFailureReason
  /** The absolute path the failure is about, when a path could be resolved. */
  readonly path: string | null
  /** One actionable sentence naming the cause; safe to show the model as-is. */
  readonly message: string
}

/** A successfully read handoff document. */
export interface HandoffSuccess {
  readonly ok: true
  /** The absolute path that was read. */
  readonly path: string
  /** The file's text, byte-for-byte as it is on disk, with no wrapper or trimming. */
  readonly text: string
}

/** The outcome of reading one handoff document. */
export type HandoffResult = HandoffSuccess | HandoffFailure

/** Input for one handoff read. */
export interface HandoffReadRequest {
  /** The model-supplied path: absolute, or relative to `cwd`. */
  readonly path: string
  /** The session working directory (`session.header.cwd`), an absolute path. */
  readonly cwd: string | undefined
  /** Maximum accepted document size in characters. */
  readonly maxChars: number
}

/**
 * The error {@link readHandoffFileOrThrow} throws: a real `Error` whose
 * `reason` lets a caller branch on the cause without matching message text.
 */
export class HandoffError extends Error {
  constructor(
    readonly reason: HandoffFailureReason,
    readonly path: string | null,
    message: string,
  ) {
    super(message)
    this.name = 'HandoffError'
  }
}

/**
 * Resolve a model-supplied handoff path to an absolute path.
 *
 * An absolute path is used as given. A relative path is resolved against the
 * session working directory, and a relative path with no session working
 * directory is refused rather than resolved against the process working
 * directory: the process directory is not the workspace the model was told to
 * write into, so guessing it would read a file the model never named.
 * @param path - the model-supplied path.
 * @param cwd - the session working directory, when the session has one.
 * @returns the resolved absolute path, or the refusal.
 */
function resolveHandoffPath(path: string, cwd: string | undefined): { ok: true; path: string } | HandoffFailure {
  if (path.trim().length === 0) {
    return {
      ok: false,
      reason: 'empty-path',
      path: null,
      message: 'handoff_path is empty; pass the path of the handoff document you wrote.',
    }
  }
  if (isAbsolute(path)) return { ok: true, path }
  if (cwd === undefined || cwd.trim().length === 0) {
    return {
      ok: false,
      reason: 'no-cwd',
      path: null,
      message:
        `handoff_path "${path}" is relative, but this session has no working directory to resolve it `
        + 'against. Pass an absolute path, or start the session in a workspace.',
    }
  }
  return { ok: true, path: resolve(cwd, path) }
}

/**
 * Resolve, validate, and read one handoff document. The single validation core
 * behind both public entry points.
 * @param request - the path, the session working directory, and the size limit.
 * @returns the document text, or a structured refusal naming the cause.
 */
export async function readHandoffFile(request: HandoffReadRequest): Promise<HandoffResult> {
  const resolved = resolveHandoffPath(request.path, request.cwd)
  if (resolved.ok === false) return resolved
  const path = resolved.path

  let info: Awaited<ReturnType<typeof stat>>
  try {
    // `stat` follows symlinks, so a symlink loop surfaces here as ELOOP rather
    // than as a decision about the link itself. Either way it is not readable.
    info = await stat(path)
  } catch (error: unknown) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return {
        ok: false,
        reason: 'missing',
        path,
        message: `no handoff document at ${path}; write it first (for example with /handoff-doc).`,
      }
    }
    return {
      ok: false,
      reason: 'unreadable',
      path,
      message: `cannot read the handoff path ${path}: ${describeError(error)}.`,
    }
  }
  if (!info.isFile()) {
    return {
      ok: false,
      reason: 'not-a-file',
      path,
      message: `${path} is not a regular file (a ${describeKind(info)}); pass the handoff document itself.`,
    }
  }

  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error: unknown) {
    return {
      ok: false,
      reason: 'unreadable',
      path,
      message: `cannot read the handoff document ${path}: ${describeError(error)}.`,
    }
  }

  if (text.trim().length === 0) {
    return {
      ok: false,
      reason: 'empty',
      path,
      message: `the handoff document ${path} is empty; a fresh context would start with no continuation state.`,
    }
  }
  if (text.length > request.maxChars) {
    return {
      ok: false,
      reason: 'too-large',
      path,
      message:
        `the handoff document ${path} is ${text.length} characters, over the ${request.maxChars}-character `
        + 'handoff limit; shorten it or raise handoffMaxChars.',
    }
  }
  return { ok: true, path, text }
}

/**
 * Read one handoff document, throwing on any refusal.
 *
 * This is the `new_context` entry point: it runs inside the tool's own
 * `execute`, where a thrown error becomes the tool result the model reads.
 * @param request - the path, the session working directory, and the size limit.
 * @returns the file's text, unchanged.
 * @throws {HandoffError} when the path cannot be turned into usable text.
 */
export async function readHandoffFileOrThrow(request: HandoffReadRequest): Promise<HandoffSuccess> {
  const result = await readHandoffFile(request)
  if (result.ok === false) throw new HandoffError(result.reason, result.path, result.message)
  return result
}

/** A one-line description of a path's kind, for a `not-a-file` refusal. */
function describeKind(info: { isDirectory(): boolean; isSymbolicLink(): boolean }): string {
  if (info.isDirectory()) return 'directory'
  if (info.isSymbolicLink()) return 'symbolic link'
  return 'special file'
}

/** A cause string for an I/O failure, preferring the OS code over a bare message. */
function describeError(error: unknown): string {
  const code = (error as NodeJS.ErrnoException).code
  const message = error instanceof Error ? error.message : String(error)
  return code === undefined ? message : `${code} (${message})`
}
