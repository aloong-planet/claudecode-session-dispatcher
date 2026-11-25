import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type LookEntry, parseLookRecord, poolKey } from "../plugin/hooks/pool-rule.ts";

/**
 * The pool's look record (docs/specs/claude-session-pool.md, "Look records"), which the plugin's mod in the dispatcher
 * session writes and the server only reads: one file per pool, under the key of the pool's roster file.
 */
export class LookRecordStore {
  readonly path: string;
  private readonly directory: string;

  constructor(root: string, directory: string) {
    this.directory = directory;
    this.path = join(root, "pool-states", `${poolKey(directory)}.json`);
  }

  /** The entries, by slot name; none where there is no file, or one that cannot be read or is not in the documented form. */
  entries(): Map<string, LookEntry> {
    return new Map((this.read() ?? []).map((entry) => [entry.name, entry]));
  }

  /** The entries; undefined where there is no file, or one that cannot be read or is not in the documented form: the pool has no look record. */
  read(): LookEntry[] | undefined {
    try {
      return parseLookRecord(readFileSync(this.path, "utf8"), this.directory);
    } catch {
      return undefined;
    }
  }
}
