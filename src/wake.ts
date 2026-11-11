import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readJsonObject, writeJsonFile } from "./json-file.ts";

/** The name the plugin is declared under. */
export const PLUGIN_NAME = "cc-session-pool";

/** What the plugin's hook hands the model when it wakes a session after a compaction that `compact_self` asked for. */
export const WAKE_SENTENCE =
  "The compaction this session requested with compact_self has finished. This is not an error. Continue the work that was in progress.";

const VERSION = 1;
/** A session ID becomes a file name, so one that could name a file elsewhere is not taken for one. */
const SESSION_ID = /^[A-Za-z0-9-]+$/;
const HOOK_RECORD = /^(\d+)\.json$/;

/**
 * What the plugin's hooks and `compact_self` leave for each other under one directory. A hook record, one per session
 * process, shows that the plugin's hooks run in that session. A wake request, one per conversation, tells the hook
 * to wake the session when the conversation's next compaction has finished.
 *
 * A file of either kind that does not hold what this version writes is treated as absent.
 */
export class WakeState {
  private readonly root: string;

  constructor(root: string) {
    this.root = root;
  }

  /** The session ID that the hook record of the session process `pid` names, if that process has a hook record. */
  hookRecord(pid: number): string | undefined {
    const record = readJsonObject(this.hookRecordPath(pid));
    return record?.version === VERSION && record.pid === pid && typeof record.sessionId === "string" ? record.sessionId : undefined;
  }

  writeHookRecord(pid: number, sessionId: string): void {
    writeJsonFile(this.hookRecordPath(pid), { version: VERSION, pid, sessionId });
  }

  /** Deletes the hook record of every process that no longer runs. */
  dropHookRecordsOfEndedProcesses(isAlive: (pid: number) => boolean): void {
    let names: string[];
    try {
      names = readdirSync(join(this.root, "hooks"));
    } catch {
      return;
    }
    for (const name of names) {
      const pid = HOOK_RECORD.exec(name)?.[1];
      if (pid !== undefined && !isAlive(Number(pid))) rmSync(join(this.root, "hooks", name), { force: true });
    }
  }

  /** When the wake request of the conversation was left, in milliseconds since the epoch, if the conversation has one. */
  wakeRequestedAt(sessionId: string): number | undefined {
    const path = this.wakeRequestPath(sessionId);
    const record = path === undefined ? undefined : readJsonObject(path);
    if (record?.version !== VERSION || record.sessionId !== sessionId || typeof record.requestedAt !== "string") return undefined;
    const requestedAt = Date.parse(record.requestedAt);
    return Number.isNaN(requestedAt) ? undefined : requestedAt;
  }

  /** Leaves a wake request for the conversation, in place of whatever file stood there. `at` is in milliseconds since the epoch. */
  leaveWakeRequest(sessionId: string, at: number): void {
    const path = this.wakeRequestPath(sessionId);
    if (path === undefined) throw new Error(`${JSON.stringify(sessionId)} is not a session ID, so no wake request was left for it.`);
    writeJsonFile(path, { version: VERSION, sessionId, requestedAt: new Date(at).toISOString() });
  }

  /** Removes the conversation's wake request, if it has one. */
  withdrawWakeRequest(sessionId: string): void {
    const path = this.wakeRequestPath(sessionId);
    if (path !== undefined) rmSync(path, { force: true });
  }

  private hookRecordPath(pid: number): string {
    return join(this.root, "hooks", `${pid}.json`);
  }

  private wakeRequestPath(sessionId: string): string | undefined {
    return SESSION_ID.test(sessionId) ? join(this.root, "wake-requests", `${sessionId}.json`) : undefined;
  }
}
