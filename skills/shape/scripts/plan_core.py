"""Validated plan state, event application and locked atomic persistence (stdlib only)."""
from contextlib import contextmanager
import copy
from datetime import datetime, timezone
import fcntl
import getpass
import json
import os
from pathlib import Path
import re
import secrets
import tempfile
import unicodedata

import lint
import prd

SIZES = ("quick", "standard", "deep")
QSTAGES = ("ideate", "research", "frame", "explore", "decide", "shape")
STAGES = QSTAGES + ("ready", "building", "shipped")
LANES = ("ideas", "why", "who", "scope", "decisions", "risks", "slices", "tasks")
STATUSES = ("open", "settled", "parked", "killed")
TASK_STATUSES = ("todo", "doing", "done", "failed")
TOP_KEYS = set("schema id slug title owner size stage rev created updated repo published approved tldr frontier progress requests recent nodes".split())
OPTIONAL_TOP_KEYS = {"comments", "thread", "comment_seq", "review_pr", "ext_dropped"}  # contract 13, 14; absent = empty
COMMON = {"id": "", "kind": "", "label": "", "body": "", "status": "open",
          "depends_on": [], "refs": [], "rev": 0, "by": "session", "by_default": False}
# kind: (prefix, number width, extra field defaults)
KINDS = {
    "story": ("P", 1, {"evidence": ""}),
    "user": ("U", 1, {"context": ""}),
    "goal": ("G-", 1, {}),
    "criterion": ("SC-", 3, {"verify": "", "evidence": "", "goal": None}),
    "nongoal": ("NG-", 1, {"why": ""}),
    "constraint": ("C-", 1, {"tag": ""}),
    "assumption": ("AS-", 1, {"validate_by": "", "impact": ""}),
    "slice": ("S", 1, {"order": 0, "why_priority": "", "independent_test": "", "scenarios": [], "exit": ""}),
    "requirement": ("FR-", 3, {"nfr": False}),
    "edge": ("E-", 1, {"expect": ""}),
    "risk": ("R-", 1, {"approach": ""}),
    "approach": ("A-", 1, {"alternatives": []}),
    "boundary": ("B-", 1, {"tier": ""}),
    "question": ("Q", 1, {"lane": "", "why": "", "stage": "", "class": "", "options": [],
                              "recommended": None, "answer": None, "priority": 0, "blocking": False, "fills": []}),
    "task": ("T-", 3, {"slice": None, "files": [], "parallel": False, "check": "", "result": None, "crew": None}),
    "decision": ("DEC-", 1, {"chose": "", "alternatives": [], "why": ""}),
    "discovery": ("X-", 1, {"evidence": ""}),
    "note": ("N-", 1, {"lane": ""}),
    "idea": ("I", 1, {"hook": "", "pitch": "", "who": "", "win": "", "tier": "", "checks": None, "scores": {},
                      "gates": {}, "boost": 0, "kill_reason": "", "merged_from": [], "merged_into": None,
                      "twists": [], "sources": []}),
    "rubric": ("K", 1, {"group": "", "weight": 0, "default_weight": 0, "origin": ""}),
    "research": ("RS", 1, {"scope": "", "targets": [], "question": "", "vehicle": "", "run": "", "state": "",
                           "report": "", "note": ""}),
}
EVENT_FIELDS = {
    "answer": ("node", "choice", "text"), "park": ("node",), "reopen": ("node",),
    "strike": ("node",), "prioritize": ("node",), "edit_label": ("node", "label"),
    "note": ("text", "node", "lane"), "ask": ("text", "node"), "expand": ("node", "text"),
    "approve_prd": (), "upsert": ("node",), "remove": ("node",),
    "set": ("field", "value"), "resolve": ("ref",), "task_status": ("node", "status", "ok", "note"),
    "boost": ("node", "value"), "kill": ("node", "text"), "restore": ("node",), "merge": ("node", "other"),
    "twist": ("node", "text"), "promote": ("node",), "weight": ("node", "value"), "weights_reset": (),
    "research": ("node", "text"), "reply": ("ref", "text", "links"),
    "comment": ("text", "author", "anchor"), "comment_accept": ("ref", "proposal"), "comment_rework": ("ref", "text"),
    "comment_delete": ("ref",), "comment_split": ("ref", "parts"),
    "comment_triage": ("ref", "action", "text", "changes", "anchor"),
    "comment_import": ("items",), "comment_posted": ("ref", "url", "ext"), "review": ("action", "refs", "proposals"),
    "review_set": ("value",),
    "score": ("node", "rubric", "value", "pass", "label", "rationale", "sources", "basis"),
    "research_status": ("node", "state", "note", "report", "run"),
}
BOARD_EVENTS = ("boost", "kill", "restore", "merge", "twist", "promote", "weight", "weights_reset", "research",
                "score", "research_status")
SESSION_EVENTS = ("upsert", "remove", "set", "resolve", "reply", "task_status", "score", "research_status",
                  "comment_split", "comment_triage", "comment_import", "comment_posted", "review_set")
COMMENT_EVENTS = ("comment", "comment_accept", "comment_rework", "comment_delete", "comment_split", "comment_triage")
REVIEW_EVENTS = ("comment_import", "comment_posted", "review", "review_set")  # contract 14
# a session may not accept its own proposal or authorise its own outward review action
USER_ONLY_EVENTS = ("comment_accept", "comment_rework", "comment_delete", "review")
PAGE_ONLY_EVENTS = ("comment_accept", "review")  # also need source page: a speed bump, the owner's deny rule is the guard (contract 14)
REQUEST_TYPES = ("note", "ask", "expand", "merge", "twist", "promote", "research", "comment", "review")
VERDICTS = ("ok", "warn", "bad", "na")
BASES = ("research", "session")
GROUPS = ("weighted", "lens", "gate")
SCOPES = ("idea", "question", "shortlist")
VEHICLES = ("inline", "worker", "workflow", "sublead")
RESEARCH_STATES = ("queued", "running", "done", "failed")
MAX_PLAN_BYTES = 2 * 1024 * 1024
THREAD_LIMIT = 40
COMMENT_LIMIT = 100
COMMENT_TEXT_LIMIT = 5000
IMPORT_LIMIT = 50
EXT_DROPPED_LIMIT = 1000  # deleted or split GitHub comments an import must not bring back; the oldest go first
REVIEW_REF_LIMIT = 20
REVIEW_ACTIONS = ("open", "push", "pull", "post")
TRUNCATED = " [truncated]"
COMMENT_KEYS = {"id", "author", "text", "anchor", "at", "state", "source", "proposal"}
COMMENT_REVIEW_KEYS = {"ext", "url", "reply_to", "resolved", "edited", "posted"}  # optional per record (contract 14.1)
PR_KEYS = {"repo", "number", "url", "branch", "head_sha", "prd_rev", "opened_at", "pulled_at"}
PR_FIXED = ("repo", "number", "url", "branch", "opened_at")  # review_set may change only head_sha, prd_rev, pulled_at while a PR is recorded
IMPORT_KEYS = {"ext", "author", "text", "anchor", "reply_to", "url", "resolved", "path", "line"}
COMMENT_STATES = ("open", "proposed", "accepted", "declined", "answered")
PROPOSAL_ACTIONS = ("accept", "answer", "decline")
PROPOSAL_STATES = {"accept": "accepted", "answer": "answered", "decline": "declined"}
LINK_LIMIT = 10
# Kinds a comment proposal may touch, with the fields beyond id/kind/label/body a proposal may set (contract 13.4).
PROPOSAL_FIELDS = {
    "requirement": {"nfr"}, "risk": {"approach"}, "edge": {"expect"}, "assumption": {"validate_by", "impact"},
    "constraint": {"tag"}, "nongoal": {"why"}, "note": {"lane"},
    "question": {"lane", "why", "options", "recommended"}, "goal": set(), "story": set(),
}
MULTILINE_FIELDS = {"body", "tldr", "text", "why", "evidence", "scenarios",
                    "pitch", "who", "win", "rationale", "note", "question", "kill_reason"}


class PlanError(Exception):
    def __init__(self, message, code=2, findings=None):
        super().__init__(message)
        self.code = code
        self.findings = findings


def need(condition, message):
    if not condition:
        raise PlanError(message)


