# Vendored compiler: upstream inventory and adaptations

`compiler.ts` is VCC 0.7.4's `src/compiler.js` typed and adapted to this fork.
Neither test below imports anything from the harness, and the vendored module
itself imports nothing at all; `tests/vendored-provenance.spec.ts` asserts that,
and `tests/vcc-compiler.spec.ts` asserts the upstream case inventory.

## Upstream (package `dsh-compaction-vcc@0.7.4`)

- project: <https://github.com/tingfeng-droid/dsh-compaction-vcc>
- licence: MIT, `package.json` line 70 and `LICENSE`, copied to `src/vcc/LICENSE`
- files carried: `src/compiler.js` (the module), `types/compiler.d.ts` (its
  declaration), and the compiler cases of `test/compiler.test.js`,
  `test/cap-notice.test.js`, `test/elide-sources.test.js`,
  `test/elide-checkpoint-bodies.test.js`, `test/malformed-nodes.test.js`
- source revision: the checkout the spec cites as `vcc/` in
  `/home/wilder/Trash/rollover-vcc-grill/`

Not carried: VCC's engine, settings namespace, preset rewrite, region and
read-back cores. Those are other modules (`src/vcc/project.ts`, `src/recall.ts`,
`src/search.ts`) or out of scope.

## Adaptations made in the copy

1. `src/compiler.js` became `src/vcc/compiler.ts` with JSDoc types moved into
   exported TypeScript interfaces (`CompileNode`, `CompileConfig`,
   `CompileEntry`, `CompileStats`, ...).
2. The node declaration extended where the host already goes beyond it:
   `CompileRole` accepts `tool`, and `CompileMessage` carries an optional
   `toolCallId`, because `Session.deriveEventMessage` derives a tool result that
   way.
3. The debug line tag changed from `[dsh-compaction-vcc]` to `[vcc-compiler]`.
   The sink call keeps upstream's guard, so a throwing sink never breaks a
   compile.
4. Pointer wording that was Chinese became English of the same meaning:
   the elided instruction-block pointer carries the row's `(seq N)`, and the
   snapshot-span pointer carries none, relying on the enclosing checkpoint row's
   `(seq N)` exactly as upstream does.
5. A tool result whose blocks are all images (a screenshot from an image tool)
   keeps upstream's excerpt row and gains an `[image] (seq N)` media row, so the
   view shows the label for an image it counts. The legacy user-role
   `tool-result` path counts its images too, so the tallies agree.
6. `parseToolArguments` accepts `undefined` as well as a string.
7. `isCheckpointSource`, `isElidableSource` and `projectToolResultText` take
   `unknown` inputs, matching the declaration's `unknown` parameters.
8. The helpers the read-back cores reuse (`estimateEntryTokens`,
   `projectToolResultText`, `truncateTokens`) are exported from the module, as
   upstream already declared them in `types/compiler.d.ts`.

## Test adaptation (settles skeleton uncertainty U2)

Upstream declares its cases with `node:test` and `node:assert/strict`. In
`tests/vcc-compiler.spec.ts` each `test(...)` is an `it(...)` inside one
`describe(...)`, `assert.equal` / `deepEqual` / `match` / `ok` / `throws`
became `expect` equivalents, and the exact expected values were kept. The
upstream case count (47) is pinned and every case runs, so a dropped case
fails. Cases marked `fork:` are new: the derived tool-result node shape, the
declaration extension, the read-back helpers, the media rows, the dropped-row
markers, the no-paraphrase proof, and the published defaults.
