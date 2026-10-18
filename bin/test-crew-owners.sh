#!/usr/bin/env bash
# Test: the owner registry and path routing (`crew owner add|rm`, `crew owners`, glob_match).
# Fake sessions live in a temp CREW_SESSIONS: the lead is this test shell (pid $$), a sub is a background sleeper that
# writes its own json, `as` runs one command inside a short-lived session. No tmux, no real crew root.
#   bash test-crew-owners.sh
set -uo pipefail

BIN=$(dirname "$(readlink -f "$0")")
CREW=$BIN/crew
T=$(mktemp -d)
BGS=""
trap 'kill $BGS 2>/dev/null; rm -rf "$T"' EXIT
export LC_ALL=C CREW_ROOT=$T/crew CREW_SESSIONS=$T/sessions CREW_PROJECTS=$T/projects CREW_NOW=2026-10-16T10:00:00Z CREW CREW_LEAD_COMM
export CREW_NOTIFY_CONFIG=$T/no-such-config CREW_NOTIFY_LOG=$T/notify.log   # no phone alert leaves the machine
export PATH="$BIN:$PATH"   # this checkout's crew-notify, never an older installed one
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
CREW_LEAD_COMM=$(cat /proc/$$/comm)
mkdir -p "$CREW_SESSIONS" "$CREW_PROJECTS" "$T/plain"
fails=0
EPOCH=1792144800   # CREW_NOW

check() { local desc=$1; shift; if "$@"; then echo "ok   $desc"; else echo "FAIL $desc"; fails=$((fails + 1)); fi; }
eq() { # description, expected, actual
  if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1"; printf '  expected: %s\n  actual:   %s\n' "$2" "$3"; fails=$((fails + 1)); fi
}
lead_json() { printf '{"pid":%s,"name":"%s","sessionId":"%s","cwd":"/x"}\n' "${3:-$$}" "$1" "$2" >"$CREW_SESSIONS/$2.json"; }
as() { # as NAME SID cmd...: run a command inside a short-lived session NAME/SID
  local name=$1 sid=$2; shift 2
  bash -c 'printf "{\"pid\":%s,\"name\":\"%s\",\"sessionId\":\"%s\"}\n" "$$" "$1" "$2" >"$CREW_SESSIONS/run-$2.json"; shift 2; "$@"' _ "$name" "$sid" "$@" 2>&1
}
LIVE_PID=""
live_sub() { # NAME SID [CWD]: a long-running process that is that session (LIVE_PID = its pid); CWD is the json's cwd key
  bash -c 'jq -nc --argjson pid "$$" --arg n "$1" --arg s "$2" --arg c "$3" "{pid: \$pid, name: \$n, sessionId: \$s} + (if \$c == \"\" then {} else {cwd: \$c} end)" >"$CREW_SESSIONS/bg-$2.json"; while :; do sleep 1; done' _ "$1" "$2" "${3:-}" &
  LIVE_PID=$!; BGS="$BGS $LIVE_PID"; sleep 0.3
}
run() { OUT=$("$@" 2>&1); RC=$?; }   # OUT and RC of a plain run (as the lead = this shell)
run_in() { local d=$1; shift; OUT=$(cd "$d" && "$@" 2>&1); RC=$?; }   # the same, with DIR as the cwd
rc_is() { [ "$RC" = "$1" ]; }
out_has() { grep -qF -- "$1" <<<"$OUT"; }
owner_has() { grep -qxF -- "$2" "$CREW_ROOT/.owners/$1/owner"; }

