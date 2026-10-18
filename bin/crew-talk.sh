# crew-talk.sh — `crew talk`: capped, logged interface threads between sibling owners (sourced by bin/crew after
# crew-owners.sh; formats and helpers there). Decisions and conflicts are not crew's job: owners SendMessage their lead.
TALK_TOPIC_MAX=80
TALK_MSG_MAX=1500

# lowercase [a-z0-9] runs joined by "-", at most 40 chars, no leading or trailing "-"
talk_slug() { printf '%s' "$1" | LC_ALL=C tr 'A-Z' 'a-z' | LC_ALL=C tr -cs 'a-z0-9' '-' | sed 's/^-//' | cut -c1-40 | sed 's/-$//'; }

# talk_put DIR a b topic lead lead_sid cap turns state created updated: rewrite the thread's meta atomically
talk_put() {
  local d=$1; shift
  printf 'a=%s\nb=%s\ntopic=%s\nlead=%s\nlead_sid=%s\ncap=%s\nturns=%s\nstate=%s\ncreated=%s\nupdated=%s\n' "$@" >"$d/meta.tmp.$$" \
    && mv "$d/meta.tmp.$$" "$d/meta"
}
# talk_load DIR: the thread's meta into TM_<key> variables
talk_load() {
  local k
  for k in a b topic lead lead_sid cap turns state created updated; do printf -v "TM_$k" '%s' "$(meta_get "$1" "$k")"; done
}
talk_store() { talk_put "$1" "$TM_a" "$TM_b" "$TM_topic" "$TM_lead" "$TM_lead_sid" "$TM_cap" "$TM_turns" "$TM_state" "$TM_created" "$TM_updated"; }

# Does thread DIR report to lead NAME (session SID, may be empty)? Same rule as a task's lead in cmd_digest: the
# lead_sid decides when it resolves to a live session, the lead name otherwise.
talk_has_lead() {
  local tsid r=""
  tsid=$(meta_get "$1" lead_sid)
  [ -z "$tsid" ] || r=$(resolve_session "$tsid" "$(meta_get "$1" lead)")
  if [ -z "$r" ]; then [ "$(meta_get "$1" lead)" = "$2" ]
  elif [ -n "$3" ]; then [ "$(cut -f3 <<<"$r")" = "$3" ]
  else [ "$(cut -f1 <<<"$r")" = "$2" ]; fi
}

