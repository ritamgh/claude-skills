#!/usr/bin/env bash
# Tests for `recall`: fixtures are fake Claude Code transcripts in a temp HOME, the index DB lives there too.
#   bash test-recall.sh
set -uo pipefail

RECALL=$(dirname "$(readlink -f "$0")")/recall
T=$(mktemp -d)
trap 'chmod -R u+rwx "$T" 2>/dev/null; rm -rf "$T"' EXIT
export HOME=$T/home RECALL_DB=$T/cache/recall/recall.db
PROJ=$HOME/.claude/projects
mkdir -p "$PROJ"
fails=0

check() { # description, then a command that must succeed
  local desc=$1; shift
  if "$@"; then echo "ok   $desc"; else echo "FAIL $desc"; fails=$((fails + 1)); fi
}
rc_of() { "$@" >"$T/out" 2>"$T/err"; echo $? >"$T/rc"; }   # run, keep stdout/stderr/exit status
rc_is() { [ "$(cat "$T/rc")" = "$1" ]; }
out_has() { grep -qF -- "$1" "$T/out"; }
out_lacks() { ! grep -qF -- "$1" "$T/out"; }
found() { rc_of "$RECALL" search "$@"; rc_is 0; }          # search gave hits
missing() { rc_of "$RECALL" search "$@"; rc_is 1; }        # search gave no hits (exit 1, not an error)
nrows() { sqlite3 "$RECALL_DB" 'select count(*) from msgs'; }

# --- fixture builders: one JSON line per record, shaped like real transcripts ---
SA=aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa   # session in project alpha
SB=bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb   # session in project beta
CWD_A=/home/user/Developer/alpha CWD_B=/home/user/Developer/beta
uid() { cat /proc/sys/kernel/random/uuid; }   # called in $(...), so a counter would not advance
user() { # session cwd ts text -> user record with string content
  jq -nc --arg s "$1" --arg c "$2" --arg t "$3" --arg x "$4" --arg u "$(uid)" \
    '{parentUuid:null,isSidechain:false,type:"user",message:{role:"user",content:$x},uuid:$u,timestamp:$t,userType:"external",cwd:$c,sessionId:$s}'
}
user_blocks() { # session cwd ts blocks-json
  jq -nc --arg s "$1" --arg c "$2" --arg t "$3" --argjson b "$4" --arg u "$(uid)" \
    '{parentUuid:null,isSidechain:false,type:"user",message:{role:"user",content:$b},uuid:$u,timestamp:$t,userType:"external",cwd:$c,sessionId:$s}'
}
asst() { # session cwd ts text -> assistant record with a thinking block and a text block
  jq -nc --arg s "$1" --arg c "$2" --arg t "$3" --arg x "$4" --arg u "$(uid)" \
    '{parentUuid:null,isSidechain:false,type:"assistant",message:{role:"assistant",model:"claude-sonnet-5",content:[{type:"thinking",thinking:"",signature:"abc"},{type:"text",text:$x}]},uuid:$u,timestamp:$t,userType:"external",cwd:$c,sessionId:$s}'
}
asst_blocks() { # session cwd ts blocks-json
  jq -nc --arg s "$1" --arg c "$2" --arg t "$3" --argjson b "$4" --arg u "$(uid)" \
    '{parentUuid:null,isSidechain:false,type:"assistant",message:{role:"assistant",content:$b},uuid:$u,timestamp:$t,userType:"external",cwd:$c,sessionId:$s}'
}
file_a() { echo "$PROJ/-home-user-Developer-alpha/$SA.jsonl"; }
file_b() { echo "$PROJ/-home-user-Developer-beta/$SB.jsonl"; }
mkdir -p "$PROJ/-home-user-Developer-alpha" "$PROJ/-home-user-Developer-beta"

