// The agent dashboard (Orca's board): every unarchived session across projects in three
// columns — Needs you, Working, Done — from the same overview the sidebar draws, kept
// current by the one overview stream. A card previews the session's last answer (the
// same bounded server read the hover card makes; no transcript comes down the stream),
// names its project and harness, shows the line its agent set, badges its pull request,
// and nests the delegated children running under it. Filters narrow by project and by
// pull-request state; a project's pull request is read once per opening.
import { useEffect, useMemo, useState } from "react";
import type { ProjectSession, SessionsOverview } from "../../shared/protocol.js";
import { agentStatusText } from "../agent-status.js";
import { api } from "../api.js";
import {
  BOARD_COLUMNS,
  BOARD_EMPTY,
  BOARD_TITLES,
  boardCards,
  boardCounts,
  boardProjects,
  PR_FILTERS,
  PR_FILTER_LABELS,
  prBadge,
  prStateOf,
  type BoardCard,
  type PrFilter,
  type PrState,
  type PullRequestShape,
} from "../dashboard.js";
import { harnessColor } from "../harness-colors.js";
import { previewLine, sessionPreview } from "../session-preview.js";
import { isWorking } from "../session-groups.js";
import { ago } from "../turns.js";
import { plainTitle } from "../plain-title.js";
import { Select } from "./Select.js";
import { Dialog } from "./Dialog.js";

/**
 * How many cards fetch a preview on opening, per column (three at most, so 24 reads): the
 * rest fetch theirs when the pointer rests on them. Each read is a transcript read on the
 * server, which is why even the eager ones are this few.
 */
const EAGER_PREVIEWS = 8;

