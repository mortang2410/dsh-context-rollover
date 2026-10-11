#!/usr/bin/env node
/**
 * Regenerate the shipped `standard-rollover` agent preset from the running
 * host's own shipped `standard` declaration, swapping only the compaction
 * engine row.
 *
 * The running host (DSH 0.2.0-rc.2) declares a preset as a
 * `@deepseek-ai/dsh-agent-preset` row carrying an inline `config.plugins`
 * array inside a `.patch.yml` file, listed in the bundle's `dsh.bundle.patch`
 * array (`dsh-web-app/presets/standard.patch.yml`). That is the format this
 * script transforms: it reads the host's declaration, restamps the preset
 * identity, and replaces the `compaction-basic` row inside the preset's own
 * `compaction` isolate group with this engine.
 *
 * Maintainer tooling (`pnpm preset:sync`), not a user command: Web users get
 * the preset because this bundle lists the generated
 * `presets/standard-rollover/declaration.patch.yml` in its own
 * `dsh.bundle.patch`. Re-run after host updates and commit the refreshed
 * `presets/` directory.
 *
 * Plain Node with no dependencies. The transform keeps every other byte of
 * the host's declaration identical and fails loud when the shipped shape
 * drifts, because an unmatched YAML patch only WARNS and is skipped
 * (`dsh-app-boot` `applyEntryPatches`, messages `patch: entry %C not found` /
 * `patch insert: entry %C not found`): a shape this script mis-reads would
 * install, boot clean, and do nothing at all.
 *
 * Usage:
 *   node scripts/make-web-preset.mjs [--presets-dir <dir>] [--out-dir <dir>]
 *     [--preset-id <id>] [--engine-name <specifier>]
 *     [--threshold-ratio <n>] [--reminder-ratio <n>]
 *     [--reminder-message <text>] [--handoff-dir <dir>]
 *     [--handoff-pattern <glob>]
 *     [--retain-tokens <n> | --retain-ratio <n>] [--handoff-max-chars <n>]
 *     [--handoff-only <true|false>]
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The host's shipped declaration this preset derives from by default. */
const SOURCE_PRESET = 'standard'

/**
 * Per-source identity anchors: the Loader row id, the preset id inside the
 * declaration, and the display metadata the generated preset carries.
 *
 * `cordis` derives Creator Mode: its tool list adds `tool-cordis` and the
 * preset-authoring skill directory, and its roster position is 4, so a
 * cordis-derived preset must restate those rather than inherit standard's.
 */
const SOURCE_PRESETS = {
  standard: {
    rowId: 'preset-standard',
    presetId: 'standard',
    order: 1,
    meta: {
      name: 'Standard + rollover (experimental)',
      description: 'Full coding agent with model-driven context rollover instead of summarization '
        + '(generated from the host standard preset). Experimental opt-in; standard remains the default.',
      order: 2,
    },
  },
  cordis: {
    rowId: 'preset-cordis',
    presetId: 'cordis',
    order: 4,
    meta: {
      name: 'Local Cordis',
      description: 'Creator Mode with model-driven context rollover instead of summarization '
        + '(generated from the host cordis preset). Keeps the Creator Mode tools and skills.',
      order: 5,
    },
  },
}

/** Default id of the generated preset. */
const DEFAULT_PRESET_ID = 'standard-rollover'

/**
 * The shipped handoff reminder text. Mirrors `DEFAULT_REMINDER_MESSAGE` in
 * `src/config.ts`: this script is plain Node with no build step, so it cannot
 * import that module, and a generated preset that omitted the message would
 * silently drop back to whatever default the engine happened to carry.
 */
const DEFAULT_REMINDER_MESSAGE = 'Context is {percent}% full. Use `/handoff-doc` to create/update the durable '
  + 'handoff document. Make it fully sufficient for a fresh context to continue the work. After it succeeds, '
  + 'call `new_context`. The handoff document, plus any recent chat kept after the rollover, will be the '
  + 'continuation context.'

/** Handoff defaults, mirroring `DEFAULT_HANDOFF_DIR`/`DEFAULT_HANDOFF_PATTERN` in `src/config.ts`. */
const DEFAULT_HANDOFF_DIR = '.scratch/handoff'
const DEFAULT_HANDOFF_PATTERN = 'HANDOFF-*.md'

