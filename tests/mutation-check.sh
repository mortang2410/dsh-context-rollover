#!/usr/bin/env bash
# The mutation check for the forced rollover's end-to-end proof (ticket `42ka`).
#
# Each mutation removes exactly one guarantee from the production source and
# requires the named end-to-end spec to fail for that reason. A mutation the spec
# survives means the guarantee sits on production code no test holds down.
#
# The three source mutations, each anchored on an exact count of its text so a
# refactor that moves the anchor fails the check instead of silently mutating
# nothing:
#   compiled-marker  the composed replacement loses the compiled frame and the
#                    recall guide  -> "crosses the rollover point" fails at
#                                      `expect(replacementText).toContain(CHECKPOINT_OPEN_TAG)`
#                                      or `RECALL_GUIDE`
#   log-position     the compiled copy stops rendering log positions (the
#                    cut markers keep the words a later append moves)
#                    -> the same test fails at `expect(logPositions.length).toBeGreaterThan(0)`
#   cap-shrink       the compiler cap loses its half-the-span ceiling
#                    -> "compiles a copy that would outsize its span down to the
#                       half-the-span cap" fails at
#                       `expect(built.text.length).toBeLessThan(sourceTokens * 4 / 2)`:
#                       the composer hands the compiler the whole span's tokens
#
# The fourth check mutates no source. It copies the README into scratch, drops every
# anchored word `tests/readme-check.mjs` asserts from its section, and requires each
# dropped word to be named by a failure line; then it asks the same check to reject a
# README with no such section, and to accept the real one. That is what keeps the
# README check from passing everything.
#
# Every edit is a byte-level backup plus a `python3` whole-string replacement with
# an asserted occurrence count, never a `sed` expression: the frame deletion spans
# several lines and `sed -i -E` mangled it. The backup is restored on every exit,
# interrupts included, and the touched files must match the commit afterwards.
#
# Bounds: every command runs under `timeout`, nothing runs in the background,
# scratch lives under ~/Trash/forced-rollover-vcc/42ka/, and the script exits
# nonzero when a mutation survives, fails for another reason, or the tree is left
# different from the commit.
#
# Usage: bash tests/mutation-check.sh

set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

SPEC_PATH="tests/forced-rollover-e2e.spec.ts"
SOURCE_FILES=(src/compiled-fallback.ts src/vcc/compiler.ts src/vcc/cap.ts)
README_CHECK="tests/readme-check.mjs"
WORK_DIR="${MUTATION_WORK_DIR:-/home/wilder/Trash/forced-rollover-vcc/42ka/mutation-check}"
BACKUP_DIR="$WORK_DIR/backup"
LOG_DIR="$WORK_DIR/logs"
VITEST_TIMEOUT_SECONDS="${VITEST_TIMEOUT_SECONDS:-180}"

# ---- safety: the touched sources must match the commit -------------------------

dirty_sources() {
  git status --porcelain -- "${SOURCE_FILES[@]}"
}

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "mutation-check: not inside a git work tree; cannot prove the sources restore" >&2
  exit 2
fi
if [ -n "$(dirty_sources)" ]; then
  echo "mutation-check: refusing to start, these production files are not committed:" >&2
  dirty_sources | sed 's/^/  /' >&2
  exit 2
fi
for file in "${SOURCE_FILES[@]}"; do
  if [ ! -f "$file" ]; then
    echo "mutation-check: missing source file $file" >&2
    exit 2
  fi
done

# ---- scratch and backups --------------------------------------------------------

