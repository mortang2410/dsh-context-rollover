/**
 * Preset-sync coverage: `scripts/make-web-preset.mjs` regenerates the shipped
 * `standard-rollover` preset from a shipped `standard` composition, fails loud
 * when the shipped shape drifts or flags are invalid, and the committed
 * preset always matches a fresh sync. The bundle patch's preset-root
 * expression is evaluated with the real loader against a fake profile dir.
 *
 * The script runs as a real subprocess against temp directories, so this
 * suite covers the shipped artifact rather than an import of it.
 *
 * @module tests/web-preset
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { evaluate } from '@deepseek-ai/cordis-plugin-loader'

const script = fileURLToPath(new URL('../scripts/make-web-preset.mjs', import.meta.url))
const repoRoot = resolve(dirname(script), '..')

/** Minimal shipped-shape fixture: surrounding rows plus the real compaction group. */
function standardFixture(): string {
  return `# fixture standard preset
- id: persona
  name: '@deepseek-ai/dsh-persona'

# \`compaction-basic\` reads \`toolResultPrune\` through \`ctx.get\`, so the pruner must
# share this realm rather than sit outside it.
- id: compaction
  name: cordis:group
  group: true
  isolate:
    compaction: true
    toolResultPruner: true
  config:
    - id: compaction-basic
      name: '@deepseek-ai/dsh-compaction-basic'

    - id: command-compact
      name: '@deepseek-ai/dsh-command-compact'

    - id: tool-result-pruner
      name: '@deepseek-ai/dsh-compaction-tool-result-pruner'
      config:
        thresholdChars: 8192
`
}

/** Scratch dirs for one run: a presets root holding `standard/` and an out dir. */
function scratch(fixture: string): { presetsDir: string; outDir: string; cleanup: () => void } {
  // Temp dirs inside the repo: the sync names the engine relatively, which
  // cannot cross drives (the script fails loud on that instead).
  const base = mkdtempSync(join(repoRoot, 'tmp-scratch-'))
  const presetsDir = join(base, 'presets')
  const outDir = join(base, 'out')
  mkdirSync(join(presetsDir, 'standard'), { recursive: true })
  writeFileSync(join(presetsDir, 'standard', 'agent.cordis.yml'), fixture)
  return { presetsDir, outDir, cleanup: () => { rmSync(base, { recursive: true, force: true }) } }
}

/** Run the script, returning stdout; throws (with status/stderr) on failure. */
function run(args: readonly string[]): string {
  return execFileSync(process.execPath, [script, ...args], { encoding: 'utf8' })
}

