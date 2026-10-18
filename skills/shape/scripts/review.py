"""plan review: publish the PRD to a draft PR with git, read and answer the review with gh (contract 14.4).

The only module that runs gh or git. Every command acts on an open `review` request the page click created."""
from contextlib import contextmanager
import fcntl
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile

import plan_core as core
import prd

TIMEOUT = 60
FAILED = 5  # exit code: gh or git failed, state untouched
BATCH = 50
SECTION = re.compile(r"#{2,3}\s+(\d{1,2})\b")
DEFINES = re.compile(r"\s*(?:-\s+|\|\s*)(?:\*\*|~~)([A-Za-z0-9._-]+)")
LEADING = re.compile(r"\s*\[([^\]\s]{1,40})\]")
VOLATILE = ("rev", "updated", "recent", "requests")  # plan.json keys that change on every event
IMPORTED = re.compile(r"imported (\d+) comments \((\d+) new\)")
JUST_POSTED = set()  # ext of replies this process posted: a racing pull must not import them as teammate comments


def fail(message):
    return core.PlanError(re.sub(r"://[^/@\s]+@", "://***@", " ".join(str(message).split()))[:300], FAILED)


def call(program, args, cwd=None):
    env = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}  # GIT_DIR, GIT_SSH_COMMAND, GIT_CONFIG_* would steer or run code
    env.update(GIT_TERMINAL_PROMPT="0", GH_PROMPT_DISABLED="1")
    try:
        result = subprocess.run([program, *args], cwd=cwd, env=env, text=True, encoding="utf-8", errors="replace",
                                capture_output=True, timeout=TIMEOUT, stdin=subprocess.DEVNULL)
    except FileNotFoundError as exc:
        raise fail(f"{program} not found on PATH" if exc.filename == program else f"{program}: {exc}") from exc
    except subprocess.TimeoutExpired as exc:
        raise fail(f"{program} {args[0]} timed out after {TIMEOUT}s") from exc
    except OSError as exc:
        raise fail(f"{program}: {exc}") from exc
    if result.returncode != 0:
        raise fail(f"{program} {args[0]} failed: {result.stderr.strip() or 'exit ' + str(result.returncode)}")
    return result.stdout


def gh(*args, cwd=None):
    return call("gh", args, cwd)


def git(*args, cwd):
    return call("git", args, cwd)


def send(task, **event):
    return core.send_event(task, dict(event, by="session", source="terminal"))


def anchor_for(text, path, line, prd_text, slug, ids):
    """Where a review comment belongs: a leading [ID], else the node or section its PRD.md line sits in, else null (never an error)."""
    lead = LEADING.match(text)
    if lead and lead.group(1) == "PRD":
        return None
    if lead and lead.group(1) in ids:
        return lead.group(1)
    if path != f"docs/prd/{slug}/PRD.md" or not isinstance(prd_text, str) or type(line) is not int:
        return None
    lines = prd_text.split("\n")
    if not 1 <= line <= len(lines):
        return None
    for number in range(line - 1, -1, -1):
        heading = SECTION.match(lines[number])
        if heading:
            return f"§{heading.group(1)}" if int(heading.group(1)) <= 18 else None
        defined = DEFINES.match(lines[number])
        if defined and defined.group(1) in ids:
            return defined.group(1)
    return None


def pages(output):
    """gh api --paginate prints one JSON array per page, back to back."""
    decoder, position, items = json.JSONDecoder(), 0, []
    output = output.strip()
    while position < len(output):
        try:
            value, position = decoder.raw_decode(output, position)
        except ValueError as exc:
            raise fail("gh api returned invalid JSON") from exc
        items += value if isinstance(value, list) else [value]
        while position < len(output) and output[position].isspace():
            position += 1
    return [item for item in items if isinstance(item, dict) and core.is_int(item.get("id"))]


def unchanged(directory, text):
    """True when docs/prd/<slug> holds exactly PRD.md and plan.json, plan.json has the same content as text (apart from the keys
    every event bumps) and PRD.md is what that plan.json renders to: anything a teammate with push rights altered is rewritten."""
    try:
        if sorted(entry.name for entry in directory.iterdir()) != ["PRD.md", "plan.json"]:
            return False
        old, new = json.loads((directory / "plan.json").read_text(encoding="utf-8")), json.loads(text)
        shown = (directory / "PRD.md").read_text(encoding="utf-8")
        return (isinstance(old, dict) and all(key in VOLATILE or old.get(key) == new.get(key) for key in set(old) | set(new))
                and shown == prd.render(dict(old, owner="withheld")))
    except (OSError, ValueError, core.PlanError):
        return False


