// The notice stack, drawn: cards behind one another, newest in front, fanned out
// into a list while the pointer or focus is on it. All the deciding (order, cap,
// merging, timers) is toast-stack.ts; this holds the state and the one timer,
// and a sideways swipe on a phone (gestures.ts) dismisses a card.
import { useCallback, useEffect, useRef, useState } from "react";
import { toastSwipe } from "../gestures.js";
import { IconX } from "../icons.js";
import { dismissToast, holdToasts, layoutToasts, nextDeadline, pushToast, releaseToasts, sweepToasts, type Toast, type ToastInput } from "../toast-stack.js";

export interface Toasts {
  stack: Toast[];
  push: (input: ToastInput) => void;
  dismiss: (id: string) => void;
  hold: () => void;
  release: () => void;
}

/** The stack's state and its timer. A pushed notice while the stack is held waits with the others. */
export function useToasts(): Toasts {
  const [stack, setStack] = useState<Toast[]>([]);
  const held = useRef(false);
  useEffect(() => {
    const next = nextDeadline(stack);
    if (next === null) return;
    const timer = window.setTimeout(() => setStack((s) => sweepToasts(s, Date.now())), Math.max(0, next - Date.now()) + 5);
    return () => window.clearTimeout(timer);
  }, [stack]);
  const push = useCallback((input: ToastInput) => setStack((s) => pushToast(s, input, Date.now(), held.current)), []);
  const dismiss = useCallback((id: string) => setStack((s) => dismissToast(s, id, Date.now())), []);
  const hold = useCallback(() => {
    held.current = true;
    setStack((s) => holdToasts(s, Date.now()));
  }, []);
  const release = useCallback(() => {
    held.current = false;
    setStack((s) => releaseToasts(s, Date.now()));
  }, []);
  return { stack, push, dismiss, hold, release };
}

export function ToastStack({ toasts, onOpen }: { toasts: Toasts; onOpen: (t: Toast) => void }) {
  const { cards, hidden } = layoutToasts(toasts.stack);
  // Fanned while the pointer is over it or focus is in it; the +N button also toggles it, for touch.
  const [pointer, setPointer] = useState(false);
  const [focus, setFocus] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = pointer || focus || pinned;
  const holding = pointer || focus || pinned;
  const { hold, release } = toasts;
  const frame = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = frame.current;
    if (!root || typeof ResizeObserver === "undefined") return;
    const place = () => {
      // News belongs in the conversation, never over the composer's prompt or its sticky bar.
      // On phones the status stack can grow, so use its real top edge rather than a fixed height.
      const composer = document.querySelector<HTMLElement>('[data-pane="main"] .composer');
      if (!composer) return;
      const top = composer.getBoundingClientRect().top;
      const fan = open ? cards.length * 50 : 6 * (cards.length - 1);
      const gap = 12;
      const y = Math.max(window.innerHeight - top + fan + gap, 30 + fan);
      root.style.setProperty("--toast-bottom", `${y}px`);
    };
    const observer = new ResizeObserver(place);
    const composer = document.querySelector('[data-pane="main"] .composer');
    if (composer) observer.observe(composer);
    const context = document.querySelector('[data-pane="main"] .chat-body');
    if (context) observer.observe(context);
    observer.observe(document.documentElement);
    place();
    return () => observer.disconnect();
  }, [cards.length, open]);
  useEffect(() => (holding ? hold() : release()), [holding, hold, release]);
  useEffect(() => {
    if (toasts.stack.length === 0) setPinned(false);
  }, [toasts.stack.length]);
  if (cards.length === 0) return null;
  return (
    <div
      className="toast-stack"
      data-testid="toast-stack"
      ref={frame}
      data-open={open}
      style={{ "--n": cards.length } as React.CSSProperties}
      onPointerEnter={(e) => e.pointerType === "mouse" && setPointer(true)}
      onPointerLeave={() => setPointer(false)}
      onFocus={() => setFocus(true)}
      onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setFocus(false)}
    >
      {cards.map(({ toast, slot }) => (
        <ToastCard key={toast.id} toast={toast} slot={slot} onOpen={() => onOpen(toast)} onDismiss={() => toasts.dismiss(toast.id)} />
      ))}
      {hidden > 0 ? (
        <button type="button" className="toast-more" aria-pressed={pinned} aria-label={`${hidden} more notices`} onClick={() => setPinned((v) => !v)}>
          +{hidden}
        </button>
      ) : null}
    </div>
  );
}

function ToastCard({ toast, slot, onOpen, onDismiss }: { toast: Toast; slot: number; onOpen: () => void; onDismiss: () => void }) {
  const drag = useRef<{ x: number; y: number } | null>(null);
  const { action, sessionId } = toast;
  const text = (
    <>
      {toast.text}
      {toast.count > 1 && !action ? <span className="toast-count"> ×{toast.count}</span> : null}
    </>
  );
  const setDx = (el: HTMLElement, dx: number | null) => (dx === null ? el.style.removeProperty("--dx") : el.style.setProperty("--dx", `${dx}px`));
  return (
    <div
      className="toast"
      role="status"
      // An Undo card is "toast" (what the mark-change specs look for); a news card is "notice", so one of each never clashes.
      data-testid={action ? "toast" : "notice"}
      data-leaving={toast.leaving ? "" : undefined}
      style={{ "--slot": slot } as React.CSSProperties}
      onKeyDown={(e) => e.key === "Escape" && onDismiss()}
      // A sideways swipe on a touch screen sends it away; a short one springs back.
      onPointerDown={(e) => {
        if (e.pointerType === "mouse") return;
        drag.current = { x: e.clientX, y: e.clientY };
        e.currentTarget.dataset.dragging = "";
      }}
      onPointerMove={(e) => {
        if (!drag.current) return;
        const dx = e.clientX - drag.current.x;
        if (Math.abs(dx) > Math.abs(e.clientY - drag.current.y)) setDx(e.currentTarget, dx);
      }}
      onPointerUp={(e) => {
        const start = drag.current;
        drag.current = null;
        delete e.currentTarget.dataset.dragging;
        if (!start) return;
        const dx = e.clientX - start.x;
        if (toastSwipe(dx, e.clientY - start.y) === "dismiss") onDismiss();
        else setDx(e.currentTarget, null);
      }}
      onPointerCancel={(e) => {
        drag.current = null;
        delete e.currentTarget.dataset.dragging;
        setDx(e.currentTarget, null);
      }}
    >
      {sessionId ? (
        <a
          className="toast-text"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onOpen();
            onDismiss();
          }}
        >
          {text}
        </a>
      ) : (
        <span className="toast-text">{text}</span>
      )}
      {action ? (
        <button
          type="button"
          className="btn btn-small btn-ghost"
          onClick={() => {
            action.run();
            onDismiss();
          }}
        >
          {action.label} <kbd>Ctrl+Z</kbd>
        </button>
      ) : null}
      <button type="button" className="icon-btn toast-close" aria-label="Dismiss" onClick={onDismiss}>
        <IconX size={12} />
      </button>
    </div>
  );
}
