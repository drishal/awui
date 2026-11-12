---
name: handoff
description: Hand this chat's work to a fresh agent with no context by writing a complete briefing from the task records and the current state, then delegating it. Use it when work must continue elsewhere — another chat, another harness, or after this conversation has grown too long.
---

# Handoff

A handoff moves work to an agent that knows nothing: a new chat with zero context, possibly a
different harness. It only works if the briefing is complete on its own — the receiver cannot
see this conversation, this chat's history, or your memory of the last hour.

You need the orchestration tools: `task_status`, `thread_read`, `delegate_task`, and optionally
`list_profiles` when the user names a harness or model. If this chat has none of them, say so and
stop; then the only honest handoff is a written briefing pasted into a new chat.

## 1. Gather what is already recorded

Call `task_status` with no argument: it lists the tasks this chat started, with their states,
outcomes, and the model each ran on. For each one that matters, `thread_read({ taskId })` — page
back with `before` when `truncated` is true — and lift out what it decided, what it changed, and
what it gave up on. Those records are cheaper and more exact than recalling them.

Then read the current state yourself: the files that changed, the tests that pass or fail now, the
branch, anything the user corrected along the way.

## 2. Write the briefing, for a stranger

Use these headings, and say plainly when one is empty:

- **Goal** — what the work is for, in two or three sentences, and where it stands now.
- **Done** — what is finished, with the commands that prove it (test names, counts, exit codes).
- **Decisions** — what was chosen and why, including the options rejected and the reason.
- **Files** — every path the receiver will need, with one line on what lives there.
- **Next steps** — the ordered work that remains, each step small enough to start today.
- **Pitfalls** — traps already hit (a flaky test, a confusing name, an API that lies), and the
  constraints to keep: do not push, do not touch unrelated files, do not reformat.

Rules that make it zero-context: no "as discussed", no "the file we changed" without a path, no
pronouns pointing at this conversation. Quote exact commands, exact paths, exact error text. Do
not assume any tool beyond the standard shell exists. Stay under 32 000 characters — a longer
briefing is not a handoff, it is a transcript, so cut it down rather than trimming the parts that
matter.

## 3. Delegate it

```
delegate_task({ brief: "<the briefing>", role: "implementation",
                title: "<the work, shortened>", notify: "wake" })
```

Add `harness`, `model`, or `profile` only when the user asked for that one; otherwise let the
default stand. `notify: "wake"` is the default and it is what a handoff wants: the receiver's
result comes back as a message when it is done. Use a `title` a human can find later in the task
panel.

## 4. Report the handoff

Say which task id and child chat the work moved to, which harness and model it runs on, and what
the receiver was told. Do not claim any of the work was done by the handoff — it has only been
handed over. If the briefing came out incomplete (a decision nobody wrote down, a path you could
not name), say that too: the receiver will hit it.
