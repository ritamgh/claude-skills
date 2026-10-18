# crew-answer.sh — answers flow down the chain, and a sub's in-pane question reaches its lead (skill: crew, "Answers").
# Sourced by bin/crew before its dispatch; never run alone. Everything from bin/crew is in scope.
#
# 1. deliver-answer: what the USER typed (the UserPromptSubmit hook, hooks/crew-answer-hook.sh) or clicked (HQ's Answer
#    button) as the answer to an open D-id is recorded (`crew answer`) and typed into the asking sub's composer as the
#    user's words. It is not for models: the subcommand is not in --help and needs $CREW_DELIVER_KEY, the content of
#    $CREW_ROOT/.deliver-key, which only the hook and HQ pass (the guard hook also refuses a Bash command naming it). The
#    text waits in $CREW_ROOT/.pending-answers/<task>.<D-id> (key=value, with a mac over the key) while the sub's pane is
#    busy, has a draft or a prompt open; each digest/subs of the lead retries it and shows it under "Answers waiting".
# 2. pane_ask_sweep: a live sub that is idle and whose last assistant message has a "Needs you" line or ends in a
#    question gets one `crew ask` on its open task (key: the message uuid, kept in $CREW_ROOT/.pane-asks/<sessionId>).

ANS_MAX=2000

# SID and every earlier id of the same session (.prev, written by `crew relink`), one per line
ans_ids() { printf '%s\n' "$1"; cat "$CREW_ROOT/.prev/$(sid_key "$1")" 2>/dev/null || true; }

ans_key_ok() { local k; k=$(cat "$CREW_ROOT/.deliver-key" 2>/dev/null) || return 1; [ -n "$k" ] && [ "${CREW_DELIVER_KEY:-}" = "$k" ]; }
ans_mac() { printf '%s' "$(cat "$CREW_ROOT/.deliver-key" 2>/dev/null)|$1|$2|$3|$4" | sha256sum | cut -d' ' -f1; }

# The one place the answer text is cleaned, for the hook and for HQ: line breaks and tabs become a space, every Unicode
# C* character (control, format, bidi, private, unassigned), U+2028 and U+2029 are dropped, then trimmed to ANS_MAX characters.
ans_clean() {
  printf '%s' "$1" | python3 -I -c '
import re, sys, unicodedata
t = sys.stdin.buffer.read().decode("utf-8", "replace")
t = re.sub(r"[\r\n\t\u2028\u2029]+", " ", t)
t = "".join(c for c in t if unicodedata.category(c)[0] != "C")
sys.stdout.write(t.strip()[:int(sys.argv[1])])' "$ANS_MAX"
}

