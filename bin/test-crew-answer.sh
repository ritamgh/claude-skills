#!/usr/bin/env bash
# Test: what the user types to a lead reaches the asking sub (hooks/crew-answer-hook.sh -> `crew deliver-answer`), is
# queued while the sub's pane is busy or has a draft, and is retried by the lead's digest; and a question a sub left in its
# own pane becomes one D-id (the sweep in digest/subs).
# Real tmux on a private server (tmux -L) behind a wrapper that records every send-keys argv; the panes run a stand-in
# `claude` that registers a session json for itself, draws a screen (idle / busy / draft) and logs each line typed into
# it. This script re-executes itself through a symlink named claude so that it is the lead session (crew recognises a
# session by its process name).
#   bash test-crew-answer.sh
set -uo pipefail

if [ "$(cat /proc/$$/comm)" != claude ]; then
  RX=$(mktemp -d); ln -s "$(command -v bash)" "$RX/claude"
  REEXEC_DIR=$RX exec "$RX/claude" "$(readlink -f "$0")" "$@"
fi
BIN=$(dirname "$(readlink -f "$0")")
CREW=$BIN/crew
HOOK=$BIN/../hooks/crew-answer-hook.sh
T=$(mktemp -d)
TS=crewanswer$$
real_tmux=$(command -v tmux)
trap '"$real_tmux" -L "$TS" kill-server 2>/dev/null; rm -rf "$T" "${REEXEC_DIR:-}"' EXIT
mkdir -p "$T/bin" "$T/sessions" "$T/projects/p" "$T/screens"
export LC_ALL=C.UTF-8 CREW_ROOT=$T/crew CREW_SESSIONS=$T/sessions CREW_PROJECTS=$T/projects CREW_NOW=2026-10-16T10:00:00Z T CREW
export CREW_NOTIFY_CONFIG=$T/no-such-config CREW_NOTIFY_LOG=$T/notify.log   # no phone alert leaves the machine
export PATH="$BIN:$PATH"   # this checkout's crew-notify, never an older installed one
unset CREW_LEAD_COMM CREW_COMPACT_SOFT CREW_COMPACT_HARD TMUX TMUX_PANE   # the private server is named by -L in the wrapper
printf '#!/bin/bash\n[ "$1" != send-keys ] || { printf "%%s\\037" "$@"; echo; } >>"$T/send.log"\nexec %s -L %s "$@"\n' "$real_tmux" "$TS" >"$T/bin/tmux"
cat >"$T/standin" <<'EOF'
#!/bin/bash
# stand-in claude (run through the claude symlink): NAME SID SCREEN. Registers itself, draws SCREEN and a composer, logs each line typed into T/typed.NAME.
name=$1 sid=$2 screen=$3 mode=${4:-}
jq -nc --argjson pid $$ --arg n "$name" --arg s "$sid" '{pid: $pid, name: $n, sessionId: $s, cwd: "/x"}' >"$CREW_SESSIONS/$sid.json"
draw() { printf '\033[2J\033[H'; cat "$T/screens/$1"; }
draw "$screen"
if [ -n "$mode" ]; then   # keys one at a time. trunc: keeps the first 10 characters; race: someone else's text is in the composer; pre: starts with text 5 in it. Ctrl-U clears.
  stty -icanon -echo; buf=${5:-}
  drawc() { draw idle; if [ "$mode" = race ] && [ -n "$buf" ]; then printf '❯ concurrent%s' "$buf"; else printf '❯ %s' "$buf"; fi; }
  drawc
  while IFS= read -r -n1 ch; do
    if [ -z "$ch" ]; then printf '%s\n' "$buf" >>"$T/typed.$name"; buf=""; drawc; continue; fi
    if [ "$ch" = $'\x15' ]; then buf=""; drawc; continue; fi
    if [ "$mode" != trunc ] || [ ${#buf} -lt 10 ]; then buf+=$ch; fi
    drawc
  done
  exit 0
fi
case "$screen" in draft) printf '❯ Please delete the deployment' ;; *) printf '❯ ' ;; esac
while IFS= read -r line; do
  printf '%s\n' "$line" >>"$T/typed.$name"
  draw idle; printf '❯ '
