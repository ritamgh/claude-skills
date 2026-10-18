---
name: Lens (zine theme)
description: A friend's hand-made zine about a codebase. Dot-grid paper, black marker ink, three flat highlighters.
colors:
  paper: "#FBF6EA"
  paper-2: "#F3EBD8"
  card: "#FFFDF8"
  ink: "#1B1A17"
  ink-2: "#46413A"
  ink-3: "#6B6458"
  teal: "#1FA898"
  teal-ink: "#0A6B60"
  teal-soft: "#D3F1EC"
  pink: "#FF7EB6"
  pink-ink: "#B21F5C"
  pink-soft: "#FFE0EE"
  yellow: "#FFD84D"
  yellow-ink: "#7A5A00"
  highlight-yellow: "#FFE680"
  highlight-pink: "#FFC3DD"
  highlight-teal: "#BDEDE5"
  sticky: "#FFF3B0"
  token-comment: "#857D70"
  token-string: "#0A6B60"
  token-number: "#A3470F"
  token-keyword: "#B21F5C"
typography:
  display:
    fontFamily: "Permanent Marker, Comic Sans MS, cursive"
    fontSize: "clamp(40px, 4.6vw, 76px)"
    fontWeight: 400
    lineHeight: 1.08
    letterSpacing: "0.005em"
  headline:
    fontFamily: "Permanent Marker, Comic Sans MS, cursive"
    fontSize: "clamp(34px, 3.2vw, 48px)"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "0.01em"
  title:
    fontFamily: "Atkinson Hyperlegible Next, Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "clamp(26px, 2.2vw, 34px)"
    fontWeight: 700
    lineHeight: 1.2
    letterSpacing: "-0.012em"
  body:
    fontFamily: "Atkinson Hyperlegible Next, Atkinson Hyperlegible, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 400
    lineHeight: 1.65
  annotation:
    fontFamily: "Shantell Sans, Comic Sans MS, cursive"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.45
  code:
    fontFamily: "JetBrains Mono, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"
    fontSize: "15.5px"
    fontWeight: 400
    lineHeight: 1.7
rounded:
  wob: "14px 18px 12px 20px / 18px 12px 20px 14px"
  code-card: "16px 22px 14px 24px / 22px 14px 24px 16px"
  map-card: "22px 28px 20px 30px / 28px 20px 30px 22px"
  stamp: "8px 12px 9px 13px"
  chip: "10px"
  inline-code: "5px"
  round: "999px"
spacing:
  gutter: "48px"
  gutter-narrow: "16px"
  rail: "220px"
  side-column: "300px"
  section-gap: "96px"
  stop-gap: "84px"
components:
  button:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.wob}"
    padding: "8px 18px"
    typography: "{typography.annotation}"
  button-go:
    backgroundColor: "{colors.yellow}"
    textColor: "{colors.ink}"
    rounded: "{rounded.wob}"
    padding: "8px 18px"
  button-hover:
    backgroundColor: "{colors.paper-2}"
  pill-selected:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.round}"
    padding: "5px 16px"
  icon-button:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.round}"
    size: "44px"
  panel:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.wob}"
    padding: "26px 30px"
  code-card:
    backgroundColor: "{colors.card}"
    textColor: "{colors.ink}"
    rounded: "{rounded.code-card}"
  code-card-header:
    backgroundColor: "{colors.paper-2}"
    textColor: "{colors.ink-3}"
    padding: "9px 18px"
  memory-note:
    backgroundColor: "{colors.sticky}"
    textColor: "{colors.ink}"
    padding: "26px 20px 18px"
  gate-choice:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.wob}"
    padding: "11px 16px"
  gate-choice-hover:
    backgroundColor: "{colors.highlight-yellow}"
  gate-choice-right:
    backgroundColor: "{colors.highlight-teal}"
  gate-choice-wrong:
    backgroundColor: "{colors.highlight-pink}"
  stamp:
    textColor: "{colors.teal-ink}"
    rounded: "{rounded.stamp}"
    padding: "1px 10px"
  severity-high:
    backgroundColor: "{colors.pink}"
    textColor: "{colors.ink}"
    padding: "4px 14px"
  severity-medium:
    backgroundColor: "{colors.yellow}"
    textColor: "{colors.ink}"
    padding: "4px 14px"
  toast:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.paper}"
    rounded: "{rounded.wob}"
    padding: "12px 22px"
---

# Design System: Lens (zine theme)