# the transcript file of session $1, else nothing
ans_transcript() {
  local g
  [[ "$1" =~ ^[A-Za-z0-9-]+$ ]] || return 0
  for g in "${CREW_PROJECTS:-$HOME/.claude/projects}"/*/"$1".jsonl; do [ -f "$g" ] && { printf '%s' "$g"; return 0; }; done
  return 0
}
# did the line reach session $1? (a user record of its transcript holds it)
ans_arrived() {
  local f j; f=$(ans_transcript "$1"); [ -n "$f" ] || return 1
  j=$(jq -nr --arg s "$2" '$s | @json') && j=${j#\"} && j=${j%\"}
  tail -c 3000000 "$f" | grep -aqF -- "$j"
}
ans_norm() { printf '%s' "${1//[[:space:]]/}"; }   # (Claude wraps a long line, also in the middle of a word: whitespace is not compared)

# ANS_MSG: why the answer is still waiting, or whom it was delivered to
ANS_MSG=""
ans_wait() { ANS_MSG=$2; printf 'waiting=%s\n' "$2" >>"$1" 2>/dev/null || true; }

# After typing went wrong (runs under the pane's lock): a composer that holds only the start of our line is cleared with
# Ctrl-U (the line then counts as not typed); anything else in it is left alone, and the entry stays marked typed.
ans_fail() { # file pane line why
  local c l
  l=$(ans_norm "$3")
  pane_read "$2" || true
  if c=$(composer_text "$P_SCREEN" 2>/dev/null); then
    c=$(ans_norm "$c")
    if [ -z "$c" ]; then printf 'typed=0\n' >>"$1"; echo "waiting: $4"; return 0; fi
    if [ "$c" != "$l" ] && [[ "$l" == "$c"* ]]; then
      tmux send-keys -t "$2" C-u >/dev/null 2>&1 || true
      sleep 0.1
      pane_read "$2" || true
      if c=$(composer_text "$P_SCREEN" 2>/dev/null) && [ -z "$(ans_norm "$c")" ]; then printf 'typed=0\n' >>"$1"; echo "waiting: partial text cleared"; return 0; fi
    fi
  fi
  echo "waiting: partial text in composer"
}

# Types the line (under the pane's lock) unless it already was; prints "waiting: WHY" or nothing when delivered.
ans_locked() { # file pane line sub-sid
  local f=$1 pane=$2 line=$3 sid=$4 typed c l i
  [ -f "$f" ] || return 0   # another call delivered it while this one waited for the lock
  typed=$(link_get "$f" typed); l=$(ans_norm "$line")
  pane_read "$pane" || { echo "waiting: $P_REASON"; return 0; }
  case "$P_STATE" in
    busy) echo "waiting: busy"; return 0 ;;
    prompt) echo "waiting: prompt open"; return 0 ;;
    nocomposer) echo "waiting: no composer"; return 0 ;;
  esac
  c=$(ans_norm "$P_COMPOSER")
  if [ "$typed" = 1 ]; then   # a try that went wrong earlier: never type the line a second time unless it did not arrive
    if [ "$c" = "$l" ]; then   # it sits whole in the composer: Enter alone completes it
      tmux send-keys -t "$pane" Enter >/dev/null 2>&1 || { echo "waiting: tmux send-keys failed"; return 0; }
      rm -f "$f"; return 0
    fi
    if [ -n "$c" ]; then
      [[ "$l" == "$c"* ]] || { echo "waiting: partial text in composer"; return 0; }
      tmux send-keys -t "$pane" C-u >/dev/null 2>&1 || true
      sleep 0.1
      pane_read "$pane" && [ "$P_STATE" = idle ] || { echo "waiting: partial text in composer"; return 0; }
    fi
    if ans_arrived "$sid" "$line"; then rm -f "$f"; return 0; fi
    printf 'typed=0\n' >>"$f"
  elif [ -n "$c" ]; then
    echo "waiting: draft"; return 0
  fi
  tmux send-keys -t "$pane" -l -- "$line" >/dev/null 2>&1 || { ans_fail "$f" "$pane" "$line" "tmux send-keys failed"; return 0; }
  printf 'typed=1\n' >>"$f"
  for i in $(seq 1 40); do
    pane_read "$pane" || { ans_fail "$f" "$pane" "$line" "$P_REASON"; return 0; }
    case "$P_STATE" in busy | prompt) ans_fail "$f" "$pane" "$line" "$P_STATE while typing"; return 0 ;; esac
    if [ "$(ans_norm "$P_COMPOSER")" = "$l" ]; then break; fi
    [ "$i" -lt 40 ] || { ans_fail "$f" "$pane" "$line" "the composer does not hold the typed text"; return 0; }
    sleep 0.025
  done
  tmux send-keys -t "$pane" Enter >/dev/null 2>&1 || { echo "waiting: tmux send-keys failed (the line sits in the composer)"; return 0; }
  rm -f "$f"
}

# Types pending answer file $1 into the asking sub's composer and presses Enter. Returns 0 delivered (file removed),
# 1 still waiting (ANS_MSG says why), 2 dropped (the task is over, or the entry is not genuine).
ans_try() {
  local f=$1 task did lsid via text mac d st sub_sid sub r name sid target pane line why
  if [ -z "$(cat "$CREW_ROOT/.deliver-key" 2>/dev/null)" ]; then rm -f "$f"; ANS_MSG="no key"; return 2; fi   # (an empty key would make the MAC forgeable)
  task=$(link_get "$f" task); did=$(link_get "$f" did); lsid=$(link_get "$f" lead_sid); via=$(link_get "$f" via); text=$(link_get "$f" text); mac=$(link_get "$f" mac)
  if [ -z "$mac" ] || [ "$(ans_mac "$task" "$did" "$lsid" "$text")" != "$mac" ]; then rm -f "$f"; ANS_MSG="not genuine"; return 2; fi
  d="$CREW_ROOT/$task"; st=$(state_of "$d")
  case "$st" in "" | done | landed | dropped) rm -f "$f"; ANS_MSG="task is over"; return 2 ;; esac
  sub_sid=$(meta_get "$d" sub_sid); sub=$(meta_get "$d" sub)
  sess_load
  r=$(resolve_session "$sub_sid" "")   # by sessionId (and its .prev chain) only: a new session that reuses the name is not the sub
  [ -n "$r" ] || { ans_wait "$f" "sub gone"; return 1; }
  name=$(cut -f1 <<<"$r"); sid=$(cut -f3 <<<"$r")
  tmap_load
  target=$(pane_target "$name" "$sid")
  [ -n "$target" ] || { ans_wait "$f" "no tmux pane"; return 1; }
  pane=$(tmux -u display-message -p -t "$target" '#{pane_id}' 2>/dev/null) || pane=""
  [[ "$pane" =~ ^%[0-9]+$ ]] || { ans_wait "$f" "no tmux pane"; return 1; }
  line="$did (your answer, relayed verbatim by $via): $text"
  mkdir -p "$CREW_ROOT/.locks"
  why=$( (flock 9; ans_locked "$f" "$pane" "$line" "$sid") 9>"$CREW_ROOT/.locks/answer-$(sid_key "$sid")" )
  if [ -n "$why" ]; then ans_wait "$f" "${why#waiting: }"; return 1; fi
  ANS_MSG=$name
  return 0
}

# crew deliver-answer [--sid LEADSID] [--via WHO] --did D<n> -- TEXT   (prints: delivered NAME | waiting WHY | nosub | ignored WHY)
cmd_deliver_answer() {
  ans_key_ok || die "unknown command 'deliver-answer'"
  local sid="" did="" via="" text=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --sid) sid=${2:-}; shift 2 ;;
      --did) did=${2:-}; shift 2 ;;
      --via) via=${2:-}; shift 2 ;;
      --) text=${2:-}; break ;;
      *) die "deliver-answer: unknown flag $1" ;;
    esac
  done
  is_did "$did" || die "deliver-answer: bad --did"
  did="D${did#[Dd]}"; via=$(ans_clean "$via"); text=$(ans_clean "$text")
  [ -n "$text" ] || die "deliver-answer needs a text"
  [ -n "$via" ] || [ -n "$sid" ] || die "deliver-answer needs --via or --sid"
  local d task lsid sub_sid ids=""
  [ -z "$sid" ] || ids=$(ans_ids "$sid")
  d=$(decision_dir "$did") || { echo "ignored: no open decision $did"; return 0; }
  task=$(basename "$d"); lsid=$(meta_get "$d" lead_sid); sub_sid=$(meta_get "$d" sub_sid)
  if [ -n "$sid" ]; then   # the hook: only the answers of this lead's own tasks
    [ -n "$lsid" ] && grep -qxF -- "$lsid" <<<"$ids" || { echo "ignored: $did is not a task of this session"; return 0; }
  fi
  if [ -z "$via" ]; then   # the hook: the lead's own name
    sess_load
    via="$(cut -f1 <<<"$(resolve_session "$sid" "")")"; via="${via:-$(meta_get "$d" lead)}'s input hook"
  fi
  cmd_answer "$did" "$text"
  # no sub, or the asking session is the lead itself (it reads what the user typed): nothing to type
  if [ -z "$sub_sid" ] || { [ -n "$sid" ] && grep -qxF -- "$sub_sid" <<<"$ids"; }; then echo "nosub"; return 0; fi
  local f="$CREW_ROOT/.pending-answers/$task.$did"
  mkdir -p "$CREW_ROOT/.pending-answers"
  printf 'task=%s\ndid=%s\nlead_sid=%s\nvia=%s\ntext=%s\nmac=%s\ncreated=%s\n' "$task" "$did" "$lsid" "$via" "$text" "$(ans_mac "$task" "$did" "$lsid" "$text")" "$(now)" >"$f.tmp.$$" && mv "$f.tmp.$$" "$f"
  if ans_try "$f"; then echo "delivered $ANS_MSG"; else echo "waiting $ANS_MSG"; fi
}

# Retry the pending answers of lead LSID (any of its earlier ids); never fails the caller.
answers_sweep() {
  local f ids
  [ -d "$CREW_ROOT/.pending-answers" ] || return 0
  ids=$(ans_ids "$1")
  for f in "$CREW_ROOT"/.pending-answers/*; do
    [ -f "$f" ] && [[ "$f" != *.tmp.* ]] || continue
    grep -qxF -- "$(link_get "$f" lead_sid)" <<<"$ids" || continue
    ans_try "$f" || true
  done
  return 0
}

# The "Answers waiting" block of lead LSID's digest, empty when nothing waits
answers_waiting_lines() {
  local f ids out="" task did why
  [ -d "$CREW_ROOT/.pending-answers" ] || return 0
  ids=$(ans_ids "$1")
  for f in "$CREW_ROOT"/.pending-answers/*; do
    [ -f "$f" ] && [[ "$f" != *.tmp.* ]] || continue
    grep -qxF -- "$(link_get "$f" lead_sid)" <<<"$ids" || continue
    task=$(link_get "$f" task); did=$(link_get "$f" did); why=$(link_get "$f" waiting)
    out+="  $did  $(short_name "$task") — waiting: ${why:-not yet tried}"$'\n'
  done
  [ -z "$out" ] || printf 'Answers waiting\n%s' "$out"
}

# --- an in-pane question becomes a D-id ---
# L_UUID, L_TEXT: the uuid and last text block of session $1's latest transcript record, when that is an assistant record
# with text (anything else: the sub is not at a stop where it waits for the user). Fails when there is none.
L_UUID=""; L_TEXT=""
say_read() {
  local sid=$1 f="" g out size n=3000000 b64
  L_UUID=""; L_TEXT=""
  [[ "$sid" =~ ^[A-Za-z0-9-]+$ ]] || return 1
  for g in "${CREW_PROJECTS:-$HOME/.claude/projects}"/*/"$sid".jsonl; do [ -f "$g" ] && { f=$g; break; }; done
  [ -n "$f" ] || return 1
  size=$(stat -c %s "$f" 2>/dev/null || echo 0)
  while :; do
    out=$(tail -c "$n" "$f" | grep -aE '"type": ?"(assistant|user)"' | jq -Rr 'fromjson? | select((.type == "assistant" or .type == "user") and .isSidechain != true) | [.type, (.uuid // ""), (if .type == "assistant" then ([.message.content[]? | select(.type == "text") | .text] | last // "") else "" end | @base64)] | @tsv' 2>/dev/null | tail -n 1 || true)
    if [ -n "$out" ] || [ "$n" -ge "$size" ]; then break; fi
    n=$((n * 10))
  done
  [ -n "$out" ] || return 1
  IFS=$'\t' read -r g L_UUID b64 <<<"$out"
  [ "$g" = assistant ] && [ -n "$L_UUID" ] && [ -n "$b64" ] || return 1
  L_TEXT=$(printf '%s' "$b64" | base64 -d 2>/dev/null) || return 1
  [ -n "${L_TEXT//[[:space:]]/}" ]
}