# Move an interrupted earlier run's leftovers beside this run's scratch instead
# of deleting them, so the run starts fresh and nothing is lost. Each one is
# renamed individually, so a whole directory can never be moved into itself.
mkdir -p "$WORK_DIR"
for entry in "$WORK_DIR"/*; do
  if [ -e "$entry" ] || [ -L "$entry" ]; then
    mv -- "$entry" "$WORK_DIR/stale-$(date +%s%N)-$(basename "$entry")"
  fi
done
mkdir -p "$BACKUP_DIR" "$LOG_DIR"
sha256sum -- "$SPEC_PATH" "$README_CHECK" >"$WORK_DIR/deliverables.sha"
for file in "${SOURCE_FILES[@]}"; do
  mkdir -p "$BACKUP_DIR/$(dirname "$file")"
  cp -- "$file" "$BACKUP_DIR/$file"
done

# One restore path, run by every exit: successful, failed, and interrupted.
restore_sources() {
  local status=$?
  for file in "${SOURCE_FILES[@]}"; do
    if ! cmp -s -- "$BACKUP_DIR/$file" "$file"; then
      cp -- "$BACKUP_DIR/$file" "$file"
      echo "mutation-check: restored $file from the backup" >&2
    fi
  done
  return $status
}
trap restore_sources EXIT
trap 'exit 130' INT TERM

# ---- the mutations ------------------------------------------------------------
#
# A mutation is a file, the exact old text, the exact new text and the number of
# occurrences the old text must have. Applied with `python3`, which exits nonzero
# when the count does not match; the edit then never happens silently.

apply_replacement() {
  local file=$1 old=$2 new=$3 count=$4
  python3 - "$file" "$old" "$new" "$count" <<'PY'
import sys
from pathlib import Path

path, old, new, count = Path(sys.argv[1]), sys.argv[2], sys.argv[3], int(sys.argv[4])
text = path.read_text(encoding='utf-8')
found = text.count(old)
if found != count:
    raise SystemExit(f'mutation-check: expected {count} occurrence(s) of the anchor in {path}, found {found}')
path.write_text(text.replace(old, new), encoding='utf-8')
PY
}

names=(); files=(); olds=(); news=(); counts=(); expectations=(); titles=()

# One mutation: the file it edits, the exact text it removes, the exact text it
# puts there, how many occurrences that text has, the spec test it must break, and
# the assertion behind that test, written `branch|part;part`: `branch` is the name
# the failure must be reported under, `m=<matcher>` matches the summary line vitest
# prints under the `×` row for a failed matcher, and `s=<text>` matches a summary
# line carrying that text. The runner reads only those summary lines.
add_mutation() {
  names+=("$1"); files+=("$2"); counts+=("$3"); titles+=("$6")
  olds+=("$(printf '%b' "$4")")
  news+=("$(printf '%b' "$5")")
  expectations+=("$7")
}

# compiled-marker: the frame and guide the compiled format carries. The anchor is
# the composer's whole frame statement with its line break written as \n, so it
# never depends on the quoting a shell would rewrite.
add_mutation compiled-marker src/compiled-fallback.ts 1 \
  'const text = frameCheckpoint(body).map(block => block.text).join(\x27\\n\\n\x27)' \
  'const text = body.map(entry => (typeof entry === \x27string\x27 ? entry : entry.text)).join(\x27\\n\\n\x27)' \
  "crosses the rollover point" "toContain|m=toContain;s=CHECKPOINT_OPEN_TAG;s=RECALL_GUIDE"

# log-position: the `(seq N)` position every compiled row carries.
add_mutation log-position src/vcc/compiler.ts 1 \
  'function seqRef(seq: number): string {\n  return `seq ${seq}`\n}\n\n/**\n * One-line pointer standing in for an elided instruction block. Carries the seq\n * so the agent can `recall` the original, plus what it was and how big it was \xe2\x80\x94' \
  'function seqRef(seq: number): string {\n  return \x27its position\x27\n}\n\n/**\n * One-line pointer standing in for an elided instruction block. The agent can `recall` the original, plus what it was and how big it was \xe2\x80\x94' \
  "crosses the rollover point" "toBeGreaterThan|m=toBeGreaterThan;s=logPositions.length"

# cap-shrink: the half-the-span ceiling on the compiler cap.
add_mutation cap-shrink src/vcc/cap.ts 1 \
  'const cap = Math.min(checkpointCap, half)' \
  'const cap = checkpointCap' \
  "half-the-span cap" "toBeLessThan|m=toBeLessThan;s=sourceTokens"

run_mutation() {
  local index=$1
  local name=${names[$index]} file=${files[$index]}
  local log="$LOG_DIR/$name.log"
  local rc=0

  # Install the mutation.
  if ! apply_replacement "$file" "${olds[$index]}" "${news[$index]}" "${counts[$index]}" 2>"$LOG_DIR/$name.apply.err"; then
    echo "mutation-check: FAIL $name could not be applied:" >&2
    sed 's/^/  /' "$LOG_DIR/$name.apply.err" >&2
    status+=("fail"); return
  fi

  # Prove the mutation landed before running the spec.
  if cmp -s -- "$BACKUP_DIR/$file" "$file"; then
    echo "mutation-check: FAIL $name did not change $file" >&2
    status+=("fail"); return
  fi

  timeout --kill-after=10s "${VITEST_TIMEOUT_SECONDS}s" \
    npx vitest run "$SPEC_PATH" -t "${titles[$index]}" >"$log" 2>&1 || rc=$?

  # Restore before anything else can fail.
  cp -- "$BACKUP_DIR/$file" "$file"

  if [ $rc -eq 124 ] || [ $rc -eq 137 ]; then
    echo "mutation-check: FAIL $name timed out after ${VITEST_TIMEOUT_SECONDS}s (log: $log)" >&2
    status+=("fail"); return
  fi
  if [ $rc -eq 0 ]; then
    echo "mutation-check: FAIL $name survived; \"${titles[$index]}\" passed with the guarantee removed (log: $log)" >&2
    status+=("fail"); return
  fi
  # The spec must have failed, not crashed on import or on a missing fixture.
  if ! grep -qE '^\s+(×|✗)' "$log"; then
    echo "mutation-check: FAIL $name broke the run before the test ran; no failing assertion in the log (log: $log)" >&2
    status+=("fail"); return
  fi
  # And it must fail on the assertion that pins this guarantee, not something else.
  # The evidence is the failing test's own summary line, the `→ received` line
  # vitest prints under the `×` row: the stack and the adjacent code frame quote
  # the whole test body, later assertions included, so reading them would accept a
  # failure on any other line. Each expectation is branch, matcher, message.
  local expectation=${expectations[$index]}
  local branch=${expectation%|*} internal=${expectation#*|}
  local marker="" hit=""
  while IFS= read -r marker; do
    case $marker in
      *m=*)
        if grep -qE -- '^[[:space:]]+→.*[[:alnum:]_]\('"${marker#*m=}"'\)' "$log"; then hit="$marker"; fi
        ;;
      *s=*)
        if grep -qF -- "${marker#*s=}" "$log"; then hit="$marker"; fi
        ;;
    esac
    if [ -n "$hit" ]; then break; fi
  done <<<"$(printf '%s' "$internal" | tr ';' '\n')"
  if [ -z "$hit" ]; then
    echo "mutation-check: FAIL $name failed for another reason; no failing assertion names ${internal//;/ or } as ${branch} (log: $log)" >&2
    status+=("fail"); return
  fi
  local assertions
  assertions=$(grep -cE '^\s+(×|✗)' "$log" || true)
  echo "mutation-check: killed $name ($assertions failing assertion(s); the failing line names $hit)"
  status+=("killed")
}

# ---- the README check mutates no source -----------------------------------------

run_readme_check() {
  local name="readme-check-anchors"
  local good="$WORK_DIR/README.real.md"
  local broken="$WORK_DIR/README.broken.md"
  local missing="$WORK_DIR/README.missing.md"
  cp -- README.md "$good"
  # Every anchor the README check asserts is dropped from the real README, one
  # replacement each, and each removed anchor must come back as a failure line
  # naming it. The list is kept here, beside the check it proves, and the script
  # fails loudly when the README stops carrying one of them.
  python3 - "$good" "$broken" "$WORK_DIR/README.anchors" <<'PY'
import sys
from pathlib import Path
text = Path(sys.argv[1]).read_text(encoding='utf-8')
heading = '### Automatic path: the compiled copy'
start = text.find(heading)
end = text.find('\n### ', start + len(heading)) if start != -1 else -1
if start == -1:
    raise SystemExit('mutation-check: the README has no compiled-copy section to mutate')
# Only the section is written out: the check reads it from the heading, and a
# short file keeps the evidence about the removed anchors alone.
section = text[start:end if end != -1 else len(text)]
tip = chr(96)
anchors = [tip + 'recall' + tip + ' or ' + tip + 'search' + tip + ' lookup', 'half-the-span cap',
           tip + 'search' + tip, tip + 'recall' + tip, 'type: "' + tip + 'seq' + tip + '"',
           'frame', 'restores', 'includeReasoning']
broken = section
dropped = []
for anchor in anchors:
    if anchor not in broken:
        raise SystemExit(f'mutation-check: the README section no longer carries {anchor!r}, so the check cannot prove it')
    broken = broken.replace(anchor, '', 1)
    dropped.append(anchor)
Path(sys.argv[3]).write_text('\n'.join(dropped), encoding='utf-8')
Path(sys.argv[2]).write_text(broken, encoding='utf-8')
print('mutation-check: README anchors removed:', ', '.join(dropped))
PY
  # A file with no such section at all.
  python3 - "$missing" <<'PY'
import sys
from pathlib import Path
path = Path(sys.argv[1])
path.write_text('# README without the compiled-copy section\n', encoding='utf-8')
PY

  local rc=0
  timeout 60s node "$README_CHECK" "$broken" >"$LOG_DIR/$name.broken.log" 2>&1 || rc=$?
  if [ $rc -eq 0 ]; then
    echo "mutation-check: FAIL $name survived; the check passed a README with an anchor removed (log: $LOG_DIR/$name.broken.log)" >&2
    python3 - "$broken" >"$WORK_DIR/README.full.md" <<'PY'
import sys
from pathlib import Path
real = Path('README.md').read_text(encoding='utf-8')
broken = Path(sys.argv[1]).read_text(encoding='utf-8')
heading = '### Automatic path: the compiled copy'
start = real.find(heading)
end = real.find('\n### ', start + len(heading)) if start != -1 else -1
sys.stdout.write(real[:start] + broken + real[end if end != -1 else len(real):])
PY
    echo "mutation-check: the same anchors inside the whole README are at $WORK_DIR/README.full.md; running the check on it" >&2
    rc=0
    timeout 60s node "$README_CHECK" "$WORK_DIR/README.full.md" >"$LOG_DIR/$name.survived.log" 2>&1 || rc=$?
    echo "mutation-check: the whole README exits $rc there (log: $LOG_DIR/$name.survived.log)" >&2
    status+=("fail"); return
  fi
  if ! grep -q 'readme-check: FAIL' "$LOG_DIR/$name.broken.log"; then
    echo "mutation-check: FAIL $name broke the check instead of failing it; its log has no failure line" >&2
    status+=("fail"); return
  fi
  # Every anchor the mutation removed must be named by one of the failure lines,
  # so a check that passes everything but one word cannot survive this either. The
  # leave-out guarantee is asserted apart because its failure line has to quote
  # the config key rather than a word the section states.
  local anchor missing_anchor=""
  while IFS= read -r anchor; do
    if [ -n "$anchor" ] && ! grep -qF -- "$anchor" "$LOG_DIR/$name.broken.log"; then
      missing_anchor="$anchor"
      break
    fi
  done <"$WORK_DIR/README.anchors"
  if ! grep -qF -- 'includeReasoning' "$LOG_DIR/$name.broken.log"; then
    echo "mutation-check: FAIL $name never reported the removed includeReasoning mention (log: $LOG_DIR/$name.broken.log)" >&2
    status+=("fail"); return
  fi
  if [ -n "$missing_anchor" ]; then
    echo "mutation-check: FAIL $name never reported the removed anchor \"$missing_anchor\" (log: $LOG_DIR/$name.broken.log)" >&2
    status+=("fail"); return
  fi

  rc=0
  timeout 60s node "$README_CHECK" "$missing" >"$LOG_DIR/$name.missing.log" 2>&1 || rc=$?
  if [ $rc -eq 0 ] || ! grep -q 'has no' "$LOG_DIR/$name.missing.log"; then
    echo "mutation-check: FAIL $name never reported the missing section (log: $LOG_DIR/$name.missing.log)" >&2
    status+=("fail"); return
  fi

  rc=0
  timeout 60s node "$README_CHECK" "$good" >"$LOG_DIR/$name.real.log" 2>&1 || rc=$?
  if [ $rc -ne 0 ]; then
    echo "mutation-check: FAIL $name rejected the real README (log: $LOG_DIR/$name.real.log)" >&2
    sed 's/^/  /' "$LOG_DIR/$name.real.log" >&2
    status+=("fail"); return
  fi
  echo "mutation-check: killed $name; it rejected a broken and an absent section and passed the real README"
  status+=("killed")
}

status=()
for index in "${!names[@]}"; do
  run_mutation "$index"
done
names+=("readme-check-anchors")
run_readme_check

# ---- the verdict --------------------------------------------------------------

echo
echo "mutation summary:"
failed=0
for index in "${!names[@]}"; do
  echo "  ${names[$index]}: ${status[$index]}"
  if [ "${status[$index]}" != "killed" ]; then failed=$((failed + 1)); fi
done

# The production sources must be back to the committed state.
if [ -n "$(dirty_sources)" ]; then
  echo "mutation-check: FAIL the production files differ from the commit after restore:" >&2
  dirty_sources | sed 's/^/  /' >&2
  failed=$((failed + 1))
fi
# The spec and the README check keep their content across the run: comparing their
# hashes names a change the same way whether or not they are committed yet.
if command -v sha256sum >/dev/null 2>&1; then
  sha256sum -c --status "$WORK_DIR/deliverables.sha" || {
    echo "mutation-check: FAIL the spec or the README check changed during the run" >&2
    sha256sum -c "$WORK_DIR/deliverables.sha" >&2 || true
    failed=$((failed + 1))
  }
fi

# Earlier runs' leftovers were renamed aside, never deleted. They are scratch from
# the same task, and this run ends with verdicts of its own and a commit that keeps
# the evidence, so the nested copies are swept into the task's own Trash folder.
if [ -z "${MUTATION_KEEP_STALE:-}" ] && command -v find >/dev/null 2>&1; then
  find "$WORK_DIR" -mindepth 1 -maxdepth 1 -name 'stale-*' -exec mv -- {} /home/wilder/Trash/forced-rollover-vcc/42ka/mutation-stale/ \; 2>/dev/null || true
fi

if [ $failed -ne 0 ]; then
  echo "mutation-check: FAIL ($failed problem(s)); see $WORK_DIR" >&2
  exit 1
fi
echo "mutation-check: OK (all ${#names[@]} checks killed their target; tree clean)"
