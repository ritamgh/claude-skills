export type HqTask = {
  id: string
  state: string
  age: string
  repo: string
  note: string
  // the open decision's id (`D3`), from the `D3 · ` that crew ls puts in front of the note
  decision?: string
  // from the task's meta file (see applyMeta): its lead session, the repo's full path, its branch and its worktree
  lead?: string
  repoPath?: string
  branch?: string
  worktree?: string
  // the meta's last branch= and worktree= lines are both empty: nothing to diff, whatever an earlier line said
  diffCleared?: true
}

// A task's meta file: the last `lead=`, `repo=`, `branch=` and `worktree=` line each.
export type HqMeta = { lead?: string; repoPath?: string; branch?: string; worktree?: string; diffCleared?: true }

// A pull request as `gh` reports it: state is OPEN, MERGED or CLOSED. `at` (ms) is when it merged or closed.
export type HqPr = { number: number; state: string; at?: number }

// A pull request whose review the user was asked for (gh search prs --review-requested=@me).
export type HqReviewPr = { repo: string; number: number; title: string; url: string; updatedAt: number }

// What the last gh search for review requests found (`prs` is null until one has worked), and when it ran (ms).
export type HqReviews = { fetched: number; prs: HqReviewPr[] | null }

// What the user has looked at: everything that finished before `all`, and single tasks by the time they were seen.
export type HqSeen = { all: number; ids: Record<string, number> }

// What the last gh query for a task found; `pr` is null when it found nothing or failed. `key` says what was
// asked (`#36` or the branch), `fetched` when (ms).
export type HqPrEntry = { key: string; fetched: number; pr: HqPr | null }

// The user-facing text kept for a finished task: summary.md, else report.md (read only while there is no summary),
// each with the mtime (ms) it was read at; null when the file is missing.
export type HqResultFiles = { summary: string | null; summaryAt: number; report: string | null; reportAt: number }

export type HqSession = {
  kind: 'claude' | 'proc'
  name: string
  state: string
  age: string
  seconds: number
  where: string
  // tmux pane of a claude session ('' for a proc or a session outside tmux)
  target: string
  window: string
  // the session's transcript file (claude sessions only, when it exists)
  transcript?: string
  // https://claude.ai/code/<id> of a claude session with Remote Control on
  link?: string
  // a live top-level lead (see markLeads): HQ never folds it into the idle line or the page's "+N idle"
  lead?: true
}

// The Needs-you items (markdown stripped) in the last reply of a live session, and when it was written (ms). Empty
// when the reply has none or the user has answered since.
export type HqChat = { items: string[]; at: number }

// An HqChat as read from a transcript, with the file's size and mtime (s) it was read at.
export type HqChatEntry = HqChat & { size: number; mtime: number }

export type HqParked = { pri: string; date: string; repo: string; text: string }

// One line of bin/tmux-map: a live claude session with its full cwd, and its tmux pane if it has one.
export type HqLive = { name: string; target: string; window: string; cwd: string; state: string; seconds: number; transcript: string; link: string }

export type HqBoard = {
  needsYou: HqTask[]
  running: HqTask[]
  // state waiting: someone else has to act (crew ls: WAITING ON OTHERS)
  waiting: HqTask[]
  done: HqTask[]
  elsewhere: HqSession[]
  parked: HqParked[]
  // the `+N more` line crew ls prints when it cuts PARKED
  parkedMore: number
}

declare module 'claude-code' {
  interface PluginState {
    hq: {
      board: HqBoard | null
      error: string | null
      view: 'focus' | 'projects'
      holds: Record<string, string>
      prs: Record<string, HqPrEntry>
      prToasted: string[]
      reviews: HqReviews
      seen: HqSeen
      // per transcript path: the Needs-you items of the session's last reply
      chats: Record<string, HqChatEntry>
      // per session key: the time of the chat reply the user dismissed
      dismissed: Record<string, number>
      entered: Record<string, number>
      // when each task last wrote a line to its status file (ms)
      last: Record<string, number>
      results: Record<string, HqResultFiles>
      // the task whose result the pane shows in full, null for the board
      detail: string | null
      // the whole text of each open question, and the last note of each task, by task id
      questions: Record<string, string>
      notes: Record<string, string>
      // the key of the NEEDS YOU line whose page the pane shows, null for the board
      need: string | null
      // the first line of that page's question that is shown
      needScroll: number
      // the New lead form while the pane shows it (null otherwise), with the folders it offers
      newLead: { repo: string; name: string; text: string; model: string; choices: string[] } | null
    }
  }
}