# Does the text ask the user something? A "Needs you:" line with real text after it (not nothing/none/n/a), or a last
# paragraph that ends in a question mark outside code and quotes.
asks_user() {
  printf '%s' "$1" | python3 -I -c '
import re, sys
t = sys.stdin.read()
lines = t.split("\n")
for n, l in enumerate(lines):
    m = re.match(r"^[\s#>*_`-]*needs you[\s*_`]*(:?)[\s*_`]*(.*)$", l, re.I)
    if not m:
        continue
    rest = m.group(2).strip(" \t*_`.")
    if not m.group(1) and not rest:   # a heading: the text is on the next line
        rest = next((x.strip(" \t*_`.-") for x in lines[n + 1:] if x.strip()), "")
    elif not m.group(1):
        continue
    if rest and not re.match(r"^(nothing|none|n/a|nil|no)\b", rest, re.I):
        sys.exit(0)
t = re.sub(r"```.*?(```|\Z)", "", t, flags=re.S)
t = re.sub(r"`[^`\n]*`", "", t)
t = re.sub(r"\"[^\"\n]*\"|“[^”\n]*”", "", t)
paras = [p for p in re.split(r"\n\s*\n", t) if p.strip()]
last = paras[-1].rstrip(" \t\n*_)") if paras else ""
sys.exit(0 if last.endswith("?") else 1)'
}

