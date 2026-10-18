# crew-owners.sh — feature owners: the registry and its shared helpers (skill: crew, "Feature owners").
# Sourced by bin/crew for `owner`, `owners`, `sleep`, `wake`, `talk` (and by digest for talk lines); never run alone.
# Everything from bin/crew is in scope (die, now, meta_get, meta_add, resolve_session, sess_load, subs_of, link_*,
# self_session, lead_session, sid_key, one_line, ...). crew-sleep.sh, crew-wake.sh and crew-talk.sh are sourced after it.
#
# --- registry: one folder per owner, $CREW_ROOT/.owners/<id>/ ---
#   owner      key=value lines. Single-value keys appear once (owner_set rewrites them); path= repeats, one glob per line.
#                feature=<id>          the owner id = the feature slug (^[a-z0-9][a-z0-9-]{0,40}$), unique in the crew root
#                repo=<abs real path>  the repo the globs are relative to
#                cwd=<abs path>        the owner session's working directory (a git worktree, say): `crew wake` opens the
#                                      window there while it exists, else in repo=. Absent when the session json has none.
#                path=<glob>           repo-relative; `*` and `?` stay inside one path segment, `**` crosses `/`,
#                                      a glob ending in `/` means everything under it (`dir/` == `dir/**`)
#                sid=<sessionId>       the owner session (followed across resumes by owner_refresh)
#                name=<session name>   display only, refreshed by owner_refresh
#                lead=<name>  lead_sid=<sessionId>   the session the owner reports to (its chain link's parent)
#                notes=<abs path>      $CREW_ROOT/.owners/<id>/notes.md (in crew, not the repo: repos may be shared)
#                state=awake|asleep
#                created=<iso>  slept_at=<iso>  woken_at=<iso>  window=<tmux session:window>  task=<last wake task id>
#   notes.md   the owner's own notes on its feature (it keeps them current; `crew sleep` refuses stale ones)
#   sleep.log  lines "<iso>\t<result>" from a deferred self-sleep (crew-sleep.sh)
#   wake.pending  lines "<iso>\t<change>": merges that touched this asleep owner's paths (`crew owners --record-wake REF
#              --change TEXT`, called by merge-card). Its lead's digest/subs show `wake F: ...?` until `crew wake F`
#              succeeds or `crew owners --dismiss F` (its lead) clears the file.
# Removed owners move to $CREW_ROOT/.owners/.removed/<id>.<epoch>/ (notes kept).
#
# --- talk threads: one folder per thread, $CREW_ROOT/.talk/<a>--<b>--<topic-slug>/ (a < b, feature ids, LC_ALL=C) ---
#   meta       key=value, rewritten whole under $CREW_ROOT/.locks/talk-<thread id>:
#                a=<id> b=<id> topic=<as given, one line> lead=<name> lead_sid=<sid> cap=<n> turns=<n>
#                state=open|closed|capped created=<iso> updated=<iso>
#   log        "<iso>\t<from id>\t<to id>\t<message, one line>" per message
#
# Locks: $CREW_ROOT/.locks/owner-<id> for any owner file write. Exit codes for refusals: 3 with "crew: refused: <why>".

OWNER_ID_RE='^[a-z0-9][a-z0-9-]{0,40}$'

owner_dir() { printf '%s/.owners/%s' "$CREW_ROOT" "$1"; }
owner_exists() { [[ "$1" =~ $OWNER_ID_RE ]] && [ -f "$(owner_dir "$1")/owner" ]; }
# the last value of KEY for owner ID ("" when unset); path= gives the last glob, use owner_paths for all of them
owner_get() { grep -E "^$2=" "$(owner_dir "$1")/owner" 2>/dev/null | tail -n 1 | cut -d= -f2- || true; }
owner_paths() { sed -n 's/^path=//p' "$(owner_dir "$1")/owner" 2>/dev/null || true; }
owner_ids() { # every registered owner id, sorted
  local f
  for f in "$CREW_ROOT"/.owners/*/owner; do [ -f "$f" ] && basename "${f%/owner}"; done | LC_ALL=C sort
}
refuse() { echo "crew: refused: $*" >&2; exit 3; }

# owner_set ID key=value...: replace those single-value keys (never path=), one atomic rewrite under the owner lock
owner_set() {
  local id=$1 f kv; shift
  f=$(owner_dir "$id")/owner
  [ -f "$f" ] || die "no owner '$id'"
  for kv in "$@"; do [[ "$kv" != *$'\n'* ]] || refuse "a value may not contain a newline"; done
  mkdir -p "$CREW_ROOT/.locks"
  (
    flock 9
    # through ENVIRON: awk -v would turn a backslash-n in a value into a newline
    KV="$(printf '%s\n' "$@")" awk '
      BEGIN { n = split(ENVIRON["KV"], a, "\n"); for (i = 1; i <= n; i++) if (a[i] != "") { k = a[i]; sub(/=.*/, "", k); set[k] = a[i]; order[++m] = k } }
      { k = $0; sub(/=.*/, "", k); if (k in set) { if (!(k in done)) { print set[k]; done[k] = 1 } ; next } print }
      END { for (i = 1; i <= m; i++) if (!(order[i] in done)) { print set[order[i]]; done[order[i]] = 1 } }' "$f" >"$f.tmp.$$" && mv "$f.tmp.$$" "$f"
  ) 9>"$CREW_ROOT/.locks/owner-$id"
}

