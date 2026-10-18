import { readFile, readdir } from 'node:fs/promises'

import { isTarget, parseLive } from '../hooks/board'
import type { HqLive } from '../types'
import { run } from './exec'

// Everything that touches a tmux pane: the live claude sessions, the pane preview, and the one way text reaches a
// session. User text only ever travels as one argv element of `tmux send-keys -l`; no shell is involved.

// `procRoot` and `settleMs` are test seams (default /proc and one second).
export type TmuxDeps = { tmuxBin: string; tmuxMapBin: string; env: Record<string, string | undefined>; procRoot?: string; settleMs?: number }

export const MAX_TEXT = 2000

// Terminal escape sequences (CSI, OSC, other two-byte ones), then any control character that is left.
const ESCAPES = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g
const CONTROLS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/g

// What the pane preview shows: the capture without escape sequences or control characters (newlines and tabs stay).
export const cleanPane = (text: string): string => text.replace(ESCAPES, '').replace(CONTROLS, '')

// What is sent to a session: one line. A line break would press Enter in the middle of the message, so line breaks
// and tabs become spaces, and every other control character is dropped.
export const sanitizeText = (text: string): string =>
  text
    .replace(/[\r\n\t\u2028\u2029]+/g, ' ')
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .trim()

// The lines of the screen that matter for a prompt: the bottom of it, where Claude Code draws its dialogs.
const SCREEN_TAIL = 25
// A selection dialog: the cursor on a numbered option, a footer that names its keys, or a question over numbered options.
const CURSOR_OPTION = /^\s*[❯›]\s*\d+\.\s/
const OPTION = /^\s*[❯›]?\s*\d+\.\s+\S/
const FOOTER = /(?:Esc to cancel|Enter to (?:select|confirm)|Tab to amend|↑\/↓ to navigate)/i
const QUESTION = /\b(?:Do you want to|Would you like to|Do you trust)\b/

// The line that shows a permission or selection prompt open on the visible screen, else null.
export function promptOpen(screen: string): string | null {
  const lines = screen
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => l.trim() !== '')
    .slice(-SCREEN_TAIL)
  const hit =
    lines.find(l => CURSOR_OPTION.test(l)) ??
    lines.find(l => FOOTER.test(l)) ??
    (lines.some(l => OPTION.test(l)) ? lines.find(l => QUESTION.test(l)) : undefined)

  return hit ? hit.trim().slice(0, 120) : null
}

// bin/tmux-map: the live claude sessions that run in a tmux pane.
export async function liveSessions(deps: TmuxDeps): Promise<HqLive[]> {
  const ran = await run([deps.tmuxMapBin], deps.env, 10_000)

  return ran.code === 0 ? parseLive(ran.stdout) : []
}

export const inTmux = (live: HqLive[]): HqLive[] => live.filter(s => s.target !== '')

export async function capture(deps: TmuxDeps, target: string, scrollback?: number): Promise<string | null> {
  if (!isTarget(target)) return null
  const argv = [deps.tmuxBin, 'capture-pane', '-p', '-J', ...(scrollback ? ['-S', `-${scrollback}`] : []), '-t', target]
  const ran = await run(argv, deps.env, 10_000)

  return ran.code === 0 ? cleanPane(ran.stdout) : null
}

// `typed`: the text was already sent to the pane when this failed, so a retry would type it a second time.
// `enterPending`: it may well be in the composer unsubmitted; `submitTyped` can press the Enter later.
export type SendResult = { ok: true } | { ok: false; status: number; error: string; reason?: string; typed?: boolean; enterPending?: boolean }

const NOT_FOREGROUND = 'Claude is not in the foreground of the pane'
const CLAUDE_COMM = /^(?:claude|\d+\.\d+\.\d+)$/

// `pid (comm) S ppid pgrp session tty tpgid ...` of /proc/<pid>/stat; comm may hold spaces and parentheses.
function parseStat(text: string): { comm: string; pgrp: number; tpgid: number } | null {
  const open = text.indexOf('(')
  const close = text.lastIndexOf(')')
  if (open < 0 || close < open) return null
  const rest = text.slice(close + 2).split(' ')
  const [pgrp, tpgid] = [Number(rest[2]), Number(rest[5])]

  return Number.isInteger(pgrp) && Number.isInteger(tpgid) ? { comm: text.slice(open + 1, close), pgrp, tpgid } : null
}

