/**
 * Provenance of the vendored VCC compiler (ticket sycr, requirement R9): the
 * copied files carry the upstream MIT notice and name the upstream project,
 * and the compiler stays dependency-free so the host's plugin compatibility
 * check never sees VCC's manifest.
 *
 * The import rule is asserted on the stripped source rather than on the file
 * text, so a comment that merely mentions a package name cannot pass it and a
 * real import cannot hide behind one.
 *
 * @module tests/vendored-provenance
 */

import { readFile } from 'node:fs/promises'
import { builtinModules } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const compilerPath = resolve(projectRoot, 'src/vcc/compiler.ts')
const noticePath = resolve(projectRoot, 'src/vcc/LICENSE')
const readmePath = resolve(projectRoot, 'src/vcc/README.md')

/** The compiler source as text. */
const source = await readFile(compilerPath, 'utf8')

/** The compiler source with comments removed: only code is left behind. */
function codeOnly(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

const code = codeOnly(source)
const bareSpecifiers = [...code.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '')
const sideEffectSpecifiers = [...code.matchAll(/\bimport\s+['"]([^'"]+)['"]/g)].map((match) => match[1] ?? '')

/** Node's module names without the `node:` alias, plus the aliases themselves. */
const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
  'node:test',
  'node:assert',
])

describe('the vendored compiler carries the upstream MIT notice', () => {
  it('ships VCC\'s MIT license text beside the vendored module', async () => {
    const notice = await readFile(noticePath, 'utf8')
    expect(notice.startsWith('MIT License')).toBe(true)
    expect(notice).toContain('Copyright (c) 2026 TsFreddie (original work: dsh-compaction-instant)')
    expect(notice).toContain('Copyright (c) 2026 Tingfeng (fork: dsh-compaction-vcc')
    expect(notice).toContain('Permission is hereby granted, free of charge')
    expect(notice).toContain('THE SOFTWARE IS PROVIDED "AS IS"')
    expect(notice).toContain('IN NO EVENT SHALL THE')
  })

  it('names the upstream project in the module header and the attribution file', async () => {
    const header = source.slice(0, source.indexOf('*/') + 2)
    expect(header).toContain('dsh-compaction-vcc@0.7.4')
    expect(header).toContain('https://github.com/tingfeng-droid/dsh-compaction-vcc')
    expect(header).toContain('Copied under the MIT licence')
    expect(header).toContain('src/vcc/LICENSE')
    const readme = await readFile(readmePath, 'utf8')
    expect(readme).toContain('https://github.com/tingfeng-droid/dsh-compaction-vcc')
    expect(readme).toContain('dsh-compaction-vcc@0.7.4')
    expect(readme).toContain('licence: MIT')
    expect(readme).toContain('src/vcc/LICENSE')
  })

  it('records the vendoring decisions in the attribution file', async () => {
    const readme = await readFile(readmePath, 'utf8')
    expect(readme).toContain('src/vcc/compiler.ts')
    expect(readme).toContain('tests/vcc-compiler.spec.ts')
    expect(readme).toContain('`CompileRole` accepts `tool`')
    expect(readme).toContain('toolCallId')
    expect(readme).toContain('node:test')
    expect(readme).toContain('node:assert/strict')
  })

  it('keeps the upstream declaration and test inventory documented', async () => {
    const readme = await readFile(readmePath, 'utf8')
    expect(readme).toContain('src/compiler.js')
    expect(readme).toContain('types/compiler.d.ts')
    expect(readme).toContain('test/compiler.test.js')
  })
})

describe('the vendored compiler imports nothing from outside itself', () => {
  it('imports nothing at all: the module has no import statement', () => {
    // A vendored copy may gain a relative import later; an external one never.
    expect(code).not.toMatch(/^\s*(?:import|export)\b[^\n]*\bfrom\s+['"]/m)
    expect([...bareSpecifiers, ...sideEffectSpecifiers]).toEqual([])
  })

  it('imports no @deepseek-ai package', () => {
    expect(bareSpecifiers.filter((specifier) => specifier.startsWith('@deepseek-ai/'))).toEqual([])
    expect(sideEffectSpecifiers.filter((specifier) => specifier.includes('@deepseek-ai'))).toEqual([])
  })

  it('imports no node builtin', () => {
    const external = [...bareSpecifiers, ...sideEffectSpecifiers]
    expect(external.filter((specifier) => nodeBuiltins.has(specifier))).toEqual([])
  })

  it('imports no package at all: every specifier is a relative module', () => {
    for (const specifier of [...bareSpecifiers, ...sideEffectSpecifiers]) {
      expect(specifier.startsWith('./') || specifier.startsWith('../')).toBe(true)
    }
  })

  it('proves the import check reads code, not comments', () => {
    // The header names the upstream project and the host; neither mention is
    // an import. Stripping comments must leave exactly one import.
    expect(source).toContain('@deepseek-ai')
    expect(source).toContain('imports nothing from the harness')
    const imports = [...code.matchAll(/^import\s/gm)]
    expect(imports).toEqual([])
    expect(codeOnly("import { x } from '@deepseek-ai/dsh-llm'")).toContain('@deepseek-ai/dsh-llm')
    expect(codeOnly("// a comment naming node:fs\nconst x = 1").includes('node:fs')).toBe(false)
  })
})
