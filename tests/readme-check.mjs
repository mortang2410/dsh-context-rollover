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
// The manual-path sentence this check needs, and the automatic-path wording the
// README replaced: the automatic path commits the compiled copy, not the notes
// checkpoint. Both strings are split so this file never states the claim itself.
const MANUAL_CLAIM = 'manual path is what composes the notes ' + 'checkpoint'
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
/**
 * Each guarantee the mutation check breaks, with the word the README names it by
 * and the specimen of source text that mutation removes.
 */
const MUTATION_WORDS = [
  { word: 'frame', label: 'framed', removed: 'the frame of the composed copy' },
  { word: 'cap', label: 'half-the-span cap', removed: 'the half-the-span ceiling' },
  { word: 'includeReasoning', label: 'leave-out', removed: 'the blocks the compiler leaves out, which come back with includeReasoning' },
]

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

/** Whether one sentence names one path by its usual label. */
function namePath(sentence, label) {
  return new RegExp(label.replace(/ /g, '[- ]?'), 'i').test(sentence)
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
    fail(`the compiled-copy section never introduces the ${backticked(READ_BACK_TOOLS[0])} or ${backticked(READ_BACK_TOOLS[1])} lookup rules`)
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
  // Each guarantee the mutation script breaks, named in the section, and a label
  // of its own: a guarantee shares no word with another label, so removing one
  // fails one check rather than several.
  for (const guarantee of MUTATION_WORDS) {
    // Each check names its specimen, so removing one anchored word fails one
    // check rather than several under one sentence.
    if (!section.includes(guarantee.word)) {
      // The specimen and the check's closing words sit around the anchor, so
      // removing the anchor leaves traces of both in the failure line: its spec
      // config key must still be named here, for the mutation check to read.
      const removed = `${guarantee.label} guarantee, dropping ${guarantee.removed}`
      fail(`the compiled-copy section never names the ${removed}; a reader cannot tell which guarantee is missing`)
    }
  }
  // What the script does with the sources it edits.
  if (!word('restores').test(section)) {
    fail('the compiled-copy section never says the mutation check restores the sources it edits')
  }
}

// The README may never claim the automatic path commits a notes checkpoint: the
// compiled copy is what it commits, and only the manual path keeps that wording.
// A claim fails when the noun phrase before its clause names that path, and it
// fails when its own clause names no path at all, so a claim stated bare on a
// line after a manual sentence cannot borrow that sentence's exemption. A claim
// that names the manual path is the only one that passes.
// The phrases that name a path, searched case-insensitively: `it` is matched
// apart so an ordinary word never reads as a label.
const LABEL_PHRASES = [
  'manual path', 'manual rollover', 'manual', 'compiled copy', 'compiled-copy',
  'automatic path', 'automatic rollover', 'rollover point', 'rollover', 'it',
  '`/compact`', '/compact',
]
const pathFragment = (match) => match[0].trim().replace(/^\W+|\W+$/g, '').toLowerCase()
const isAutomaticPath = (fragment) => /automatic|automatic path|rollover|rollover point|compiled/.test(fragment)
const isManualPath = (fragment) => /manual|compact/.test(fragment)
const claims = text
  .split(/\n\s*\n/)
  // A semicolon starts a new claim inside the same sentence, so each claim keeps
  // the sentence and the paragraph it came from and reads their labels for context.
  .flatMap(paragraph => paragraph
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?]) /)
    .flatMap(sentence => sentence.split('; ').map(claim => ({ claim, sentence, paragraph }))))

