// A stand-in Tern for the Tern client's tests: the tty pair the SDK talks to,
// answering `hello` the way Tern 0.8 does, applying every frame to a document
// it keeps (nodes by id, as Tern addresses them), acking each frame, and
// sending keys and events back. The document is what a test reads; it holds
// what Tern would draw, not how.
import { EventEmitter } from "node:events";
import { KINDS } from "@stencil-hq/tern";

export interface DocNode {
  id: string;
  k: string;
  p: Record<string, unknown>;
  c: string[];
}

interface WireNode {
  id: string;
  k: string;
  p?: Record<string, unknown>;
  c?: WireNode[];
}

const ESC = "\x1b";

export class FakeTern {
  readonly input = Object.assign(new EventEmitter(), { isTTY: true, isRaw: false, setRawMode: () => undefined, resume: () => undefined, pause: () => undefined });
  readonly output = { isTTY: true, columns: 160, write: (data: Uint8Array | string) => this.#write(typeof data === "string" ? data : new TextDecoder().decode(data)) };
  readonly nodes = new Map<string, DocNode>();
  readonly errors: string[] = [];
  /** Every message the program sent, in order: verb and body. */
  readonly sent: Array<{ verb: string; body: unknown }> = [];
  focus: string | null = null;
  #buffer = "";
  #chunks = new Map<string, string>();

  #write(data: string): void {
    this.#buffer += data;
    for (;;) {
      const start = this.#buffer.indexOf(`${ESC}_tsp;`);
      if (start < 0) {
        // DA1 and mode sequences, titles, the clipboard: nothing to draw.
        if (this.#buffer.includes(`${ESC}[c`)) this.#reply(`${ESC}[?62;22c`);
        this.#buffer = this.#buffer.includes(ESC) ? this.#buffer.slice(this.#buffer.lastIndexOf(ESC)) : "";
        return;
      }
      const end = this.#buffer.indexOf(`${ESC}\\`, start);
      if (end < 0) return;
      const before = this.#buffer.slice(0, start);
      if (before.includes(`${ESC}[c`)) this.#reply(`${ESC}[?62;22c`);
      this.#message(this.#buffer.slice(start + 6, end));
      this.#buffer = this.#buffer.slice(end + 2);
    }
  }

  #message(raw: string): void {
    const verb = raw[0] as string;
    let rest = raw.slice(2);
    const params: Record<string, string> = {};
    for (;;) {
      const m = /^([A-Za-z0-9_-]+)=([^; ]*);/.exec(rest);
      if (!m) break;
      params[m[1] as string] = m[2] as string;
      rest = rest.slice(m[0].length);
    }
    if (params.c !== undefined) {
      const joined = (this.#chunks.get(params.c) ?? "") + rest;
      if (params.m === "1") return void this.#chunks.set(params.c, joined);
      this.#chunks.delete(params.c);
      rest = joined;
    }
    if (verb === "b") return;
    const body = JSON.parse(rest) as Record<string, unknown>;
    this.sent.push({ verb, body });
    if (verb === "q" && body.q === "hello") {
      this.#reply(
        `${ESC}_tsp;r;${JSON.stringify({ r: "hello", v: 1, term: "tern", ver: "0.8.3", kinds: KINDS, features: ["blobs", "settle", "adopt", "dock", "scroll", "styles", "flow"], apc: 65536, credits: 2, cols: 160, cell: { w: 8, h: 16 }, dark: true, reduceMotion: false, hour12: false })}${ESC}\\`,
      );
    } else if (verb === "f") this.#frame(body as { sf: string; s: number; ops: unknown[][] });
  }