# --- glob_match: literal table (glob, path, expected 1 = match) ---
. "$BIN/crew-owners.sh"
glob_case() { # GLOB PATH WANT
  local got=0; glob_match "$1" "$2" && got=1
  eq "glob '$1' vs '$2' -> $3" "$3" "$got"
}
glob_case 'src/*.sh' 'src/a.sh' 1
glob_case 'src/*.sh' 'src/x/a.sh' 0
glob_case 'src/**' 'src/x/y.sh' 1
glob_case 'src/**' 'src/x' 1
glob_case 'src/**' 'src' 0
glob_case 'src/' 'src/x/y' 1
glob_case 'src/' 'src' 0
glob_case 'src/' 'srcx/a' 0
glob_case 'a.b' 'a.b' 1
glob_case 'a.b' 'aXb' 0
glob_case 'c++/x' 'c++/x' 1
glob_case 'a+' 'aa' 0
glob_case 'a?c' 'abc' 1
glob_case 'a?c' 'a/c' 0
glob_case 'a*' 'ab' 1
glob_case 'a*' 'a/b' 0
glob_case '**/x.ts' 'x.ts' 1
glob_case '**/x.ts' 'a/b/x.ts' 1
glob_case 'src/**/*.ts' 'src/a.ts' 1
glob_case 'src/**/*.ts' 'src/a/b/c.ts' 1
glob_case 'src/**/*.ts' 'src/a/b/c.js' 0
glob_case '[ab].c' 'a.c' 0
glob_case '[ab].c' '[ab].c' 1
glob_case '(x)|y' '(x)|y' 1
glob_case '(x)|y' 'y' 0
glob_case '^x$' 'x' 0
glob_case 'a\b' 'a\b' 1
glob_case 'my dir/*' 'my dir/a b' 1
glob_case '**' 'a/b/c' 1

# --- the cast: lead-a (this shell), subs worker-1 / worker-2, a joined owner-1 session, a stranger under lead-b ---
lead_json lead-a SID-A
live_sub lead-b SID-B
live_sub worker-1 SID-W; W1_PID=$LIVE_PID
live_sub worker-2 SID-W2
live_sub stranger SID-S
as worker-1 SID-W "$CREW" join lead-a >/dev/null
as worker-2 SID-W2 "$CREW" join lead-a >/dev/null
as owner-1 SID-O "$CREW" join lead-a >/dev/null
as ghost SID-G "$CREW" join lead-a >/dev/null    # joined, but its process is gone
as stranger SID-S "$CREW" join lead-b >/dev/null

REPO=$T/repo
mkdir -p "$REPO/src/a/deep" "$REPO/src/b" "$REPO/lib" "$REPO/docs/g"
git -C "$REPO" init -q
for f in src/a/x.c src/a/deep/q.c src/b/y.c lib/z.sh README.md docs/g/h.md; do echo base >"$REPO/$f"; done
git -C "$REPO" add -A
git -C "$REPO" commit -q -m base
REPO=$(realpath "$REPO")

# --- owners on an empty registry ---
run "$CREW" owners
eq "owners with no owners" "no owners" "$OUT"

# --- add: --sub (the caller is the lead) ---
run "$CREW" owner add alpha --paths 'src/a/**' 'lib/*.sh' --sub worker-1 --repo "$REPO"
eq "add --sub prints the summary" "owner alpha: worker-1 (lead lead-a), 2 globs, notes $CREW_ROOT/.owners/alpha/notes.md" "$OUT"
check "add --sub exits 0" rc_is 0
eq "owner file" "feature=alpha
repo=$REPO
path=src/a/**
path=lib/*.sh
sid=SID-W
name=worker-1
lead=lead-a
lead_sid=SID-A
notes=$CREW_ROOT/.owners/alpha/notes.md
state=awake
created=2026-10-16T10:00:00Z" "$(cat "$CREW_ROOT/.owners/alpha/owner")"
eq "notes.md first line" "# alpha — owner notes" "$(head -n 1 "$CREW_ROOT/.owners/alpha/notes.md")"
check "notes.md has guidance lines" grep -q 'Open threads' "$CREW_ROOT/.owners/alpha/notes.md"
check "no temp left in the registry" bash -c '[ -z "$(ls -A "$0"/.owners | grep -v "^alpha$")" ]' "$CREW_ROOT"

# --- add: by sessionId, repeated --paths, default session (the caller must have joined a lead) ---
run "$CREW" owner add gamma --paths 'src/**' --paths 'extra.txt' --sub SID-W2 --repo "$REPO"
eq "add --sub by sessionId, repeated --paths" "owner gamma: worker-2 (lead lead-a), 2 globs, notes $CREW_ROOT/.owners/gamma/notes.md" "$OUT"
OUT=$(as owner-1 SID-O "$CREW" owner add beta --paths 'src/b/' --paths 'docs/**/*.md' --repo "$REPO"); RC=$?
eq "add as the joined session itself" "owner beta: owner-1 (lead lead-a), 2 globs, notes $CREW_ROOT/.owners/beta/notes.md" "$OUT"
check "owner beta: lead is the session's parent" owner_has beta "lead_sid=SID-A"
check "owner beta: sid is the caller's" owner_has beta "sid=SID-O"

