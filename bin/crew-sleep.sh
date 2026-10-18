# crew-sleep.sh — `crew sleep FEATURE`: compact an idle owner and close only its window (sourced by bin/crew after
# crew-owners.sh; formats and helpers there).
# The checks run in this order, each refusal is `refuse` (exit 3) naming what to do:
#   1 registered and awake  2 caller is the lead or the owner  3 running  4 in a tmux pane  5 its window holds only
#   that pane  6 nobody is viewing the window  7 its notes are not older than its newest work log (done, landed, dropped, review lines do not count)  8 pane idle, composer empty
# then /compact (keep the notes), wait for idle, 5 and 6 again plus "the pane still runs this session", and the window
# is closed by its tmux window id (never by name) and the owner recorded asleep; its wake task, if still running, is logged review.
# The pane is addressed by its pane id (%N) once found: window indexes shift when another window closes.
# The owner itself asks mid-turn, so its pane is busy: checks 1-7 run at once, then a detached `crew sleep --deferred`
# (internal) waits for the pane to go idle, runs 5, 6 and 8 and the same compaction and close, and logs the result to
# the owner's sleep.log. Only that waiter may run it: crew sleep hands it a one-time token (owner folder sleep.token,
# mode 600, and CREW_SLEEP_TOKEN in the waiter's env); the waiter also repeats the notes check after its wait.
# The lead's lifecycle sweep (crew-lifecycle.sh) starts the same waiter for an idle owner (sleep_spawn_waiter).

# sleep_locate ID: checks 3 and 4. Sets SL_NAME SL_PID SL_SID (the live session, ids refreshed) and SL_PANE (its tmux pane id, %N).
SL_NAME=""; SL_PID=""; SL_SID=""; SL_PANE=""; SL_WID=""
sleep_locate() {
  local id=$1 row
  row=$(owner_refresh "$id")
  [ -n "$row" ] || refuse "$(owner_get "$id" name) is not running: there is no window to close"
  SL_NAME=$(cut -f1 <<<"$row"); SL_PID=$(cut -f2 <<<"$row"); SL_SID=$(cut -f3 <<<"$row")
  sleep_locate_pane
}
# the pane of the live session SL_NAME/SL_PID/SL_SID (also used by crew close): sets SL_PANE, its pane id
sleep_locate_pane() {
  local pid
  tmap_load
  SL_PANE=$(pane_target "$SL_NAME" "$SL_SID")
  [ -n "$SL_PANE" ] || refuse "$SL_NAME has no tmux pane (it is not running in tmux): nothing to close"
  # tmux expands #{...} in target strings: only a plain session:window.pane (as fg_ok requires) is ever passed to -t
  [[ "$SL_PANE" =~ ^[A-Za-z0-9_-]+:[0-9]+\.[0-9]+$ ]] || refuse "the tmux pane of $SL_NAME has an unusual name: nothing closed"
  # pane_target matches by name: the pane must hold this owner's own session, not another one with the same name
  sleep_pane_owner || refuse "$SL_NAME's tmux pane belongs to another session: nothing was typed"
  # session:index.pane is not stable (renumber-windows renumbers the windows when any other one closes, and the target
  # could then name another Claude by the time /compact is typed): from here on only the pane id (%N) is used
  pid=$(tmux display-message -p -t "$SL_PANE" '#{pane_id}' 2>/dev/null || true)
  [[ "$pid" =~ ^%[0-9]+$ ]] || refuse "could not find the tmux pane id of $SL_NAME: nothing was typed"
  SL_PANE=$pid
  sleep_pane_owner || refuse "$SL_NAME's tmux pane belongs to another session: nothing was typed"
}

