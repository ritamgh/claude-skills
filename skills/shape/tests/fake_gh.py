#!/usr/bin/env python3
"""A fake `gh` for the review tests: records every call and answers from $FAKE_GH_DIR/routes.json.

routes.json keys: repo, pr_url, get {endpoint: JSON | {"raw": text}}, fail [argv substrings], fail_post_nth, sleep, fail_message (stderr of a failing call).
"""
import json
import os
import sys
import time

DIR = os.environ["FAKE_GH_DIR"]


def load(name, default):
    try:
        with open(os.path.join(DIR, name), encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return default


def die(message):
    print(message, file=sys.stderr)
    sys.exit(1)


argv = sys.argv[1:]
routes = load("routes.json", {})
counter = load("counter.json", {"posts": 0, "next_id": 900})
flags = {"paginate": "--paginate" in argv, "input": "--input" in argv}
fields = {}
endpoint = None
method = "GET"
i = 0
while i < len(argv):
    arg = argv[i]
    if arg in ("--method", "-X"):
        method, i = argv[i + 1], i + 1
    elif arg in ("-f", "-F"):
        key, _, value = argv[i + 1].partition("=")
        fields[key], i = value, i + 1
    elif arg in ("-H", "--input", "--jq", "--json", "--repo", "--head", "--title", "--body"):
        i += 1
    elif argv[:1] == ["api"] and not arg.startswith("-") and endpoint is None and i > 0:
        endpoint = arg.split("?")[0]
    i += 1
stdin = sys.stdin.read() if flags["input"] else None
with open(os.path.join(DIR, "log.jsonl"), "a", encoding="utf-8") as log:
    log.write(json.dumps({"argv": argv, "cwd": os.getcwd(), "stdin": stdin, "fields": fields,
                          "no_prompt": [os.environ.get("GIT_TERMINAL_PROMPT"), os.environ.get("GH_PROMPT_DISABLED")],
                          "git_env": sorted(key for key in os.environ if key.startswith("GIT_")), "gh_token": os.environ.get("GH_TOKEN"),
                          "stdin_closed": os.path.samestat(os.fstat(0), os.stat(os.devnull))}) + "\n")
if any(part in " ".join(argv) for part in routes.get("fail", [])):
    die(routes.get("fail_message", "gh: HTTP 502 (fake)"))
if routes.get("sleep"):
    time.sleep(routes["sleep"])
if argv[:2] == ["repo", "view"]:
    named = argv[2] if len(argv) > 2 and not argv[2].startswith("-") else None  # `gh repo view <repo>` answers for that repo; bare, for the one gh guesses
    print(json.dumps({"nameWithOwner": named or routes["repo"]}))
elif argv[:2] == ["pr", "create"]:
    print("\nhttps://github.com/acme/notes/pull/7" if "pr_url" not in routes else routes["pr_url"])
elif argv[:1] == ["api"] and method == "POST":
    counter["posts"] += 1
    counter["next_id"] += 1
    with open(os.path.join(DIR, "counter.json"), "w", encoding="utf-8") as handle:
        json.dump(counter, handle)
    if counter["posts"] == routes.get("fail_post_nth"):
        die("gh: HTTP 500 (fake)")
    anchor = "discussion_r" if endpoint.endswith("/replies") else "issuecomment-"
    print(json.dumps({"id": counter["next_id"], "html_url": f"https://github.com/acme/notes/pull/7#{anchor}{counter['next_id']}"}))
elif argv[:1] == ["api"]:
    if endpoint not in routes.get("get", {}):
        die("gh: HTTP 404 (fake) " + str(endpoint))
    value = routes["get"][endpoint]
    if isinstance(value, dict) and "raw" in value:
        sys.stdout.write(value["raw"])
    elif flags["paginate"] and isinstance(value, list):  # real gh prints one array per page
        half = (len(value) + 1) // 2
        sys.stdout.write(json.dumps(value[:half]) + json.dumps(value[half:]))
    else:
        print(json.dumps(value))
else:
    die("gh: unknown command (fake)")