# --- add from inside the repo takes the repo from the cwd ---
OUT=$(cd "$REPO/src" && "$CREW" owner add delta --paths 'x/' --sub ghost 2>&1); RC=$?
check "a gone sub is refused (exit 3)" rc_is 3
check "a gone sub is not an owner" test ! -e "$CREW_ROOT/.owners/delta"
live_sub worker-3 SID-W3
as worker-3 SID-W3 "$CREW" join lead-a >/dev/null
OUT=$(cd "$REPO/src" && "$CREW" owner add delta --paths 'x/' --sub worker-3 2>&1); RC=$?
check "repo defaults to the cwd's toplevel" owner_has delta "repo=$REPO"
"$CREW" owner rm delta >/dev/null 2>&1

# --- add refusals ---
run "$CREW" owner add alpha --paths 'x/' --sub worker-3 --repo "$REPO"
check "duplicate id: exit 3" rc_is 3
check "duplicate id names the repo" out_has "repo $REPO"
check "duplicate id names the existing session" out_has "session worker-1"
check "duplicate id changed nothing" owner_has alpha "sid=SID-W"
OUT=$(as loner SID-L "$CREW" owner add eps --paths 'x/' --repo "$REPO"); RC=$?
check "a session that has joined no lead: exit 3" rc_is 3
check "...and says so" out_has "has not joined a lead"
run "$CREW" owner add eps --paths 'x/' --sub stranger --repo "$REPO"
check "--sub of another lead: exit 3" rc_is 3
check "...says it is not your live sub" out_has "not a live sub of yours"
run "$CREW" owner add eps --paths 'x/' --sub nobody --repo "$REPO"
check "--sub unknown: exit 3" rc_is 3
run "$CREW" owner add eps --paths '/etc/**' --sub worker-3 --repo "$REPO"
check "absolute glob: exit 3" rc_is 3
run "$CREW" owner add eps --paths 'src/../etc' --sub worker-3 --repo "$REPO"
check "'..' segment: exit 3" rc_is 3
run "$CREW" owner add eps --paths '..' --sub worker-3 --repo "$REPO"
check "'..' alone: exit 3" rc_is 3
run "$CREW" owner add eps --paths 'src/' '' --sub worker-3 --repo "$REPO"
check "empty glob: exit 3" rc_is 3
run "$CREW" owner add eps --sub worker-3 --repo "$REPO"
check "no --paths: exit 2" rc_is 2
run "$CREW" owner add 'Bad_ID' --paths 'x/' --sub worker-3 --repo "$REPO"
check "bad feature id: exit 2" rc_is 2
run "$CREW" owner add eps --paths 'x/' --sub worker-3 --repo "$T/nowhere"
check "--repo that does not exist: exit 2" rc_is 2
OUT=$(cd "$T/plain" && "$CREW" owner add eps --paths 'x/' --sub worker-3 2>&1); RC=$?
check "no --repo and cwd not a repo: exit 3" rc_is 3
check "none of the refused adds registered anything" bash -c '[ "$(ls "$0"/.owners | tr "\n" " ")" = "alpha beta gamma " ]' "$CREW_ROOT"

# --- two adds of one id at once: exactly one wins ---
"$CREW" owner add race --paths 'x/' --sub worker-3 --repo "$REPO" >/dev/null 2>&1 & p1=$!
"$CREW" owner add race --paths 'y/' --sub worker-3 --repo "$REPO" >/dev/null 2>&1 & p2=$!
wait $p1; r1=$?; wait $p2; r2=$?
eq "concurrent adds of one id: one exits 0, the other 3" "0 3" "$(printf '%s\n' "$r1" "$r2" | sort | paste -sd' ')"
eq "...and the registry holds one clean owner file" "1" "$(grep -c '^feature=race$' "$CREW_ROOT/.owners/race/owner")"
"$CREW" owner rm race >/dev/null 2>&1

