// A bot profile's form: which harness runs it, which real model and thinking
// level that harness offers here, its instructions (sent on every invocation),
// its role label, and its accent (a row of swatches, not a list of token names). Capability-gated: a control appears only when
// the harness says it has one, and never with a fictional universal value.
import { useEffect, useState } from "react";
import type { BotProfile, HarnessStatus, ModelInfo, WorkspaceInfo } from "../../shared/protocol.js";
import { BOARD_MAX_BOT_NAME_CHARS, BOARD_MAX_INSTRUCTIONS_CHARS, BOARD_MAX_ROLE_CHARS, HARNESS_ACCENTS } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { createBot, deleteBot, patchBot } from "../rooms.js";
import { IconRefresh, IconX } from "../icons.js";
import { ConfirmButton } from "./ConfirmButton.js";
import { Dialog } from "./Dialog.js";
import { FormRow } from "./FormRow.js";
import { Select } from "./Select.js";
import { ModelPicker } from "./ModelPicker.js";

const ACCENTS: string[] = [...HARNESS_ACCENTS];

/**
 * Role presets: the label to start from, what kind of model the role wants, and
 * instructions to start from. They never pick a model — the harness's own
 * catalog and the user decide that; the hint only says what to look for. The
 * instruction texts follow the common multi-agent split (the plan's
 * lead/researcher/critic; MetaGPT's SOP roles; the gauntlet loop's rule that
 * the implementer never grades its own work and a critic judges evidence, not
 * claims).
 */
const ROLE_PRESETS = [
  {
    label: "lead",
    hint: "Lead — the room's default responder: the strongest reasoning model you have carries the answer.",
    instructions:
      "You lead this room: answer the user's request yourself, directly and completely — do not hand the whole job to someone else. When another member's expertise would change the answer, get their input once and weigh it; say what you kept, changed, or rejected and why. State your assumptions and what you actually checked.",
  },
  {
    label: "researcher",
    hint: "Researcher — gathers and checks facts: a strong model with web or search tools; a mid-tier one keeps it cheap.",
    instructions:
      "Gather evidence before you conclude: search and read the available sources, prefer primary ones, and keep notes on what each said. Answer with the facts you verified, cite or quote where they came from, and say plainly when evidence is missing, stale, or conflicting. Do not fill gaps with guesses.",
  },
  {
    label: "implementer",
    hint: "Implementer — executes the work: a fast, cheap model that is good with tools (edits, commands).",
    instructions:
      "Do the work precisely: make the smallest change that satisfies the request, use the project's own tools and checks to verify it, and report exactly what changed and what you verified. Don't broaden the task or refactor beyond it; if the request is ambiguous or blocked, say what you need instead of guessing.",
  },
  {
    label: "critic",
    hint: "Critic — challenges the result: a strong model from a different family than the lead, so it does not share the lead's blind spots.",
    instructions:
      "Audit the result as a hostile reviewer: name concrete defects — wrong facts, missing cases, unverified claims, real risks — each with why it matters and, where you can, the fix. Judge the evidence in front of you, never the author's confidence. If it holds up, say so in one line and stop; do not invent objections.",
  },
] as const;

