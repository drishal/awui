// A pending approval or question takes the composer's place, as in the web UI:
// numbered options (1–9 or ↑/↓ and Enter), Esc to dismiss; a question that
// wants text gets a box of its own.
import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import type { TextareaRenderable } from "@opentui/core";
import { useKeyboard } from "@opentui/solid";
import type { InteractionAnswer, InteractionRequest } from "../../shared/protocol.js";
import { splitStep } from "../../web/questions.js";
import { MAX_DENIAL_REASON_CHARS } from "../../shared/protocol.js";
import { isApproval, optionsOf } from "../requests.js";
import { useAtui, useTheme } from "./context.js";

export function RequestCard(p: { request: InteractionRequest; more: number; active: boolean }) {
  const app = useAtui();
  const t = useTheme();
  const options = createMemo(() => optionsOf(p.request));
  const [index, setIndex] = createSignal(0);
  createEffect(
    on(
      () => p.request.id,
      () => setIndex(Math.max(0, options().findIndex((o) => o.recommended))),
    ),
  );
  const approval = () => isApproval(p.request);
  const [titleLine = "", ...rest] = p.request.title.split("\n");
  const message = () => p.request.message?.trim() ?? "";
  // A question's short title is a label (Claude Code's "Approach"); its message is the question itself.
  const labelled = () => !approval() && p.request.kind === "select" && message() !== "" && rest.length === 0 && titleLine.length <= 32;
  const head = () => splitStep(labelled() ? message() : titleLine);
  const detail = () => (labelled() ? "" : [rest.join("\n").trim(), message()].filter(Boolean).join("\n\n"));
  let input: TextareaRenderable | undefined;
  const answer = (a: InteractionAnswer, denialReason?: string) => void app.answer(p.request.id, a, denialReason);
  const [denying, setDenying] = createSignal(false);
  const [denialReason, setDenialReason] = createSignal("");
  const choose = (o: { label: string; answer: InteractionAnswer }) => {
    if (approval() && o.label === "Deny") {
      setDenying(true);
      setIndex(options().findIndex((candidate) => candidate.label === "Deny"));
      return;
    }
    answer(o.answer);
  };

  useKeyboard((key) => {
    if (!p.active || key.defaultPrevented) return;
    if (key.name === "escape") {
      key.preventDefault();
      return answer({ kind: "cancel" });
    }
    const list = options();
    if (list.length === 0 || denying()) return;
    if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      setIndex((i) => (i + (key.name === "down" ? 1 : -1) + list.length) % list.length);
    } else if (key.name === "return") {
      key.preventDefault();
      const o = list[index()];
      if (o) choose(o);
    } else if (/^[1-9]$/.test(key.name) && !key.ctrl && !key.meta) {
      const o = list[Number(key.name) - 1];
      if (o) {
        key.preventDefault();
        choose(o);
      }
    }
  });

  return (
    <box flexDirection="column" flexShrink={0} marginLeft={2} marginRight={2} border borderStyle="rounded" borderColor={t().warn} paddingLeft={1} paddingRight={1}>
      <text fg={t().warn}>
        {approval() ? "● Waiting for approval" : "● Waiting for your answer"}
        <Show when={labelled()}>
          <span style={{ fg: t().muted }}>{`  ${titleLine}`}</span>
        </Show>
        <Show when={head().step}>
          <span style={{ fg: t().muted }}>{`  ${head().step}`}</span>
        </Show>
        <Show when={p.more > 0}>
          <span style={{ fg: t().muted }}>{`  +${p.more} more`}</span>
        </Show>
      </text>
      <text fg={t().text} wrapMode="word">
        <b>{head().text}</b>
      </text>
      <Show when={detail()}>
        <box border={["left"]} borderColor={t().border} paddingLeft={1} marginTop={1} maxHeight={10}>
          <text fg={t().text2} wrapMode="char">
            {detail()}
          </text>
        </box>
      </Show>
      <Show
        when={options().length > 0}
        fallback={
          <box border={["left"]} borderColor={t().accent} paddingLeft={1} marginTop={1}>
            <textarea
              ref={(el: TextareaRenderable) => (input = el)}
              focused={p.active}
              initialValue={p.request.prefill ?? ""}
              placeholder={p.request.placeholder ?? "Type the answer…"}
              textColor={t().text}
              minHeight={1}
              maxHeight={p.request.kind === "editor" ? 12 : 4}
              keyBindings={[
                { name: "return", action: "submit" },
                { name: "return", shift: true, action: "newline" },
                { name: "linefeed", action: "newline" },
              ]}
              onSubmit={() => answer(p.request.kind === "editor" ? { kind: "editor", value: input?.plainText ?? "" } : { kind: "input", value: input?.plainText ?? "" })}
            />
          </box>
        }
      >
        <box flexDirection="column" marginTop={1}>
          <For each={options()}>
            {(o, i) => (
              <box flexDirection="column" onMouseDown={() => choose(o)}>
                <text fg={i() === index() ? t().text : t().text2}>
                  <span style={{ fg: i() === index() ? t().accent : t().muted }}>{i() === index() ? "› " : "  "}</span>
                  <span style={{ fg: o.recommended ? t().accent : t().muted }}>{i() < 9 ? `${i() + 1}. ` : "   "}</span>
                  {o.label}
                  <Show when={o.recommended}>
                    <span style={{ fg: t().accent }}>{"  recommended"}</span>
                  </Show>
                </text>
                <Show when={o.detail}>
                  <box paddingLeft={5}>
                    <text fg={t().muted} wrapMode="word">
                      {o.detail}
                    </text>
                  </box>
                </Show>
              </box>
            )}
          </For>
        </box>
        <Show when={denying()}>
          <box flexDirection="column" border={["left"]} borderColor={t().accent} paddingLeft={1} marginTop={1}>
            <text fg={t().muted}>Reason for denial (optional) — Enter sends Deny, Shift+Enter adds a line</text>
            <textarea
              ref={(el: TextareaRenderable) => (input = el)}
              focused={p.active && denying()}
              initialValue={denialReason()}
              onContentChange={() => {
                const current = input?.plainText ?? "";
                setDenialReason(current.slice(0, MAX_DENIAL_REASON_CHARS));
              }}
              placeholder="What should the agent change?"
              textColor={t().text}
              minHeight={1}
              maxHeight={5}
              keyBindings={[
                { name: "return", action: "submit" },
                { name: "return", shift: true, action: "newline" },
                { name: "linefeed", action: "newline" },
              ]}
              onSubmit={() => {
                const deny = options().find((o) => o.label === "Deny");
                if (deny) answer(deny.answer, input?.plainText.trim() || undefined);
              }}
            />
          </box>
        </Show>
      </Show>
      <text fg={t().muted}>{denying() ? "Enter denies · Shift+Enter new line · Esc dismisses" : options().length > 0 ? "↑↓ or 1–9 to choose · Deny opens a reason field · Esc dismisses" : "Enter sends · Shift+Enter new line · Esc dismisses"}</text>
    </box>
  );
}
