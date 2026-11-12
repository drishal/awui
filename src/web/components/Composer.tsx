// The composer card (DeepSeek Harness): text on top, settings and actions in
// the bottom row, a status stack above, approvals taking over the card. From
// T3 Code: ↑/↓ recall this chat's prompts, Shift+Enter continues a Markdown
// list (Tab indents it), the stash parks a draft for later (Alt+S), a prompt
// link's text arrives with a note to read it, and a run stopped on a usage
// limit offers to continue when the limit resets. A dropped file that is not
// an image becomes an `@path` reference when the project has it (matched by
// name: file-drop.ts), else offers to be added to the project first.
import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { type ChainStep, type ConfigPatch, type DelegatedTaskView, IMAGE_MIME_TYPES, type HarnessStatus, type ImageAttachment, type InteractionAnswer, MAX_IMAGES, MAX_PASTE_BYTES, type PasteAttachment, type QueueState, type SendMode, type SlashCommand, type UsageLimits } from "../../shared/protocol.js";
import { api, errorText, idempotencyKey } from "../api.js";
import type { ChatState } from "../chat-state.js";
import { APP_COMMANDS, isSkill, mergeCommands, skillMenu, skillName, slashMenu } from "../commands.js";
import { blanks, matchPrompts, nextBlank, promptGist } from "../prompt-blanks.js";
import { managePrompts, useSavedPrompts } from "../saved-prompts.js";
import { IconArrowUp, IconChevronDown, IconImage, IconLink, IconPlan, IconPlus, IconSpark, IconScreen, IconStash, IconStop, IconTerminal, IconX, Spinner } from "../icons.js";
import { draftImages, saveDraftImages } from "../draft-images.js";
import { dataUrl, imageFiles, type PendingImage, pendingImage, prepareImage } from "../images.js";
import { addQuestion, dropHint, insertReference, matchProjectFile, MAX_CHOICES, otherFiles, uploadProblem } from "../file-drop.js";
import { UploadError, uploadToProject } from "../upload.js";
import { canCaptureScreen, captureScreen } from "../screen-capture.js";
import { ImageViewer, imageSize } from "./ImageViewer.js";
import { load, save } from "../storage.js";
import { ApprovalFolded, ApprovalStack } from "./ApprovalStack.js";
import { type FoldedRequest, foldRequest } from "../approval-fold.js";
import { ChipEditor, type ChipEditorHandle } from "./ChipEditor.js";
import { ComposerControls } from "./ComposerControls.js";
import { ContextRing } from "./ContextRing.js";
import { StatusStack } from "./StatusStack.js";
import { useAddImagesToDraft, useAddToDraft, useLinkedPrompt } from "../draft-bus.js";
import { recallStep, sentPrompts, type Recall } from "../prompt-history.js";
import { continueList, indentList } from "../list-continue.js";
import { loadStash, saveStash, stashDraft, takeFromStash, type StashEntry } from "../stash.js";
import { CONTINUE_TEXT, limitStop } from "../../shared/limit-stop.js";
import { LimitRecovery } from "./LimitRecovery.js";
import { DirenvNote } from "./DirenvNote.js";
import { ColdResumeHint } from "./ColdResumeHint.js";
import { RotationHint } from "./RotationHint.js";
import { COLD_RESUME_OFF_KEY, coldResumeHint, lastActivity } from "../cold-resume.js";
import { ROTATION_OFF_KEY, chatRotation } from "../rotation.js";
import { useDismiss, useLeave, useMediaQuery, useMorph, useNow } from "../hooks.js";
import { composerFolded } from "../composer-fold.js";
import { DirenvRow, GitPanel, GitRow } from "./GitStatusView.js";
import { useGitStatus } from "../git.js";
import { jobProgress } from "../job-progress.js";
import { chatJobs, FINISHED_SHOWN_MS, shownJobs } from "../jobs.js";
import { Dot, dotted } from "./Dot.js";

/** What glides when the phone's card folds or opens: the box, the + and the right-hand buttons. */
const MORPH_PARTS = [".composer-input", ".composer-attach", ".composer-actions"] as const;

/** The prompt box's drag limits: a line, or most of a screen. */
const MIN_PROMPT_H = 26;
const MAX_PROMPT_H = 420;

/** Paste larger than this many UTF-16 chars offers "attach as file" instead of filling the box. */
const PASTE_FILE_OFFER = 12_000;

/** Context share (%) from which the chip is offered, and from which it starts on. */
const COMPACT_OFFER = 50;
const COMPACT_DEFAULT = 80;

const formatTokens = (n: number): string => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

const coarsePointer = () => typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;

const draftPastes = new Map<string, PasteAttachment[]>();

/** An executor owns deliberate closing and pane transfer; render lifecycles do not delete files. */
export function releasePastes(chatId: string): PasteAttachment[] {
  const pastes = draftPastes.get(chatId) ?? [];
  draftPastes.delete(chatId);
  return pastes;
}

/** Needed before the position changes; only a real exchange asks for it. */
interface MutableDraftRef {
  current: (() => void) | null;
}

/** Let React coordinate delivery; no file cleanup during effect remount. */