# --- rm ---
OUT=$(as stranger SID-S "$CREW" owner rm beta); RC=$?
check "a session that is neither lead nor owner cannot rm: exit 3" rc_is 3
check "...beta is still registered" test -f "$CREW_ROOT/.owners/beta/owner"
OUT=$(as owner-1 SID-O "$CREW" owner rm beta); RC=$?
check "the owner session can rm itself" rc_is 0
check "...folder moved to .removed/<id>.<epoch>" test -f "$CREW_ROOT/.owners/.removed/beta.$EPOCH/owner"
check "...notes kept" test -f "$CREW_ROOT/.owners/.removed/beta.$EPOCH/notes.md"
check "...no longer registered" test ! -e "$CREW_ROOT/.owners/beta"
run "$CREW" owner rm nosuch
check "rm unknown owner: exit 2" rc_is 2
OUT=$(CREW_LEAD_COMM=not-a-claude "$CREW" owner rm gamma 2>&1); RC=$?
check "rm from a plain shell (not in a claude session) is allowed" rc_is 0
check "...gamma moved too" test -f "$CREW_ROOT/.owners/.removed/gamma.$EPOCH/owner"
live_sub owner-1 SID-O
run "$CREW" owner add beta --paths 'src/b/' --paths 'docs/**/*.md' --sub owner-1 --repo "$REPO"
check "re-adding a removed id works" rc_is 0
run "$CREW" owner add gamma --paths 'src/**' --paths 'extra.txt' --sub worker-2 --repo "$REPO"
check "re-adding gamma works" rc_is 0
run "$CREW" owner rm alpha
check "the lead can rm" rc_is 0
check "...alpha folder moved" test -f "$CREW_ROOT/.owners/.removed/alpha.$EPOCH/owner"
run "$CREW" owner add alpha --paths 'src/a/**' 'lib/*.sh' --sub worker-1 --repo "$REPO"
check "re-adding alpha works" rc_is 0

# --- owners: plain listing; an asleep owner in another repo is written by hand ---
mkdir -p "$T/other"; OTHER=$(realpath "$T/other")
mkdir -p "$CREW_ROOT/.owners/zeta"
printf 'feature=zeta\nrepo=%s\npath=other/**\nsid=SID-Z\nname=zed\nlead=lead-a\nlead_sid=SID-A\nnotes=%s\nstate=asleep\ncreated=2026-10-15T00:00:00Z\nslept_at=2026-10-16T07:00:00Z\n' \
  "$OTHER" "$CREW_ROOT/.owners/zeta/notes.md" >"$CREW_ROOT/.owners/zeta/owner"
