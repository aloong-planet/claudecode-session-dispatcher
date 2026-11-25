import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isRosterSlot, poolKey, type RosterSlot } from "../plugin/hooks/pool-rule.ts";
import { writeJsonFile } from "./json-file.ts";
import { Refusal } from "./validate.ts";

export type Slot = RosterSlot;

const VERSION = 1;

/** The persisted list of one pool's slots: one JSON file per pool directory. */
export class RosterStore {
  readonly path: string;
  private readonly directory: string;

  constructor(root: string, directory: string) {
    this.directory = directory;
    this.path = join(root, "pools", `${poolKey(directory)}.json`);
  }

  read(): Slot[] {
    let text: string;
    try {
      text = readFileSync(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw this.unusable(`it cannot be read (${(error as Error).message})`);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw this.unusable("it is not valid JSON");
    }
    if (typeof data !== "object" || data === null) throw this.unusable("it is not a JSON object");
    const { version, directory, slots } = data as Record<string, unknown>;
    if (version !== VERSION) throw this.unusable(`its version is ${JSON.stringify(version)}, and this server reads version ${VERSION}`);
    if (directory !== this.directory) throw this.unusable(`it belongs to the directory ${JSON.stringify(directory)}`);
    if (!Array.isArray(slots) || !slots.every(isRosterSlot)) throw this.unusable("its slots are not in the expected form");
    return slots.map(({ name, origin, pid, model, permissionMode, endedSessionId }) => {
      const slot: Slot = { name, origin };
      if (pid !== undefined) slot.pid = pid;
      if (model !== undefined) slot.model = model;
      if (permissionMode !== undefined) slot.permissionMode = permissionMode;
      if (endedSessionId !== undefined) slot.endedSessionId = endedSessionId;
      return slot;
    });
  }

  write(slots: Slot[]): void {
    writeJsonFile(this.path, { version: VERSION, directory: this.directory, slots });
  }

  private unusable(reason: string): Refusal {
    return new Refusal(`The roster file ${this.path} cannot be used: ${reason}. It was left unchanged.`);
  }
}