done
EOF
chmod +x "$T/bin/tmux" "$T/standin"
printf 'earlier output\n\n  ? for shortcuts\n' >"$T/screens/idle"
printf 'earlier output\n\n✻ Working… (12s · esc to interrupt)\n' >"$T/screens/busy"
printf 'earlier output\n\n  ? for shortcuts\n' >"$T/screens/draft"
export PATH=$T/bin:$PATH
jq -nc --argjson pid $$ '{pid: $pid, name: "boss", sessionId: "SID-BOSS", cwd: "/x"}' >"$CREW_SESSIONS/boss.json"
tmux new-session -d -x 120 -y 40 -s cc -n main 'sleep 600'   # started after the exports: its panes inherit them

fails=0
check() { local desc=$1; shift; if "$@"; then echo "ok   $desc"; else echo "FAIL $desc"; fails=$((fails + 1)); fi; }
eq() { if [ "$2" = "$3" ]; then echo "ok   $1"; else echo "FAIL $1"; printf '  expected: %s\n  actual:   %s\n' "$2" "$3"; fails=$((fails + 1)); fi; }

# sub NAME SID SCREEN [MODE [COMPOSER]]: a live sub in its own tmux window, joined under boss
sub() {
  mkdir -p "$CREW_ROOT/.links"
  printf 'sub_name=%s\nparent_name=boss\nparent_sid=SID-BOSS\n' "$1" >"$CREW_ROOT/.links/$2"
  tmux new-window -d -t cc: -n "$1" "$REEXEC_DIR/claude" "$T/standin" "$1" "$2" "$3" ${4:-} ${5:+"$5"}
  local i; for i in $(seq 1 50); do [ -s "$CREW_SESSIONS/$2.json" ] && break; sleep 0.1; done
  sleep 0.2
}
# task ID LEAD_SID SUB SID [D-id]: a running task of that sub under that lead, with an open decision when a D-id is given
task() {
  mkdir -p "$CREW_ROOT/$1"
  printf 'lead=boss\nlead_sid=%s\nsub=%s\nsub_sid=%s\n' "$2" "$3" "$4" >"$CREW_ROOT/$1/meta"
  printf '2026-10-16T09:00:00Z\trunning\tgo\n' >"$CREW_ROOT/$1/status"
  if [ -n "${5:-}" ]; then printf '%s\n' "$5" >"$CREW_ROOT/$1/decision"; printf 'which one?\n' >"$CREW_ROOT/$1/ask.md"; fi
}
# prompt SID TEXT: what the UserPromptSubmit hook is fed when the user types TEXT into session SID
prompt() { jq -nc --arg s "$1" --arg p "$2" '{session_id: $s, hook_event_name: "UserPromptSubmit", prompt: $p}' | "$HOOK"; }
pane_of() { tmux display-message -p -t "cc:$1" '#{pane_id}'; }
sent() { tr '\037' '|' <"$T/send.log" 2>/dev/null; }   # one line per send-keys call
typed() { cat "$T/typed.$1" 2>/dev/null; }
open_d() { cat "$CREW_ROOT/$1/decision" 2>/dev/null; }
VIA="boss's input hook"

sub alpha SID-A idle;  task 1016-alpha SID-BOSS alpha SID-A D17
sub bravo SID-B idle;  task 1016-bravo SID-BOSS bravo SID-B D18
sub charlie SID-C idle; task 1016-charlie SID-BOSS charlie SID-C D19
sub delta SID-D idle;  task 1016-delta SID-BOSS delta SID-D D20
sub other SID-O idle;  task 1016-other SID-OTHERLEAD other SID-O D30
printf 'lead=otherlead\n' >>"$CREW_ROOT/1016-other/meta"
printf '30\n' >"$CREW_ROOT/.dseq"

# --- idle: typed as argv (send-keys -l --, then Enter) to the pane id ---
pa=$(pane_of alpha)
prompt SID-BOSS "D17 go" >"$T/out" 2>&1; rc=$?
eq "the hook exits 0 and prints nothing (the prompt reaches the lead unchanged)" "0:" "$rc:$(cat "$T/out")"
eq "'D17 go' is typed into alpha's pane as the user's words" "D17 (your answer, relayed verbatim by $VIA): go" "$(typed alpha)"
eq "as send-keys -l -- TEXT then a separate Enter, aimed at %N" "send-keys|-t|$pa|-l|--|D17 (your answer, relayed verbatim by $VIA): go|
send-keys|-t|$pa|Enter|" "$(sent | grep -F "|$pa|")"
eq "the answer is recorded and the decision closed" "go:" "$(cat "$CREW_ROOT/1016-alpha/answer.md" | tr -d '\n'):$(open_d 1016-alpha)"
check "nothing waits" test -z "$(ls "$CREW_ROOT/.pending-answers" 2>/dev/null)"
check "the key file exists and only its owner can read it" test "$(stat -c %a "$CREW_ROOT/.deliver-key")" = 600