run "$CREW" owners
eq "owners lists every repo" "alpha  awake      worker-1  src/a/** lib/*.sh
beta   awake      owner-1   src/b/ docs/**/*.md
gamma  awake      worker-2  src/** extra.txt
zeta   asleep 3h  zed       other/**" "$OUT"
run "$CREW" owners --repo "$REPO"
eq "owners --repo lists only that repo" "alpha  awake  worker-1  src/a/** lib/*.sh
beta   awake  owner-1   src/b/ docs/**/*.md
gamma  awake  worker-2  src/** extra.txt" "$OUT"
run "$CREW" owners --repo "$REPO/src"
eq "owners --repo a folder inside the repo means the repo" "alpha  awake  worker-1  src/a/** lib/*.sh
beta   awake  owner-1   src/b/ docs/**/*.md
gamma  awake  worker-2  src/** extra.txt" "$OUT"
run "$CREW" owners --notes alpha
eq "owners --notes prints the notes path" "$CREW_ROOT/.owners/alpha/notes.md" "$OUT"
run "$CREW" owners --notes nosuch
check "owners --notes unknown: exit 2" rc_is 2
run "$CREW" owners --bogus
check "owners unknown option: exit 2" rc_is 2

# --- owners follows a resumed session (owner_refresh): the new live sid lists the old one in .prev ---
kill "$W1_PID" 2>/dev/null; rm -f "$CREW_SESSIONS/bg-SID-W.json" "$CREW_SESSIONS/run-SID-W.json"
live_sub worker-1b SID-W9
mkdir -p "$CREW_ROOT/.prev"; echo SID-W >"$CREW_ROOT/.prev/SID-W9"
run "$CREW" owners --repo "$REPO"
eq "a resumed owner shows its new name" "alpha  awake  worker-1b  src/a/** lib/*.sh
beta   awake  owner-1    src/b/ docs/**/*.md
gamma  awake  worker-2   src/** extra.txt" "$OUT"
check "...and the registry follows the new sessionId" owner_has alpha "sid=SID-W9"
check "...and the new name" owner_has alpha "name=worker-1b"
check "...without duplicating keys" bash -c '[ "$(grep -c "^sid=" "$0")" = 1 ]' "$CREW_ROOT/.owners/alpha/owner"
check "...path lines intact" owner_has alpha "path=lib/*.sh"

# --- owners --for: overlap between owners, unowned files, absolute and cwd-relative files ---
run_in "$REPO" "$CREW" owners --for src/a/x.c src/b/y.c lib/z.sh README.md src/a/deep/q.c docs/g/h.md
eq "--for: all matching owners, then the unowned files" "alpha  awake  worker-1b  3 files: src/a/x.c, lib/z.sh, src/a/deep/q.c
beta   awake  owner-1    2 files: src/b/y.c, docs/g/h.md
gamma  awake  worker-2   3 files: src/a/x.c, src/b/y.c, src/a/deep/q.c
unowned: 1 files: README.md" "$OUT"
OUT=$(cd "$REPO/src" && "$CREW" owners --for a/x.c "$REPO/lib/z.sh" ../README.md 2>&1); RC=$?
eq "--for from inside the repo: cwd-relative, absolute and .. paths" "alpha  awake  worker-1b  2 files: src/a/x.c, lib/z.sh
gamma  awake  worker-2   1 files: src/a/x.c
unowned: 1 files: README.md" "$OUT"
run_in "$REPO" "$CREW" owners --for README.md
eq "--for with only unowned files" "unowned: 1 files: README.md" "$OUT"
run_in "$REPO" "$CREW" owners --for src/f1 src/f2 src/f3 src/f4 src/f5 src/f6 src/f7
eq "--for lists five files then +N" "gamma  awake  worker-2  7 files: src/f1, src/f2, src/f3, src/f4, src/f5, +2" "$OUT"
run "$CREW" owners --repo "$REPO" --for /etc/passwd
check "--for a file outside the repo: exit 2" rc_is 2
run "$CREW" owners --repo "$REPO" --for
check "--for with no files: exit 2" rc_is 2
run "$CREW" owners --repo "$OTHER" --for "$OTHER/other/a"
eq "--for on a repo with an asleep owner" "zeta  asleep 3h  zed  1 files: other/a" "$OUT"

# --- owners --for-diff on a real repo with a commit ---
echo changed >"$REPO/src/a/x.c"; echo changed >"$REPO/README.md"; echo changed >"$REPO/docs/g/h.md"
echo new >"$REPO/src/a/my file.c"
git -C "$REPO" add -A
git -C "$REPO" commit -q -m second
run "$CREW" owners --repo "$REPO" --for-diff HEAD~1
eq "--for-diff HEAD~1" "alpha  awake  worker-1b  2 files: src/a/my file.c, src/a/x.c
beta   awake  owner-1    1 files: docs/g/h.md
gamma  awake  worker-2   2 files: src/a/my file.c, src/a/x.c
unowned: 1 files: README.md" "$OUT"
run "$CREW" owners --repo "$REPO" --for-diff HEAD
eq "--for-diff with nothing changed" "no changed files" "$OUT"
run "$CREW" owners --repo "$REPO" --for-diff nosuchref
check "--for-diff with an unknown ref: exit 2" rc_is 2
run "$CREW" owners --repo "$REPO" --for-diff --output=$T/pwned
check "--for-diff with an option-looking ref: exit 2" rc_is 2
check "...and wrote nothing" test ! -e "$T/pwned"
OUT=$(cd "$REPO" && "$CREW" owners --for-diff HEAD~1 2>&1); RC=$?
check "--for-diff takes the repo from the cwd" bash -c 'grep -q "^unowned: 1 files: README.md$" <<<"$0"' "$OUT"

# --- F7: a git worktree of the registered repo routes to the owners of the main checkout ---
git -C "$REPO" worktree add -q -b wtb "$T/wt" HEAD
WT=$(realpath "$T/wt")
echo wtchange >"$WT/src/a/x.c"; echo wtchange >"$WT/README.md"; echo wtnew >"$WT/lib/new.sh"
git -C "$WT" add lib/new.sh
run_in "$WT" "$CREW" owners --for-diff HEAD
eq "--for-diff inside a worktree finds the owners of the main checkout" "alpha  awake  worker-1b  2 files: lib/new.sh, src/a/x.c
gamma  awake  worker-2   1 files: src/a/x.c
unowned: 1 files: README.md" "$OUT"
run_in "$WT" "$CREW" owners --for src/a/x.c README.md
eq "--for inside a worktree finds the owners of the main checkout" "alpha  awake  worker-1b  1 files: src/a/x.c
gamma  awake  worker-2   1 files: src/a/x.c
unowned: 1 files: README.md" "$OUT"
run_in "$WT/src" "$CREW" owners --for a/x.c
eq "--for from a folder of a worktree" "alpha  awake  worker-1b  1 files: src/a/x.c
gamma  awake  worker-2   1 files: src/a/x.c" "$OUT"
run "$CREW" owners --repo "$WT"
eq "owners --repo a worktree lists the owners of the main checkout" "alpha  awake  worker-1b  src/a/** lib/*.sh
beta   awake  owner-1    src/b/ docs/**/*.md
gamma  awake  worker-2   src/** extra.txt" "$OUT"
live_sub worker-5 SID-W5
as worker-5 SID-W5 "$CREW" join lead-a >/dev/null
OUT=$(cd "$WT" && "$CREW" owner add wtfeat --paths 'lib/' --sub worker-5 2>&1); RC=$?
check "owner add from a worktree stores the main checkout" owner_has wtfeat "repo=$REPO"
check "...and no cwd= when the session json has no cwd" bash -c '! grep -q "^cwd=" "$0"' "$CREW_ROOT/.owners/wtfeat/owner"
"$CREW" owner rm wtfeat >/dev/null 2>&1

# --- W1: the registry keeps the owner session's working directory (cwd=) beside the main checkout (repo=) ---
live_sub worker-6 SID-W6 "$WT"
as worker-6 SID-W6 "$CREW" join lead-a >/dev/null
run "$CREW" owner add wtcwd --paths 'lib/' --sub worker-6 --repo "$REPO"
check "an owner whose session runs in a worktree keeps cwd= that worktree" owner_has wtcwd "cwd=$WT"
check "...and repo= stays the main checkout" owner_has wtcwd "repo=$REPO"
eq "...cwd= sits once, right after repo=" "feature=wtcwd
repo=$REPO
cwd=$WT" "$(head -n 3 "$CREW_ROOT/.owners/wtcwd/owner")"
mkdir -p "$WT/src"
live_sub_json() { jq -nc --argjson pid "$LIVE_PID" --arg n "$1" --arg s "$2" --arg c "$3" '{pid: $pid, name: $n, sessionId: $s, cwd: $c}' >"$CREW_SESSIONS/bg-$2.json"; }
live_sub_json worker-6 SID-W6 "$WT/src"
run "$CREW" owners
check "owner_refresh follows the live session's cwd" owner_has wtcwd "cwd=$WT/src"
eq "...without duplicating the key" "1" "$(grep -c '^cwd=' "$CREW_ROOT/.owners/wtcwd/owner")"
check "an owner whose session json has no cwd gets no cwd= line" bash -c '! grep -q "^cwd=" "$0"' "$CREW_ROOT/.owners/alpha/owner"

# --- W5: an owner whose session is live is awake, whatever the registry says (a wake that died before owner_set) ---
sed -i 's/^state=.*/state=asleep/' "$CREW_ROOT/.owners/wtcwd/owner"
run "$CREW" owners
check "a live session marks an asleep owner awake" owner_has wtcwd "state=awake"
sed -i 's/^state=.*/state=asleep/' "$CREW_ROOT/.owners/zeta/owner"
run "$CREW" owners
check "...and an owner with no live session stays asleep" owner_has zeta "state=asleep"
kill "$LIVE_PID" 2>/dev/null; rm -f "$CREW_SESSIONS/bg-SID-W6.json"
"$CREW" owner rm wtcwd >/dev/null 2>&1