// True when a claude process (its comm is `claude`, or a version for a background session) is in the pane's foreground
// process group. A tmux-map listing only says the session exists: a Ctrl-Z'd claude leaves the shell in front, and
// keys sent then would run in that shell. Anything unreadable counts as not in the foreground.
export async function claudeInForeground(deps: TmuxDeps, target: string): Promise<boolean> {
  if (!isTarget(target)) return false
  const shown = await run([deps.tmuxBin, 'display-message', '-p', '-t', target, '#{pane_pid}\t#{pane_current_command}'], deps.env, 10_000)
  if (shown.code !== 0) return false
  const [pid = '', command = ''] = shown.stdout.replace(/\n$/, '').split('\t')
  if (!/^\d+$/.test(pid) || !CLAUDE_COMM.test(command)) return false

  const root = deps.procRoot ?? '/proc'
  try {
    const pane = parseStat(await readFile(`${root}/${pid}/stat`, 'utf8'))
    if (!pane || pane.tpgid <= 0) return false
    for (const entry of await readdir(root)) {
      if (!/^\d+$/.test(entry)) continue
      try {
        const proc = parseStat(await readFile(`${root}/${entry}/stat`, 'utf8'))
        if (proc && proc.pgrp === pane.tpgid && CLAUDE_COMM.test(proc.comm)) return true
      } catch {
        // the process ended while it was read
      }
    }
  } catch {
    return false
  }

  return false
}

// What the composer shows, as text without whitespace: the `❯` row and the rows under it down to the rule or a blank row.
// With `whole`, a blank row is part of the composer (the user pressed Shift+Enter twice) and only a rule ends it; a screen
// that ends first gives no entries, since rows may be missing.
// Claude Code wraps a long composer onto indented rows that `-J` does not join, and the break eats the space, so
// whitespace is dropped on both sides of a comparison. One entry per row count, since a footer may follow with no rule.
function composerTexts(screen: string, whole = false): string[] {
  const lines = screen.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!/^\s*❯/.test(lines[i]!)) continue
    const seen: string[] = []
    let row = lines[i]!.replace(/^\s*❯/, '')
    for (let j = i + 1; ; j++) {
      seen.push(`${seen.at(-1) ?? ''}${row.replace(/\s/g, '')}`)
      if (j >= lines.length) return whole ? [] : seen
      if (/^\s*[─━]{8,}\s*$/.test(lines[j]!) || (!whole && lines[j]!.trim() === '')) return seen // a rule is a row of dashes: a user row that merely starts with one is text
      row = lines[j]!
    }
  }

  return []
}

const squeeze = (text: string) => text.replace(/\s/g, '')
const composerEndsWith = (screen: string, text: string): boolean => composerTexts(screen).some(t => t.endsWith(squeeze(text)))
// The whole composer, down to its rule: rows the user typed under the text count against it.
const composerIs = (screen: string, text: string): boolean => composerTexts(screen, true).at(-1) === squeeze(text)

