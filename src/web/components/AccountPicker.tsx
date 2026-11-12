// Native account choice as an opaque provider/index id, never a credential or email.
// Harness adapters may offer /session pin even if their models rarely change.
import { useEffect, useState } from "react";
import type { ChatState } from "../chat-state.js";
import type { OauthAccountChoice } from "../../shared/protocol.js";
import { api, errorText } from "../api.js";

export function AccountPicker({ chat }: { chat: ChatState }) {
  const [choices, setChoices] = useState<OauthAccountChoice[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let mounted = true;
    if (!chat.capabilities.supportsAccountSelection) return;
    void api<{ accounts: OauthAccountChoice[] }>(`/api/chats/${chat.chatId}/accounts`).then((result) => {
      if (mounted) setChoices(result.accounts);
    }).catch(() => mounted && setChoices([]));
    return () => { mounted = false; };
  }, [chat.capabilities.supportsAccountSelection, chat.chatId]);
  if (!chat.capabilities.supportsAccountSelection || !choices?.some((choice) => choice.supported) ) return null;
  const idle = chat.status === "idle" || chat.status === "error";
  return (
    <div className="config-row">
      <label htmlFor={`account-${chat.chatId}`} className="config-row-label">Account</label>
      <div className="config-account-picker">
        <select
          id={`account-${chat.chatId}`}
          className="input"
          aria-label="Native session account"
          disabled={!idle || busy}
          value={choices.find((choice) => choice.current)?.id ?? "default"}
          onChange={async (e) => {
            setBusy(true); setError(null);
            try {
              await api(`/api/chats/${chat.chatId}/account`, { body: { id: e.target.value } });
            } catch (e) {
              setError(errorText(e));
            } finally { setBusy(false); }
          }}
        >
          <option value="default" disabled={true}>Native account…</option>
          {choices.filter((a) => a.supported).map((a) => <option key={a.id} value={a.id}>{a.provider} account {a.index}</option>)}
        </select>

        {error ? <span className="notice-error">{error}</span> : null}
      </div>
    </div>
  );
}