# --- F8: one owner per session ---
run "$CREW" owner add dup --paths 'x/' --sub worker-2 --repo "$REPO"
check "a session that already owns a feature cannot own another (exit 3)" rc_is 3
eq "...and names the feature it owns" "crew: refused: worker-2 already owns gamma: one owner per session" "$OUT"
check "...nothing registered" test ! -e "$CREW_ROOT/.owners/dup"
run "$CREW" owner add dup --paths 'x/' --sub SID-W2 --repo "$REPO"
eq "...also when the session is given by sessionId" "crew: refused: worker-2 already owns gamma: one owner per session" "$OUT"
OUT=$(as owner-1 SID-O "$CREW" owner add dup --paths 'x/' --repo "$REPO"); RC=$?
eq "...also when the session adds itself" "crew: refused: owner-1 already owns beta: one owner per session" "$OUT"
run "$CREW" owner add dup --paths 'x/' --sub worker-5 --repo "$REPO"
check "a session that owns nothing can still own one" rc_is 0
"$CREW" owner rm dup >/dev/null 2>&1

# --- owner ids with -- would make talk thread ids ambiguous ---
run "$CREW" owner add a--b --paths 'x/' --sub worker-5 --repo "$REPO"
check "an id containing -- is refused (exit 3)" rc_is 3
eq "...with the reason" "crew: refused: owner ids cannot contain --" "$OUT"
check "...nothing registered" test ! -e "$CREW_ROOT/.owners/a--b"
run "$CREW" owner add a-b --paths 'x/' --sub worker-5 --repo "$REPO"
check "an id with a single - is fine" rc_is 0
"$CREW" owner rm a-b >/dev/null 2>&1

