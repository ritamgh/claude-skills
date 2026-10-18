export const meta = {
  name: 'idea-research',
  description: 'Research any set of ideas against any criteria: fact-checked dossiers, gap round, evaluator panel, REPORT.md and scores.json',
  whenToUse: 'Compare 1-8 candidate ideas against weighted criteria and pass/fail gates with web-verified, dated evidence. Args: dir, today, context, ideas, criteria, gates, gate_docs, evaluators, depth, topics, dry_run.',
  phases: [
    { title: 'Research', detail: 'one dossier per topic, each fact-checked as it lands' },
    { title: 'Gaps', detail: 'completeness critic, then research + fact-check on each gap (full depth only)' },
    { title: 'Panel', detail: 'evaluators score every idea on every criterion and judge every gate' },
    { title: 'Synthesis', detail: 'REPORT.md, then scores.json built from the evaluator numbers' },
  ],
}

// ---------------------------------------------------------------------------------------------------------
// Pure helpers: no globals other than `args` (which only the last line of this block passes in).

function fail(field, why) {
  throw new Error('idea-research: args.' + field + ' ' + why)
}

function text(v) {
  return typeof v === 'string' ? v.trim() : ''
}

function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
}

function needText(v, field) {
  if (!text(v)) fail(field, 'is required and must be a non-empty string')
  return text(v)
}

function needAbs(v, field) {
  const s = needText(v, field)
  if (s[0] !== '/') fail(field, 'must be an absolute path, got "' + s + '"')
  return s
}

// Ids become object keys in scores.json; these would be dropped or shadowed.
function needId(v, field) {
  const s = needText(v, field)
  if (s === '__proto__' || s === 'constructor' || s === 'prototype') fail(field, 'must not be "' + s + '"')
  return s
}

function needList(v, field, min, max) {
  if (!Array.isArray(v)) fail(field, 'is required and must be an array')
  if (v.length < min) fail(field, 'needs at least ' + min + ' item' + (min === 1 ? '' : 's'))
  if (max && v.length > max) fail(field, 'allows at most ' + max + ' items, got ' + v.length)
  return v
}

function validToday(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return false
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]))
  return d.getUTCMonth() === +m[2] - 1 && d.getUTCDate() === +m[3]
}

// Validate and normalise args. Throws Error naming the field; never calls an agent.
function normaliseArgs(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) throw new Error('idea-research: args must be an object')
  const dir = needAbs(a.dir, 'dir').replace(/\/+$/, '') || '/'
  const today = text(a.today)
  if (!validToday(today)) fail('today', 'is required and must be a real date as YYYY-MM-DD, got "' + String(a.today) + '"')
  const context = needText(a.context, 'context')

  const seen = new Set()
  const ideas = needList(a.ideas, 'ideas', 1, 8).map((x, i) => {
    const f = 'ideas[' + i + ']'
    if (!x || typeof x !== 'object') fail(f, 'must be an object with id and name')
    const id = needId(x.id, f + '.id')
    if (!slug(id)) fail(f + '.id', 'must contain letters or digits')
    if (seen.has(slug(id))) fail(f + '.id', 'is a duplicate of an earlier idea id ("' + id + '")')
    seen.add(slug(id))
    return { id, key: slug(id), name: needText(x.name, f + '.name'), pitch: text(x.pitch) }
  })

  const ids = new Set()
  const rubric = (list, field, weighted) =>
    list.map((x, i) => {
      const f = field + '[' + i + ']'
      if (!x || typeof x !== 'object') fail(f, 'must be an object with id and name')
      const id = needId(x.id, f + '.id')
      if (ids.has(id)) fail(f + '.id', 'is a duplicate of another criterion or gate id ("' + id + '")')
      ids.add(id)
      const out = { id, name: needText(x.name, f + '.name'), description: text(x.description) }
      if (weighted) {
        const w = x.weight === undefined || x.weight === null ? 1 : x.weight
        if (typeof w !== 'number' || !isFinite(w) || w < 0) fail(f + '.weight', 'must be a number >= 0')
        out.weight = w
      }
      return out
    })
  const criteria = rubric(needList(a.criteria, 'criteria', 1), 'criteria', true)
  const gates = rubric(a.gates == null ? [] : needList(a.gates, 'gates', 0), 'gates', false)

  const gate_docs = (a.gate_docs == null ? [] : needList(a.gate_docs, 'gate_docs', 0)).map((p, i) => needAbs(p, 'gate_docs[' + i + ']'))
  const evaluators = (a.evaluators == null ? [] : needList(a.evaluators, 'evaluators', 0)).map((p, i) => needText(p, 'evaluators[' + i + ']'))

  const depth = a.depth == null ? 'full' : a.depth
  if (depth !== 'full' && depth !== 'quick') fail('depth', 'must be "full" or "quick", got "' + String(a.depth) + '"')

  let topics = null
  if (a.topics != null) {
    const keys = new Set()
    topics = needList(a.topics, 'topics', 1).map((t, i) => {
      const f = 'topics[' + i + ']'
      if (!t || typeof t !== 'object') fail(f, 'must be an object with key, title and prompt')
      const key = slug(needText(t.key, f + '.key'))
      if (!key) fail(f + '.key', 'must contain letters or digits')
      if (keys.has(key)) fail(f + '.key', 'is a duplicate topic key ("' + key + '")')
      keys.add(key)
      return { key, title: needText(t.title, f + '.title'), prompt: needText(t.prompt, f + '.prompt') }
    })
  }

  if (a.dry_run != null && typeof a.dry_run !== 'boolean') fail('dry_run', 'must be true or false')
  return { dir, today, context, ideas, criteria, gates, gate_docs, evaluators, depth, topics, dry_run: a.dry_run === true }
}