This file documents the **zine** theme (`assets/themes/zine.html`, the default) only. Future themes get their own design notes. Values below are read from the shipped CSS; the dark palette comes from the `prefers-color-scheme` block and the identical `[data-theme="dark"]` block.

## Overview

**Creative North Star: "The Friend's Zine"**

A lesson is a hand-made zine about one codebase: dot-grid paper, black marker ink, and three flat highlighters. One long scroll of sketched panels in which a real input travels through real code. One thing is in focus at a time; there are no side-by-side panels and no dashboard chrome. Marker lettering and a hand-written annotation voice carry personality, while the reading surface (19px Atkinson Hyperlegible, real mono for code) stays calm enough for an hour of study.

Color is semantic, not decorative. Yellow marks the line that matters and values that changed. Pink marks warnings, gotchas and wrong answers. Teal marks the route and right answers. Everything else is paper and ink. Boxes and arrows are wobbly, drawn by seeded jitter so they are stable between renders, and a magnifier-with-eyes mascot shows think, happy, oops and worry.

**Key Characteristics:**
- Dot-grid paper (22px grid, 1.2px dots) under every surface.
- Marker face only for h1, h2 and big numerals; annotation hand face for labels and margin voice; sans for all reading text.
- Uneven corner radii (`--wob`) on every drawn box; 2 to 2.5px ink borders; soft paper-colored shadows, never hard offsets.
- Highlighter swipes are gradients with feathered ends, not flat rectangles.
- The signature is the route drawing on and the contents rail ticking off stops.

## Colors

Warm cream paper, near-black warm ink, three highlighters each in a fill, an ink and a soft variant.

