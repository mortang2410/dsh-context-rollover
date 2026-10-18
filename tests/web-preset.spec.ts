/**
 * Preset-format coverage for the running host line.
 *
 * `scripts/make-web-preset.mjs` regenerates the shipped `standard-rollover`
 * preset from the host's OWN shipped `standard` declaration, in the host's
 * inline `@deepseek-ai/dsh-agent-preset` format, swapping only the compaction
 * engine row. This suite covers three things the ticket treats as one defect
 * class, because all three fail silently on the host:
 *
 * 1. The generator produces the new format, keeps its configuration flags
 *    working, and fails loud when the host declaration's shape drifts.
 * 2. The committed declaration is a fresh generation, and this bundle's patch
 *    list composes over the REAL host bundle tree with every patch applied:
 *    an unmatched patch id only WARNS and is skipped, so a nonzero count here
 *    is exactly the silent no-op the old `agent-presets` target produced.
 * 3. The generated declaration actually loads through the REAL preset
 *    registry: booting the real host composition and selecting
 *    `standard-rollover` resolves that session's compaction service to THIS
 *    engine. Checking the generated text alone cannot prove that.
 *
 * The script runs as a real subprocess against temp directories, so this
 * suite covers the shipped artifact rather than an import of it.
 *
 * @module tests/web-preset
 */

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, describe, expect, it } from 'vitest'
import { createRequire } from 'node:module'
import type { Context } from '@deepseek-ai/cordis'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import type { EntryOptions } from '@deepseek-ai/cordis-plugin-loader'
import {
  boot,
  bundlePatchPaths,
  composeEntries,
  createRuntimeResolution,
  loadOverlayPatches,
  loadProfileDirectory,
  PluginPackages,
} from '@deepseek-ai/dsh-app-boot'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompactionEngine } from '@deepseek-ai/dsh-compaction'
import { SessionId } from '@deepseek-ai/dsh-session'
// Type-only: resolves `ctx.agentPresets` and `ctx.agents` through their own merges.
import type {} from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-agent'

const script = fileURLToPath(new URL('../scripts/make-web-preset.mjs', import.meta.url))
const repoRoot = resolve(dirname(script), '..')

/** The generated declaration: the shipped artifact under test. */
const COMMITTED = join(repoRoot, 'presets', 'standard-rollover', 'declaration.patch.yml')

/** The checked-in byte-for-byte copy of the running host's `standard` declaration. */
const HOST_FIXTURE = join(repoRoot, 'tests', 'fixtures', 'host', 'standard.patch.yml')

/** The checked-in byte-for-byte copy of the running host's `cordis` declaration. */
const CORDIS_FIXTURE = join(repoRoot, 'tests', 'fixtures', 'host', 'cordis.patch.yml')

/** The generated cordis-derived declaration: the second shipped artifact. */
const COMMITTED_LOCAL_CORDIS = join(repoRoot, 'presets', 'local-cordis', 'declaration.patch.yml')

/**
 * SHA-256 of the running host's `dsh-web-app/presets/standard.patch.yml`
 * (DSH 0.2.0-rc.2). The committed fixture must stay that exact file: the
 * generator's anchor is the host's own shape, so a fixture that quietly drifted
 * would let the committed preset become un-reproducible from the real host.
 */
const HOST_DECLARATION_SHA256 = '6cd2f197737fc94a45e487d0bb57869461dd6f392d45f6429b576e75d973eda8'

/** The host declaration's anchor row, as the generator reads it. */
const ANCHOR_HEAD = "              - id: compaction-basic\n"
const ANCHOR_ROW = `${ANCHOR_HEAD}                name: '@deepseek-ai/dsh-compaction-basic'\n`

/** Recursively collect every row id in a composed entry list. */
function rowIds(rows: readonly EntryOptions[]): Set<string> {
  const found = new Set<string>()
  const walk = (list: readonly EntryOptions[]): void => {
    for (const row of list) {
      if (typeof row.id === 'string') found.add(row.id)
      if (row.group === true && Array.isArray(row.config)) walk(row.config as EntryOptions[])
    }
  }
  walk(rows)
  return found
}

