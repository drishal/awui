import { useEffect, useRef, useState } from "react";
import { useSwipeDown } from "../gestures.js";

/**
 * Native modal <dialog>: focus trap, Escape, and inert background for free.
 * On a phone it is a bottom sheet (styles/phones.css): a handle on top, and a drag
 * down on the handle or the title closes it.
 */
export function Dialog({
  title,
  onClose,
  children,
  className,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const grip = useRef<HTMLDivElement>(null);
  const [leaving, setLeaving] = useState(false);
  const closing = useRef(false);
  const deadline = useRef(0);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const finish = () => {
    if (closing.current) return;
    closing.current = true;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) { onCloseRef.current(); return; }
    setLeaving(true);
    const generation = ++deadline.current;
    window.setTimeout(() => { if (generation === deadline.current) onCloseRef.current(); }, 120);
  };
  useSwipeDown(grip, body, finish);
  // A sheet opened by a long press must not close on the tap the browser may send when the finger lifts.
  const openedAt = useRef(0);
  useEffect(() => {
    const el = ref.current;
    openedAt.current = Date.now();
    closing.current = false;
    deadline.current += 1;
    setLeaving(false);
    if (el && !el.open) el.showModal();
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      ++deadline.current;
      el?.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      className={`dialog${className ? ` ${className}` : ""}${leaving ? " is-leaving" : ""}`}
      aria-label={title}
      inert={leaving || undefined}
      onCancel={(e) => {
        e.preventDefault();
        finish();
      }}
      onClick={(e) => {
        if (e.target === ref.current && Date.now() - openedAt.current > 350) finish();
      }}
    >
      <div className="dialog-body" ref={body}>
        <div ref={grip} className="sheet-grip">
          <div className="sheet-handle" aria-hidden="true" />
          <header className="dialog-head">
            <h2>{title}</h2>
            <button type="button" className="icon-btn" aria-label="Close" onClick={finish}>
              ✕
            </button>
          </header>
        </div>
        {children}
      </div>
    </dialog>
  );
}
