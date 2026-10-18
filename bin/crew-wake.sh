# crew-wake.sh — `crew wake OWNER "task"`: reopen a sleeping owner with `claude --resume` and hand it the task (sourced
# by bin/crew after crew-owners.sh; formats and helpers there).
#
# The wake is a crew task of its own (owner=, resume_sid=, lead=, sub=, brief.md = the task) launched by spawn_launch,
# so the reservation, the join and the relink of a spawned sub-lead apply as they are: the resumed session's first
# `crew whoami` completes them, also when claude gives it a NEW sessionId (consume_locked links the new id, relink_self
# adopts the old life). spawn_launch reads the prompt from the task's wake-prompt.md, written at each launch.

# the wake task's meta: window name, the session to resume, the owner's lead (live or as recorded) and who woke it
wake_prepare() { # task-dir owner-id lead-name lead-sid by top: top non-empty = the lead is not running, nothing to join (empty clears an earlier top=1)
  local d=$1 f=$2 name slug
  name=$(owner_get "$f" name); [ -n "$name" ] || name=${3:+$3/}$f
  slug=${name##*/}; slug=${slug,,}; slug=${slug//[^a-z0-9-]/-}   # tmux expands #{...} in a window name: a plain slug only
  [ -n "$slug" ] || slug=$f
  meta_add "$d" "spawned=1" "spawn_slug=$slug" "resume_sid=$(owner_get "$f" sid)" "owner=$f" "woken_by=$5" \
    ${3:+"lead=$3" "lead_sid=$4"} "sub=$name" "sub_sid=$(owner_get "$f" sid)" \
    "top=${6:+1}"
}

wake_prompt() { # task-dir owner-id: the first message of the woken owner
  local d=$1 f=$2 id g globs="" q="'" slept=""
  id=$(basename "$d")
  # the history since the owner was last active: its sleep, or (an owner left awake) its last wake, else its creation
  if [ "$(owner_get "$f" state)" = asleep ]; then slept=$(owner_get "$f" slept_at); fi
  [ -n "${slept:-}" ] || slept=$(owner_get "$f" woken_at)
  [ -n "$slept" ] || slept=$(owner_get "$f" created)
  while IFS= read -r g; do [ -z "$g" ] || globs+="'${g//$q/$q\\$q$q}' "; done < <(owner_paths "$f")
  printf 'Woken by %s for: %s. First run `crew whoami`, then `git log%s -- %s` in %s and re-read your notes at %s; then do it. Report up as before; when done run `crew log %s done` and `crew summary %s`, then update your notes.\n' \
    "$(meta_get "$d" woken_by)" "$(cat "$d/brief.md")" "${slept:+ --since=$slept}" "${globs% }" "$(owner_get "$f" repo)" "$(owner_get "$f" notes)" "$id" "$id" >"$d/wake-prompt.md"
}

cmd_wake() {
  local feature="" task="" resume="" d id
  if [ "${1:-}" = --resume ]; then
    [ $# -eq 2 ] && [ -n "$2" ] || die "wake --resume needs one task ID"
    resume=$2
  else
    [ $# -ge 1 ] || die "wake needs FEATURE and a task text"
    case "$1" in -*) die "unknown flag $1" ;; esac
    feature=$1; shift
    if [ "${1:-}" = -- ]; then shift
    else case "${1:-}" in -*) die "unknown flag $1 (put -- before a task that starts with a dash)" ;; esac; fi
    [ $# -le 1 ] || die "wake takes one task text, quote it"
    task=${1:-}
    [[ "$task" =~ [^[:space:]] ]] || die "wake needs a task text (one non-empty argument)"
    [ "${#task}" -le 2000 ] || die "the task is ${#task} characters (max 2000)"
  fi
  mkdir -p "$CREW_ROOT"
  relink_once   # a spawned session joins before the limits are computed; takes the spawn lock itself
  exec 8>"$CREW_ROOT/.spawn.lock"; flock 8   # the checks, the limits and the launch are one step; closed when this command ends
  SPAWN_HELD=1
  if [ -n "$resume" ]; then
    d=$(tdir "$resume"); id=$resume
    feature=$(meta_get "$d" owner); [ -n "$feature" ] || die "wake --resume: $id is not a wake task"
    [ "$(state_of "$d")" = queued ] || die "wake --resume: $id is $(state_of "$d"), not queued"
    task=$(cat "$d/brief.md")
  fi
  owner_exists "$feature" || refuse "$feature is not a feature owner"
  # a sleep of this owner holds this lock from before it closes the window until it records the owner asleep: a wake in
  # that gap would be overwritten by it. Closed when this command ends.
  mkdir -p "$CREW_ROOT/.locks"; exec 7>"$CREW_ROOT/.locks/sleep-$feature"
  flock -n 7 || refuse "$feature is falling asleep: try again in a moment"
  local live me lead by name repo wdir lname="" lsid="" sid t
  sid=$(owner_get "$feature" sid)
  [ -n "$sid" ] || refuse "$feature has no sessionId to resume: nothing launched"
  live=$(owner_refresh "$feature"); name=$(owner_get "$feature" name)
  if [ -n "$live" ]; then name=$(cut -f1 <<<"$live"); refuse "$feature is awake: SendMessage $name"; fi
  # state=awake with no live session (a crash, a reboot, a launch that died) is wakeable like an asleep owner; the
  # wake task it left behind (t) ends failed below, unless that launch is still coming up
  t=$(owner_get "$feature" task)
  if [ "$(owner_get "$feature" state)" != asleep ] && [ -n "$t" ] && [ -d "$CREW_ROOT/$t" ] && [ "$(meta_get "$CREW_ROOT/$t" owner)" = "$feature" ] &&
     [ "$(state_of "$CREW_ROOT/$t")" = running ]; then
    if [ -f "$CREW_ROOT/.pending/$t" ] && reservation_alive "$CREW_ROOT/.pending/$t" "$(tmux list-windows -a -F '#{window_id}' 2>/dev/null || true)"; then
      refuse "$feature is starting: its window $(meta_get "$CREW_ROOT/$t" window) is still open"
    fi
  else t=""
  fi
  me=$(lead_session); lead=$(owner_lead "$feature")
  if [ "${CREW_AS_USER:-0}" = 1 ] || [ -z "$me" ]; then by="the user"
  elif [ "$(owner_caller_role "$feature")" = 1 ]; then by=$(cut -f1 <<<"$me")
  else
    lname=$(owner_get "$feature" lead); if [ -n "$lead" ]; then lname=$(cut -f1 <<<"$lead"); fi
    refuse "$feature is asleep: ask its lead ($lname) to wake it"
  fi
  if [ -n "$lead" ]; then   # the woken owner takes one of its lead's sub-lead places
    lname=$(cut -f1 <<<"$lead"); lsid=$(cut -f3 <<<"$lead")
    local reason; reason=$(spawn_limits "$lname" "$lsid" "$resume") || refuse "$reason"
  fi
  local q
  for q in "$CREW_ROOT"/*/; do   # one queued wake per owner
    q=${q%/}
    if [ "$(meta_get "$q" owner)" = "$feature" ] && [ "$(basename "$q")" != "$resume" ] && [ "$(state_of "$q")" = queued ]; then
      refuse "a wake of $feature is already queued: crew wake --resume $(basename "$q")"
    fi
  done
  [ -n "$(shopt -s nullglob; echo "${CREW_PROJECTS:-$HOME/.claude/projects}"/*/"$sid".jsonl)" ] || refuse "no transcript for $sid: cannot resume $feature"   # names only, never read
  repo=$(owner_get "$feature" repo); [ -d "$repo" ] || die "wake: repo not found: $repo"
  wdir=$(owner_get "$feature" cwd)   # the window opens where the owner session worked (a worktree), else in the repo
  [ -n "$wdir" ] && [ -d "$wdir" ] || wdir=$repo
  if [ -n "$t" ]; then rm -f "$CREW_ROOT/.pending/$t"; cmd_log "$t" failed "woken session died before it joined"; fi
  local ram=1 memmsg=""
  memmsg=$(cmd_mem) || ram=0
  if [ $ram = 1 ]; then tmux_windows >/dev/null; fi   # no point making a task for a window that cannot open
  if [ -z "$resume" ]; then
    local intent; intent=$(first_line <(printf '%s\n' "$task")); intent=${intent:0:200}
    d=$(NEW_OWN=1 cmd_new "$feature" --shape ship --repo "$wdir" -- "$intent" | sed -n 's/^dir=//p')
    [ -d "$d" ] || die "wake: could not make the task"
    id=$(basename "$d")
    printf '%s\n' "$task" >"$d/brief.md"
  fi
  local unlinked=""; [ -n "$lead" ] || unlinked=top
  wake_prepare "$d" "$feature" "${lname:-$(owner_get "$feature" lead)}" "${lsid:-$(owner_get "$feature" lead_sid)}" "$by" "$unlinked"
  if [ $ram = 0 ]; then
    cmd_log "$id" queued "wake waiting for RAM"
    printf 'queued: wake of %s waiting for RAM (%s). Start it with: crew wake --resume %s\n' "$feature" "$memmsg" "$id"
    return 0
  fi
  wake_prompt "$d" "$feature"
  spawn_launch "$d" "$lname" "$lsid" 7>&- >/dev/null   # a tmux server started from here must not inherit the sleep lock
  owner_set "$feature" "state=awake" "woken_at=$(now)" "task=$id" "window=$(meta_get "$d" window)"
  owner_wake_clear "$feature"   # the lead acted on any pending wake
  echo "woke $feature in $(meta_get "$d" window) (task $id)"
  # no live lead to join: the reservation is consumed as a top-level lead, and the owner reports in its own pane
  [ -z "$unlinked" ] || echo "lead $(owner_get "$feature" lead) is not running: $feature will report in its pane"
}