# The caller must be an owner: sets ME_ID, and TROW[id] = the live row of every owner (refreshed), none when not running
declare -gA TROW=()
talk_who() {
  local me id r sid
  ME_ID=""
  sess_load
  me=$(lead_session || true)
  for id in $(owner_ids); do
    r=$(owner_refresh "$id")
    [ -z "$r" ] || TROW[$id]=$r
  done
  [ -n "$me" ] || return 0
  sid=$(cut -f3 <<<"$me")
  for id in "${!TROW[@]}"; do
    [ "$(cut -f3 <<<"${TROW[$id]}")" != "$sid" ] || ME_ID=$id
  done
}
# talk_target TO: the owner id TO names (a feature id or the owner's session name), or die
talk_target() {
  local id
  if owner_exists "$1"; then printf '%s' "$1"; return 0; fi
  for id in $(owner_ids); do
    if [ "$(owner_get "$id" name)" = "$1" ]; then printf '%s' "$id"; return 0; fi
  done
  die "talk: no owner '$1'"
}
# the session an owner reports to: its live sessionId, else the one recorded
talk_lead_key() {
  local r; r=$(owner_lead "$1")
  if [ -n "$r" ]; then cut -f3 <<<"$r"; else owner_get "$1" lead_sid; fi
}
# talk_thread A B TOPIC: sets TD (the thread folder) and TID (its id), a < b
talk_thread() {
  local LC_COLLATE=C a=$1 b=$2 slug
  if [[ "$b" < "$a" ]]; then a=$2; b=$1; fi
  slug=$(talk_slug "$3")
  [ -n "$slug" ] || die "talk: the topic needs a letter or digit"
  TID="$a--$b--$slug"; TD="$CREW_ROOT/.talk/$TID"; TA=$a; TB=$b
}
talk_clean_topic() { # the topic, trimmed; dies when empty, multi-line or longer than TALK_TOPIC_MAX
  local t
  [[ "$1" != *[[:cntrl:]]* ]] || die "talk: the topic must be one line"
  t=$(printf '%s' "$1" | sed 's/^ *//; s/ *$//')
  [ -n "$t" ] || die "talk: the topic is empty"
  [ ${#t} -le $TALK_TOPIC_MAX ] || die "talk: the topic is over $TALK_TOPIC_MAX chars"
  printf '%s' "$t"
}

cmd_talk() {
  case "${1:-}" in
    --list) shift; talk_list "$@"; return 0 ;;
    --done) shift; talk_done "$@"; return 0 ;;
  esac
  [ $# -ge 3 ] || die "usage: crew talk TO \"topic\" [--] \"message\""
  local to=$1 topic msg; shift
  topic=$(talk_clean_topic "$1"); shift
  [ "${1:-}" != -- ] || shift
  [ $# -eq 1 ] || die "talk: give exactly one message"
  msg=$(one_line "$1")
  [ -n "$msg" ] || die "talk: the message is empty"
  [ ${#msg} -le $TALK_MSG_MAX ] || die "talk: the message is over $TALK_MSG_MAX chars"

  talk_who
  [ -n "$ME_ID" ] || refuse "only feature owners talk; you are not one"
  local rid; rid=$(talk_target "$to")
  [ "$rid" != "$ME_ID" ] || refuse "$to is you: talk to a sibling owner"
  [ "$(talk_lead_key "$rid")" = "$(talk_lead_key "$ME_ID")" ] \
    || refuse "$to is not your sibling (lead $(owner_get "$rid" lead)): ask your lead"
  if [ "$(owner_get "$rid" state)" = asleep ] || [ -z "${TROW[$rid]:-}" ]; then
    refuse "$to is asleep: ask your lead ($(owner_get "$ME_ID" lead)) to wake it"
  fi

  talk_thread "$ME_ID" "$rid" "$topic"
  local cap=${CREW_TALK_CAP:-6}
  [[ "$cap" =~ ^[1-9][0-9]*$ ]] || cap=6
  mkdir -p "$CREW_ROOT/.locks" "$TD"
  (
    flock 9
    local stamp; stamp=$(now)
    if [ -f "$TD/meta" ]; then talk_load "$TD"
    else
      TM_a=$TA; TM_b=$TB; TM_topic=$topic; TM_lead=$(owner_get "$ME_ID" lead); TM_lead_sid=$(owner_get "$ME_ID" lead_sid)
      TM_cap=$cap; TM_turns=0; TM_state=open; TM_created=$stamp; TM_updated=$stamp
    fi
    [ "$TM_state" != closed ] || refuse "thread closed: start a new topic"
    if [ "$TM_turns" -ge "$TM_cap" ]; then
      if [ "$TM_state" != capped ]; then TM_state=capped; TM_updated=$stamp; talk_store "$TD"; fi
      refuse "cap reached ($TM_turns/$TM_cap) on $TM_a↔$TM_b \"$TM_topic\": take it to your lead ($TM_lead), it decides or asks the user"
    fi
    printf '%s\t%s\t%s\t%s\n' "$stamp" "$ME_ID" "$rid" "$msg" >>"$TD/log"
    TM_turns=$((TM_turns + 1)); TM_updated=$stamp
    talk_store "$TD"
    printf 'send with SendMessage to %s:\n[talk %s→%s "%s" %s/%s] %s\n' "$(cut -f1 <<<"${TROW[$rid]}")" "$ME_ID" "$rid" "$TM_topic" "$TM_turns" "$TM_cap" "$msg"
  ) 9>"$CREW_ROOT/.locks/talk-$TID" || exit $?
}

# crew talk --done TO "topic": either party closes the thread
talk_done() {
  [ $# -eq 2 ] || die "usage: crew talk --done TO \"topic\""
  local topic; topic=$(talk_clean_topic "$2")
  talk_who
  [ -n "$ME_ID" ] || refuse "only feature owners talk; you are not one"
  talk_thread "$ME_ID" "$(talk_target "$1")" "$topic"
  [ -f "$TD/meta" ] || die "talk: no thread $TA↔$TB \"$topic\""
  (
    flock 9
    talk_load "$TD"
    TM_state=closed; TM_updated=$(now)
    talk_store "$TD"
  ) 9>"$CREW_ROOT/.locks/talk-$TID" || exit $?
}

# crew talk --list [--lead NAME]: one line per thread of that lead (default: the caller; all outside a claude session)
talk_list() {
  local lead="" lsid="" all=0 me d now_s upd
  if [ "${1:-}" = --lead ]; then
    lead=${2:-}; [ -n "$lead" ] || die "--lead needs a name"
    shift 2
  fi
  [ $# -eq 0 ] || die "usage: crew talk --list [--lead NAME]"
  sess_load
  if [ -z "$lead" ]; then
    me=$(lead_session || true)
    if [ -z "$me" ]; then all=1; else lead=$(cut -f1 <<<"$me"); lsid=$(cut -f3 <<<"$me"); fi
  else
    lsid=$(cut -f3 <<<"$(resolve_session "" "$lead")")
  fi
  [ "$lsid" != - ] || lsid=""
  now_s=$(date -u -d "$(now)" +%s)
  for d in "$CREW_ROOT"/.talk/*/; do
    d=${d%/}
    [ -f "$d/meta" ] || continue
    [ $all = 1 ] || talk_has_lead "$d" "$lead" "$lsid" || continue
    talk_load "$d"
    upd=$(date -u -d "$TM_updated" +%s 2>/dev/null || echo "$now_s")
    printf '%s↔%s "%s" %s/%s %s %s\n' "$TM_a" "$TM_b" "$TM_topic" "$TM_turns" "$TM_cap" "$TM_state" "$(fmt_age $((now_s > upd ? now_s - upd : 0)))"
  done
}

# digest lines for lead NAME (sid SID) since iso $3: `  talk: A↔B "<topic>" (3/6)` per open thread with a message after $3
# (empty $3 = every open one), " capped → you" appended when the thread hit its cap
talk_digest_lines() {
  local LC_COLLATE=C d
  for d in "$CREW_ROOT"/.talk/*/; do
    d=${d%/}
    [ -f "$d/meta" ] || continue
    talk_load "$d"
    [ "$TM_state" = open ] || [ "$TM_state" = capped ] || continue
    [ -z "${3:-}" ] || [[ "$TM_updated" > "$3" ]] || continue
    talk_has_lead "$d" "$1" "$2" || continue
    printf '  talk: %s↔%s "%s" (%s/%s)%s\n' "$TM_a" "$TM_b" "$TM_topic" "$TM_turns" "$TM_cap" "$([ "$TM_state" != capped ] || printf ' capped → you')"
  done
}
