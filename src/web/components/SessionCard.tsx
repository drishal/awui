// A session's hover card (T3 Code's thread hover card): resting the mouse on a
// sidebar row shows its last prompt and the start of the answer, the model,
// how many turns, and the files it changed, without opening it. The preview
// is the server's read-only one (a live chat's state, else the harness's file,
// never starting the harness), fetched once per version of the session.
import { useEffect, useRef, useState } from "react";
import type { ProjectSession, SessionPreview } from "../../shared/protocol.js";
import { api } from "../api.js";
import { harnessColor } from "../harness-colors.js";
import { useCardPlace } from "../hover-card.js";
import { plainPreview } from "../session-groups.js";
import { agentStatusText } from "../agent-status.js";

const cache = new Map<string, Promise<SessionPreview | null>>();

function preview(s: ProjectSession): Promise<SessionPreview | null> {
  const key = `${s.id}@${s.updatedAt ?? ""}`;
  let hit = cache.get(key);
  if (!hit) {
    const q = new URLSearchParams({ harnessId: s.harnessId, workspaceId: s.workspaceId, sessionId: s.id });
    hit = api<SessionPreview>(`/api/sessions/preview?${q}`).catch(() => null);
    cache.set(key, hit);
    if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  }
  return hit;
}

export function SessionCard({ s, anchor, harnessName, project, id, provenance }: { s: ProjectSession; anchor: DOMRect; harnessName: string; project: string; id: string; provenance?: string | null }) {
  const [data, setData] = useState<SessionPreview | null | undefined>(undefined);
  const card = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let live = true;
    void preview(s).then((p) => live && setData(p));
    return () => {
      live = false;
    };
  }, [s.id, s.updatedAt]);
  // Beside the row, kept inside the window once its height is known.
  const { left, top } = useCardPlace(card, anchor, "right", [data]);
  const model = data?.model?.split("/").pop();
  return (
    <div ref={card} id={id} role="tooltip" className="session-card" style={{ left, top, ...harnessColor(s.harnessId) }}>
      <div className="session-card-title">{s.title}</div>
      <div className="session-card-meta">
        <span className="badge badge-harness">{harnessName}</span>
        {project ? <span>{project}</span> : null}
        {data ? <span>{data.turns === 1 ? "1 turn" : `${data.turns} turns`}</span> : null}
        {model ? <span className="session-card-model">{model}</span> : null}
      </div>
      {provenance ? <p className="session-card-provenance">{provenance}</p> : null}
      {s.agentStatus ? <p className={`session-card-status is-${s.agentStatus.state}`}>{agentStatusText(s.agentStatus)}</p> : null}
      {data === undefined ? (
        <div className="session-card-loading muted">Loading…</div>
      ) : data === null ? (
        <div className="session-card-loading muted">No preview for this session</div>
      ) : (
        <>
          {data.prompt ? (
            <div className="session-card-prompt">
              <p className="session-card-clamp">{data.prompt}</p>
            </div>
          ) : null}
          {data.answer ? <p className="session-card-answer">{plainPreview(data.answer)}</p> : null}
          {data.files.length > 0 ? (
            <ul className="session-card-files" aria-label="Files changed">
              {data.files.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          ) : null}
        </>
      )}
    </div>
  );
}
