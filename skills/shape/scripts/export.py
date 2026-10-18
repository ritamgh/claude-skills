"""Hand an approved plan to crew or orchestrate (contract 6.1). Pure functions over the plan dict."""
import re


def nodes_of(plan, kind, status=None):
    return [n for n in plan["nodes"] if n["kind"] == kind and (status is None or n["status"] == status)]


def prd_path(plan, directory):
    return f"{plan['published']}/PRD.md" if plan["published"] else str(directory / "PRD.md")


def rules(plan):
    never = [n["label"] for n in nodes_of(plan, "boundary", "settled") if n["tier"] == "never"]
    return never + ["Non-goal: " + n["label"] for n in nodes_of(plan, "nongoal", "settled")]


def open_tasks(plan):
    return [n for n in nodes_of(plan, "task") if n["status"] != "done"]


def first_sentence(text):
    return re.split(r"(?<=[.!?])\s+", text.strip(), maxsplit=1)[0]


def to_crew(plan, plan_dir):
    prd = prd_path(plan, plan_dir)
    rule_lines = ["Rule: " + rule for rule in rules(plan)]
    tasks = []
    for task in open_tasks(plan):
        suffix = "-" + task["id"].lower()
        brief = ["Goal: " + first_sentence(plan["tldr"]),
                 f"PRD: {prd} (cite ids, never paste)",
                 f"Task: {task['id']} {task['label']}",
                 "Covers: " + ", ".join(task["refs"]),
                 "Files: " + ", ".join(task["files"]),
                 "Check: " + task["check"]] + rule_lines
        tasks.append({"id": task["id"], "slug": plan["slug"][:41 - len(suffix)].rstrip("-") + suffix, "title": task["label"],
                      "brief": "\n".join(brief), "check": task["check"], "files": task["files"],
                      "refs": task["refs"]})
    return {"kind": "crew", "prd": prd, "repo": plan["repo"], "tasks": tasks}


def slice_of(plan, task):
    """The first settled slice (by order, then creation) citing the task or one of its refs."""
    wanted = {task["id"], *task["refs"]}
    slices = sorted(enumerate(nodes_of(plan, "slice", "settled")), key=lambda p: (p[1]["order"], p[0]))
    return next((s["id"] for _, s in slices if wanted & set(s["refs"])), None)


def task_deps(task, ids):
    return [dep for dep in task["depends_on"] if dep in ids]


def waves_of(tasks):
    """Levels of the dependency graph among the given tasks, ids ascending within a level."""
    ids = {t["id"] for t in tasks}
    deps = {t["id"]: set(task_deps(t, ids)) for t in tasks}
    level, done, waves = set(ids), set(), []
    while level:
        wave = sorted(i for i in level if deps[i] <= done)
        if not wave:  # a cycle is rejected on write; never loop forever on a hand-edited file
            wave = sorted(level)
        waves.append(wave)
        done.update(wave)
        level.difference_update(wave)
    return waves


def chains_of(tasks, waves):
    """Groups of two or more tasks in one wave that are linked by shared files."""
    files = {t["id"]: set(t["files"]) for t in tasks}
    chains = []
    for wave in waves:
        groups = []
        for tid in wave:
            linked = [g for g in groups if any(files[tid] & files[other] for other in g)]
            merged = [tid] + [other for g in linked for other in g]
            groups = [g for g in groups if g not in linked] + [sorted(merged)]
        chains += sorted(g for g in groups if len(g) > 1)
    return chains


class Orchestrate(dict):
    """The orchestrate export; serialises as a plain dict, remembers its plan id for the Markdown form."""
    plan_id = ""


def to_orchestrate(plan, plan_dir):
    tasks = open_tasks(plan)
    ids = {t["id"] for t in tasks}
    waves = waves_of(tasks)
    export = Orchestrate({
        "kind": "orchestrate", "prd": prd_path(plan, plan_dir), "repo": plan["repo"], "goal": plan["tldr"],
        "success_criteria": [{"id": n["id"], "label": n["label"]} for n in nodes_of(plan, "criterion", "settled")],
        "review_focus": [{"id": n["id"], "label": n["label"]}
                         for n in sorted(nodes_of(plan, "risk", "settled"), key=lambda n: int(n["id"].split("-")[1]))],
        "rules": rules(plan),
        "cards": [{"id": t["id"], "concern": t["label"], "owns": t["files"], "check": t["check"],
                   "depends_on": task_deps(t, ids), "refs": t["refs"], "slice": slice_of(plan, t)} for t in tasks],
        "waves": waves, "chains": chains_of(tasks, waves),
    })
    export.plan_id = plan["id"]
    return export


def orchestrate_markdown(d):
    cell = lambda text: text.replace("|", "\\|")
    lines = [f"Plan: {d.plan_id}", "", "## Goal", d["goal"], "", "Success criteria:"]
    lines += [f"{i}. {c['id']} {c['label']}" for i, c in enumerate(d["success_criteria"], 1)]
    lines += ["", "## Review Focus"]
    lines += [f"{i}. {r['id']} {r['label']}" for i, r in enumerate(d["review_focus"], 1)] or ["None."]
    lines += ["", "## Tasks", "| id | concern | worker | owns | check | status |", "|---|---|---|---|---|---|"]
    lines += [f"| {c['id']} | {cell(c['concern'])} |  | {cell(', '.join(c['owns']))} | {cell(c['check'])} | pending |"
              for c in d["cards"]]
    lines += ["", "## Waves"] + [f"{i}. {', '.join(w)}" for i, w in enumerate(d["waves"], 1)]
    lines += [f"Chained (share files, run in order): {', '.join(c)}" for c in d["chains"]]
    lines += ["", "## Worker rules (from the PRD)"] + ["- " + rule for rule in d["rules"]]
    return "\n".join(lines) + "\n"