def utcnow():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def task_id_valid(task_id):
    return isinstance(task_id, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", task_id) is not None and ".." not in task_id


def crew_root():
    return Path(os.environ.get("CREW_ROOT", "~/.claude/crew")).expanduser().absolute()


def task_path(task_id):
    need(task_id_valid(task_id), "Invalid task id")
    return crew_root() / task_id / "plan"


def plan_dir(task_id: str) -> Path:
    directory = task_path(task_id)
    if not (directory / "plan.json").is_file():
        raise PlanError(f"No plan for {task_id}", 3)
    return directory


def reject_constant(name):
    raise ValueError(f"{name} is not valid JSON")


def loads(data):
    """json.loads that refuses NaN/Infinity, which allow_nan=False writers could not store back."""
    return json.loads(data, parse_constant=reject_constant)


def is_int(value):
    return type(value) is int


def str_list(value):
    return isinstance(value, list) and all(isinstance(item, str) for item in value)


def timestamp(value):
    if not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z", value):
        return False
    try:
        datetime.strptime(value, "%Y-%m-%dT%H:%M:%SZ")
        return True
    except ValueError:
        return False


def control_free(value, field, keep=""):
    """Reject C0, DEL, C1, Cf format and Zl/Zp separator characters (except those in keep): they reach PRD.md and terminals as escapes or hidden text, and U+2028/9 split lines in line-based readers."""
    need(not any(unicodedata.category(c) in ("Cc", "Cf", "Zl", "Zp") and c not in keep for c in value),
         f"{field} contains control characters")


def control_free_all(value, field="plan", multiline=False):
    """Walk any stored value; strings are one line unless their field name is in MULTILINE_FIELDS."""
    if isinstance(value, str):
        control_free(value, field, "\n\t" if multiline else "")
    elif isinstance(value, list):
        for item in value:
            control_free_all(item, field, multiline)
    elif isinstance(value, dict):
        for key, item in value.items():
            control_free(key, f"{field} key", "")
            control_free_all(item, f"{field}.{key}", key in MULTILINE_FIELDS)


def text(value, field, limit=None, empty=False, line=False):
    need(isinstance(value, str), f"{field} must be text")
    control_free(value, field, "" if line else "\n\t")
    value = value.strip()
    need(empty or bool(value), f"{field} cannot be empty")
    need(limit is None or len(value) <= limit, f"{field} is too long")
    need(not line or not any(c in value for c in "\n\r"), f"{field} must be one line")
    return value


def absolute_or_null(value):
    return value is None or (isinstance(value, str) and os.path.isabs(value))


def score_value(value, field="value"):
    need(type(value) in (int, float) and 1 <= value <= 5 and round(value, 1) == value,
         f"{field} must be a number from 1 to 5 with at most one decimal")


def check_evidence(nid, key, entry, gate, rev):
    """One stored score (a weighted/lens rubric) or gate verdict on an idea."""
    where = f"{nid}.{'gates' if gate else 'scores'}.{key}"
    own = {"pass", "note"} if gate else {"value", "label", "rationale"}
    need(isinstance(entry, dict) and set(entry) == own | {"sources", "basis", "rev"}, f"{where}: invalid fields")
    if gate:
        need(entry["pass"] is None or type(entry["pass"]) is bool, f"{where}: pass must be true, false or null")
        text(entry["note"], f"{where}.note", 2000, empty=True)
    else:
        score_value(entry["value"], f"{where}.value")
        text(entry["label"], f"{where}.label", 60, empty=True, line=True)
        text(entry["rationale"], f"{where}.rationale", 2000, empty=True)
    need(str_list(entry["sources"]) and entry["basis"] in BASES, f"{where}: invalid sources/basis")
    need(is_int(entry["rev"]) and 0 <= entry["rev"] <= rev, f"{where}: invalid rev")


def validate_idea(node, rev):
    nid = node["id"]
    need(node["status"] != "parked", f"{nid}: an idea cannot be parked")
    text(node["hook"], f"{nid}.hook", 120, empty=True, line=True)
    text(node["pitch"], f"{nid}.pitch", 4000, empty=True)
    text(node["who"], f"{nid}.who", 4000, empty=True)
    text(node["win"], f"{nid}.win", 4000, empty=True)
    text(node["tier"], f"{nid}.tier", 40, empty=True, line=True)
    text(node["kill_reason"], f"{nid}.kill_reason", 2000, empty=True)
    need(is_int(node["boost"]) and 0 <= node["boost"] <= 3, f"{nid}: boost must be 0 to 3")
    need(len(node["twists"]) <= 6, f"{nid}: at most six twists")
    for twist in node["twists"]:
        text(twist, f"{nid}.twists", 300, line=True)
    need(len(node["merged_from"]) <= 2, f"{nid}: merged_from names at most two ideas")
    need(node["merged_into"] is None or isinstance(node["merged_into"], str), f"{nid}: invalid merged_into")
    checks = node["checks"]
    if checks is not None:
        need(isinstance(checks, dict) and set(checks) == {"allowed", "exists", "feasible"}, f"{nid}: invalid checks")
        for key, check in checks.items():
            need(isinstance(check, dict) and set(check) == {"verdict", "label", "note"}
                 and check["verdict"] in VERDICTS, f"{nid}.checks.{key}: invalid check")
            text(check["label"], f"{nid}.checks.{key}.label", 60, empty=True, line=True)
            text(check["note"], f"{nid}.checks.{key}.note", 2000, empty=True)
    for field, gate in (("scores", False), ("gates", True)):
        need(isinstance(node[field], dict), f"{nid}.{field} must be an object")
        for key, entry in node[field].items():
            check_evidence(nid, key, entry, gate, rev)


def add_thread(node, role, entry_text, at, ref):
    """Append to a node's conversation thread (optional key, absent = empty), keeping the last THREAD_LIMIT entries."""
    node["thread"] = (node.get("thread", []) + [{"role": role, "text": entry_text, "at": at, "ref": ref}])[-THREAD_LIMIT:]


def validate_thread(nid, thread, links=False):
    need(isinstance(thread, list) and len(thread) <= THREAD_LIMIT, f"{nid}.thread must be a list of at most {THREAD_LIMIT}")
    for entry in thread:
        need(isinstance(entry, dict) and set(entry) == {"role", "text", "at", "ref"} | ({"links"} if links else set()),
             f"{nid}.thread: invalid entry fields")
        need(entry["role"] in ("user", "session") and isinstance(entry["ref"], str), f"{nid}.thread: invalid role/ref")
        text(entry["text"], f"{nid}.thread.text", 2000)
        need(timestamp(entry["at"]), f"{nid}.thread: invalid timestamp")
        if links:
            need(str_list(entry["links"]) and len(entry["links"]) <= LINK_LIMIT, f"{nid}.thread: invalid links")
            need(entry["role"] == "session" or not entry["links"], f"{nid}.thread: a user entry has no links")


def add_plan_thread(plan, role, entry_text, at, ref, links=()):
    """Append to the plan-level conversation (optional key, absent = empty), keeping the last THREAD_LIMIT entries."""
    entry = {"role": role, "text": entry_text, "at": at, "ref": ref, "links": list(links)}
    plan["thread"] = (plan.get("thread", []) + [entry])[-THREAD_LIMIT:]


def anchor_valid(anchor, byid):
    return anchor is None or (isinstance(anchor, str) and (anchor in byid or re.fullmatch(r"§(?:1[0-8]|[0-9])", anchor) is not None))


def ext_valid(value):
    return isinstance(value, str) and re.fullmatch(r"(?:rc|rv|ic):\d{1,20}", value) is not None


def https_url(value):
    return isinstance(value, str) and len(value) <= 2000 and re.fullmatch(r"https://[^\s\x00-\x1f\x7f]+", value) is not None


def github_url(value):
    """The page labels these links GitHub: any other https site would send the owner somewhere else."""
    return https_url(value) and value.startswith("https://github.com/")


def repo_name_valid(value):
    """owner/name for gh: no path segments ('.', '..') that would turn into a different API URL."""
    return (isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9._-]{1,100}", value) is not None
            and value.split("/")[1] not in (".", ".."))


def validate_review_pr(plan):
    pr = plan.get("review_pr")
    if pr is None:
        return
    need(isinstance(pr, dict) and set(pr) == PR_KEYS, "Invalid review_pr fields")
    need(repo_name_valid(pr["repo"]), "review_pr.repo must be owner/name")
    need(is_int(pr["number"]) and pr["number"] > 0, "review_pr.number must be a positive integer")
    need(pr["url"] == f"https://github.com/{pr['repo']}/pull/{pr['number']}", "review_pr.url must be https://github.com/<repo>/pull/<number>")
    need(isinstance(pr["branch"], str) and re.fullmatch(r"[A-Za-z0-9._/][A-Za-z0-9._/-]{0,199}", pr["branch"])
         and ".." not in pr["branch"], "Invalid review_pr.branch")
    need(isinstance(pr["head_sha"], str) and re.fullmatch(r"[0-9a-f]{40}", pr["head_sha"]), "review_pr.head_sha must be 40 hex digits")
    need(is_int(pr["prd_rev"]) and 0 <= pr["prd_rev"] <= plan["rev"], "Invalid review_pr.prd_rev")
    need(timestamp(pr["opened_at"]) and (pr["pulled_at"] is None or timestamp(pr["pulled_at"])), "Invalid review_pr timestamps")