/** Directory names must stay path-contained; mirrors the harness preset rule. */
const PRESET_ID = /^[a-z0-9][a-z0-9-]*$/

/**
 * The shipped `compaction` group header, verbatim.
 *
 * The engine must publish inside this group's `isolate` realm: without one it
 * would register `ctx.compaction` in the root realm, where the registry
 * rejects the mount as a leaked service (`mountPreset` ->
 * `leakedServices`). Matching the block verbatim is also what makes a host
 * shape change loud instead of silently re-scoping the engine row.
 */
const COMPACTION_GROUP = '          - id: compaction\n'
  + '            name: cordis:group\n'
  + '            group: true\n'
  + '            isolate:\n'
  + '              compaction: true\n'
  + '              toolResultPruner: true\n'

/**
 * Candidate roots holding the host's shipped declaration
 * (`<root>/standard.patch.yml`): explicit `--presets-dir` first, then the
 * checked-in fixture this repo owns.
 *
 * `tests/fixtures/host/standard.patch.yml` is a byte-for-byte copy of the
 * running host's own declaration, so the sync is reproducible without the
 * installed host or the sibling checkout.
 * @param presetsDir - value of `--presets-dir`, when given.
 * @returns candidate preset-root directories, nearest first.
 */
export function candidatePresetRoots(presetsDir) {
  if (presetsDir !== undefined) return [resolve(presetsDir)]
  return [join(packageDir, 'tests', 'fixtures', 'host')]
}

/**
 * Resolve one source entry by preset id.
 * @param source - source preset id.
 * @returns the source's identity anchors and display metadata.
 * @throws when the id is not a known source, because an unknown source would
 *   silently derive from the wrong declaration or produce a preset with the
 *   wrong row id.
 */
export function resolveSource(source) {
  const entry = SOURCE_PRESETS[source]
  if (entry === undefined) {
    throw new Error(
      `make-web-preset: unknown --source-preset ${JSON.stringify(source)}; `
      + `known sources: ${Object.keys(SOURCE_PRESETS).join(', ')}`,
    )
  }
  return entry
}

/**
 * Find the host declaration the preset derives from.
 * @param presetsDir - value of `--presets-dir`, when given.
 * @param source - source preset id.
 * @returns the absolute declaration file path.
 * @throws when no candidate supplies the source declaration.
 */
export function findSourcePreset(presetsDir, source = SOURCE_PRESET) {
  const tried = []
  for (const root of candidatePresetRoots(presetsDir)) {
    const file = join(root, `${source}.patch.yml`)
    tried.push(file)
    if (existsSync(file)) return file
  }
  throw new Error(
    `make-web-preset: no "${source}" declaration found; tried ${tried.join(', ')}. `
    + `Pass --presets-dir <dir> holding <dir>/${source}.patch.yml`,
  )
}

/**
 * Validate the numeric engine configuration and the text values, mirroring the
 * engine's own rules so a bad flag fails here instead of at session start.
 * @param config - raw options.
 * @returns the validated options.
 * @throws on any out-of-range, blank, or misspelled value.
 */
