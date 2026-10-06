# 03: Handoff file resolution with loud refusal

**What to build:** One module owns turning a model-supplied handoff path into the durable
handoff document's text. It resolves, validates and reads, and it refuses loudly rather than
returning an empty or partial document.

**Blocked by:** 01.

**Note for the implementer:** this module is called from `new_context`'s `execute` for the
explicit path, and from the emergency scan in ticket 05. Ticket 05 needs a variant that reports
whether a candidate is usable WITHOUT throwing, so a candidate that fails can be skipped rather
than aborting the emergency rollover. Design the module so both callers are served; a throwing
read plus a non-throwing probe that share one validation core is the smallest shape that does it.

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
- [ ] The read happens inside `new_context`'s own `execute`, so a refusal is thrown where it
      becomes the tool result the MODEL reads. Do not defer the read to the engine's pre-step
      path: that path catches every failure into `ctx.logger.warn` (`src/index.ts:180-183`), so a
      deferred refusal would silently leave the context unchanged while the model believed the
      rollover had happened.
- [ ] Test: each refusal case above asserts the specific failure, not merely that something
      threw.
- [ ] Test: a successful read returns byte-identical text to what was written to disk.
- [ ] Nothing in this module reads or writes any path the model did not name.
