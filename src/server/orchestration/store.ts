// The task records' one file in the state folder: read leniently, written whole through a
// checked temp-and-rename (a write that fails rejects, so a delegation whose record never
// landed cannot report success). A malformed row is dropped and counted, unlike Board's
// rooms.json, because here the child's session file is the source of truth: losing a row
// loses only the parent's pointer to work that still exists and can be resumed.
import { isObj, readJson, writeJsonChecked } from "../state-file.js";
import { parseStoredTask, pruneTasks, TASK_SCHEMA_VERSION, type StoredTask } from "./types.js";

export class TaskStore {
  constructor(private readonly file: string | null) {}

  /** Every well-formed record, pruned; `dropped` counts rows that could not be read. */
  async read(): Promise<{ tasks: StoredTask[]; dropped: number }> {
    const raw = await readJson(this.file);
    const rows = isObj(raw) && Array.isArray(raw.tasks) ? raw.tasks : [];
    const tasks: StoredTask[] = [];
    let dropped = 0;
    for (const row of rows) {
      const task = parseStoredTask(row);
      if (task) tasks.push(task);
      else dropped += 1;
    }
    return { tasks: pruneTasks(tasks, Date.now()), dropped };
  }

  /** Write the lot, pruned first; a failure rejects. */
  async write(tasks: StoredTask[]): Promise<void> {
    await writeJsonChecked(this.file, { schemaVersion: TASK_SCHEMA_VERSION, tasks: pruneTasks(tasks, Date.now()) });
  }
}
