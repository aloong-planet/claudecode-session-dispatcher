import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Refusal } from "./validate.ts";

export type Slot = {
  name: string;
  /** Whether the server opened a session for the slot or took over one the owner opened. */
  origin: "opened" | "adopted";
  /** For an opened slot: the process ID of the session the server opened, and with it of the window it opened. */
  pid?: number;
};

const VERSION = 1;

/** The persisted list of one pool's slots: one JSON file per pool directory. */
export class RosterStore {
  readonly path: string;
  private readonly directory: string;

  constructor(root: string, directory: string) {
    this.directory = directory;
    const key = createHash("sha256").update(directory).digest("hex").slice(0, 16);
    this.path = join(root, "pools", `${key}.json`);
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
    if (!Array.isArray(slots) || !slots.every(isSlot)) throw this.unusable("its slots are not in the expected form");
    return slots.map(({ name, origin, pid }) => (pid === undefined ? { name, origin } : { name, origin, pid }));
  }

  write(slots: Slot[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const temporary = `${this.path}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify({ version: VERSION, directory: this.directory, slots }, null, 2)}\n`);
    renameSync(temporary, this.path);
  }

  private unusable(reason: string): Refusal {
    return new Refusal(`The roster file ${this.path} cannot be used: ${reason}. It was left unchanged.`);
  }
}

function isSlot(value: unknown): value is Slot {
  if (typeof value !== "object" || value === null) return false;
  const { name, origin, pid } = value as Record<string, unknown>;
  return typeof name === "string" && (origin === "opened" || origin === "adopted") && (pid === undefined || typeof pid === "number");
}
