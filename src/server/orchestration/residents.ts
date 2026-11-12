// Persistent purpose -> native-session identity and small continuity notes only.
// Native transcripts remain in their harness. Notes are bounded and redacted at
// write and read: an augmenting memory, never a transcript or credential store.
import { z } from "zod";
import { readJson, writeJsonChecked } from "../state-file.js";

export type ResidentNote = { key: string; text: string; updatedAt: number };
export type ResidentRecord = {
  name: string;
  profile: string | null;
  harnessId: string;
  workspaceId: string;
  workspacePath: string;
  ownerChatId: string;
  ownerSessionId: string | null;
  nativeId: string;
  notes: ResidentNote[];
};
export interface ResidentCaller { chatId: string; sessionId: string | null }
type StoredResident = ResidentRecord & { key: string; createdAt: number };

const schema = z.object({
  version: z.literal(1),
  residents: z.array(z.object({
    name: z.string().trim().min(1).max(80),
    key: z.string().min(1).max(512),
    profile: z.string().max(128).nullable(),
    harnessId: z.string().min(1).max(64),
    workspaceId: z.string().min(1).max(128),
    workspacePath: z.string().min(1).max(4096),
    ownerChatId: z.string().min(1).max(128),
    ownerSessionId: z.string().min(1).max(512).nullable(),
    nativeId: z.string().min(1).max(1024),
    createdAt: z.number().int().nonnegative(),
    notes: z.array(z.object({ key: z.string().trim().min(1).max(80), text: z.string().max(4000), updatedAt: z.number().int().max(9999999999999) })).max(24),
  })).max(24),
});

export function residentName(value: string): string {
  const name = value.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,79}$/.test(name)) throw new Error("A resident name uses lowercase letters, digits, underscore, or dash and starts with a letter");
  return name;
}
export function residentKey(caller: ResidentCaller, name: string): string {
  return `${caller.sessionId ?? `chat:${caller.chatId}`}:${name}`;
}
/** A defensive filter, not a credential detector or hiding place. */
export function redactNote(input: string): string {
  return input
    .replace(/(?:Bearer|Basic|token|api[_ -]?key|apikey|authorization|password|secret|session[_ -]?id)[\s:=]+[A-Za-z0-9_./+=:@%\-]{6,}/gi, "[redacted credential]")
    .replace(/(?:eyJ[a-zA-Z0-9_-]{10,}\.){2}[a-zA-Z0-9_-]{8,}/g, "[redacted token]")
    .replace(/[a-zA-Z0-9_\-]{24,}\.[a-zA-Z0-9_\-]{8,}\.[a-zA-Z0-9_\-]{20,}/g, "[redacted token]")
    .replace(/(?:sk|rk|ghp|AKIA|ASIA)[A-Za-z0-9]{8,}/g, "[redacted credential]");
}

export class ResidentStore {
  private records = new Map<string, StoredResident>();
  constructor(private readonly file: string | null) {}
  async ready(): Promise<void> {
    const value = await readJson(this.file);
    const decoded = schema.safeParse(value);
    if (!decoded.success) return;
    for (const resident of decoded.data.residents) {
      if (this.records.has(resident.key)) continue;
      this.records.set(resident.key, { ...resident, notes: resident.notes.map((note) => ({ ...note, text: redactNote(note.text) })) });
    }
  }
  forCaller(caller: ResidentCaller, name: string): ResidentRecord | undefined { return this.records.get(residentKey(caller, name)); }
  forOwner(caller: ResidentCaller): ResidentRecord[] { return [...this.records.values()].filter((r) => this.owned(r, caller)); }
  byName(caller: ResidentCaller, name: string): ResidentRecord | undefined { return this.records.get(residentKey(caller, name)); }
  owned(record: ResidentRecord, caller: ResidentCaller): boolean { return record.ownerChatId === caller.chatId || (record.ownerSessionId !== null && record.ownerSessionId === caller.sessionId); }
  owns(record: ResidentRecord, caller: ResidentCaller): boolean { return this.owned(record, caller); }

  private find(record: ResidentRecord) {
    const direct = this.records.get(residentKey({ chatId: record.ownerChatId, sessionId: record.ownerSessionId }, record.name));
    if (direct) return direct;
    return [...this.records.values()].find((r) => r.name === record.name && r.ownerChatId === record.ownerChatId && (record.ownerSessionId === null || record.ownerSessionId === r.ownerSessionId));
  }

  async create(record: ResidentRecord): Promise<void> {
    const key = residentKey({ chatId: record.ownerChatId, sessionId: record.ownerSessionId }, record.name);
    if (this.records.has(key)) throw new Error(`Resident ${record.name} already belongs here`);
    const save = { ...record, key, createdAt: Date.now() };
    this.records.set(key, save);
    Object.assign(record, save);
    await this.save().catch((error) => { this.records.delete(key); throw error; });
  }


  async write(record: ResidentRecord, key: string, text: string): Promise<void> {
    const existing = this.find(record);
    if (!existing) throw new Error("Resident is not registered");
    const before = existing.notes.map((n) => ({ ...n }));
    existing.notes = [...before.filter((n) => n.key !== key), { key, text: redactNote(text).slice(0, 4000), updatedAt: Date.now() }].slice(-24);
    Object.assign(record, existing);
    await this.save().catch((error) => { existing.notes = before; Object.assign(record, existing); throw error; });
  }
  async forget(record: ResidentRecord, key: string): Promise<boolean> {
    const existing = this.find(record);
    if (!existing) return false;
    const before = existing.notes;
    const notes = before.filter((n) => n.key !== key);
    if (notes.length === before.length) return false;
    existing.notes = notes;
    Object.assign(record, existing);
    await this.save().catch((error) => { existing.notes = before; Object.assign(record, existing); throw error; });
    return true;
  }
  async saveIdentity(): Promise<void> { await this.save(); }

  private save(): Promise<void> {
    const residents = [...this.records.values()].slice(-24).map((resident) => ({ ...resident, notes: resident.notes.map((n) => ({ ...n, text: redactNote(n.text) })) }));
    return writeJsonChecked(this.file, { version: 1, residents });
  }
}