# ---------- 1. what gets indexed ----------
{
  user "$SA" $CWD_A 2026-10-01T10:00:00.000Z "How do we deploy the zebrafish service?"
  asst_blocks "$SA" $CWD_A 2026-10-01T10:00:05.000Z '[{"type":"thinking","thinking":"pondering quokka","signature":"x"},{"type":"text","text":"Use the blue-green rollout for zebrafish."}]'
  asst_blocks "$SA" $CWD_A 2026-10-01T10:00:09.000Z '[{"type":"tool_use","id":"toolu_1","name":"Bash","input":{"command":"grep wombat"}}]'
  user_blocks "$SA" $CWD_A 2026-10-01T10:00:10.000Z '[{"type":"tool_result","tool_use_id":"toolu_1","content":"wombat output ostrich"}]'
  user_blocks "$SA" $CWD_A 2026-10-01T10:00:11.000Z '[{"type":"text","text":"<system-reminder>reminder about narwhal</system-reminder>"}]'
  jq -nc --arg s "$SA" '{parentUuid:null,isSidechain:false,isMeta:true,type:"user",message:{role:"user",content:"<local-command-caveat>caveat axolotl</local-command-caveat>"},uuid:"m1",timestamp:"2026-10-01T10:00:12.000Z",cwd:"/x",sessionId:$s}'
  user_blocks "$SA" $CWD_A 2026-10-01T10:00:13.000Z '[{"type":"text","text":"<system-reminder>pangolin rules</system-reminder>"},{"type":"text","text":"real question about capybara"}]'
  user "$SA" $CWD_A 2026-10-01T10:00:14.000Z "<task-notification><task-id>t1</task-id><summary>background lemur finished</summary></task-notification>"
  user "$SA" $CWD_A 2026-10-01T10:00:15.000Z "<local-command-stdout>output gecko</local-command-stdout>"
  user "$SA" $CWD_A 2026-10-01T10:00:16.000Z $'<command-name>/orchestrate</command-name>\n<command-message>orchestrate</command-message>\n<command-args>plan the heron migration</command-args>'
  jq -nc --arg s "$SA" '{type:"ai-title",aiTitle:"Zebrafish rollout",sessionId:$s}'
} >"$(file_a)"

found zebrafish
check "1: user prompt text found" out_has "zebrafish"
found "blue-green rollout" --role assistant
check "1: assistant text block found (role filter assistant)" out_has "blue-green"
found capybara
check "1: system-reminder block stripped but the real text beside it is kept" out_has "capybara"
found heron
check "1: slash command args are indexed" out_has "heron"
for w in quokka wombat ostrich narwhal axolotl pangolin lemur gecko; do
  check "1: '$w' (thinking/tool_use/tool_result/system-reminder/meta/notification/stdout) is not indexed" missing "$w"
done
found zebrafish
check "1: hit shows the ai-title" out_has "Zebrafish rollout"
check "1: hit shows project name" out_has "alpha"
check "1: hit shows a session:line handle" out_has "aaaaaaaa:1"

# ---------- 2. incremental ----------
before=$(nrows)
asst "$SA" $CWD_A 2026-10-01T11:00:00.000Z "Later we chose the platypus approach." >>"$(file_a)"
found platypus
check "2: appended line found on the next search" out_has "platypus"
check "2: exactly one new row after the append" test "$(nrows)" = "$((before + 1))"
found zebrafish
check "2: repeat search does not duplicate old rows" test "$(nrows)" = "$((before + 1))"
rc_of "$RECALL" index
check "2: explicit index with nothing new keeps the row count" test "$(nrows)" = "$((before + 1))"

# ---------- 3. partial trailing line ----------
before=$(nrows)
partial=$(asst "$SA" $CWD_A 2026-10-01T12:00:00.000Z "Half written ocelot message.")
printf '%s' "$partial" >>"$(file_a)"
check "3: line without trailing newline is not indexed yet" missing ocelot
check "3: no row added for the partial line" test "$(nrows)" = "$before"
printf '\n' >>"$(file_a)"
found ocelot
check "3: found once the newline arrives" out_has "ocelot"
check "3: exactly one row added" test "$(nrows)" = "$((before + 1))"