claims.forEach(({ claim: clause, sentence, paragraph }, index) => {
  const claim = clause.search(/notes checkpoint/i)
  // A code block that lists the three paths side by side labels them as a table,
  // so a line there is read by its own label rather than by the last one above.
  const isListed = paragraph.split('\n').some(line => line.trim().startsWith('```'))
  if (isListed) {
    if (claim !== -1 && !isManualPath(clause)) {
      fail(`clause ${index + 1} claims a notes checkpoint outside the manual path: ${clause.slice(0, 160)}`)
    }
    return
  }
  if (claim === -1) return
  // The closest path label before the claim, and the nearest one after it up to
  // the first comma, question mark or exclamation mark.
  const labelAt = (span) => {
    const named = LABEL_PHRASES.flatMap(phrase => {
      const matcher = phrase === 'it' ? /\bIt\b/g : new RegExp(phrase.replace(/[./]/g, '\\$&'), 'gi')
      return [...span.matchAll(matcher)]
    })
    return named.sort((left, right) => left.index - right.index).at(-1)
  }
  // A path named by the sentence's own "automatic", "rollover" or "compiled" word
  // is automatic wherever it sits, counted from the "on the <label> path" list on:
  // that list names objects, not the path committing the checkpoint. A sentence
  // that reaches a path and then claims a checkpoint for it counts all of its words.
  const objectLabel = [...clause.slice(0, claim).matchAll(/on the ([^,]+?) path\b/gi)].at(-1)
  const pathWord = [...clause.slice(0, claim).matchAll(/automatic|rollover|compiled/gi)].at(-1)
  const namedPath = clause.slice(0, claim).search(/(automatic|rollover|compiled|manual|compact)[^.]*\b(?:it|this|the path|that path)\b/i) !== -1
  const automaticBefore = pathWord !== undefined
    && (namedPath || (objectLabel !== undefined && pathWord.index >= objectLabel.index))
  const beforeRaw = automaticBefore
    ? undefined
    : objectLabel
      ? labelAt(clause.slice(0, objectLabel.index))
      : labelAt(clause.slice(0, claim))
  // A pronoun carries the nearest path the paragraph named before it, so "The
  // automatic path reaches the threshold. It commits a notes checkpoint." fails.
  const contextLabel = beforeRaw !== undefined && pathFragment(beforeRaw) === 'it'
    ? labelAt(paragraph.slice(0, paragraph.indexOf(clause)))
    : undefined
  const before = contextLabel ?? beforeRaw
  const after = clause.slice(claim).search(/[,?!]\s/)
  const tailStart = after === -1 ? clause.length : claim + after
  const following = labelAt(clause.slice(claim, tailStart))
  // An automatic label wins wherever a later label sits: a trailing mention of
  // another path never excuses "the automatic path commits a notes checkpoint
  // even though the manual path ...". A clause with no label of its own takes the
  // label of the paragraph's text before it, and the inline list of the three
  // paths is skipped there, since its labels read as a table rather than a claim.
  const automaticLabel = before !== undefined && !objectLabel && isAutomaticPath(pathFragment(before))
  if (automaticBefore || automaticLabel) {
    fail(`clause ${index + 1} attaches a notes checkpoint to the automatic path: ${clause.slice(0, 160)}`)
    return
  }
  if (following !== undefined && isAutomaticPath(pathFragment(following))) {
    fail(`clause ${index + 1} attaches a notes checkpoint to the automatic path: ${clause.slice(0, 160)}`)
    return
  }
  if (before === undefined && following === undefined) {
    const inherited = labelAt(paragraph.slice(0, paragraph.indexOf(clause)))

    if (inherited !== undefined && isAutomaticPath(pathFragment(inherited))) {
      fail(`clause ${index + 1} continues the automatic path's notes checkpoint: ${clause.slice(0, 160)}`)
      return
    }
  }
  // What passes is the manual path, in plain words or as `/compact`; or a pronoun
  // that hands the clause to the previous sentence's path; or a mention of the
  // read-back tools that put the log back in reach, the only object the README
  // gives a notes checkpoint anywhere.
  const handsBack = READ_BACK_TOOLS.some(tool => word(tool).test(clause))
  const manual = following !== undefined
    ? isManualPath(pathFragment(following))
    : before === undefined
      ? false
      : isManualPath(pathFragment(before)) || pathFragment(before) === 'it'
  if (!manual && !handsBack) {
    fail(`clause ${index + 1} claims a notes checkpoint outside the manual path: ${clause.slice(0, 160)}`)
  }
})
// One sentence names the manual path as the notes-checkpoint path, in that order.
if (!claims.some(({ claim }) => claim.includes(MANUAL_CLAIM))) {
  fail(`README never says the ${MANUAL_CLAIM}`)
}

if (failures.length > 0) {
  console.error(`readme-check: FAIL (${failures.length}) in ${README}`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(
  `readme-check: OK (${COMPILER_KEYS.length} keys, ${READ_BACK_TOOLS.length} tools, `
  + `${MUTATION_WORDS.length} guarantees, no automatic notes-checkpoint claim) in ${README}`,
)
