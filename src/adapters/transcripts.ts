import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TranscriptMark, Transcripts } from "../ports.ts";

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
    if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return undefined;
    try {
      for (const entry of readdirSync(this.root, { withFileTypes: true })) {
        const path = join(this.root, entry.name, `${sessionId}.jsonl`);
        if (entry.isDirectory() && existsSync(path)) return { path, offset: statSync(path).size };
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  compactedSince(mark: TranscriptMark): boolean {
    let appended: string;
    try {
      const file = openSync(mark.path, "r");
      try {
        const length = fstatSync(file).size - mark.offset;
        if (length <= 0) return false;
        const buffer = Buffer.alloc(length);
        readSync(file, buffer, 0, length, mark.offset);
        appended = buffer.toString("utf8");
      } finally {
        closeSync(file);
      }
    } catch {
      return false;
    }
    return appended.split("\n").some(isCompactionRecord);
  }
}

/** Whether a transcript line records a finished compaction. A line that is still being written does not parse. */
function isCompactionRecord(line: string): boolean {
  if (!line.includes("compact_boundary")) return false;
  try {
    const record = JSON.parse(line) as { type?: unknown; subtype?: unknown };
    return record.type === "system" && record.subtype === "compact_boundary";
  } catch {
    return false;
  }
}