// One send at a time per pane: two messages never interleave their keys.
const locks = new Map<string, Promise<unknown>>()
function exclusive<T>(key: string, task: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).then(task, task)
  const tail = run.catch(() => undefined)
  locks.set(key, tail)
  void tail.then(() => {
    if (locks.get(key) === tail) locks.delete(key)
  })

  return run
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Types `text` into the claude session at `target` and presses Enter. Refuses a target that tmux-map does not list as
// a live claude session, one where claude is not in the foreground, text that is empty or too long, and a pane that
// shows a prompt (the user answers those in tmux). The text goes in first; Enter is pressed only after the pane is
// read again and shows no prompt, claude still in front, and the text at the end of the composer. A permission dialog
// that opens meanwhile would take that Enter as "yes".
export function sendText(deps: TmuxDeps, target: string, rawText: string): Promise<SendResult> {
  if (!isTarget(target)) return Promise.resolve({ ok: false, status: 400, error: 'bad target' })
  const text = sanitizeText(rawText)
  if (text === '') return Promise.resolve({ ok: false, status: 400, error: 'empty text' })
  if (Array.from(text).length > MAX_TEXT) return Promise.resolve({ ok: false, status: 413, error: `text is longer than ${MAX_TEXT} characters` })

  return exclusive(target, async (): Promise<SendResult> => {
    if (!inTmux(await liveSessions(deps)).some(s => s.target === target)) {
      return { ok: false, status: 403, error: 'not a live claude session in tmux' }
    }
    if (!(await claudeInForeground(deps, target))) return { ok: false, status: 409, error: NOT_FOREGROUND }

    const screen = await capture(deps, target)
    if (screen === null) return { ok: false, status: 502, error: 'could not read the pane' }
    const open = promptOpen(screen)
    if (open) return { ok: false, status: 409, error: 'a prompt is open in the pane: answer it in tmux', reason: open }

    const typed = await run([deps.tmuxBin, 'send-keys', '-t', target, '-l', '--', text], deps.env, 10_000)
    // tmux may have taken some of the keys before failing (or timing out): not safe to type again.
    if (typed.code !== 0) return { ok: false, status: 502, error: `tmux send-keys failed: ${typed.stderr.trim()}`, typed: true }

    const deadline = Date.now() + (deps.settleMs ?? 1000)
    for (;;) {
      const now = await capture(deps, target)
      if (now === null) return { ok: false, status: 502, error: 'could not read the pane; Enter was not pressed', typed: true }
      const appeared = promptOpen(now)
      if (appeared) {
        return { ok: false, status: 409, error: 'a prompt opened while typing: nothing more was sent, and the text is still in the composer', reason: appeared, typed: true }
      }
      if (composerEndsWith(now, text)) break
      if (Date.now() >= deadline) return { ok: false, status: 409, error: 'the text did not show up in the composer: Enter was not pressed, and the text may still be there', typed: true, enterPending: true }
      await sleep(25)
    }
    if (!(await claudeInForeground(deps, target))) return { ok: false, status: 409, error: `${NOT_FOREGROUND}: Enter was not pressed, and the text may still be in the pane`, typed: true }

    const entered = await run([deps.tmuxBin, 'send-keys', '-t', target, 'Enter'], deps.env, 10_000)
    if (entered.code !== 0) return { ok: false, status: 502, error: `tmux send-keys failed: ${entered.stderr.trim()}`, typed: true }

    return { ok: true }
  })
}

// The late Enter for a `sendText` that failed with `enterPending`. It never types: it presses Enter only when the
// composer holds exactly `rawText` (text of the user's own, or anything around it, is left alone) and no prompt is open.
// A refusal without `typed` may be retried; with `typed`, the text is no longer there as sent.
export function submitTyped(deps: TmuxDeps, target: string, rawText: string): Promise<SendResult> {
  if (!isTarget(target)) return Promise.resolve({ ok: false, status: 400, error: 'bad target', typed: true })
  const text = sanitizeText(rawText)

  return exclusive(target, async (): Promise<SendResult> => {
    if (!inTmux(await liveSessions(deps)).some(s => s.target === target)) return { ok: false, status: 403, error: 'not a live claude session in tmux' }
    if (!(await claudeInForeground(deps, target))) return { ok: false, status: 409, error: NOT_FOREGROUND }

    const screen = await capture(deps, target)
    if (screen === null) return { ok: false, status: 502, error: 'could not read the pane' }
    const open = promptOpen(screen)
    if (open) return { ok: false, status: 409, error: 'a prompt is open in the pane: answer it in tmux', reason: open }
    if (!composerIs(screen, text)) return { ok: false, status: 409, error: 'the composer no longer holds the text alone: Enter was not pressed', typed: true }

    const entered = await run([deps.tmuxBin, 'send-keys', '-t', target, 'Enter'], deps.env, 10_000)

    return entered.code === 0 ? { ok: true } : { ok: false, status: 502, error: `tmux send-keys failed: ${entered.stderr.trim()}`, typed: true }
  })
}