# ---------- 4. file truncated / replaced ----------
{
  user "$SA" $CWD_A 2026-10-02T09:00:00.000Z "Fresh start about the marmot."
} >"$(file_a)"
check "4: shrunken file drops the old rows" missing zebrafish
found marmot
check "4: shrunken file's new content is indexed" out_has "marmot"
check "4: only the new content remains" test "$(sqlite3 "$RECALL_DB" "select count(*) from msgs where session='$SA'")" = 1
# replaced by a LARGER file with different content: the stored head fingerprint must catch it
{
  user "$SA" $CWD_A 2026-10-02T10:00:00.000Z "Replacement file talking about the lynx."
  asst "$SA" $CWD_A 2026-10-02T10:00:01.000Z "More lynx filler so this file is bigger than before, much bigger than the previous file."
} >"$(file_a)"
check "4: grown replacement drops the old rows" missing marmot
found lynx
check "4: grown replacement is reindexed" test "$(sqlite3 "$RECALL_DB" "select count(*) from msgs where session='$SA'")" = 2

# ---------- 5. redaction ----------
ANT=sk-ant'-'api03-Zk3jQ9xW2mN8vB5cL7pR4tY6uH1sD0fG
# Assemble fake secret signatures at runtime so source scanners do not flag the fixtures.
GH_PREFIX=gh AWS_PREFIX=AK PEM_TYPE='RSA PRIVATE KEY'
GH="${GH_PREFIX}p_1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R"
AWS="${AWS_PREFIX}IAIOSFODNN7EXAMPLE"
HIE=Qx9Zt3Lm7Vb2Nc8Rd4Wy6Hs1Kf5Jg0Ae3Pu9Tz7Xo2
{
  user "$SA" $CWD_A 2026-10-03T09:00:00.000Z "keyfinder alpha: my key is $ANT and the github token $GH ok"
  asst "$SA" $CWD_A 2026-10-03T09:00:01.000Z $'keyfinder beta: aws id '"$AWS"$' password=hunter2hunter2 and Authorization: Bearer abc123def456ghi789 plus blob '"$HIE"
  asst "$SA" $CWD_A 2026-10-03T09:00:02.000Z $'keyfinder gamma:\n-----BEGIN '"$PEM_TYPE"$'-----\nMIIEowIBAAKCAQEAfakefakefake\n-----END '"$PEM_TYPE"$'-----\nafter-key-text'
} >"$(file_a)"
rc_of "$RECALL" search keyfinder -n 20
SECRETS=("$ANT" "$GH" "$AWS" "hunter2hunter2" "abc123def456ghi789" "$HIE" "MIIEowIBAAKCAQEA")
for s in "${SECRETS[@]}"; do
  check "5: search output has no '${s:0:12}...'" out_lacks "$s"
done
check "5: search still returns the surrounding text" out_has "keyfinder"
check "5: redaction marker present" out_has "[REDACTED]"
rc_of "$RECALL" read "$SA:1" --around 5
for s in "${SECRETS[@]}"; do
  check "5: read output has no '${s:0:12}...'" out_lacks "$s"
done
for s in "${SECRETS[@]}"; do
  check "5: DB files have no '${s:0:12}...'" bash -c '! grep -qaF -- "$1" "$2"*' _ "$s" "$RECALL_DB"
done

# ---------- 6. filters ----------
{
  user "$SA" $CWD_A 2026-09-01T09:00:00.000Z "filtertest old alpha question"
  asst "$SA" $CWD_A 2026-10-10T09:00:00.000Z "filtertest recent alpha answer"
} >"$(file_a)"
{
  user "$SB" $CWD_B 2026-10-10T09:00:00.000Z "filtertest recent beta question"
} >"$(file_b)"
found filtertest -n 20
check "6: unfiltered finds all 3" test "$(grep -c 'filtertest' "$T/out")" = 3
found filtertest -n 20 --project beta
check "6: --project beta keeps beta" out_has "beta question"
check "6: --project beta drops alpha" out_lacks "alpha"
found filtertest -n 20 --since 2026-10-01
check "6: --since date keeps the recent hit" out_has "recent alpha answer"
check "6: --since date drops the old hit" out_lacks "old alpha"
found filtertest -n 20 --role assistant
check "6: --role assistant keeps the answer" out_has "recent alpha answer"
check "6: --role assistant drops user prompts" out_lacks "question"
check "6: --since 1h (relative) excludes older fixtures" missing filtertest --since 1h
rc_of "$RECALL" search filtertest --since bogus
check "6: bad --since is a usage error (exit 2)" rc_is 2