// The topic list: generated from the args unless args.topics replaced it. Each topic: {key, title, prompt}.
function buildTopics(n) {
  if (n.topics) return n.topics
  const quick = n.depth === 'quick'
  const out = []
  const add = (key, title, prompt) => out.push({ key, title, prompt })

  if (quick) {
    add('ctx-rules', 'Rules, evaluators and precedents', 'Read every rule, brief, criteria page or program document the context points to. Extract the exact wording of the evaluation criteria, any pass/fail tests, eligibility and submission requirements and deadlines. Profile who really evaluates (people or roles, public statements, what they rewarded or criticised before) and verify the current list. Then find at least 6 comparable precedents: what won or worked, what lost despite strong execution, and why.')
    add('ctx-landscape', 'Competition, platform and strategy', 'Cover three things briefly but with evidence. (1) Competition and alternatives: direct, adjacent, incumbents, substitutes, with pricing where public. (2) The platform or technology scope the ideas depend on: official docs, limits, test access, known pitfalls. (3) Strategy fit: what the host, company or market is investing in now, and where an idea looks redundant against it.')
  } else {
    add('ctx-rules', 'Rules, constraints and who evaluates', 'Read every rule, brief, criteria page or program document the context points to. Extract the exact wording of the evaluation criteria, any pass/fail tests, eligibility traps, submission requirements and deadlines, and any clarifications from the organisers or owners. Profile who really evaluates: for each evaluator the role, public talks and posts, stated interests, and what they have praised or criticised before. Verify the current list of evaluators.')
    add('ctx-precedents', 'Comparable precedents', 'Study comparable precedents (past editions, similar programs, similar products or bids) from the last two years. For at least 12 cases record the problem, the audience, what was done, the outcome and what made it stand out. Include runners-up or failures that looked strong and infer why they lost. Derive concrete rules for the ideas below.')
    add('ctx-competition', 'Competition and alternatives', 'Scan exhaustively for competing entries, products and substitutes close to each idea: direct, adjacent and incumbent, using code search, product directories, news, forums and social posts. For each near competitor give closeness (direct, adjacent, unrelated), quality, pricing where public, and how each idea must differ. Estimate the size and quality bar of the field.')
    add('ctx-platform', 'Platform and technology scope', 'Determine exactly what the platform or technology the ideas depend on can do today: official docs, API specs, SDK source, limits, test or sandbox access, rate limits, pricing, known pitfalls from issues and forums. For each idea give the minimal reliable call sequence for a demo, with fallbacks, and flag anything that would block it.')
    add('ctx-strategy', 'Strategy fit of the host, company or market', 'Research the strategy and announcements of the host, company or market the ideas must fit: the latest earnings or roadmap themes, executive quotes, products shipped or announced, investment areas. For each idea say how well it maps to something actively pursued, which names or phrases a pitch should echo, and whether something already shipped makes it look redundant.')
  }

  for (const idea of n.ideas) {
    const who = idea.id + ' "' + idea.name + '"' + (idea.pitch ? ' (' + idea.pitch + ')' : '')
    if (quick) {
      add(idea.key + '-scan', idea.id + ' quick scan', 'Quick but sourced scan of idea ' + who + ': feasibility and scope in one paragraph, the best market or user evidence you can find, the closest competitor, and the one legal, ethical or practical constraint most likely to kill it.')
    } else {
      add(idea.key + '-feasibility', idea.id + ' feasibility and technical scope', 'Feasibility and technical scope of idea ' + who + ': what must be built, what already exists, effort and team size needed, dependencies, demo and test feasibility, and what could make it impossible. Be specific about versions, limits and data availability.')
      add(idea.key + '-evidence', idea.id + ' market and user evidence', 'Market and user evidence for idea ' + who + ': who has the problem, hard sized and dated data, documented incidents or cases, willingness to pay or adopt, adoption of related tools. Find the latest edition of every statistic.')
      add(idea.key + '-landscape', idea.id + ' landscape, legal and ethical constraints', 'Landscape plus legal and ethical constraints for idea ' + who + ': incumbents and research, regulation, licensing, liability, privacy, abuse potential, and which disclaimers or design choices keep it honest.')
    }
  }

  const gateList = n.gates.map((g) => g.id + ' ' + g.name + (g.description ? ': ' + g.description : '')).join('\n')
  n.gate_docs.forEach((p, i) => {
    add('gates-' + (i + 1), 'Pre-assessment of gates from ' + p, 'Read the document at ' + p + ' in full. Its criteria are GATES: pass/fail must-haves. Using desk research only, pre-assess each gate and test the document\'s factual claims, one by one, verifying each against current sources. Say which gates look likely to pass or fail and what evidence would settle them, and note what the document is missing.' + (gateList ? '\n\nGATES already defined for this run:\n' + gateList : ''))
  })
  if (n.gates.length && !n.gate_docs.length) {
    add('gates', 'Pre-assessment of the gates', 'These criteria are GATES: pass/fail must-haves. Using desk research only, pre-assess each against current sources and test any factual claim inside it. Say which gates look likely to pass or fail for each idea and what evidence would settle them.\n\nGATES:\n' + gateList)
  }
  return out
}

