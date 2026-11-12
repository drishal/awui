---
name: council
description: Put one piece of work in front of three reviewers from different model families at once, merge their verdicts, and run at most one rebuttal round. Use it when someone says "council this diff", asks for a second opinion, or wants a change checked by more than one model before it lands.
---

# Council

A council is three agents reviewing the same work in parallel, each from a different model
family, followed by one merged report. No reviewer edits anything. Do this only when the user
asks for it, or when a change is about to be called done and three independent reads of it are
worth the cost.

You need the orchestration tools: `list_profiles`, `delegate_task`, `thread_wait`,
`task_status`, `thread_read`, `thread_send`, `task_cancel`. If this chat has none of them, say
so and stop: there is no council without delegation.

## 1. Choose the seats

Call `list_profiles` with no arguments. Pick three seats from three different model families, not
three models from one vendor. A saved bot profile (`source: "bot"`) is a good seat when its harness
and model fit: its `provider` field names the family. A `source: "harness"` entry has no model or
provider of its own (both are null): choose a `model` for it yourself, spelled as that harness
spells it (`provider/id`), and the part before the slash is the family. Skip entries with
`available: false`.

If fewer than three distinct providers exist, seat one reviewer per provider and say in the
report how many sat: a council of two is still a council, a council of one is an advisor.

## 2. Write one brief

Every seat gets the same brief, worded so a stranger can review it with no other context:
what the work is, what it should do, the diff or the files to read (with paths), and what you
want judged (correctness, tests, security, naming — say which matter most). Keep it under
20 000 characters; paste the diff rather than naming a command that may not resolve.

End every brief with these rules, verbatim, on their own lines:

```
Review only: change nothing — no edits, no commits, no pushes, no new files.
Do not delegate and do not spawn subagents.
Return findings ranked by severity (blocker, major, minor, nit), each with a concrete fix.
Score the work out of 10 and say approve or reject.
If you cannot score it, write "no score" and why; never invent a score.
```

## 3. Start all three in one turn

Call `delegate_task` three times **in the same turn**, so the reviewers run at the same time:

```
delegate_task({ harness: "<seat's harness>", model: "<seat's model>", role: "review",
                title: "Council 1 · <seat>", notify: "none",
                clientRequestId: "council-1-<seat>", brief: "<the brief>" })
```

Use `profile` instead of `harness`/`model` when the seat is a bot profile. Round 1 ids are
`council-1-a`, `council-1-b`, `council-1-c`; round 2 reuses the same seats with `council-2-…`.
The `clientRequestId` is what makes a retried call return the same task instead of starting a
fourth reviewer. `notify: "none"` is right because you wait for them yourself.

## 4. Wait for all three

Then call `thread_wait({ taskIds: ["<a>", "<b>", "<c>"], waitMs: 110000 })`. It returns early
when every task is finished or asking a question. If any task is still `working`, wait again
with the ones that are left. `task_status` shows the states; a task that is `waiting_for_user`
has a question the user must answer — tell them and keep waiting, do not answer for them.

Read a verdict with `thread_read({ taskId })` when the wait result cut it short. A reviewer
that is stuck and produces nothing after two waits can be stopped with `task_cancel`, but say so
in the report and treat the missing verdict as missing.

## 5. Merge round 1

Build one verdict: where the three agree, where they disagree, and which findings are blockers.
Keep the sharpest wording of each finding and name the seats that raised it. A finding two
reviewers missed is still worth reporting, marked as a single seat's.

Then decide:

- **Every seat approves** (score at least 8 and no blocker) → done, write the report.
- **Otherwise** → one rebuttal round, and only one.

## 6. Round 2, the only rebuttal round

Send the same brief plus: the round-1 verdicts in full, your merged list, and for each blocking
finding whether you fixed it or why you think it is wrong. Same three seats, new
`clientRequestId`s (`council-2-a`…), `role: "review"`, `notify: "none"`, then `thread_wait` on
all three again. Ask them to approve or maintain their objection, not to review from scratch.

Stop when all three approve, or when round 2 has answered. There is never a third round; an
objection that survives round 2 is reported as unresolved with the seats that held it.

## 7. Report

Answer with a short table, then the findings:

```
| Seat | Model | Round | Score | Verdict  |
|------|-------|-------|-------|----------|
| a    | …     | 1 → 2 | 8     | approve  |
| b    | …     | 1 → 2 | 6     | reject   |
| c    | …     | 1 → 2 | no score | approve |
```

A seat that never gave a score shows **no score** — never fill one in, never average a missing
one. Below the table: unresolved blockers with the seat that raised them, the disagreements
worth a human's attention, and one line saying whether the council approved.