def validate_comments(plan, byid):
    comments = plan.get("comments", [])
    need(isinstance(comments, list) and len(comments) <= COMMENT_LIMIT, f"comments must be a list of at most {COMMENT_LIMIT}")
    numbers, exts = set(), set()
    for comment in comments:
        need(isinstance(comment, dict) and COMMENT_KEYS <= set(comment) <= COMMENT_KEYS | COMMENT_REVIEW_KEYS,
             "Invalid comment fields")
        cid = comment["id"]
        need(isinstance(cid, str) and re.fullmatch(r"CM[1-9]\d*", cid) and cid not in numbers, "Invalid comment id")
        numbers.add(cid)
        text(comment["author"], f"{cid}.author", 80, empty=True, line=True)
        text(comment["text"], f"{cid}.text", COMMENT_TEXT_LIMIT)
        need(anchor_valid(comment["anchor"], byid), f"{cid}: invalid anchor")
        need(timestamp(comment["at"]) and comment["state"] in COMMENT_STATES and comment["source"] in ("paste", "github"),
             f"{cid}: invalid timestamp/state/source")
        ext, posted = comment.get("ext"), comment.get("posted")
        need((ext is None or ext_valid(ext)) and (comment["source"] == "github") == (ext is not None) and (ext is None or ext not in exts),
             f"{cid}: invalid or duplicate ext")
        exts.add(ext)
        need(comment.get("url", "") == "" or https_url(comment["url"]), f"{cid}: url must be an https link")
        need(comment.get("reply_to") is None or ext_valid(comment["reply_to"]), f"{cid}: invalid reply_to")
        need(all(type(comment.get(flag, False)) is bool for flag in ("resolved", "edited")), f"{cid}: resolved/edited must be booleans")
        need(posted is None or (isinstance(posted, dict) and set(posted) == {"at", "url", "ext"} and timestamp(posted["at"])
                                and https_url(posted["url"]) and ext_valid(posted["ext"])), f"{cid}: invalid posted")
        proposal = comment["proposal"]
        if comment["state"] == "open":
            need(proposal is None, f"{cid}: an open comment has no proposal")
            continue
        need(isinstance(proposal, dict) and set(proposal) == {"action", "text", "rev", "changes", "at"}, f"{cid}: invalid proposal fields")
        need(proposal["action"] in PROPOSAL_ACTIONS and timestamp(proposal["at"]), f"{cid}: invalid proposal action/time")
        need(comment["state"] == "proposed" or PROPOSAL_STATES[proposal["action"]] == comment["state"], f"{cid}: state does not match the proposal")
        text(proposal["text"], f"{cid}.proposal.text", 2000, empty=True)
        need(is_int(proposal["rev"]) and 0 <= proposal["rev"] <= plan["rev"], f"{cid}: invalid proposal rev")
        changes = proposal["changes"]
        need(isinstance(changes, list) and len(changes) <= 5 and all(isinstance(c, dict) and isinstance(c.get("type"), str) for c in changes),
             f"{cid}: invalid proposal changes")
        need((proposal["action"] == "accept") == bool(changes), f"{cid}: only an accept proposal carries changes")
    seq = plan.get("comment_seq")
    if "comment_seq" in plan:
        need(is_int(seq) and seq >= max((int(c[2:]) for c in numbers), default=0), "Invalid comment_seq")
    if "ext_dropped" in plan:
        dropped = plan["ext_dropped"]
        need(isinstance(dropped, list) and len(dropped) <= EXT_DROPPED_LIMIT and all(ext_valid(e) for e in dropped)
             and len(set(dropped)) == len(dropped), "Invalid ext_dropped")
    if "thread" in plan:
        validate_thread("plan", plan["thread"], links=True)


def validate_node(node, rev):
    need(isinstance(node, dict), "Node must be an object")
    kind = node.get("kind")
    need(isinstance(kind, str) and kind in KINDS, "Unknown node kind")
    prefix, width, extra = KINDS[kind]
    defaults = dict(COMMON, **extra)
    need(set(node) - {"thread"} == set(defaults), f"Invalid fields for {kind}")
    nid = node["id"]
    if "thread" in node:
        validate_thread(nid, node["thread"])
    need(isinstance(nid, str) and re.fullmatch(re.escape(prefix) + r"\d{" + str(width) + r",}", nid), "Invalid node id")
    text(node["label"], "label", 120, line=True)
    need(isinstance(node["body"], str) and len(node["body"]) <= 4000, f"{nid}: invalid body")
    control_free(node["body"], f"{nid}.body", "\n\t")
    need(node["status"] in (TASK_STATUSES if kind == "task" else STATUSES), f"{nid}: invalid status")
    need(is_int(node["rev"]) and 0 <= node["rev"] <= rev, f"{nid}: invalid rev")
    need(node["by"] in ("user", "session") and type(node["by_default"]) is bool, f"{nid}: invalid attribution")
    for field, default in defaults.items():
        value = node[field]
        if isinstance(default, list):
            need(isinstance(value, list), f"{nid}.{field} must be a list")
            if field != "options":
                need(str_list(value), f"{nid}.{field} must contain ids/text")
        elif default is not None:
            need(type(value) is type(default), f"{nid}.{field} has the wrong type")
    if kind == "constraint":
        need(node["tag"] in ("appetite", "stack", "perf", "security", "other"), "Invalid constraint tag")
    if kind == "boundary":
        need(node["tier"] in ("always", "ask", "never", "command"), "Invalid boundary tier")
    if kind in ("question", "note"):
        need(node["lane"] in LANES, "Invalid lane")
    if kind == "requirement" and node["nfr"]:
        need(re.search(r"\d", node["label"] + node["body"]), "NFR must carry a number")
    if kind == "criterion":
        need(node["goal"] is None or isinstance(node["goal"], str), "Invalid goal")
    if kind == "task":
        for field in ("slice", "crew"):
            need(node[field] is None or isinstance(node[field], str), f"Invalid task {field}")
        need(node["crew"] is None or task_id_valid(node["crew"]), "Invalid crew task id")
        result = node["result"]
        if result is not None:
            need(isinstance(result, dict) and set(result) == {"ok", "at", "note"}, "Invalid task result")
            need(type(result["ok"]) is bool and timestamp(result["at"]) and isinstance(result["note"], str), "Invalid task result fields")
    if kind == "idea":
        validate_idea(node, rev)
    if kind == "rubric":
        need(node["group"] in GROUPS, "Invalid rubric group")
        for field in ("weight", "default_weight"):
            need(is_int(node[field]) and 0 <= node[field] <= 50, f"{nid}.{field} must be 0 to 50")
            need(node["group"] != "gate" or node[field] == 0, f"{nid}.{field} is always 0 for a gate")
        text(node["origin"], f"{nid}.origin", 4000, empty=True, line=True)
    if kind == "research":
        need(node["scope"] in SCOPES and node["vehicle"] in VEHICLES and node["state"] in RESEARCH_STATES,
             "Invalid research scope/vehicle/state")
        text(node["question"], f"{nid}.question", 4000, empty=True)
        text(node["note"], f"{nid}.note", 2000, empty=True)
        for field in ("run", "report"):
            text(node[field], f"{nid}.{field}", 4096, empty=True, line=True)
    if kind == "question":
        need(node["stage"] in QSTAGES and node["class"] in ("mechanical", "taste", "user"), "Invalid question stage/class")
        options = node["options"]
        need(len(options) <= 6, "At most six options allowed")
        for i, option in enumerate(options):
            need(isinstance(option, dict) and set(option) == {"key", "label", "why"}, "Invalid option fields")
            need(option["key"] == "abcdef"[i] and isinstance(option["why"], str), "Options must use keys a through f in order")
            text(option["label"], "option label", 120, line=True)
        keys = [option["key"] for option in options]
        need(node["recommended"] is None or node["recommended"] in keys, "Unknown recommended option")
        answer = node["answer"]
        if answer is not None:
            need(isinstance(answer, dict) and set(answer) == {"choice", "text", "by", "source", "at", "rev"}, "Invalid answer fields")
            need(answer["choice"] is None or answer["choice"] in keys, "Invalid answer choice")
            need(answer["text"] is None or isinstance(answer["text"], str), "Invalid answer text")
            need(answer["choice"] is not None or bool(answer["text"] and answer["text"].strip()), "Empty answer")
            need(answer["by"] in ("user", "session") and answer["source"] in ("page", "terminal", "build"), "Invalid answer attribution")
            need(timestamp(answer["at"]) and is_int(answer["rev"]) and 0 < answer["rev"] <= rev, "Invalid answer timestamp/rev")