# ---------- 7. read around ----------
{
  user "$SA" $CWD_A 2026-10-05T09:00:00.000Z "readtest one"
  asst_blocks "$SA" $CWD_A 2026-10-05T09:00:01.000Z '[{"type":"tool_use","id":"t","name":"Bash","input":{"command":"ls"}}]'
  user_blocks "$SA" $CWD_A 2026-10-05T09:00:02.000Z '[{"type":"tool_result","tool_use_id":"t","content":"files"}]'
  asst "$SA" $CWD_A 2026-10-05T09:00:03.000Z "readtest two"
  user "$SA" $CWD_A 2026-10-05T09:00:04.000Z "readtest three"
  asst "$SA" $CWD_A 2026-10-05T09:00:05.000Z "readtest four"
  user "$SA" $CWD_A 2026-10-05T09:00:06.000Z "readtest five"
} >"$(file_a)"
rc_of "$RECALL" read "aaaaaaaa:5" --around 1
check "7: read exits 0" rc_is 0
check "7: previous message included" out_has "readtest two"
check "7: target message included" out_has "readtest three"
check "7: next message included" out_has "readtest four"
check "7: nothing further before" out_lacks "readtest one"
check "7: nothing further after" out_lacks "readtest five"
rc_of "$RECALL" read "$SA:5" --around 0
check "7: --around 0 gives only the target" bash -c 'grep -q "readtest three" "$1" && ! grep -q "readtest two" "$1" && ! grep -q "readtest four" "$1"' _ "$T/out"
rc_of "$RECALL" read "zzzzzzzz:1"
check "7: unknown session is exit 2" rc_is 2
rc_of "$RECALL" read "$SA:1" --around 3
check "7: window clipped at the session start" out_has "readtest one"

# ---------- 8. permissions ----------
check "8: DB file mode is 0600" test "$(stat -c %a "$RECALL_DB")" = 600
check "8: DB dir mode is 0700" test "$(stat -c %a "$(dirname "$RECALL_DB")")" = 700

# ---------- 9. punctuation in queries ----------
{
  user "$SA" $CWD_A 2026-10-06T09:00:00.000Z "we fixed tmux-map and bg-session for the D-id field"
} >"$(file_a)"
found "tmux-map bg-session"
check "9: hyphenated plain query works" out_has "tmux-map"
found "D-id"
check "9: 'D-id' works" out_has "D-id"
check "9: unbalanced quote does not error" found 'tmux"map'
found "bg-session:"
check "9: trailing colon does not error" out_has "bg-session"
found '"tmux-map" OR nothinghere'
check "9: real FTS5 syntax still passes through" out_has "tmux-map"

# ---------- 10. titles, summaries, json, usage, stats ----------
{
  user "$SA" $CWD_A 2026-10-07T09:00:00.000Z "titletest question"
  jq -nc --arg s "$SA" '{type:"ai-title",aiTitle:"Auto generated name",sessionId:$s}'
  jq -nc --arg s "$SA" '{type:"custom-title",customTitle:"my-chosen-name",sessionId:$s}'
  jq -nc --arg s "$SA" '{type:"ai-title",aiTitle:"Later auto name",sessionId:$s}'
  jq -nc --arg s "$SA" --arg u "$(uid)" '{parentUuid:null,isSidechain:false,isCompactSummary:true,type:"user",message:{role:"user",content:"This session is being continued. Summary mentions the vole."},uuid:$u,timestamp:"2026-10-07T09:30:00.000Z",cwd:"/home/user/Developer/alpha",sessionId:$s}'
} >"$(file_a)"
found titletest
check "10: custom title beats ai-title, even a later ai-title" out_has "my-chosen-name"
found vole
check "10: compaction summary is indexed" out_has "vole"
check "10: compaction summary is marked" out_has "summary"
check "10: summary is not a plain user message" missing vole --role user
rc_of "$RECALL" search titletest --json
check "10: --json is a valid array with a handle" bash -c 'jq -e ".[0].handle == \"aaaaaaaa:1\" and .[0].role == \"user\" and .[0].project == \"alpha\"" "$1" >/dev/null' _ "$T/out"
rc_of "$RECALL" search
check "10: search without a query is exit 2" rc_is 2
rc_of "$RECALL" stats
check "10: stats prints files and messages" bash -c 'grep -q "files" "$1" && grep -q "messages" "$1" && grep -q "last index" "$1"' _ "$T/out"

