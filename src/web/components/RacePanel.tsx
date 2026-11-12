// Races: one prompt sent to several isolated worktree chats, as the panel that
// compares them. A row per member shows what its chat is doing and what it changed
// against the fork point; a file opens its diff; one member can be picked as the
// winner (kept, or copied into the project's working tree), and the losers can be
// cleaned up with the reasons git gives for keeping one. The server holds every
// record (races.ts); this only draws it and asks.
import { useEffect, useState } from "react";
import type { BreakdownRules } from "../../shared/breakdown.js";
import type { HarnessStatus, RaceCleanupResult, RaceMemberView, RaceSummary, RaceWinnerResult, ToolDiff } from "../../shared/protocol.js";
import { ago } from "../turns.js";
import { api, errorText } from "../api.js";
import { Dialog } from "./Dialog.js";
import { CodeBreakdown } from "./CodeBreakdown.js";
import { DiffView } from "./ToolBody.js";

const STATUS_WORD: Record<RaceMemberView["status"], string> = { running: "running", settled: "finished", failed: "failed", closed: "chat closed" };

/** Why a cleanup would keep this loser, in the panel's words. */
function loserState(member: RaceMemberView): string {
  if (member.status === "running") return "still running";
  if (member.dirty) return "has uncommitted work";
  if ((member.unmerged ?? 0) > 0) return `${member.unmerged} unmerged commit${member.unmerged === 1 ? "" : "s"}`;
  if (member.status === "closed") return "clean, chat closed";
  return "clean";
}

const CLEANUP_WORD: Record<string, string> = {
  running: "kept: still running",
  uncommitted: "kept: uncommitted work",
  moved: "kept: its HEAD moved off the branch",
  unmerged: "kept: unmerged commits",
  branch_kept: "worktree removed, branch kept",
  worktree_gone: "worktree was already gone",
  worktree_refused: "kept: git refused to remove it",
  outside_project: "kept: its worktree is outside the project",
};

