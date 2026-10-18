#!/usr/bin/env bash
# PreToolUse hook (matcher: Bash). Deny commands that can kill the user's real tmux server:
#   - `tmux ... kill-server` without an explicit -S <path> or -L <name> on that same invocation. When $TMUX is set
#     (the Bash tool runs inside the user's pane) tmux ignores TMUX_TMPDIR and uses the socket in $TMUX.
#     A socket that still reaches the real server (`-L default`, `-S $TMUX`, `-S /tmp/tmux-UID/default`) does not count.
#   - pkill / killall aimed at tmux, and `kill` of the tmux server pid (`kill $(pgrep tmux)`, `pgrep tmux | xargs kill`).
#   - `tmux kill-window` / `kill-pane` / `kill-session` (and their aliases and unambiguous prefixes) aimed at the default
#     server, by the same rule: a session's window is closed with `crew close SUB` (its lead, or HQ), never by hand.
#   - on the default server, the string arguments of the tmux subcommands that run commands (run-shell, if-shell, bind-key,
#     confirm-before, command-prompt, new-window, split-window, respawn-*, display-popup...) are read both as shell command
#     lines and as tmux commands (quotes removed), so `run-shell 'pkill tmux'` and `if-shell true '"kill-window" -t x'` are
#     caught. `-k` on respawn-pane/respawn-window/unlink-window, `source-file -` and control mode (-C, even with no command)
#     are denied. The text arguments of display-message, send-keys, set-buffer, rename-window... are never read as commands.
#   - `tmux send-keys` / `paste-buffer` / `load-buffer` (and their aliases and prefixes) aimed at the default server, also
#     inside run-shell/if-shell...: a session must not type into another pane as if the user had (use SendMessage, or crew).
#     A private -L/-S server is fine.
#   - any mention of CREW_DELIVER_KEY or .deliver-key: the key that lets only the user's input hook and HQ deliver a typed answer.
#   - any mention of CREW_AS_USER in the command text, however it is spelled: only HQ's own code and the user set it
#     (fails closed, so inspecting commands that name it are denied too, and so is `env printf %s CREW_AS_USER=1`).
#   - the body of a quoted heredoc (<<'EOF') is text, not commands, and is not scanned, unless a shell reads it
#     (`bash <<'EOF'`, `... | bash`) or the command goes on after the body (a line ending in | && || or \): quoting stops
#     expansion, not execution. A `<<` inside a # comment is no heredoc. Unquoted bodies are always scanned.
# This is a guardrail against ACCIDENTS (the TMUX_TMPDIR crash, a worker closing a window by hand), not a sandbox against a
# hostile session; a denylist cannot win against deliberate evasion inside bash. Known limits, left as they are:
#   - quote concatenation (`CREW_AS_''USER`, `kill-wi""ndow`) and anything built at run time (variables, base64, a script file
#     written first and run, python/node calling tmux);
#   - xargs, shell aliases and functions that wrap tmux;
#   - interactive client paths: command-prompt with send-keys -K, choose-tree keys, a key binding set earlier.
# crew close's real protection is its own sessionId check (only SUB's direct lead; HQ is CREW_AS_USER=1, which by convention
# only HQ's code and the user set); this hook only keeps accidents and honest mistakes away from that door.
# Exit 2 + stderr = deny. Any parse problem fails open (exit 0).
PROG=$(cat <<'PYEOF'
import json, os, re, shlex, sys

try:
    cmd = json.load(sys.stdin)["tool_input"]["command"]
except Exception:
    sys.exit(0)
if not isinstance(cmd, str):
    sys.exit(0)

WRAP = {"env", "command", "exec", "sudo", "nohup", "time", "builtin", "nice", "timeout", "stdbuf", "setsid"}
SHELLS = {"sh", "bash", "zsh", "dash", "ksh"}
KEYWORDS = {"do", "then", "else", "elif", "if", "while", "until", "!"}
ASSIGN = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*=")
TMUX_WORD = re.compile(r"\btmux\b")
SOCKET_FLAG = re.compile(r"(^|\s)-[LS]\b")
REAL_SOCKET = re.compile(r"\$\{?TMUX(?![A-Za-z0-9_])|^/tmp/tmux-\d+/default$")
# `kill ... $(pgrep tmux)` / `kill ... `pidof tmux`` / `kill $(tmux display -p '#{pid}')`
KILL_SUBST = re.compile(r"(?<![\w./-])kill\b[^\n;&|]*?(?:\$\(|`)([^)`]*)")
PGREP_XARGS = re.compile(r"\b(?:pgrep|pidof)\b([^|;&\n]*)\|\s*xargs\b[^|;&\n]*\bkill\b")


def targets_tmux(pattern):
    """A process pattern that names tmux but not a private -L/-S server."""
    return bool(TMUX_WORD.search(pattern)) and not SOCKET_FLAG.search(pattern)


def kills_tmux_pid(text):
    for m in KILL_SUBST.finditer(text):
        inner = m.group(1)
        if re.search(r"\b(?:pgrep|pidof|ps)\b", inner) and targets_tmux(inner):
            return True
        if TMUX_WORD.search(inner) and "#{pid}" in inner:
            return True
    return any(targets_tmux(m.group(1)) for m in PGREP_XARGS.finditer(text))


def segments(s):
    """Split on ; & | newline ( ) { } and backtick outside quotes."""
    out, cur, q, i = [], [], None, 0
    while i < len(s):
        c = s[i]
        if c == "\\" and q != "'" and i + 1 < len(s):
            cur.append(s[i:i + 2]); i += 2; continue
        if q:
            if c == q:
                q = None
            cur.append(c)
        elif c in "'\"":
            q = c; cur.append(c)
        elif c in ";&|\n(){}`":
            out.append("".join(cur)); cur = []
        else:
            cur.append(c)
        i += 1
    out.append("".join(cur))
    return out


KINDS = []  # why the command was denied: server | window | user (the first one decides the message)
KILL_SUBS = (("kill-window", 6, "killw"), ("kill-pane", 6, "killp"), ("kill-session", 8, None))
FORCE_SUBS = (("respawn-pane", 8, "respawnp"), ("respawn-window", 8, "respawnw"), ("unlink-window", 8, "unlinkw"))
FORCE_FLAG = re.compile(r"^-[A-Za-z]*k[A-Za-z]*$")
# tmux subcommands whose arguments are commands (tmux or shell) to run: only these are read as commands
TAKERS = (("run-shell", 5, "run"), ("if-shell", 4, "if"), ("confirm-before", 7, "confirm"), ("bind-key", 4, "bind"),
          ("command-prompt", 8, None), ("new-window", 6, "neww"), ("split-window", 7, "splitw"), ("respawn-pane", 9, "respawnp"),
          ("respawn-window", 9, "respawnw"), ("display-popup", 9, "popup"), ("new-session", 6, "new"), ("set-hook", 5, None),
          ("display-menu", 9, "menu"))
# typing into another session's pane
INJECT_SUBS = (("send-keys", 3, "send"), ("paste-buffer", 3, "pasteb"), ("load-buffer", 3, "loadb"))
HEREDOC = re.compile(r"<<-?\s*(['\"])([A-Za-z_][A-Za-z0-9_]*)\1")


def deny(kind):
    KINDS.append(kind)
    return True


def named(word, subs):
    """word is one of subs (full, shortest accepted prefix, alias): tmux accepts `kill-w` and `killw` for kill-window."""
    for full, minlen, alias in subs:
        if (len(word) >= minlen and full.startswith(word)) or word == alias:
            return True
    return False


def is_kill_target(sub):
    return named(sub, KILL_SUBS)


def in_comment(prefix):
    """An unquoted # at the start of a word in prefix: the rest of the line is a comment."""
    q, i = None, 0
    while i < len(prefix):
        c = prefix[i]
        if c == "\\" and q != "'":
            i += 2; continue
        if q:
            if c == q:
                q = None
        elif c in "'\"":
            q = c
        elif c == "#" and (i == 0 or prefix[i - 1] in " \t;&|("):
            return True
        i += 1
    return False


def safe_split(text):
    try:
        return shlex.split(text)
    except ValueError:
        return text.split()


def strip_quoted_heredocs(text):
    """Drop the bodies of quoted heredocs (literal text) unless a shell/eval/source reads them."""
    lines, out, i = text.split("\n"), [], 0
    while i < len(lines):
        line = lines[i]
        out.append(line)
        i += 1
        m = HEREDOC.search(line)
        if not m:
            continue
        try:
            before = shlex.split(line[:m.start()])  # a marker inside an open quote is not a heredoc
        except ValueError:
            continue
        if in_comment(line[:m.start()]):  # `echo hi # <<'EOF'`: no heredoc, the next lines are commands
            continue
        if line[m.end():].rstrip().endswith(("|", "&&", "||", "\\")):  # the command goes on after the body: cannot tell what reads it
            continue
        dash = line[m.start():].startswith("<<-")
        j = i
        while j < len(lines) and not ((lines[j].lstrip("\t") if dash else lines[j]) == m.group(2)):
            j += 1
        reads = before + line[m.end():].split()
        if any(os.path.basename(t) in SHELLS | {"eval", "source", "."} for t in reads):
            continue  # a shell runs the body: it stays in the text
        i = min(j + 1, len(lines))
    return "\n".join(out)


def tmux_verdict(args):
    """args: tokens after `tmux`. Return True if it kills the server, a window, a pane or a session of the default
    server (one not confined to a private -L/-S socket)."""
    socket, control, i = False, False, 0
    while i < len(args):
        a = args[i]
        if not a.startswith("-") or a == "-":
            break
        if a.startswith("--"):
            i += 1; continue
        j = 1
        while j < len(a):
            if a[j] == "C":
                control = True
            if a[j] in "LScfT":
                val = a[j + 1:] if j + 1 < len(a) else (args[i + 1] if i + 1 < len(args) else "")
                if a[j] == "L" and val not in ("", "default"):
                    socket = True
                if a[j] == "S" and val and not REAL_SOCKET.search(val):
                    socket = True
                if j == len(a) - 1:
                    i += 1  # the flag's value is the next token
                break
            j += 1
        i += 1
    if socket:
        return False
    if control:  # control mode reads tmux commands from stdin (also with no command given)
        return deny("window")
    return command_bad(args[i:], 0) if i < len(args) else False


def tmux_chunks(tokens):
    """Split tmux command words into commands at `;` (a lone `\\;` token, or one glued to the end of a word)."""
    chunks, cur = [], []
    for t in tokens:
        if t == ";":
            chunks.append(cur); cur = []
        elif t.endswith(";"):
            cur.append(t[:-1]); chunks.append(cur); cur = []
        else:
            cur.append(t)
    chunks.append(cur)
    return chunks


def command_bad(tokens, depth):
    """tokens: tmux commands run on the default server. Their string arguments are read as commands only for the
    subcommands in TAKERS (run-shell, if-shell, bind-key...); the text of display-message, send-keys... never is."""
    for chunk in tmux_chunks(tokens):
        if not chunk:
            continue
        first, rest = chunk[0], chunk[1:]
        if len(first) >= 8 and "kill-server".startswith(first):
            return deny("server")
        if is_kill_target(first):
            return deny("window")
        if named(first, INJECT_SUBS):
            return deny("send")
        if named(first, FORCE_SUBS) and any(FORCE_FLAG.match(f) for f in rest):
            return deny("window")  # -k kills what runs in the pane / the window
        if first in ("source-file", "source") and "-" in rest:
            return deny("window")  # tmux commands from stdin
        if named(first, TAKERS):
            for a in rest:
                if string_bad(a, depth + 1):
                    return True
    return False


def string_bad(a, depth):
    """An argument that tmux runs as a command: as a shell command line (all the shell rules), and as tmux command(s)
    (quotes removed, so `'"kill-window" -t x'` is kill-window)."""
    if depth > 6:
        return deny("window")  # nested too deep to follow: fail closed
    if check(a):
        return True

    return command_bad(safe_split(a), depth)


def bad(tokens):
    while tokens and tokens[0] in KEYWORDS:  # `for x in a b; do tmux ...`
        tokens = tokens[1:]
    k = 0
    while k < len(tokens) and ASSIGN.match(tokens[k]):
        k += 1
    if k >= len(tokens):
        return False
    prog = os.path.basename(tokens[k])
    rest = tokens[k + 1:]
    if prog in WRAP:
        for m, t in enumerate(rest):
            if os.path.basename(t) in ("tmux", "pkill", "killall"):
                return bad(rest[m:])
        return False
    if prog == "tmux":
        return tmux_verdict(rest)
    if prog in ("pkill", "killall"):
        pats = [t for t in rest if not t.startswith("-")]
        return any(targets_tmux(p) for p in pats)
    if prog in SHELLS:
        for m, t in enumerate(rest[:-1]):
            if re.match(r"^-[a-z]*c$", t):
                return check(rest[m + 1])
    if prog == "eval":
        return check(" ".join(rest))
    return False


def check(text):
    if kills_tmux_pid(text):
        return True
    for seg in segments(text):
        try:
            tokens = shlex.split(seg)
        except ValueError:
            tokens = seg.split()
        if tokens and bad(tokens):
            return True
    return False


cmd = strip_quoted_heredocs(cmd)
if "CREW_AS_USER" in cmd:
    KINDS.insert(0, "user")
elif re.search(r"CREW_DELIVER_KEY|\.deliver-key", cmd):
    KINDS.insert(0, "key")
hit = bool(KINDS) or check(cmd)
kind = KINDS[0] if KINDS else "server"
if hit and kind == "user":
    sys.stderr.write(
        "BLOCKED: CREW_AS_USER is set only by HQ's own code (the pane and the web server) and by the user, never by a "
        "session: it lets a caller act as the user, e.g. close another session's window.\n"
        "Close a session you lead with `crew close SUB` (SUB's lead, or HQ); ask the lead or the user otherwise. "
        "(Any command that names CREW_AS_USER is denied, also an inspection: look at the files with Read.)\n"
    )
    sys.exit(2)
if hit and kind == "key":
    sys.stderr.write(
        "BLOCKED: the delivery key is held only by the user's input hook and HQ. It lets crew type an answer into a "
        "session's pane as the user's words, which a session must never do. (Any command that names it is denied, "
        "also an inspection.)\n"
    )
    sys.exit(2)
if hit and kind == "send":
    sys.stderr.write(
        "BLOCKED: tmux send-keys, paste-buffer and load-buffer on the real tmux server would type into another session's "
        "pane as if the user had.\n"
        "To reach another agent use SendMessage, or crew (crew talk, crew ask, crew compact). "
        "A tmux server of your own (`tmux -L <name>` or `-S <path>`, started by you) is still yours to type into.\n"
    )
    sys.exit(2)
if hit and kind == "window":
    sys.stderr.write(
        "BLOCKED: do not kill tmux windows, panes or sessions by hand: use `crew close SUB` (lead or HQ only).\n"
        "Only SUB's direct lead or HQ may close a session; crew refuses when it has other panes, is busy or has a draft. "
        "A server of your own (`tmux -L <name>` or `-S <path>`, started by you) is still yours to kill from.\n"
    )
    sys.exit(2)
if hit:
    sys.stderr.write(
        "BLOCKED: this command could kill the user's real tmux server.\n"
        "The Bash tool runs inside the user's tmux pane, so $TMUX is set, and tmux then ignores TMUX_TMPDIR and "
        "talks to the socket in $TMUX (that is how a reviewer's `TMUX_TMPDIR=... tmux kill-server` killed every "
        "session). TMUX_TMPDIR alone, or an `unset TMUX` in another command, does not make a bare `tmux kill-server` safe.\n"
        "Use an explicit private socket on that same invocation: `tmux -S <socket-path> kill-server` or "
        "`tmux -L <name> kill-server` (for a server you started with the same -S/-L; `-L default` and "
        "`-S $TMUX` are the real server), or kill your own test server by the PID you saved. "
        "Do not use pkill/killall on tmux, and do not kill $(pgrep tmux).\n"
    )
    sys.exit(2)
PYEOF
)
exec python3 -I -c "$PROG"