function evaluatorPlan(n) {
  if (n.depth === 'quick') return { designer: 0, evaluators: 3 }
  if (n.evaluators.length) return { designer: 0, evaluators: n.evaluators.length + 2 }
  return { designer: 1, evaluators: 8 } // up to 6 designed personas + skeptic + literal reader
}

// Maximum agent counts for the plan. A gap costs two agents (research + fact-check).
function countAgents(n, topics) {
  const plan = evaluatorPlan(n)
  const quick = n.depth === 'quick'
  const research = topics.length
  const critic = quick ? 0 : 1
  const gapMax = quick ? 0 : 6
  const agents = {
    research,
    factcheck: research,
    critic,
    gap_max: gapMax,
    designer: plan.designer,
    evaluators: plan.evaluators,
    synthesis: 1,
    scores_writer: 1,
  }
  agents.total_max = research * 2 + critic + gapMax * 2 + plan.designer + plan.evaluators + 2
  const sonnet = research * 2 + gapMax * 2 + 1
  return { agents, models: { sonnet, opus: agents.total_max - sonnet } }
}

const SKEPTIC = 'The skeptic: assume each idea has a fatal flaw and look hard for it (legal, technical, market, demo or execution). Score down whatever you cannot defend from the evidence.'
const LITERAL = 'The literal reader: score only against the written criteria and gates exactly as worded, ignore anything not in them, and give no credit for ambition the text does not ask for.'
const DEFAULT_PERSONA = 'The person who would actually decide, as described in the context: weigh the ideas the way they would.'

function buildPersonas(n, designed) {
  if (n.depth === 'quick') return [n.evaluators[0] || DEFAULT_PERSONA, SKEPTIC, LITERAL]
  const base = n.evaluators.length ? n.evaluators : (designed || []).map(text).filter(Boolean).slice(0, 6)
  return (base.length ? base : [DEFAULT_PERSONA]).concat([SKEPTIC, LITERAL])
}

// ---- scoring: all numbers come from here, never from an LLM ----

function oneDecimal(sum, count) {
  return Math.round((sum * 10) / count) / 10
}

function labelFor(v) {
  return v >= 4.5 ? 'Excellent' : v >= 3.5 ? 'Strong' : v >= 2.5 ? 'Mixed' : v >= 1.5 ? 'Weak' : 'Poor'
}

function joinShort(parts, max) {
  return parts.map((p) => text(p).replace(/\s+/g, ' ').slice(0, 240)).filter(Boolean).join(' | ').slice(0, max)
}