### Primary
- **Route Teal** (#1FA898): the route line, focus ring, section underline squiggle, completed rail ticks. Teal text uses **Deep Teal Ink** (#0A6B60) for contrast; **Teal Wash** (#D3F1EC) fills active surfaces.

### Secondary
- **Marker Pink** (#FF7EB6): warnings, wrong answers, high-severity badge, impact (break-it) painting. Text uses **Raspberry Ink** (#B21F5C); **Pink Wash** (#FFE0EE) fills result panels.
- **Highlighter Yellow** (#FFD84D, swipe #FFE680): the line that matters, changed values, selection, primary action button, medium severity. Text on yellow stays ink; **Mustard Ink** (#7A5A00) is the yellow-as-text color (the "likely" stamp).

### Neutral
- **Zine Paper** (#FBF6EA), **Deep Paper** (#F3EBD8, code headers, hover, inline code), **Card Cream** (#FFFDF8, every raised panel).
- **Marker Ink** (#1B1A17, text and all borders), **Soft Ink** (#46413A, secondary text), **Pencil Ink** (#6B6458, captions and tertiary).
- **Sticky Yellow** (#FFF3B0): memory note and glossary tooltip only; it is a hard-coded paper-note color, not a highlighter.
- Syntax: comment #857D70 italic, string #0A6B60, number #A3470F, keyword #B21F5C semibold.
- Dark: paper #1A1915, card #25231E, ink #F3EDE0, teal #34C7B5, pink #FF86BC, yellow #F2CB4E; highlighters become 28 to 30% alpha fills; the sticky note becomes #3B3520.

### Named Rules
**The Three Highlighters Rule.** Yellow means attention or change, pink means wrong or risk, teal means route or right. No color is used for decoration, and no fourth accent exists.

**The Ink-Text Rule.** Colored text uses the `-ink` variant of its highlighter (teal-ink, pink-ink, yellow-ink), never the fill color.

## Typography

**Display Font:** Permanent Marker (with Comic Sans MS, cursive)
**Body Font:** Atkinson Hyperlegible Next (with Atkinson Hyperlegible, system-ui)
**Annotation Font:** Shantell Sans (with Comic Sans MS, cursive)
**Mono Font:** JetBrains Mono (with ui-monospace stack)

**Character:** A loud marker for a few words, a handwriting voice for notes, and a legible humanist sans doing all the reading. Mono stays real mono.

### Hierarchy
- **Display** (400 marker, clamp(40px, 4.6vw, 76px), 1.08): the lesson title only, max 20ch, balanced; the part after the colon gets a pink swipe.
- **Headline** (400 marker, clamp(34px, 3.2vw, 48px), 1.1): section h2, each underlined with a teal squiggle. Numerals in stop badges (30px) and the quiz score (88px) also use the marker.
- **Title** (700 sans, clamp(26px, 2.2vw, 34px), 1.2, -0.012em): stop titles; node, experiment, decision, risk and question titles step down through 30, 28, 25, 24 and 23px, all 700 sans.
- **Body** (400 sans, 19px, 1.65; 18px at 760px and below): narrative capped at 68ch, intro text at 66ch, lede 21px at 62ch.
- **Annotation** (Shantell 400 to 700, 15 to 18px): rail, buttons, pills, tabs, captions, stamps, margin notes (600, 16.5px, pink-ink), verdict labels.
- **Code** (mono 15.5px, 1.7; 14px at 760px and below; 14.5px for file and location lines).

### Named Rules
**The Marker Is Rare Rule.** Permanent Marker appears on h1, h2 and numerals only. Titles of cards, stops and questions are bold sans.

**The No-Eyebrow Rule.** Headings carry no kicker or small label above them. Hand-face labels (`.lab`, `.side-h`) appear inline beside or below content as annotations, never stacked above a heading as a category tag.

## Layout

Two-column page grid: a 220px sticky contents rail and a fluid main column, 48px gap, max width 1660px, 48px side padding. Sections are separated by 96px; stops by 84px of padding. Inside a stop a 64px numeral column sits left of the content, joined by a dotted vertical line that turns solid teal once passed. Stop content is a two-column grid: narrative and code (fluid) beside a 300px sticky memory note. The map is full width of the main column with a 900px minimum SVG width inside a horizontally scrolling wrapper.

Breakpoints:
- **1280px:** side column narrows to 280px, page gap 40px, padding 32px.
- **1120px:** single column. The rail becomes a sticky horizontal strip along the top (brand icon plus scrolling contents; stop ticks, key hints and counts hidden). The memory note becomes static (max 520px) and node detail stacks.
- **760px:** 16px side gutter, 18px body, hero stacks and the mascot is hidden, stop numeral column shrinks to 44px, gate, experiments, risks and glossary go single column, a "swipe the map sideways" hint appears.

Rhythm is generous and uneven by design (26, 32, 48, 84, 96px); there is no strict spacing scale beyond these repeated values.

## Elevation & Depth

Hybrid: a thin ink border does most of the structural work, with one soft ambient paper shadow lifting raised cards. There are no hard offset shadows.

### Shadow Vocabulary
- **Paper Lift** (`box-shadow: 2px 4px 14px rgba(60,48,20,.12)`; dark `2px 6px 18px rgba(0,0,0,.45)`): map card, node note, code card, gate, experiments, quiz card.
- **Sticky Lift** (`2px 6px 16px rgba(60,48,20,.18)`, tooltip `rgba(0,0,0,.2)`): memory note and glossary tooltip, rotated about 1 degree.
- **Current Ring** (`0 0 0 4px` teal-soft or yellow highlight): the "here" stop dot and the current quiz pip.

### Named Rules
**The Border First Rule.** A raised thing has a 2 to 2.5px ink border and the soft lift; the shadow alone never defines an edge.

## Shapes

Everything drawn is a little uneven. `--wob` (`14px 18px 12px 20px / 18px 12px 20px 14px`) is the standard box; the code card, map card and stamps carry their own asymmetric variants. Pills and icon buttons are fully round, tiny chips (10px), inline code (5px). Stamps and severity badges tilt -2 to -3 degrees; the memory note tilts 0.8 degrees and the toast -1 degree. Map nodes are a soft fill, a diagonal hatch overlay (teal when active, pink when hit) and a double-pass rough outline, with seeded jitter so shapes do not change between renders. Dashed borders mean provisional or secondary (zones, trigger, result panel, risk dividers); solid means drawn and committed.

## Components

### Map and nodes
Layers are dashed zones with hand labels; nodes are rough boxes with a bold 18px sans label and a 15px hand kind line; edges are 1.7px ink-2 paths with arrowheads and paper-stroked labels. The route is a 7px teal line at 85% opacity that draws on over 0.7s (`cubic-bezier(.16,1,.3,1)`), with a dotted ghost of the remaining path. States: onroute (deep teal stroke), active (hatch), picked (yellow fill), hit and origin (pink stroke, hatch or fill), dim (32% opacity). Focus-visible thickens the stroke in teal. Clicking a node opens the node note beneath the map.

### Step panel (stop)
Marker numeral inside a hand-drawn ring (teal ink and teal-soft fill when current, teal ring when passed), a 700 sans title, a hand-face meta line with a confidence stamp, narrative capped at 68ch, then the code card; the memory note rides in the side column.

### Guess-first gate
A cream bordered card with the mascot (think before, happy or oops after), a bold 21px question and lettered round-key choices. Hover slides 3px and fills yellow; right turns teal-wash with a teal key, wrong turns pink-wash with a pink key; unchosen options fall to 60%. The gated content is blurred (7px, 60% opacity) and unselectable until answered.

### Code card
Figure with a deep-paper caption (file in 600 mono, line range in hand), numbered rows, and a feathered yellow highlighter swipe on important lines whose background grows from 0 to 100% over 0.8s when the stop first scrolls into view (only with motion allowed). Margin notes sit between rows: a hand-drawn arrow icon plus 16.5px pink-ink handwriting, sticky to the left edge when scrolled sideways. A right-edge mask hints at overflow.

### Memory sticky note
A rotated sticky-yellow note with a teal tape strip, listing name and value pairs in mono with dashed separators. New values get a pink swipe and a "new" tag; not-yet-revealed values are a scribbled-out line. Sticky on desktop, static below 1120px.

### Contents rail
Brand mascot plus "lens", section links in 17px hand face (current section gets a yellow swipe), and a stop list on a dashed vertical line with a teal fill that grows with progress. Stop dots: hollow, teal check when done, teal ring when here, a pink "?" for unanswered gates.

### Ask Claude pop and panel
Selecting text shows a solid-ink pill tilted -1.2 degrees ("Ask Claude" plus an A key hint) above the selection; it never appears over blurred, unanswered gate text. The panel is a 500px paper drawer from the right with a 2.5px ink left edge and a neutral shadow: a marker "Ask Claude" heading, a Haiku/Sonnet pill, the quote as a yellow highlighter card with the where-line in hand, quick-question chips, the reader's questions as wobbly hand bubbles on the right, and answers in 18px body text labelled with the model in teal hand. At 1800px and wider the page shrinks to sit beside it; on a phone it fills the screen. Without `serve.py`, the same controls read "Copy question".

### Buttons, pills, tabs
`.btn`: card fill, 2px ink border, `--wob`, 17px hand 600; hover lifts 1px and tilts -0.4 degrees. `.btn.go` is the yellow primary action; `.btn.quiet` is borderless. Depth pill and tabs: selected state is solid ink with paper text (tabs also tilt -1 degree). Icon buttons are 44px circles. Kbd hints have a thicker bottom border.

### Stamps and severity badges
Confidence stamps ("seen in code" teal, "likely" mustard, "a guess" pink) are outlined, tilted, 15px hand. Severity badges are filled: high is pink, medium is yellow, both with ink text and border; low is transparent with soft ink text.

### Quiz and break-it
Quiz: round pips (teal right, pink wrong, yellow ring for current), a cream question card, a marker score numeral beside the mascot. Break-it: a two-part card, change on the left, result on the right behind a dashed divider; result turns pink-wash once run, the run button is the yellow go button.

### Glossary tooltip and toast
Glossary terms are underlined with a pink dotted 2px line; the tooltip is a small tilted sticky (340px max, 16px sans). Definitions list uses teal swipes behind each term. The toast is an ink pill-note with paper text, slides up 24px with a 0.3s ease and tilts -1 degree.

### Motion
Easing is `cubic-bezier(.16,1,.3,1)` for route draw, highlighter swipes, rail fill and toast; 0.15s linear-ish for hovers. `prefers-reduced-motion` removes all animation and transitions and turns off smooth scroll.

## Do's and Don'ts

### Do:
- **Do** use yellow for attention or changes, pink for wrong or risk, teal for route or right, and the `-ink` variant for any colored text.
- **Do** set h1, h2 and numerals in Permanent Marker and every other title in bold Atkinson Hyperlegible.
- **Do** keep doodles (mascot, arrows, squiggles, stars) in headings, the map, margins and state moments (gate, score, empty states).
- **Do** give every drawn box `--wob` or an asymmetric variant, a 2 to 2.5px ink border, and the soft Paper Lift shadow.
- **Do** keep narrative lines at or under 68ch and body at 19px or larger (18px on phones).
- **Do** respect `prefers-reduced-motion` and keep the light and dark palettes in step.

### Don't:
- **Don't** put icons, doodles, or highlighter noise inside paragraphs; the only inline marks are code chips, glossary underlines and single swipes on short phrases.
- **Don't** set body copy or cards' titles in the marker or hand faces.
- **Don't** add eyebrows or kickers above headings.
- **Don't** introduce hard offset shadows, a fourth accent color, or flat square corners on drawn boxes.
- **Don't** return to side-by-side dashboard panels; the lesson is one scroll (the trace tabs only choose which trace to read).
- **Don't** let the horizontal layout scroll the page at 390px; only the map and code rows scroll sideways.
