# crew-close.sh — `crew close SUB [--force-draft]`: close a session's tmux window (sourced by bin/crew after
# crew-owners.sh and crew-sleep.sh, whose pane and window checks it reuses).
# Who may: SUB's direct lead (the chain link by sessionId, followed through .prev; not a grandparent, not a sibling; never
# by name), or HQ: CREW_AS_USER=1 (HQ's own code and the user). Everyone else is refused with who can. Then: SUB runs in
# a tmux pane, its window holds only that pane (and is not the last of its tmux session), SUB is
# idle, its composer is empty (unless --force-draft). The window is closed by its id (never by name or index) and the
# close is logged on SUB's open tasks.

# close_authorize: sets CLOSE_BY (who is closing), or refuses. Authority comes from sessionIds only: names are labels that
# any `claude -n` can take, so a name never grants anything, and no link is rewritten here (link_parent would).
CLOSE_BY=""
close_authorize() {
  local me="" mname="" msid="" s lf="" psid n p ps live="" lname=""
  if [ "${CREW_AS_USER:-0}" = 1 ]; then CLOSE_BY="the user"; return 0; fi
  me=$(lead_session)
  if [ -n "$me" ]; then mname=$(cut -f1 <<<"$me"); msid=$(cut -f3 <<<"$me"); fi
  # the link is filed under the sub's sessionId, or under an earlier one of the same session (a resume: .prev)
  for s in "$SL_SID" $(cat "$CREW_ROOT/.prev/$(sid_key "$SL_SID")" 2>/dev/null || true); do
    if [ -f "$(link_path "$s")" ]; then lf=$(link_path "$s"); break; fi
  done
  [ -n "$lf" ] || refuse "$SL_NAME reports to no one; only HQ can close it"
  psid=$(link_get "$lf" parent_sid)
  # the lead is the live session that is, or continues (its .prev lists it), the link's parent sessionId
  while IFS=$'\t' read -r n p ps; do
    [ -n "$ps" ] || continue
    if [ "$ps" = "$psid" ] || grep -qxF -- "$psid" "$CREW_ROOT/.prev/$(sid_key "$ps")" 2>/dev/null; then live=$ps; lname=$n; break; fi
  done <<<"$SESS_TABLE"
  [ -n "$live" ] || refuse "$SL_NAME: lead gone: only HQ can close it"
  if [ -n "$msid" ] && [ "$msid" = "$live" ]; then CLOSE_BY=$mname; return 0; fi
  refuse "$SL_NAME reports to $lname; only $lname or HQ can close it"
}

# the pane must be idle with an empty composer (a draft only with --force-draft); reads the pane afresh each time
close_idle() {
  pane_read "$SL_PANE" || refuse "$SL_NAME: $P_REASON: nothing closed"
  case "$P_STATE" in
    idle) ;;
    draft) [ "$1" = 1 ] || refuse "unsent text in $SL_NAME's composer (draft): nothing closed; --force-draft closes it anyway" ;;
    busy) refuse "$SL_NAME is busy (mid-turn): try again when it is idle" ;;
    prompt) refuse "a prompt is open in $SL_NAME's pane: answer it in tmux first" ;;
    *) refuse "$SL_NAME's composer is not visible ($P_STATE): nothing closed" ;;
  esac
}

cmd_close() {
  local sub="" force=0 rows row n win t d me
  while [ $# -gt 0 ]; do
    case "$1" in
      --force-draft) force=1; shift ;;
      -*) die "unknown flag $1" ;;
      *) [ -z "$sub" ] || die "close takes one SUB"; sub=$1; shift ;;
    esac
  done
  [ -n "$sub" ] || die "close needs SUB (a live session name)"
  relink_once
  sess_load
  rows=$(N=$sub awk -F'\t' '$1 == ENVIRON["N"]' <<<"$SESS_TABLE")
  [ -n "$rows" ] || refuse "$sub is not running: nothing to close"
  n=$(wc -l <<<"$rows")
  [ "$n" -eq 1 ] || refuse "$n live sessions are named $sub: nothing closed"
  row=$rows
  SL_NAME=$(cut -f1 <<<"$row"); SL_PID=$(cut -f2 <<<"$row"); SL_SID=$(cut -f3 <<<"$row")
  me=$(lead_session)
  if [ -n "$me" ] && [ "$(cut -f3 <<<"$me")" = "$SL_SID" ]; then refuse "$SL_NAME cannot close itself (exit it from inside)"; fi
  close_authorize
  [ "$CLOSE_BY" != "the user" ] || SL_NOVIEW=1
  sleep_locate_pane
  sleep_window
  close_idle $force
  # right before the kill: the pane still holds this session, in the same window
  sleep_pane_owner || refuse "the pane no longer holds $SL_NAME's session: nothing closed"
  sleep_window
  win=$(one_line "$(tmux display-message -p -t "$SL_WID" '#{session_name}:#{window_name}' 2>/dev/null || true)")
  close_idle $force   # the last look, right before the kill: a draft typed or a turn begun since the first one is not lost
  tmux kill-window -t "$SL_WID" >/dev/null 2>&1 || refuse "tmux could not close the window: $SL_NAME is still running"
  sub_tasks "$SL_SID"
  while IFS= read -r d; do
    [ -n "$d" ] || continue
    t=$(basename "$d")
    (cmd_log "$t" "$(state_of "$d")" "closed by $CLOSE_BY (crew close)") >/dev/null 2>&1 || true
  done <<<"$T_OPEN"
  echo "closed: $SL_NAME, window $win ($SL_WID)"
}