export function resolveOptions(config) {
  const thresholdRatio = config.thresholdRatio ?? 0.9
  const reminderRatio = config.reminderRatio ?? 0.4
  const handoffMaxChars = config.handoffMaxChars ?? 20000
  for (const [name, value] of [['threshold-ratio', thresholdRatio], ['reminder-ratio', reminderRatio]]) {
    if (!Number.isFinite(value) || value <= 0 || value > 1) {
      throw new Error(`make-web-preset: --${name} must be in (0, 1], got ${String(value)}`)
    }
  }
  if (reminderRatio > thresholdRatio) {
    throw new Error(
      `make-web-preset: --reminder-ratio (${reminderRatio}) must not exceed --threshold-ratio (${thresholdRatio})`,
    )
  }
  const reminderMessage = config.reminderMessage ?? DEFAULT_REMINDER_MESSAGE
  if (typeof reminderMessage !== 'string' || reminderMessage.trim().length === 0) {
    throw new Error(
      `make-web-preset: --reminder-message must be a non-empty string, got ${JSON.stringify(reminderMessage)}`,
    )
  }
  const handoffDir = config.handoffDir ?? DEFAULT_HANDOFF_DIR
  if (typeof handoffDir !== 'string' || handoffDir.trim().length === 0) {
    throw new Error(`make-web-preset: --handoff-dir must be a non-empty string, got ${JSON.stringify(handoffDir)}`)
  }
  const handoffPattern = config.handoffPattern ?? DEFAULT_HANDOFF_PATTERN
  if (typeof handoffPattern !== 'string' || handoffPattern.trim().length === 0) {
    throw new Error(
      `make-web-preset: --handoff-pattern must be a non-empty string, got ${JSON.stringify(handoffPattern)}`,
    )
  }
  const retainTokens = config.retainTokens ?? null
  if (retainTokens !== null && (!Number.isSafeInteger(retainTokens) || retainTokens < 0)) {
    throw new Error(`make-web-preset: --retain-tokens must be a non-negative integer, got ${String(retainTokens)}`)
  }
  const retainRatio = config.retainRatio ?? 0.1
  if (retainTokens === null && (!Number.isFinite(retainRatio) || retainRatio <= 0 || retainRatio > 1)) {
    throw new Error(`make-web-preset: --retain-ratio must be in (0, 1], got ${String(retainRatio)}`)
  }
  // handoffOnly is a boolean, and a flag string that is neither `true` nor
  // `false` is a typo rather than a truthy value. Defaults ON: this is the
  // shipped preset's contract, so the generated artifact keeps no tail unless a
  // caller asks for one explicitly.
  const handoffOnly = config.handoffOnly ?? true
  if (typeof handoffOnly !== 'boolean') {
    throw new Error(`make-web-preset: --handoff-only must be true or false, got ${JSON.stringify(handoffOnly)}`)
  }
  // Under handoffOnly the engine reads --retain-tokens but never --retain-ratio,
  // so an explicit ratio would be written and ignored. Refuse it instead.
  if (handoffOnly && config.retainRatio !== undefined) {
    throw new Error(
      'make-web-preset: --retain-ratio has no effect with --handoff-only true; '
      + 'pass --retain-tokens for a recent tail, or --handoff-only false for a ratio tail',
    )
  }
  if (!Number.isSafeInteger(handoffMaxChars) || handoffMaxChars <= 0) {
    throw new Error(`make-web-preset: --handoff-max-chars must be a positive integer, got ${String(handoffMaxChars)}`)
  }
  const engineName = config.engineName ?? ownPackageName()
  if (typeof engineName !== 'string' || engineName.trim().length === 0) {
    throw new Error(`make-web-preset: --engine-name must be a non-empty string, got ${JSON.stringify(engineName)}`)
  }
  return {
    thresholdRatio,
    reminderRatio,
    reminderMessage,
    handoffDir,
    handoffPattern,
    retainTokens,
    retainRatio,
    handoffOnly,
    handoffMaxChars,
    engineName,
  }
}

/**
 * This package's own name: the default bare specifier the engine row carries.
 *
 * A bare specifier is the only form that resolves from a preset row. The
 * registry mounts a preset's rows with `prepareProfileEntries(ctx, plugins,
 * ctx.baseUrl)`, where `baseUrl` is the composition's base and NOT a preset
 * directory (there is none in the inline format), so a relative path resolves
 * somewhere unrelated. The host's boot-time profile resolution routes a bare
 * name through the installation closure, which is how the shipped presets
 * name their own plugins.
 */
function ownPackageName() {
  const manifest = JSON.parse(readFileSync(join(packageDir, 'package.json'), 'utf8'))
  if (typeof manifest.name !== 'string' || manifest.name === '') {
    throw new Error('make-web-preset: this package declares no name')
  }
  return manifest.name
}

/**
 * Render a value as a YAML double-quoted scalar.
 *
 * A JSON string is a valid YAML 1.2 double-quoted scalar, and it is the one
 * rendering that survives every message an operator can pass: backticks,
 * braces, quotes, backslashes and newlines all stay intact and unambiguous.
 * @param text - the value to render.
 * @returns the quoted scalar.
 */
function yamlString(text) {
  return JSON.stringify(text)
}

/** Render a scalar in single quotes, doubling any embedded quote. */
function yamlSingleQuoted(text) {
  return `'${text.replaceAll("'", "''")}'`
}

/**
 * Render the replacement engine row.
 * @param indent - column of the anchor row's `-`, so the row keeps the host's nesting.
 * @param options - validated options from {@link resolveOptions}.
 * @returns the row text, without trailing newline.
 */