function urlsOf(lists) {
  const out = []
  for (const l of lists) for (const u of Array.isArray(l) ? l : []) if (typeof u === 'string' && /^https?:\/\//.test(u) && !out.includes(u)) out.push(u)
  return out
}

// evals: array of evaluator results ({scores:[{idea_id,criterion_id,score,reason,sources}], gates:[{idea_id,gate_id,verdict,reason,sources}]})
// -> {ideaId: {scores: {K: {value,label,rationale,sources}}, gates: {K: {pass,note,sources}}}}
function aggregate(n, evals) {
  const out = {}
  for (const idea of n.ideas) {
    const scores = {}
    for (const c of n.criteria) {
      const votes = []
      for (const e of evals) {
        const s = (e.scores || []).find((x) => x.idea_id === idea.id && x.criterion_id === c.id) // one vote per evaluator: first row wins
        if (s && typeof s.score === 'number' && s.score >= 1 && s.score <= 5) votes.push(s)
      }
      if (!votes.length) continue
      const value = oneDecimal(votes.reduce((a, v) => a + v.score, 0), votes.length)
      scores[c.id] = { value, label: labelFor(value), rationale: joinShort(votes.map((v) => v.reason), 2000), sources: urlsOf(votes.map((v) => v.sources)) }
    }
    const gates = {}
    for (const g of n.gates) {
      const votes = []
      for (const e of evals) {
        const v = (e.gates || []).find((x) => x.idea_id === idea.id && x.gate_id === g.id)
        if (v) votes.push(v)
      }
      const yes = votes.filter((v) => v.verdict === 'pass').length
      const no = votes.filter((v) => v.verdict === 'fail').length
      gates[g.id] = {
        pass: yes === no ? null : yes > no,
        note: joinShort(votes.map((v) => v.reason), 2000),
        sources: urlsOf(votes.map((v) => v.sources)),
      }
    }
    out[idea.id] = { scores, gates }
  }
  return out
}

function weightedTotal(n, entry) {
  let sum = 0
  let weight = 0
  for (const c of n.criteria) {
    const s = entry.scores[c.id]
    if (s && c.weight > 0) {
      sum += c.weight * s.value
      weight += c.weight
    }
  }
  return weight ? Math.round((sum * 10) / weight) / 10 : null
}

function fallbackVerdict(n, entry) {
  const w = weightedTotal(n, entry)
  const failed = n.gates.filter((g) => entry.gates[g.id].pass === false).map((g) => g.id)
  return (w === null ? 'Not scored' : 'Weighted score ' + w + ' of 5') + (failed.length ? '; fails gate ' + failed.join(', ') : '')
}

function oneLine(s, max) {
  return text(s).replace(/\s+/g, ' ').slice(0, max)
}

function buildScores(n, evals, verdicts) {
  const agg = aggregate(n, evals)
  const ideas = {}
  for (const idea of n.ideas) {
    const entry = agg[idea.id]
    const v = (verdicts || []).find((x) => x && x.idea_id === idea.id)
    ideas[idea.id] = { verdict: oneLine(v && v.verdict, 200) || fallbackVerdict(n, entry), scores: entry.scores, gates: entry.gates }
  }
  return { today: n.today, report: n.dir + '/REPORT.md', ideas }
}

function cell(s) {
  return String(s).replace(/\|/g, '/').replace(/\s+/g, ' ')
}

// Markdown tables for the report, built from the same votes as scores.json.
function scorecard(n, evals, personas) {
  const agg = aggregate(n, evals)
  const lines = ['Evaluators: ' + personas.map((p, i) => 'E' + (i + 1) + ' = ' + oneLine(p, 90)).join('; ')]
  for (const idea of n.ideas) {
    const entry = agg[idea.id]
    lines.push('', '### ' + idea.id + ' ' + idea.name, '')
    lines.push('| Evaluator | ' + n.criteria.map((c) => cell(c.id + ' ' + c.name + ' (w' + c.weight + ')')).join(' | ') + ' |')
    lines.push('|---|' + n.criteria.map(() => '---').join('|') + '|')
    evals.forEach((e, i) => {
      const cells = n.criteria.map((c) => {
        const s = (e.scores || []).find((x) => x.idea_id === idea.id && x.criterion_id === c.id)
        return s ? s.score : '-'
      })
      lines.push('| E' + (e.index + 1) + ' | ' + cells.join(' | ') + ' |')
    })
    lines.push('| Mean | ' + n.criteria.map((c) => (entry.scores[c.id] ? entry.scores[c.id].value : '-')).join(' | ') + ' |')
    const w = weightedTotal(n, entry)
    lines.push('', 'Weighted score: ' + (w === null ? 'not scored' : w + ' / 5'))
    if (n.gates.length) {
      lines.push('', '| Evaluator | ' + n.gates.map((g) => cell(g.id + ' ' + g.name)).join(' | ') + ' |')
      lines.push('|---|' + n.gates.map(() => '---').join('|') + '|')
      for (const e of evals) {
        const cells = n.gates.map((g) => {
          const v = (e.gates || []).find((x) => x.idea_id === idea.id && x.gate_id === g.id)
          return v ? v.verdict : '-'
        })
        lines.push('| E' + (e.index + 1) + ' | ' + cells.join(' | ') + ' |')
      }
      lines.push('| Majority | ' + n.gates.map((g) => (entry.gates[g.id].pass === null ? 'unknown' : entry.gates[g.id].pass ? 'pass' : 'fail')).join(' | ') + ' |')
    }
  }
  return lines.join('\n')
}

// ---- prompts ----

function freshness(today) {
  const y = Number(today.slice(0, 4))
  return 'FRESHNESS: today is ' + today + ' and your training data is older and may be stale. Never state a fact from model memory. Web-verify every fact (rules, prices, product features, API behaviour, laws, rates, competitor offerings, people, statistics) by a search or fetch done now, as of ' + today + '. For every report, survey or statistic, search for the latest edition (for example a ' + y + ' edition replacing ' + (y - 1) + ') and use it; if an older figure is still the latest, say so. Mark the year of every statistic. Label every claim OPENED (you fetched the page), SEARCH-ONLY (seen only in a snippet) or INFERRED (your reasoning), with its URL.'
}

function contextBlock(n) {
  const ideas = n.ideas.map((i) => '- ' + i.id + ' "' + i.name + '"' + (i.pitch ? ': ' + i.pitch : '')).join('\n')
  const crit = n.criteria.map((c) => '- ' + c.id + ' "' + c.name + '" (weight ' + c.weight + ')' + (c.description ? ': ' + c.description : '')).join('\n')
  const gates = n.gates.length ? '\n\nGATES (pass/fail must-haves):\n' + n.gates.map((g) => '- ' + g.id + ' "' + g.name + '"' + (g.description ? ': ' + g.description : '')).join('\n') : ''
  return 'CONTEXT (read any file paths mentioned in it):\n' + n.context + '\n\nIDEAS:\n' + ideas + '\n\nCRITERIA:\n' + crit + gates
}

function researchRules(n) {
  return 'RESEARCH RULES\n- Go deep. Open the actual pages you rely on (WebFetch) and prefer primary sources (regulators, official docs, filings, source code, the program\'s own pages). A search snippet is not a source.\n- ' + freshness(n.today) + '\n- Numbers need units, dates and the population they describe. Note conflicting figures instead of picking one silently.\n- If a site is blocked, say so and use forums, news, trade press, code hosts or posts that are reachable.\n- End with concrete implications for each idea separately (by id) and open questions for the team.\n- Write your full dossier as Markdown to the file path given. Be exhaustive in the file and concise in the structured return.\n- Do not edit any other files. Do not spawn subagents.'
}

function researchPrompt(n, t) {
  return contextBlock(n) + '\n\nYOUR TOPIC: ' + t.title + '\n\n' + t.prompt + '\n\nWrite your dossier to ' + n.dir + '/' + t.key + '.md (create the directory if it is missing).\n' + researchRules(n)
}

function factcheckPrompt(n, t, r) {
  const claims = (r.load_bearing_claims || []).map((c, i) => (i + 1) + '. [' + c.status + '] ' + c.claim + ' (source: ' + c.source + ')').join('\n')
  return contextBlock(n) + '\n\nYou are an adversarial fact-checker for the research dossier at ' + n.dir + '/' + t.key + '.md ("' + t.title + '"). Read the dossier. Then independently re-verify its most load-bearing claims, listed below, by opening primary sources yourself. Default to "unverifiable" unless you actually confirm it. Correct any wrong number, date or attribution. ' + freshness(n.today) + ' Freshness is part of your job: check that each claim still holds as of ' + n.today + ', look for a newer edition of any cited report or statistic and mark the claim "corrected" with the newer figure if there is one, and flag any claim that reads like it came from memory rather than an opened source. Also flag any important claim not in this list that looks wrong or unsupported, and anything the dossier missed that would change the conclusions.\n\nCLAIMS:\n' + claims + '\n\nWrite your fact-check report to ' + n.dir + '/' + t.key + '.factcheck.md. Do not edit the dossier or any other file. Do not spawn subagents.'
}

function digestOf(items) {
  return items
    .map((x) => '## ' + x.t.key + ' ' + x.t.title + '\nFile: ' + x.file + '\nSummary: ' + x.r.summary + '\nFindings: ' + (x.r.key_findings || []).join(' | ') + '\nOpen questions: ' + (x.r.open_questions || []).join(' | ') + '\nFact-check: ' + (x.f ? (x.f.verdicts || []).map((v) => v.verdict + ': ' + v.claim + (v.correction ? ' -> ' + v.correction : '')).join(' | ') + ' NOTES: ' + x.f.notes : 'none'))
    .join('\n\n')
}

function filesOf(n, items) {
  return items.flatMap((x) => [x.file].concat(x.f ? [n.dir + '/' + x.t.key + '.factcheck.md'] : [])).join('\n')
}

function criticPrompt(n, items, taken) {
  return contextBlock(n) + '\n\nYou are the completeness critic for a research fleet comparing the ideas above. Below are digests of ' + items.length + ' dossiers and their fact-checks (full files in ' + n.dir + '). Identify the most decision-relevant gaps: questions not researched, claims refuted or unverifiable that matter, contradictions between dossiers, angles nobody covered (ethics and abuse, accessibility, demo feasibility, data availability, what a skeptical owner would ask, build risks). Return at most 6 gaps, each with a short key like "g1-short-name", a title, and a self-contained research prompt. Only return gaps that could change the decision or the plan. If gate documents are in play, a gap is worth researching when it decides one of the gates. Keys already used: ' + taken.join(', ') + '.\n\n' + freshness(n.today) + '\n\nDo not spawn subagents.\n\n' + digestOf(items)
}

function designerPrompt(n) {
  return contextBlock(n) + '\n\nDerive 4 to 6 evaluator personas: the people or roles who would really judge these ideas against these criteria, given the context (decision makers, domain experts, customers, technical reviewers, automated judging passes if the context mentions them). Name the real roles from the context, not generic ones. For each persona write one sentence on what it values and what it punishes. Do not add a skeptic or a literal reader: they are added for you. Where you need facts about who evaluates, ' + freshness(n.today) + '\n\nDo not spawn subagents.'
}

function evaluatorPrompt(n, persona, files) {
  return contextBlock(n) + '\n\nYou are an evaluator. Persona: ' + persona + '\n\nRead the research files below (dossiers and fact-checks; where they conflict, prefer the fact-check corrections). Then score EVERY idea on EVERY criterion from 1 to 5 (integers; 1 = fails the criterion, 5 = excellent), and give pass, fail or unknown for EVERY gate on every idea. Judge each idea as the team could realistically deliver it. Be harsh and specific; ground each score in evidence from the files and give the URL of the sources you rely on in "sources". Give a short reason (one or two sentences) for each score and gate verdict. Use unknown for a gate only when the evidence cannot settle it.\n\n' + freshness(n.today) + ' If you rely on any fact beyond the files, verify it on the web first.\n\nDo not spawn subagents.\n\nFILES:\n' + files
}

function synthesisPrompt(n, p) {
  return contextBlock(n) + '\n\nYou are writing the final decision report. Read every research file below. Write ' + n.dir + '/REPORT.md, exhaustive but well structured, in this order: (1) the verdict first: which idea or ideas to pursue, confidence, and the 3 reasons; (2) the scorecard: paste the SCORECARD section below verbatim (the numbers are final and computed, do not change or recompute them); (3) for each idea, the strongest sourced evidence, incumbents and differentiation, scope and risks with mitigations, and what must be true for it to work; (4) the gates: for each gate and idea the outcome and the evidence behind it; (5) refuted or shaky claims to avoid repeating; (6) open questions and next steps; (7) a Sources section listing every URL that was OPENED. Use tables where items are compared. Prefer fact-check corrections over original dossier claims. Mark anything unverified. ' + freshness(n.today) + ' Every fact in the report must trace to a research file, and every statistic must show its year and whether it is the latest edition.\n\nThen return a summary of at most 300 words with the verdict, and for each idea id a one-line verdict (at most 160 characters, no line breaks).\n\nSCORECARD (computed):\n' + p.scorecard + '\n\nCRITIC RATIONALE: ' + p.rationale + '\n\nDo not edit any other file. Do not spawn subagents.\n\nFILES:\n' + p.files
}

function writerPrompt(n, json) {
  return 'Write exactly the JSON between the markers below, byte for byte, to ' + n.dir + '/scores.json (create the directory if it is missing). Do not change, reformat, reorder or add anything; do not include the markers. Then read the file back and confirm it parses as JSON.\n\n<<<JSON\n' + json + '\nJSON>>>'
}

// ---- schemas ----

const DOSSIER = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '<=200 words' },
    key_findings: { type: 'array', items: { type: 'string' } },
    load_bearing_claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: { claim: { type: 'string' }, source: { type: 'string' }, status: { type: 'string', enum: ['OPENED', 'SEARCH-ONLY', 'INFERRED'] } },
        required: ['claim', 'source', 'status'],
      },
    },
    implications: {
      type: 'array',
      items: { type: 'object', properties: { idea_id: { type: 'string' }, text: { type: 'string' } }, required: ['idea_id', 'text'] },
    },
    open_questions: { type: 'array', items: { type: 'string' } },
  },
  required: ['summary', 'key_findings', 'load_bearing_claims', 'implications', 'open_questions'],
}

