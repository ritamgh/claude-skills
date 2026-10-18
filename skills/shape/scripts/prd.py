"""Pure, deterministic PRD projection of plan.json (contract section 8)."""
import re

# Title, Pending intent, source kinds. The section number is the tuple index.
SECTIONS = (
    ("Header", "", ()),
    ("TL;DR", "Three sentences: who, problem, outcome", ()),
    ("Problem & evidence", "One concrete story and how we know", ("story",)),
    ("Users & context", "Who it is for and where they work", ("user",)),
    ("Goals & success criteria", "Goals with measurable success criteria", ("goal", "criterion")),
    ("Non-goals", "What we will not do, and why", ("nongoal",)),
    ("Appetite & constraints", "Time budget and hard limits", ("constraint",)),
    ("Assumptions", "What we believe but have not checked", ("assumption",)),
    ("Slices", "Vertical slices, walking skeleton first", ("slice",)),
    ("Requirements", "What the system must do", ("requirement",)),
    ("Edge cases", "Expected behaviour at the edges", ("edge",)),
    ("Risks & rabbit holes", "What could sink it and the pre-decided way round", ("risk",)),
    ("Technical approach", "Architecture and alternatives considered", ("approach",)),
    ("Agent boundaries", "What agents always do, ask first, never do", ("boundary",)),
    ("Open questions", "", ("question",)),
    ("Task map", "Tasks with a runnable check each", ("task",)),
    ("Milestones", "An exit criterion per slice", ("slice",)),
    ("Decision log", "Decisions and why", ("decision",)),
    ("Progress & discoveries", "", ("discovery",)),
)
TIERS = ("always", "ask", "never", "command")
TIER_TITLES = ("Always", "Ask first", "Never", "Commands")
DETAILS = {
    "story": (("evidence", "Evidence"),),
    "user": (("context", "Context"),),
    "criterion": (("verify", "Verify"), ("evidence", "Evidence")),
    "nongoal": (("why", "Why"),),
    "constraint": (("tag", "Tag"),),
    "assumption": (("validate_by", "Validate by"), ("impact", "Impact")),
    "slice": (("why_priority", "Why this priority"), ("independent_test", "Independent test")),
    "edge": (("expect", "Expected behaviour"),),
    "risk": (("approach", "Approach"),),
    "approach": (("alternatives", "Alternatives"),),
    "question": (("why", "Why"),),
    "decision": (("chose", "Chose"), ("alternatives", "Alternatives"), ("why", "Why")),
    "discovery": (("evidence", "Evidence"),),
}


def _visible(node):
    kind, status = node["kind"], node["status"]
    if kind == "question":
        return status in ("open", "parked")
    if kind == "assumption":
        return status in ("open", "settled", "killed")
    if kind == "task":
        return True
    return status in ("settled", "parked")


def _order(node):
    """Explicit kind-specific keys, then numeric id to break ties deterministically."""
    kind = node["kind"]
    primary = 0
    if kind == "slice":
        primary = node.get("order", 0)
    elif kind == "constraint":
        primary = int(node.get("tag") != "appetite")
    elif kind == "requirement":
        primary = int(node.get("nfr", False))
    elif kind == "boundary":
        primary = TIERS.index(node["tier"])
    return kind, primary, int(re.search(r"\d+", node["id"]).group()), node["id"]


def _section_nodes(plan, number):
    kinds = SECTIONS[number][2]
    return sorted((node for node in plan["nodes"]
                   if node["kind"] in kinds and _visible(node)
                   and (number != 16 or node.get("exit", ""))), key=_order)


def section_has_content(plan: dict, number: int) -> bool:
    """Whether this section renders something other than Pending, shared with lint."""
    if number in (0, 14, 18):
        return True
    if number == 1:
        return bool(plan.get("tldr", "").strip())
    return bool(_section_nodes(plan, number))


def _label(node, open_questions):
    text = f"**{node['id']}** {node['label']}"
    if node["kind"] == "assumption" and node["status"] == "killed":
        text = f"~~{node['id']} {node['label']}~~ (killed)"
    for dependency in node.get("depends_on", []):
        if dependency in open_questions:
            text += f" [NEEDS CLARIFICATION: {dependency}]"
    if node["status"] == "parked":
        text += " (parked)"
    if node["kind"] == "assumption" and node["status"] in ("open", "settled"):
        text += " (unvalidated)" if node["status"] == "open" else " (validated)"
    if node["kind"] in ("assumption", "decision", "constraint") and node.get("by_default"):
        text += " (default)"
    return text


def _node_lines(node, open_questions, indent=""):
    lines = [indent + "- " + _label(node, open_questions)]
    if node.get("body"):
        lines.extend(indent + "  " + line for line in node["body"].splitlines())
    for field, title in DETAILS.get(node["kind"], ()):
        value = node.get(field)
        if value:
            if isinstance(value, list):
                lines.append(indent + f"  - {title}:")
                for item in value:
                    lines.extend(indent + "    " + line for line in ("- " + item).splitlines())
            else:
                lines.extend(indent + "  " + line for line in (f"- {title}: {value}").splitlines())
    if node.get("refs"):
        lines.append(indent + "  - Refs: " + ", ".join(node["refs"]))
    if node["kind"] == "slice":
        for scenario in node.get("scenarios", []):
            lines.extend(indent + "  " + line for line in ("- " + scenario).splitlines())
    if node["kind"] == "question":
        if node.get("blocking"):
            lines.append(indent + "  - Blocking: yes")
        for option in node.get("options", []):
            recommended = " (recommended)" if option["key"] == node.get("recommended") else ""
            why = ": " + option["why"] if option.get("why") else ""
            lines.append(indent + f"  - {option['key']}. {option['label']}{recommended}{why}")
    return lines