export function Dashboard({ overview, harnesses, onOpenSession, onClose }: {
  overview: SessionsOverview;
  harnesses: Array<{ id: string; displayName: string }>;
  onOpenSession: (s: ProjectSession, workspace: SessionsOverview["workspaces"][number] | undefined) => void;
  onClose: () => void;
}) {
  const [project, setProject] = useState<string>("");
  const [pr, setPr] = useState<PrFilter>("any");
  const [prs, setPrs] = useState<Record<string, PullRequestShape | null>>({});
  const [prsRead, setPrsRead] = useState(0);
  const projects = useMemo(() => boardProjects(overview), [overview]);
  const prStates = useMemo(() => {
    const out: Record<string, PrState> = {};
    for (const [id, value] of Object.entries(prs)) out[id] = prStateOf(value);
    return out;
  }, [prs]);
  const cards = useMemo(
    () => boardCards(overview, { project: project || null, pr, prStates, working: (s) => isWorking(s.status) }),
    [overview, project, pr, prStates],
  );
  const counts = boardCounts(cards);
  const names = useMemo(() => new Map(harnesses.map((h) => [h.id, h.displayName])), [harnesses]);
  const byId = useMemo(() => new Map(overview.workspaces.map((w) => [w.id, w])), [overview.workspaces]);

  // Each project's pull request, once: gh is slow and the badge is decoration, so a
  // failure just leaves the project without one (which reads as "no pull request").
  useEffect(() => {
    const wanted = projects.slice(0, 8).map((w) => w.id);
    let cancelled = false;
    void (async () => {
      const read: Record<string, PullRequestShape | null> = {};
      for (const id of wanted) {
        try {
          read[id] = (await api<{ pr: PullRequestShape | null }>(`/api/workspaces/${id}/github/pr`)).pr;
        } catch {
          read[id] = null;
        }
        if (cancelled) return;
      }
      setPrs(read);
      setPrsRead((n) => n + 1);
    })();
    return () => {
      cancelled = true;
    };
  }, [overview.workspaces]);

  return (
    <Dialog title="Agents" onClose={onClose} className="dialog-wide dashboard-dialog">
      <div className="dashboard-filters">
        <div className="dashboard-filter">
          <Select
            value={project}
            options={[{ value: "", label: `Every project (${overview.sessions.filter((s) => !s.archived).length})` }, ...projects.map((w) => ({ value: w.id, label: `${w.name} (${w.count})` }))]}
            onChange={setProject}
            label="Project"
          />
        </div>
        <div className="dashboard-filter">
          <Select
            value={pr}
            options={PR_FILTERS.map((f) => ({ value: f, label: PR_FILTER_LABELS[f] }))}
            onChange={(v) => setPr(v as PrFilter)}
            label="Pull request"
          />
        </div>
        {prsRead === 0 && pr !== "any" ? <span className="muted">Reading each project{"'"}s pull request…</span> : null}
        <button type="button" className="btn btn-small btn-ghost dashboard-close" onClick={onClose}>
          Close
        </button>
      </div>
      <div className="dashboard-board" data-testid="dashboard-board">
        {BOARD_COLUMNS.map((column) => (
          <section key={column} className={`dashboard-column is-${column}`} aria-label={BOARD_TITLES[column]} data-testid={`dashboard-${column}`}>
            <h3 className="dashboard-column-head">
              {BOARD_TITLES[column]} <span className="dashboard-count">{counts[column]}</span>
            </h3>
            {cards[column].length === 0 ? (
              <p className="dashboard-empty muted">{BOARD_EMPTY[column]}</p>
            ) : (
              <ul className="dashboard-cards">
                {cards[column].map((card, index) => (
                  <Card
                    key={card.session.id}
                    card={card}
                    eager={index < EAGER_PREVIEWS}
                    names={names}
                    harnessName={names.get(card.session.harnessId) ?? card.session.harnessId}
                    projectName={byId.get(card.session.workspaceId)?.name ?? ""}
                    pr={prs[card.session.workspaceId] ?? null}
                    onOpen={() => onOpenSession(card.session, byId.get(card.session.workspaceId))}
                    onOpenChild={(child) => onOpenSession(child, byId.get(child.workspaceId))}
                  />
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </Dialog>
  );
}

function Card({ card, eager, names, harnessName, projectName, pr, onOpen, onOpenChild }: {
  card: BoardCard;
  eager: boolean;
  /** Harness id to its display name, for the children's dots. */
  names: ReadonlyMap<string, string>;
  harnessName: string;
  projectName: string;
  pr: PullRequestShape | null;
  onOpen: () => void;
  onOpenChild: (s: ProjectSession) => void;
}) {
  const s = card.session;
  const [wanted, setWanted] = useState(eager);
  const [line, setLine] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    void sessionPreview(s).then((preview) => live && setLine(previewLine(preview)));
    return () => {
      live = false;
    };
  }, [wanted, s.id, s.updatedAt]);
  const badge = prBadge(s, pr ? { [s.workspaceId]: pr } : undefined);
  return (
    <li className="dashboard-card" data-testid="dashboard-card" data-session={s.id} onPointerEnter={() => setWanted(true)}>
      <button type="button" className="dashboard-card-main" onClick={onOpen} title={`Open ${plainTitle(s.title)}`}>
        <span className="dashboard-card-title">
          <span className="harness-dot" style={harnessColor(s.harnessId)} role="img" aria-label={harnessName} />
          {plainTitle(s.title)}
        </span>
        <span className="dashboard-card-meta">
          <span>{projectName}</span>
          <span>{s.updatedAt ? ago(Date.parse(s.updatedAt)) : ""}</span>
          {s.asking ? <span className="dashboard-flag is-needs">needs you</span> : null}
          {s.origin === "agent" ? <span className="dashboard-flag">delegated</span> : null}
        </span>
        {s.agentStatus ? <span className={`dashboard-status is-${s.agentStatus.state}`}>{agentStatusText(s.agentStatus)}</span> : null}
        {line === undefined || line === null ? null : <span className="dashboard-line">{line}</span>}
      </button>
      {badge ? (
        <a className="dashboard-pr" href={badge.url} target="_blank" rel="noreferrer">
          {badge.words}
        </a>
      ) : null}
      {card.children.length > 0 ? (
        <ul className="dashboard-children" aria-label={`Agents working under ${plainTitle(s.title)}`}>
          {card.children.map((child) => (
            <li key={child.id}>
              <button type="button" className="dashboard-child" onClick={() => onOpenChild(child)}>
                <span className="dashboard-child-title">
                  <span className="harness-dot" style={harnessColor(child.harnessId)} role="img" aria-label={names.get(child.harnessId) ?? child.harnessId} />
                  {plainTitle(child.title)}
                </span>
                <span className={`dashboard-child-state is-${child.asking ? "needs" : isWorking(child.status) ? "working" : "done"}`}>
                  {child.asking ? "needs you" : isWorking(child.status) ? "working" : "done"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}
