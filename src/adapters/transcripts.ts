import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptMark, Transcripts } from "../ports.ts";

/** Whether a session's transcript shows a name that was given to it; "unknown" when the transcript cannot be found or read. */
export type NameState = "named" | "unnamed" | "unknown";

/**
 * Reads session transcripts: `<root>/<project>/<sessionId>.jsonl`, one JSON object per line. Claude Code does not
 * document this file as a stable interface, so every failure to find or read it is reported as "not found".
 */
export class FileTranscripts implements Transcripts {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  mark(sessionId: string): TranscriptMark | undefined {
    try {
      const path = this.find(sessionId);
      return path === undefined ? undefined : { path, offset: statSync(path).size };
    } catch {
      return undefined;
    }
  }

  compactedSince(mark: TranscriptMark): boolean {
    return recordsSince(mark, "compact_boundary").some((record) => record.type === "system" && record.subtype === "compact_boundary");
  }

  queuedSince(mark: TranscriptMark): string[] {
    return recordsSince(mark, "queue-operation").flatMap((record) =>
      record.type === "queue-operation" && record.operation === "enqueue" && typeof record.content === "string" ? [record.content] : [],
    );
  }

  nameState(sessionId: string): NameState {
    let contents: Buffer;
    try {
      const path = this.find(sessionId);
      if (path === undefined) return "unknown";
      contents = readFileSync(path);
    } catch {
      return "unknown";
    }
    // The word is searched for in the bytes first: a dispatcher session's transcript runs to tens of megabytes.
    for (let found = contents.indexOf(NAME_RECORD); found !== -1; found = contents.indexOf(NAME_RECORD, found + 1)) {
      const start = contents.lastIndexOf("\n", found) + 1;
      const end = contents.indexOf("\n", found);
      const record = parse(contents.toString("utf8", start, end === -1 ? contents.length : end));
      if (record?.type === NAME_RECORD && typeof record.customTitle === "string" && record.customTitle !== "") return "named";
    }
    return "unnamed";
  }

  private find(sessionId: string): string | undefined {
    if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return undefined;
    for (const entry of readdirSync(this.root, { withFileTypes: true })) {
      const path = join(this.root, entry.name, `${sessionId}.jsonl`);
      if (entry.isDirectory() && existsSync(path)) return path;
    }
    return undefined;
  }
}

const NAME_RECORD = "custom-title";

type TranscriptRecord = Record<string, unknown>;

/** The records appended after `mark` whose line contains `word`. A line that is still being written does not parse and is left out. */
function recordsSince(mark: TranscriptMark, word: string): TranscriptRecord[] {
  let appended: string;
  try {
    const file = openSync(mark.path, "r");
    try {
      const length = fstatSync(file).size - mark.offset;
      if (length <= 0) return [];
      const buffer = Buffer.alloc(length);
      readSync(file, buffer, 0, length, mark.offset);
      appended = buffer.toString("utf8");
    } finally {
      closeSync(file);
    }
  } catch {
    return [];
  }
  return appended.split("\n").flatMap((line) => {
    const record = line.includes(word) ? parse(line) : undefined;
    return record ? [record] : [];
  });
}

function parse(line: string): TranscriptRecord | undefined {
  try {
    const record: unknown = JSON.parse(line);
    return typeof record === "object" && record !== null ? (record as TranscriptRecord) : undefined;
  } catch {
    return undefined;
  }
}