export function renderEngineRow(indent, options) {
  const pad = ' '.repeat(indent)
  // `- id:` sits at `indent`, so the row's keys sit at `indent + 2` and its
  // `config:` children at `indent + 4`, matching the host's own nesting.
  const key = (text) => `${pad}    ${text}`
  // A tail key is written only where the engine reads it: retainTokens under either
  // flag, and retainRatio only without handoffOnly. With neither set, a handoffOnly
  // row carries no tail.
  let tail = ''
  if (options.retainTokens !== null) tail = `${key(`retainTokens: ${options.retainTokens}`)}\n`
  else if (!options.handoffOnly) tail = `${key(`retainRatio: ${options.retainRatio}`)}\n`
  return `${pad}# Generated by dsh-context-rollover scripts/make-web-preset.mjs: the same\n`
    + `${pad}# deterministic rollover backend the host bundle mounts, owned per-session here.\n`
    + `${pad}# Do not edit; re-run \`pnpm preset:sync\` after host updates. The engine is named\n`
    + `${pad}# by bare package specifier because a preset row has no directory to be relative\n`
    + `${pad}# to: the registry mounts these rows under the composition's own base.\n`
    + `${pad}- id: context-rollover\n`
    + `${pad}  name: ${yamlSingleQuoted(options.engineName)}\n`
    + `${pad}  config:\n`
    + `${key(`thresholdRatio: ${options.thresholdRatio}`)}\n`
    + `${key(`reminderThresholdRatio: ${options.reminderRatio}`)}\n`
    + `${key(`reminderMessage: ${yamlString(options.reminderMessage)}`)}\n`
    + `${key(`handoffOnly: ${options.handoffOnly}`)}\n`
    + tail
    + `${key(`handoffMaxChars: ${options.handoffMaxChars}`)}\n`
    + `${key(`handoffDir: ${yamlSingleQuoted(options.handoffDir)}`)}\n`
    + `${key(`handoffPattern: ${yamlSingleQuoted(options.handoffPattern)}`)}\n`
    + `${key(`modelSurface: 'always'`)}`
}

/**
 * Locate the single match of `pattern`, failing loud on zero or many.
 * @param text - the haystack.
 * @param pattern - a non-global pattern; this makes the global copy matchAll needs.
 * @param what - human name of the anchor, for the diagnostic.
 * @returns the sole match.
 */
