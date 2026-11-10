// One lightweight metadata stream feeds both the sidebar's sessions and rooms.
// A module-level listener set keeps their projection code independent while the
// browser process keeps just one EventSource and its shared reconnect policy.
import { useEffect, useRef } from "react";
import type { OverviewEvent } from "../shared/protocol.js";
import { OverviewStream } from "./stream.js";

const listeners = new Set<(event: OverviewEvent) => void>();
let connection: OverviewStream | null = null;

export function useOverviewStream(onEvent: (event: OverviewEvent) => void): void {
  const callback = useRef(onEvent);
  callback.current = onEvent;
  useEffect(() => {
    const listener = (event: OverviewEvent) => callback.current(event);
    if (!connection) connection = new OverviewStream({ onEvent: (event) => { for (const current of listeners) current(event); }, onState: () => undefined, onGone: () => undefined });
    const first = listeners.size === 0;
    listeners.add(listener);
    if (first) connection.start();
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        connection?.stop();
        connection = null;
      }
    };
  }, []);
}