# --- the other forms ---
prompt SID-BOSS "D18: A" >/dev/null
eq "'D18: A'" "D18 (your answer, relayed verbatim by $VIA): A" "$(typed bravo)"
prompt SID-BOSS "d19 - use the worktree" >/dev/null
eq "'d19 - use the worktree'" "D19 (your answer, relayed verbatim by $VIA): use the worktree" "$(typed charlie)"

# --- text: control and format characters out, one line, capped ---
prompt SID-BOSS $'D20 yes\a, ship\nit​‮ now' >/dev/null
eq "bell, zero-width and bidi characters are removed and the newline becomes a space" "D20 (your answer, relayed verbatim by $VIA): yes, ship it now" "$(typed delta)"
sub eagle SID-E idle; task 1016-eagle SID-BOSS eagle SID-E D31
long=$(head -c 3000 /dev/zero | tr '\0' 'x')
prompt SID-BOSS "D31 $long" >/dev/null
eq "an answer is capped at 2000 characters (the line is the 58-character prefix and 2000 x)" 2058 "$(typed eagle | tr -d '\n' | wc -m)"

# --- what is not an answer to this lead's sub ---
n=$(sent | wc -l)
prompt SID-BOSS "D30 go" >/dev/null
eq "a D-id of another lead's sub is ignored: nothing typed, still open" "$n:D30:" "$(sent | wc -l):$(open_d 1016-other):$(typed other)"
prompt SID-BOSS "D99 go" >/dev/null
prompt SID-BOSS "what about D17 go" >/dev/null
prompt SID-BOSS "D17" >/dev/null
prompt SID-BOSS "hello" >/dev/null
prompt SID-STRANGER "D30 go" >/dev/null
eq "an unknown D-id, a D-id mid-sentence, a bare D-id, a stranger session: nothing typed" "$n" "$(sent | wc -l)"
printf 'not json' | "$HOOK"; rc=$?
eq "a broken hook input exits 0" 0 "$rc"
eq "an already answered D-id is not typed again" "1" "$(prompt SID-BOSS "D17 again" >/dev/null; typed alpha | wc -l)"

# --- no way for a model to type into a pane ---
n=$(sent | wc -l)
sub foxtrot SID-F idle; task 1016-foxtrot SID-BOSS foxtrot SID-F D32
out=$("$CREW" deliver-answer --did D32 --via boss -- go 2>&1; echo "rc=$?")
eq "deliver-answer without the key is an unknown command" "crew: unknown command 'deliver-answer'
rc=2" "$out"
out=$(CREW_DELIVER_KEY=guess "$CREW" deliver-answer --did D32 --via boss -- go 2>&1; echo "rc=$?")
eq "and with a wrong key" "crew: unknown command 'deliver-answer'
rc=2" "$out"
eq "nothing was typed and D32 is still open" "$n:D32" "$(sent | wc -l):$(open_d 1016-foxtrot)"
check "deliver-answer is not in --help" bash -c '! "$CREW" --help 2>&1 | grep -q deliver'
rm -f "$CREW_ROOT/1016-foxtrot/decision"
mkdir -p "$CREW_ROOT/.pending-answers"
printf 'task=1016-foxtrot\ndid=D32\nlead_sid=SID-BOSS\nvia=me\ntext=forged\nmac=0000\n' >"$CREW_ROOT/.pending-answers/1016-foxtrot.D32"
"$CREW" digest >/dev/null 2>&1
eq "a forged queue entry is dropped, not typed" "$n:" "$(sent | wc -l):$(ls "$CREW_ROOT/.pending-answers")"