# --- C3 pending wakes: `owners --record-wake` marks asleep owners, the lead's digest shows them until woken or dismissed ---
WREPO=$T/wrepo
mkdir -p "$WREPO/svc" "$WREPO/unrelated" "$T/nt"
git -C "$WREPO" init -q
for f in svc/a.c unrelated/u.c README.md; do echo base >"$WREPO/$f"; done
git -C "$WREPO" add -A
git -C "$WREPO" commit -q -m base
WREPO=$(realpath "$WREPO")
echo changed >"$WREPO/svc/a.c"; echo changed >"$WREPO/README.md"
git -C "$WREPO" add -A
git -C "$WREPO" commit -q -m merge-like
mkwo() { # ID STATE LEAD LEAD_SID GLOB: an owner folder written by hand in the registry format
  mkdir -p "$CREW_ROOT/.owners/$1"
  printf 'feature=%s\nrepo=%s\npath=%s\nsid=SID-X-%s\nname=%s\nlead=%s\nlead_sid=%s\nnotes=%s\nstate=%s\ncreated=2026-10-15T00:00:00Z\nslept_at=2026-10-16T07:00:00Z\n' \
    "$1" "$WREPO" "$5" "$1" "$1" "$3" "$4" "$CREW_ROOT/.owners/$1/notes.md" "$2" >"$CREW_ROOT/.owners/$1/owner"
}
mkwo sleepy asleep lead-a SID-A 'svc/**'
mkwo sleepy2 asleep lead-b SID-B 'svc/'
mkwo wideawake awake lead-a SID-A 'svc/**'
mkwo napper asleep lead-a SID-A 'unrelated/**'
# digest runs the lifecycle sweep, which may ask tmux: pin it to a private server nobody started
printf '#!/bin/sh\nexec %s -L crewowners%s "$@"\n' "$(command -v tmux)" "$$" >"$T/nt/tmux"; chmod +x "$T/nt/tmux"
dig() { run env -u TMUX -u TMUX_PANE PATH="$T/nt:$PATH" "$CREW" digest "$@"; }
PEND=$CREW_ROOT/.owners/sleepy/wake.pending

