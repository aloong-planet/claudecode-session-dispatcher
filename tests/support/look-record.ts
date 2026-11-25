import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Writes the pool's look record by hand, in the form "Look records" documents, as the mod would have; a string is written as it is. */
export function writeLookRecord(rosterRoot: string, directory: string, record: unknown): void {
  const key = createHash("sha256").update(directory).digest("hex").slice(0, 16);
  mkdirSync(join(rosterRoot, "pool-states"), { recursive: true });
  writeFileSync(join(rosterRoot, "pool-states", `${key}.json`), typeof record === "string" ? record : JSON.stringify(record));
}
