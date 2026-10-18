# crew-lifecycle.sh — the lifecycle sweep of `crew digest` and `crew subs` (sourced by bin/crew after crew-answer.sh;
# everything from bin/crew is in scope: subs_of, sub_tasks, state_of, meta_get, sid_key, one_line, short_name, ...).
# lifecycle_sweep LEAD LSID ACT prints zero or more one-line action items for the lead, first in both outputs:
#   closed X (landed)      a live sub whose newest task is landed and which has no open and no done task was closed (`crew
#                          close`'s own checks: idle, empty composer, nobody viewing)
#   close X pending: ...   `crew close` refused (viewed, busy, draft ...); retried on every sweep, said once per reason
#   verify X? (T done) ... a sub whose tasks are done but not landed: the lead lands it or reopens it (standing)
# ACT=1 may close; ACT=0 (--peek, --lead) only lists the standing items. crew-owners.sh, crew-sleep.sh and crew-close.sh
# (they define refuse, cmd_close ...) are sourced only when there is a sub to close; refuse exits, so every action runs
# in a subshell. Registered owners are never closed here: they sleep.
# Cheap when idle: no link names this lead and no owner is led by it means no tmux call and no transcript read.

# the sid is a registered feature owner, or continues one (.prev: it resumed under a new sessionId); its window is slept,
# never closed, by the sweep
lifecycle_is_owner() {
  local prev="$CREW_ROOT/.prev/$(sid_key "$1")" a=(-e "sid=$1") id
  if [ -f "$prev" ]; then while IFS= read -r id; do [ -z "$id" ] || a+=(-e "sid=$id"); done <"$prev"; fi
  grep -qsFx "${a[@]}" "$CREW_ROOT"/.owners/*/owner 2>/dev/null
}

# every task of session $1 in state done, "id" per line (a task is the sub's by its sub_sid, or an earlier id of the
# same session: .prev, as sub_tasks)
lifecycle_done_tasks() {
  local d s prev="$CREW_ROOT/.prev/$(sid_key "$1")"
  for d in "$CREW_ROOT"/*/; do
    d=${d%/}
    [ -f "$d/status" ] || continue
    s=$(meta_get "$d" sub_sid)
    [ -n "$s" ] && { [ "$s" = "$1" ] || { [ -f "$prev" ] && grep -qxF -- "$s" "$prev"; }; } || continue
    [ "$(state_of "$d")" != done ] || basename "$d"
  done
}