run "$CREW" owners --repo "$WREPO" --record-wake HEAD~1 --change 'card/x (card T-9, abc1234)'
eq "--record-wake names each asleep owner the diff touches (and no awake or unmatched one)" "wake pending: sleepy
wake pending: sleepy2" "$OUT"
check "--record-wake exits 0" rc_is 0
eq "wake.pending holds the timestamp and the change" $'2026-10-16T10:00:00Z\tcard/x (card T-9, abc1234)' "$(cat "$PEND")"
check "an awake owner matched by the same diff gets no wake.pending" test ! -e "$CREW_ROOT/.owners/wideawake/wake.pending"
check "an asleep owner whose globs the diff misses gets no wake.pending" test ! -e "$CREW_ROOT/.owners/napper/wake.pending"
run "$CREW" owners --repo "$WREPO" --record-wake HEAD --change 'nothing changed'
eq "a diff that touches no owner prints nothing" "" "$OUT"
run "$CREW" owners --repo "$WREPO" --record-wake HEAD~1
check "--record-wake without --change: exit 2" rc_is 2
run "$CREW" owners --repo "$WREPO" --change 'x'
check "--change without --record-wake: exit 2" rc_is 2
run "$CREW" owners --repo "$WREPO" --record-wake nosuchref --change 'x'
check "--record-wake with an unknown ref: exit 2" rc_is 2

dig
eq "the owner's lead sees the wake line first, under Action items" "Action items
  wake sleepy: card/x (card T-9, abc1234)? → crew wake sleepy \"<task>\", or crew owners --dismiss sleepy" "$(head -n 2 <<<"$OUT")"
dig
check "the wake line is standing: the next digest shows it again" bash -c 'grep -qF "  wake sleepy: card/x (card T-9, abc1234)? → crew wake sleepy" <<<"$0"' "$OUT"
check "an awake or unmatched owner has no wake line" bash -c '! grep -q "wake wideawake\|wake napper" <<<"$0"' "$OUT"
dig --lead lead-b
check "another lead sees its own owner's wake line" bash -c 'grep -qF "  wake sleepy2: card/x (card T-9, abc1234)? → crew wake sleepy2" <<<"$0"' "$OUT"
check "...and not the first lead's owner's" bash -c '! grep -q "wake sleepy:" <<<"$0"' "$OUT"
run "$CREW" owners --repo "$WREPO" --record-wake HEAD~1 --change $'card/y (card T-10,\tdef5678)'
dig
check "a second change shows the oldest with a count" bash -c 'grep -qF "  wake sleepy: card/x (card T-9, abc1234) (+1 more)? → crew wake sleepy \"<task>\", or crew owners --dismiss sleepy" <<<"$0"' "$OUT"
eq "the change is stored on one line" 2 "$(wc -l <"$PEND")"

run "$CREW" owners --dismiss nosuch
check "--dismiss of an unknown owner: exit 2" rc_is 2
OUT=$(as stranger SID-S "$CREW" owners --dismiss sleepy2); RC=$?
check "a session that is not the owner's lead cannot dismiss (exit 3)" rc_is 3
check "...and the wake stays" test -s "$CREW_ROOT/.owners/sleepy2/wake.pending"
OUT=$(as owner-1 SID-O "$CREW" owners --dismiss sleepy); RC=$?
check "a sibling owner cannot dismiss either (exit 3)" rc_is 3
check "...and the file stays" test -s "$PEND"
run "$CREW" owners --dismiss sleepy
eq "the lead dismisses a wake" "dismissed wake for sleepy" "$OUT"
check "...wake.pending is gone" test ! -e "$PEND"
dig
check "...and the next digest has no wake line for it" bash -c '! grep -q "wake sleepy:" <<<"$0"' "$OUT"
run "$CREW" owners --dismiss sleepy
eq "dismissing with nothing pending says so" "no wake pending for sleepy" "$OUT"

# --- a renamed lead: owner lead= follows it (asleep owners too) ---
lead_json lead-a2 SID-A
run "$CREW" owners
check "lead= of an awake owner follows the lead's new name" owner_has alpha "lead=lead-a2"
check "lead= of an asleep owner follows it too" owner_has zeta "lead=lead-a2"
check "lead_sid is unchanged" owner_has zeta "lead_sid=SID-A"
check "...path lines intact" owner_has zeta "path=other/**"

if [ $fails -gt 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "all checks passed"