def validate(plan, strict=False):
    """strict also rejects control/format characters anywhere in the plan; used for every write, not for display of a plan already on disk."""
    need(isinstance(plan, dict) and TOP_KEYS <= set(plan) <= TOP_KEYS | OPTIONAL_TOP_KEYS, "Invalid top-level keys in plan")
    need(type(plan["schema"]) is int and plan["schema"] == 1, "Unknown schema")
    need(task_id_valid(plan["id"]), "Invalid plan id")
    need(plan["slug"] == re.sub(r"^\d{4}-", "", plan["id"]), "Invalid slug")
    need(plan["size"] in SIZES and plan["stage"] in STAGES, "Invalid size/stage")
    text(plan["title"], "title")
    need(isinstance(plan["owner"], str) and isinstance(plan["tldr"], str), "Invalid owner/tldr")
    need(is_int(plan["rev"]) and plan["rev"] >= 0, "Invalid plan rev")
    need(timestamp(plan["created"]) and timestamp(plan["updated"]), "Invalid plan timestamps")
    need(absolute_or_null(plan["repo"]) and absolute_or_null(plan["published"]), "repo/published must be absolute or null")
    approved = plan["approved"]
    if approved is not None:
        need(isinstance(approved, dict) and set(approved) == {"at", "rev"}, "Invalid approval fields")
        need(timestamp(approved["at"]) and is_int(approved["rev"]) and 0 < approved["rev"] <= plan["rev"], "Invalid approval")
    need(isinstance(plan["nodes"], list), "nodes must be a list")
    byid = {}
    for node in plan["nodes"]:
        validate_node(node, plan["rev"])
        need(node["id"] not in byid, "Duplicate node id")
        byid[node["id"]] = node
    for node in plan["nodes"]:
        for field in ("depends_on", "refs", "fills"):
            for ref in node.get(field, []):
                need(ref in byid, f"{node['id']}.{field}: unknown id {ref}")
                if field == "fills":
                    need(byid[ref]["kind"] not in ("question", "task"), "fills cannot name question/task")
        for field, kind in (("goal", "goal"), ("slice", "slice")):
            ref = node.get(field)
            if ref is not None:
                need(ref in byid and byid[ref]["kind"] == kind, f"Invalid {field} ref")
    need(sum(n["kind"] == "idea" and n["status"] == "settled" for n in plan["nodes"]) <= 1,
         "At most one idea can be settled")
    for node in plan["nodes"]:
        if node["kind"] == "idea":
            for field, groups in (("scores", ("weighted", "lens")), ("gates", ("gate",))):
                for key in node[field]:
                    need(key in byid and byid[key]["kind"] == "rubric" and byid[key]["group"] in groups,
                         f"{node['id']}.{field}: {key} is not a {'/'.join(groups)} rubric")
            for ref in node["merged_from"] + ([node["merged_into"]] if node["merged_into"] else []):
                need(ref in byid and byid[ref]["kind"] == "idea", f"{node['id']}: {ref} is not an idea")
        if node["kind"] == "research":
            for ref in node["targets"]:
                need(ref in byid and byid[ref]["kind"] == "idea", f"{node['id']}.targets: {ref} is not an idea")
    # Iterative DFS also handles valid dependency chains beyond Python's recursion limit.
    visiting, visited = set(), set()
    for nid in byid:
        stack = [(nid, False)]
        while stack:
            current, exiting = stack.pop()
            if exiting:
                visiting.remove(current)
                visited.add(current)
            elif current not in visited:
                need(current not in visiting, "depends_on cycle")
                visiting.add(current)
                stack.append((current, True))
                stack.extend((ref, False) for ref in reversed(byid[current]["depends_on"]))
    need(str_list(plan["frontier"]), "Invalid frontier")
    progress = plan["progress"]
    need(isinstance(progress, dict) and set(progress) == {"settled", "total"}, "Invalid progress")
    need(all(is_int(v) and v >= 0 for v in progress.values()), "Invalid progress counts")
    validate_comments(plan, byid)
    validate_review_pr(plan)
    need(isinstance(plan["requests"], list) and isinstance(plan["recent"], list), "Invalid requests/recent")
    for request in plan["requests"]:
        need(isinstance(request, dict) and set(request) == {"ref", "type", "node", "lane", "text", "at"}, "Invalid request fields")
        need(isinstance(request["ref"], str) and request["type"] in REQUEST_TYPES, "Invalid request")
        need(request["node"] is None or (isinstance(request["node"], str) and request["node"] in byid), "Invalid request node")
        need(request["lane"] is None or request["lane"] in LANES, "Invalid request lane")
        need(isinstance(request["text"], str) and timestamp(request["at"]), "Invalid request text/timestamp")
    need(len(plan["recent"]) <= 30, "Too many recent events")
    for recent in plan["recent"]:
        need(isinstance(recent, dict) and set(recent) == {"rev", "at", "by", "source", "type", "node", "summary"}, "Invalid recent fields")
        need(is_int(recent["rev"]) and 0 < recent["rev"] <= plan["rev"] and timestamp(recent["at"]), "Invalid recent rev/timestamp")
        need(recent["by"] in ("user", "session") and recent["source"] in ("page", "terminal", "build"), "Invalid recent attribution")
        need(isinstance(recent["type"], str) and recent["type"] in EVENT_FIELDS and isinstance(recent["summary"], str), "Invalid recent event")
        need(recent["node"] is None or isinstance(recent["node"], str), "Invalid recent node")
    if strict:
        control_free_all(plan)


def load(task_id: str) -> dict:
    path = plan_dir(task_id) / "plan.json"
    with path.open("rb") as handle:
        data = handle.read(MAX_PLAN_BYTES + 1)
    need(len(data) <= MAX_PLAN_BYTES, "plan.json exceeds 2 MB")
    try:
        plan = loads(data)
    except (ValueError, UnicodeError) as exc:
        raise PlanError(f"Invalid plan.json: {exc}") from exc
    validate(plan)
    need(plan["id"] == task_id, "Plan id does not match its task directory")
    return plan


def frontier(plan: dict) -> list[str]:
    byid = {node["id"]: node for node in plan["nodes"]}
    dependents = dict.fromkeys(byid, 0)
    for node in plan["nodes"]:
        if node["status"] == "open":
            for ref in set(node["depends_on"]):
                dependents[ref] += 1
    eligible = [node for node in plan["nodes"] if node["kind"] == "question" and node["status"] == "open"
                and all(byid[ref]["status"] in ("settled", "done", "killed") for ref in node["depends_on"])]
    eligible.sort(key=lambda n: (-n["priority"], QSTAGES.index(n["stage"]), -dependents[n["id"]], int(n["id"][1:])))
    return [node["id"] for node in eligible]


def derive(plan):
    plan["frontier"] = frontier(plan)
    questions = [n for n in plan["nodes"] if n["kind"] == "question" and n["status"] != "killed"]
    plan["progress"] = {"settled": sum(n["status"] == "settled" for n in questions), "total": len(questions)}


def one_line(value):
    return " ".join(str(value).split())


def board_event(plan, event, byid, node):
    """Ideate/Research events (contract 12.2, 12.3). Returns (summary, touched nodes)."""
    kind = event["type"]
    touched = []
    if kind in ("boost", "kill", "restore", "merge", "twist", "promote"):
        need(node["kind"] == "idea", "Node is not an idea")
        if kind == "boost":
            need(node["status"] == "open", "Only an open idea can be boosted")
            value = event.get("value")
            need(is_int(value) and 0 <= value <= 3, "boost value must be 0 to 3")
            node["boost"] = value
            summary = f"boosted {node['id']} ({value})"
        elif kind == "kill":
            need(node["status"] != "killed", "Idea is killed already")
            need(event.get("text"), "kill requires a reason")
            node.update(status="killed", kill_reason=event["text"], boost=0)
            summary = f"killed {node['id']}: {one_line(event['text'])}"
        elif kind == "restore":
            need(node["status"] == "killed", "Only a killed idea can be restored")
            node.update(status="open", kill_reason="")
            summary = f"restored {node['id']}"
        elif kind == "merge":
            other_id = event.get("other")
            need(isinstance(other_id, str) and other_id in byid, "other must name an existing node")
            other = byid[other_id]
            need(other is not node, "Cannot merge an idea with itself")
            need(other["kind"] == "idea" and "killed" not in (node["status"], other["status"]),
                 "Only ideas in play can be merged")
            prefix, _, extra = KINDS["idea"]
            number = max(int(n["id"][len(prefix):]) for n in plan["nodes"] if n["kind"] == "idea") + 1
            draft = copy.deepcopy(dict(COMMON, **extra))
            draft.update(id=prefix + str(number), kind="idea", label=f"{node['label']} + {other['label']}"[:120],
                         tier="Draft", merged_from=[node["id"], other["id"]])
            plan["nodes"].append(draft)
            node["merged_into"] = other["merged_into"] = draft["id"]
            plan["requests"].append({"ref": event["id"], "type": "merge", "node": draft["id"], "lane": None,
                                     "text": "", "at": event["at"]})
            touched.append(draft)
            event["draft"] = draft["id"]  # the audit line keeps the draft id: news cannot find it from the parents alone
            summary = f"merged {node['id']} + {other['id']} into {draft['id']}"
            touched.append(other)
        elif kind == "twist":
            plan["requests"].append({"ref": event["id"], "type": "twist", "node": node["id"], "lane": None,
                                     "text": event.get("text", ""), "at": event["at"]})
            summary = f"twist on {node['id']}"
        else:
            need(node["status"] != "killed", "A killed idea cannot be promoted")
            for other in plan["nodes"]:
                if other["kind"] == "idea" and other["status"] == "settled" and other is not node:
                    other["status"] = "open"
                    touched.append(other)
            node["status"] = "settled"
            if plan["stage"] in ("ideate", "research"):
                plan["stage"] = "frame"
            plan["requests"].append({"ref": event["id"], "type": "promote", "node": node["id"], "lane": None,
                                     "text": "", "at": event["at"]})
            summary = f"promoted {node['id']}"
        if kind != "twist":  # a twist only asks the session for something; the idea itself does not change
            touched.append(node)
    elif kind == "weight":
        need(node["kind"] == "rubric" and node["group"] != "gate", "Only a weighted or lens rubric has a weight")
        value = event.get("value")
        need(is_int(value) and 0 <= value <= 50, "weight value must be 0 to 50")
        node["weight"] = value
        touched = [node]
        summary = f"weight {node['id']} = {value}"
    elif kind == "weights_reset":
        rubrics = [n for n in plan["nodes"] if n["kind"] == "rubric"]
        need(rubrics, "No rubric exists")
        for rubric in rubrics:
            if rubric["group"] != "gate" and rubric["weight"] != rubric["default_weight"]:
                rubric["weight"] = rubric["default_weight"]
                touched.append(rubric)
        summary = "weights reset"
    elif kind == "research":
        if node is not None:
            need(node["kind"] in ("idea", "question"), "Research needs an idea or a question")
        target = "shortlist" if node is None else node["id"] if node["kind"] == "idea" else "question"
        plan["requests"].append({"ref": event["id"], "type": "research", "node": node["id"] if node else None,
                                 "lane": None, "text": event.get("text", ""), "at": event["at"]})
        summary = f"research requested: {target}"
    elif kind == "score":
        need(node["kind"] == "idea", "Node is not an idea")
        rubric_id = event.get("rubric")
        need(isinstance(rubric_id, str) and rubric_id in byid and byid[rubric_id]["kind"] == "rubric"
             and byid[rubric_id]["status"] != "killed", "rubric must name an existing rubric that is not killed")
        rubric = byid[rubric_id]
        need(("value" in event) != ("pass" in event), "score needs exactly one of value or pass")
        basis = event.get("basis", "session")
        sources = event.get("sources", [])
        need(basis in BASES and str_list(sources), "Invalid score basis/sources")
        rationale = text(event.get("rationale", ""), "rationale", 2000, empty=True)
        common = {"sources": copy.deepcopy(sources), "basis": basis, "rev": event["rev"]}
        if rubric["group"] == "gate":
            need("pass" in event, "A gate takes pass, not value")
            need(event["pass"] is None or type(event["pass"]) is bool, "pass must be true, false or null")
            node["gates"][rubric_id] = {"pass": event["pass"], "note": rationale, **common}
            verdict = {True: "passes", False: "fails", None: "is undecided on"}[event["pass"]]
            summary = f"{node['id']} {verdict} {rubric_id}"
        else:
            need("value" in event, "A weighted or lens rubric takes value, not pass")
            score_value(event["value"])
            label = text(event.get("label", ""), "label", 60, empty=True, line=True)
            node["scores"][rubric_id] = {"value": event["value"], "label": label, "rationale": rationale, **common}
            summary = f"scored {node['id']} on {rubric_id}: {event['value']:g} ({basis})"
        touched = [node]
    else:  # research_status
        need(node["kind"] == "research", "Node is not a research job")
        need(event.get("state") in RESEARCH_STATES, "Unknown research state")
        need("report" not in event or (isinstance(event["report"], str) and os.path.isabs(event["report"])),
             "report must be an absolute path")
        node["state"] = event["state"]
        node["note"] = event.get("note", "")
        for field in ("report", "run"):
            if field in event:
                node[field] = text(event[field], field, 4096, empty=True, line=True)
        detail = {"done": node["report"], "failed": node["note"]}.get(node["state"])
        summary = f"{node['id']} {node['state']}" + (f": {one_line(detail)}" if detail else "")
        touched = [node]
    return summary, touched


