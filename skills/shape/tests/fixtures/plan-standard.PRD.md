<!-- Generated from plan.json rev 95 by `plan render`. Do not edit: change the plan. -->

## 0. Header

**Title:** Offline sync for a notes app
- Owner: user
- Size: standard
- Stage: decide
- Rev: 95
- Updated: 2026-10-17T02:07:00Z
- Approved: no

## 1. TL;DR

Solo users who edit notes on a phone and a laptop lose edits made without a connection. We add offline editing with an operation log that syncs with the existing REST API. It works when sync finishes in under 2 s after reconnect and no edit is lost across two devices.

## 2. Problem & evidence

- **P1** Edits made offline on the train are lost when the laptop syncs
  Maya edits a shopping list on her phone without signal. The laptop later overwrites it.
  - Evidence: Three support threads in the last month (#412, #430, #447)

## 3. Users & context

- **U1** Solo users with a phone and a laptop
  - Context: Edit on the go; one account; one device at a time.

## 4. Goals & success criteria

- **G-1** Notes stay editable and in sync without a connection
  - **SC-001** Sync finishes in under 2 s (p95) after reconnect
    - Verify: Sync benchmark with 500 notes on a throttled link
  - **SC-002** No edit is lost when two devices edit offline and reconnect
    - Verify: Two-device scenario test

## 5. Non-goals

- **NG-1** No CRDT or real-time co-editing
  - Why: An op-log is enough for solo users and fits the appetite.
- **NG-2** No note sharing between accounts
  - Why: One account per user; sharing needs permissions we do not have.

## 6. Appetite & constraints

- **C-1** Appetite: 2 weeks
  A budget, not an estimate. If it runs over, cut scope, not time.
  - Tag: appetite
- **C-2** Keep the existing REST API; no new endpoints before the sync slice (default)
  - Tag: stack

## 7. Assumptions

- **AS-1** One developer for the whole 2 weeks (unvalidated) (default)
  - Validate by: Confirm at the readiness gate
  - Impact: S2 would not fit with half a developer
- **AS-2** Device clocks are within 5 s of server time (validated)
  - Validate by: Compared 20 devices against the server
  - Impact: Timestamp ordering of ops stays valid
- **AS-3** OS disk encryption is on by default on supported phones [NEEDS CLARIFICATION: Q11] (unvalidated) (default)
  - Validate by: Check Android 10+ and iOS 15+ documentation
  - Impact: Decides whether Q11 can rely on the OS
- ~~AS-4 Users want end-to-end encryption in v1~~ (killed)
  - Validate by: Ask five users
  - Impact: Would add key management to the appetite

## 8. Slices

- **S1** Walking skeleton: edit offline, sync manually
  - Why this priority: Proves the store and the op-log end to end
  - Independent test: Edit a note in airplane mode, tap Sync, see it on the laptop
  - Refs: FR-001, FR-002, FR-003
  - Given a note and no connection, When the user edits it, Then the edit is saved locally
  - Given queued edits and a connection, When the user taps Sync, Then the server holds the edit

## 9. Requirements

- **FR-001** Users can create and edit notes while offline
- **FR-002** Edits made offline are queued as operations and kept across app restarts
- **FR-003** The Sync button pushes queued operations and pulls remote ones
- **FR-005** Sync after reconnect completes in under 2 s (p95) for 500 notes

## 10. Edge cases

- **E-1** Sync interrupted halfway
  - Expected behaviour: Operations already pushed are not re-applied; the rest are re-sent, because operations carry ids.
  - Refs: Q16

## 11. Risks & rabbit holes

- **R-2** Large attachments (parked)
  - Approach: Past the appetite; revisit after launch.

## 12. Technical approach

- **A-1** Op-log over SQLite with a server-assigned order
  - Alternatives:
    - CRDT
    - Full-state snapshot

## 13. Agent boundaries

### Always

- **B-2** Run the task's check before marking it done

### Ask first

- **B-4** Ask before changing the REST API contract

### Never

- **B-1** Never add a CRDT library
  - Refs: NG-1

### Commands

- **B-3** npx jest

## 14. Open questions

- **Q7** Conflict policy when two devices edit the same note
  - Why: Decides the data model and two slices
  - Refs: AS-1
  - Blocking: yes
  - a. Last-write-wins (recommended): solo users, 2-week appetite
  - b. Field-level merge
  - c. Ask the user on a clash
- **Q8** How long are tombstones kept?
  - Why: Bounds storage growth against how late a device may reconnect.
  - a. 30 days (recommended): Covers a long holiday
  - b. 7 days
  - c. Forever
- **Q9** Retry policy on a failed sync [NEEDS CLARIFICATION: Q7]
  - Why: Sets sync behaviour on a flaky network and the check for T-004.
  - Blocking: yes
  - a. Exponential backoff, capped at 60 s (recommended): Standard and easy to test with a fake clock
  - b. Fixed 5 s interval
  - c. Manual retry only
- **Q11** Encryption at rest
  - Why: Affects the first slice; costly to retrofit.
  - Blocking: yes
  - a. Rely on OS disk encryption (recommended): No key management; matches the appetite
  - b. App-level (SQLCipher)
  - c. Decide after launch
- **Q17** How do the sync checks run in CI?
  - Why: Decides whether T-004 can have a runnable check.
  - a. Fake clock and in-memory SQLite (recommended): Fast and deterministic
  - b. Real device farm
- **Q20** Do attachments sync in v1? [NEEDS CLARIFICATION: Q11] (parked)
  - Why: Large files blow the appetite.
  - a. Yes
  - b. No, v2 (recommended): Past the appetite
- **Q21** Which sync metrics do we log?
  - Why: Needed to verify SC-001 in production.
  - a. Duration and op count (recommended)
- **Q22** Does the server API support a `since` cursor for incremental pulls?
  - Why: Blocks background sync (S2).
  - Blocking: yes
  - a. Yes
  - b. No
  - c. Unknown, ask the backend owner

## 15. Task map

| id | slice | covers | files | depends on | P | check | status |
|---|---|---|---|---|---|---|---|
| **T-001** SQLite schema and migrations | S1 | FR-001 | app/db/schema.ts, app/db/migrate.ts |  |  | `npx jest app/db` | done |
| **T-002** Offline edit queue | S1 | FR-002 | app/queue.ts | T-001 |  | `npx jest app/queue` | todo |
| **T-003** Manual sync action | S1 | FR-003 | app/sync.ts | T-002 |  | `npx jest app/sync` | todo |
| **T-004** Sync worker | S2 | FR-004, FR-005, SC-001 | app/worker.ts | T-003 |  |  | todo |

## 16. Milestones

- **S1** Walking skeleton: edit offline, sync manually
  Manual sync of one note works between two devices

## 17. Decision log

- **DEC-1** SQLite over IndexedDB
  - Chose: SQLite
  - Alternatives:
    - IndexedDB
    - localStorage
  - Why: Same schema on phone and web; the op-log stays queryable.
  - Refs: Q10
- **DEC-2** Op-log sync, no CRDT
  - Chose: Op-log
  - Alternatives:
    - CRDT
    - Full-state snapshot
  - Why: NG-1 and the 2-week appetite.
  - Refs: Q12
- **DEC-3** Server stays the source of truth (default)
  - Chose: Server
  - Alternatives:
    - Peer-to-peer
  - Why: Existing REST API, one account per user.
  - Refs: Q6

## 18. Progress & discoveries

Tasks: todo 3, doing 0, done 1, failed 0.

- **X-1** The REST API pages notes at 100 per page
  - Evidence: GET /notes returns next_page; checked against staging.
