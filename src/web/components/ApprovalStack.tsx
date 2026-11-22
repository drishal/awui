// Pending harness requests take over the composer card (DeepSeek Harness),
// with OpenCode's button order (Deny ghost, Approve primary on the right) and
// Hermes Desktop's stacked silhouettes when more requests are queued.
import { useEffect, useRef, useState } from "react";
import type { InteractionAnswer, InteractionFormData, InteractionRequest } from "../../shared/protocol.js";
import { MAX_DENIAL_REASON_CHARS } from "../../shared/protocol.js";
import { clampInteractionFormHeight, INTERACTION_FORM_MIN_HEIGHT, readInteractionFormCancel, readInteractionFormHeight, readInteractionFormSubmit } from "../../shared/interaction-form.js";
import { HTML_RENDER_THEME_MESSAGE, htmlRenderThemeFragment, htmlRenderThemeFromStyles, type HtmlRenderTheme } from "../../shared/html-render.js";
import { useNow } from "../hooks.js";
import { IconCheck, IconStop, IconX } from "../icons.js";
import type { FoldedRequest } from "../approval-fold.js";
import { approvalAnswers, isApproval } from "../../shared/approval.js";
import { choicesOf, splitStep } from "../questions.js";
import { Dot } from "./Dot.js";

function Countdown({ expiresAt }: { expiresAt: number }) {
  const now = useNow(true);
  return <span className="approval-countdown">{Math.max(0, Math.round((expiresAt - now) / 1000))}s</span>;
}

/**
 * An answered request's last moment: the card has fallen away and one quiet
 * line holds what was decided, its mark drawing itself. It leaves by itself;
 * the conversation keeps the real record (the request row).
 */
export function ApprovalFolded({ folded, onDone }: { folded: FoldedRequest; onDone: () => void }) {
  useEffect(() => {
    const t = setTimeout(onDone, 2600);
    return () => clearTimeout(t);
  }, [onDone]);
  return (
    <div className={`approval-folded${folded.ok ? "" : " is-no"}`} role="status" data-testid="approval-folded">
      <span className="approval-folded-mark" aria-hidden="true">
        {folded.ok ? <IconCheck size={14} /> : <IconX size={14} />}
      </span>
      <span className="approval-folded-text">{folded.text}</span>
    </div>
  );
}