const FACTCHECK = {
  type: 'object',
  properties: {
    verdicts: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          verdict: { type: 'string', enum: ['confirmed', 'corrected', 'refuted', 'unverifiable'] },
          correction: { type: 'string' },
          source: { type: 'string' },
        },
        required: ['claim', 'verdict', 'correction', 'source'],
      },
    },
    notes: { type: 'string' },
  },
  required: ['verdicts', 'notes'],
}

const GAPS = {
  type: 'object',
  properties: {
    gaps: {
      type: 'array',
      items: { type: 'object', properties: { key: { type: 'string' }, title: { type: 'string' }, prompt: { type: 'string' } }, required: ['key', 'title', 'prompt'] },
    },
    rationale: { type: 'string' },
  },
  required: ['gaps', 'rationale'],
}

const PERSONAS = {
  type: 'object',
  properties: { personas: { type: 'array', items: { type: 'string' } } },
  required: ['personas'],
}

function evaluatorSchema(n) {
  const withEnum = (ids) => (ids.length ? { type: 'string', enum: ids } : { type: 'string' })
  const sources = { type: 'array', items: { type: 'string' } }
  return {
    type: 'object',
    properties: {
      persona: { type: 'string' },
      scores: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            idea_id: withEnum(n.ideas.map((i) => i.id)),
            criterion_id: withEnum(n.criteria.map((c) => c.id)),
            score: { type: 'integer', minimum: 1, maximum: 5 },
            reason: { type: 'string' },
            sources,
          },
          required: ['idea_id', 'criterion_id', 'score', 'reason', 'sources'],
        },
      },
      gates: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            idea_id: withEnum(n.ideas.map((i) => i.id)),
            gate_id: withEnum(n.gates.map((g) => g.id)),
            verdict: { type: 'string', enum: ['pass', 'fail', 'unknown'] },
            reason: { type: 'string' },
            sources,
          },
          required: ['idea_id', 'gate_id', 'verdict', 'reason', 'sources'],
        },
      },
      preferred: withEnum(n.ideas.map((i) => i.id).concat(['none'])),
      deciding_factor: { type: 'string' },
    },
    required: ['persona', 'scores', 'gates', 'preferred', 'deciding_factor'],
  }
}

