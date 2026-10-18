# tmux:// links

A `tmux://<target>` link lands you in that tmux window: `crew go <target>` selects the window (and pane) and
switches your attached client to its session when it is elsewhere. It sends no keys. `<target>` is
`session:index` or `session:index.pane` (what HQ prints, e.g. `tmux://claude:7`), or a crew task id (its spawned
window). Nothing else is accepted.

Files here (nothing is installed for you):

- `crew-tmux-open`: the handler. Strips `tmux://` and passes only the rest to `crew go`, which validates it.
- `open-actions.conf.snippet`: the kitty rule that runs the handler on click.
- `crew-tmux.desktop`: the `x-scheme-handler/tmux` fallback for apps that go through `xdg-open`.

## Apply for kitty (the one that matters)

```sh
cat ~/.claude/skills/crew/tmux-link/open-actions.conf.snippet >> ~/.config/kitty/open-actions.conf
```

In `~/.config/kitty/kitty.conf`, uncomment/replace the `url_prefixes` line with `tmux` added at the end:

```
url_prefixes file ftp ftps gemini git gopher http https irc ircs kitty mailto news sftp ssh tmux
```

Then restart kitty (or reload with ctrl+shift+f5). The `url_prefixes` line is what makes a plain-text
`tmux://...` clickable; the `open-actions.conf` rule is what runs the handler for it.

Inside tmux with `mouse on`, kitty gets the click only with the modifier you already use for https links.

## Optional: xdg fallback

```sh
sed "s|HOME_DIR|$HOME|" ~/.claude/skills/crew/tmux-link/crew-tmux.desktop > ~/.local/share/applications/crew-tmux.desktop
xdg-mime default crew-tmux.desktop x-scheme-handler/tmux
```

Kitty uses the open-actions rule first; this only matters for links opened by other apps (a browser, `xdg-open`).

## Check

```sh
~/.claude/skills/crew/tmux-link/crew-tmux-open tmux://claude:1   # selects window 1 of session claude
```

## Why plain text, not a hyperlink

From reading Claude Code's bundled code (not seen on screen): it writes an OSC 8 hyperlink only when its terminal
check passes, and that check lists kitty by `TERM_PROGRAM`, which tmux overrides (`TERM_PROGRAM=tmux`,
`TERM=tmux-256color`; `FORCE_HYPERLINK=1` forces it on). So inside tmux a link most likely shows as text, and
kitty's own URL detection (`url_prefixes`) is what makes it clickable. Claude Code itself linkifies bare `http(s)://`
text only.