# --- close: a landed sub's window is closed, retried while `crew close` refuses ---
# $1 name, $2 sid (sub_tasks has run for it), $3 its done tasks (lifecycle_done_tasks: unverified work keeps it open);
# prints the line for this sweep, if any. A sub that no longer qualifies loses its pending marker silently. Runs in a
# subshell of the caller ($(...)): the sourced files do not outlive it.
lifecycle_close_one() {
  local name=$1 sid=$2 dir="$CREW_ROOT/.lifecycle/close-pending" mark out rc=0 reason
  mark="$dir/$(sid_key "$2")"
  if [ -n "$T_OPEN" ] || [ "$T_LAST_STATE" != landed ] || [ -n "$3" ]; then rm -f "$mark"; return 0; fi
  . "$CREW_BIN/crew-owners.sh"; . "$CREW_BIN/crew-sleep.sh"; . "$CREW_BIN/crew-close.sh"
  out=$( (cmd_close "$name") 2>&1 ) || rc=$?
  if [ $rc = 0 ]; then
    rm -f "$mark"; printf 'closed %s (landed)\n' "$name"
    return 0
  fi
  reason=$(one_line "${out#crew: refused: }"); reason=${reason#crew: }
  if [ "$(cat "$mark" 2>/dev/null || true)" != "$reason" ]; then
    { mkdir -p "$dir" && printf '%s\n' "$reason" >"$mark.tmp" && mv "$mark.tmp" "$mark"; } || true
    printf 'close %s pending: %s; retrying next sweep\n' "$name" "$reason"
  fi
}

# --- sleep: an idle owner is put to sleep by crew sleep's own detached waiter; its result is reported by a later sweep ---
# seconds since the ISO time $1 (now is CREW_NOW's); fails when it is not one crew writes (date -d "" is midnight today)
lifecycle_age() {
  local e
  [[ "$1" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$ ]] && e=$(date -u -d "$1" +%s 2>/dev/null) || return 1
  echo $(($(date -u -d "$(now)" +%s) - e))
}

# owner $1 reports to this lead: the session its lead_sid resolves to (.prev followed), never by name: a new session that
# took a dead lead's name is not that lead (as owner_caller_role)
lifecycle_owner_is_led() {
  local r
  r=$(owner_lead "$1")
  [ -n "$r" ] && [ "$(cut -f3 <<<"$r")" = "$3" ]
}

# Owner $1 (runs in a subshell of the caller, crew-owners.sh and crew-sleep.sh sourced): prints the line for this sweep, if
# any. $owner/sweep-sleep holds `started=<iso>` of the last attempt and `reported=1` once its result was said.
lifecycle_owner_sleep() {
  local f=$1 d mark started res row sid newest ts wt age idle=${CREW_OWNER_IDLE_S:-600} retry=${CREW_OWNER_RETRY_S:-1800} LC_COLLATE=C
  [[ "$idle" =~ ^[0-9]+$ ]] || idle=600
  [[ "$retry" =~ ^[0-9]+$ ]] || retry=1800
  d=$(owner_dir "$f"); mark="$d/sweep-sleep"
  started=$(sed -n 's/^started=//p' "$mark" 2>/dev/null | tail -n 1 || true)
  # the waiter of an earlier sweep has logged its result (a line stamped at or after the attempt): say it once
  if [ -n "$started" ] && ! grep -qxF reported=1 "$mark" 2>/dev/null; then
    res=$(S=$started LC_ALL=C awk -F'\t' '$1 >= ENVIRON["S"] {r = $2} END {print r}' "$d/sleep.log" 2>/dev/null || true)
    if [ -n "$res" ]; then
      printf 'reported=1\n' >>"$mark"
      case "$res" in asleep:*) printf 'slept %s\n' "$f" ;; *) printf 'sleep %s refused: %s\n' "$f" "$res" ;; esac
      return 0
    fi
  fi
  [ "$(owner_get "$f" state)" = awake ] || return 0
  # one attempt per owner per CREW_OWNER_RETRY_S, whatever its outcome
  if [ -n "$started" ] && age=$(lifecycle_age "$started") && [ "$age" -lt "$retry" ]; then return 0; fi
  # live: resolved, not owner_refresh (a digest or subs does not rewrite the registry; sleep_locate refreshes once all else passed)
  row=$(resolve_session "$(owner_get "$f" sid)" ""); [ -n "$row" ] || return 0
  sid=$(cut -f3 <<<"$row")
  # no open task, the wake task (task=) included, and nothing logged, woken or created within the grace
  sub_tasks "$sid"
  [ -z "$T_OPEN" ] || return 0
  newest=""; [ -z "$T_LAST" ] || newest=$(tail -n 1 "$T_LAST/status" | cut -f1)
  wt=$(owner_get "$f" task)
  if [[ "$wt" =~ ^[A-Za-z0-9._-]+$ ]] && [ -f "$CREW_ROOT/$wt/status" ]; then
    case "$(state_of "$CREW_ROOT/$wt")" in done | landed | dropped) ;; *) return 0 ;; esac
    ts=$(tail -n 1 "$CREW_ROOT/$wt/status" | cut -f1); [[ "$ts" < "$newest" ]] || newest=$ts
  fi
  for ts in "$(owner_get "$f" woken_at)" "$(owner_get "$f" created)"; do [[ "$ts" < "$newest" ]] || newest=$ts; done
  age=$(lifecycle_age "$newest") || return 0
  [ "$age" -ge "$idle" ] || return 0
  # crew sleep's checks that need no wait (running, in a pane, alone in an unwatched window, fresh notes, idle composer):
  # a refusal is a silent skip, tried again at the next sweep
  ( sleep_locate "$f"; sleep_window; sleep_notes "$f"; sleep_idle ) >/dev/null 2>&1 || return 0
  { printf 'started=%s\n' "$(now)" >"$mark.tmp" && mv "$mark.tmp" "$mark"; } || return 0
  ( sleep_spawn_waiter "$f" ) >/dev/null 2>&1 || return 0
  printf 'sleeping %s (idle, no open task; result next sweep)\n' "$f"
}