function synthesisSchema(n) {
  return {
    type: 'object',
    properties: {
      summary: { type: 'string' },
      verdicts: {
        type: 'array',
        items: { type: 'object', properties: { idea_id: { type: 'string', enum: n.ideas.map((i) => i.id) }, verdict: { type: 'string' } }, required: ['idea_id', 'verdict'] },
      },
    },
    required: ['summary', 'verdicts'],
  }
}

const WRITTEN = {
  type: 'object',
  properties: { written: { type: 'boolean' } },
  required: ['written'],
}

// ---------------------------------------------------------------------------------------------------------
// Run

const n = normaliseArgs(args)
const topics = buildTopics(n)
const plan = countAgents(n, topics)

if (n.dry_run) {
  return { dry_run: true, topics: topics.map((t) => ({ key: t.key, title: t.title })), agents: plan.agents, models: plan.models }
}

const quick = n.depth === 'quick'
let spent = 0
const ask = (prompt, opts) => {
  spent++
  return agent(prompt, opts)
}
const SONNET = { model: 'sonnet', effort: 'high' }
const OPUS = { model: 'opus', effort: 'high' }

// Evaluator personas depend only on the context, so design them while research runs.
const designedP = evaluatorPlan(n).designer
  ? ask(designerPrompt(n), { label: 'panel-designer', phase: 'Panel', schema: PERSONAS, ...OPUS }).catch(() => null)
  : Promise.resolve(null)

