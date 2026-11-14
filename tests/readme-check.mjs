/**
 * The README check (ticket `42ka`): it fails when the compiled-copy section
 * stops naming the two read-back tools, the lookup word a cut is found by, either
 * guarantee `tests/mutation-check.sh` breaks, or what that script does with the
 * sources it edits, and when any of the compiler's configuration keys disappears
 * from the README. It also fails if the README ever claims the automatic path
 * commits a notes checkpoint.
 *
 * The assertions name artifacts the other deliverables carry, not free prose, so
 * rewording a sentence passes while dropping a tool, a guarantee or a key fails.
 * Every section assertion is proven load-bearing by `tests/mutation-check.sh`,
 * which removes the anchored words one at a time and requires a failure line
 * naming each of them.
 *
 * Usage: `node tests/readme-check.mjs [path/to/README.md]`
 * Exit 0 means every assertion held; exit 1 lists each one that did not.
 */

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const README = resolve(dirname(fileURLToPath(import.meta.url)), '..', process.argv[2] ?? 'README.md')
const SECTION_HEADING = '### Automatic path: the compiled copy'
/** The keys the composer reads, plus the read-back budget it is spent under. */
const COMPILER_KEYS = [
  'checkpointCap',
  'assistantTextTokens',
  'userTextTokens',
  'toolCallTokens',
  'includeReasoning',
  'toolArgTools',
  'hideTools',
  'maxRecallTokens',
]
const READ_BACK_TOOLS = ['recall', 'search']
const MANUAL_MARKERS = ['Manual `/compact`', 'manual `/compact`']
/** Each guarantee the mutation check breaks, as a word the README names it by. */
const MUTATION_WORDS = ['frame', 'cap']

const BACKTICK = String.fromCharCode(96)

/** Every failure the check found, one line each. */
const failures = []

/**
 * Record one failed assertion.
 * @param {string} message - what the README lacks.
 */
function fail(message) {
  failures.push(message)
}

/** A backticked name, the form both the tools and the lookup word are written in. */
function backticked(name) {
  return `${BACKTICK}${name}${BACKTICK}`
}

/** A regular expression matching a whole word, whatever its surroundings. */
function word(name) {
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
}

/** The README text, split into the compiled-copy section and the rest. */
const text = readFileSync(README, 'utf8')
const sectionStart = text.indexOf(SECTION_HEADING)
const sectionEnd = text.indexOf('\n### ', sectionStart + SECTION_HEADING.length)
const section = sectionStart === -1
  ? ''
  : text.slice(sectionStart, sectionEnd === -1 ? text.length : sectionEnd)

if (sectionStart === -1) fail(`README has no "${SECTION_HEADING}" heading`)

if (section) {
  // The section's prose carries each anchored word exactly once, so the mutation
  // check can remove it with one replacement and read the failure it causes.
  if (!new RegExp(`(?:^|[^\\w-])compiled(?:$|[^\\w-])`, 'm').test(section)) {
    fail('the compiled-copy section never says "compiled"')
  }
  if (!/fallback|automatic rollover/i.test(section)) {
    fail('the compiled-copy section never names the automatic path it describes')
  }
  for (const key of COMPILER_KEYS) {
    // A table row: | `key` | default | what it bounds |
    if (!new RegExp(`\\|\\s*${backticked(key)}\\s*\\|`).test(section)) {
      fail(`the compiled-copy section has no configuration row for ${backticked(key)}`)
    }
    if (!word(key).test(text)) fail(`README never names ${backticked(key)}`)
  }
  // The pair sentence that introduces both tools, so dropping it fails even when
  // each name still appears further down.
  if (!section.includes(`${backticked(READ_BACK_TOOLS[0])} or ${backticked(READ_BACK_TOOLS[1])} lookup`)) {
    fail(`the compiled-copy section never introduces the ${backticked(READ_BACK_TOOLS[0])} or ${backticked(READ_BACK_TOOLS[1])} lookup budget`)
  }
  for (const tool of READ_BACK_TOOLS) {
    // The tool as a mention of its own, inline rather than bold in a list.
    if (!section.includes(backticked(tool))) {
      fail(`the compiled-copy section never names the ${backticked(tool)} tool`)
    }
    if (!text.includes(`**${backticked(tool)}**`)) {
      fail(`README never lists the ${backticked(tool)} tool in its tool list`)
    }
  }
  // The word a reader finds a cut by: the lookup argument of the read-back tool.
  if (!section.includes(`type: "${backticked('seq')}"`)) {
    fail(`the compiled-copy section never says a cut is found by the type: "${backticked('seq')}" lookup`)
  }
  // Each guarantee the mutation script breaks, named by its own word.
  for (const guarantee of MUTATION_WORDS) {
    if (!section.includes(guarantee)) {
      fail(`the compiled-copy section never names the ${guarantee} guarantee that the README mutation check breaks`)
    }
  }
  // What the script does with the sources it edits.
  if (!word('restores').test(section)) {
    fail('the compiled-copy section never says the mutation check restores the sources it edits')
  }
}

// The README may never claim the automatic path commits a notes checkpoint: the
// compiled copy is what it commits, and only the manual path keeps that wording.
const lines = text.split('\n')
lines.forEach((line, index) => {
  if (!/notes checkpoint/i.test(line)) return
  const manualNearby = /manual|`\/compact`/i.test(line)
    || (index > 0 && /manual|`\/compact`/i.test(lines[index - 1] ?? ''))
  if (!manualNearby) {
    fail(`line ${index + 1} claims a notes checkpoint outside the manual path: ${line.trim().slice(0, 120)}`)
  }
  if (/automatic/i.test(line)) {
    fail(`line ${index + 1} attaches a notes checkpoint to the automatic path: ${line.trim().slice(0, 120)}`)
  }
})

if (!MANUAL_MARKERS.some(marker => text.includes(marker))) {
  fail('README never says the manual path is what composes the notes checkpoint')
}

if (failures.length > 0) {
  console.error(`readme-check: FAIL (${failures.length}) in ${README}`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(
  `readme-check: OK (${COMPILER_KEYS.length} keys, ${READ_BACK_TOOLS.length} tools, `
  + `${MUTATION_WORDS.length} mutations, no automatic notes-checkpoint claim) in ${README}`,
)