# the owners led by this lead, ACT=1 only (it may start a sleep); runs in $(...): the sourced files do not outlive it
lifecycle_owners() {
  local f
  . "$CREW_BIN/crew-owners.sh"; . "$CREW_BIN/crew-sleep.sh"
  for f in $(owner_ids); do
    lifecycle_owner_is_led "$f" "$1" "$2" || continue
    lifecycle_owner_sleep "$f"
  done
}

# --- the sweep ---
lifecycle_sweep() {
  local lead=$1 lsid=$2 act=$3 n s sid t dn a prev lines="" verify="" closed links=0 owners=0
  [ "$lsid" != - ] || lsid=""
  # one grep each: no link names this lead (by sessionId or name), no owner is led by it (its lead_sid is this session's
  # or an earlier id of it, .prev; never by name): nothing to read or ask
  if grep -qsFx -e "parent_sid=$lsid" -e "parent_name=$lead" "$CREW_ROOT"/.links/* 2>/dev/null; then links=1; fi
  if [ -n "$lsid" ]; then
    a=(-e "lead_sid=$lsid"); prev="$CREW_ROOT/.prev/$(sid_key "$lsid")"
    if [ -f "$prev" ]; then while IFS= read -r s; do [ -z "$s" ] || a+=(-e "lead_sid=$s"); done <"$prev"; fi
    if grep -qsFx "${a[@]}" "$CREW_ROOT"/.owners/*/owner 2>/dev/null; then owners=1; fi
  fi
  [ $links = 1 ] || [ $owners = 1 ] || return 0

  # section: subs (close, verify)
  if [ $links = 1 ]; then
    while IFS=$'\t' read -r n s sid; do
      if [ "$s" != live ]; then rm -f "$CREW_ROOT/.lifecycle/close-pending/$(sid_key "$sid")"; continue; fi
      if lifecycle_is_owner "$sid"; then continue; fi
      sub_tasks "$sid"
      dn=""; [ -n "$T_OPEN" ] || dn=$(lifecycle_done_tasks "$sid")   # only used when nothing is open
      closed=0
      if [ "$act" = 1 ]; then
        t=$(lifecycle_close_one "$n" "$sid" "$dn")
        if [ -n "$t" ]; then lines+="$t"$'\n'; case "$t" in closed*) closed=1 ;; esac; fi
      fi
      # done, not landed: the lead decides (a sub that was just closed has nothing left to verify)
      if [ -z "$T_OPEN" ] && [ $closed = 0 ]; then
        while IFS= read -r t; do
          [ -n "$t" ] || continue
          verify+="verify $n? ($(short_name "$t") done) → crew log $t landed, or reopen it"$'\n'
        done <<<"$dn"
      fi
    done < <(subs_of "$lead" "$lsid")
  fi
  # section: owners (sleep: ACT=1 only; wake lines are standing)
  if [ $owners = 1 ] && [ "$act" = 1 ]; then
    t=$(lifecycle_owners "$lead" "$lsid" || true)
    [ -z "$t" ] || lines+="$t"$'\n'
  fi
  if [ $owners = 1 ]; then   # an asleep owner a merge touched, until `crew wake` or `crew owners --dismiss`
    t=$(. "$CREW_BIN/crew-owners.sh"; owner_wake_lines "$lead" "$lsid" || true); [ -z "$t" ] || verify+="$t"$'\n'
  fi
  printf '%s%s' "$lines" "$verify"
}

# The sweep's lines as the first block of a digest or subs output: "Action items" and each line indented two spaces;
# nothing when there is nothing to say.
lifecycle_block() {
  local lines
  lines=$(lifecycle_sweep "$@" || true)
  [ -z "$lines" ] || printf 'Action items\n%s\n' "$(sed 's/^/  /' <<<"$lines")"
}