# ---------- 11. duplicate uuid across files (resumed sessions copy history) ----------
DUP='{"parentUuid":null,"isSidechain":false,"type":"user","message":{"role":"user","content":"duplicated ibex history"},"uuid":"dddddddd-0000-4000-8000-000000000001","timestamp":"2026-10-08T09:00:00.000Z","cwd":"/home/user/Developer/alpha","sessionId":"SESS"}'
rm -f "$(file_a)"
printf '%s\n' "${DUP/SESS/$SA}" >"$(file_a)"
printf '%s\n' "${DUP/SESS/$SB}" >"$(file_b)"
found ibex
check "11: a message copied into a second file is returned once" test "$(grep -c ibex "$T/out")" = 1

# ---------- 12. labelled secrets: any value after password/secret/token/api_key, quoted values whole ----------
rm -f "$(file_b)"
{
  user "$SA" $CWD_A 2026-10-09T09:00:00.000Z 'labeltest one password=hunter2 end'
  asst "$SA" $CWD_A 2026-10-09T09:00:01.000Z 'labeltest two password="correct horse battery staple" end'
  asst "$SA" $CWD_A 2026-10-09T09:00:02.000Z "labeltest three secret: 'xyz12' and api_key=ab1 end"
  asst "$SA" $CWD_A 2026-10-09T09:00:03.000Z 'labeltest four {"token": "t0k3n w1th spaces"} end'
} >"$(file_a)"
rc_of "$RECALL" search labeltest -n 20
for s in hunter2 "correct horse" "battery staple" xyz12 "ab1 end" "t0k3n"; do
  check "12: search output has no '$s'" out_lacks "$s"
done
check "12: the text around the secrets survives" out_has "labeltest"
for s in hunter2 "correct horse" "battery staple" xyz12 t0k3n; do
  check "12: DB files have no '$s'" bash -c '! grep -qaF -- "$1" "$2"*' _ "$s" "$RECALL_DB"
done

# ---------- 13. DB sidecars (-wal/-shm) are 0600 even when the DB pre-existed 0644 and another client holds it open ----------
mkdir -p "$T/c13"; rm -f "$T/c13"/recall.db*
python3 -I -c '
import os, sqlite3, sys, time
os.umask(0o022)
db = sqlite3.connect(sys.argv[1], isolation_level=None)
db.execute("PRAGMA journal_mode=WAL"); db.execute("CREATE TABLE t(x)"); db.execute("INSERT INTO t VALUES(1)")
print("ready", flush=True); time.sleep(30)' "$T/c13/recall.db" >"$T/holder" &
HOLDER=$!
until grep -q ready "$T/holder"; do sleep 0.1; done
chmod 644 "$T/c13/recall.db"
rc_of env RECALL_DB="$T/c13/recall.db" "$RECALL" search labeltest
check "13: search on a pre-existing 0644 DB works" test "$(cat "$T/rc")" != 2
check "13: every DB file (db, -wal, -shm) is 0600" bash -c '
  for f in "$1"*; do [ "$(stat -c %a "$f")" = 600 ] || { echo "$f $(stat -c %a "$f")"; exit 1; }; done' _ "$T/c13/recall.db"
kill $HOLDER 2>/dev/null; wait $HOLDER 2>/dev/null

