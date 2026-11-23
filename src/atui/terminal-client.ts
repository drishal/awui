// The project terminal uses the server's existing bounded interactive PTY:
// only real user bytes are sent, never a command. Closing the view disconnects
// the stream and then explicitly closes the PTY; the browser shares the route.
import { readEvents, ServerError } from "./client.js";

export interface ProjectTerminal {
  write(data: Uint8Array): void;
  resize(cols: number, rows: number): void;
  close(): Promise<void>;
}

export async function openProjectTerminal(base: string, workspaceId: string, cols: number, rows: number, handlers: {
  onOutput: (data: string) => void;
  onExit: (code: number, signal?: number) => void;
}): Promise<ProjectTerminal> {
  let closed = false;
  let controller: AbortController | null = null;
  let response: Response;
  try {
    response = await fetch(`${base}/api/workspaces/${encodeURIComponent(workspaceId)}/terminal`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cols, rows }),
    });
  } catch {
    throw new ServerError(0, "network", `Cannot reach the awui server at ${base}`);
  }
  if (!response.ok) {
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    throw new ServerError(response.status, "terminal_start", data?.error ?? "The terminal could not start here");
  }
  const { id } = (await response.json()) as { id: string };
  const root = `${base}/api/workspaces/${encodeURIComponent(workspaceId)}/terminal/${encodeURIComponent(id)}`;
  const decoder = new TextDecoder();
  let writes = Promise.resolve();
  const close = async () => {
    if (closed) return;
    closed = true;
    controller?.abort();
    await fetch(root, { method: "DELETE" }).catch(() => undefined);
  };
  {
    controller = new AbortController();
    void (async () => {
      try {
        const events = await fetch(`${root}/events`, { signal: controller?.signal });
        if (!events.ok || !events.body) throw new Error("The terminal stream could not connect");
        for await (const event of readEvents(events.body)) {
          if (closed) return;
          if (event.event === "terminal") {
            const frame = JSON.parse(event.data) as { text?: string };
            if (typeof frame.text === "string") handlers.onOutput(frame.text);
          } else if (event.event === "exit") {
            const frame = JSON.parse(event.data) as { code?: number; signal?: number };
            handlers.onExit(frame.code ?? 0, frame.signal);
            return;
          }
        }
      } catch {
        if (!closed) handlers.onExit(1);
      }
    })();
  }
  return {
    write(data) {
      if (closed || data.length === 0) return;
      const body = JSON.stringify({ data: decoder.decode(data) });
      writes = writes.then(async () => {
        if (!closed) await fetch(`${root}/write`, { method: "POST", headers: { "content-type": "application/json" }, body }).catch(() => undefined);
      });
    },
    resize(cols, rows) {
      if (closed) return;
      writes = writes.then(async () => {
        if (!closed) await fetch(`${root}/resize`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cols, rows }) }).catch(() => undefined);
      });
    },
    close,
  };
}