function singleMatch(text, pattern, what) {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`
  const matches = [...text.matchAll(new RegExp(pattern.source, flags))]
  const only = matches[0]
  if (matches.length !== 1 || only === undefined) {
    throw new Error(
      `make-web-preset: expected exactly one ${what} in the host declaration, found ${matches.length}; `
      + 'update scripts/make-web-preset.mjs to the new shipped shape',
    )
  }
  return only
}

/**
 * Splice `replacement` over one match, failing loud on zero or many.
 * @param text - the haystack.
 * @param pattern - the anchor; must carry any capture the replacer reads.
 * @param replacement - the text to substitute, built from the match.
 * @param what - human name of the anchor, for the diagnostic.
 * @returns the spliced text with the match start index.
 */
function spliceOnce(text, pattern, replacement, what) {
  const match = singleMatch(text, pattern, what)
  const start = match.index
  if (start === undefined) throw new Error(`make-web-preset: internal: no index for ${what}`)
  const rendered = typeof replacement === 'function' ? replacement(match) : replacement
  return { text: text.slice(0, start) + rendered + text.slice(start + match[0].length), index: start }
}

/**
 * Swap the host declaration's `compaction-basic` row for the rollover engine
 * row and restamp the preset's identity. Everything else stays byte-identical.
 * @param text - the host declaration text.
 * @param options - validated options from {@link resolveOptions}.
 * @param presetId - generated preset id.
 * @param sourceId - source preset id the text derives from.
 * @returns the generated declaration text.
 * @throws when any anchor row is absent, duplicated, or has gained a block this
 *   transform would silently mis-scope, or when the compaction isolate group
 *   the engine must publish into is no longer the shipped one.
 */
export function transformPresetText(text, options, presetId = DEFAULT_PRESET_ID, sourceId = SOURCE_PRESET) {
  if (!PRESET_ID.test(presetId)) {
    throw new Error(`make-web-preset: --preset-id must match ${PRESET_ID}, got ${presetId}`)
  }
  const source = resolveSource(sourceId)
  // Check the realm-bearing group first: if the host ever moves the anchor out
  // of it, the replacement row would register into the root realm, where the
  // registry rejects the whole mount as a leaked service.
  const groupIndex = text.indexOf(COMPACTION_GROUP)
  if (groupIndex === -1) {
    throw new Error(
      'make-web-preset: the host standard declaration no longer carries the shipped compaction isolate group; '
      + 'update scripts/make-web-preset.mjs to the new shipped shape',
    )
  }

  const anchor = singleMatch(text, /^( +)- id: compaction-basic$/gm, 'compaction-basic row')
  const indent = anchor[1].length
  if (anchor.index < groupIndex) {
    throw new Error('make-web-preset: the compaction-basic row sits outside the compaction isolate group')
  }
  const namePattern = new RegExp(`^ {${indent + 2}}name: '@deepseek-ai/dsh-compaction-basic'$`, 'm')
  const afterAnchor = text.slice(anchor.index + anchor[0].length)
  const nameMatch = singleMatch(afterAnchor, namePattern, 'compaction-basic plugin name')
  const anchorRow = `${anchor[0]}\n${nameMatch[0]}`
  // A future host may add keys (e.g. a `config:` block) to the shipped row.
  // Those deeper-indented lines would then attach to the replacement row, so
  // fail loud rather than silently re-scope them.
  const following = afterAnchor.slice(nameMatch.index + nameMatch[0].length).split('\n').slice(1)
  const next = following.find(line => line.trim() !== '' && !line.trim().startsWith('#'))
  if (next !== undefined && next.search(/\S/) > indent) {
    throw new Error(
      'make-web-preset: the host compaction-basic row carries an unexpected block; '
      + 'update scripts/make-web-preset.mjs to the new shipped shape',
    )
  }
  let output = text.slice(0, anchor.index) + renderEngineRow(indent, options) + text.slice(anchor.index + anchorRow.length)

  // Restamp the declaration: row id, preset id, and inline display metadata.
  output = spliceOnce(
    output,
    new RegExp(`^( {4}- id: )${source.rowId}$`, 'm'),
    match => `${match[1] ?? ''}preset-${presetId}`,
    'declaration row id',
  ).text
  output = spliceOnce(
    output,
    new RegExp(`^( {8}id: )${source.presetId}$`, 'm'),
    match => `${match[1] ?? ''}${presetId}`,
    'declaration preset id',
  ).text
  output = spliceOnce(
    output,
    new RegExp(`^ {8}order: ${source.order}$`, 'm'),
    `        name: ${yamlString(source.meta.name)}\n`
    + `        description: ${yamlString(source.meta.description)}\n`
    + `        order: ${source.meta.order}`,
    'declaration order',
  ).text
  return output
}

/**
 * Parse `--key value` / `--key=value` arguments.
 * @param argv - process arguments without the node/script prefix.
 * @returns the parsed flags.
 */
export function parseArgs(argv) {
  // A null-prototype object, not `{}`. Assigning to `flags['__proto__']` on a
  // plain object invokes the inherited setter, creates no OWN key, and so is
  // invisible to Object.keys — verified: `const f = {}; f['__proto__'] = 'x'`
  // leaves Object.keys(f) empty. That would let `--__proto__ cordis` through
  // the allow-list below and silently derive from the default source.
  const flags = Object.create(null)
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg.startsWith('--')) throw new Error(`make-web-preset: unexpected argument ${arg}; see --help`)
    const [key, inline] = arg.slice(2).split('=', 2)
    if (key === 'help') {
      flags.help = true
      continue
    }
    const value = inline ?? argv[index + 1]
    if (value === undefined || value.startsWith('--')) {
      throw new Error(`make-web-preset: --${key} needs a value; see --help`)
    }
    if (inline === undefined) index += 1
    flags[key] = value
  }
  const known = new Set([
    'help', 'presets-dir', 'out-dir', 'preset-id', 'source-preset', 'engine-name',
    'threshold-ratio', 'reminder-ratio', 'reminder-message', 'handoff-dir',
    'handoff-pattern', 'retain-tokens', 'retain-ratio', 'handoff-only', 'handoff-max-chars',
  ])
  for (const key of Object.keys(flags)) {
    if (!known.has(key)) {
      throw new Error(`make-web-preset: unknown option --${key}; see --help`)
    }
  }
  return flags
}

/** Print usage. */
export function printHelp() {
  console.log(`make-web-preset: regenerate the shipped ${DEFAULT_PRESET_ID} preset (maintainer sync)

Options:
  --presets-dir <dir>     directory holding the host's standard.patch.yml
                          (default: tests/fixtures/host)
  --source-preset <id>    host declaration to derive from: standard | cordis
                          (default: standard)
  --out-dir <dir>         presets root to write into (default: this package's presets/)
  --preset-id <id>        generated preset id (default: ${DEFAULT_PRESET_ID})
  --engine-name <spec>    module specifier the engine row names
                          (default: this package's own name)
  --threshold-ratio <n>   auto-rollover point, fraction of window (default: 0.9)
  --reminder-ratio <n>    one-time handoff reminder point (default: 0.4)
  --reminder-message <t>  reminder text; {percent} is the only placeholder
                          (default: the shipped /handoff-doc reminder)
  --handoff-dir <dir>     handoff directory, relative to the session cwd
                          (default: ${DEFAULT_HANDOFF_DIR}; written to the row,
                          not read by the engine)
  --handoff-pattern <g>   handoff file glob inside that directory
                          (default: ${DEFAULT_HANDOFF_PATTERN}; written to the row,
                          not read by the engine)
  --retain-tokens <n>     absolute recent-tail budget (default: unset; with
                          --handoff-only true it keeps that tail behind the handoff)
  --retain-ratio <n>      tail budget fraction when --retain-tokens is unset
                          (default: 0.1; needs --handoff-only false)
  --handoff-only <bool>   replace the whole prior surface with the handoff document,
                          keeping no tail unless --retain-tokens is set
                          (default: true; pass false for a ratio tail)
  --handoff-max-chars <n> max handoff/notes text (default: 20000)`)
}

/**
 * Run the generator.
 * @param argv - process arguments without the node/script prefix.
 */
export async function main(argv = process.argv.slice(2)) {
  const flags = parseArgs(argv)
  if (flags.help) {
    printHelp()
    return
  }
  const presetId = flags['preset-id'] ?? DEFAULT_PRESET_ID
  if (!PRESET_ID.test(presetId)) {
    throw new Error(`make-web-preset: --preset-id must match ${PRESET_ID}, got ${presetId}`)
  }
  const number = (name) => {
    const raw = flags[name]
    if (raw === undefined) return undefined
    const value = Number(raw)
    if (!Number.isFinite(value)) throw new Error(`make-web-preset: --${name} must be a number, got ${raw}`)
    return value
  }
  const boolean = (name) => {
    const raw = flags[name]
    if (raw === undefined) return undefined
    if (raw !== 'true' && raw !== 'false') {
      throw new Error(`make-web-preset: --${name} must be true or false, got ${raw}`)
    }
    return raw === 'true'
  }
  const options = resolveOptions({
    thresholdRatio: number('threshold-ratio'),
    reminderRatio: number('reminder-ratio'),
    reminderMessage: flags['reminder-message'],
    handoffDir: flags['handoff-dir'],
    handoffPattern: flags['handoff-pattern'],
    retainTokens: number('retain-tokens'),
    retainRatio: number('retain-ratio'),
    handoffOnly: boolean('handoff-only'),
    handoffMaxChars: number('handoff-max-chars'),
    engineName: flags['engine-name'],
  })
  if (flags['retain-tokens'] !== undefined && flags['retain-ratio'] !== undefined) {
    throw new Error('make-web-preset: --retain-tokens and --retain-ratio are exclusive')
  }
  const sourceId = flags['source-preset'] ?? SOURCE_PRESET
  const source = findSourcePreset(flags['presets-dir'], resolveSource(sourceId).presetId)
  const text = readFileSync(source, 'utf8')
  const outDir = flags['out-dir'] === undefined ? join(packageDir, 'presets') : resolve(flags['out-dir'])
  const dir = join(outDir, presetId)
  const preset = transformPresetText(text, options, presetId, sourceId)
  mkdirSync(dir, { recursive: true })
  const declaration = join(dir, 'declaration.patch.yml')
  writeFileSync(declaration, preset)
  console.log(`make-web-preset: derived ${presetId} from ${source}`)
  console.log(`make-web-preset: wrote ${declaration}`)
}

const invokedDirectly = process.argv[1] !== undefined
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