// A dossier whose fact-check returned nothing still goes on to the panel; the log names it.
const uncheckedOf = (items) => items.filter((x) => !x.f).map((x) => x.t.key)

const stages = (label, phaseName) => [
  (t) => ask(researchPrompt(n, t), { label: label + ':' + t.key, phase: phaseName, schema: DOSSIER, ...SONNET }),
  (r, t) =>
    r
      ? ask(factcheckPrompt(n, t, r), { label: (label === 'research' ? 'factcheck' : 'gapcheck') + ':' + t.key, phase: phaseName, schema: FACTCHECK, ...SONNET }).then((f) => ({ t, r, f, file: n.dir + '/' + t.key + '.md' }))
      : null,
]

phase('Research')
const researched = await pipeline(topics, ...stages('research', 'Research'))
const done = researched.filter(Boolean)
const failedTopics = topics.filter((t) => !done.some((x) => x.t.key === t.key)).map((t) => t.key)
const uncheckedTopics = uncheckedOf(done)
log(done.length + '/' + topics.length + ' dossiers researched' + (uncheckedTopics.length ? '; not fact-checked: ' + uncheckedTopics.join(', ') : ' and fact-checked') + (failedTopics.length ? '; failed: ' + failedTopics.join(', ') : ''))
if (!done.length) throw new Error('idea-research: no topic completed, nothing to evaluate')