def publish(plan, branch):
    """Put the mirror's PRD.md and plan.json on origin's `branch` through a temporary worktree; returns (head sha, committed)."""
    repo, slug = plan["repo"], plan["slug"]
    core.need(branch == "prd/" + slug, f"Review branch must be prd/{slug}, not {branch}")
    if not Path(repo).is_dir():
        raise fail(f"repo {repo} is not a directory")
    existing = git("ls-remote", "--heads", "origin", f"refs/heads/{branch}", cwd=repo).strip() != ""
    source = branch
    if not existing:
        match = re.search(r"^ref: refs/heads/(\S+)\tHEAD$", git("ls-remote", "--symref", "origin", "HEAD", cwd=repo), re.M)
        if not match:
            raise fail("origin has no default branch")
        source = match.group(1)
    private = f"refs/prd-review/{slug}/{os.getpid()}"  # not FETCH_HEAD: any other fetch in this checkout rewrites it; per process so two publishers never share it
    git("fetch", "origin", f"+refs/heads/{source}:{private}", cwd=repo)
    base = git("rev-parse", "--verify", f"{private}^{{commit}}", cwd=repo).strip()
    git("update-ref", "-d", private, cwd=repo)
    scratch = tempfile.mkdtemp(prefix="plan-review-")
    tree = os.path.join(scratch, "tree")
    try:
        git("worktree", "add", "--detach", tree, base, cwd=repo)
        directory = Path(tree, "docs/prd", slug)
        for part in ("docs", "docs/prd", f"docs/prd/{slug}", f"docs/prd/{slug}/PRD.md", f"docs/prd/{slug}/plan.json"):
            if os.path.islink(Path(tree, part)):
                raise fail(f"{part} on the review branch is a symlink: refusing to write through it")
        shown = core.review_plan(plan)
        files = {"PRD.md": prd.render(dict(shown, owner="withheld")), "plan.json": core.json_text(shown)}
        committed = not unchanged(directory, files["plan.json"])
        if committed:
            directory.mkdir(parents=True, exist_ok=True)
            if not directory.resolve().is_relative_to(Path(tree).resolve()):
                raise fail("docs/prd path resolves outside the review worktree")
            for entry in directory.iterdir():  # anything else a teammate put next to the two files goes
                if entry.name not in files or entry.is_dir():
                    shutil.rmtree(entry) if entry.is_dir() and not entry.is_symlink() else entry.unlink()
            for name, content in files.items():
                (directory / name).write_text(content, encoding="utf-8")
            git("add", "--", f"docs/prd/{slug}", cwd=tree)
            git("-c", "commit.gpgsign=false", "commit", "--no-verify", "-q", "-m", f"PRD: {plan['title']} (rev {plan['rev']})", cwd=tree)
        sha = git("rev-parse", "HEAD", cwd=tree).strip()
        if committed or not existing:
            git("push", "--no-verify", "origin", f"HEAD:refs/heads/{branch}", cwd=tree)
        return sha, committed
    finally:
        try:
            git("worktree", "remove", "--force", tree, cwd=repo)
        except core.PlanError:
            pass
        shutil.rmtree(scratch, ignore_errors=True)
        try:
            git("worktree", "prune", cwd=repo)
        except core.PlanError:
            pass


ORIGIN = re.compile(r"(?:https://(?:[^/@\s]+@)?github\.com/|ssh://git@github\.com/|git@github\.com:)([^/\s]+/[^/\s]+?)(?:\.git)?/?")


def origin_repo(repo):
    """owner/name from origin's configured URL (not insteadOf-rewritten), so a fork's other remotes never pick the PR's target."""
    url = git("config", "--get", "remote.origin.url", cwd=repo).strip()
    found = ORIGIN.fullmatch(url)
    core.need(found is not None and core.repo_name_valid(found.group(1)), "origin is not a github.com owner/name remote")
    return found.group(1)


def open_pr(task, plan):
    core.need(plan.get("review_pr") is None, "A review PR is open already")
    core.need(plan["repo"] is not None, "Set the plan's repo before opening a review PR")
    repo, slug, branch = plan["repo"], plan["slug"], "prd/" + plan["slug"]
    try:
        name = json.loads(gh("repo", "view", origin_repo(repo), "--json", "nameWithOwner", cwd=repo))["nameWithOwner"]
    except (ValueError, KeyError, TypeError) as exc:
        raise fail("gh repo view returned no nameWithOwner") from exc
    if not core.repo_name_valid(name):
        raise fail("gh repo view returned an unexpected repository name")
    sha, _ = publish(plan, branch)
    body = (f"PRD for {slug} (rev {plan['rev']}). To review it, give your Claude this PR link and ask it to use the "
            "prd-review skill: one review, line comments starting `[ID] type: text`.")
    out = gh("pr", "create", "--repo", name, "--draft", "--head", branch, "--title", f"PRD: {plan['title']}", "--body", body, cwd=repo)
    found = re.search(r"https://\S+/pull/(\d+)", out)
    if not found:
        raise fail("gh pr create printed no pull request URL")
    value = {"repo": name, "number": int(found.group(0).rsplit("/", 1)[1]), "url": found.group(0), "branch": branch,
             "head_sha": sha, "prd_rev": plan["rev"], "opened_at": core.utcnow(), "pulled_at": None}
    try:
        send(task, type="review_set", value=value)
    except core.PlanError as exc:
        raise fail(f"PR opened at {value['url']} but not recorded: {exc}") from exc
    summary = f"opened PR #{value['number']} {value['url']}"
    return summary, {"number": value["number"], "url": value["url"], "branch": branch, "head_sha": sha, "prd_rev": plan["rev"]}