# One sweep at a time per sub (a lock): the marker check, the `crew ask` and the marker write are one step.
# pane_ask_one NAME SID LEAD-NAME LEAD-SID
pane_ask_one() {
  local n=$1 sid=$2 mk d t line target
  mk="$CREW_ROOT/.pane-asks/$(sid_key "$sid")"
  say_read "$sid" || return 0
  [ "$(cat "$mk" 2>/dev/null || true)" != "$L_UUID" ] || return 0
  asks_user "$L_TEXT" || return 0
  sub_tasks "$sid"
  t=""
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    if [ -z "$t" ] || [ "$d" = "$T_LAST" ]; then t=$d; fi
  done <<<"$T_OPEN"
  if [ -n "$t" ] && [ -z "$(open_decision "$t")" ]; then   # (a task that already has a D-id has asked)
    tmap_load
    target=$(pane_target "$n" "$sid")
    [ -n "$target" ] && pane_read "$target" && [ "$P_STATE" = idle ] || return 0   # not at rest yet: look again next time
    line=$(one_line "$(awk 'NF {print; exit}' <<<"$L_TEXT")")
    cmd_ask "$(basename "$t")" "asked in its pane: ${line:0:160}" >/dev/null 2>&1 || true
  fi
  printf '%s\n' "$L_UUID" >"$mk"
}

# One `crew ask` for each question a live, idle sub of lead (name $1, sessionId $2) left in its own pane. Silent.
pane_ask_sweep() {
  local n s sid
  grep -qsFx -e "parent_sid=$2" -e "parent_name=$1" "$CREW_ROOT"/.links/* 2>/dev/null || return 0
  mkdir -p "$CREW_ROOT/.pane-asks" "$CREW_ROOT/.locks"
  while IFS=$'\t' read -r n s sid; do
    [ "$s" = live ] || continue
    ( flock -n 9 || exit 0; pane_ask_one "$n" "$sid" ) 9>"$CREW_ROOT/.locks/paneask-$(sid_key "$sid")" || true
  done < <(subs_of "$1" "$2")
  return 0
}