phase('Gaps')
let gapItems = []
let gapTitles = []
let rationale = 'no gap round (quick depth)'
if (quick) {
  log('quick depth: no gap round')
} else {
  const critic = await ask(criticPrompt(n, done, topics.map((t) => t.key)), { label: 'completeness-critic', phase: 'Gaps', schema: GAPS, ...OPUS })
  const found = critic && Array.isArray(critic.gaps) ? critic.gaps : []
  if (found.length > 6) log('critic returned ' + found.length + ' gaps; dropped ' + (found.length - 6) + ' beyond the cap of 6')
  rationale = critic ? critic.rationale : 'critic did not return'
  const taken = new Set(topics.map((t) => t.key))
  const gapTopics = found.slice(0, 6).map((g, i) => {
    let key = slug(g.key) || 'g' + (i + 1)
    while (taken.has(key)) key += '-x'
    taken.add(key)
    return { key, title: g.title, prompt: g.prompt }
  })
  log('critic found ' + gapTopics.length + ' gaps: ' + gapTopics.map((g) => g.title).join('; '))
  gapItems = (await pipeline(gapTopics, ...stages('gap', 'Gaps'))).filter(Boolean)
  gapTitles = gapTopics.map((g) => g.title)
  if (uncheckedOf(gapItems).length) log('gap dossiers not fact-checked: ' + uncheckedOf(gapItems).join(', '))
}
const all = done.concat(gapItems)
const files = filesOf(n, all)

phase('Panel')
const personas = buildPersonas(n, ((await designedP) || {}).personas)
const evalResults = await parallel(
  personas.map((p, i) => () => ask(evaluatorPrompt(n, p, files), { label: 'eval:' + (i + 1), phase: 'Panel', schema: evaluatorSchema(n), ...OPUS }).then((e) => (e ? { ...e, index: i } : null))),
)
// An evaluator that returned no score row and no gate row counted for nothing: treat it as failed.
const evals = evalResults.filter((e) => e && ((e.scores || []).length || (e.gates || []).length))
if (!evals.length) throw new Error('idea-research: every evaluator failed; dossiers are in ' + n.dir)
if (evals.length < personas.length) log(evals.length + '/' + personas.length + ' evaluators returned; scores use those only')

phase('Synthesis')
const synthesis = await ask(synthesisPrompt(n, { scorecard: scorecard(n, evals, personas), rationale, files }), { label: 'synthesis', phase: 'Synthesis', schema: synthesisSchema(n), ...OPUS })
if (!synthesis) throw new Error('idea-research: synthesis failed, REPORT.md was not written; dossiers are in ' + n.dir)
const scores = buildScores(n, evals, synthesis.verdicts)
const wrote = await ask(writerPrompt(n, JSON.stringify(scores, null, 2)), { label: 'scores-writer', phase: 'Synthesis', schema: WRITTEN, model: 'sonnet', effort: 'low' })
if (!wrote || wrote.written !== true) throw new Error('idea-research: scores.json was not written to ' + n.dir)

const used = { research: topics.length, factcheck: done.length + gapItems.length, critic: quick ? 0 : 1, gaps: gapTitles.length, evaluators: personas.length, synthesis: 1, scores_writer: 1, total: spent }
return { report: n.dir + '/REPORT.md', scores_file: n.dir + '/scores.json', agents: used, topics: topics.map((t) => t.key), gaps: gapTitles }
