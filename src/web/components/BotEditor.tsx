// A bot profile's form: which harness runs it, which real model and thinking
// level that harness offers here, its instructions (sent on every invocation),
// its role label, and its accent. Capability-gated: a control appears only when
// the harness says it has one, and never with a fictional universal value.
import { useEffect, useState } from "react";
import type { BotProfile, HarnessStatus, ModelInfo, WorkspaceInfo } from "../../shared/protocol.js";
import { BOARD_MAX_BOT_NAME_CHARS, BOARD_MAX_INSTRUCTIONS_CHARS, BOARD_MAX_ROLE_CHARS, HARNESS_ACCENTS } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { createBot, deleteBot, patchBot } from "../rooms.js";
import { IconRefresh } from "../icons.js";
import { ConfirmButton } from "./ConfirmButton.js";
import { Select } from "./Select.js";
import { Dialog } from "./Dialog.js";
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

  return (
    <Dialog title={bot ? `Edit ${bot.name}` : "New bot"} onClose={onClose} className="bot-editor-dialog">
      <div className="board-form">
        <label className="room-field">
          <span>Name</span>
          <input type="text" value={name} maxLength={BOARD_MAX_BOT_NAME_CHARS} aria-label="Bot name" onChange={(e) => setName(e.target.value)} />
        </label>
        {bot || !harness?.capabilities.supportsModelSelection ? (
          <label className="room-field">
            <span>Harness</span>
            {bot ? (
              <span className="board-static" title="A bot's harness cannot change; create a new profile instead">
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
          </label>
        ) : null}
        {workspaces.length > 1 ? (
          <label className="room-field">
            <span>Model catalog from</span>
            <Select
              label="Model catalog workspace"
              value={workspaceId}
              onChange={setWorkspaceId}
              options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
            />
          </label>
        ) : null}
        {harness?.capabilities.supportsModelSelection ? (
          <div className="board-field">
            <span className="board-field-label">{bot ? "Model" : "Harness & model"}</span>
            <div className="board-model-row">
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
              <button type="button" className="icon-btn" aria-label="Refresh models" title="Re-read this harness's models" onClick={() => void loadModels()}>
                <IconRefresh size={14} />
              </button>
            </div>
            {model !== null ? (
              <button type="button" className="btn btn-small btn-ghost" onClick={() => setModel(null)}>
                Use the harness default
              </button>
            ) : null}
            {modelsError ? <p className="room-warning">{modelsError}</p> : null}
            {staleModel ? (
              <p className="room-warning">
                “{staleModel}” is not offered by {harness?.displayName ?? harnessId} here, so it was cleared: pick a model from the list, or leave Harness default.
              </p>
            ) : null}
          </div>
        ) : null}
        {harness?.capabilities.supportsPermissionMode ? (
          <label className="room-field">
            <span>Permission mode</span>
            <input
              type="text"
              value={permissionMode}
              aria-label="Permission mode"
              placeholder="Harness default"
              onChange={(e) => setPermissionMode(e.target.value)}
            />
            <span className="board-hint">The harness's own mode id. awui checks it when the bot runs; a mode it refuses is reported, never silently ignored.</span>
          </label>
        ) : null}
        <div className="room-field">
          <span>Role</span>
          <div className="board-role-presets" role="group" aria-label="Role presets">
            {ROLE_PRESETS.map((preset) => (
              <button
                key={preset.label}
                type="button"
                className="board-role-preset"
                aria-pressed={role.trim().toLowerCase() === preset.label}
                title={preset.instructions}
                onClick={() => {
                  setRole(preset.label);
                  // Fill the instructions from the preset, but never over text the user wrote:
                  // an empty field, or one still holding another preset's words, may be replaced.
                  setInstructions((previous) => {
                    const trimmed = previous.trim();
                    const untouched = trimmed === "" || ROLE_PRESETS.some((p) => p.instructions.trim() === trimmed);
                    return untouched ? preset.instructions : previous;
                  });
                }}
              >
                {preset.label}
              </button>
            ))}
          </div>
          <input type="text" value={role} maxLength={BOARD_MAX_ROLE_CHARS} aria-label="Role" placeholder="lead, researcher, critic…" onChange={(e) => setRole(e.target.value)} />
          <span className="board-hint">{ROLE_PRESETS.find((preset) => preset.label === role.trim().toLowerCase())?.hint ?? "A label for you; routing follows mentions, never the role."}</span>
        </div>
        <label className="room-field">
          <span>Accent</span>
          <Select
            label="Accent"
            value={accent}
            onChange={setAccent}
            options={[{ value: "", label: "Theme default" }, ...ACCENTS.map((token) => ({ value: token, label: token, dot: `var(--${token})` }))]}
          />
        </label>
        <label className="room-field">
          <span>Instructions</span>
          <textarea
            value={instructions}
            maxLength={BOARD_MAX_INSTRUCTIONS_CHARS}
            rows={6}
            aria-label="Instructions"
            placeholder="How this bot should work in a room…"
            onChange={(e) => setInstructions(e.target.value)}
          />
          <span className="board-hint">Sent with every invocation, because harnesses have no portable system prompt. A room's history cannot erase them.</span>
        </label>
      </div>
      {notice ? (
        <p className="room-warning" role="alert">
          {notice}
        </p>
      ) : null}
      <div className="board-actions">
        <button type="button" className="btn btn-primary" disabled={!valid || saving} onClick={() => void save()}>
          {bot ? "Save profile" : "Create bot"}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
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
      </div>
    </Dialog>
  );
}