# checks 5 and 6 on the pane's window; sets SL_WID, and refuses when the pane has moved to another window since.
# Also refuses when the window is the last of its tmux session (closing it would end the session).
sleep_window() {
  local wid n sid clients
  wid=$(tmux display-message -p -t "$SL_PANE" '#{window_id}' 2>/dev/null || true)
  [[ "$wid" =~ ^@[0-9]+$ ]] || refuse "could not find the tmux window of $SL_NAME's pane: nothing closed"
  [ -z "$SL_WID" ] || [ "$wid" = "$SL_WID" ] || refuse "$SL_NAME's pane moved to another window: nothing closed"
  SL_WID=$wid
  n=$(tmux list-panes -t "$wid" -F x 2>/dev/null | wc -l || true)
  [ "$n" -eq 1 ] || refuse "window has $n panes (e.g. an nvim split): close the others first"
  # a tmux error must not read as "nobody is viewing": capture the list first, match it in bash
  clients=$(tmux list-clients -F '#{window_id}' 2>/dev/null) || refuse "cannot tell who is viewing: nothing closed"
  case $'\n'"$clients"$'\n' in   # (crew close as the user skips this: SL_NOVIEW=1)
    *$'\n'"$wid"$'\n'*) [ "${SL_NOVIEW:-0}" = 1 ] || refuse "the user is viewing $SL_NAME's window; try again later" ;;
  esac
  sid=$(tmux display-message -p -t "$wid" '#{session_id}' 2>/dev/null || true)
  [[ "$sid" =~ ^\$[0-9]+$ ]] || refuse "could not find the tmux session of $SL_NAME's window: nothing closed"
  n=$(tmux list-windows -t "$sid" -F x 2>/dev/null | wc -l || true)
  [ "$n" -gt 1 ] || refuse "$SL_NAME's window is the last one in its tmux session: nothing closed"
}

# the owner's session pid is still inside the pane's process tree (the pane was not reused by something else)
sleep_pane_owner() {
  local pp p=$SL_PID i
  pp=$(tmux display-message -p -t "$SL_PANE" '#{pane_pid}' 2>/dev/null || true)
  [[ "$pp" =~ ^[0-9]+$ ]] || return 1
  for i in $(seq 1 64); do
    [ "$p" != "$pp" ] || return 0
    [[ "$p" =~ ^[0-9]+$ ]] && [ "$p" -gt 1 ] || return 1
    p=$(ps -o ppid= -p "$p" 2>/dev/null | tr -d ' ' || true)
  done
  return 1
}

# check 7: the notes exist and are not older than the newest status line of the owner's session's tasks that is not a
# finishing one (done, landed, dropped, review come after the work: they are skipped), at second granularity; with no
# such line, not older than when the owner was created or last woken
sleep_notes() {
  local id=$1 f nm ts w ref what d s line prev="$CREW_ROOT/.prev/$(sid_key "$SL_SID")" LC_COLLATE=C
  f=$(owner_get "$id" notes); [ -n "$f" ] || f=$(owner_dir "$id")/notes.md
  [ -s "$f" ] || refuse "notes at $f are missing or empty: ask the owner to write them first"
  nm=$(stat -c %Y "$f" 2>/dev/null || echo 0)
  ts=""; what=""
  for d in "$CREW_ROOT"/*/; do   # the tasks of the session, as sub_tasks finds them
    d=${d%/}
    [ -f "$d/status" ] || continue
    s=$(meta_get "$d" sub_sid)
    [ -n "$s" ] && { [ "$s" = "$SL_SID" ] || { [ -f "$prev" ] && grep -qxF -- "$s" "$prev"; }; } || continue
    line=$(awk -F'\t' '$2 != "done" && $2 != "landed" && $2 != "dropped" && $2 != "review" && $1 > m {m = $1} END {print m}' "$d/status")
    if [[ "$line" > "$ts" ]]; then ts=$line; what="the last log line of $(basename "$d")"; fi
  done
  if [ -z "$ts" ]; then
    ts=$(owner_get "$id" created); w=$(owner_get "$id" woken_at)
    [[ "$w" < "$ts" ]] || ts=$w
    what="$id's creation"
  fi
  # a time it cannot read must refuse (date -d "" is midnight today): only the ISO form crew writes counts
  [[ "$ts" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] && ref=$(date -u -d "$ts" +%s 2>/dev/null) ||
    refuse "cannot read the time of $what: nothing closed"
  [ "$nm" -ge "$ref" ] || refuse "notes at $f are older than its last task log: ask the owner to update its notes first"
}

# check 8
sleep_idle() {
  pane_read "$SL_PANE" || refuse "$SL_NAME: $P_REASON: nothing was typed"
  case "$P_STATE" in
    idle) ;;
    busy) refuse "$SL_NAME is busy (mid-turn): try again when it is idle" ;;
    prompt) refuse "a prompt is open in $SL_NAME's pane: answer it in tmux first" ;;
    draft) refuse "unsent text in $SL_NAME's composer (draft): nothing was typed" ;;
    *) refuse "$SL_NAME's composer is not visible ($P_STATE): nothing was typed" ;;
  esac
}

# Has the transcript of session $1 got a compact_boundary record stamped at or after $2 (ISO, compared to the second)?
# Claude appends it when a compaction is over; the pane alone cannot tell (the compacting screen has no composer text).
sleep_boundary_seen() {
  local sid=$1 since=$2 f="" g out
  [[ "$sid" =~ ^[A-Za-z0-9-]+$ ]] || return 1
  for g in "${CREW_PROJECTS:-$HOME/.claude/projects}"/*/"$sid".jsonl; do [ -f "$g" ] && { f=$g; break; }; done
  [ -n "$f" ] || return 1
  out=$(tail -c 3000000 "$f" | grep -a 'compact_boundary' | jq -Rr --arg since "$since" 'fromjson? | select(.type == "system" and .subtype == "compact_boundary" and ((.timestamp // "")[0:19] >= $since[0:19])) | .timestamp' 2>/dev/null || true)
  [ -n "$out" ]
}