describe('make-web-preset', () => {
  it('derives standard-rollover with the engine row and untouched surroundings', () => {
    const { presetsDir, outDir, cleanup } = scratch(standardFixture())
    try {
      run(['--presets-dir', presetsDir, '--out-dir', outDir, '--retain-tokens', '12000'])
      const composition = readFileSync(join(outDir, 'standard-rollover', 'agent.cordis.yml'), 'utf8')
      expect(composition).not.toContain(`name: '@deepseek-ai/dsh-compaction-basic'`)
      expect(composition).toContain('- id: context-rollover')
      // Portable relative specifier: the temp out dir sits beside nothing, so
      // the entry must stay a relative path into this package's lib.
      expect(composition).toContain(`name: '`)
      expect(composition).toContain('lib/index.js')
      expect(composition).toContain('thresholdRatio: 0.9')
      expect(composition).toContain('retainTokens: 12000')
      expect(composition).not.toContain('retainRatio')
      // The preset row owns its model-facing tools and guidance explicitly.
      expect(composition).toContain(`modelSurface: 'always'`)
      // Untouched rows survive byte-identical around the swap.
      expect(composition).toContain(`- id: persona\n  name: '@deepseek-ai/dsh-persona'`)
      expect(composition).toContain(`- id: command-compact\n      name: '@deepseek-ai/dsh-command-compact'`)
      const meta = readFileSync(join(outDir, 'standard-rollover', 'preset.yml'), 'utf8')
      expect(meta).toContain('order: 2')
    } finally {
      cleanup()
    }
  })

  it('fails loud when the shipped row is absent', () => {
    const { presetsDir, outDir, cleanup } = scratch('# no compaction here\n- id: persona\n  name: x\n')
    try {
      expect(() => run(['--presets-dir', presetsDir, '--out-dir', outDir])).toThrow(/compaction-basic row/)
    } finally {
      cleanup()
    }
  })

  it('fails loud when the shipped row gains an unexpected config block', () => {
    const changed = standardFixture().replace(
      `    - id: compaction-basic\n      name: '@deepseek-ai/dsh-compaction-basic'\n`,
      `    - id: compaction-basic\n      name: '@deepseek-ai/dsh-compaction-basic'\n      config:\n        future: true\n`,
    )
    const { presetsDir, outDir, cleanup } = scratch(changed)
    try {
      expect(() => run(['--presets-dir', presetsDir, '--out-dir', outDir])).toThrow(/unexpected config block/)
    } finally {
      cleanup()
    }
  })

  it('rejects out-of-range flags', () => {
    const { presetsDir, outDir, cleanup } = scratch(standardFixture())
    try {
      expect(() => run(['--presets-dir', presetsDir, '--out-dir', outDir, '--threshold-ratio', '2']))
        .toThrow(/in \(0, 1\]/)
    } finally {
      cleanup()
    }
  })

  it('defaults the reminder ratio to 0.4 and rejects a blank reminder message', () => {
    const { presetsDir, outDir, cleanup } = scratch(standardFixture())
    try {
      run(['--presets-dir', presetsDir, '--out-dir', outDir])
      const composition = readFileSync(join(outDir, 'standard-rollover', 'agent.cordis.yml'), 'utf8')
      expect(composition).toContain('reminderThresholdRatio: 0.4\n')
      expect(() => run([
        '--presets-dir', presetsDir, '--out-dir', outDir, '--reminder-message', '   ',
      ])).toThrow(/reminder-message must be a non-empty string/)
    } finally {
      cleanup()
    }
  })

  it('committed preset matches a fresh sync of the repo standard fixture', () => {
    // Temp dir inside the repo: the sync names the engine relatively, which
    // cannot cross drives (the script fails loud on that instead).
    const outDir = mkdtempSync(join(repoRoot, 'tmp-sync-'))
    try {
      // The source composition is checked in here rather than read from a
      // sibling harness checkout: the running host ships its presets as
      // `.patch.yml` declarations, so no `standard/agent.cordis.yml` exists
      // to sync from. The fixture carries exactly the shipped `standard`
      // rows (verified row-for-row against the host's own declaration), so
      // this still proves the committed preset is a fresh generation.
      run(['--presets-dir', join(repoRoot, 'tests', 'fixtures'), '--out-dir', outDir])
      const fresh = readFileSync(join(outDir, 'standard-rollover', 'agent.cordis.yml'), 'utf8')
      const committed = readFileSync(join(repoRoot, 'presets', 'standard-rollover', 'agent.cordis.yml'), 'utf8')
      expect(fresh).toBe(committed)
      const freshMeta = readFileSync(join(outDir, 'standard-rollover', 'preset.yml'), 'utf8')
      const committedMeta = readFileSync(join(repoRoot, 'presets', 'standard-rollover', 'preset.yml'), 'utf8')
      expect(freshMeta).toBe(committedMeta)
    } finally {
      rmSync(outDir, { recursive: true, force: true })
    }
  })

  it('the shipped preset keeps no tail: handoffOnly is true and no tail budget is set', () => {
    // The handoff-only contract is the preset's whole point, and it is a
    // boolean rather than a tiny tail budget: `retainTokens: 0` was measured
    // to keep the last surface node.
    const committed = readFileSync(
      join(repoRoot, 'presets', 'standard-rollover', 'agent.cordis.yml'),
      'utf8',
    )
    expect(committed).toContain('handoffOnly: true')
    expect(committed).not.toContain('handoffOnly: false')
  })

  it('renders handoffOnly on, and accepts an explicit false, and rejects a non-boolean', () => {
    const { presetsDir, outDir, cleanup } = scratch(standardFixture())
    try {
      run(['--presets-dir', presetsDir, '--out-dir', outDir])
      const generated = readFileSync(join(outDir, 'standard-rollover', 'agent.cordis.yml'), 'utf8')
      expect(generated).toContain('handoffOnly: true')
      // A tail budget can still be requested for a deployment that wants one.
      run(['--presets-dir', presetsDir, '--out-dir', outDir, '--handoff-only', 'false'])
      expect(readFileSync(join(outDir, 'standard-rollover', 'agent.cordis.yml'), 'utf8'))
        .toContain('handoffOnly: false')
      // A typo must fail loud rather than render a truthy string into YAML.
      expect(() => run(['--presets-dir', presetsDir, '--out-dir', outDir, '--handoff-only', 'yes']))
        .toThrow(/--handoff-only must be true or false/)
    } finally {
      cleanup()
    }
  })

  it('a copy of the shipped preset keeps the 40% reminder and its message', () => {
    // Equality with a fresh generation would still hold if the generator and
    // the committed preset both regressed to the old defaults, so the values
    // the ticket requires are asserted directly on the committed artifact.
    const committed = readFileSync(
      join(repoRoot, 'presets', 'standard-rollover', 'agent.cordis.yml'),
      'utf8',
    )
    expect(committed).toContain('reminderThresholdRatio: 0.4\n')
    expect(committed).toContain('thresholdRatio: 0.9\n')
    // The message renders as a YAML double-quoted scalar, so parse it back the
    // way a config loader would rather than matching the rendered line.
    const line = committed.split('\n').find(candidate => candidate.trimStart().startsWith('reminderMessage: '))
    if (line === undefined) throw new Error('the preset engine row carries no reminderMessage')
    const rendered = JSON.parse(line.trimStart().slice('reminderMessage: '.length)) as string
    expect(rendered).toContain('/handoff-doc')
    expect(rendered).toContain('new_context')
    expect(rendered).toContain('{percent}')
  })

  it('the repo fixture is the shipped standard shape the generator expects', () => {
    // The sync's anchor row is the contract between the fixture and the
    // generator: if either drifts, the sync above fails loud instead of the
    // committed preset silently becoming un-reproducible.
    const source = readFileSync(join(repoRoot, 'tests', 'fixtures', 'standard', 'agent.cordis.yml'), 'utf8')
    expect(source).toContain(
      `- id: compaction\n  name: cordis:group\n  group: true\n  isolate:\n`
      + `    compaction: true\n    toolResultPruner: true\n  config:\n`,
    )
    expect(source.match(/^ {4}- id: compaction-basic\n {6}name: '@deepseek-ai\/dsh-compaction-basic'$/gm)).toHaveLength(1)
    // The generated preset is the fixture's own bytes with only the engine row
    // swapped: everything before the swap must survive untouched.
    const [sourceHead] = source.split('    - id: compaction-basic')
    const [committedHead] = readFileSync(
      join(repoRoot, 'presets', 'standard-rollover', 'agent.cordis.yml'),
      'utf8',
    ).split('    # Generated by dsh-context-rollover')
    expect(committedHead).toBe(sourceHead)
  })

  it('registers the installed presets dir through a profile-relative expression', () => {
    // The patch keeps its expression on one line; the capture below fails
    // loud if anyone wraps it, instead of silently testing a stale copy.
    const patch = readFileSync(join(repoRoot, 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('default: standard')
    expect(patch).toContain('includeShippedRoot: true')
    expect(patch).toContain('includeUserRoot: true')
    expect(patch).toContain('trust: system')
    const line = patch.split('\n').find(candidate => candidate.includes('path: !!js '))
    if (line === undefined) throw new Error('bundle patch has no !!js preset-root path')
    const expr = line.slice(line.indexOf('path: !!js ') + 'path: !!js '.length).trim()
    // baseUrl is the profile directory at boot; the expression must resolve
    // the installed package's presets dir from it in any install layout.
    // (Drive-letter URL: fileURLToPath rejects drive-less URLs on Windows.)
    const base = 'file:///C:/fake-profiles/web/'
    const resolved = evaluate({ baseUrl: base }, expr)
    const expected = fileURLToPath(new URL('node_modules/dsh-context-rollover/presets/', base))
    expect(resolved).toBe(expected)
  })
})