export function BotEditor({
  bot,
  harnesses,
  workspaces,
  defaultWorkspaceId,
  onSaved,
  onDeleted,
  onNotice,
  onClose,
}: {
  /** null creates a profile; an existing one is edited in place. */
  bot: BotProfile | null;
  harnesses: HarnessStatus[];
  workspaces: WorkspaceInfo[];
  /** Which project's model catalog to read when the caller knows one (the open room's). */
  defaultWorkspaceId: string | null;
  onSaved: (bot: BotProfile) => void;
  onDeleted: (id: string) => void;
  onNotice: (text: string) => void;
  onClose: () => void;
}) {
  const [name, setName] = useState(bot?.name ?? "");
  const [harnessId, setHarnessId] = useState(bot?.harnessId ?? harnesses.find((h) => h.available)?.id ?? harnesses[0]?.id ?? "");
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId ?? workspaces[0]?.id ?? "");
  const [model, setModel] = useState<string | null>(bot?.model ?? null);
  const [thinkingLevel, setThinkingLevel] = useState(bot?.thinkingLevel ?? "");
  const [instructions, setInstructions] = useState(bot?.instructions ?? "");
  const [role, setRole] = useState(bot?.role ?? "");
  const [accent, setAccent] = useState(bot?.accent ?? "");
  const [permissionMode, setPermissionMode] = useState(bot?.permissionMode ?? "");
  const [models, setModels] = useState<ModelInfo[]>([]);
  // The harness's own default levels, for when no model is picked (the model's levels win when one is).
  const [harnessLevels, setHarnessLevels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  // A saved model the harness no longer lists: cleared on load, but said out loud.
  const [staleModel, setStaleModel] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [saving, setSaving] = useState(false);
  // A refused profile (a name, a model, an id already in use) is said inside this dialog.
  const [notice, setNotice] = useState<string | null>(null);

  const harness = harnesses.find((h) => h.id === harnessId) ?? null;
  const chosenModel = models.find((m) => m.key === model) ?? null;
  // The levels the harness exposes: the chosen model's own, else the harness's defaults. Never invented values.
  const levels = chosenModel?.levels && chosenModel.levels.length > 0 ? chosenModel.levels : harnessLevels;

  const loadModels = async () => {
    if (!harnessId || !workspaceId) return;
    setLoadingModels(true);
    try {
      const { models: list, thinkingLevels } = await api<{ models: ModelInfo[]; thinkingLevels?: string[] }>(`/api/harnesses/${encodeURIComponent(harnessId)}/models?workspaceId=${encodeURIComponent(workspaceId)}`);
      setModels(list);
      setHarnessLevels(thinkingLevels ?? []);
      setModelsError(null);
    } catch (e) {
      setModels([]);
      setModelsError(errorText(e));
    } finally {
      setLoadingModels(false);
    }
  };
  // The catalog is per harness and workspace: switching either re-reads it.
  useEffect(() => {
    void loadModels();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [harnessId, workspaceId]);

  // A model from another catalog (or a harness switch) must not be sent as this one's.
  useEffect(() => {
    if (model !== null && models.length > 0 && !models.some((m) => m.key === model)) {
      setStaleModel(model);
      setModel(null);
    }
  }, [models, model]);

  // A level the harness no longer offers must not be sent as this bot's.
  useEffect(() => {
    if (thinkingLevel !== "" && levels.length > 0 && !levels.includes(thinkingLevel)) setThinkingLevel("");
  }, [levels, thinkingLevel]);

  const trimmedName = name.trim();
  const valid = trimmedName.length > 0 && trimmedName.length <= BOARD_MAX_BOT_NAME_CHARS && harnessId !== "";
  const thinking = thinkingLevel.trim();
  const permission = permissionMode.trim();

  const save = async () => {
    if (!valid || saving) return;
    setSaving(true);
    try {
      const body = {
        name: trimmedName,
        model,
        thinkingLevel: thinking === "" ? null : thinking,
        instructions,
        role: role.trim(),
        accent: accent === "" ? null : accent,
        permissionMode: permission === "" ? null : permission,
      };
      const saved = bot ? await patchBot(bot.id, body) : await createBot({ ...body, harnessId });
      onSaved(saved);
      onClose();
    } catch (e) {
      setNotice(errorText(e));
      onNotice(errorText(e));
    } finally {
      setSaving(false);
    }
  };

  const preset = ROLE_PRESETS.find((p) => p.label === role.trim().toLowerCase());
  const modelNote = modelsError ?? (staleModel ? `“${staleModel}” is not offered by ${harness?.displayName ?? harnessId} here, so it was cleared: pick another, or keep the harness default.` : null);

  return (
    <Dialog title={bot ? `Edit ${bot.name}` : "New bot"} onClose={onClose} className="bot-editor-dialog">
      <div className="board-form">
        <div className="form-card">
          <FormRow label="Name" desc="Also its @handle in a room, unless the room picks another." stack>
            <input className="input" type="text" value={name} maxLength={BOARD_MAX_BOT_NAME_CHARS} aria-label="Bot name" placeholder="e.g. reviewer" onChange={(e) => setName(e.target.value)} />
          </FormRow>
          {bot || !harness?.capabilities.supportsModelSelection ? (
            <FormRow label="Harness" desc={bot ? "A bot's harness cannot change; make a new bot instead." : "The agent that runs this bot."}>
              {bot ? (
                <span className="board-static">
                  <span className="harness-dot" style={{ ["--harness" as string]: `var(--harness-${bot.harnessId}, var(--muted))` }} aria-hidden="true" />
                  {harness?.displayName ?? bot.harnessId}
                </span>
              ) : (
                <Select
                  label="Harness"
                  value={harnessId}
                  onChange={setHarnessId}
                  options={harnesses.map((h) => ({
                    value: h.id,
                    label: h.displayName,
                    hint: h.available ? (h.version ?? "") : (h.reason ?? "not installed"),
                    disabled: !h.available,
                    dot: `var(--harness-${h.id}, var(--muted))`,
                  }))}
                />
              )}
            </FormRow>
          ) : null}
          {harness?.capabilities.supportsModelSelection ? (
            <FormRow label={bot ? "Model" : "Harness and model"} desc={modelNote ?? (model === null ? "The harness's own default, until you pick one." : "Picked from the harness's own list.")}>
              <ModelPicker
                models={models}
                current={model}
                harnessId={harnessId}
                disabled={loadingModels}
                onSelect={(key) => setModel(key)}
                onRefresh={loadModels}
                emptyLabel="Harness default"
                levels={harness?.capabilities.supportsThinkingLevel ? levels : []}
                thinking={thinkingLevel}
                onThinking={setThinkingLevel}
                {...(bot
                  ? {}
                  : {
                      triggerLabel: `${harness?.displayName ?? harnessId} · ${chosenModel?.name ?? "Harness default"}${thinking ? ` · ${thinking}` : ""}`,
                      header: (
                        <div className="board-harness-chips" role="group" aria-label="Harness">
                          {harnesses.map((h) => (
                            <button
                              key={h.id}
                              type="button"
                              className="board-harness-chip"
                              aria-pressed={h.id === harnessId}
                              disabled={!h.available}
                              title={h.available ? (h.version ?? h.displayName) : (h.reason ?? "not installed")}
                              onClick={() => setHarnessId(h.id)}
                            >
                              <span className="harness-dot" style={{ ["--harness" as string]: `var(--harness-${h.id}, var(--muted))` }} aria-hidden="true" />
                              {h.displayName}
                            </button>
                          ))}
                        </div>
                      ),
                    })}
              />
              {model !== null ? (
                <button type="button" className="ghost-icon" aria-label="Use the harness default" title="Use the harness default" onClick={() => setModel(null)}>
                  <IconX size={13} />
                </button>
              ) : null}
              <button type="button" className="ghost-icon" aria-label="Refresh models" title="Re-read this harness's models" onClick={() => void loadModels()}>
                <IconRefresh size={14} />
              </button>
            </FormRow>
          ) : null}
          {workspaces.length > 1 && harness?.capabilities.supportsModelSelection ? (
            <FormRow label="Models from" desc="The project whose model list to read; providers can differ per folder.">
              <Select label="Model catalog workspace" value={workspaceId} onChange={setWorkspaceId} options={workspaces.map((w) => ({ value: w.id, label: w.name, hint: w.path }))} />
            </FormRow>
          ) : null}
          {harness?.capabilities.supportsPermissionMode ? (
            <FormRow label="Permission mode" desc="The harness's own mode id, checked when the bot runs; a mode it refuses is reported.">
              <input className="input" type="text" value={permissionMode} aria-label="Permission mode" placeholder="Harness default" onChange={(e) => setPermissionMode(e.target.value)} />
            </FormRow>
          ) : null}
        </div>

        <div className="form-card">
          <FormRow label="Role" desc={preset?.hint ?? "A label for you; routing follows @mentions, never the role. A preset also fills in its instructions."} stack>
            <div className="board-role-row">
              <div className="board-role-presets" role="group" aria-label="Role presets">
                {ROLE_PRESETS.map((p) => (
                  <button
                    key={p.label}
                    type="button"
                    className="board-role-preset"
                    aria-pressed={role.trim().toLowerCase() === p.label}
                    title={p.instructions}
                    onClick={() => {
                      setRole(p.label);
                      // Fill the instructions from the preset, but never over text the user wrote:
                      // an empty field, or one still holding another preset's words, may be replaced.
                      setInstructions((previous) => {
                        const trimmed = previous.trim();
                        const untouched = trimmed === "" || ROLE_PRESETS.some((q) => q.instructions.trim() === trimmed);
                        return untouched ? p.instructions : previous;
                      });
                    }}
                  >
                    {p.label}
                  </button>
                ))}
              </div>
              <input className="input board-role-input" type="text" value={role} maxLength={BOARD_MAX_ROLE_CHARS} aria-label="Role" placeholder="or your own" onChange={(e) => setRole(e.target.value)} />
            </div>
          </FormRow>
          <FormRow label="Accent" desc="Its dot in the room and on its replies.">
            <div className="board-swatches" role="radiogroup" aria-label="Accent">
              {[{ value: "", label: "Theme default" }, ...ACCENTS.map((token) => ({ value: token, label: token }))].map((swatch) => (
                <button
                  key={swatch.value || "default"}
                  type="button"
                  role="radio"
                  aria-checked={accent === swatch.value}
                  aria-label={swatch.label}
                  title={swatch.label}
                  className={`board-swatch${swatch.value === "" ? " is-default" : ""}`}
                  style={swatch.value ? ({ "--swatch": `var(--${swatch.value})` } as React.CSSProperties) : undefined}
                  onClick={() => setAccent(swatch.value)}
                />
              ))}
            </div>
          </FormRow>
          <FormRow label="Instructions" desc="Sent with every message the bot answers (harnesses have no shared system prompt), so a room's history cannot erase them." stack>
            <textarea
              className="input"
              value={instructions}
              maxLength={BOARD_MAX_INSTRUCTIONS_CHARS}
              rows={6}
              aria-label="Instructions"
              placeholder="How this bot should work in a room…"
              onChange={(e) => setInstructions(e.target.value)}
            />
          </FormRow>
        </div>
      </div>
      {notice ? (
        <p className="room-warning" role="alert">
          {notice}
        </p>
      ) : null}
      <div className="board-actions">
        {bot ? (
          <ConfirmButton
            label={`Delete ${bot.name}`}
            confirmLabel="Delete?"
            className="btn btn-small btn-ghost board-delete"
            danger
            onConfirm={() => {
              void deleteBot(bot.id)
                .then(() => {
                  onDeleted(bot.id);
                  onClose();
                })
                .catch((e: unknown) => {
                  setNotice(errorText(e));
                  onNotice(errorText(e));
                });
            }}
          />
        ) : null}
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" disabled={!valid || saving} onClick={() => void save()}>
          {bot ? "Save bot" : "Create bot"}
        </button>
      </div>
    </Dialog>
  );
}