def comment_anchor(value, byid):
    need(anchor_valid(value, byid), "anchor must be null, an existing node id or §0 to §18")
    return value


def comment_request(plan, comment, request_text, at, byid):
    plan["requests"].append({"ref": comment["id"], "type": "comment", "node": comment["anchor"] if comment["anchor"] in byid else None,
                             "lane": None, "text": request_text, "at": at})


def add_comment(plan, body, author, anchor, at, byid, **extra):
    seq = plan.get("comment_seq", max((int(c["id"][2:]) for c in plan.get("comments", [])), default=0)) + 1
    comment = {"id": f"CM{seq}", "author": author, "text": body, "anchor": anchor, "at": at, "state": "open",
               "source": "paste", "proposal": None, **extra}
    plan["comment_seq"] = seq
    plan.setdefault("comments", []).append(comment)
    comment_request(plan, comment, body, at, byid)
    return comment


def drop_comment_request(plan, cid):
    plan["requests"] = [r for r in plan["requests"] if not (r["type"] == "comment" and r["ref"] == cid)]


def capped_strings(value, field):
    """A proposal carries free text of any shape (options, ...): cap every string in it."""
    if isinstance(value, str):
        need(len(value) <= 4000, f"{field} is too long")
    elif isinstance(value, list):
        for item in value:
            capped_strings(item, field)
    elif isinstance(value, dict):
        for key, item in value.items():
            capped_strings(key, field)
            capped_strings(item, field)
    return value


def clean_change(change, byid):
    """One change of a comment proposal, normalised, or PlanError when it is outside the allow-list (contract 13.4)."""
    need(isinstance(change, dict) and isinstance(change.get("type"), str), "A change must be an event object")
    kind = change["type"]
    if kind == "upsert":
        need(set(change) == {"type", "node"} and isinstance(change["node"], dict), "upsert takes only a node object")
        patch = change["node"]
        if "id" in patch:
            need(isinstance(patch["id"], str) and patch["id"] in byid, "upsert must name an existing node")
            node_kind = byid[patch["id"]]["kind"]
            need(patch.get("kind", node_kind) == node_kind, "Cannot change node kind")
        else:
            node_kind = patch.get("kind")
        need(isinstance(node_kind, str) and node_kind in PROPOSAL_FIELDS, f"A proposal cannot change a {node_kind} node")
        extra = set(patch) - {"id", "kind", "label", "body"} - PROPOSAL_FIELDS[node_kind]
        need(not extra, f"A proposal cannot set {', '.join(sorted(map(str, extra)))} on a {node_kind}")
        clean = {}
        for key, value in patch.items():
            if key == "label":
                value = text(value, "label", 120, line=True)
            elif isinstance(value, str):
                value = value.strip() if key in ("id", "kind") else text(value, key, 4000, empty=True)
            clean[key] = copy.deepcopy(capped_strings(value, key))
        return {"type": "upsert", "node": clean}
    if kind in ("reopen", "edit_label"):
        need(set(change) == {"type", "node"} | ({"label"} if kind == "edit_label" else set()), f"{kind} takes only its own fields")
        nid = change["node"]
        need(isinstance(nid, str) and nid in byid, f"{kind} must name an existing node")
        need(byid[nid]["kind"] in PROPOSAL_FIELDS, f"A proposal cannot change a {byid[nid]['kind']} node")
        clean = {"type": kind, "node": nid}
        if kind == "edit_label":
            clean["label"] = text(change["label"], "label", 120, line=True)
        return clean
    need(kind == "set" and set(change) == {"type", "field", "value"} and change["field"] in ("title", "tldr"),
         "A proposal may only upsert, reopen, edit_label or set title/tldr")
    return {"type": "set", "field": change["field"],
            "value": text(change["value"], change["field"], 4000, empty=change["field"] == "tldr", line=True)}


def apply_changes(plan, changes, event):
    """Run cleaned proposal changes on plan as the user at this event's rev/at. Returns them with assigned ids."""
    applied = []
    for change in changes:
        step = dict(copy.deepcopy(change), id=event["id"], at=event["at"], by="user", source=event["source"], rev=event["rev"])
        _change(plan, step)
        applied.append({key: step[key] for key in change})
    return applied


def check_sender(event):
    kind = event["type"]
    need(kind not in USER_ONLY_EVENTS or event["by"] == "user", f"{kind} requires --by user")
    need(kind not in PAGE_ONLY_EVENTS or event["source"] == "page", f"{kind} is accepted only from the plan page (--source page)")


def find_comment(plan, ref, state, what):
    comment = next((c for c in plan.get("comments", []) if c["id"] == ref), None)
    need(comment is not None, "ref must name an existing comment")
    need(state is None or comment["state"] == state, f"Only {'an' if state == 'open' else 'a'} {state} comment can be {what}")
    return comment


def forget_ext(plan, comment):
    """A deleted or split GitHub comment is never imported again: remember its ext (contract 14.1)."""
    for ext in (comment.get("ext"), (comment.get("posted") or {}).get("ext")):  # the owner's own reply goes with it
        if ext is not None and ext not in plan.get("ext_dropped", []):
            plan["ext_dropped"] = (plan.get("ext_dropped", []) + [ext])[-EXT_DROPPED_LIMIT:]


def comment_event(plan, event, byid):
    """Comment events (contract 13). Returns the summary; mutates plan and the applied event."""
    kind = event["type"]
    check_sender(event)
    comments = plan.get("comments", [])
    if kind == "comment":
        need(len(comments) < COMMENT_LIMIT, "Too many comments: delete closed comments")
        need("text" in event, "comment requires text")
        author = text(event.get("author", ""), "author", 80, empty=True, line=True)
        anchor = comment_anchor(event.get("anchor"), byid)
        event.update(author=author, anchor=anchor)
        comment = add_comment(plan, event["text"], author, anchor, event["at"], byid)
        event["comment"] = comment["id"]
        return f"comment {comment['id']} added"
    ref = event.get("ref")
    if kind == "comment_split":
        comment = find_comment(plan, ref, "open", "split")
        parts = event.get("parts")
        need(isinstance(parts, list) and 2 <= len(parts) <= 10, "parts must be 2 to 10 comments")
        need(len(comments) - 1 + len(parts) <= COMMENT_LIMIT, "Too many comments: delete closed comments")
        clean = []
        for part in parts:
            need(isinstance(part, dict) and "text" in part and set(part) <= {"text", "author", "anchor"}, "Invalid comment part")
            clean.append({"text": text(part["text"], "part text", COMMENT_TEXT_LIMIT),
                          "author": text(part["author"], "author", 80, empty=True, line=True) if "author" in part else comment["author"],
                          "anchor": comment_anchor(part["anchor"], byid) if "anchor" in part else comment["anchor"]})
        comments.remove(comment)
        forget_ext(plan, comment)
        drop_comment_request(plan, ref)
        for part in clean:
            add_comment(plan, part["text"], part["author"], part["anchor"], event["at"], byid)
        event["parts"] = clean
        return f"split {ref} into {len(clean)}"
    if kind == "comment_triage":
        comment = find_comment(plan, ref, "open", "triaged")
        action, changes = event.get("action"), event.get("changes")
        need(action in PROPOSAL_ACTIONS, "action must be accept, answer or decline")
        reason = event.get("text", "")
        if action == "accept":
            need(isinstance(changes, list) and 1 <= len(changes) <= 5, "accept needs 1 to 5 changes")
            changes = [clean_change(change, byid) for change in changes]
            dry = copy.deepcopy(plan)  # the changes must apply today, else the failure would wait for the user's click
            apply_changes(dry, changes, event)
            dry["rev"] = event["rev"]
            validate(dry, strict=True)
        else:
            need(reason, f"{action} needs text")
            need(not changes, f"{action} takes no changes")
            changes = []
        if "anchor" in event:
            comment["anchor"] = comment_anchor(event["anchor"], byid)
        comment.update(state="proposed", proposal={"action": action, "text": reason, "rev": event["rev"],
                                                   "changes": changes, "at": event["at"]})
        drop_comment_request(plan, ref)
        event["changes"] = changes
        return f"proposal on {ref}: {action}"
    if kind == "comment_accept":
        comment = find_comment(plan, ref, "proposed", "accepted")
        proposal = comment["proposal"]
        need(is_int(event.get("proposal")) and event["proposal"] == proposal["rev"], "The proposal changed; reload the page")
        try:
            changes = [clean_change(change, byid) for change in proposal["changes"]]
            for change in changes:
                target = byid.get(change.get("node", {}).get("id") if change["type"] == "upsert" else change.get("node"))
                need(target is None or target["rev"] <= proposal["rev"], "node changed since the proposal")
            event["changes"] = apply_changes(plan, changes, event)
        except PlanError as exc:
            raise PlanError(f"Proposal no longer applies: {exc}") from exc
        comment["state"] = PROPOSAL_STATES[proposal["action"]]
        return f"{comment['state']} {ref}"
    if kind == "comment_rework":
        comment = find_comment(plan, ref, "proposed", "reworked")
        comment.update(state="open", proposal=None)
        comment_request(plan, comment, event.get("text") or comment["text"], event["at"], byid)
        return f"reworked {ref}"
    comment = find_comment(plan, ref, None, "deleted")  # comment_delete: any state
    comments.remove(comment)
    forget_ext(plan, comment)
    drop_comment_request(plan, ref)
    return f"deleted {ref}"