export function RacePanel({
  initialRaceId,
  harnesses,
  breakdown,
  onOpenChat,
  onClose,
}: {
  initialRaceId: string | null;
  harnesses: HarnessStatus[];
  /** config.yml's `breakdown:` globs, for the source / tests / generated chip. */
  breakdown: BreakdownRules;
  onOpenChat(chatId: string): void;
  onClose(): void;
}) {
  const [races, setRaces] = useState<RaceSummary[] | null>(null);
  const [race, setRace] = useState<RaceSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"keep" | "apply">("keep");
  const [discard, setDiscard] = useState<string[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [cleaned, setCleaned] = useState<RaceCleanupResult["results"] | null>(null);
  const [open, setOpen] = useState<{ chatId: string; path: string; diff: ToolDiff | null } | null>(null);

  const nameOf = (harnessId: string) => harnesses.find((h) => h.id === harnessId)?.displayName ?? harnessId;

  const loadList = async () => {
    try {
      setRaces((await api<{ races: RaceSummary[] }>("/api/races")).races);
    } catch (e) {
      setError(errorText(e));
    }
  };
  const loadRace = async (id: string) => {
    try {
      setRace(await api<RaceSummary>(`/api/races/${id}`));
    } catch (e) {
      setError(errorText(e));
    }
  };

  useEffect(() => {
    if (initialRaceId) void loadRace(initialRaceId);
    else void loadList();
  }, [initialRaceId]);

  // Members finish while the panel is open: read the race again every few seconds until none is running, so
  // "running" does not stay on a chat that has long settled. A click in flight is never raced by a refresh.
  const raceId = race?.id;
  const anyRunning = race?.members.some((member) => member.status === "running") ?? false;
  useEffect(() => {
    if (!raceId || !anyRunning || busy) return;
    const timer = window.setInterval(() => void loadRace(raceId), 3000);
    return () => window.clearInterval(timer);
    // loadRace only closes over setters.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [raceId, anyRunning, busy]);

  /** Every action answers with the race as it stands, so one state update is enough. */
  const apply = (result: { race: RaceSummary }) => {
    setRace(result.race);
    setRaces((current) => current && current.map((row) => (row.id === result.race.id ? { ...row, ...result.race } : row)));
  };
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const pick = (chatId: string) =>
    run(async () => {
      const result = await api<RaceWinnerResult>(`/api/races/${race?.id}/winner`, { body: { chatId, mode } });
      apply(result);
      setNotice(result.instructions);
      setCleaned(null);
    });
  const cleanUp = () =>
    run(async () => {
      const result = await api<RaceCleanupResult>(`/api/races/${race?.id}/cleanup`, { body: { discard } });
      apply(result);
      setCleaned(result.results);
      setDiscard([]);
      setOpen(null);
    });
  const showDiff = (chatId: string, file: string) =>
    run(async () => {
      const result = await api<{ path: string; diff: ToolDiff | null }>(`/api/races/${race?.id}/members/${chatId}/diff?path=${encodeURIComponent(file)}`);
      setOpen({ chatId, path: result.path, diff: result.diff });
    });

  const losers = race ? race.members.filter((member) => !member.winner) : [];
  return (
    <Dialog title="Races" onClose={onClose} className="dialog-wide">
      {error ? <p className="notice notice-error">{error}</p> : null}
      {race ? (
        <>
          <div className="race-head">
            <button className="btn btn-small" onClick={() => { setRace(null); setOpen(null); setCleaned(null); setNotice(null); void loadList(); }}>
              All comparisons
            </button>
            <button className="btn btn-small" disabled={busy} onClick={() => void loadRace(race.id)}>Refresh</button>
            <span className="muted">{race.workspaceName} · from {race.base} · {ago(race.createdAt)}</span>
          </div>
          <p className="race-prompt">{race.prompt}</p>
          <fieldset className="race-mode">
            <legend>Picking a winner</legend>
            <label className="checkbox">
              <input type="radio" name="race-mode" checked={mode === "keep"} onChange={() => setMode("keep")} />
              Keep its branch
            </label>
            <label className="checkbox">
              <input type="radio" name="race-mode" checked={mode === "apply"} onChange={() => setMode("apply")} />
              Apply its changes to this project
            </label>
          </fieldset>
          <ul className="race-members">
            {race.members.map((member) => (
              <li className={`race-member${member.winner ? " is-winner" : ""}`} key={member.chatId}>
                <div className="race-member-head">
                  <strong>{nameOf(member.harnessId)}</strong>
                  {member.model ? <span className="muted">{member.model}</span> : null}
                  <span className="race-status">{STATUS_WORD[member.status]}</span>
                  {member.winner ? <span className="race-winner">Winner</span> : null}
                  <span className="race-counts" title="Lines added and removed against the fork point">
                    +{member.added ?? 0} −{member.removed ?? 0}
                  </span>
                  <CodeBreakdown files={member.files} rules={breakdown} />
                  <span className="race-branch muted">{member.branch}</span>
                  {member.status !== "closed" ? (
                    <button className="btn btn-small" onClick={() => onOpenChat(member.chatId)}>
                      Open chat
                    </button>
                  ) : null}
                  {member.winner ? null : (
                    <button className="btn btn-small" disabled={busy} onClick={() => void pick(member.chatId)}>
                      Pick {nameOf(member.harnessId)}
                    </button>
                  )}
                </div>
                {member.answer ? <p className="race-answer">{member.answer}</p> : null}
                {member.files && member.files.length > 0 ? (
                  <ul className="race-files">
                    {member.files.map((file) => (
                      <li key={file.path}>
                        <button className="race-file" onClick={() => void showDiff(member.chatId, file.path)}>
                          {file.path}
                        </button>
                        <span className="muted">
                          {file.binary ? "binary" : `+${file.added} −${file.removed}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="muted race-none">Nothing changed against the fork point.</p>
                )}
                {open && open.chatId === member.chatId ? (
                  <div className="race-diff">
                    <p className="muted">{open.path}</p>
                    {open.diff ? <DiffView diff={open.diff} expanded /> : <p className="muted">No change in this file now.</p>}
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
          {notice ? <p className="notice">{notice}</p> : null}
          {race.winnerChatId ? (
            <section className="race-cleanup" aria-label="Clean up the losers">
              <h3>Clean up the losers</h3>
              <p className="muted">Each worktree goes only when it has nothing left to lose; one whose branch this project does not have is kept, unless you tick it.</p>
              <ul className="race-losers">
                {losers.map((member) => (
                  <li key={member.chatId}>
                    <span>{nameOf(member.harnessId)}</span>
                    <span className="muted">{loserState(member)}</span>
                    {(member.unmerged ?? 0) > 0 ? (
                      <label className="checkbox">
                        <input
                          type="checkbox"
                          checked={discard.includes(member.chatId)}
                          onChange={(e) => setDiscard((current) => (e.target.checked ? [...current, member.chatId] : current.filter((id) => id !== member.chatId)))}
                        />
                        Discard its branch
                      </label>
                    ) : null}
                  </li>
                ))}
              </ul>
              {losers.length > 0 ? (
                <button className="btn" disabled={busy} onClick={() => void cleanUp()}>
                  Clean up {losers.length} loser{losers.length === 1 ? "" : "s"}
                </button>
              ) : (
                <p className="muted">Only the winner is left.</p>
              )}
              {cleaned ? (
                <ul className="race-cleanup-results" aria-label="What the cleanup did">
                  {cleaned.map((row) => (
                    <li key={row.chatId}>
                      {nameOf(race.members.find((m) => m.chatId === row.chatId)?.harnessId ?? row.chatId)}: {row.reason ? CLEANUP_WORD[row.reason] ?? row.reason : "worktree and branch removed"}
                    </li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}
        </>
      ) : (
        <>
          <div className="race-head">
            <button className="btn btn-small" disabled={busy} onClick={() => void loadList()}>Refresh</button>
            <span className="muted">One prompt, several worktree chats. Compare them here, keep a winner, and clean up the rest.</span>
          </div>
          {races === null ? <p className="muted">Loading…</p> : null}
          {races && races.length === 0 ? <p className="muted">No comparisons yet. Start one from the palette: “Compare agents in isolated worktrees”.</p> : null}
          <ul className="race-list">
            {(races ?? []).map((row) => (
              <li key={row.id}>
                <button className="race-row" onClick={() => { setNotice(null); setCleaned(null); setOpen(null); void loadRace(row.id); }}>
                  <span className="race-row-title">{row.workspaceName}</span>
                  <span className="race-row-prompt">{row.prompt}</span>
                  <span className="muted">
                    {row.members.length} agent{row.members.length === 1 ? "" : "s"} · {ago(row.createdAt)}
                    {row.winnerChatId ? " · winner picked" : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
    </Dialog>
  );
}