def push(task, plan):
    pr = plan["review_pr"]
    sha, committed = publish(plan, pr["branch"])
    send(task, type="review_set", value=dict(pr, head_sha=sha, prd_rev=plan["rev"]))
    summary = f"pushed {sha[:7]} (rev {plan['rev']})" if committed else "nothing new"
    return summary, {"changed": committed, "head_sha": sha, "prd_rev": plan["rev"]}


def pull(task, plan):
    pr = plan["review_pr"]
    repo, number = pr["repo"], pr["number"]
    base = f"repos/{repo}"

    def listing(path):
        return pages(gh("api", "--paginate", f"{base}/{path}?per_page=100"))

    review_comments, reviews, issues = listing(f"pulls/{number}/comments"), listing(f"pulls/{number}/reviews"), listing(f"issues/{number}/comments")
    path = f"docs/prd/{plan['slug']}/PRD.md"
    prd_text = None
    if any(c.get("path") == path and type(c.get("line")) is int for c in review_comments):
        try:
            prd_text = gh("api", "-H", "Accept: application/vnd.github.raw", f"{base}/contents/{path}?ref={pr['head_sha']}")
        except core.PlanError:
            prd_text = None  # anchors degrade to the explicit [ID] or null
    ids = {node["id"] for node in plan["nodes"]}
    items = []

    def add(kind, raw, path=None, line=None, reply_to=None):
        body = raw.get("body") if isinstance(raw.get("body"), str) else ""
        ext, author, url = f"{kind}:{raw['id']}", (raw.get("user") or {}).get("login"), raw.get("html_url")
        if ext not in JUST_POSTED:
            items.append(dict({"ext": ext, "author": author if isinstance(author, str) else "", "text": body,
                               "url": url if isinstance(url, str) else "", "resolved": False,
                               "anchor": anchor_for(body, path, line, prd_text, plan["slug"], ids)},
                              **({"reply_to": reply_to} if reply_to else {})))

    for raw in review_comments:
        parent = raw.get("in_reply_to_id")
        add("rc", raw, raw.get("path"), raw.get("line"), f"rc:{parent}" if core.is_int(parent) else None)
    for raw in reviews:
        if raw.get("state") != "PENDING" and isinstance(raw.get("body"), str) and raw["body"].strip():
            add("rv", raw)
    for raw in issues:
        add("ic", raw)
    current = core.load(task)
    comments = current.get("comments", [])
    known = ({c["ext"] for c in comments if c.get("ext")} | {c["posted"]["ext"] for c in comments if c.get("posted")}
             | set(current.get("ext_dropped", [])))
    fresh = {i["ext"] for i in items if i["ext"] not in known and i["text"].strip()}
    if len(comments) + len(fresh) > core.COMMENT_LIMIT:
        raise fail(f"the PR holds {len(fresh)} new comments but the plan has room for {core.COMMENT_LIMIT - len(comments)} "
                   f"(cap {core.COMMENT_LIMIT}): nothing imported; delete closed comments, then pull again")
    seen = new = 0
    for start in range(0, len(items), BATCH):
        counts = IMPORTED.fullmatch(send(task, type="comment_import", items=items[start:start + BATCH])["summary"])
        seen, new = seen + int(counts.group(1)), new + int(counts.group(2))
    send(task, type="review_set", value=dict(core.load(task)["review_pr"], pulled_at=core.utcnow()))
    return f"pulled {seen} comments ({new} new)", {"imported": seen, "new": new}