# ---------- 14. metadata (directory name, cwd, title) is redacted too ----------
KEYDIR=sk-ant'-'api03-Zk3jQ9xW2mN8vB5cL7pR4tY6uH1sD0fG
mkdir -p "$PROJ/-home-user-Developer-$KEYDIR"
{
  user "$SB" "/home/user/Developer/$KEYDIR" 2026-10-09T10:00:00.000Z "metatest question"
  jq -nc --arg s "$SB" --arg title "fix $GH leak" '{type:"ai-title",aiTitle:$title,sessionId:$s}'
} >"$PROJ/-home-user-Developer-$KEYDIR/$SB.jsonl"
rc_of "$RECALL" search metatest --json
check "14: --json hit found" out_has "metatest"
check "14: --json output has no key from the directory name / cwd" out_lacks "Zk3jQ9xW2mN8vB5cL7pR4tY6uH1sD0fG"
check "14: --json output has no key from the title" out_lacks "1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R"
for s in Zk3jQ9xW2mN8vB5cL7pR4tY6uH1sD0fG 1a2B3c4D5e6F7g8H9i0J1k2L3m4N5o6P7q8R; do
  check "14: DB files have no '${s:0:10}...'" bash -c '! grep -qaF -- "$1" "$2"*' _ "$s" "$RECALL_DB"
done
rm -rf "$PROJ/-home-user-Developer-$KEYDIR"

# ---------- 15. malformed records are skipped; unexpected errors exit 2 ----------
{
  echo '[{"type":"user"}]'
  echo '{"type":"user","message":{"role":"user","content":[{"type":"text","text":null}]},"uuid":"u-null","timestamp":"2026-10-11T09:00:00.000Z","cwd":"/x","sessionId":"s"}'
  echo '{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"odd types survivor"}]},"uuid":["a"],"timestamp":12,"cwd":5,"sessionId":7}'
  echo '{"type":"ai-title","aiTitle":42,"sessionId":"s"}'
  user "$SA" $CWD_A 2026-10-11T09:00:05.000Z "badrecord good line"
} >"$(file_a)"
rc_of "$RECALL" search badrecord
check "15: good line after malformed records is found (exit 0)" rc_is 0
check "15: odd-typed record (uuid list, cwd int) is still indexed" found survivor
mkdir -p "$T/ro"; chmod 500 "$T/ro"
rc_of env RECALL_DB="$T/ro/sub/recall.db" "$RECALL" search badrecord
check "15: an unexpected error (unwritable cache dir) is exit 2, not 1" rc_is 2
check "15: ... with a one-line message, no traceback" bash -c '! grep -q Traceback "$1" && grep -q "^recall:" "$1"' _ "$T/err"

# ---------- 16. rewrite that keeps the first 256 bytes is still detected ----------
L1=$(user "$SA" $CWD_A 2026-10-12T09:00:00.000Z "rewrite first line padded to be long enough to cover the whole head fingerprint of the file $(printf 'x%.0s' {1..250})")
{ echo "$L1"; user "$SA" $CWD_A 2026-10-12T09:00:01.000Z "rewrite stale-second"; } >"$(file_a)"
found "stale-second"
{ echo "$L1"; user "$SA" $CWD_A 2026-10-12T09:00:01.000Z "rewrite fresh-second which is longer than the stale one"; user "$SA" $CWD_A 2026-10-12T09:00:02.000Z "rewrite third"; } >"$(file_a)"
check "16: stale text from a same-head rewrite is gone" missing "stale-second"
check "16: rewritten text is found" found "fresh-second"

# ---------- 17. replacing the file that first held a shared uuid restores the other file's copy ----------
printf '%s\n' "${DUP/SESS/$SA}" >"$(file_a)"
printf '%s\n' "${DUP/SESS/$SB}" >"$(file_b)"
found ibex
{ user "$SA" $CWD_A 2026-10-13T09:00:00.000Z "unrelated replacement content for the first file, longer than the duplicate line was"; } >"$(file_a)"
check "17: the other file's copy is still found" found ibex
check "17: and the session shown is the surviving file's" out_has "bbbbbbbb:1"

if [ $fails -gt 0 ]; then echo "$fails check(s) failed"; exit 1; fi
echo "all checks passed"