def import_text(value):
    """GitHub text as comment text: CR/CRLF become newlines, control and format characters (a ZWJ in an emoji too) are dropped."""
    value = value.replace("\r\n", "\n").replace("\r", "\n")
    return "".join(c for c in value if c in "\n\t" or unicodedata.category(c) not in ("Cc", "Cf", "Zl", "Zp")).strip()


def clean_import_item(item, byid):
    """One comment_import item: structural faults refuse the import; bad content (anchor, url, length) degrades."""
    need(isinstance(item, dict) and {"ext", "author", "text"} <= set(item) <= IMPORT_KEYS, "Invalid import item")
    need(ext_valid(item["ext"]) and (item.get("reply_to") is None or ext_valid(item["reply_to"])), "Invalid import ext/reply_to")
    need(isinstance(item["author"], str) and isinstance(item["text"], str) and isinstance(item.get("url", ""), str),
         "Invalid import author/text/url")
    need(type(item.get("resolved", False)) is bool, "Invalid import resolved")
    need(item.get("path") is None or isinstance(item["path"], str), "Invalid import path")
    need(item.get("line") is None or is_int(item["line"]), "Invalid import line")
    body = import_text(item["text"])
    if len(body) > COMMENT_TEXT_LIMIT:
        body = body[:COMMENT_TEXT_LIMIT - len(TRUNCATED)] + TRUNCATED
    anchor = item.get("anchor")
    url = item.get("url", "")
    return {"ext": item["ext"], "author": " ".join(import_text(item["author"]).split())[:80], "text": body,
            "anchor": anchor if anchor_valid(anchor, byid) else None, "reply_to": item.get("reply_to"),
            "url": url if github_url(url) else "", "resolved": item.get("resolved", False)}


def review_event(plan, event, byid):
    """GitHub review events (contract 14). Returns the summary; mutates plan and the applied event."""
    kind = event["type"]
    check_sender(event)
    if kind == "review_set":
        need("value" in event and (event["value"] is None or isinstance(event["value"], dict)), "review_set value must be null or a record")
        if event["value"] is None:  # validate() checks the record on the candidate plan
            plan.pop("review_pr", None)
            plan["requests"] = [r for r in plan["requests"] if r["type"] != "review"]  # a click made for the old PR must not post to the next
            return "review PR cleared"
        need(event["value"].get("branch") == "prd/" + plan["slug"], f"review_pr.branch must be prd/{plan['slug']}")
        old = plan.get("review_pr")
        need(old is None or all(event["value"].get(key) == old[key] for key in PR_FIXED),
             "review_pr repo, number, url, branch and opened_at cannot change: clear it with review_set null first")
        plan["review_pr"] = copy.deepcopy(event["value"])
        return "review PR set"
    if kind == "comment_posted":
        comment = find_comment(plan, event.get("ref"), None, "marked posted")
        need(comment.get("posted") is None, "Comment is posted already")
        need(github_url(event.get("url")) and ext_valid(event.get("ext")) and event["ext"][:2] in ("rc", "ic"),
             "comment_posted needs a github.com url and an rc:/ic: ext")
        comment["posted"] = {"at": event["at"], "url": event["url"], "ext": event["ext"]}
        return f"posted reply on {comment['id']}"
    if kind == "review":
        action, refs, pr = event.get("action"), event.get("refs"), plan.get("review_pr")
        need(action in REVIEW_ACTIONS, "action must be open, push, pull or post")
        if action == "open":
            need(pr is None, "A review PR is open already")
            need(plan["repo"] is not None, "Set the plan's repo before opening a review PR")
        else:
            need(pr is not None, "No review PR: open one first")
        if action == "post":
            need(isinstance(refs, list) and 1 <= len(refs) <= REVIEW_REF_LIMIT and all(isinstance(r, str) for r in refs)
                 and len(set(refs)) == len(refs), f"post needs 1 to {REVIEW_REF_LIMIT} distinct comment ids")
            shown = event.get("proposals")  # the proposal rev the page displayed on each card: a click posts only that text
            need(isinstance(shown, dict) and set(shown) == set(refs), "post needs the proposal rev shown for each comment id")
            for ref in refs:
                comment = find_comment(plan, ref, None, "posted")
                proposal = comment["proposal"]
                need(comment["source"] == "github" and comment.get("posted") is None
                     and (comment["state"] == "accepted" or (proposal is not None and proposal["action"] in ("answer", "decline")
                                                              and proposal["text"])),
                     f"{ref} has no GitHub reply to post")
                need(is_int(shown[ref]) and shown[ref] == proposal["rev"], "The proposal changed; reload the page")
            line = "post " + ",".join(refs)
        else:
            need(refs is None and event.get("proposals") is None, "refs and proposals apply only to post")
            line = action
        if action == "post":  # a new click replaces every open post request naming one of these comments, so a refused post can be re-clicked
            plan["requests"] = [r for r in plan["requests"] if not (r["type"] == "review" and r["text"].startswith("post ")
                                                                   and set(r["text"][5:].split(",")) & set(refs))]
        if not any(r["type"] == "review" and r["text"] == line for r in plan["requests"]):
            plan["requests"].append({"ref": event["id"], "type": "review", "node": None, "lane": None, "text": line, "at": event["at"]})
        return f"review requested: {line}"
    items = event.get("items")  # comment_import
    need(isinstance(items, list) and 1 <= len(items) <= IMPORT_LIMIT, f"items must be 1 to {IMPORT_LIMIT} comments")
    items = event["items"] = [clean_import_item(item, byid) for item in items]
    comments = plan.get("comments", [])
    known = {c["ext"]: c for c in comments if c.get("ext")}
    skipped = {c["posted"]["ext"] for c in comments if c.get("posted")} | set(plan.get("ext_dropped", []))  # our replies; deleted or split comments
    imported = created = 0
    for item in items:
        if item["ext"] in skipped or not item["text"]:
            continue
        imported += 1
        comment = known.get(item["ext"])
        if comment is None:
            need(len(plan.get("comments", [])) < COMMENT_LIMIT, "Too many comments: delete closed comments")
            known[item["ext"]] = add_comment(plan, item["text"], item["author"], item["anchor"], event["at"], byid, source="github",
                                             ext=item["ext"], url=item["url"], reply_to=item["reply_to"], resolved=item["resolved"],
                                             edited=False, posted=None)
            created += 1
            continue
        if comment["text"] != item["text"]:
            comment.update(text=item["text"], edited=True)
            if comment["state"] == "proposed":
                comment.update(state="open", proposal=None)
                comment_request(plan, comment, item["text"], event["at"], byid)
            elif comment["state"] == "open":
                for request in plan["requests"]:
                    if request["type"] == "comment" and request["ref"] == comment["id"]:
                        request["text"] = item["text"]
        if comment.get("resolved", False) != item["resolved"]:
            comment["resolved"] = item["resolved"]
    return f"imported {imported} comments ({created} new)"


