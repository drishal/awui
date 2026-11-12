// Limited-session invitations (grants.ts): who may hold one, and what it allows.
// A session signed in with an invitation can only do what the invitation names;
// every other action is refused with `missing_grant`. Managing them is a
// settings.manage action of its own, so a limited session never widens itself.
import { useEffect, useState } from "react";
import type { GrantValue, InviteCreate } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";
import { FormRow } from "./FormRow.js";
import { IconPlus, IconX } from "../icons.js";

interface InviteRow {
  id: string;
  name: string;
  grants: GrantValue[];
  createdAt: number;
}

interface InvitesResponse {
  invites: InviteRow[];
  all: GrantValue[];
}

/** The grants' words, as the invite editor reads them. */
const GRANT_LABEL: Record<GrantValue, string> = {
  "chat.read": "Read chats",
  "chat.write": "Send and manage chats",
  "chat.approve": "Approve",
  "settings.manage": "Manage settings",
  "workspaces.manage": "Open workspaces",
  "routines.manage": "Manage routines",
  "boards.manage": "Manage board rooms",
};

/** The dialog's section ids (SettingsDialog's own list); the invites panel is one of them. */
export type SectionIdOf = string;

export function InvitationsPanel({ current }: { current: SectionIdOf }) {
  const [invites, setInvites] = useState<InvitesResponse | null>(null);
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<Set<GrantValue>>(new Set(["chat.read"]));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const refresh = () => {
    void api<InvitesResponse>("/api/invites")
      .then((r) => setInvites(r))
      .catch((e: unknown) => setError(errorText(e)));
  };

  useEffect(refresh, []);

  const create = async () => {
    if (!name.trim() || picked.size === 0) return;
    setError(null);
    try {
      const input: InviteCreate = { name: name.trim(), grants: [...picked] };
      await api("/api/invites", { method: "POST", body: input });
      setName("");
      setSaved(true);
      refresh();
    } catch (e) {
      setError(errorText(e));
    }
  };

  const toggle = (grant: GrantValue) => {
    setPicked((p) => {
      const next = new Set(p);
      if (next.has(grant)) next.delete(grant);
      else next.add(grant);
      return next;
    });
    setSaved(false);
  };

  const revoke = async (id: string) => {
    setError(null);
    try {
      await api(`/api/invites/${id}`, { method: "DELETE", body: {} });
      refresh();
    } catch (e) {
      setError(errorText(e));
    }
  };

  return (
    <section className="form-section" id="settings-panel-invites" role="tabpanel" aria-labelledby="settings-invites" hidden={current !== "invites"}>
      <h3 id="settings-invites">Invitations</h3>
      <p className="form-note">A limited sign-in can only do what its invitation names. Revoke to cut a session off at once.</p>
      <div className="form-card">
        <FormRow row="new" label="New invitation" desc="One name and the grants it allows." stack>
          <input className="input" aria-label="Invitation name" placeholder="e.g. Phone (read-only)" value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} />
          <div className="invite-grants">
            {invites?.all.map((grant) => (
              <label className="invite-grant" key={grant}>
                <input type="checkbox" checked={picked.has(grant)} onChange={() => toggle(grant)} />
                <span>{GRANT_LABEL[grant]}</span>
              </label>
            ))}
          </div>
          <button type="button" className="btn btn-small btn-primary" disabled={!name.trim() || picked.size === 0} onClick={() => void create()}>
            <IconPlus size={13} /> Create
          </button>
          {saved ? <span className="form-desc" role="status">Created. Pair the device from its sign-in screen with this invitation.</span> : null}
        </FormRow>
        <FormRow row="list" label="Issued invitations" desc="The newest first; revoke removes it and its holder's grants at once." stack>
          {invites && invites.invites.length > 0 ? (
            <div className="invite-list">
              {invites.invites.map((invite) => (
                <div className="invite-row" key={invite.id}>
                  <span className="invite-name">{invite.name}</span>
                  <span className="invite-grant-names">{invite.grants.map((g) => GRANT_LABEL[g]).join(" · ")}</span>
                  <button type="button" className="ghost-icon" aria-label={`Revoke ${invite.name}`} title="Revoke invitation" onClick={() => void revoke(invite.id)}>
                    <IconX size={14} />
                  </button>
                </div>
                ))}
            </div>
          ) : (
            <p className="form-empty">None issued. Existing password sign-ins keep full access.</p>
          )}
        </FormRow>
      </div>
      {error ? (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