# session_cwd SID: the working directory in the live session json of SID (only *.json: the folder also holds *.key
# secrets); nothing when it has none, is not absolute or holds a control character
session_cwd() {
  local f c
  for f in "$CREW_SESSIONS"/*.json; do
    [ -f "$f" ] || continue
    c=$(S=$1 jq -r 'select(.sessionId == env.S) | .cwd // empty' "$f" 2>/dev/null) || continue
    [ -n "$c" ] || continue
    [[ "$c" == /* && "$c" != *[[:cntrl:]]* ]] && printf '%s' "$c"
    return 0
  done
  return 0
}

# owner_refresh ID: when the owner's session is live under a newer sessionId (a resume: resolve_session follows .prev)
# or a new name, record them, with its working directory and state=awake; the same for its lead (lead= / lead_sid=),
# also while the owner itself is not running.
# Prints the live row "name<TAB>pid<TAB>sessionId", or nothing when it is not running.
owner_refresh() {
  local id=$1 sid name r lr cwd upd=()
  lr=$(owner_lead "$id")
  if [ -n "$lr" ] && { [ "$(cut -f1 <<<"$lr")" != "$(owner_get "$id" lead)" ] || [ "$(cut -f3 <<<"$lr")" != "$(owner_get "$id" lead_sid)" ]; }; then
    owner_set "$id" "lead=$(one_line "$(cut -f1 <<<"$lr")")" "lead_sid=$(cut -f3 <<<"$lr")"
  fi
  sid=$(owner_get "$id" sid); name=$(owner_get "$id" name)
  r=$(resolve_session "$sid" "")
  [ -n "$r" ] || return 0
  if [ "$(cut -f3 <<<"$r")" != "$sid" ] || [ "$(cut -f1 <<<"$r")" != "$name" ]; then
    upd+=("sid=$(cut -f3 <<<"$r")" "name=$(cut -f1 <<<"$r")")
  fi
  cwd=$(session_cwd "$(cut -f3 <<<"$r")")
  if [ -n "$cwd" ] && [ "$cwd" != "$(owner_get "$id" cwd)" ]; then upd+=("cwd=$cwd"); fi
  # a live session is an awake owner: a wake that died after spawn_launch, before it recorded the owner awake
  if [ "$(owner_get "$id" state)" != awake ]; then upd+=("state=awake"); fi
  if [ ${#upd[@]} -gt 0 ]; then owner_set "$id" "${upd[@]}"; fi
  printf '%s' "$r"
}

# The owner's lead, live: "name<TAB>pid<TAB>sessionId", or nothing
owner_lead() { resolve_session "$(owner_get "$1" lead_sid)" ""; }

# Is the calling session the owner's lead (1), the owner itself (2), or neither (0)? Prints the digit.
owner_caller_role() {
  local id=$1 me msid r
  me=$(lead_session); [ -n "$me" ] || { echo 0; return 0; }
  msid=$(cut -f3 <<<"$me")
  r=$(owner_lead "$id"); if [ -n "$r" ] && [ "$(cut -f3 <<<"$r")" = "$msid" ]; then echo 1; return 0; fi
  r=$(resolve_session "$(owner_get "$id" sid)" ""); if [ -n "$r" ] && [ "$(cut -f3 <<<"$r")" = "$msid" ]; then echo 2; return 0; fi
  echo 0
}

# main_checkout DIR: the main checkout of the repo DIR is in (also from one of its worktrees or a folder inside);
# DIR itself when it is not in a git repo. Owners are registered by this path, so a worktree routes to the same owners.
main_checkout() {
  local d=$1 c
  c=$(git -C "$d" rev-parse --path-format=absolute --git-common-dir 2>/dev/null) || c=""
  if [ "${c##*/}" = .git ] && c=$(realpath -e -- "${c%/*}" 2>/dev/null); then printf '%s' "$c"; return 0; fi
  # a submodule or bare repo has no main checkout beside its git dir: use its own toplevel
  c=$(git -C "$d" rev-parse --show-toplevel 2>/dev/null) || c=""
  printf '%s' "${c:-$d}"
}

# --- path globs ---
# glob_ere GLOB: set GLOB_RE to the anchored ERE for GLOB. Every metacharacter is escaped, so the glob is never a
# pattern of its own: `*` and `?` stay inside one path segment, `**` crosses `/`, `**/` at the start of a segment is
# zero or more directories (`src/**/*.ts` matches `src/a.ts`), a trailing `/` means `/**`. `a/**` matches `a/x` and
# `a/x/y` but not `a` (the owner owns files under the folder); the match is on repo-relative file paths.
GLOB_RE=""
glob_ere() {
  local g=$1 re="" c i=0 n=${#1}
  while [ $i -lt $n ]; do
    c=${g:i:1}
    case $c in
      '*')
        if [ "${g:i+1:1}" = '*' ]; then
          if [ "${g:i+2:1}" = / ] && { [ $i -eq 0 ] || [ "${g:i-1:1}" = / ]; }; then re+='(.*/)?'; i=$((i + 3)); continue; fi
          re+='.*'; i=$((i + 2)); continue
        fi
        re+='[^/]*' ;;
      '?') re+='[^/]' ;;
      '\' | '.' | '[' | ']' | '{' | '}' | '(' | ')' | '+' | '^' | '$' | '|') re+="\\$c" ;;
      *) re+=$c ;;
    esac
    i=$((i + 1))
  done
  [[ $g != */ ]] || re+='.*'
  GLOB_RE="^$re\$"
}
# glob_match GLOB PATH: 0 when the repo-relative PATH matches GLOB, else 1
glob_match() { glob_ere "$1"; [[ $2 =~ $GLOB_RE ]]; }

