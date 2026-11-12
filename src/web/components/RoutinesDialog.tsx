// Routines: a prompt on a cadence, in a project, on a harness. The server runs
// them (the 30 s tick in index.ts) with no browser open; this dialog is how they
// are made, turned off, run once, read back (their last few runs), and removed.
import { useEffect, useState } from "react";
import type { HarnessStatus, Routine, RoutineOutcome, RoutineRun, WorkspaceInfo } from "../../shared/protocol.js";
import type { RoutineCadence } from "../../shared/routine-schedule.js";
import { cadenceLabel } from "../../shared/routine-schedule.js";
import { api, errorText } from "../api.js";
import { IconX } from "../icons.js";
import { Dialog } from "./Dialog.js";

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/** A few expressions worth one click, in the same five fields the cron box takes. */
const CRON_PRESETS = ["*/15 * * * *", "0 * * * *", "0 9 * * 1-5", "30 18 * * 5"];
/** How many of a routine's last runs its row shows: enough to see a couple of nights, not a log. */
const RUN_ROWS_PER_ROUTINE = 3;
type Kind = RoutineCadence["kind"];

/** How a run ended, in the list's words: "posted 09:00", "quiet 09:00", "skipped 09:00 — precheck exited 1". */
function outcomeWords(outcome: RoutineOutcome): string {
  switch (outcome) {
    case "posted":
      return "posted";
    case "quiet":
      return "quiet";
    case "skipped":
      return "skipped";
    case "failed":
      return "failed";
    case "launched":
      return "running";
  }
}