# /compact, wait, look again, close the window by id, record the owner asleep. One sleep per owner at a time.
sleep_close() {
  local id=$1 focus reason row win t i still="" exitw=${CREW_SLEEP_EXIT_S:-3} since deadline poll=${CREW_COMPACT_POLL_S:-1}
  [[ "$poll" =~ ^[0-9]+(\.[0-9]+)?$ ]] || poll=1
  [[ "$exitw" =~ ^[0-9]+$ ]] || exitw=3
  mkdir -p "$CREW_ROOT/.locks"
  exec 8>"$CREW_ROOT/.locks/sleep-$id"
  flock -n 8 || refuse "another sleep of $id is under way"
  # another sleep may have finished while this one was on its way to the lock
  [ "$(owner_get "$id" state)" = awake ] || refuse "$id is already asleep"
  focus=$(one_line "asleep next: keep $id owner notes (crew owners --notes $id), open talk threads, interface decisions, next step")
  sub_tasks "$SL_SID"
  # the pane must still hold the owner right before anything is typed (it may have waited for the lock)
  sleep_pane_owner || refuse "the pane no longer holds $SL_NAME's session: nothing was typed"
  since=$(now); deadline=$(($(date +%s) + ${CREW_COMPACT_WAIT_S:-120}))
  if ! reason=$(compact_send "$SL_NAME" "$SL_SID" "$SL_PANE" "${focus:0:900}"); then refuse "$reason"; fi
  compact_wait "$SL_PANE" || refuse "still busy after compaction; nothing closed"
  # the pane may look idle before the compaction is over: the window stays until the transcript says it ended
  until sleep_boundary_seen "$SL_SID" "$since"; do
    [ "$(date +%s)" -lt "$deadline" ] || refuse "the compaction was not confirmed in the transcript: nothing closed"
    sleep "$poll"
  done
  # the world may have moved while it compacted: the same session, in the same lone, unwatched window
  row=$(owner_refresh "$id")
  [ -n "$row" ] || refuse "$SL_NAME stopped running during the compaction: nothing closed"
  SL_NAME=$(cut -f1 <<<"$row"); SL_PID=$(cut -f2 <<<"$row"); SL_SID=$(cut -f3 <<<"$row")
  sleep_pane_owner || refuse "the pane no longer holds $SL_NAME's session: nothing closed"
  sleep_window
  win=$(one_line "$(tmux display-message -p -t "$SL_WID" '#{session_name}:#{window_name}' 2>/dev/null || true)")
  # input in the composer, or a new turn, since the compaction ended: closing the window would lose it
  pane_read "$SL_PANE" || refuse "$SL_NAME's pane could not be read after the compaction ($P_REASON): nothing closed"
  [ "$P_STATE" = idle ] || refuse "$SL_NAME got input during compaction: nothing closed"
  tmux kill-window -t "$SL_WID" >/dev/null 2>&1 || refuse "tmux could not close the window: $SL_NAME is still awake"
  # the session may outlive the window's SIGHUP for a moment, and a refresh that sees it live would flip the owner back
  # to awake: wait (bounded) until the process is gone before recording asleep
  if [[ "$SL_PID" =~ ^[0-9]+$ ]]; then
    for i in $(seq 1 $((${exitw%.*} * 10))); do kill -0 "$SL_PID" 2>/dev/null || break; sleep 0.1; done
    ! kill -0 "$SL_PID" 2>/dev/null || still=" ($SL_NAME still exiting)"
  fi
  owner_set "$id" state=asleep "slept_at=$(now)" "window=$win" "sid=$SL_SID" "name=$SL_NAME"
  # a wake task still running when the owner falls asleep would stay in flight under its lead for good
  t=$(owner_get "$id" task)
  if [[ "$t" =~ ^[A-Za-z0-9._-]+$ ]] && [ -f "$CREW_ROOT/$t/status" ] && [ "$(meta_get "$CREW_ROOT/$t" owner)" = "$id" ] &&
    [ "$(state_of "$CREW_ROOT/$t")" = running ]; then
    (cmd_log "$t" review "$id fell asleep before it logged done") >/dev/null 2>&1 || true
  fi
  echo "asleep: $id ($SL_NAME), window $win closed$still"
}

