"""Readiness checks on loaded plan dicts, per contract section 9."""
import re

import prd

MANDATORY: dict[str, list[int]] = {
    "quick": [0, 1, 2, 4, 5, 8, 13, 15],
    "standard": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 11, 12, 13, 15, 16],
    "deep": [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 16, 17],
}
VAGUE = re.compile(r"\b(fast|slow|scalable|easy|simple|intuitive|robust|user-friendly|efficient|seamless|quickly)\b", re.I)


def lint(plan: dict) -> list[dict]:
    findings = []

    def add(rule, node, section, message, severity="block"):
        findings.append({"rule": rule, "severity": severity, "node": node,
                         "section": section, "message": message})

    for section in MANDATORY[plan["size"]]:
        if not prd.section_has_content(plan, section):
            add("empty-section", None, section, f"Section {section} renders as Pending.")

    nodes = plan["nodes"]
    tasks = [node for node in nodes if node["kind"] == "task"]
    task_refs = {ref for task in tasks for ref in task.get("refs", [])}
    scenario_refs = {ref for node in nodes if node["kind"] == "slice" and node["status"] == "settled"
                     and any(scenario.strip() for scenario in node.get("scenarios", []))
                     for ref in node.get("refs", [])}
    for node in nodes:
        kind, status, node_id = node["kind"], node["status"], node["id"]
        if kind == "question":
            if node.get("blocking") and status in ("open", "parked"):
                add("blocking-question", node_id, 14, "Blocking question is unresolved.")
            elif not node.get("blocking") and status == "open":
                add("open-question", node_id, 14, "Non-blocking question is still open.", "warn")
        if kind == "requirement" and status == "settled" and not node.get("nfr") and node_id not in scenario_refs:
            add("fr-no-scenario", node_id, 9, "FR has no scenario in a settled slice citing it.")
        if kind in ("requirement", "criterion"):
            section = 9 if kind == "requirement" else 4
            if status == "settled" and node_id not in task_refs:
                add("uncovered", node_id, section, "No task cites this requirement or success criterion.")
            text = node["label"] + " " + node.get("body", "")
            if VAGUE.search(text) and not re.search(r"\d", text):
                add("vague", node_id, section, "Vague wording without a number in the label or body.")
        if kind == "task" and not node.get("check", "").strip():
            add("task-no-check", node_id, 15, "Task has no runnable check.")
        if kind in ("assumption", "decision", "constraint") and node.get("by_default"):
            section = {"assumption": 7, "decision": 17, "constraint": 6}[kind]
            add("default", node_id, section, "Unexamined default: review it once more.", "warn")
    if not any(node["kind"] == "nongoal" and node["status"] == "settled" for node in nodes):
        add("no-nongoals", None, 5, "No settled non-goal defines what is out of scope.")
    return findings
