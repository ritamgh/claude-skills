#!/usr/bin/env bash
# Symlink this checkout into $HOME/.claude. Never import live files into the repo.
set -euo pipefail
REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
DRY=0
for arg in "$@"; do
  case $arg in
    --dry-run) DRY=1 ;;
    *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
  esac
done
BACKUP="$HOME/.claude/backups/claude-skills-install/$(date +%Y%m%d-%H%M%S-%N)"
act() {
  if ((DRY)); then printf '    [dry-run]'; printf ' %q' "$@"; printf '\n'; else "$@"; fi
}
link_item() {
  local path=$1 src="$REPO/$1" live="$HOME/.claude/$1"
  if [[ -L $live && $live -ef $src ]]; then
    printf 'skip     %s (already linked)\n' "$path"
    return
  fi
  if [[ -e $live || -L $live ]]; then
    printf 'backup   %s\n' "$path"
    act mkdir -p -- "$BACKUP/$(dirname "$path")"
    act mv -- "$live" "$BACKUP/$path"
  fi
  printf 'link     %s\n' "$path"
  act mkdir -p -- "$(dirname "$live")"
  act ln -s -- "$src" "$live"
}
shopt -s nullglob
for src in "$REPO"/skills/*/ "$REPO"/bin/* "$REPO"/hooks/* "$REPO"/agents/*.md "$REPO"/mods/hq "$REPO"/workflows/idea-research.js; do
  [[ -e $src ]] || continue
  src=${src%/}
  link_item "${src#"$REPO/"}"
done
printf 'Settings unchanged. Merge %s/settings.example.json into ~/.claude/settings.json yourself.\n' "$REPO"
((DRY)) && printf 'dry run: nothing changed\n'
exit 0