def _header(plan):
    lines = [f"**Title:** {plan['title']}"]
    for field in ("owner", "size", "stage", "rev", "updated"):
        lines.append(f"- {field.capitalize()}: {plan[field]}")
    approved = plan.get("approved")
    if approved:
        approval = f"Approved at rev {approved['rev']}"
        # Build progress (task status, discoveries) and the Ideate/Research board never render here, so they are not a change to the approved spec.
        if any(node["rev"] > approved["rev"] for node in plan["nodes"]
               if node["kind"] not in ("task", "discovery", "idea", "rubric", "research")):
            approval += f"; changed since (rev {plan['rev']})"
        lines.append(f"- {approval}")
        lines.append(f"- Approved at: {approved['at']}")
    else:
        lines.append("- Approved: no")
    return lines


def _cell(value):
    return str(value).replace("|", "\\|").replace("\r\n", "\n").replace("\r", "\n").replace("\n", "<br>")


def _check_cell(check):
    """One code span per line, joined by <br>; the delimiter is longer than any backtick run inside."""
    spans = []
    for line in check.splitlines():
        if line.strip():
            fence = "`" * (max(map(len, re.findall(r"`+", line)), default=0) + 1)
            pad = " " if line.startswith("`") or line.endswith("`") else ""
            escaped = line.replace("|", "\\|")
            spans.append(f"{fence}{pad}{escaped}{pad}{fence}")
    return "<br>".join(spans)


def _tasks(nodes, open_questions):
    lines = ["| id | slice | covers | files | depends on | P | check | status |",
             "|---|---|---|---|---|---|---|---|"]
    for node in nodes:
        cells = [_label(node, open_questions), node.get("slice") or "", ", ".join(node.get("refs", [])),
                 ", ".join(node.get("files", [])), ", ".join(node.get("depends_on", [])),
                 "P" if node.get("parallel") else ""]
        row = [_cell(cell) for cell in cells] + [_check_cell(node.get("check", "")), _cell(node["status"])]
        lines.append("| " + " | ".join(row) + " |")
    return lines


def _content(plan, number, open_questions):
    nodes = _section_nodes(plan, number)
    if number == 0:
        return _header(plan)
    if number == 1:
        # A tldr line starting with '#' would become a heading (or fake a section heading).
        return [("\\" + line.lstrip() if line.lstrip().startswith("#") else line)
                for line in plan["tldr"].strip().splitlines()]
    if number == 4:
        lines = []
        goals = [node for node in nodes if node["kind"] == "goal"]
        criteria = [node for node in nodes if node["kind"] == "criterion"]
        for goal in goals:
            lines.extend(_node_lines(goal, open_questions))
            for criterion in criteria:
                if criterion.get("goal") == goal["id"]:
                    lines.extend(_node_lines(criterion, open_questions, "  "))
        goal_ids = {node["id"] for node in goals}
        for criterion in criteria:
            if criterion.get("goal") not in goal_ids:
                lines.extend(_node_lines(criterion, open_questions))
                if criterion.get("goal"):
                    lines.append("  - Goal: " + criterion["goal"])
        return lines
    if number == 13:
        lines = []
        for tier, title in zip(TIERS, TIER_TITLES):
            group = [node for node in nodes if node["tier"] == tier]
            if group:
                if lines:
                    lines.append("")
                lines.extend([f"### {title}", ""])
                for node in group:
                    lines.extend(_node_lines(node, open_questions))
        return lines
    if number == 14 and not nodes:
        return ["None."]
    if number == 15:
        return _tasks(nodes, open_questions)
    if number == 16:
        lines = []
        for node in nodes:
            lines.append("- " + _label(node, open_questions))
            lines.extend("  " + line for line in node["exit"].splitlines())
        return lines
    lines = []
    if number == 18:
        tasks = [node for node in plan["nodes"] if node["kind"] == "task"]
        if tasks:
            counts = [f"{status} {sum(node['status'] == status for node in tasks)}"
                      for status in ("todo", "doing", "done", "failed")]
            lines.append("Tasks: " + ", ".join(counts) + ".")
            if nodes:
                lines.append("")
        if not tasks and not nodes:
            return ["Nothing yet."]
    for node in nodes:
        lines.extend(_node_lines(node, open_questions))
    return lines


def render(plan: dict) -> str:
    open_questions = {node["id"] for node in plan["nodes"]
                      if node["kind"] == "question" and node["status"] == "open"}
    blocks = [f"<!-- Generated from plan.json rev {plan['rev']} by `plan render`. Do not edit: change the plan. -->"]
    for number, (title, intent, _) in enumerate(SECTIONS):
        lines = _content(plan, number, open_questions) if section_has_content(plan, number) else [f"> Pending: {intent}"]
        blocks.append(f"## {number}. {title}\n\n" + "\n".join(lines))
    return "\n\n".join(blocks) + "\n"