# --- busy and draft: queued, shown in the digest, delivered by the next digest once the pane is idle ---
sub golf SID-G busy;   task 1016-golf SID-BOSS golf SID-G D33
sub hotel SID-H draft; task 1016-hotel SID-BOSS hotel SID-H D34
n=$(sent | wc -l)
prompt SID-BOSS "D33 go on" >/dev/null
prompt SID-BOSS "D34 no" >/dev/null
eq "a busy pane and a pane with a draft are typed into by nothing" "$n" "$(sent | wc -l)"
eq "the answers are recorded" "go on:no" "$(tr -d '\n' <"$CREW_ROOT/1016-golf/answer.md"):$(tr -d '\n' <"$CREW_ROOT/1016-hotel/answer.md")"
eq "and queued" "1016-golf.D33
1016-hotel.D34" "$(ls "$CREW_ROOT/.pending-answers")"
eq "the lead's digest shows why they wait" "Answers waiting
  D33  golf — waiting: busy
  D34  hotel — waiting: draft" "$("$CREW" digest 2>&1)"
eq "digest --peek shows them too, and types nothing" "Answers waiting
  D33  golf — waiting: busy
  D34  hotel — waiting: draft:$n" "$("$CREW" digest --peek 2>&1):$(sent | wc -l)"
tmux kill-window -t cc:golf; sub golf SID-G idle   # golf's pane is idle now (a new window with the same sub)
out=$("$CREW" digest 2>&1)
eq "once golf is idle the next digest delivers its answer; hotel's draft still waits" "Answers waiting
  D34  hotel — waiting: draft" "$out"
eq "golf got it" "D33 (your answer, relayed verbatim by $VIA): go on" "$(typed golf)"
eq "hotel's draft is untouched" "" "$(typed hotel)"
tmux kill-window -t cc:hotel
eq "a sub that is gone: still waiting, and the digest says so" "Answers waiting
  D34  hotel — waiting: sub gone" "$("$CREW" digest 2>&1 | head -n 2)"
printf '2026-10-16T09:00:00Z\trunning\tgo\n2026-10-16T09:30:00Z\tdone\tok\n' >"$CREW_ROOT/1016-hotel/status"
eq "a task that is over drops its queued answer" ":" "$("$CREW" digest 2>&1):$(ls "$CREW_ROOT/.pending-answers")"

# --- a resumed lead: the hook's session id is new, the task still names the old one ---
sub india SID-I idle; task 1016-india SID-BOSS-OLD india SID-I D35
mkdir -p "$CREW_ROOT/.prev"; printf 'SID-BOSS-OLD\n' >"$CREW_ROOT/.prev/SID-BOSS"
prompt SID-BOSS "D35 ok" >/dev/null
eq "an answer typed in the resumed lead (task lead_sid = an earlier id in .prev) is delivered" "D35 (your answer, relayed verbatim by $VIA): ok" "$(typed india)"

# --- a task with no sub (the lead's own question): recorded, nothing typed ---
mkdir -p "$CREW_ROOT/1016-own"; printf 'lead=boss\nlead_sid=SID-BOSS\n' >"$CREW_ROOT/1016-own/meta"; printf '2026-10-16T09:00:00Z\trunning\tgo\n' >"$CREW_ROOT/1016-own/status"
printf 'D36\n' >"$CREW_ROOT/1016-own/decision"; printf 'q\n' >"$CREW_ROOT/1016-own/ask.md"
n=$(sent | wc -l)
prompt SID-BOSS "D36 yes" >/dev/null
eq "a lead's own D-id is closed by the typed answer and nothing is typed anywhere" "yes::$n" "$(tr -d '\n' <"$CREW_ROOT/1016-own/answer.md"):$(open_d 1016-own):$(sent | wc -l)"

# --- HQ's click: the same delivery, any open D-id, "relayed by HQ" ---
sub juliet SID-J idle; task 1016-juliet SID-BOSS juliet SID-J D37
key=$(cat "$CREW_ROOT/.deliver-key")
eq "deliver-answer --via HQ with the key" "delivered juliet" "$(CREW_DELIVER_KEY=$key "$CREW" deliver-answer --did D37 --via HQ -- 'take B' 2>&1)"
eq "juliet got it as HQ's relay" "D37 (your answer, relayed verbatim by HQ): take B" "$(typed juliet)"


# --- queue entries made by hand (a valid MAC needs the key): entry TASK DID TEXT [typed] ---
entry() {
  local key mac; key=$(cat "$CREW_ROOT/.deliver-key")
  mac=$(printf '%s' "$key|$1|$2|SID-BOSS|$3" | sha256sum | cut -d' ' -f1)
  mkdir -p "$CREW_ROOT/.pending-answers"
  printf 'task=%s\ndid=%s\nlead_sid=SID-BOSS\nvia=%s\ntext=%s\nmac=%s\n%s' "$1" "$2" "$VIA" "$3" "$mac" "${4:+typed=1$'\n'}" >"$CREW_ROOT/.pending-answers/$1.$2"
}
LINE() { echo "$1 (your answer, relayed verbatim by $VIA): $2"; }   # the line typed for DID TEXT

