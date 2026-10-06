# 03: Handoff file resolution with loud refusal

**What to build:** One module owns turning a model-supplied handoff path into the durable
handoff document's text. It resolves, validates and reads, and it refuses loudly rather than
returning an empty or partial document.

**Blocked by:** 01.

**Verify:** `pnpm test -- tests/handoff.spec.ts`

**Status:** ready-for-agent

- [ ] A handoff path may be absolute, or relative to the session working directory
      (`session.header.cwd`), and both resolve to the same file.
- [ ] A relative path with no session working directory is refused with a message naming that
      cause, rather than resolving against the process working directory.
- [ ] The resolved path must be a regular file. A directory, a missing file, a symlink loop or a
      permission failure each produce a distinct, actionable refusal.
- [ ] Empty or whitespace-only content is refused.
- [ ] Content larger than `handoffMaxChars` is refused with a message naming the limit and the
      actual size.
- [ ] Successful read returns the file text unchanged, with no added wrapper, preamble or
      markers.
- [ ] Test: each refusal case above asserts the specific failure, not merely that something
      threw.
- [ ] Test: a successful read returns byte-identical text to what was written to disk.
- [ ] Nothing in this module reads or writes any path the model did not name.
