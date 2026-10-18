#!/usr/bin/env bash
# Regression coverage for jw argument validation. Never starts a real jcode.
set -euo pipefail

JW="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/jw"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export ORCH_ROOT="$tmp/orchestration"
unset CLAUDE_CODE_SESSION_ID
mkdir -p "$tmp/bin" "$tmp/repo"
cat > "$tmp/bin/jcode" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' '{"session_id":"test-session","text":"Argument validation completed."}'
EOF
chmod +x "$tmp/bin/jcode"
export PATH="$tmp/bin:$PATH"
git -C "$tmp/repo" init -q
git -C "$tmp/repo" -c user.name=Test -c user.email=test@example.invalid commit -q --allow-empty -m initial
printf 'Review this task.\n' > "$tmp/brief.md"
printf 'preserve me\n' > "$tmp/victim"

failures=0
checks=0
check() { # label expected_rc expected_message command...
  local label=$1 expected_rc=$2 expected_message=$3 output rc=0; shift 3
  checks=$((checks+1))
  output=$(bash "$JW" "$@" 2>&1) || rc=$?
  if [[ $rc == "$expected_rc" && $output == *"$expected_message"* ]]; then
    printf 'ok: %s\n' "$label"
  else
    printf 'FAIL: %s (expected exit %s and message %q, got exit %s)\n%s\n' \
      "$label" "$expected_rc" "$expected_message" "$rc" "$output" >&2
    failures=$((failures+1))
  fi
}

# Removing either parser's leading-dash guard breaks these checks.
for base in "--output=$tmp/victim" --stat -HEAD -; do
  check "run rejects base $base" 2 'jw: invalid --base:' \
    run --slug release --task W4 --repo "$tmp/repo" --no-worktree --base "$base" "$tmp/brief.md"
  check "review rejects base $base" 2 'jw: invalid --base:' \
    review --repo "$tmp/repo" --base "$base"
done
checks=$((checks+1))
if [[ $(cat "$tmp/victim") == 'preserve me' ]]; then
  echo 'ok: --base cannot overwrite a file'
else
  echo 'FAIL: --base overwrote a file' >&2
  failures=$((failures+1))
fi

# Removing component validation breaks each invalid-input check. Include
# repeated flags so an invalid value cannot be hidden by a later valid one.
for value in '../escape' 'a/escape' 'a..b' '..' '.' '-bad' '_bad' 'bad name' 'bad@name' $'bad\nname' ''; do
  for command in run resume; do
    if [[ $command == run ]]; then
      args=(--repo "$tmp/repo" --no-worktree "$tmp/brief.md")
    else
      args=(--cwd "$tmp/repo" test-session 'Continue the review.')
    fi
    check "$command rejects slug $(printf %q "$value")" 2 'jw: invalid --slug:' \
      "$command" --slug "$value" --slug release --task W4 "${args[@]}"
    check "$command rejects task $(printf %q "$value")" 2 'jw: invalid --task:' \
      "$command" --slug release --task "$value" --task W4 "${args[@]}"
  done
  check "init rejects slug $(printf %q "$value")" 2 'jw: invalid slug:' init "$value"
  check "post rejects slug $(printf %q "$value")" 2 'jw: invalid slug:' post "$value" W4 INFO 'test message'
  check "board rejects slug $(printf %q "$value")" 2 'jw: invalid slug:' board "$value"
done

# Positive controls exercise real invoke/status handling, not stub internals.
# Each supported punctuation character is valid except consecutive dots.
check 'run accepts revision and safe components' 0 'status:   ok' \
  run --slug Release_1.2-3 --task W4_1.2-ok --repo "$tmp/repo" --no-worktree --base HEAD "$tmp/brief.md"
check 'resume accepts safe components' 0 'status:   ok' \
  resume --slug Release_1.2-3 --task W4_1.2-ok --cwd "$tmp/repo" test-session 'Continue the review.'
check 'init accepts a safe slug' 0 'ledger:' init Release_1.2-3
check 'post accepts a safe slug' 0 'posted to' post Release_1.2-3 W4 INFO 'test message'
check 'board accepts a safe slug' 0 'INFO: test message' board Release_1.2-3

# A tracked file named HEAD makes an unseparated git diff HEAD ambiguous.
# Removing the revision/path separator makes this reach jcode instead of
# reporting the real, clean diff. After a change, review must reach invoke.
printf 'initial\n' > "$tmp/repo/HEAD"
git -C "$tmp/repo" add HEAD
git -C "$tmp/repo" -c user.name=Test -c user.email=test@example.invalid commit -q -m 'add revision-like filename'
check 'review treats HEAD as a revision, not a path' 2 'nothing to review: no changes vs HEAD and no untracked files' \
  review --repo "$tmp/repo" --base HEAD
printf 'changed\n' > "$tmp/repo/HEAD"
check 'review rejects an unknown base revision' 2 'jw: unknown --base revision: no-such-rev' \
  review --repo "$tmp/repo" --base no-such-rev
check 'review accepts a valid base with changes' 0 'status:   ok' review --repo "$tmp/repo" --base HEAD

printf '%s checks, %s failures\n' "$checks" "$failures"
(( failures == 0 ))
