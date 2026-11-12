---
name: advisor
description: Ask one agent from another model family for a read-only opinion on a question, a design, or a diff, and report its answer with the model that gave it. Use it for "ask an advisor", "what would another model say", or a quick second opinion when a full council is too much.
---

# Advisor

An advisor is one delegated review: a single agent — ideally from another model family — reads a
self-contained brief, changes nothing, and answers. It is cheaper and faster than a council, and
it is one opinion, not a verdict.

You need the orchestration tools: `list_profiles`, `delegate_task`, `thread_wait`,
`task_status`, `thread_read`. If this chat has none of them, say so and stop.

## 1. Choose the advisor

Call `list_profiles` with no arguments. Prefer an entry whose `provider` differs from the model
you are running as, and skip `available: false`. If the user named a harness or a model, use
that one. If only your own family is installed, say so before delegating: the answer will share
your blind spots.

## 2. Write the brief

Assume the advisor has no context at all. Include:

- the question, in one sentence, with the decision it feeds into;
- the material: the diff, the file paths and the relevant excerpts, the error text;
- what a good answer looks like (a recommendation, the trade-offs, the risk you are unsure of);
- what is out of scope, so the advisor does not re-litigate settled decisions.

Keep it under 20 000 characters and paste the material rather than pointing at commands.

End the brief with exactly this line:

```
Review only. Change nothing.
```

## 3. Delegate once

One call, and no more:

```
delegate_task({ harness: "<harness>", model: "<model>", role: "review",
                title: "<question, shortened>", notify: "none",
                clientRequestId: "advisor-<short-slug>", brief: "<the brief>" })
```

Then `thread_wait({ taskIds: ["<id>"], waitMs: 110000 })`. If the task is still `working`,
`task_status` and wait again; a `waiting_for_user` advisor has a question for the user — relay
it rather than answering it. Use `thread_read({ taskId })` when the answer was cut short.

## 4. Report it as borrowed

Hand the answer back attributed, never as your own conclusion:

```
**<model>** (<harness>), asked as an advisor: <its answer, quoted or lightly tidied>
```

`task_status` for the task carries `model`; use it. When `model` is null, write "the harness
default" rather than guessing. Then add your own view in one short paragraph — where you agree,
where you do not — and mark clearly which part is the advisor's. If the advisor failed or was
cancelled, say that instead of paraphrasing nothing.