# --- crew owner add|rm ---
cmd_owner() {
  case "${1:-}" in
    add) shift; own_add "$@" ;;
    rm) shift; own_rm "$@" ;;
    *) die "owner needs add or rm (crew help)" ;;
  esac
}

own_add() {
  local id=${1:-} repo="" sub="" mode="" globs=() g me msid mname lf r rows n osid oname lname lsid tmp other osd ocwd
  [ $# -gt 0 ] || die "owner add needs FEATURE"
  shift
  [[ "$id" =~ $OWNER_ID_RE ]] || die "bad feature id '$id' (lowercase letters, digits and -, at most 41 characters)"
  [[ "$id" != *--* ]] || refuse "owner ids cannot contain --"
  while [ $# -gt 0 ]; do
    case $1 in
      --paths) mode=paths; shift ;;
      --sub) [ $# -ge 2 ] || die "--sub needs a session"; sub=$2; mode=""; shift 2 ;;
      --repo) [ $# -ge 2 ] || die "--repo needs a folder"; repo=$2; mode=""; shift 2 ;;
      --*) die "owner add: unknown option '$1'" ;;
      *) [ "$mode" = paths ] || die "owner add: unexpected argument '$1' (globs follow --paths)"; globs+=("$1"); shift ;;
    esac
  done
  [ ${#globs[@]} -gt 0 ] || die "owner add needs --paths GLOB..."
  for g in "${globs[@]}"; do
    [ -n "$g" ] || refuse "empty glob"
    [[ "$g" != /* ]] || refuse "glob '$g' is absolute; globs are relative to the repo"
    [[ "$g" != *[[:cntrl:]]* ]] || refuse "glob '$g' has a control character"
    case "/${g%/}/" in */../* | */./* | *//*) refuse "glob '$g' has an empty, '.' or '..' segment" ;; esac
  done
  if [ -n "$repo" ]; then repo=$(realpath -e -- "$repo" 2>/dev/null) || die "repo not found: $repo"
  else repo=$(repo_of); [ -n "$repo" ] || refuse "not inside a git repo; pass --repo DIR"; fi
  repo=$(main_checkout "$repo")

  sess_load
  me=$(self_session); msid=$(cut -f3 <<<"$me"); mname=$(cut -f1 <<<"$me")
  if [ -z "$sub" ]; then
    lf=$(link_path "$msid"); r=""
    [ ! -f "$lf" ] || r=$(link_parent "$lf")
    [ -n "$r" ] || refuse "this session has not joined a lead that is running (crew join LEAD first)"
    osid=$msid; oname=$mname
    lname=$(cut -f1 <<<"$r"); lsid=$(cut -f3 <<<"$r")
  else
    rows=$(S=$sub awk -F'\t' '$2 == "live" && ($1 == ENVIRON["S"] || $3 == ENVIRON["S"]) {print $1 "\t" $3}' <<<"$(subs_of "$mname" "$msid")")
    n=0; [ -z "$rows" ] || n=$(wc -l <<<"$rows")
    [ "$n" -ge 1 ] || refuse "'$sub' is not a live sub of yours (crew subs)"
    [ "$n" -eq 1 ] || refuse "'$sub' names $n of your subs; pass the sessionId"
    oname=$(cut -f1 <<<"$rows"); osid=$(cut -f2 <<<"$rows")
    lname=$mname; lsid=$msid
  fi
  oname=$(one_line "$oname"); lname=$(one_line "$lname")
  ocwd=$(session_cwd "$osid")

  mkdir -p "$CREW_ROOT/.owners" "$CREW_ROOT/.locks"
  (
    flock 9
    owner_exists "$id" && refuse "owner '$id' already exists (repo $(owner_get "$id" repo), session $(owner_get "$id" name))"
    for other in $(owner_ids); do   # one owner per session, also when it resumed under a new sessionId
      osd=$(owner_get "$other" sid)
      if [ "$osd" = "$osid" ] || { [ -n "$osd" ] && [ "$(cut -f3 <<<"$(resolve_session "$osd" "")")" = "$osid" ]; }; then
        refuse "$oname already owns $other: one owner per session"
      fi
    done
    tmp=$CREW_ROOT/.owners/.new-$id.$$
    rm -rf "$tmp"; mkdir "$tmp"
    {
      printf 'feature=%s\nrepo=%s\n' "$id" "$repo"
      [ -z "$ocwd" ] || printf 'cwd=%s\n' "$ocwd"
      printf 'path=%s\n' "${globs[@]}"
      printf 'sid=%s\nname=%s\nlead=%s\nlead_sid=%s\nnotes=%s\nstate=awake\ncreated=%s\n' \
        "$osid" "$oname" "$lname" "$lsid" "$(owner_dir "$id")/notes.md" "$(now)"
    } >"$tmp/owner"
    printf '# %s — owner notes\n\nKeep this current: `crew sleep` refuses notes older than your last task log.\n\nWhat this feature is (one paragraph):\n\nInterfaces other features rely on (files, functions, commands):\n\nDecisions made, and why:\n\nOpen threads (who is waiting on what):\n' "$id" >"$tmp/notes.md"
    mv -T "$tmp" "$(owner_dir "$id")" || { rm -rf "$tmp"; die "cannot register owner '$id'"; }
  ) 9>"$CREW_ROOT/.locks/owner-$id"
  echo "owner $id: $oname (lead $lname), ${#globs[@]} globs, notes $(owner_dir "$id")/notes.md"
}

own_rm() {
  [ $# -eq 1 ] && [ -n "$1" ] || die "owner rm needs FEATURE"
  local id=$1 dest epoch n=0
  owner_exists "$id" || die "no owner '$id'"
  sess_load
  if [ "$(owner_caller_role "$id")" = 0 ] && [ -n "$(lead_session)" ]; then
    refuse "only the lead of '$id' ($(owner_get "$id" lead)) or the owner itself can remove it"
  fi
  epoch=$(date -u -d "$(now)" +%s)
  mkdir -p "$CREW_ROOT/.owners/.removed" "$CREW_ROOT/.locks"
  dest=$CREW_ROOT/.owners/.removed/$id.$epoch
  (
    flock 9
    owner_exists "$id" || die "no owner '$id'"
    while [ -e "$dest" ]; do n=$((n + 1)); dest=$CREW_ROOT/.owners/.removed/$id.$epoch-$n; done
    mv -T "$(owner_dir "$id")" "$dest"
    echo "owner $id: removed, folder $dest"
  ) 9>"$CREW_ROOT/.locks/owner-$id"
}

# --- crew owners ---
# own_state ID: awake | asleep 3h
own_state() {
  local st at e
  st=$(owner_get "$1" state)
  [ "$st" = asleep ] || { printf '%s' "${st:-awake}"; return 0; }
  at=$(owner_get "$1" slept_at)
  e=$(date -u -d "$at" +%s 2>/dev/null) || e=""
  [ -n "$at" ] && [ -n "$e" ] || { printf asleep; return 0; }
  e=$(($(date -u -d "$(now)" +%s) - e)); [ "$e" -ge 0 ] || e=0
  printf 'asleep %s' "$(fmt_age "$e")"
}

# own_rel REPO FILE: FILE (absolute, or relative to the cwd) as a repo-relative path; fails when it is outside REPO
own_rel() {
  local abs
  case $2 in /*) abs=$2 ;; *) abs=$(pwd -P)/$2 ;; esac
  abs=$(realpath -ms -- "$abs")
  case $abs in "$1"/?*) printf '%s' "${abs#"$1"/}" ;; *) return 1 ;; esac
}

# own_list N FILE...: "N files: a, b, c, d, e, +K" (five at most)
own_list() {
  local n=$1 s="" i=0 f; shift
  for f in "$@"; do
    [ $i -lt 5 ] || break
    s+="${s:+, }$f"; i=$((i + 1))
  done
  [ "$n" -le 5 ] || s+=", +$((n - 5))"
  printf '%s files: %s' "$n" "$s"
}

# owner_wake_clear ID: drop the pending wake of ID (a wake that launched, or a dismiss), under the owner lock
owner_wake_clear() {
  mkdir -p "$CREW_ROOT/.locks"
  ( flock 9; rm -f "$(owner_dir "$1")/wake.pending" ) 9>"$CREW_ROOT/.locks/owner-$1"
}

# owner_wake_lines LEAD LSID: one action item per owner led by this lead (its lead_sid resolves to LSID, never by LEAD's
# name: as owner_caller_role) that holds a pending wake, naming the oldest change
owner_wake_lines() {
  local id f n lr first
  for id in $(owner_ids); do
    f=$(owner_dir "$id")/wake.pending
    [ -s "$f" ] || continue
    lr=$(owner_lead "$id")
    [ -n "$lr" ] && [ "$(cut -f3 <<<"$lr")" = "$2" ] || continue
    n=$(wc -l <"$f"); first=$(head -n 1 "$f" | cut -f2-)
    printf 'wake %s: %s%s? → crew wake %s "<task>", or crew owners --dismiss %s\n' "$id" "$first" "$([ "$n" -le 1 ] || printf ' (+%s more)' $((n - 1)))" "$id" "$id"
  done
}

cmd_owners() {
  local repo="" top="" ref="" notes="" want=0 files=() rel=() uniq=() un=() gl=() m=() id f g hit rows="" ws=0 wn=0 wf=0 line name
  local record=0 change="" dismiss=""
  local -A owned=() seen=()
  while [ $# -gt 0 ]; do
    case $1 in
      --repo) [ $# -ge 2 ] || die "--repo needs a folder"; repo=$2; shift 2 ;;
      --record-wake) [ $# -ge 2 ] || die "--record-wake needs a ref"; ref=$2; want=1; record=1; shift 2 ;;
      --change) [ $# -ge 2 ] || die "--change needs a text"; change=$(one_line "$2"); shift 2 ;;
      --dismiss) [ $# -ge 2 ] || die "--dismiss needs a feature"; dismiss=$2; shift 2 ;;
      --for) want=1; shift; while [ $# -gt 0 ] && [[ $1 != --* ]]; do files+=("$1"); shift; done ;;
      --for-diff) [ $# -ge 2 ] || die "--for-diff needs a ref"; ref=$2; want=1; shift 2 ;;
      --notes) [ $# -ge 2 ] || die "--notes needs a feature"; notes=$2; shift 2 ;;
      *) die "owners: unknown argument '$1'" ;;
    esac
  done
  if [ -n "$notes" ]; then
    owner_exists "$notes" || die "no owner '$notes'"
    echo "$(owner_dir "$notes")/notes.md"
    return 0
  fi
  if [ -n "$dismiss" ]; then
    owner_exists "$dismiss" || die "no owner '$dismiss'"
    sess_load
    [ "${CREW_AS_USER:-0}" = 1 ] || [ "$(owner_caller_role "$dismiss")" = 1 ] ||
      refuse "only the lead of '$dismiss' ($(owner_get "$dismiss" lead)) can dismiss its wake"
    if [ -s "$(owner_dir "$dismiss")/wake.pending" ]; then owner_wake_clear "$dismiss"; echo "dismissed wake for $dismiss"
    else echo "no wake pending for $dismiss"; fi
    return 0
  fi
  [ $record = 1 ] || [ -z "$change" ] || die "--change goes with --record-wake"
  [ $record = 0 ] || [ -n "$change" ] || die "--record-wake needs --change TEXT"
  if [ -n "$repo" ]; then repo=$(realpath -e -- "$repo" 2>/dev/null) || die "repo not found: $repo"
  elif [ $want = 1 ]; then repo=$(repo_of); [ -n "$repo" ] || die "owners --for needs a repo: run it inside one or pass --repo DIR"; fi
  if [ -n "$repo" ]; then   # files and the diff are the worktree's; owners are registered by the main checkout
    top=$(git -C "$repo" rev-parse --show-toplevel 2>/dev/null) || top=$repo
    repo=$(main_checkout "$repo")
  fi

  if [ $want = 1 ]; then
    [ -n "$ref" ] || [ ${#files[@]} -gt 0 ] || die "--for needs at least one file"
    for f in "${files[@]}"; do
      rel+=("$(own_rel "$top" "$f")") || die "file outside the repo $top: $f"
    done
    files=("${rel[@]}")
    if [ -n "$ref" ]; then
      [[ "$ref" != -* ]] && git -C "$top" rev-parse --verify --quiet "$ref^{commit}" >/dev/null 2>&1 || die "not a commit in $top: $ref"
      while IFS= read -r -d '' f; do files+=("$f"); done < <(git -C "$top" diff --name-only -z "$ref" --)
    fi
    for f in "${files[@]}"; do [ -z "${seen[$f]:-}" ] || continue; seen[$f]=1; uniq+=("$f"); done
    files=("${uniq[@]}")
    if [ ${#files[@]} -eq 0 ]; then [ $record = 1 ] || echo "no changed files"; return 0; fi
  fi

  sess_load
  for id in $(owner_ids); do
    owner_refresh "$id" >/dev/null
    [ -z "$repo" ] || [ "$(owner_get "$id" repo)" = "$repo" ] || continue
    if [ $want = 1 ]; then
      mapfile -t gl < <(owner_paths "$id")
      m=()
      for f in "${files[@]}"; do
        hit=0
        for g in "${gl[@]}"; do
          if glob_match "$g" "$f"; then hit=1; break; fi
        done
        if [ $hit = 1 ]; then m+=("$f"); owned[$f]=1; fi
      done
      [ ${#m[@]} -gt 0 ] || continue
      if [ $record = 1 ]; then   # only a sleeping owner needs a wake: an awake one is live and its lead can message it
        [ "$(owner_get "$id" state)" = asleep ] || continue
        mkdir -p "$CREW_ROOT/.locks"
        ( flock 9; printf '%s\t%s\n' "$(now)" "$change" >>"$(owner_dir "$id")/wake.pending" ) 9>"$CREW_ROOT/.locks/owner-$id"
        echo "wake pending: $id"
        continue
      fi
      line=$(own_list ${#m[@]} "${m[@]}")
    else
      line=$(owner_paths "$id" | paste -sd' ')
    fi
    name=$(owner_get "$id" name)
    rows+=$id$'\t'$(own_state "$id")$'\t'${name:--}$'\t'${line:--}$'\n'   # no empty field: tab is IFS whitespace
  done
  if [ -n "$rows" ]; then
    while IFS=$'\t' read -r id f g line; do
      [ ${#id} -le $wf ] || wf=${#id}; [ ${#f} -le $ws ] || ws=${#f}; [ ${#g} -le $wn ] || wn=${#g}
    done <<<"${rows%$'\n'}"
    while IFS=$'\t' read -r id f g line; do
      printf '%-*s  %-*s  %-*s  %s\n' "$wf" "$id" "$ws" "$f" "$wn" "$g" "$line"
    done <<<"${rows%$'\n'}"
  elif [ $want = 0 ]; then
    echo "no owners"
  fi
  if [ $want = 1 ] && [ $record = 0 ]; then
    for f in "${files[@]}"; do [ -n "${owned[$f]:-}" ] || un+=("$f"); done
    [ ${#un[@]} -eq 0 ] || echo "unowned: $(own_list ${#un[@]} "${un[@]}")"
  fi
}
