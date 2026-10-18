#!/usr/bin/env python3
"""Add the Ask panel to an HTML report: inlines assets/ask-panel.css and ask-panel.js before </body>.

  python3 inject.py REPORT.html [-o OUT.html]     (without -o the file is changed in place)

Injecting twice is a no-op (a marker comment is the check). A page that already has its own lens Ask
(it calls /__lens/ask) is left alone.
"""
import argparse, re, sys
from pathlib import Path

BEGIN, END = "<!-- ask-panel:begin -->", "<!-- ask-panel:end -->"
ASSETS = Path(__file__).resolve().parent.parent / "assets"


def inject(page):
    if BEGIN in page or "/__lens/ask" in page:
        return page
    css = (ASSETS / "ask-panel.css").read_text(encoding="utf-8")
    js = (ASSETS / "ask-panel.js").read_text(encoding="utf-8").replace("</script", "<\\/script")
    block = f"{BEGIN}\n<style>\n{css}</style>\n<script>\n{js}</script>\n{END}\n"
    closes = list(re.finditer(r"</body\s*>", page, re.I))
    at = closes[-1].start() if closes else len(page)
    return page[:at] + block + page[at:]


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("page", help="the HTML report")
    ap.add_argument("-o", "--out", help="write here instead of changing the report in place")
    a = ap.parse_args()
    src = Path(a.page)
    if not src.is_file():
        sys.exit(f"no such file: {src}")
    page = src.read_text(encoding="utf-8")
    done = inject(page)
    if "/__lens/ask" in page and BEGIN not in page:
        print("skipped: this page already has its own Ask (lens)", file=sys.stderr)
    out = Path(a.out) if a.out else src
    if done != page or out != src:
        out.write_text(done, encoding="utf-8")


if __name__ == "__main__":
    main()
