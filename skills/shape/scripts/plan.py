#!/usr/bin/env python3
"""The plan CLI. JSON is the stable machine interface, text is for the terminal."""
import argparse
import json
import sys
import unicodedata

import export as exporter
import plan_core as core


def parser():
    root = argparse.ArgumentParser(prog="plan")
    commands = root.add_subparsers(dest="command", required=True)
    init = commands.add_parser("init")
    init.add_argument("task")
    init.add_argument("--title", required=True)
    init.add_argument("--size", choices=core.SIZES, default="standard")
    init.add_argument("--repo")
    init.add_argument("--owner")
    event = commands.add_parser("event")
    event.add_argument("task")
    event.add_argument("--by", choices=("user", "session"), default="session")
    event.add_argument("--source", choices=("page", "terminal", "build"), default="terminal")
    event.add_argument("--json", dest="event_json")
    event.add_argument("stdin", nargs="?", choices=("-",))
    for name in ("show", "frontier", "news", "lint", "list"):
        sub = commands.add_parser(name)
        if name != "list":
            sub.add_argument("task")
        sub.add_argument("--json", action="store_true")
        if name == "frontier":
            sub.add_argument("-n", type=int)
        if name == "news":
            sub.add_argument("--peek", action="store_true")
    for name in ("render", "path", "publish"):
        sub = commands.add_parser(name)
        sub.add_argument("task")
        if name == "publish":
            sub.add_argument("--to", required=True)
    export = commands.add_parser("export")
    export.add_argument("task")
    export.add_argument("--to", required=True, choices=("crew", "orchestrate"))
    export.add_argument("--markdown", action="store_true")
    return root


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False))


def say(line=""):
    """Human output is one line per print: stored text must not add lines or terminal escapes."""
    print("".join(" " if unicodedata.category(c) in ("Cc", "Cf", "Zl", "Zp") else c for c in str(line)))


def ranked(plan, limit=None):
    nodes = {n["id"]: n for n in plan["nodes"]}
    ids = core.frontier(plan)
    if limit is not None:
        core.need(limit >= 0, "-n must be nonnegative")
        ids = ids[:limit]
    fields = ("id", "label", "why", "options", "recommended")
    return [{key: nodes[nid][key] for key in fields} for nid in ids]


def question_text(question):
    options = question["options"]
    recommendation = next((o["label"] for o in options if o["key"] == question["recommended"]), None)
    suffix = f" [recommended: {recommendation}]" if recommendation else ""
    return f"{question['id']}: {question['label']}{suffix}"


def run(args):
    command = args.command
    if command == "init":
        print(core.initialize(args.task, args.title, args.size, args.repo, args.owner))
    elif command == "event":
        core.need((args.event_json is None) != (args.stdin is None), "Use exactly one of --json OBJ or -")
        try:
            event = core.loads(sys.stdin.read() if args.stdin else args.event_json)
        except (ValueError, UnicodeError) as exc:
            raise core.PlanError(f"Invalid event JSON: {exc}") from exc
        core.need(isinstance(event, dict), "Event must be an object")
        event.update(by=args.by, source=args.source)
        emit(core.send_event(args.task, event))
    elif command == "publish":
        core.need(isinstance(args.to, str) and args.to.startswith("/"), "Publish directory must be absolute")
        core.send_event(args.task, {"type": "set", "field": "published", "value": args.to,
                                    "by": "session", "source": "terminal"})
        print(args.to + "/PRD.md")
        print(args.to + "/plan.json")
    elif command == "list":
        rows = []
        directory = core.crew_root()
        if directory.is_dir():
            for path in sorted(directory.iterdir()):
                if (path / "plan/plan.json").is_file():
                    plan = core.load(path.name)
                    rows.append({key: plan[key] for key in ("id", "title", "stage", "rev", "progress", "updated")})
        if args.json:
            emit(rows)
        else:
            for row in rows:
                say(f"{row['id']}  {row['title']}  {row['stage']}  rev {row['rev']}  {row['progress']['settled']}/{row['progress']['total']}")
    elif command == "news":
        events = core.news(args.task, args.peek)
        if args.json:
            emit(events)
        else:
            for event in events:
                if event["type"] == "merge" and "merged_from" in event:
                    say(f"rev {event['rev']} merge {' + '.join(event['merged_from'])} \u2192 draft {event['node']}")
                    continue
                details = event.get("text") or event.get("label") or event.get("choice") or event.get("state") or ""
                say(f"rev {event['rev']} {event['type']} {event.get('node') or ''} {details}".rstrip())
    elif command == "render":
        for path in core.render_plan(args.task):
            print(path)
    else:
        plan = core.load(args.task)
        if command == "path":
            print(core.plan_dir(args.task))
        elif command == "export":
            core.need(plan["stage"] in ("ready", "building"), f"Plan is at stage {plan['stage']}; export needs ready or building")
            core.need(args.to == "orchestrate" or not args.markdown, "--markdown works only with --to orchestrate")
            result = (exporter.to_crew if args.to == "crew" else exporter.to_orchestrate)(plan, core.plan_dir(args.task))
            if args.markdown:
                sys.stdout.write(exporter.orchestrate_markdown(result))
            else:
                emit(result)
        elif command == "show":
            if args.json:
                emit(plan)
            else:
                say(plan["title"])
                say(f"Stage: {plan['stage']}  Rev: {plan['rev']}")
                say(f"Progress: {plan['progress']['settled']}/{plan['progress']['total']}")
                say("Frontier:")
                for question in ranked(plan, 3):
                    say(question_text(question))
                say("Open requests:")
                for request in plan["requests"]:
                    say(f"{request['ref']} {request['type']} {request['node'] or request['lane'] or 'plan'}: {request['text']}")
        elif command == "frontier":
            questions = ranked(plan, args.n)
            if args.json:
                emit(questions)
            else:
                for question in questions:
                    say(question_text(question))
                    say("  " + question["why"])
        elif command == "lint":
            findings = core.lint.lint(plan)
            if args.json:
                emit(findings)
            else:
                for finding in findings:
                    print(f"{finding['severity']} {finding['rule']} {finding['node'] or ''}: {finding['message']}")
            return 1 if any(f["severity"] == "block" for f in findings) else 0
    return 0


def main(argv=None):
    args = parser().parse_args(argv)
    try:
        return run(args)
    except core.PlanError as exc:
        if exc.code == 4:
            emit({"ok": False, "lint": exc.findings})
        else:
            print(str(exc), file=sys.stderr)
        return exc.code
    except (OSError, UnicodeError) as exc:
        print(str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