# the body of the detached waiter: wait for the owner's turn to end, then checks 5, 6, 8 and the close
sleep_deferred_run() {
  local id=$1 wait=${CREW_SLEEP_WAIT_S:-600} poll=${CREW_SLEEP_POLL_S:-2} end tf
  [[ "$wait" =~ ^[0-9]+$ ]] || wait=600
  [[ "$poll" =~ ^[0-9]+(\.[0-9]+)?$ ]] || poll=2
  # only the waiter that cmd_sleep started holds the token: --deferred does not skip the caller rule or the notes check
  tf=$(owner_dir "$id")/sleep.token
  [ -n "${CREW_SLEEP_TOKEN:-}" ] && [ -f "$tf" ] && [ "$(cat "$tf" 2>/dev/null)" = "$CREW_SLEEP_TOKEN" ] ||
    refuse "sleep --deferred is internal (crew sleep starts it): no valid token"
  rm -f "$tf"
  [ "$(owner_get "$id" state)" = awake ] || refuse "$id is already asleep"
  sleep_locate "$id"
  end=$(($(date +%s) + wait))
  while pane_read "$SL_PANE" && [ "$P_STATE" = busy ]; do
    [ "$(date +%s)" -lt "$end" ] || refuse "$SL_NAME is still busy after ${wait}s: not put to sleep"
    sleep "$poll"
  done
  [ "$(owner_get "$id" state)" = awake ] || refuse "$id is already asleep"
  # the wait may have been long: the owner may have exited or moved, and its pane index may now hold another session
  sleep_locate "$id"
  sleep_window
  sleep_notes "$id"   # the owner may have logged a task during the wait
  sleep_idle
  sleep_close "$id"
}

sleep_deferred() {
  local id=$1 log res rc=0
  owner_exists "$id" || refuse "$id is not an owner (crew owners lists them)"
  log=$(owner_dir "$id")/sleep.log
  res=$(sleep_deferred_run "$id" 2>&1) || rc=$?
  res=${res#crew: refused: }
  printf '%s\t%s\n' "$(now)" "$(one_line "$res")" >>"$log"
}

# Start the detached waiter for owner $1 (checks 1-7 have passed): a one-time token (file mode 600 + the waiter's env) is
# what lets --deferred run at all; argv only, no shell string. Used by cmd_sleep (role 2) and the lifecycle sweep.
sleep_spawn_waiter() {
  local id=$1 log token
  log=$(owner_dir "$id")/sleep.log
  token=$(head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' || true)
  [ "${#token}" -eq 32 ] || die "could not make a sleep token"
  (umask 077; printf '%s\n' "$token" >"$(owner_dir "$id")/sleep.token")
  setsid env "CREW_ROOT=$CREW_ROOT" "CREW_SESSIONS=$CREW_SESSIONS" "CREW_SLEEP_TOKEN=$token" "$CREW_BIN/crew" sleep --deferred "$id" </dev/null >>"$log" 2>&1 &
  disown
}

cmd_sleep() {
  local deferred=0 id="" role log
  while [ $# -gt 0 ]; do
    case "$1" in
      --deferred) deferred=1; shift ;;
      -*) die "unknown flag $1" ;;
      *) [ -z "$id" ] || die "sleep takes one FEATURE"; id=$1; shift ;;
    esac
  done
  [ -n "$id" ] || die "sleep needs FEATURE"
  if [ $deferred = 1 ]; then sleep_deferred "$id"; return 0; fi
  owner_exists "$id" || refuse "$id is not an owner (crew owners lists them)"
  [ "$(owner_get "$id" state)" = awake ] || refuse "$id is already asleep (crew wake $id brings it back)"
  role=$(owner_caller_role "$id")
  [ "$role" != 0 ] || refuse "only $id's lead ($(owner_get "$id" lead)) or the owner may put it to sleep"
  sleep_locate "$id"
  sleep_window
  sleep_notes "$id"
  if [ "$role" = 2 ]; then
    # the owner is mid-turn: a detached waiter does the rest once the turn is over
    log=$(owner_dir "$id")/sleep.log
    sleep_spawn_waiter "$id"
    echo "will sleep when this turn ends (result in $log)"
    return 0
  fi
  sleep_idle
  sleep_close "$id"
}