export function Composer({
  chat,
  harnesses,
  maxChars,
  hero,
  placeholder,
  onSend,
  onStop,
  onCompact,
  onRotate,
  onAnswer,
  onConfig,
  onRefreshModels,
  onHandoff,
  onNewChat,
  limits,
  draftTransfer,
  side = false,
  onOpenTask,
  onCancelTask,
}: {
  chat: ChatState;
  harnesses: HarnessStatus[];
  maxChars: number;
  hero?: boolean;
  placeholder?: string;
  onSend: (text: string, mode: SendMode, images: ImageAttachment[], options?: { compactFirst?: boolean; attachments?: string[]; idempotencyKey?: string }) => Promise<boolean>;
  onStop: () => void;
  /** Compact this chat (the same route the palette's Compact context and /compact run); the cold-resume hint needs it. */
  onCompact?: () => void;
  /** Start a fresh session from this chat's transcript (the rotation offer); absent where the pane does not offer it. */
  onRotate?: () => void;
  onAnswer: (requestId: string, answer: InteractionAnswer) => Promise<void>;
  onConfig: (patch: ConfigPatch) => Promise<void>;
  onRefreshModels: () => Promise<void>;
  onHandoff: (harnessId: string, draft: string) => Promise<void>;
  /** Ctrl+Alt+Enter: once the message is sent, open a new chat. */
  onNewChat?: () => void;
  /** The subscriptions' limits: where a stop on a usage limit learns when it resets. */
  limits?: UsageLimits | null;
  /** The mounted destination uses this to publish its current draft for explicit swap. */
  draftTransfer?: React.MutableRefObject<(() => void) | null>;
  side?: boolean;
  /** A delegated task's row: Open shows its child chat, Cancel stops it. The caller binds this chat's id. */
  onOpenTask?: (task: DelegatedTaskView) => void;
  onCancelTask?: (task: DelegatedTaskView) => void;
}) {
  const draftKey = `draft.${chat.chatId}`;
  const [text, setText] = useState(() => load<string>(draftKey, ""));
  const [sending, setSending] = useState(false);
  // One idempotency key per send attempt: the same prompt sent again after a failure reuses it
  // (so a lost answer cannot send twice), while any edit is a new message with a new key.
  const attempt = useRef<{ key: string; text: string; mode: SendMode; images: PendingImage[]; pastes: PasteAttachment[]; compactFirst: boolean } | null>(null);
  const [answering, setAnswering] = useState(false);
  const [folded, setFolded] = useState<FoldedRequest | null>(null);
  const { git, direnv, at: gitAt, refresh: refreshGit } = useGitStatus(chat.chatId, chat.status);
  const [gitOpen, setGitOpen] = useState(false);
  // Images are per chat like the text draft: the composer remounts on a tab switch
  // (App.tsx keys it by chatId), and a draft's pictures must come back with it.
  const [images, setImages] = useState<PendingImage[]>(() => draftImages(chat.chatId));
  const [imageError, setImageError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState(false);
  // A big pasted blob the user chose to send as a file instead of inline text.
  const [pastes, setPastes] = useState<PasteAttachment[]>(() => releasePastes(chat.chatId));
  useEffect(() => {
    if (!draftTransfer) return;
    draftTransfer.current = () => {
      draftPastes.set(chat.chatId, pastes);
      save(`draft.${chat.chatId}`, text);
      saveDraftImages(chat.chatId, images);
    };
  }, [draftTransfer, chat.chatId, text, images, pastes]);
  // The oversized paste awaiting the user's choice (inline vs file).
  const [pendingPaste, setPendingPaste] = useState<string | null>(null);
  const [pasteBusy, setPasteBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  // What the drag in flight says on the card: files that are not images are for referencing.
  const [dragHint, setDragHint] = useState("");
  const [viewing, setViewing] = useState<number | null>(null);
  const thumbs = useRef(new Map<number, HTMLElement>());
  const area = useRef<ChipEditorHandle>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  // In the box, or still on something inside the card: the folded phone card stays open (composer-fold.ts).
  const [writing, setWriting] = useState(false);
  const touching = useRef(false);
  // The divider above the card (pi-vot's): drag it up for a taller prompt. The
  // height is the textarea's, kept per device; double-click or the keyboard resets.
  const [promptHeight, setPromptHeight] = useState<number | null>(() => load<number | null>("composerHeight", null));
  const dragFrom = useRef<{ y: number; height: number } | null>(null);
  const promptHeightNow = () => promptHeight ?? area.current?.offsetHeight ?? MIN_PROMPT_H;
  const clampPrompt = (height: number) => Math.min(MAX_PROMPT_H, Math.max(MIN_PROMPT_H, Math.round(height)));
  const resizeTo = (height: number) => {
    const next = clampPrompt(height);
    setPromptHeight(next);
    save("composerHeight", next);
  };
  const filePicker = useRef<HTMLInputElement>(null);
  const caps = chat.capabilities;
  const running = chat.status === "running";
  const stopping = chat.status === "stopping";
  const busy = running || stopping || chat.status === "compacting";
  const closed = chat.status === "disposed";
  // Capturing a window is a desktop gesture; on a phone the picker would offer the phone itself.
  const canCapture = useMemo(() => canCaptureScreen() && !coarsePointer(), []);

  useEffect(() => {
    save(draftKey, text);
  }, [draftKey, text]);

  useEffect(() => {
    saveDraftImages(chat.chatId, images);
  }, [chat.chatId, images]);

  useEffect(() => {
    draftPastes.set(chat.chatId, pastes);
  }, [chat.chatId, pastes]);

  const tooLong = text.length > maxChars;

  // ↑/↓ walk this chat's sent prompts (prompt-history.ts); an edit ends the walk.
  const recall = useRef<Recall | null>(null);
  // Where the caret goes once a text set by a key (recall, a list, the stash) has rendered.
  const caretAfter = useRef<[number, number] | null>(null);
  useLayoutEffect(() => {
    const at = caretAfter.current;
    const el = area.current;
    if (!at || !el) return;
    caretAfter.current = null;
    el.setSelectionRange(at[0], at[1]);
  }, [text]);
  const setTextAt = (next: string, from: number, to = from) => {
    caretAfter.current = [from, to];
    setText(next);
  };

  // A prompt link's text: into an empty composer (else after the draft), with a note to read it first.
  const [linked, setLinked] = useState<{ hidden: number } | null>(null);
  useLinkedPrompt((prompt) => {
    setText((current) => (current.trim() ? `${current.replace(/\s*$/, "")}\n\n${prompt.text}` : prompt.text));
    setLinked({ hidden: prompt.hidden });
    window.requestAnimationFrame(() => area.current?.focus());
  }, !side);

  useAddToDraft((added) => {
    setText((current) => (current.trim() ? `${current.replace(/\s*$/, "")}\n\n${added}` : added));
    window.requestAnimationFrame(() => {
      const el = area.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(el.value.length, el.value.length);
    });
  }, !side);

  // Compact before send (T3 Code's chip): offered once the context is half full, on by
  // default from COMPACT_DEFAULT; the choice lasts until a message goes.
  const percent = chat.context?.percent ?? null;
  const offerCompact = caps.supportsCompact && chat.context?.tokens != null && percent !== null && percent >= COMPACT_OFFER;
  const [compactChoice, setCompactChoice] = useState<boolean | null>(null);
  const compactFirst = offerCompact && (compactChoice ?? (percent ?? 0) >= COMPACT_DEFAULT);

  // Cold resume (cold-resume.ts): offered when the chat sat idle past its prompt cache's expiry, never
  // run by itself. The minute tick is what shows it to a tab that has been sitting open.
  const [coldOff, setColdOff] = useState(() => load(COLD_RESUME_OFF_KEY, false));
  // Rotation (rotation.ts): a fresh session seeded from this transcript once the context is nearly
  // full. Offered only where the pane can open the new chat and the harness can seed one.
  const [rotateOff, setRotateOff] = useState(() => load(ROTATION_OFF_KEY, false));
  const rotate = onRotate ? chatRotation(chat, { off: rotateOff }) : null;
  const coldNow = useNow(!coldOff && caps.supportsCompact, 60_000);
  const cold = coldResumeHint({
    lastActivityAt: lastActivity(chat.items),
    usage: chat.usage,
    contextTokens: chat.context?.tokens ?? null,
    supportsCompact: caps.supportsCompact,
    off: coldOff,
    now: coldNow,
  });

  const submit = useCallback(
    async (mode: SendMode) => {
      const value = text.trim();
      if (!value || sending || tooLong) return false;
      // Clear immediately so text typed while the request is in flight survives;
      // restore only if the send failed and nothing new was typed or attached.
      const attached = images;
      const pasted = pastes;
      // The same words, mode, and attachments as the attempt that just failed: this is its retry.
      const prior = attempt.current;
      const key = prior && prior.text === value && prior.mode === mode && prior.images === attached && prior.pastes === pasted && prior.compactFirst === compactFirst ? prior.key : idempotencyKey();
      attempt.current = { key, text: value, mode, images: attached, pastes: pasted, compactFirst };
      setSending(true);
      setText("");
      setImages([]);
      setPastes([]);
      setImageError(null);
      setLinked(null);
      setFileNote(null);
      recall.current = null;
      const ok = await onSend(
        value,
        mode,
        attached.map(({ mimeType, data }) => ({ mimeType, data })),
        { ...(mode === "normal" && compactFirst ? { compactFirst: true } : {}), ...(pasted.length > 0 ? { attachments: pasted.map((p) => p.id) } : {}), idempotencyKey: key },
      );
      setSending(false);
      if (ok) {
        setCompactChoice(null);
        attempt.current = null;
      }
      if (!ok) {
        setText((current) => current || value);
        setImages((current) => (current.length > 0 ? current : attached));
        setPastes((current) => (current.length > 0 ? current : pasted));
      }
      area.current?.focus();
      return ok;
    },
    [onSend, sending, text, images, pastes, compactFirst],
  );

  /** Park the oversized paste as a file on the server and chip it. */
  const attachPaste = async () => {
    if (!pendingPaste || pasteBusy) return;
    setPasteBusy(true);
    setImageError(null);
    try {
      const blob = pendingPaste;
      if (new TextEncoder().encode(blob).length > MAX_PASTE_BYTES) {
        setImageError("That paste is larger than the 1 MiB file limit");
        return;
      }
      const pasted = await api<PasteAttachment>(`/api/chats/${chat.chatId}/pastes`, { body: { text: blob } });
      setPastes((current) => [...current, pasted].slice(0, 4));
      setPendingPaste(null);
    } catch (error) {
      setImageError(error instanceof Error ? error.message : String(error));
    } finally {
      setPasteBusy(false);
      area.current?.focus();
    }
  };

  /** The user wants it inline after all. */
  const inlinePaste = () => {
    if (pendingPaste === null) return;
    setText((current) => current + pendingPaste);
    setPendingPaste(null);
    area.current?.focus();
  };

  const addImages = async (files: File[]) => {
    if (files.length === 0) return;
    setImageError(null);
    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      setImageError(`Up to ${MAX_IMAGES} images per message`);
      return;
    }
    const added: PendingImage[] = [];
    for (const file of files.slice(0, room)) {
      try {
        added.push(await prepareImage(file));
      } catch (error) {
        setImageError(error instanceof Error ? error.message : String(error));
      }
    }
    if (files.length > room) setImageError(`Up to ${MAX_IMAGES} images per message`);
    setImages((current) => [...current, ...added].slice(0, MAX_IMAGES));
    area.current?.focus();
  };

  // A window or screen, captured straight into the draft (screen-capture.ts).
  const captureIntoComposer = async () => {
    setImageError(null);
    setCapturing(true);
    try {
      const file = await captureScreen();
      if (file) await addImages([file]);
    } catch (error) {
      setImageError(error instanceof Error ? error.message : String(error));
    } finally {
      setCapturing(false);
    }
  };
  // Images from elsewhere: what another app shared to awui.
  useAddImagesToDraft((files) => void addImages(files), !side);

  // The stash (stash.ts): park this draft, or take one back (what is here then goes in its place).
  const [stash, setStash] = useState<StashEntry[]>(loadStash);
  const [stashOpen, setStashOpen] = useState(false);
  const { render: showStash, leaving: stashLeaving } = useLeave(stashOpen);
  const stashRef = useRef<HTMLDivElement>(null);
  // Escape closes it wherever the focus is; the focus starts on its first item that can be used.
  useDismiss(stashRef, stashOpen, () => setStashOpen(false), { escape: true, outside: false });
  useEffect(() => {
    if (stashOpen) stashRef.current?.querySelector<HTMLElement>('[role="menuitem"]:not(:disabled)')?.focus();
  }, [stashOpen]);
  const [stashNote, setStashNote] = useState<string | null>(null);
  useEffect(() => {
    if (!stashNote) return;
    const t = window.setTimeout(() => setStashNote(null), 2500);
    return () => window.clearTimeout(t);
  }, [stashNote]);
  const from = chat.title || "New chat";
  const stashNow = () => {
    const next = stashDraft(loadStash(), { text, images, from });
    if (!next) return;
    if (!saveStash(next)) {
      setImageError("The browser's storage is full: the draft stays here");
      return;
    }
    const dropped = next[0]?.dropped ?? 0;
    setStash(next);
    setStashOpen(false);
    setText("");
    setImages([]);
    setLinked(null);
    setStashNote(dropped > 0 ? `Stashed; ${dropped} image${dropped === 1 ? " was" : "s were"} too big to keep` : "Stashed");
  };
  const unstash = (id: string) => {
    const { entries, entry } = takeFromStash(loadStash(), id);
    if (!entry) return;
    const swapped = stashDraft(entries, { text, images, from }) ?? entries;
    saveStash(swapped);
    setStash(swapped);
    setStashOpen(false);
    setTextAt(entry.text, entry.text.length);
    setImages(entry.images.map(pendingImage).slice(0, MAX_IMAGES));
    area.current?.focus();
  };
  const dropStashed = (id: string) => {
    const { entries } = takeFromStash(loadStash(), id);
    saveStash(entries);
    setStash(entries);
  };

  // An edited or removed queued message (StatusStack): the whole queue goes back to the harness.
  // The chain (the server's): steps that run once this run is over, even with the page closed.
  const name = (id: string) => harnesses.find((h) => h.id === id)?.displayName ?? id;
  const setChain = async (steps: ChainStep[], resume = false): Promise<boolean> => {
    try {
      const plain = steps.map((s) => (s.kind === "send" ? { kind: s.kind, text: s.text } : { kind: s.kind, harness: s.harness, ...(s.prompt ? { prompt: s.prompt } : {}) }));
      await api(`/api/chats/${chat.chatId}/chain`, { method: "PUT", body: { steps: plain, ...(resume ? { resume: true } : {}) } });
      return true;
    } catch (error) {
      setImageError(errorText(error));
      return false;
    }
  };
  const [thenMenu, setThenMenu] = useState(false);
  const { render: showThen, leaving: thenLeaving } = useLeave(thenMenu);
  /** The draft as the chain's next step: sent when the run before it is over (or, with `harness`, a handoff carrying it). */
  const addThen = async (harness?: string) => {
    const draft = text.trim();
    if (!harness && !draft) return;
    const step = harness ? { id: "", kind: "handoff" as const, harness, ...(draft ? { prompt: draft } : {}) } : { id: "", kind: "send" as const, text: draft };
    if (await setChain([...chat.chain, step])) {
      // Only what went into the step: anything typed while it was on its way stays.
      setText((current) => (current.trim() === draft ? "" : current));
      setThenMenu(false);
    }
  };

  const editQueue = caps.supportsQueueEdit
    ? async (queue: QueueState): Promise<boolean> => {
        try {
          await api(`/api/chats/${chat.chatId}/queue`, { method: "PUT", body: queue });
          return true;
        } catch (error) {
          setImageError(errorText(error));
          return false;
        }
      }
    : undefined;

  const onPaste = (e: React.ClipboardEvent<HTMLDivElement>) => {
    const files = imageFiles(e.clipboardData.files);
    // Spreadsheets and rich editors copy a rendering beside the text; paste the text then.
    if (files.length === 0 || e.clipboardData.getData("text/plain")) {
      // A big text blob would flood the box and the context; offer sending it as a file.
      const blob = e.clipboardData.getData("text/plain");
      if (blob.length > PASTE_FILE_OFFER) {
        e.preventDefault();
        setPendingPaste(blob);
      }
      return;
    }
    e.preventDefault();
    void addImages(files);
  };

  const hasFiles = (e: React.DragEvent) => e.dataTransfer.types.includes("Files");

  // Dropped files that are not images (file-drop.ts): `@path` for one the project has, a choice between
  // several of that name, an offer to add one it lacks. The text is read through a ref, since the
  // answers arrive after requests and the draft may have moved on.
  const [choices, setChoices] = useState<Array<{ name: string; paths: string[] }>>([]);
  const [missing, setMissing] = useState<File[]>([]);
  const [fileNote, setFileNote] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const draftNow = useRef(text);
  draftNow.current = text;
  /** Where the next reference goes: the caret when the files came, then after each one put in. */
  const referenceAt = useRef(0);
  const reference = (path: string) => {
    const at = Math.min(referenceAt.current, draftNow.current.length);
    const next = insertReference(draftNow.current, at, at, `@${path}`);
    draftNow.current = next.text;
    referenceAt.current = next.caret;
    setTextAt(next.text, next.caret);
    window.requestAnimationFrame(() => area.current?.focus());
  };
  const referenceFiles = async (files: File[]) => {
    if (files.length === 0) return;
    setFileNote(null);
    referenceAt.current = area.current?.selectionEnd ?? draftNow.current.length;
    const notes: string[] = [];
    const absent: File[] = [];
    const ask: Array<{ name: string; paths: string[] }> = [];
    for (const file of files) {
      try {
        const { files: listed } = await api<{ files: string[] }>(`/api/workspaces/${encodeURIComponent(chat.workspace.id)}/files?q=${encodeURIComponent(file.name)}`);
        const match = matchProjectFile(file.name, listed);
        if (match.kind === "one") reference(match.path);
        else if (match.kind === "many") ask.push({ name: file.name, paths: match.paths });
        else {
          const problem = uploadProblem(file);
          if (problem) notes.push(problem);
          else absent.push(file);
        }
      } catch (error) {
        notes.push(`${file.name}: ${errorText(error)}`);
      }
    }
    if (ask.length > 0) setChoices((current) => [...current, ...ask]);
    if (absent.length > 0) setMissing((current) => [...current, ...absent]);
    if (notes.length > 0) setFileNote(notes.join(". "));
  };
  const addMissing = async () => {
    const files = missing;
    setAdding(true);
    setFileNote(null);
    const notes: string[] = [];
    for (const file of files) {
      try {
        reference(await uploadToProject(chat.workspace.id, file));
      } catch (error) {
        // A file by that name is there already (the list leaves out what git ignores): refer to it all the same.
        if (error instanceof UploadError && error.status === 409) {
          reference(file.name.trim());
          notes.push(`${file.name} was already in the project; referenced it`);
        } else notes.push(`${file.name}: ${errorText(error)}`);
      }
    }
    setMissing([]);
    setAdding(false);
    if (notes.length > 0) setFileNote(notes.join(". "));
  };

  // The "/" menu (Hermes Desktop's): open while the first word is still being typed.
  // "$" is the skills' own menu, where the harness has any (elsewhere a "$" is just typed).
  const [commands, setCommands] = useState<SlashCommand[] | null>(null);
  const [menuIndex, setMenuIndex] = useState(0);
  const [menuDismissed, setMenuDismissed] = useState(false);
  const menuId = useId();
  const slashQuery = /^\/(\S*)$/.exec(text)?.[1];
  const skillQuery = /^\$(\S*)$/.exec(text)?.[1];
  // "#" lists the saved prompts (the server's, for every device), where there are any.
  const savedPrompts = useSavedPrompts();
  const promptQuery = /^#(\S*)$/.exec(text)?.[1];
  const skillCount = commands ? commands.filter(isSkill).length : 0;
  const menuKind =
    closed || menuDismissed
      ? null
      : slashQuery !== undefined
        ? "slash"
        : skillQuery !== undefined && skillCount > 0
          ? "skill"
          : promptQuery !== undefined && (savedPrompts?.length ?? 0) > 0
            ? "prompt"
            : null;
  const menuOpen = menuKind !== null;
  const { render: renderMenu, leaving: menuLeaving } = useLeave(menuOpen);
  const promptMatches = menuKind === "prompt" ? matchPrompts(savedPrompts ?? [], promptQuery ?? "") : [];
  const menuItems =
    menuKind === "slash"
      ? slashMenu(commands ?? APP_COMMANDS, slashQuery ?? "")
      : menuKind === "skill"
        ? skillMenu(commands ?? [], skillQuery ?? "")
        : promptMatches.map((p): SlashCommand => ({ name: p.name, description: promptGist(p), source: "saved" }));
  const activeCommand = menuItems[Math.min(menuIndex, menuItems.length - 1)];
  // The furl keeps showing what was open: while it plays, menuKind is already null.
  const lastMenu = useRef({ kind: menuKind, items: menuItems });
  useEffect(() => {
    if (menuOpen) lastMenu.current = { kind: menuKind, items: menuItems };
  }, [menuOpen, menuKind, menuItems]);
  const renderKind = menuOpen ? menuKind : lastMenu.current.kind;
  const renderItems = menuOpen ? menuItems : lastMenu.current.items;
  const wantsCommands = (slashQuery !== undefined || skillQuery !== undefined) && !closed;

  useEffect(() => {
    if (!wantsCommands || commands !== null) return;
    let cancelled = false;
    api<{ commands: SlashCommand[] }>(`/api/chats/${chat.chatId}/commands`).then(
      (r) => !cancelled && setCommands(mergeCommands(r.commands)),
      () => !cancelled && setCommands(mergeCommands([])),
    );
    return () => {
      cancelled = true;
    };
  }, [wantsCommands, commands, chat.chatId]);

  useEffect(() => {
    setMenuIndex(0);
    if (slashQuery === undefined && skillQuery === undefined && promptQuery === undefined) setMenuDismissed(false);
  }, [slashQuery, skillQuery, promptQuery]);

  useEffect(() => {
    if (menuOpen) document.getElementById(`${menuId}-${menuIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [menuOpen, menuIndex, menuId]);

  const completeCommand = (c: SlashCommand) => {
    if (menuKind === "prompt") {
      const p = promptMatches.find((x) => x.name === c.name);
      if (p) insertPrompt(p.text);
      return;
    }
    setText(`/${c.name} `);
    area.current?.focus();
  };
  /** A saved prompt replaces the draft, its first blank selected to type over. */
  const insertPrompt = (value: string) => {
    const first = blanks(value)[0];
    setTextAt(value, first?.start ?? value.length, first?.end ?? value.length);
    area.current?.focus();
  };

  /** Arrow keys move, Tab/Enter complete, Esc closes; true when the key was the menu's. */
  const menuKey = (e: React.KeyboardEvent<HTMLDivElement>): boolean => {
    if (!menuOpen) return false;
    if (e.key === "Escape") {
      setMenuDismissed(true);
      return true;
    }
    if (menuItems.length === 0) return false;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      const step = e.key === "ArrowDown" ? 1 : -1;
      setMenuIndex((i) => (i + step + menuItems.length) % menuItems.length);
      return true;
    }
    if (e.key !== "Tab" && (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing)) return false;
    // A command typed in full that takes nothing more runs on Enter; otherwise the key completes it.
    if (e.key === "Enter" && activeCommand && activeCommand.name === slashQuery && !activeCommand.hint) return false;
    if (activeCommand) completeCommand(activeCommand);
    return true;
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (menuKey(e)) {
      e.preventDefault();
      return;
    }
    const el = area.current;
    if (!el) return;
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey && !e.nativeEvent.isComposing;
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.code === "KeyS") {
      e.preventDefault();
      stashNow();
      return;
    }
    if ((e.key === "ArrowUp" || e.key === "ArrowDown") && plain && !e.shiftKey) {
      const step = recallStep(sentPrompts(chat.items), recall.current, e.key === "ArrowUp" ? "up" : "down", text, el.selectionStart);
      if (step) {
        e.preventDefault();
        recall.current = step.recall;
        setTextAt(step.text, step.text.length);
      }
      return;
    }
    if (e.key === "Tab" && plain) {
      // A saved prompt's blanks: Tab to the next, Shift+Tab back (unless the only one is already selected).
      const blank = nextBlank(text, e.shiftKey ? el.selectionStart : el.selectionEnd, e.shiftKey);
      if (blank && !(blank.start === el.selectionStart && blank.end === el.selectionEnd)) {
        e.preventDefault();
        el.setSelectionRange(blank.start, blank.end);
        return;
      }
      const next = indentList(text, el.selectionStart, el.selectionEnd, e.shiftKey);
      if (next) {
        e.preventDefault();
        setTextAt(next.text, next.from, next.to);
      }
      return;
    }
    // While a run goes: the draft as the chain's next step, sent once the run is over.
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey) && e.shiftKey && !e.altKey && busy) {
      e.preventDefault();
      void addThen();
      return;
    }
    // A new line (Shift+Enter, or Enter on a touch screen) inside a list item starts the next item.
    if (e.key === "Enter" && plain && (e.shiftKey || coarsePointer()) && el.selectionStart === el.selectionEnd) {
      const next = continueList(text, el.selectionStart);
      if (next) {
        e.preventDefault();
        setTextAt(next.text, next.caret);
      }
      return;
    }
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing || coarsePointer()) return;
    e.preventDefault();
    if ((e.ctrlKey || e.metaKey) && e.altKey) {
      if (!busy) void submit("normal").then((ok) => ok && onNewChat?.());
      return;
    }
    if (!busy) void submit("normal");
    else if (caps.supportsSteer && running) void submit("steer");
  };

  const empty = !text.trim();
  // A phone's composer rests as one pill row and opens into the box and its controls when you write (Claude's
  // app): the open is a morph, the card's height springing and its parts gliding to their new places.
  const phone = useMediaQuery("(max-width: 600px)");
  const pillRow = composerFolded({ phone, hero: Boolean(hero), closed, writing, text, images: images.length, pastes: pastes.length, menuOpen, dragging });
  useMorph(cardRef, pillRow, MORPH_PARTS);
  const model = chat.config.models.find((m) => m.key === chat.config.model);
  const blind = images.length > 0 && model?.vision === false;
  const pending = closed ? [] : chat.pending;
  const harnessName = harnesses.find((h) => h.id === chat.harnessId)?.displayName ?? chat.harnessId;
  const stopped = useMemo(() => limitStop(chat.items, chat.status, limits ?? null, harnessName), [chat.items, chat.status, limits, harnessName]);
  // The subagent/job strip above the composer: live while any delegated run is.
  const jobs = useMemo(() => jobProgress(chat.items, busy), [chat.items, busy]);
  // Background jobs (a backgrounded command, a waited-on task): the running ones, and one that just ended for a moment.
  const allJobs = useMemo(() => chatJobs(chat.items), [chat.items]);
  const jobsTicking = allJobs.some((j) => j.status === "running" || (j.endedAt !== undefined && Date.now() - j.endedAt < FINISHED_SHOWN_MS));
  const jobsNow = useNow(jobsTicking, 2000);
  const background = useMemo(() => shownJobs(allJobs, jobsNow), [allJobs, jobsNow]);

  return (
    <div className={`composer${hero ? " is-hero" : ""}`}>
      {!closed ? (
        <div
          className="composer-resize"
          role="separator"
          aria-orientation="horizontal"
          aria-label="Resize the prompt box"
          tabIndex={0}
          title="Drag for a taller prompt (double-click to reset)"
          onPointerDown={(e) => {
            dragFrom.current = { y: e.clientY, height: promptHeightNow() };
            e.currentTarget.setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            const from = dragFrom.current;
            if (!from) return;
            setPromptHeight(clampPrompt(from.height + (from.y - e.clientY)));
          }}
          onPointerUp={() => {
            if (!dragFrom.current) return;
            dragFrom.current = null;
            if (promptHeight !== null) save("composerHeight", promptHeight);
          }}
          onDoubleClick={() => {
            setPromptHeight(null);
            save("composerHeight", null);
          }}
          onKeyDown={(e) => {
            if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
            e.preventDefault();
            resizeTo(promptHeightNow() + (e.key === "ArrowUp" ? 24 : -24));
          }}
        />
      ) : null}
      <StatusStack
        chatId={chat.chatId}
        queue={chat.queue}
        todos={chat.todos}
        notice={chat.extensionStatus[`${chat.harnessId}:status`] ?? null}
        onEditQueue={editQueue}
        chain={chat.chain}
        chainPaused={chat.chainPaused}
        harnessName={name}
        onChain={setChain}
        top={direnv ? <DirenvRow direnv={direnv} /> : null}
        base={git ? <GitRow git={git} onOpen={() => setGitOpen(true)} /> : null}
        working={busy}
        jobs={jobs}
        background={background}
        allJobs={allJobs}
        tasks={chat.delegated ?? []}
        {...(onOpenTask ? { onOpenTask } : {})}
        {...(onCancelTask ? { onCancelTask } : {})}
      />
      {gitOpen && git ? <GitPanel chatId={chat.chatId} git={git} at={gitAt} onRefresh={refreshGit} onClose={() => setGitOpen(false)} /> : null}
      {stopped && !busy && pending.length === 0 && !closed ? (
        <LimitRecovery
          key={stopped.id}
          chatId={chat.chatId}
          stop={stopped}
          idle={!busy}
          continueAt={chat.continueAt}
          onContinue={() => void onSend(CONTINUE_TEXT, "normal", [])}
          onSchedule={async (at) => {
            await api<{ ok: boolean }>(`/api/chats/${chat.chatId}/continue-at`, { body: { at } });
          }}
        />
      ) : null}
      <DirenvNote chat={chat} />
      {rotate ? (
        <RotationHint
          hint={rotate}
          busy={busy}
          onRotate={() => onRotate?.()}
          onDismiss={() => {
            setRotateOff(true);
            save(ROTATION_OFF_KEY, true);
          }}
        />
      ) : null}
      {cold && !rotate && onCompact && !busy && pending.length === 0 ? (
        <ColdResumeHint
          hint={cold}
          busy={busy}
          onCompact={() => onCompact?.()}
          onDismiss={() => {
            setColdOff(true);
            save(COLD_RESUME_OFF_KEY, true);
          }}
        />
      ) : null}
      {pending.length === 0 && folded ? <ApprovalFolded key={folded.id} folded={folded} onDone={() => setFolded(null)} /> : null}
      {pending.length > 0 ? (
        <ApprovalStack
          pending={pending}
          busy={answering}
          stopping={stopping}
          onStop={onStop}
          onAnswer={async (request, answer) => {
            setAnswering(true);
            await onAnswer(request.id, answer);
            setAnswering(false);
            setFolded(foldRequest(request, answer));
          }}
        />
      ) : (
        <div
          ref={cardRef}
          className={`composer-card${closed ? " is-closed" : ""}${dragging ? " is-dragging" : ""}${pillRow ? " is-folded" : ""}`}
          // Writing opens the folded card; it folds again once focus has left it (a touch on its chip keeps it open).
          onFocus={(e) => {
            if ((e.target as HTMLElement).closest(".composer-input")) setWriting(true);
          }}
          onBlur={() => {
            window.setTimeout(() => {
              const card = cardRef.current;
              if (card && !card.contains(document.activeElement) && !touching.current) setWriting(false);
            }, 160);
          }}
          onPointerDown={() => {
            touching.current = true;
            const up = () => {
              window.removeEventListener("pointerup", up);
              window.setTimeout(() => (touching.current = false), 250);
            };
            window.addEventListener("pointerup", up);
          }}
          onDragOver={(e) => {
            if (closed || !hasFiles(e)) return;
            e.preventDefault();
            setDragging(true);
            setDragHint(dropHint(e.dataTransfer.items));
          }}
          onDragLeave={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragging(false);
          }}
          onDrop={(e) => {
            if (closed || !hasFiles(e)) return;
            e.preventDefault();
            setDragging(false);
            void addImages(imageFiles(e.dataTransfer.files));
            void referenceFiles(otherFiles(e.dataTransfer.files));
          }}
        >
          {dragging ? (
            <div className="composer-drop" aria-hidden="true">
              {dragHint}
            </div>
          ) : null}
          {pendingPaste !== null ? (
            <div className="paste-offer" role="group" aria-label="Large paste">
              <span className="paste-offer-note">Pasting {(pendingPaste.length / 1024).toFixed(0)} KB ({pendingPaste.split("\n").length.toLocaleString("en-US")} lines)</span>
              <button type="button" className="btn btn-small" disabled={pasteBusy} onClick={() => void attachPaste()}>
                {pasteBusy ? "Saving…" : "Attach as file"}
              </button>
              <button type="button" className="btn btn-small btn-ghost" disabled={pasteBusy} onClick={inlinePaste}>
                Paste inline
              </button>
            </div>
          ) : null}
          {pastes.length > 0 ? (
            <ul className="composer-pastes" aria-label="Pasted files">
              {pastes.map((paste, i) => (
                <li key={paste.id} className="composer-paste">
                  <span className="paste-label" title={paste.path}>
                    <strong>paste-{i + 1}.txt</strong> {paste.lines.toLocaleString("en-US")} lines
                    <Dot />
                    {(paste.bytes / 1024).toFixed(1)} KB
                  </span>
                  <button
                    type="button"
                    className="composer-image-remove"
                    aria-label={`Remove paste #${i + 1}`}
                    onClick={() => {
                      setPastes((current) => current.filter((x) => x.id !== paste.id));
                      // Never delete a paste that was already accepted: the agent reads the path later.
                      void api(`/api/chats/${chat.chatId}/pastes/${paste.id}`, { method: "DELETE" }).catch((e) => setImageError(errorText(e)));
                    }}
                  >
                    <IconX size={11} />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
          {images.length > 0 ? (
            <ul className="composer-images" aria-label="Attached images">
              {images.map((image, i) => {
                const size = imageSize(image);
                return (
                  <li key={image.id} className="composer-image">
                    <button
                      type="button"
                      className="composer-image-open"
                      aria-label={`View image #${i + 1}`}
                      title={`Image #${i + 1}${size ? ` · ${size}` : ""}`}
                      ref={(el) => {
                        if (el) thumbs.current.set(i, el);
                        else thumbs.current.delete(i);
                      }}
                      onClick={() => setViewing(i)}
                    >
                      <img src={dataUrl(image)} alt={`Attached image #${i + 1}`} />
                    </button>
                    <span className="image-label" aria-hidden="true">
                      <strong>#{i + 1}</strong>
                      {size ? <span>{size}</span> : null}
                    </span>
                    <button
                      type="button"
                      className="composer-image-remove"
                      aria-label={`Remove image #${i + 1}`}
                      onClick={() => setImages((current) => current.filter((x) => x.id !== image.id))}
                    >
                      <IconX size={11} />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
          {imageError || blind ? (
            <p className="composer-note" role="status">
              {imageError ?? `${model?.name ?? "This model"} does not take image input; switch to a vision model before sending.`}
            </p>
          ) : null}
          {linked ? (
            <p className="composer-note composer-linked" role="status">
              <IconLink size={13} />
              <span>
                From a link: read it before you send it.
                {linked.hidden > 0 ? ` ${linked.hidden} hidden character${linked.hidden === 1 ? " was" : "s were"} taken out.` : ""}
              </span>
              <button type="button" className="icon-btn" aria-label="Dismiss the link note" onClick={() => setLinked(null)}>
                <IconX size={11} />
              </button>
            </p>
          ) : null}
          {choices[0] ? (
            <div className="paste-offer" role="group" aria-label="Which file">
              <span className="paste-offer-note">{choices[0].name} is in {choices[0].paths.length} places in the project</span>
              {choices[0].paths.slice(0, MAX_CHOICES).map((path) => (
                <button
                  key={path}
                  type="button"
                  className="btn btn-small"
                  onClick={() => {
                    reference(path);
                    setChoices((current) => current.slice(1));
                  }}
                >
                  {path}
                </button>
              ))}
              <button type="button" className="btn btn-small btn-ghost" onClick={() => setChoices((current) => current.slice(1))}>
                Cancel
              </button>
            </div>
          ) : null}
          {missing.length > 0 ? (
            <div className="paste-offer" role="group" aria-label="Add to the project">
              <span className="paste-offer-note">{addQuestion(missing.map((file) => file.name))}</span>
              <button type="button" className="btn btn-small" disabled={adding} onClick={() => void addMissing()}>
                {adding ? "Adding…" : "Add"}
              </button>
              <button type="button" className="btn btn-small btn-ghost" disabled={adding} onClick={() => setMissing([])}>
                Cancel
              </button>
            </div>
          ) : null}
          {fileNote ? (
            <p className="composer-note" role="status">
              {fileNote}
            </p>
          ) : null}
          {stashNote ? (
            <p className="composer-note" role="status">
              {stashNote}
            </p>
          ) : null}
          {renderMenu ? (
            <div
              className={`command-menu${renderKind === "skill" ? " is-skills" : renderKind === "prompt" ? " is-prompts" : ""}${menuLeaving ? " is-leaving" : ""}`}
              id={menuId}
              role="listbox"
              aria-label={renderKind === "skill" ? "Skills" : renderKind === "prompt" ? "Saved prompts" : "Commands"}
            >
              <div className="command-menu-head" aria-hidden="true">
                {renderKind === "skill" ? dotted(["Skills", skillCount]) : renderKind === "prompt" ? dotted(["Saved prompts", savedPrompts?.length ?? 0]) : "Commands"}
              </div>
              {renderItems.length === 0 ? (
                <div className="command-empty">
                  {renderKind === "prompt"
                    ? `No saved prompt matches #${promptQuery}`
                    : commands === null
                      ? "Loading commands…"
                      : renderKind === "skill"
                        ? `No skill matches $${skillQuery}`
                        : `No command matches /${slashQuery}`}
                </div>
              ) : (
                renderItems.map((c, i) => (
                  <div
                    key={`${c.source}:${c.name}`}
                    id={`${menuId}-${i}`}
                    role="option"
                    aria-selected={i === menuIndex}
                    className={`command-item${i === menuIndex ? " is-active" : ""}`}
                    title={c.description ? `${renderKind === "skill" ? `$${skillName(c)}` : `/${c.name}`}${c.hint ? ` ${c.hint}` : ""}: ${c.description}` : undefined}
                    onPointerMove={() => setMenuIndex(i)}
                    onMouseDown={(e) => {
                      // Keep the caret in the composer.
                      e.preventDefault();
                      completeCommand(c);
                    }}
                  >
                    {renderKind === "skill" ? (
                      <IconSpark size={14} className="command-icon-skill" />
                    ) : renderKind === "prompt" ? (
                      <IconPlan size={14} className="command-icon-prompt" />
                    ) : (
                      <IconTerminal size={14} />
                    )}
                    <span className="command-name">{renderKind === "skill" ? `$${skillName(c)}` : renderKind === "prompt" ? `#${c.name}` : `/${c.name}`}</span>
                    {c.description ? <span className="command-desc">{c.description}</span> : null}
                    {renderKind === "slash" && (c.source === "skill" || c.source === "prompt" || c.source === "app") ? <span className="command-source">{c.source}</span> : null}
                  </div>
                ))
              )}
              {renderKind === "prompt" ? (
                <button
                  type="button"
                  className="command-foot command-foot-btn"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    managePrompts();
                  }}
                >
                  Manage saved prompts…
                </button>
              ) : null}
              {/* Where the skills went: under "$", unless the query already asks for them. */}
              {renderKind === "slash" && skillCount > 0 && !(slashQuery ?? "").toLowerCase().startsWith("skill") ? (
                <div className="command-foot" aria-hidden="true">
                  <IconSpark size={12} /> {skillCount} {skillCount === 1 ? "skill" : "skills"} under <kbd className="keycap">$</kbd>
                </div>
              ) : null}
            </div>
          ) : null}
          <ChipEditor
            ref={area}
            className="composer-input"
            style={promptHeight !== null && !pillRow ? { minHeight: promptHeight } : undefined}
            value={text}
            disabled={closed}
            placeholder={
              closed
                ? "This chat is closed"
                : busy
                  ? caps.supportsSteer
                    ? "Steer the agent, or queue a follow-up…"
                    : "The agent is working…"
                  : images.length > 0
                    ? "Say what to do with the image…"
                    : (placeholder ?? "Message the agent…")
            }
            onChange={setText}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            aria-label="Message"
            aria-autocomplete="list"
            aria-controls={menuOpen ? menuId : undefined}
            aria-activedescendant={menuOpen && menuItems.length > 0 ? `${menuId}-${menuIndex}` : undefined}
            enterKeyHint={coarsePointer() ? "enter" : "send"}
          />
          <div className="composer-bar">
            <button
              type="button"
              className="icon-btn composer-attach"
              aria-label="Attach images"
              title="Attach images (or paste / drop them)"
              disabled={closed || images.length >= MAX_IMAGES}
              onClick={() => filePicker.current?.click()}
            >
              <IconImage size={16} className="attach-image" />
              <IconPlus size={16} className="attach-plus" />
            </button>
            <input
              ref={filePicker}
              type="file"
              accept={IMAGE_MIME_TYPES.join(",")}
              multiple
              hidden
              onChange={(e) => {
                void addImages(imageFiles(e.target.files));
                e.target.value = "";
              }}
            />
            {canCapture ? (
              <button
                type="button"
                className="icon-btn composer-capture"
                aria-label="Capture a screenshot"
                title="Capture a window or screen into the message"
                aria-busy={capturing || undefined}
                disabled={closed || capturing || images.length >= MAX_IMAGES}
                onClick={() => void captureIntoComposer()}
              >
                <IconScreen size={16} />
              </button>
            ) : null}
            <div className="stash" ref={stashRef}>
              <button
                type="button"
                className="icon-btn composer-stash"
                aria-label={stash.length > 0 ? `Stash (${stash.length} kept)` : "Stash"}
                aria-haspopup="menu"
                aria-expanded={stashOpen}
                title="Stash this draft for later (Alt+S), or take a stashed one back"
                disabled={closed}
                onClick={() => {
                  setStash(loadStash());
                  setStashOpen((v) => !v);
                }}
              >
                <IconStash size={16} />
                {stash.length > 0 ? <span className="stash-count">{stash.length}</span> : null}
              </button>
              {showStash ? (
                <>
                  <div className="menu-backdrop" onClick={() => setStashOpen(false)} aria-hidden="true" />
                  <ul className={`menu-list stash-menu${stashLeaving ? " is-leaving" : ""}`} role="menu" aria-label="Stash" onKeyDown={(e) => e.key === "Escape" && setStashOpen(false)}>
                    <li role="none">
                      <button type="button" role="menuitem" disabled={empty && images.length === 0} onClick={stashNow}>
                        <IconStash size={14} /> Stash this draft <kbd>Alt+S</kbd>
                      </button>
                    </li>
                    <li role="none">
                      <button
                        type="button"
                        role="menuitem"
                        disabled={empty}
                        onClick={() => {
                          setStashOpen(false);
                          managePrompts(text);
                        }}
                      >
                        <IconPlan size={14} /> Save the draft as a prompt…
                      </button>
                    </li>
                    {stash.length === 0 ? <li className="stash-empty muted">Nothing stashed</li> : null}
                    {stash.map((entry) => (
                      <li key={entry.id} role="none" className="stash-entry">
                        <button type="button" role="menuitem" className="stash-take" title={entry.text} onClick={() => unstash(entry.id)}>
                          <span className="stash-text">{entry.text.trim().split("\n")[0] || `${entry.images.length} image${entry.images.length === 1 ? "" : "s"}`}</span>
                          <span className="stash-meta muted">
                            {entry.from}
                            {entry.images.length > 0 ? (
                              <>
                                <Dot />
                                {`${entry.images.length} image${entry.images.length === 1 ? "" : "s"}`}
                              </>
                            ) : null}
                          </span>
                        </button>
                        <button type="button" className="icon-btn stash-drop" aria-label={`Drop stashed “${entry.text.trim().slice(0, 40)}”`} onClick={() => dropStashed(entry.id)}>
                          <IconX size={11} />
                        </button>
                      </li>
                    ))}
                  </ul>
                </>
              ) : null}
            </div>
            <ComposerControls chat={chat} harnesses={harnesses} onConfig={onConfig} onRefreshModels={onRefreshModels} onHandoff={(id) => onHandoff(id, text)} />
            <div className="composer-actions">
              {tooLong ? (
                <span className="composer-error">
                  {text.length.toLocaleString()} / {maxChars.toLocaleString()}
                </span>
              ) : null}
              {offerCompact && !busy ? (
                <button
                  type="button"
                  className={`compact-chip${compactFirst ? " is-on" : ""}`}
                  aria-pressed={compactFirst}
                  title={
                    compactFirst
                      ? "On: Enter compacts the context first, then sends. Click to send with the full history."
                      : "Off: the next message goes with the full history. Click to compact first."
                  }
                  onClick={() => setCompactChoice(!compactFirst)}
                  data-testid="compact-chip"
                >
                  {compactFirst ? "Compact" : "Full"} {formatTokens(chat.context?.tokens ?? 0)}
                </button>
              ) : null}
              <ContextRing context={chat.context} usage={chat.usage} draft={{ text, images: images.length }} canCompact={caps.supportsCompact} history={chat.contextHistory} compacting={chat.status === "compacting"} timing={{ items: chat.items, status: chat.status, workspace: chat.workspace.path }} />
              {busy ? (
                <>
                  {caps.supportsSteer ? (
                    <button type="button" className="pill-btn" disabled={empty || sending || !running || tooLong} onClick={() => void submit("steer")}>
                      Steer
                    </button>
                  ) : null}
                  {caps.supportsFollowUp ? (
                    <button type="button" className="pill-btn" disabled={empty || sending || !running || tooLong} onClick={() => void submit("followUp")}>
                      Follow-up
                    </button>
                  ) : null}
                  {!caps.supportsSteer ? (
                    <button type="button" className="pill-btn" disabled={empty || sending || stopping || tooLong} onClick={() => void submit("stopAndSend")}>
                      Stop and send
                    </button>
                  ) : null}
                  <span className="then-split">
                    <button
                      type="button"
                      className="pill-btn then-btn"
                      disabled={empty || tooLong}
                      title="Send this once the run is over, even with this page closed (Ctrl+Shift+Enter)"
                      onClick={() => void addThen()}
                    >
                      Then
                    </button>
                    <button type="button" className="pill-btn then-more" aria-label="Then hand off to…" aria-expanded={thenMenu} onClick={() => setThenMenu((v) => !v)}>
                      <IconChevronDown size={12} />
                    </button>
                    {showThen ? (
                      <>
                        <div className="menu-backdrop" onClick={() => setThenMenu(false)} aria-hidden="true" />
                        <ul className={`menu-list then-menu${thenLeaving ? " is-leaving" : ""}`} role="menu" aria-label="Then hand off to" onKeyDown={(e) => e.key === "Escape" && setThenMenu(false)}>
                          <li className="then-menu-head muted" role="none">
                            Once the run is over, hand off to…
                          </li>
                          {/* A read-only surface cannot host a handoff (the server's orchestration refusal says the same). */}
                          {harnesses
                            .filter((h) => h.available && h.id !== chat.harnessId && !h.capabilities.readOnlyHarness)
                            .map((h, i) => (
                              <li key={h.id} role="none">
                                <button type="button" role="menuitem" autoFocus={i === 0} onClick={() => void addThen(h.id)}>
                                  {h.displayName}
                                  {text.trim() ? <span className="muted"> with this message</span> : null}
                                </button>
                              </li>
                            ))}
                        </ul>
                      </>
                    ) : null}
                  </span>
                  <button type="button" className="round-btn is-stop" onClick={onStop} disabled={stopping} aria-label="Stop the agent">
                    {stopping ? <Spinner size={14} /> : <IconStop size={14} />}
                  </button>
                </>
              ) : (
                <button type="button" className="round-btn" aria-label="Send" disabled={empty || sending || closed || tooLong} onClick={() => void submit("normal")}>
                  <IconArrowUp size={16} />
                </button>
              )}
            </div>
          </div>
        </div>
      )}
      {viewing !== null && images[viewing] ? (
        <ImageViewer images={images.map((i) => ({ src: dataUrl(i), width: i.width, height: i.height }))} start={viewing} thumbnail={(i) => thumbs.current.get(i) ?? null} onClose={() => setViewing(null)} />
      ) : null}
    </div>
  );
}