/** Find one row by id anywhere in a composed entry list. */
function findRow(rows: readonly EntryOptions[], id: string): EntryOptions | undefined {
  for (const row of rows) {
    if (row.id === id) return row
    if (row.group === true && Array.isArray(row.config)) {
      const nested = findRow(row.config as EntryOptions[], id)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

/**
 * Scratch dirs for one generator run: a declaration dir and an out dir.
 *
 * The declaration is written under `<sourcePreset>.patch.yml`, because
 * `findSourcePreset` looks the file up by the requested source's own name.
 * Writing it as `standard.patch.yml` while passing `--source-preset cordis`
 * makes the generator fail with "no cordis declaration found", so the two
 * must agree.
 * @param declaration - the host declaration text to place in the scratch dir.
 * @param sourcePreset - filename stem the generator will look for.
 */
function scratch(
  declaration: string,
  sourcePreset = 'standard',
): { presetsDir: string; outDir: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'dsh-web-preset-'))
  const presetsDir = join(base, 'presets')
  const outDir = join(base, 'out')
  mkdirSync(presetsDir, { recursive: true })
  writeFileSync(join(presetsDir, `${sourcePreset}.patch.yml`), declaration)
  return { presetsDir, outDir, cleanup: () => { rmSync(base, { recursive: true, force: true }) } }
}

/** Run the generator, returning stdout; throws (with status/stderr) on failure. */
function run(args: readonly string[]): string {
  return execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' })
}

/** Escape literal text for use inside a RegExp. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** The real host fixture text, the shape the generator anchors on. */
function hostDeclaration(): string {
  return readFileSync(HOST_FIXTURE, 'utf8')
}

/** The real host's `cordis` fixture text, the shape a cordis-derived preset anchors on. */
function cordisDeclaration(): string {
  return readFileSync(CORDIS_FIXTURE, 'utf8')
}

/**
 * The declaration's inline `config.plugins` array, parsed by the host's own
 * loader dialect rather than by matching generated text.
 * @param text - declaration text.
 * @returns the declared child rows.
 */
function declarationPlugins(text: string): readonly EntryOptions[] {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-web-preset-parse-'))
  try {
    const file = join(dir, 'declaration.patch.yml')
    writeFileSync(file, text)
    const inserted = loadOverlayPatches('test', file).flatMap(patch => patch.insert ?? [])
    const row = inserted.find(candidate => candidate.name === '@deepseek-ai/dsh-agent-preset')
    if (row === undefined) throw new Error('the declaration carries no @deepseek-ai/dsh-agent-preset row')
    const plugins = (row.config as { plugins?: unknown } | undefined)?.plugins
    if (!Array.isArray(plugins)) throw new Error('the declaration row carries no config.plugins array')
    return plugins as EntryOptions[]
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/**
 * One row's `config` children inside the declaration's compaction group, read
 * the way the registry reads them.
 * @param text - declaration text.
 * @param id - child row id.
 * @returns the child row, when declared.
 */
function declaredChild(text: string, id: string): EntryOptions | undefined {
  const compaction = declarationPlugins(text).find(row => row.id === 'compaction')
  return (compaction?.config as EntryOptions[] | undefined)?.find(row => row.id === id)
}

/**
 * The catalog of host bundle patch files this suite composes over.
 *
 * CI checks the harness fork out beside this repo and CI's own steps build it;
 * locally the installed host is the built line. Composing these files needs no
 * build, so preferring the checkout keeps this suite independent of whether an
 * installed host happens to exist.
 * @returns the labels and files, or undefined when neither host source exists.
 */
function hostBundlePatches(): { label: string; files: readonly string[] } | undefined {
  const checkout = resolve(repoRoot, process.env.DSH_CHECKOUT_DIR ?? '../deepseek-harness')
  const candidates = [
    { label: 'the harness checkout', dir: join(checkout, 'packages', 'bundle') },
    {
      label: 'the installed host',
      dir: join(homedir(), '.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai'),
    },
  ]
  for (const { label, dir } of candidates) {
    const base = join(dir, 'dsh-base', 'cordis.patch.yml')
    const webDir = join(dir, 'dsh-web-app')
    if (!existsSync(base) || !existsSync(join(webDir, 'cordis.patch.yml'))) continue
    const manifest = JSON.parse(readFileSync(join(webDir, 'package.json'), 'utf8')) as {
      dsh: { bundle: { patch: string | string[] } }
    }
    return { label, files: [base, ...bundlePatchPaths(webDir, manifest.dsh.bundle)] }
  }
  return undefined
}

/** This bundle's declared patch list, as the boot reads it from `package.json`. */
function ownPatches(): { files: readonly string[]; patches: PatchOptions[] } {
  const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    dsh: { bundle: { patch: string | string[] } }
  }
  const files = bundlePatchPaths(repoRoot, manifest.dsh.bundle)
  return { files, patches: files.flatMap(file => loadOverlayPatches('test', file)) }
}

/**
 * An installation anchor whose dependency closure is actually BUILT.
 *
 * The real boot imports host plugins from disk, so the anchor must point at a
 * built DSH installation: this repo's sibling checkout after CI builds it, or
 * the installed host. Prefer the checkout because CI's `pnpm test` runs before
 * this package's own `pnpm build`, while the checkout is built earlier.
 * @returns the absolute path of an installation's `package.json`.
 * @throws when neither candidate supplies a built closure, because a silently
 *   chosen unbuilt anchor would turn this suite's strongest test into a no-op.
 */
function builtInstallationAnchor(): string {
  const checkout = resolve(repoRoot, process.env.DSH_CHECKOUT_DIR ?? '../deepseek-harness')
  const candidates = [
    join(checkout, 'apps', 'cli', 'package.json'),
    join(homedir(), '.npm-global/lib/node_modules/@deepseek-ai/dsh', 'package.json'),
  ]
  for (const anchor of candidates) {
    if (!existsSync(anchor)) continue
    try {
      const resolved = createRequire(anchor).resolve('@deepseek-ai/dsh-compaction-basic/package.json')
      if (existsSync(join(dirname(resolved), 'lib', 'index.js'))) return anchor
    } catch {
      // An unbuilt or absent closure is the next candidate's turn.
    }
  }
  throw new Error(
    'no built DSH installation found: build the sibling checkout or install the host, so the real '
    + 'registry can import the host plugins this test boots',
  )
}

/** Cleanup thunks for the expensive boot scenario, run even if its test fails. */
const bootCleanup: Array<() => void> = []
afterAll(() => {
  for (const cleanup of bootCleanup.splice(0)) cleanup()
})

describe('make-web-preset', () => {
  it('derives standard-rollover in the host inline format, with the engine row and untouched surroundings', () => {
    const { presetsDir, outDir, cleanup } = scratch(hostDeclaration())
    try {
      run(['--presets-dir', presetsDir, '--out-dir', outDir, '--handoff-only', 'false', '--retain-tokens', '12000'])
      const generated = readFileSync(join(outDir, 'standard-rollover', 'declaration.patch.yml'), 'utf8')
      // The engine replaces the host's summarizer; the preset id stays put.
      expect(generated).not.toContain(`name: '@deepseek-ai/dsh-compaction-basic'`)
      expect(generated).toContain('- id: context-rollover')
      expect(generated).toContain("name: 'dsh-context-rollover'")
      // The host's own inline declaration format: one preset row carrying
      // `config.plugins`, not a `presets/<id>/agent.cordis.yml` directory.
      const plugins = declarationPlugins(generated)
      const compaction = plugins.find(row => row.id === 'compaction')
      expect(compaction?.group).toBe(true)
      expect(compaction?.isolate).toEqual({ compaction: true, toolResultPruner: true })
      expect(declaredChild(generated, 'context-rollover')?.name).toBe('dsh-context-rollover')
      expect(declaredChild(generated, 'context-rollover')?.config).toMatchObject({
        thresholdRatio: 0.9,
        reminderThresholdRatio: 0.4,
        handoffOnly: false,
        retainTokens: 12000,
        handoffDir: '.scratch/handoff',
        handoffPattern: 'HANDOFF-*.md',
        modelSurface: 'always',
      })
      expect(declaredChild(generated, 'context-rollover')?.config).not.toHaveProperty('retainRatio')
      // The declaration row is restamped, and the host's own rows survive.
      expect(generated).toContain("    - id: preset-standard-rollover\n      name: '@deepseek-ai/dsh-agent-preset'")
      expect(generated).toContain('        id: standard-rollover\n')
      expect(generated).toContain('        order: 2\n')
      expect(generated).toContain("              - id: command-compact\n                name: '@deepseek-ai/dsh-command-compact'")
    } finally {
      cleanup()
    }
  })

  it('swaps only the anchor row: every other byte of the host declaration survives', () => {
    const { presetsDir, outDir, cleanup } = scratch(hostDeclaration())
    try {
      run(['--presets-dir', presetsDir, '--out-dir', outDir])
      const generated = readFileSync(join(outDir, 'standard-rollover', 'declaration.patch.yml'), 'utf8')
      // The expected text is the host declaration with EXACTLY the restamps the
      // generator documents, so any other byte that moved shows up here.
      const expected = hostDeclaration()
        .replace('    - id: preset-standard\n', '    - id: preset-standard-rollover\n')
        .replace('        id: standard\n', '        id: standard-rollover\n')
        .replace(
          '        order: 1\n',
          '        name: "Standard + rollover (experimental)"\n'
          + '        description: "Full coding agent with model-driven context rollover instead of summarization '
          + '(generated from the host standard preset). Experimental opt-in; standard remains the default."\n'
          + '        order: 2\n',
        )
      const [head, tail] = expected.split(ANCHOR_ROW)
      if (head === undefined || tail === undefined) throw new Error('the expected text lost its anchor row')
      const banner = '              # Generated by dsh-context-rollover'
      const [generatedHead] = generated.split(banner)
      expect(generatedHead).toBe(head)
      // Everything BELOW the replaced row is byte-identical too: the generated
      // text ends with the expected text's own tail, and the replacement's
      // length accounts for the whole difference.
      expect(generated).toMatch(new RegExp(`${tail === undefined ? '' : escapeRegExp(tail)}$`))
      const replacement = generated.slice(head.length, generated.length - (tail?.length ?? 0))
      expect(replacement).toContain('- id: context-rollover')
      expect(replacement).toContain("name: 'dsh-context-rollover'")
      expect(replacement.split('\n').filter(line => line.trimStart().startsWith('- id:'))).toEqual([
        '              - id: context-rollover',
      ])
    } finally {
      cleanup()
    }
  })

  it('fails loud when the anchor row is absent', () => {
    const { presetsDir, outDir, cleanup } = scratch(hostDeclaration().replaceAll('compaction-basic', 'compaction-renamed'))
    try {
      expect(() => run(['--presets-dir', presetsDir, '--out-dir', outDir])).toThrow(/compaction-basic row/)
    } finally {
      cleanup()
    }
  })

  it('fails loud when the anchor row gains an unexpected block', () => {
    const changed = hostDeclaration().replace(ANCHOR_ROW, `${ANCHOR_ROW}                config:\n                  future: true\n`)
    const { presetsDir, outDir, cleanup } = scratch(changed)
    try {
      expect(() => run(['--presets-dir', presetsDir, '--out-dir', outDir])).toThrow(/unexpected block/)
    } finally {
      cleanup()
    }
  })

  it('fails loud when the compaction isolate group drifts', () => {
    // The engine must publish inside a realm. Without one the registry rejects
    // the whole mount as a leaked root-realm service, so a changed group has to
    // stop the sync rather than generate a preset that cannot mount.
    const changed = hostDeclaration().replace(
      '            isolate:\n              compaction: true\n              toolResultPruner: true\n',
      '            isolate:\n              compaction: true\n',
    )
    const { presetsDir, outDir, cleanup } = scratch(changed)
    try {
      expect(() => run(['--presets-dir', presetsDir, '--out-dir', outDir])).toThrow(/compaction isolate group/)
    } finally {
      cleanup()
    }
  })

  it('fails loud when the declaration row, preset id, or order is not the shipped one', () => {
    const cases = [
      ['declaration row id', hostDeclaration().replace('- id: preset-standard\n', '- id: preset-renamed\n')],
      ['declaration preset id', hostDeclaration().replace('        id: standard\n', '        id: renamed\n')],
      ['declaration order', hostDeclaration().replace('        order: 1\n', '        order: 7\n')],
    ] as const
    for (const [label, changed] of cases) {
      const { presetsDir, outDir, cleanup } = scratch(changed)
      try {
        expect(() => run(['--presets-dir', presetsDir, '--out-dir', outDir]), label).toThrow(/expected exactly one/)
      } finally {
        cleanup()
      }
    }
  })

  it('rejects out-of-range, blank, and contradictory flags', () => {
    const { presetsDir, outDir, cleanup } = scratch(hostDeclaration())
    const base = ['--presets-dir', presetsDir, '--out-dir', outDir]
    try {
      expect(() => run([...base, '--threshold-ratio', '2'])).toThrow(/in \(0, 1\]/)
      expect(() => run([...base, '--reminder-ratio', '0.95'])).toThrow(/must not exceed --threshold-ratio/)
      expect(() => run([...base, '--reminder-message', '   '])).toThrow(/reminder-message must be a non-empty string/)
      expect(() => run([...base, '--handoff-dir', '  '])).toThrow(/handoff-dir must be a non-empty string/)
      expect(() => run([...base, '--handoff-pattern', ''])).toThrow(/handoff-pattern must be a non-empty string/)
      expect(() => run([...base, '--handoff-only', 'yes'])).toThrow(/--handoff-only must be true or false/)
      expect(() => run([...base, '--handoff-max-chars', '0'])).toThrow(/handoff-max-chars must be a positive integer/)
      expect(() => run([...base, '--handoff-only', 'false', '--retain-tokens', '1', '--retain-ratio', '0.5']))
        .toThrow(/exclusive/)
      expect(() => run([...base, '--engine-name', '  '])).toThrow(/engine-name must be a non-empty string/)
      expect(() => run([...base, '--preset-id', 'Not Valid'])).toThrow(/--preset-id must match/)
    } finally {
      cleanup()
    }
  })

  it('emits no tail key under handoffOnly when no tail budget is requested', () => {
    const { presetsDir, outDir, cleanup } = scratch(hostDeclaration())
    try {
      run(['--presets-dir', presetsDir, '--out-dir', outDir])
      const config = declaredChild(
        readFileSync(join(outDir, 'standard-rollover', 'declaration.patch.yml'), 'utf8'),
        'context-rollover',
      )?.config
      expect(config).toMatchObject({ handoffOnly: true })
      expect(config).not.toHaveProperty('retainRatio')
      expect(config).not.toHaveProperty('retainTokens')
    } finally {
      cleanup()
    }
  })

  it('refuses --retain-ratio under handoffOnly, where the engine never reads it', () => {
    const { presetsDir, outDir, cleanup } = scratch(hostDeclaration())
    const base = ['--presets-dir', presetsDir, '--out-dir', outDir]
    try {
      expect(() => run([...base, '--retain-ratio', '0.2'])).toThrow(/no effect with --handoff-only true/)
    } finally {
      cleanup()
    }
  })

  it('writes an explicit --retain-tokens under handoffOnly, where the engine reads it', () => {
    const { presetsDir, outDir, cleanup } = scratch(hostDeclaration())
    try {
      run(['--presets-dir', presetsDir, '--out-dir', outDir, '--retain-tokens', '8192'])
      const config = declaredChild(
        readFileSync(join(outDir, 'standard-rollover', 'declaration.patch.yml'), 'utf8'),
        'context-rollover',
      )?.config
      expect(config).toMatchObject({ handoffOnly: true, retainTokens: 8192 })
      expect(config).not.toHaveProperty('retainRatio')
    } finally {
      cleanup()
    }
  })

  it('keeps every flag able to express the shipped values, in both handoffOnly directions', () => {
    const { presetsDir, outDir, cleanup } = scratch(hostDeclaration())
    const base = ['--presets-dir', presetsDir, '--out-dir', outDir]
    try {
      const read = (): unknown => declaredChild(
        readFileSync(join(outDir, 'standard-rollover', 'declaration.patch.yml'), 'utf8'),
        'context-rollover',
      )?.config
      run(base)
      expect(read()).toMatchObject({ handoffOnly: true, handoffMaxChars: 20000 })
      expect(read()).not.toHaveProperty('retainRatio')
      run([...base, '--handoff-only', 'false'])
      expect(read()).toMatchObject({ handoffOnly: false, retainRatio: 0.1 })
      run([
        ...base, '--threshold-ratio', '0.8', '--reminder-ratio', '0.3', '--handoff-max-chars', '4096',
        '--handoff-dir', 'docs/handoff', '--handoff-pattern', 'NOTE-*.md', '--reminder-message', 'custom {percent}',
        '--handoff-only', 'false', '--retain-tokens', '8192', '--engine-name', 'other-engine',
      ])
      expect(read()).toMatchObject({
        thresholdRatio: 0.8,
        reminderThresholdRatio: 0.3,
        handoffMaxChars: 4096,
        handoffDir: 'docs/handoff',
        handoffPattern: 'NOTE-*.md',
        reminderMessage: 'custom {percent}',
        retainTokens: 8192,
      })
      expect(declaredChild(
        readFileSync(join(outDir, 'standard-rollover', 'declaration.patch.yml'), 'utf8'),
        'context-rollover',
      )?.name).toBe('other-engine')
    } finally {
      cleanup()
    }
  })

  it('committed preset matches a fresh sync of the checked-in host declaration', () => {
    const outDir = mkdtempSync(join(tmpdir(), 'dsh-web-preset-sync-'))
    try {
      run(['--presets-dir', join(repoRoot, 'tests', 'fixtures', 'host'), '--out-dir', outDir])
      const fresh = readFileSync(join(outDir, 'standard-rollover', 'declaration.patch.yml'), 'utf8')
      expect(fresh).toBe(readFileSync(COMMITTED, 'utf8'))
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('the checked-in host fixture is the running host declaration, byte for byte', () => {
    const source = hostDeclaration()
    expect(createHash('sha256').update(source).digest('hex')).toBe(HOST_DECLARATION_SHA256)
    // The generator must have a real anchor to read: the host's own inline
    // preset row and the compaction group that row owns.
    expect(source).toContain("    - id: preset-standard\n      name: '@deepseek-ai/dsh-agent-preset'")
    expect(source).toContain(ANCHOR_ROW)
  })

  it('the shipped preset carries the required engine configuration', () => {
    // Equality with a fresh generation would still hold if the generator and
    // the committed preset both regressed, so assert the required values on the
    // committed artifact directly, parsed the way a config loader reads it.
    const engine = declaredChild(readFileSync(COMMITTED, 'utf8'), 'context-rollover')
    expect(engine?.config).toMatchObject({
      thresholdRatio: 0.9,
      reminderThresholdRatio: 0.4,
      handoffOnly: true,
      handoffDir: '.scratch/handoff',
      handoffPattern: 'HANDOFF-*.md',
      modelSurface: 'always',
    })
    const message = (engine?.config as { reminderMessage?: string } | undefined)?.reminderMessage
    expect(message).toContain('/handoff-doc')
    expect(message).toContain('new_context')
    expect(message).toContain('{percent}')
    // The literal, not the constant: pins the shipped text against the engine default.
    expect(message).toBe(
      'Context is {percent}% full. {used_tokens} of {window_tokens} tokens are used. '
      + 'The percent is measured against the whole window of this model, so a low percent on a large window is expected. '
      + 'The handoff point, where these reminders start, is {handoff_point_tokens} tokens. '
      + 'The rollover point is {rollover_point_tokens} tokens, leaving {tokens_to_rollover} tokens before the rollover point. '
      + 'Crossing the rollover point is not silent: the engine sends a hard reminder every turn from there, '
      + 'and with `automaticRollover` on it rolls the context over by itself. '
      + 'Run `/handoff-doc` (the `handoff-doc` skill) to create/update the durable handoff document. '
      + 'Make it fully sufficient for a fresh context to continue the work. After it succeeds, call '
      + '`new_context` with the path of that document as `handoff_path`. The handoff document, plus any recent '
      + 'chat kept after the rollover, will be the continuation context.',
    )
  })

  it('derives a cordis-sourced preset under a new id, keeping Creator Mode tools', () => {
    const { presetsDir, outDir, cleanup } = scratch(cordisDeclaration(), 'cordis')
    try {
      const output = run([
        '--presets-dir', presetsDir, '--out-dir', outDir,
        '--source-preset', 'cordis', '--preset-id', 'local-cordis',
      ])
      expect(output).toContain('local-cordis')
      const generated = readFileSync(join(outDir, 'local-cordis', 'declaration.patch.yml'), 'utf8')
      expect(generated).toContain('    - id: preset-local-cordis\n')
      expect(generated).toContain('        id: local-cordis\n')
      expect(generated).toContain('        name: "Local Cordis"\n')
      expect(generated).toContain('        order: 5\n')
      expect(generated).toContain('              - id: context-rollover\n')
      expect(generated).not.toContain('compaction-basic')
      expect(generated).toContain('          - id: tool-cordis\n')
    } finally { cleanup() }
  })

  it('rejects an unknown source preset', () => {
    const { presetsDir, outDir, cleanup } = scratch(hostDeclaration())
    try {
      expect(() => run(['--presets-dir', presetsDir, '--out-dir', outDir, '--source-preset', 'nope']))
        .toThrow(/unknown --source-preset/)
      // A misspelled FLAG must fail too. Without the allow-list in Task 2
      // Step 4 this exits 0 and silently derives from standard.
      expect(() => run(['--presets-dir', presetsDir, '--out-dir', outDir, '--source-presett', 'cordis']))
        .toThrow(/unknown option --source-presett/)
    } finally { cleanup() }
  })

  it('rejects a known source whose declaration is absent from the presets dir', () => {
    // The scratch dir holds only standard.patch.yml, so asking for cordis must
    // fail rather than silently deriving from standard.
    const { presetsDir, outDir, cleanup } = scratch(hostDeclaration())
    try {
      expect(() => run(['--presets-dir', presetsDir, '--out-dir', outDir, '--source-preset', 'cordis']))
        .toThrow(/no "cordis" declaration found/)
    } finally { cleanup() }
  })

  it('committed local-cordis matches a fresh sync of the checked-in cordis fixture', () => {
    const { presetsDir, outDir, cleanup } = scratch(cordisDeclaration(), 'cordis')
    try {
      run([
        '--presets-dir', presetsDir, '--out-dir', outDir,
        '--source-preset', 'cordis', '--preset-id', 'local-cordis',
      ])
      expect(readFileSync(join(outDir, 'local-cordis', 'declaration.patch.yml'), 'utf8'))
        .toBe(readFileSync(COMMITTED_LOCAL_CORDIS, 'utf8'))
    } finally { cleanup() }
  })

  it('the committed local-cordis artifact keeps the cordis-only content, asserted directly', () => {
    // Deliberately NOT a regeneration: this reads the committed artifact and
    // the fixture, so a transform which silently dropped or MOVED the
    // cordis-only content cannot pass by comparing its own output with itself.
    const committed = readFileSync(COMMITTED_LOCAL_CORDIS, 'utf8')
    const fixture = cordisDeclaration()

    // The row id unique to cordis.
    expect(committed).toContain('          - id: tool-cordis\n')
    expect(fixture).toContain('          - id: tool-cordis\n')

    // The config cordis adds to a row that standard ALSO has. A file-wide
    // substring check is not enough: a transform could leave the
    // `customSkillDirs` block in the file while detaching it from its row, or
    // attach it to a different row. So locate the row and read its own block.
    const rowBlock = (text: string, rowId: string): string => {
      const lines = text.split('\n')
      // Exactly one match. `findIndex` alone would silently take the first of
      // two same-id rows, so a fixture that gained a duplicate could pass by
      // inspecting the wrong one.
      const starts = lines
        .map((line, index) => (line.trim() === `- id: ${rowId}` ? index : -1))
        .filter(index => index >= 0)
      expect(starts, `${rowId} must appear exactly once`).toHaveLength(1)
      const start = starts[0]!
      const indent = lines[start]!.search(/\S/)
      const block = [lines[start]!]
      for (const line of lines.slice(start + 1)) {
        if (line.trim() === '') continue
        if (line.search(/\S/) <= indent) break
        block.push(line)
      }
      return block.join('\n')
    }

    const committedSkills = rowBlock(committed, 'skill-filesystem')
    const fixtureSkills = rowBlock(fixture, 'skill-filesystem')
    expect(fixtureSkills).toContain('customSkillDirs:')
    // Equality, not substring: the transform preserves this row's block byte
    // for byte (measured: a real transform run leaves it identical), so a
    // substring check would accept a truncated value — dropping the trailing
    // `'skills'` argument would still contain `customSkillDirs:` and
    // `dsh-agent-preset/package.json` while pointing the skill directory at the
    // package root instead of its `skills/` subdirectory.
    expect(committedSkills).toBe(fixtureSkills)
    expect(committedSkills).toContain("'skills'")

    // And the preset-authoring tool row is NOT where that config ended up.
    expect(rowBlock(committed, 'tool-cordis')).not.toContain('customSkillDirs:')
  })

  it('the checked-in cordis fixture is the running host declaration, byte for byte', () => {
    expect(createHash('sha256').update(cordisDeclaration()).digest('hex'))
      .toBe('b74d71901b692f11111d02d20072735b2fe94b74744ee7e3bfdc5d972f1a3aa5')
  })
})

describe('bundle patch against the real host tree', () => {
  it('applies every patch with nothing skipped, and every target row exists', () => {
    const host = hostBundlePatches()
    if (host === undefined) throw new Error('no host bundle patches found to compose against')
    const own = ownPatches()
    expect(own.files).toContain(COMMITTED)
    const skipped: string[] = []
    const rows = composeEntries(
      [[...host.files.flatMap(file => loadOverlayPatches('test', file)), ...own.patches]],
      message => skipped.push(message),
    )
    // This is the whole defect: an unmatched patch id only WARNS and is
    // skipped, so a nonzero count here is a bundle that installs, boots clean,
    // and does nothing. The old patch targeted `agent-presets`, which does not
    // exist on this host line.
    expect(skipped).toEqual([])
    const ids = rowIds(rows)
    for (const patch of own.patches) {
      if (typeof patch.id !== 'string') continue
      expect(ids.has(patch.id), `this bundle patches ${patch.id}, which ${host.label} does not define`).toBe(true)
    }
    // The preset roster row this host line exposes, and the one it does not.
    expect(ids.has('agent-preset-registry')).toBe(true)
    expect(ids.has('agent-presets')).toBe(false)
    // The generated declaration rides this bundle's patch list, so the preset
    // row is present in the composed tree the boot would mount.
    expect(findRow(rows, 'preset-standard-rollover')).toBeDefined()
    expect(findRow(rows, 'compaction-basic')).toBeDefined()
  })

  it('the roster row this host line exposes accepts only {default, selectedDefault}', () => {
    // The old patch wrote `roots`/`includeShippedRoot`/`includeUserRoot` into
    // that row. Those fields do not exist there, and the patch still "applied"
    // because a patch replaces a row's whole config without validating it, so
    // reading the real schema is what pins the shape this bundle must not fight.
    const checkout = resolve(repoRoot, process.env.DSH_CHECKOUT_DIR ?? '../deepseek-harness')
    const candidates = [
      join(checkout, 'packages', 'preset', 'agent-preset-registry', 'src', 'index.ts'),
      join(homedir(), '.npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/index.js'),
    ]
    const source = candidates.find(candidate => existsSync(candidate))
    if (source === undefined) throw new Error('no agent-preset-registry found to read its config schema')
    const text = readFileSync(source, 'utf8')
    expect(text).toContain('selectedDefault')
    expect(text).not.toContain('includeShippedRoot')
    expect(text).not.toContain('includeUserRoot')
  })
})

describe('the shipped declaration loads through the real preset registry', () => {
  /**
   * Boot the real host composition with this bundle installed, mount `presetId`
   * on one fresh session, and hand back what the preset tests assert on.
   *
   * Shared by both preset tests so the two cannot drift into measuring
   * different trees. The caller owns disposal: call `dispose()` in a `finally`.
   * @param presetId - the preset to mount on the session.
   * @returns the booted context, its registry, the session's agent and
   *   compaction service, the composition inventory, and a disposer.
   */
  async function bootPreset(presetId: string, declarationEdit?: (text: string) => string) {
    const anchor = builtInstallationAnchor()
    const work = mkdtempSync(join(tmpdir(), 'dsh-web-preset-boot-'))
    bootCleanup.push(() => { rmSync(work, { recursive: true, force: true }) })

    // Build the engine straight from the checked-in `src`, into a private
    // directory, and lay out that directory as a real INSTALL of this package:
    // its manifest (with its own `dsh.bundle.patch` list), its bundle patch,
    // and its generated declaration. CI runs `pnpm test` before this package's
    // own `pnpm build`, so the shared `lib/` this row names at runtime may not
    // exist yet, and a test must not create it as a side effect.
    const engineDir = join(work, 'engine')
    const manifest = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      name: string
      dsh: { bundle: { patch: string | string[] } }
      peerDependencies: Record<string, string>
      peerDependenciesMeta?: Record<string, unknown>
    }
    execFileSync(process.execPath, [
      join(repoRoot, 'node_modules/typescript/bin/tsc'), '-p', join(repoRoot, 'tsconfig.build.json'),
      '--outDir', join(engineDir, 'lib'), '--declarationDir', join(engineDir, 'lib/types'),
    ], { cwd: repoRoot, stdio: 'pipe' })
    const engineName = manifest.name
    cpSync(join(repoRoot, 'cordis.patch.yml'), join(engineDir, 'cordis.patch.yml'))
    // The whole presets tree, because the manifest's patch list now names both
    // declarations: copying only standard-rollover leaves the local-cordis
    // overlay unreadable and `skippedBundles` non-empty.
    cpSync(join(repoRoot, 'presets'), join(engineDir, 'presets'), { recursive: true })
    if (declarationEdit !== undefined) {
      const declarationPath = join(engineDir, 'presets', presetId, 'declaration.patch.yml')
      writeFileSync(declarationPath, declarationEdit(readFileSync(declarationPath, 'utf8')))
    }
    // The manifest carries the real `peerDependencies`. They are not decoration:
    // the host's linked-root routing reads THE IMPORTING PACKAGE's manifest to
    // decide that a peer of this plugin resolves from the installation closure
    // instead of its own directory, so a manifest without them would make the
    // engine's own imports fail and this test would be measuring the wrong thing.
    writeFileSync(join(engineDir, 'package.json'), JSON.stringify({
      name: engineName, version: '0.0.0-test', type: 'module', main: 'lib/index.js',
      files: ['lib', 'cordis.patch.yml', 'presets'],
      dsh: manifest.dsh,
      peerDependencies: manifest.peerDependencies,
      ...(manifest.peerDependenciesMeta === undefined ? {} : { peerDependenciesMeta: manifest.peerDependenciesMeta }),
    }))
    expect(existsSync(join(engineDir, 'lib/index.js'))).toBe(true)

    // A profile shaped like a real deployment's: the shipped bundle tuple plus
    // this bundle, installed by link exactly as `dsh plugin add` records it.
    const home = join(work, 'home')
    const profileDir = join(home, 'profiles', 'spec')
    mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
    symlinkSync(engineDir, join(profileDir, 'node_modules', engineName), 'dir')
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({
      private: true,
      dependencies: { [engineName]: `link:${engineDir}` },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', engineName] } },
    }, null, 2)}\n`)

    const profile = loadProfileDirectory('spec', profileDir, anchor, { userLayer: false })
    expect(profile.skippedBundles).toEqual([])
    expect(profile.layers.map(layer => layer.packageName)).toContain(engineName)
    const resolution = await createRuntimeResolution({ installAnchor: anchor, profile })
    const patches = profile.layers.flatMap(layer => layer.patches)

    // Host rows with effects outside this process: a bound port, a served asset
    // tree, file watching, telemetry, the browser roster. Everything that
    // decides an agent's compaction backend stays real, and the boot's own
    // startup audit is the assertion that the shipped graph is intact.
    const overrides: PatchOptions[] = [
      { id: 'storage-json', config: { root: join(work, 'storages') } },
      { id: 'session-persistence-jsonl', config: { root: join(work, 'sessions') } },
      { id: 'webserver', disabled: true },
      { id: 'hmr', disabled: true },
      { id: 'web-runtime', disabled: true },
      { id: 'session-telemetry-otel', disabled: true },
      { id: 'modules', disabled: true },
      { id: 'connection', disabled: true },
      { id: 'session-log-download', disabled: true },
      { id: 'open-in-app', disabled: true },
      { id: 'client-hmr', disabled: true },
      { id: 'directory-picker', disabled: true },
      // Choosing the deployment default stays the deployment's business; the
      // shipped preset only has to be selectable.
      { id: 'agent-preset-registry', config: { default: 'standard' } },
    ]
    const rootConfig = join(profileDir, 'cordis.yml')
    writeFileSync(rootConfig, '[]\n')

    // The engine's notes store and every other `dshHomePath` reader must stay
    // inside this test, never the developer's own harness home.
    const previousHome = process.env.DSH_HOME
    process.env.DSH_HOME = home
    const skips: string[] = []
    let ctx: Context | undefined
    try {
      ctx = await boot('dsh-web-preset-test', rootConfig, [...patches, ...overrides], async (bootCtx) => {
        bootCtx.logger.exporter({
          levels: { default: 2 },
          export: ({ type, args }) => {
            if (type === 'warn' || type === 'error') skips.push(args.map(String).join(' '))
          },
        })
        bootCtx.provide('profileContext', {
          name: 'spec', dir: profileDir, patchPath: join(profileDir, 'cordis.patch.yml'),
          installAnchor: anchor, home, cwd: work,
          startedBundles: profile.layers.map(layer => layer.packageName),
          overlays: [], telemetryDisabledEnv: '1',
        })
        await bootCtx.plugin(PluginPackages, { resolution })
        bootCtx.provide('connection', {
          fetch: { register: () => () => {} }, rpc: { intercept: () => () => {} },
        } as never)
      })
      const registry = ctx.get('agentPresets')
      expect(registry).toBeDefined()
      // A patch this bundle declares that no host row matched appears here as
      // `patch: entry "..." not found`, while the boot still succeeds.
      expect(skips.filter(line => line.includes('patch:'))).toEqual([])

      const listed = await registry!.list()
      expect(listed.map(row => row.id)).toContain('standard-rollover')
      expect(listed.find(row => row.id === 'standard-rollover')?.broken).toBeUndefined()

      const handle = await ctx.agents.create({
        sessionId: SessionId('web-preset-resolution'),
        setup: async (agentCtx: Context) => { await registry!.mount(agentCtx, presetId) },
      })
      const agent: Agent = handle.agent
      const service = registry!.serviceFor(agent, 'compaction') as CompactionEngine | undefined
      expect(service).toBeDefined()
      const inventory = await registry!.compositionInventory()
      return {
        ctx,
        registry: registry!,
        agent,
        service,
        inventory,
        engineName,
        dispose: async () => {
          await ctx?.fiber.dispose()
          if (previousHome === undefined) delete process.env.DSH_HOME
          else process.env.DSH_HOME = previousHome
        },
      }
    } catch (error: unknown) {
      await ctx?.fiber.dispose()
      if (previousHome === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previousHome
      throw error
    }
  }

  it('selecting standard-rollover resolves the session compaction service to THIS engine', async () => {
    const booted = await bootPreset('standard-rollover')
    try {
      const { service, inventory, engineName } = booted
      // The row RESOLVED and mounted: this engine, not the host's summarizer.
      expect(service?.constructor.name).toBe('ContextRolloverEngine')
      expect(service?.constructor.name).not.toBe('BasicCompactionEngine')
      // The engine's own resolved configuration, read off the mounted instance
      // rather than off the declaration text: this is the session's live service.
      expect((service as CompactionEngine & { config: unknown }).config).toMatchObject({
        thresholdRatio: 0.9,
        reminderThresholdRatio: 0.4,
        handoffOnly: true,
        handoffDir: '.scratch/handoff',
        handoffPattern: 'HANDOFF-*.md',
      })
      // The mounted composition carries this engine's row and no summarizer.
      const rows = inventory.find(row => row.id === 'standard-rollover')?.rows ?? []
      expect(rows.map(row => row.moduleName)).toContain(engineName)
      expect(rows.map(row => row.entryId)).not.toContain('compaction-basic')
    } finally {
      await booted.dispose()
    }
  })

  it('selecting local-cordis mounts THIS engine and reaches the model with Creator Mode tools', async () => {
    const booted = await bootPreset('local-cordis')
    try {
      const { ctx, agent, service, inventory, engineName } = booted
      // A cordis-derived session runs THIS engine, not the shipped summarizer.
      expect(service?.constructor.name).toBe('ContextRolloverEngine')
      expect(service?.constructor.name).not.toBe('BasicCompactionEngine')

      const rows = inventory.find(row => row.id === 'local-cordis')?.rows ?? []
      const modules = rows.map(row => row.moduleName)
      expect(modules).toContain(engineName)
      // Creator Mode's own contributions survived the derivation. Both are
      // checked, because either could be dropped independently: `tool-cordis`
      // is the preset-authoring tool, and `skill-filesystem` is the row that
      // carries `customSkillDirs` pointing at the preset-authoring skills.
      expect(modules).toContain('@deepseek-ai/dsh-tool-cordis')
      expect(modules).toContain('@deepseek-ai/dsh-skill-filesystem')
      expect(rows.map(row => row.entryId)).toContain('skill-filesystem')
      expect(rows.map(row => row.entryId)).not.toContain('compaction-basic')

      // The model actually receives the rollover tools. Without
      // `modelSurface: 'always'` the engine mounts and the model sees nothing,
      // which is the failure this assertion exists to catch.
      const tools = ctx.get('tools') as { schemas(scope?: unknown): { name: string }[] }
      const visible = tools.schemas(agent).map(tool => tool.name)
      for (const name of ['new_context', 'get_context_remaining', 'notes', 'history']) {
        expect(visible, `local-cordis session must see ${name}`).toContain(name)
      }
      expect(visible).toContain('cordis_inspect_list')

      // The shipped `cordis` preset is unaffected: it still runs the summarizer.
      const cordisRows = inventory.find(row => row.id === 'cordis')?.rows ?? []
      expect(cordisRows.map(row => row.entryId)).toContain('compaction-basic')
    } finally {
      await booted.dispose()
    }
  }, 300_000)

  it('a custom reminderMessage in the preset row reaches the mounted engine', async () => {
    // The shipped text equals the engine default, so a row that dropped the key
    // would look identical. A distinct row text makes the wiring observable.
    const booted = await bootPreset('local-cordis', (text) => {
      const edited = text.replace('reminderMessage: "Context is', 'reminderMessage: "Row text is')
      expect(edited).not.toBe(text)
      return edited
    })
    try {
      const service = booted.service as CompactionEngine & { config: { reminderMessage: string } }
      expect(service?.constructor.name).toBe('ContextRolloverEngine')
      expect(service.config.reminderMessage).toMatch(/^Row text is \{percent\}% full\./)
    } finally {
      await booted.dispose()
    }
  }, 300_000)
})