# --- a queue entry is not genuine without the key file (an empty key would make the MAC forgeable) ---
sub kappa2 SID-K2 idle; task 1016-kappa2 SID-BOSS kappa2 SID-K2
mv "$CREW_ROOT/.deliver-key" "$CREW_ROOT/.deliver-key.off"
mkdir -p "$CREW_ROOT/.pending-answers"
forged=$(printf '%s' "|1016-kappa2|D50|SID-BOSS|forged" | sha256sum | cut -d' ' -f1)
printf 'task=1016-kappa2\ndid=D50\nlead_sid=SID-BOSS\nvia=x\ntext=forged\nmac=%s\n' "$forged" >"$CREW_ROOT/.pending-answers/1016-kappa2.D50"
"$CREW" digest >/dev/null 2>&1
eq "an entry whose MAC was made with an empty key (no key file) is dropped and not typed" ":" "$(typed kappa2):$(ls "$CREW_ROOT/.pending-answers")"
mv "$CREW_ROOT/.deliver-key.off" "$CREW_ROOT/.deliver-key"

# --- the sub is found by sessionId (and its .prev chain), never by a name a new session reuses ---
task 1016-reuse SID-BOSS reuse SID-REUSE-OLD
sub reuse SID-REUSE-NEW idle
entry 1016-reuse D51 "take B"
eq "a new session that reuses the sub's name does not get the answer; it waits" "Answers waiting
  D51  reuse — waiting: sub gone:" "$("$CREW" digest 2>&1):$(typed reuse)"
mkdir -p "$CREW_ROOT/.prev"; printf 'SID-REUSE-OLD\n' >"$CREW_ROOT/.prev/SID-REUSE-NEW"
eq "the session that continues the sub (its .prev lists the old id) does" "" "$("$CREW" digest 2>&1)"
eq "and got the line" "$(LINE D51 'take B')" "$(typed reuse)"