  #reply(data: string): void {
    queueMicrotask(() => this.input.emit("data", data));
  }

  #add(node: WireNode): void {
    this.nodes.set(node.id, { id: node.id, k: node.k, p: { ...(node.p ?? {}) }, c: (node.c ?? []).map((c) => c.id) });
    for (const child of node.c ?? []) this.#add(child);
  }

  #remove(id: string): void {
    const node = this.nodes.get(id);
    if (!node) return;
    for (const c of node.c) this.#remove(c);
    this.nodes.delete(id);
    for (const other of this.nodes.values()) other.c = other.c.filter((c) => c !== id);
  }

  #frame(frame: { sf: string; s: number; ops: unknown[][] }): void {
    if (!this.nodes.has(frame.sf)) this.nodes.set(frame.sf, { id: frame.sf, k: "col", p: {}, c: [] });
    frame.ops.forEach((op, i) => {
      const [kind, id] = op as [string, string];
      const node = this.nodes.get(id);
      const fail = (msg: string) => this.errors.push(`frame ${frame.s} op ${i} (${kind}): ${msg}`);
      switch (kind) {
        case "add": {
          const [, , parent, before, wire] = op as [string, string, string, string | null, WireNode];
          const p = this.nodes.get(parent);
          if (!p) return fail(`unknown parent ${parent}`);
          this.#add(wire);
          const at = before === null ? p.c.length : p.c.indexOf(before);
          p.c.splice(at < 0 ? p.c.length : at, 0, wire.id);
          return;
        }
        case "set": {
          if (!node) return fail(`unknown id ${id}`);
          for (const [k, v] of Object.entries(op[2] as Record<string, unknown>)) {
            if (v === null) delete node.p[k];
            else node.p[k] = v;
          }
          return;
        }
        case "text": {
          if (!node) return fail(`unknown id ${id}`);
          node.p.text = op[2] === "append" ? `${(node.p.text as string | undefined) ?? ""}${op[3] as string}` : op[3];
          return;
        }
        case "move": {
          const [, , parent, before] = op as [string, string, string, string | null];
          const p = this.nodes.get(parent);
          if (!node || !p) return fail(`unknown id ${id}`);
          for (const other of this.nodes.values()) other.c = other.c.filter((c) => c !== id);
          const at = before === null ? p.c.length : p.c.indexOf(before);
          p.c.splice(at < 0 ? p.c.length : at, 0, id);
          return;
        }
        case "del":
          if (!node) return fail(`unknown id ${id}`);
          return this.#remove(id);
        case "focus":
          if (id !== null && !node) return fail(`unknown id ${id}`);
          this.focus = id;
          return;
        default:
          return;
      }
    });
    this.#reply(`${ESC}_tsp;e;${JSON.stringify({ ev: "ack", sf: frame.sf, s: frame.s })}${ESC}\\`);
  }

  /** Every prop text under node `id` (its `text`, spans, heads, labels), in document order. */
  text(id = "main"): string {
    const out: string[] = [];
    const visit = (n: DocNode | undefined) => {
      if (!n) return;
      const p = n.p;
      for (const key of ["head", "title", "target", "label", "text", "spans", "placeholder"]) {
        const v = p[key];
        if (typeof v === "string") out.push(v);
        else if (Array.isArray(v)) out.push(v.map((s) => (typeof s === "string" ? s : ((s as { t?: string }).t ?? ""))).join(""));
      }
      for (const c of n.c) visit(this.nodes.get(c));
    };
    visit(this.nodes.get(id));
    return out.join("\n");
  }

  /** The nodes of kind `k` under `id`. */
  find(k: string, id = "main"): DocNode[] {
    const out: DocNode[] = [];
    const visit = (n: DocNode | undefined) => {
      if (!n) return;
      if (n.k === k) out.push(n);
      for (const c of n.c) visit(this.nodes.get(c));
    };
    visit(this.nodes.get(id));
    return out;
  }

  /** Keys as the pty would carry them: text, "\r" for Enter, ESC sequences. */
  type(bytes: string): void {
    this.input.emit("data", bytes);
  }

  /** A user event Tern would send about node `id` (a click's action, a toggle). */
  event(ev: Record<string, unknown>): void {
    this.input.emit("data", `${ESC}_tsp;e;${JSON.stringify({ sf: "s1", ...ev })}${ESC}\\`);
  }
}