def post_texts(plan, requests, clicks, accepted):
    """Validate every reply before any is sent; returns [(comment, text)] for the refs not posted yet.

    Text is never the session's: an answer/decline posts the stored proposal.text, an accepted comment posts
    "Applied in <sha7> (PRD rev N)." plus that text, and only once the PR holds the rev it was accepted at."""
    pr = plan["review_pr"]
    comments = {c["id"]: c for c in plan.get("comments", [])}
    clicked = {}  # comment id -> rev of the newest page click naming it
    for request in requests:
        for ref in request["text"].split(" ", 1)[1].split(","):
            clicked[ref] = max(clicked.get(ref, 0), clicks[request["ref"]]["rev"])
    todo = []
    for ref, click_rev in clicked.items():
        comment = comments.get(ref)
        core.need(comment is not None, f"{ref} no longer exists")
        if comment.get("posted") is not None:
            continue
        proposal = comment["proposal"]
        core.need(proposal is not None and (comment["state"] == "accepted" or proposal["action"] in ("answer", "decline")),
                  f"{ref} has no reply to post")
        core.need(proposal["rev"] <= click_rev, f"{ref}: its proposal changed after your click; click Post again")
        if comment["state"] == "accepted":
            core.need(accepted.get(ref, pr["prd_rev"] + 1) <= pr["prd_rev"], f"{ref} is not in the pushed PR yet: click Push new version first")
            text = f"Applied in {pr['head_sha'][:7]} (PRD rev {pr['prd_rev']})." + ("\n" + proposal["text"] if proposal["text"] else "")
        else:
            core.need(proposal["text"], f"{ref} has no reply to post")
            text = proposal["text"]
        todo.append((comment, text))
    return todo


def post(task, plan, requests, clicks):
    pr = plan["review_pr"]
    accepted = {e["ref"]: e["rev"] for e in core.audit_events(core.plan_dir(task)) if e.get("type") == "comment_accept"}
    todo = post_texts(plan, requests, clicks, accepted)
    posted = []
    for position, (comment, text) in enumerate(todo):
        root = comment.get("reply_to") or comment.get("ext")
        if isinstance(root, str) and root.startswith("rc:"):
            endpoint, kind = f"repos/{pr['repo']}/pulls/{pr['number']}/comments/{root[3:]}/replies", "rc"
        else:
            endpoint, kind = f"repos/{pr['repo']}/issues/{pr['number']}/comments", "ic"
        ref, left = comment["id"], ", ".join(c["id"] for c, _ in todo[position:])
        try:
            reply = json.loads(gh("api", "--method", "POST", endpoint, "-f", "body=" + text))
            url, ext = reply["html_url"], f"{kind}:{reply['id']}"
            core.need(core.https_url(url) and core.ext_valid(ext), "bad reply")
        except core.PlanError as exc:
            raise fail(f"post failed on {ref}: {exc}; not posted: {left}") from exc
        except (ValueError, KeyError, TypeError) as exc:
            raise fail(f"gh returned an unreadable reply for {ref}; it may be posted; not recorded: {left}") from exc
        JUST_POSTED.add(ext)
        try:
            send(task, type="comment_posted", ref=ref, url=url, ext=ext)
        except core.PlanError as exc:
            raise fail(f"{ref} posted at {url} but not recorded: {exc}") from exc
        posted.append({"ref": ref, "url": url, "ext": ext})
    return f"posted {len(posted)} replies", {"posted": posted, "remaining": []}


def clicks(task, requests):
    """{request ref: its originating event}; refuses a request the user's page click did not create (speed bump: contract 14.4)."""
    events = {e.get("id"): e for e in core.audit_events(core.plan_dir(task))}
    for request in requests:
        click = events.get(request["ref"])
        core.need(click is not None and click.get("type") == "review" and click.get("by") == "user" and click.get("source") == "page",
                  f"Review request {request['ref']} was not made by a click on the plan page")
    return {r["ref"]: events[r["ref"]] for r in requests}


@contextmanager
def posting(task):
    """One review command at a time per plan: the second waits, then finds its request resolved. Not core.locked: send() takes that one inside."""
    with (core.plan_dir(task) / ".review.lock").open("a", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def run(task, action):
    """Run one review command; returns (summary line, --json result)."""
    core.load(task)  # an unknown task fails with its own error, not on the missing lock file
    with posting(task):  # every action: a pull must not list a reply a post has sent but not recorded yet
        return run_one(task, action)


def run_one(task, action):
    plan = core.load(task)
    asked = action == "post"
    requests = [r for r in plan["requests"] if r["type"] == "review"
                and (r["text"].startswith("post ") if asked else r["text"] == action)]
    core.need(requests, f"No open review request for {action}: click it on the plan page first")
    clicked = clicks(task, requests)
    core.need(action == "open" or plan.get("review_pr") is not None, "No review PR: open one first")
    if action != "open":
        target, origin = plan["review_pr"]["repo"], origin_repo(plan["repo"]) if plan["repo"] is not None else None
        core.need(origin is not None and target.casefold() == origin.casefold(),
                  f"The recorded review PR is in {target} but this plan's origin is {origin}: clear it and open one again")
    summary, result = {"open": lambda: open_pr(task, plan), "push": lambda: push(task, plan),
                       "pull": lambda: pull(task, plan), "post": lambda: post(task, plan, requests, clicked)}[action]()
    for request in requests:
        send(task, type="resolve", ref=request["ref"])
    return summary, dict(result, action=action)