# --- a failure partway never makes the answer arrive twice ---
sub quebec SID-Q2 idle race;  task 1016-quebec SID-BOSS quebec SID-Q2 D52
sub romeo SID-R2 idle trunc;  task 1016-romeo SID-BOSS romeo SID-R2 D53
pq=$(pane_of quebec); pr=$(pane_of romeo)
prompt SID-BOSS "D52 go" >/dev/null
prompt SID-BOSS "D53 go" >/dev/null
"$CREW" digest >/dev/null 2>&1; "$CREW" digest >/dev/null 2>&1
eq "other text in the composer: typed once, then left alone (partial text), never submitted" "1::partial text in composer" \
  "$(sent | grep -cF "|$pq|-l|"):$(typed quebec):$(link=$(grep '^waiting=' "$CREW_ROOT/.pending-answers/1016-quebec.D52" | tail -n 1); echo "${link#waiting=}")"
eq "its entry is marked typed" "typed=1" "$(grep '^typed=' "$CREW_ROOT/.pending-answers/1016-quebec.D52" | tail -n 1)"
eq "digest says why" "Answers waiting
  D52  quebec — waiting: partial text in composer" "$("$CREW" digest 2>&1 | grep -A1 'Answers waiting' | head -n 2)"
eq "a composer that holds only the start of our line is cleared with Ctrl-U each time; nothing was submitted" "4:4:" \
  "$(sent | grep -cF "|$pr|-l|"):$(sent | grep -cF "|$pr|C-u|"):$(typed romeo)"
eq "and its entry is no longer marked typed" "typed=0" "$(grep '^typed=' "$CREW_ROOT/.pending-answers/1016-romeo.D53" | tail -n 1)"

# typed in full but Enter never went: Enter alone completes it
sub sierra SID-S2 idle pre "$(LINE D54 go)"; task 1016-sierra SID-BOSS sierra SID-S2
ps=$(pane_of sierra)
entry 1016-sierra D54 go typed
"$CREW" digest >/dev/null 2>&1
eq "an entry marked typed whose line sits whole in the composer gets Enter, not a second copy" "0:1:$(LINE D54 go):0" \
  "$(sent | grep -cF "|$ps|-l|"):$(sent | grep -cF "|$ps|Enter|"):$(typed sierra | tr -d '\n'):$(ls "$CREW_ROOT/.pending-answers" | grep -c sierra)"

# typed, composer empty: the transcript decides whether the line arrived
sub tango SID-T2 idle;   task 1016-tango SID-BOSS tango SID-T2
sub uniform SID-U2 idle; task 1016-uniform SID-BOSS uniform SID-U2
jq -nc --arg t "$(LINE D55 go)" '{type: "user", uuid: "u-x", message: {content: $t}}' >"$T/projects/p/SID-T2.jsonl"
entry 1016-tango D55 go typed; entry 1016-uniform D56 go typed
"$CREW" digest >/dev/null 2>&1
eq "marked typed, composer empty, the transcript has the line: it arrived, nothing is typed again" ":" "$(typed tango):$(ls "$CREW_ROOT/.pending-answers" | grep tango)"
eq "marked typed, composer empty, the transcript lacks it: typed once" "$(LINE D56 go)" "$(typed uniform)"

# --- both paths clean the text the same way ---
sub victor SID-V2 idle; task 1016-victor SID-BOSS victor SID-V2 D57
sub whiskey SID-W2 idle; task 1016-whiskey SID-BOSS whiskey SID-W2 D58
weird=$'go ‮ now ok​!\a'
prompt SID-BOSS "D57 $weird" >/dev/null
CREW_DELIVER_KEY=$(cat "$CREW_ROOT/.deliver-key") "$CREW" deliver-answer --did D58 --via HQ -- "$weird" >/dev/null
eq "the hook strips format, bidi, line-separator and control characters" "$(LINE D57 'go  now ok!')" "$(typed victor)"
eq "HQ's path gives the same text" "D58 (your answer, relayed verbatim by HQ): go  now ok!" "$(typed whiskey)"

# --- the hook says so when the delivery fails ---
mkdir -p "$T/failbin"
printf '#!/bin/bash\necho "boom: no such thing" >&2\nexit 2\n' >"$T/failbin/crew"; chmod +x "$T/failbin/crew"
out=$(printf '{"session_id":"SID-BOSS","prompt":"D17 go"}' | CREW_BIN=$T/failbin "$HOOK"); rc=$?
eq "a failing delivery: exit 0, and a note for the lead model" '0:{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"D17: answer not delivered (boom: no such thing); tell the user"}}' "$rc:$out"
printf '#!/bin/bash\nsleep 20\n' >"$T/failbin/crew"
out=$(printf '{"session_id":"SID-BOSS","prompt":"D17 go"}' | CREW_ANSWER_HOOK_TIMEOUT=1 CREW_BIN=$T/failbin "$HOOK"); rc=$?
eq "a delivery that times out says so" '0:{"hookSpecificOutput":{"hookEventName":"UserPromptSubmit","additionalContext":"D17: answer not delivered (timed out); tell the user"}}' "$rc:$out"

rm -f "$CREW_ROOT"/.pending-answers/*   # (the two left waiting above are not part of the digests below)

# --- an in-pane question becomes one D-id ---
# say SID UUID TEXT: the sub's transcript ends with that assistant message
say() {
  jq -nc --arg u "$2" --arg t "$3" '{type: "assistant", uuid: $u, timestamp: "2026-10-16T09:50:00.000Z", message: {id: "m", content: [{type: "text", text: "earlier"}, {type: "tool_use", name: "Bash"}, {type: "text", text: $t}]}}' >"$T/projects/p/$1.jsonl"
}
sub kilo SID-K idle;   task 1016-kilo SID-BOSS kilo SID-K;   say SID-K u-1 $'Two ways to go.\nNeeds you: A (worktree) or B (in place)?'
sub lima SID-L idle;   task 1016-lima SID-BOSS lima SID-L;   say SID-L u-2 $'Built it.\nShould I also bump the version?'
sub mike SID-M idle;   task 1016-mike SID-BOSS mike SID-M;   say SID-M u-3 $'All done. Tests pass.'
sub nov SID-N busy;    task 1016-nov SID-BOSS nov SID-N;     say SID-N u-4 $'Which port?'
sub oscar SID-P idle;  task 1016-oscar SID-BOSS oscar SID-P D40; say SID-P u-5 $'Which one?'
sub papa SID-Q idle;   task 1016-papa SID-BOSS papa SID-Q;   say SID-Q u-6 $'Which one?'; printf '{"type":"user","uuid":"u-7","message":{"content":"B"}}\n' >>"$T/projects/p/SID-Q.jsonl"
printf '40\n' >"$CREW_ROOT/.dseq"
out=$("$CREW" digest 2>&1)
eq "kilo (a Needs you line) and lima (ends in a question) each got a D-id; the others did not" "D41:D42:::D40:" \
  "$(open_d 1016-kilo):$(open_d 1016-lima):$(open_d 1016-mike):$(open_d 1016-nov):$(open_d 1016-oscar):$(open_d 1016-papa)"
eq "the question is the first line of the message, in its task's ask.md" "asked in its pane: Two ways to go.
asked in its pane: Built it." "$(cat "$CREW_ROOT/1016-kilo/ask.md" "$CREW_ROOT/1016-lima/ask.md")"
eq "and it is in the same digest's Needs you" "Needs you
  D40  oscar via oscar — which one? → crew show 1016-oscar
  D41  kilo via kilo — asked in its pane: Two ways to go. → crew show 1016-kilo
  D42  lima via lima — asked in its pane: Built it. → crew show 1016-lima" "$out"
"$CREW" digest >/dev/null 2>&1; "$CREW" subs >/dev/null 2>&1
eq "more sweeps raise no second D-id for the same message" "42" "$(cat "$CREW_ROOT/.dseq")"
prompt SID-BOSS "D41 A" >/dev/null
"$CREW" digest >/dev/null 2>&1
eq "an answered in-pane question is not raised again" "42:" "$(cat "$CREW_ROOT/.dseq"):$(open_d 1016-kilo)"
say SID-K u-8 $'Next: C or D?'
"$CREW" digest >/dev/null 2>&1
eq "a new question (a new message uuid) gets a new D-id" "D43" "$(open_d 1016-kilo)"


# --- what is not a question for the user ---
sub xray SID-X2 idle;    task 1016-xray SID-BOSS xray SID-X2;     say SID-X2 u-10 $'Done.\nNeeds you: nothing'
sub yankee SID-Y2 idle;  task 1016-yankee SID-BOSS yankee SID-Y2; say SID-Y2 u-11 $'Done.\n**Needs you:** none right now.'
sub zulu SID-Z2 idle;    task 1016-zulu SID-BOSS zulu SID-Z2;     say SID-Z2 u-12 $'Done. Needs you: n/a'
sub alfa2 SID-A2 idle;   task 1016-alfa2 SID-BOSS alfa2 SID-A2;   say SID-A2 u-13 $'Fixed it. See the "why?"'
sub bravo2 SID-B2 idle;  task 1016-bravo2 SID-BOSS bravo2 SID-B2; say SID-B2 u-14 $'Fixed it. Try `make why?`'
sub charlie2 SID-C2 idle; task 1016-charlie2 SID-BOSS charlie2 SID-C2; say SID-C2 u-15 $'Output:\n```\nwhy?\n```'
sub delta2 SID-D2 idle;  task 1016-delta2 SID-BOSS delta2 SID-D2; say SID-D2 u-16 $'Results are in.\n\nNeeds you: pick A or B'
"$CREW" digest >/dev/null 2>&1
eq "'Needs you: nothing/none/n/a', a quoted or code-quoted question mark: no D-id; a real Needs you line: one" "::::::D" \
  "$(open_d 1016-xray):$(open_d 1016-yankee):$(open_d 1016-zulu):$(open_d 1016-alfa2):$(open_d 1016-bravo2):$(open_d 1016-charlie2):$(open_d 1016-delta2 | cut -c1)"

# --- one sweep at a time per sub ---
sub echo2 SID-E2 idle;   task 1016-echo2 SID-BOSS echo2 SID-E2;   say SID-E2 u-20 $'Which port?'
( flock 9 && exec sleep 60 ) 9>"$CREW_ROOT/.locks/paneask-SID-E2" &
holder=$!
sleep 0.3
"$CREW" digest >/dev/null 2>&1
eq "a sweep that finds another sweep of the same sub under way leaves it to that one" "" "$(open_d 1016-echo2)"
kill "$holder"; wait "$holder" 2>/dev/null
"$CREW" digest >/dev/null 2>&1
eq "and the next sweep raises it" "D" "$(open_d 1016-echo2 | cut -c1)"

echo "---"
[ "$fails" -eq 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