def _change(plan, event):
    kind = event["type"]
    byid = {n["id"]: n for n in plan["nodes"]}
    if kind in COMMENT_EVENTS:
        return comment_event(plan, event, byid)[:240]
    if kind in REVIEW_EVENTS:
        return review_event(plan, event, byid)[:240]
    node = None
    if kind not in ("upsert", "set", "resolve", "reply", "approve_prd", "weights_reset"):
        nid = event.get("node")
        if kind not in ("note", "ask", "research") or nid is not None:
            need(isinstance(nid, str) and nid in byid, "node must name an existing node")
            node = byid[nid]
    touched = []
    if kind in BOARD_EVENTS:
        summary, touched = board_event(plan, event, byid, node)
    elif kind == "answer":
        need(node["kind"] == "question" and node["status"] != "killed", "Cannot answer this node")
        choice = event.get("choice")
        if choice == "recommended":
            choice = node["recommended"]
            need(choice is not None, "Question has no recommendation")
        need(choice is None or choice in [o["key"] for o in node["options"]], "Unknown choice")
        need(choice is not None or event.get("text"), "answer requires choice or text")
        node["answer"] = {"choice": choice, "text": event.get("text"),
                          **{key: event[key] for key in ("by", "source", "at", "rev")}}
        node["status"] = "settled"
        touched = [node] + [byid[ref] for ref in node["fills"]]
        for filled in touched:
            filled["status"] = "settled"
        chosen = next((o["label"] for o in node["options"] if o["key"] == choice), event.get("text", ""))
        summary = f"answered {node['id']}: {chosen}"
    elif kind in ("park", "reopen", "strike", "prioritize", "edit_label"):
        if kind == "park":
            need(node["kind"] != "task", "Cannot park a task")
            node["status"] = "parked"
            summary = f"parked {node['id']}"
        elif kind == "reopen":
            need(node["status"] not in ("open", "todo"), "Node is already open")
            node["status"] = "todo" if node["kind"] == "task" else "open"
            if node["kind"] == "question":
                node["answer"] = None
            if node["kind"] == "idea":
                node["kill_reason"] = ""
            summary = f"reopened {node['id']}"
        elif kind == "strike":
            need(node["kind"] == "assumption", "Only assumptions can be struck")
            node["status"] = "killed"
            summary = f"struck {node['id']}"
        elif kind == "prioritize":
            need(node["kind"] == "question" and node["status"] == "open", "Only open questions can be prioritized")
            node["priority"] = max((n["priority"] for n in plan["nodes"] if n["kind"] == "question"), default=0) + 1
            summary = f"prioritized {node['id']}"
        else:
            node["label"] = text(event.get("label"), "label", 120, line=True)
            summary = f"renamed {node['id']}: {node['label']}"
        touched = [node]
    elif kind in ("note", "ask", "expand"):
        if kind in ("note", "ask"):
            need(event.get("text"), f"{kind} requires text")
        lane = event.get("lane")
        need(lane is None or lane in LANES, "Invalid request lane")
        plan["requests"].append({"ref": event["id"], "type": kind, "node": event.get("node"), "lane": lane,
                                 "text": event.get("text", ""), "at": event["at"]})
        if kind == "ask":
            if node is not None:
                add_thread(node, "user", event["text"], event["at"], event["id"])
            else:
                add_plan_thread(plan, "user", event["text"], event["at"], event["id"])
        where = event.get("node") or lane or "plan"
        summary = {"note": f"note on {where}", "ask": f"asked about {where}", "expand": f"expand {where}"}[kind]
    elif kind == "approve_prd":
        need(plan["stage"] == "shape", "PRD approval requires stage shape")
        findings = lint.lint(plan)
        if any(f["severity"] == "block" for f in findings):
            raise PlanError("PRD has blocking lint findings", 4, findings)
        plan["stage"] = "ready"
        plan["approved"] = {"at": event["at"], "rev": event["rev"]}
        summary = "approved PRD"
    elif kind == "upsert":
        patch = event.get("node")
        need(isinstance(patch, dict), "upsert node must be an object")
        need("answer" not in patch, "Only answer/reopen may set a question answer")
        need("thread" not in patch, "A thread is written only by ask/reply events")
        nid = patch.get("id")
        need(nid is None or isinstance(nid, str), "Invalid node id")
        old = byid.get(nid)
        node_kind = patch.get("kind", old["kind"] if old else None)
        need(isinstance(node_kind, str) and node_kind in KINDS, "upsert requires a known kind")
        need(old is None or node_kind == old["kind"], "Cannot change node kind")
        prefix, width, extra = KINDS[node_kind]
        if nid is None:
            number = max((int(n["id"][len(prefix):]) for n in plan["nodes"] if n["kind"] == node_kind), default=0) + 1
            nid = prefix + str(number).zfill(width)
        node = old if old is not None else copy.deepcopy(dict(COMMON, **extra))
        node.update({key: value.strip() if isinstance(value, str) else copy.deepcopy(value)
                     for key, value in patch.items() if key not in ("rev", "by")})
        node.update(id=nid, kind=node_kind)
        if node_kind == "research" and (old is None or "scope" in patch or "targets" in patch):
            need(str_list(node["targets"]), "Research targets must be a list of idea ids")
            count, scope = len(node["targets"]), node["scope"]
            need(scope != "idea" or count == 1, "An idea research job needs exactly one idea in targets")
            need(scope != "shortlist" or count >= 1, "A shortlist research job needs at least one idea in targets")
        if old is None:
            if "status" not in patch and node_kind == "task":
                node["status"] = "todo"
            plan["nodes"].append(node)
        touched = [node]
        summary = f"updated {nid}" if old is not None else f"added {nid}: {node['label']}"
        # The stored event retains the object, including the assigned id, for a useful audit trail.
        event["node"]["id"] = nid
    elif kind == "remove":
        plan["nodes"].remove(node)
        nid = node["id"]
        for other in plan["nodes"]:
            before = copy.deepcopy(other)
            for field in ("depends_on", "refs", "fills", "merged_from", "targets"):
                if field in other:
                    other[field] = [ref for ref in other[field] if ref != nid]
            for field in ("goal", "slice", "merged_into"):
                if other.get(field) == nid:
                    other[field] = None
            for field in ("scores", "gates"):
                other.get(field, {}).pop(nid, None)
            if other != before:
                touched.append(other)
        for request in plan["requests"]:
            if request["node"] == nid:
                if request["type"] == "ask":  # the node's thread goes with it: keep the user's question where a reply can land
                    add_plan_thread(plan, "user", request["text"], request["at"], request["ref"])
                request["node"] = None
        for comment in plan.get("comments", []):
            if comment["anchor"] == nid:
                comment["anchor"] = None
        for entry in plan.get("thread", []):
            entry["links"] = [ref for ref in entry["links"] if ref != nid]
        summary = f"removed {nid}"
    elif kind == "set":
        field = event.get("field")
        need(field in ("title", "tldr", "stage", "size", "owner", "repo", "published") and "value" in event, "Invalid set field/value")
        value = event["value"]
        if field == "stage":
            need(value in QSTAGES or (value == "building" and plan["stage"] == "ready")
                 or (value == "shipped" and plan["stage"] == "building"), "Invalid stage transition")
            if value in QSTAGES:
                plan["approved"] = None
        elif field in ("title", "owner", "tldr"):
            value = text(value, field, empty=field == "tldr")
        elif field == "size":
            need(value in SIZES, "Invalid size")
        else:
            need(absolute_or_null(value), "repo/published must be absolute or null")
        plan[field] = value
        summary = f"set {field} to {value}"
    elif kind == "resolve":
        ref = event.get("ref")
        need(isinstance(ref, str) and any(r["ref"] == ref for r in plan["requests"]), "Unknown request ref")
        need(all(r["type"] != "comment" for r in plan["requests"] if r["ref"] == ref),
             "A comment is triaged, split or deleted, not resolved")
        plan["requests"] = [r for r in plan["requests"] if r["ref"] != ref]
        summary = f"resolved {ref}"
    elif kind == "reply":
        ref = event.get("ref")
        request = next((r for r in plan["requests"] if r["ref"] == ref), None)
        need(request is not None and request["type"] == "ask", "ref must name an open ask request")
        need(isinstance(event.get("text"), str) and event["text"].strip(), "reply requires text")
        if request["node"] is None:  # a plan-level ask, or one whose node was removed: the plan thread holds the conversation
            links = event.get("links", [])
            need(str_list(links) and len(links) <= LINK_LIMIT, f"links must be a list of at most {LINK_LIMIT} node or comment ids")
            known = byid.keys() | {c["id"] for c in plan.get("comments", [])}
            need(all(link in known for link in links), "links must name existing nodes or comments")
            add_plan_thread(plan, "session", event["text"], event["at"], ref, links)
            summary = "replied on plan"
        else:
            need("links" not in event, "links apply only to a plan-level reply")
            add_thread(byid[request["node"]], "session", event["text"], event["at"], ref)
            summary = f"replied on {request['node']}"
        plan["requests"].remove(request)
    else:  # task_status
        need(node["kind"] == "task" and event.get("status") in TASK_STATUSES, "Invalid task/status")
        node["status"] = event["status"]
        if "ok" in event:
            need(type(event["ok"]) is bool, "ok must be a boolean")
            node["result"] = {"ok": event["ok"], "at": event["at"], "note": event.get("note", "")}
        touched = [node]
        summary = f"{node['id']}: {node['status']}"
    for changed in touched:
        changed.update(rev=event["rev"], by=event["by"])
    return summary[:240]