/** A question as a list: one row per option, numbered (1–9 pick it), its description under it. */
function ChoiceList({ request, busy, onAnswer }: { request: InteractionRequest; busy: boolean; onAnswer: (answer: InteractionAnswer) => void }) {
  const list = useRef<HTMLOListElement>(null);
  const choices = choicesOf(request);
  const first = Math.max(0, choices.findIndex((c) => c.recommended));
  const buttons = () => [...(list.current?.querySelectorAll<HTMLButtonElement>(".choice") ?? [])];
  return (
    <ol
      ref={list}
      className="choice-list"
      aria-label="Options"
      onKeyDown={(e) => {
        const all = buttons();
        const at = all.indexOf(document.activeElement as HTMLButtonElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          all[(at + (e.key === "ArrowDown" ? 1 : -1) + all.length) % all.length]?.focus();
        }
      }}
    >
      {choices.map((c, i) => (
        <li key={`${i}:${c.value}`}>
          <button
            type="button"
            className={`choice${c.recommended ? " is-recommended" : ""}${c.other ? " is-other" : ""}`}
            disabled={busy}
            autoFocus={i === first}
            onClick={() => onAnswer({ kind: "select", value: c.value })}
          >
            <span className="choice-key" aria-hidden="true">
              {i < 9 ? i + 1 : ""}
            </span>
            <span className="choice-body">
              <span className="choice-label">
                {c.label}
                {c.recommended ? <span className="choice-tag">Recommended</span> : null}
              </span>
              {c.detail ? <span className="choice-detail">{c.detail}</span> : null}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}

/**
 * A `form` request (omp's ask tool): the harness's whole HTML form in an
 * opaque-origin frame. The frame posts the controls' values by name or a
 * cancel; nothing inside it can reach the app's session.
 */
function FormQuestion({
  request,
  stopping,
  src,
  onAnswer,
  onStop,
}: {
  request: InteractionRequest;
  stopping: boolean;
  src: string | null;
  onAnswer: (answer: InteractionAnswer) => void;
  onStop: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(INTERACTION_FORM_MIN_HEIGHT * 2);
  const [theme, setTheme] = useState<HtmlRenderTheme>(() => htmlRenderThemeFromStyles(getComputedStyle(document.documentElement)));
  // The URL's theme is the first paint's; later theme changes are posted, so a
  // reload never throws away answers already typed into the form.
  const [firstUrl] = useState(() => (src ? src + htmlRenderThemeFragment(htmlRenderThemeFromStyles(getComputedStyle(document.documentElement))) : null));

  useEffect(() => {
    const root = document.documentElement;
    const update = () => setTheme(htmlRenderThemeFromStyles(getComputedStyle(root)));
    const observer = new MutationObserver(update);
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme", "class", "style"] });
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    frame.current?.contentWindow?.postMessage({ method: HTML_RENDER_THEME_MESSAGE, theme }, "*");
  }, [theme]);
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      // Only the frame this card owns, and only from its opaque origin.
      if (event.source !== frame.current?.contentWindow || event.origin !== "null") return;
      if (readInteractionFormCancel(event.data)) {
        onAnswer({ kind: "cancel" });
        return;
      }
      const data: InteractionFormData | null = readInteractionFormSubmit(event.data);
      if (data) {
        onAnswer({ kind: "form", data });
        return;
      }
      const reported = readInteractionFormHeight(event.data);
      if (reported !== undefined) setHeight(clampInteractionFormHeight(reported));
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onAnswer]);

  if (!firstUrl) {
    return (
      <div className="approval-actions">
        <p className="approval-message">This form cannot be shown here; answer it from the chat that asked.</p>
        <span className="approval-spacer" />
        <button type="button" className="btn" onClick={() => onAnswer({ kind: "cancel" })}>
          Dismiss
        </button>
      </div>
    );
  }
  return (
    <>
      <div className="approval-form-frame" style={{ height }}>
        <iframe ref={frame} src={firstUrl} title={request.title || "Form question"} sandbox="allow-scripts allow-forms" />
      </div>
      <div className="approval-actions">
        <button type="button" className="btn btn-ghost btn-danger-text" onClick={onStop} disabled={stopping}>
          <IconStop size={12} /> {stopping ? "Stopping…" : "Stop"}
        </button>
        <span className="approval-spacer" />
        <span className="approval-hint">Fill in the form, then Submit</span>
      </div>
    </>
  );
}

export function ApprovalStack({
  pending,
  busy,
  stopping,
  onAnswer,
  onStop,
  formSrc,
}: {
  pending: InteractionRequest[];
  busy: boolean;
  stopping: boolean;
  onAnswer: (request: InteractionRequest, answer: InteractionAnswer, denialReason?: string) => void;
  onStop: () => void;
  /** The document URL for a `form` request; absent when this surface cannot frame one. */
  formSrc?: (request: InteractionRequest) => string | null;
}) {
  const request = pending[0] as InteractionRequest;
  const [value, setValue] = useState(request.secret ? "" : (request.prefill ?? ""));
  const [denialReason, setDenialReason] = useState("");
  useEffect(() => {
    setValue(request.secret ? "" : (request.prefill ?? ""));
    setDenialReason("");
  }, [request.id, request.prefill, request.secret]);
  const approval = isApproval(request);
  const [titleLine = "", ...restLines] = request.title.split("\n");
  const message = request.message?.trim() ?? "";
  const question = request.kind === "select" && !approval;
  // A question's short title is a label (Claude Code's "Approach"); its message is the question itself.
  const labelled = question && message !== "" && restLines.length === 0 && titleLine.length <= 32;
  const { text: headline, step } = splitStep(labelled ? message : titleLine);
  const detail = labelled ? "" : [restLines.join("\n").trim(), message].filter(Boolean).join("\n\n");
  const behind = Math.min(pending.length - 1, 2);
  const answers = approvalAnswers(request);

  return (
    <div className={`approval-stack behind-${behind}`} data-testid="approval-card">
      <section
        className="approval-card"
        aria-label="The agent is waiting for you"
        role="group"
        onKeyDown={(e) => {
          if (!question || busy || e.ctrlKey || e.metaKey || e.altKey || !/^[1-9]$/.test(e.key)) return;
          if ((e.target as HTMLElement).closest("input, textarea")) return;
          const option = request.options?.[Number(e.key) - 1];
          if (option === undefined) return;
          e.preventDefault();
          onAnswer(request, { kind: "select", value: option });
        }}
      >
        <header className="approval-strip">
          <span className="approval-dot" aria-hidden="true" />
          <span>{approval ? "Waiting for approval" : "Waiting for your answer"}</span>
          {labelled ? <span className="approval-chip">{titleLine}</span> : null}
          {step ? <span className="approval-chip">{step}</span> : null}
          {request.expiresAt ? <Countdown expiresAt={request.expiresAt} /> : null}
          {pending.length > 1 ? <span className="approval-more">{pending.length - 1} more</span> : null}
        </header>
        <div className="approval-headline">{headline}</div>
        {detail ? question ? <p className="approval-message">{detail}</p> : <pre className="approval-detail">{detail}</pre> : null}

        {request.kind === "form" ? (
          <FormQuestion key={request.id} request={request} stopping={stopping} src={formSrc?.(request) ?? null} onAnswer={(answer) => onAnswer(request, answer)} onStop={onStop} />
        ) : request.kind === "input" || request.kind === "editor" ? (
          <form
            className="approval-form"
            onSubmit={(e) => {
              e.preventDefault();
              onAnswer(request, request.kind === "input" ? { kind: "input", value } : { kind: "editor", value });
            }}
          >
            {request.kind === "input" ? (
              <input
                className="input"
                type={request.secret ? "password" : "text"}
                value={value}
                placeholder={request.placeholder ?? ""}
                onChange={(e) => setValue(e.target.value)}
                aria-label={headline ?? "Answer"}
                autoComplete="off"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                autoFocus
              />
            ) : (
              <textarea className="input approval-editor" value={value} onChange={(e) => setValue(e.target.value)} aria-label={headline ?? "Text"} rows={8} autoFocus />
            )}
            <div className="approval-actions">
              <button type="button" className="btn btn-ghost btn-danger-text" onClick={onStop} disabled={stopping}>
                <IconStop size={12} /> {stopping ? "Stopping…" : "Stop"}
              </button>
              <span className="approval-spacer" />
              <button type="button" className="btn" disabled={busy} onClick={() => onAnswer(request, { kind: "cancel" })}>
                Cancel
              </button>
              <button type="submit" className="btn btn-primary" disabled={busy}>
                Submit
              </button>
            </div>
          </form>
        ) : approval ? (
          <>
            <div className="approval-denial-reason">
              <textarea
                id={`denial-reason-${request.id}`}
                className="input"
                value={denialReason}
                onChange={(e) => setDenialReason(e.target.value)}
                maxLength={MAX_DENIAL_REASON_CHARS}
                rows={2}
                aria-label="Reason for denial (optional)"
                placeholder="Reason for denial (optional) — sent with Deny"
              />
            </div>
            <div className="approval-actions">
              <button type="button" className="btn btn-ghost btn-danger-text" onClick={onStop} disabled={stopping}>
                <IconStop size={12} /> {stopping ? "Stopping…" : "Stop"}
              </button>
              <span className="approval-spacer" />
              {/* Bordered: Deny is a real choice beside Approve, not a dismiss link. */}
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => answers && onAnswer(request, answers.deny, denialReason.trim() || undefined)}
              >
                Deny
              </button>
              <button
                type="button"
                className="btn btn-primary"
                disabled={busy}
                autoFocus
                onClick={() => answers && onAnswer(request, answers.approve)}
              >
                Approve
              </button>
            </div>
          </>
        ) : (
          <>
            <ChoiceList request={request} busy={busy} onAnswer={(a) => onAnswer(request, a)} />
            <div className="approval-foot">
              <button type="button" className="btn btn-small btn-ghost btn-danger-text" onClick={onStop} disabled={stopping}>
                <IconStop size={11} /> {stopping ? "Stopping…" : "Stop"}
              </button>
              <span className="approval-hint">
                {(request.options?.length ?? 0) > 1 ? (
                  <>
                    1–{Math.min(9, request.options?.length ?? 0)} to choose
                    <Dot />
                  </>
                ) : null}
                ↑↓ to move
              </span>
              <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => onAnswer(request, { kind: "cancel" })}>
                Dismiss
              </button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