/** When a run happened, as the list's rows show it. */
function runWhen(run: RoutineRun): string {
  return new Date(run.startedAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

/** How the last slot ended, in the list's words: "posted 09:00", "skipped 09:00 — precheck exited 1". */
function outcomeText(routine: Routine): string {
  if (!routine.lastRunOutcome) return "";
  const at = routine.lastRunAt ? new Date(routine.lastRunAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  const verb = outcomeWords(routine.lastRunOutcome);
  const when = at ? `${verb} ${at}` : verb;
  return routine.lastRunDetail ? `${when} — ${routine.lastRunDetail}` : when;
}

export function RoutinesDialog({ harnesses, workspaces, onClose, onOpenChat }: { harnesses: HarnessStatus[]; workspaces: WorkspaceInfo[]; onClose: () => void; onOpenChat: (chatId: string) => void }) {
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  /** The last few runs of each routine, newest first (the server keeps the full history). */
  const [runs, setRuns] = useState<RoutineRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [precheck, setPrecheck] = useState("");
  const [harnessId, setHarnessId] = useState(harnesses[0]?.id ?? "");
  const [workspaceId, setWorkspaceId] = useState(workspaces[0]?.id ?? "");
  const [kind, setKind] = useState<Kind>("daily");
  const [time, setTime] = useState("09:00");
  const [minute, setMinute] = useState(0);
  const [weekday, setWeekday] = useState(1);
  const [cron, setCron] = useState("0 9 * * 1-5");
  const [onceAt, setOnceAt] = useState("");
  const [timezone, setTimezone] = useState("");
  /** The optional stops: no run after a date, after a number of runs, or long after a missed slot. */
  const [until, setUntil] = useState("");
  const [maxRuns, setMaxRuns] = useState("");
  const [grace, setGrace] = useState("");

  const load = async () => {
    try {
      const [list, history] = await Promise.all([
        api<{ routines: Routine[] }>("/api/routines"),
        api<{ runs: RoutineRun[] }>(`/api/routines/runs?limit=${RUN_ROWS_PER_ROUTINE * 4}`),
      ]);
      setRoutines(list.routines);
      setRuns(history.runs);
    } catch (failure) {
      setError(errorText(failure));
    }
  };
  useEffect(() => {
    void load();
  }, []);

  const cadence = (): RoutineCadence => {
    if (kind === "hourly") return { kind: "hourly", minute };
    if (kind === "cron") return { kind: "cron", expr: cron.trim() };
    if (kind === "once") return { kind: "once", at: new Date(onceAt).getTime() };
    const [h, m] = time.split(":").map(Number);
    const hour = h ?? 9;
    const at = m ?? 0;
    return kind === "weekly" ? { kind: "weekly", weekday, hour, minute: at } : { kind, hour, minute: at };
  };

  /** The stops as the wire takes them: empty boxes are no limit at all. */
  const limits = () => ({
    timezone: timezone.trim(),
    until: until ? new Date(`${until}T23:59`).getTime() : null,
    maxRuns: maxRuns.trim() ? Number(maxRuns) : null,
    graceMinutes: grace.trim() ? Number(grace) : 0,
  });

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api<Routine>("/api/routines", { method: "PUT", body: { name: name.trim(), prompt: prompt.trim(), harnessId, workspaceId, cadence: cadence(), precheck: precheck.trim(), ...limits() } });
      setName("");
      setPrompt("");
      setPrecheck("");
      setUntil("");
      setMaxRuns("");
      setGrace("");
      await load();
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
    }
  };

  /** The PUT replaces the whole routine, so the row's fields go back with a new flag. */
  const setEnabled = async (routine: Routine, enabled: boolean) => {
    setError(null);
    // The checkbox answers at once; the PUT confirms it, and a failure reloads the
    // truth rather than leaving the row saying something the server does not.
    setRoutines((current) => current?.map((r) => (r.id === routine.id ? { ...r, enabled } : r)) ?? current);
    try {
      await api("/api/routines", {
        method: "PUT",
        body: {
          id: routine.id,
          name: routine.name,
          prompt: routine.prompt,
          harnessId: routine.harnessId,
          workspaceId: routine.workspaceId,
          cadence: routine.cadence,
          precheck: routine.precheck,
          timezone: routine.timezone,
          until: routine.until,
          maxRuns: routine.maxRuns,
          graceMinutes: routine.graceMinutes,
          enabled,
        },
      });
      await load();
    } catch (failure) {
      setError(errorText(failure));
      await load();
    }
  };

  const remove = async (routine: Routine) => {
    setError(null);
    try {
      await api(`/api/routines/${encodeURIComponent(routine.id)}`, { method: "DELETE" });
      await load();
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  /** Run a routine now, without moving its own slot: the same work its next tick would do. */
  const runNow = async (routine: Routine) => {
    setError(null);
    try {
      await api(`/api/routines/${encodeURIComponent(routine.id)}/run`, { method: "POST" });
      await load();
    } catch (failure) {
      setError(errorText(failure));
    }
  };

  const canSave = Boolean(name.trim() && prompt.trim() && harnessId && workspaceId) && !busy;
  /** This routine's newest runs, as its row shows them. */
  const runsFor = (routineId: string) => runs.filter((run) => run.routineId === routineId).slice(0, RUN_ROWS_PER_ROUTINE);

  return (
    <Dialog title="Routines" onClose={onClose} className="routines">
      <div className="routines-body">
        {routines === null ? <p className="muted">Loading…</p> : null}
        {routines?.length === 0 ? <p className="muted">No routines yet.</p> : null}
        {routines && routines.length > 0 ? (
          <ul className="routines-list" aria-label="Routines">
            {routines.map((routine) => (
              <li key={routine.id} className="routine-row">
                <div className="routine-row-main">
                  <label className="routine-main">
                    <input type="checkbox" checked={routine.enabled} aria-label={`Enable ${routine.name}`} onChange={(e) => void setEnabled(routine, e.target.checked)} />
                    <span className="routine-name">{routine.name}</span>
                    <span className="routine-when">
                      {cadenceLabel(routine.cadence)}
                      {routine.timezone ? ` (${routine.timezone})` : ""} · {routine.nextRunAt === null ? "no further run" : `next ${new Date(routine.nextRunAt).toLocaleString()}`}
                    </span>
                    {routine.halted ? <span className="routine-halted">{routine.halted}</span> : null}
                    {routine.precheck ? (
                      <span className="routine-precheck" title={routine.precheck}>
                        precheck: {routine.precheck}
                      </span>
                    ) : null}
                    {routine.lastRunOutcome ? (
                      <span className={`routine-outcome routine-outcome-${routine.lastRunOutcome}`} title={routine.lastRunDetail ?? undefined}>
                        {outcomeText(routine)}
                      </span>
                    ) : null}
                  </label>
                  {runsFor(routine.id).length > 0 ? (
                    <ul className="routine-runs" aria-label={`Recent runs of ${routine.name}`}>
                      {runsFor(routine.id).map((run) => (
                        <li key={run.id} className={`routine-run routine-outcome-${run.outcome}`}>
                          <span className="routine-run-when">{runWhen(run)}</span>
                          <span className="routine-run-words" title={run.detail ?? undefined}>
                            {run.detail ? `${outcomeWords(run.outcome)} — ${run.detail}` : outcomeWords(run.outcome)}
                          </span>
                          {run.chatId ? (
                            <button type="button" className="link-btn" onClick={() => onOpenChat(run.chatId as string)}>
                              Open
                            </button>
                          ) : null}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
                <button type="button" className="btn btn-ghost btn-small" aria-label={`Run ${routine.name} now`} onClick={() => void runNow(routine)}>
                  Run now
                </button>
                <button type="button" className="icon-btn" aria-label={`Delete ${routine.name}`} onClick={() => void remove(routine)}>
                  <IconX size={13} />
                </button>
              </li>
            ))}
          </ul>
        ) : null}

        <form
          className="routines-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (canSave) void save();
          }}
        >
          <h3>New routine</h3>
          <input className="input" aria-label="Routine name" placeholder="Nightly review" value={name} onChange={(e) => setName(e.target.value)} />
          <textarea className="input" aria-label="Prompt" rows={3} placeholder="Review today's commits and list what needs me." value={prompt} onChange={(e) => setPrompt(e.target.value)} />
          <input className="input" aria-label="Precheck command" placeholder="Optional precheck command: run in the project first, a non-zero exit skips this run" value={precheck} onChange={(e) => setPrecheck(e.target.value)} />
          <div className="routines-picks">
            <label>
              Project
              <select aria-label="Project" value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)}>
                {workspaces.map((w) => (
                  <option key={w.id} value={w.id}>
                    {w.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Agent
              <select aria-label="Agent" value={harnessId} onChange={(e) => setHarnessId(e.target.value)}>
                {harnesses.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.displayName}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="routines-picks">
            <label>
              When
              <select aria-label="When" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
                <option value="hourly">Hourly</option>
                <option value="daily">Daily</option>
                <option value="weekdays">Weekdays</option>
                <option value="weekly">Weekly</option>
                <option value="cron">Cron</option>
                <option value="once">Once</option>
              </select>
            </label>
            {kind === "hourly" ? (
              <label>
                Minute
                <input type="number" min={0} max={59} aria-label="Minute" value={minute} onChange={(e) => setMinute(Math.max(0, Math.min(59, Number(e.target.value) || 0)))} />
              </label>
            ) : kind === "cron" ? null : kind === "once" ? (
              <label>
                At
                <input type="datetime-local" aria-label="Once at" value={onceAt} onChange={(e) => setOnceAt(e.target.value)} />
              </label>
            ) : (
              <label>
                At
                <input type="time" aria-label="At" value={time} onChange={(e) => setTime(e.target.value)} />
              </label>
            )}
            <label>
              Timezone
              <input className="input input-short" aria-label="Timezone" placeholder="this machine" value={timezone} onChange={(e) => setTimezone(e.target.value)} />
            </label>
            {kind === "weekly" ? (
              <label>
                Day
                <select aria-label="Day" value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>
                  {WEEKDAYS.map((day, index) => (
                    <option key={day} value={index}>
                      {day}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          {kind === "cron" ? (
            <div className="routines-cron">
              <label>
                Cron
                <input className="input" aria-label="Cron expression" placeholder="0 9 * * 1-5" value={cron} onChange={(e) => setCron(e.target.value)} />
              </label>
              <div className="routines-presets">
                {CRON_PRESETS.map((preset) => (
                  <button key={preset} type="button" className="btn btn-ghost btn-small" onClick={() => setCron(preset)}>
                    {preset}
                  </button>
                ))}
              </div>
              <p className="muted routines-hint">minute hour day-of-month month day-of-week: *, a number, a-b, */n, or a comma list.</p>
            </div>
          ) : null}
          <div className="routines-picks">
            <label>
              Stop after
              <input type="date" aria-label="Runs until" value={until} onChange={(e) => setUntil(e.target.value)} />
            </label>
            <label>
              Runs
              <input className="input input-short" type="number" min={1} max={10000} aria-label="At most this many runs" placeholder="no limit" value={maxRuns} onChange={(e) => setMaxRuns(e.target.value)} />
            </label>
            <label>
              Grace (min)
              <input className="input input-short" type="number" min={0} max={1440} aria-label="Grace minutes" placeholder="no limit" value={grace} onChange={(e) => setGrace(e.target.value)} />
            </label>
          </div>
          {error ? (
            <p className="routines-error" role="alert">
              {error}
            </p>
          ) : null}
          <div className="dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
            <button type="submit" className="btn btn-primary" disabled={!canSave}>
              Add routine
            </button>
          </div>
        </form>
      </div>
    </Dialog>
  );
}