def apply_event(plan: dict, event: dict) -> str:
    """Validate against a copy. On error neither the plan nor the event is mutated.

    On success the event also receives its generated envelope for the audit writer.
    """
    validate(plan)
    need(isinstance(event, dict), "Event must be an object")
    kind = event.get("type")
    need(isinstance(kind, str) and kind in EVENT_FIELDS, "Unknown event type")
    allowed = set(EVENT_FIELDS[kind]) | {"type", "v", "id", "at", "by", "source", "rev"}
    need(set(event) <= allowed, "Unknown event fields")
    applied = copy.deepcopy(event)
    by, source = applied.get("by", "session"), applied.get("source", "terminal")
    need(by in ("user", "session") and source in ("page", "terminal", "build"), "Invalid event by/source")
    need(kind not in SESSION_EVENTS or by == "session", "Session event requires --by session")
    for field in ("text", "label", "note"):
        if field in applied:
            applied[field] = text(applied[field], field, 120 if field == "label" else COMMENT_TEXT_LIMIT if kind == "comment" else 2000,
                                  empty=kind in ("comment_triage", "comment_rework"), line=field == "label")
    applied.update(v=1, id="e-" + secrets.token_hex(6), at=utcnow(), by=by, source=source, rev=plan["rev"] + 1)
    candidate = copy.deepcopy(plan)
    summary = _change(candidate, applied)
    candidate.update(rev=applied["rev"], updated=applied["at"])
    validate(candidate, strict=True)
    derive(candidate)
    nid = applied.get("node")
    if isinstance(nid, dict):
        nid = nid["id"]
    recent = {key: applied[key] for key in ("rev", "at", "by", "source", "type")}
    recent.update(node=nid, summary=summary)
    candidate["recent"] = [recent] + candidate["recent"][:29]
    validate(candidate, strict=True)
    need(len(json_text(candidate).encode("utf-8")) <= MAX_PLAN_BYTES, "plan.json exceeds 2 MB")
    plan.clear()
    plan.update(candidate)
    event.clear()
    event.update(applied)
    return summary


def json_text(value):
    return json.dumps(value, ensure_ascii=False, indent=2, allow_nan=False) + "\n"


@contextmanager
def locked(directory):
    with (directory / ".lock").open("a", encoding="utf-8") as handle:
        fcntl.flock(handle.fileno(), fcntl.LOCK_EX)
        try:
            yield
        finally:
            fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def stage(path, content):
    """Write content to path's .tmp sibling and return it, ready for os.replace."""
    temporary = path.with_name(path.name + ".tmp")
    try:
        with temporary.open("w", encoding="utf-8") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
    except BaseException:
        temporary.unlink(missing_ok=True)
        raise
    return temporary


def atomic_write(path, content):
    temporary = stage(path, content)
    try:
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def mirror_dir(plan):
    if plan["published"] is None:
        return None
    mirror = Path(plan["published"])
    try:
        mirror.mkdir(parents=True, exist_ok=True)
        need(mirror.is_dir(), "Published path must be a directory")
    except OSError as exc:
        raise PlanError(f"Cannot create published directory: {exc}") from exc
    return mirror


def public_plan(plan):
    """The plan as the published mirror shows it: no comments, plan thread or review PR, no comment or review requests (contract 1, 13, 14)."""
    shown = {key: value for key, value in plan.items() if key not in OPTIONAL_TOP_KEYS}
    shown["requests"] = [r for r in plan["requests"] if r["type"] not in ("comment", "review")]
    return shown


def review_plan(plan):
    """What the review PR shows: public_plan minus what is private to this machine or this owner (contract 14.4).
    No repo or published path, owner, requests or chat threads, and the trail names a private field without its value."""
    shown = public_plan(plan)
    for key in ("repo", "published", "owner", "requests"):
        del shown[key]
    shown["nodes"] = [{key: value for key, value in node.items() if key != "thread"} for node in shown["nodes"]]
    shown["recent"] = [dict(entry, summary=re.sub(r"^(set (?:repo|published|owner)) to .*$", r"\1", entry["summary"], flags=re.S))
                       for entry in shown["recent"]]
    return shown


def write_projection(directory, plan, rendered=None):
    """Caller holds the task lock. Every temp file is written before any is renamed, so a failed write changes nothing; working plan.json is renamed last."""
    rendered = prd.render(plan) if rendered is None else rendered
    encoded = json_text(plan)
    files = [(directory / "PRD.md", rendered)]
    mirror = mirror_dir(plan)
    if mirror is not None and mirror.resolve() != directory.resolve():  # a mirror in the plan dir itself is the working copy
        files += [(mirror / "PRD.md", rendered), (mirror / "plan.json", json_text(public_plan(plan)))]
    files.append((directory / "plan.json", encoded))
    staged = []
    try:
        for path, content in files:
            staged.append((stage(path, content), path))
        for temporary, path in staged:
            os.replace(temporary, path)
    finally:
        for temporary, _ in staged:
            temporary.unlink(missing_ok=True)


def audit_events(directory):
    path = directory / "events.jsonl"
    if not path.exists():
        return []
    try:
        # Split on "\n" only: splitlines() also cuts at U+2028, VT, FF, NEL inside a JSON string.
        lines = path.read_text(encoding="utf-8").split("\n")
        events = [loads(line) for line in (lines[:-1] if lines[-1] == "" else lines)]
    except (ValueError, UnicodeError) as exc:
        raise PlanError(f"Invalid events.jsonl: {exc}") from exc
    need(all(isinstance(event, dict) for event in events), "Invalid events.jsonl: every line must be an object")
    return events


def check_writable(directory, plan):
    """Fail before the audit append if any projection destination cannot take its files."""
    targets = [directory]
    mirror = mirror_dir(plan)
    if mirror is not None:
        targets.append(mirror)
    for target in targets:
        for name in ("PRD.md", "plan.json"):
            need(not (target / name).is_dir(), f"{target / name} is a directory")
        try:
            tempfile.NamedTemporaryFile(dir=target).close()
        except OSError as exc:
            raise PlanError(f"Cannot write to {target}: {exc}") from exc


def send_event(task_id, event):
    directory = plan_dir(task_id)
    with locked(directory):
        plan = load(task_id)
        events = audit_events(directory)
        need(not events or (isinstance(events[-1], dict) and is_int(events[-1].get("rev"))), "Invalid audit event rev")
        need(not events or events[-1]["rev"] <= plan["rev"], "events.jsonl is ahead of plan.json, manual recovery required")
        summary = apply_event(plan, event)
        check_writable(directory, plan)
        rendered = prd.render(plan)
        audit = directory / "events.jsonl"
        size = audit.stat().st_size if audit.exists() else 0
        try:
            with audit.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps(event, ensure_ascii=False, allow_nan=False) + "\n")
                handle.flush()
                os.fsync(handle.fileno())
            write_projection(directory, plan, rendered)
        except BaseException:
            # A failed projection must not leave the audit ahead of plan.json: that would refuse every later event.
            os.truncate(audit, size)
            raise
    return {"ok": True, "rev": plan["rev"], "event": event, "summary": summary}


def initialize(task_id, title, size="standard", repo=None, owner=None):
    directory = task_path(task_id)
    title = text(title, "title")
    need(size in SIZES, "Invalid size")
    need(absolute_or_null(repo), "repo must be absolute")
    directory.mkdir(parents=True, exist_ok=True)
    with locked(directory):
        need(not (directory / "plan.json").exists(), "A plan already exists")
        now = utcnow()
        seeds = json.loads(Path(__file__).with_name("seeds.json").read_text(encoding="utf-8"))[size]
        nodes = []
        for seed in seeds:
            node = copy.deepcopy(dict(COMMON, **KINDS[seed["kind"]][2]))
            node.update(seed, rev=0, by="session")
            nodes.append(node)
        plan = {"schema": 1, "id": task_id, "slug": re.sub(r"^\d{4}-", "", task_id), "title": title,
                "owner": owner if owner is not None else getpass.getuser(), "size": size, "stage": "frame", "rev": 0,
                "created": now, "updated": now, "repo": repo, "published": None, "approved": None, "tldr": "",
                "frontier": [], "progress": {"settled": 0, "total": 0}, "requests": [], "recent": [], "nodes": nodes}
        derive(plan)
        validate(plan, strict=True)
        (directory / "events.jsonl").touch()
        write_projection(directory, plan)
    return directory


def merge_news(event):
    """A merge as the session sees it (ideate.md 3): node is the draft, merged_from its parents. The audit line keeps the page's node/other."""
    if event.get("type") != "merge" or "draft" not in event:
        return event
    seen = {key: value for key, value in event.items() if key not in ("node", "other", "draft")}
    return dict(seen, node=event["draft"], merged_from=[event["node"], event["other"]])


def news(task_id, peek=False):
    directory = plan_dir(task_id)
    with locked(directory):
        load(task_id)
        events = audit_events(directory)
        cursor_path = directory / "session.cursor"
        try:
            cursor = int(cursor_path.read_text(encoding="utf-8")) if cursor_path.exists() else 0
        except ValueError as exc:
            raise PlanError("Invalid session.cursor") from exc
        need(0 <= cursor <= len(events), "session.cursor is outside the audit log")
        result = [event for event in events[cursor:]
                  if (event.get("by") == "user" and event.get("source") == "page")
                  or (event.get("type") == "research_status" and event.get("state") in ("done", "failed"))]
        if not peek:
            atomic_write(cursor_path, str(len(events)) + "\n")
        return [merge_news(event) for event in result]


def render_plan(task_id):
    directory = plan_dir(task_id)
    with locked(directory):
        plan = load(task_id)
        derive(plan)
        write_projection(directory, plan)
    paths = [directory / "PRD.md"]
    if plan["published"] is not None:
        paths.extend([Path(plan["published"]) / "PRD.md", Path(plan["published"]) / "plan.json"])
    return paths
