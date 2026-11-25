// The pool monitor's reports (docs/specs/claude-session-pool-monitor.md, claude-session-pool-monitor::US-001): in a
// dispatcher session, what the mod keeps of each slot from one look to the next, which of what a look found
// (pool-look.ts) is due for a report, and the text of the report. The mod's module decides whether the report can be made
// at that look (claude-session-pool-plugin::REQ-005).
//
// Of a worker session the monitor uses what the look took of it: the listing's entry and the activity record
// (claude-session-pool-monitor::REQ-001). Of its own session it reads the transcript, for the cross-session messages it
// received (claude-session-pool-monitor::REQ-002), and of a message only who sent it and when it arrived. It reads the
// transcript by ranges, as a mod can read no more of a file at once ("What a mod can read"), and each look reads only what was
// added since an earlier look read it.
//
// Like the module, this file imports nothing but the plugin's files, and it passes Claude Code's interface for mods only
// to functions declared at its top. The type below states the part of that interface it uses, as measured on Claude Code
// 2.1.327.

import type { Sight, SlotSight } from "./pool-look.ts";
import { SESSION_ID_FORM } from "./pool-rule.ts";
import { PART } from "./subagent-watch.ts";

export type MonitorEngine = {
  fs: {
    read: (path: string, options: { as: "bytes"; offset: number; length: number }) => Promise<{ base64: string }>;
    stat: (path: string) => Promise<{ size: number }>;
  };
  /** `transcriptPath` is the transcript of the session's present conversation; empty where it keeps none on this machine. */
  session: { info: () => Promise<{ transcriptPath: string }> };
};

/** What the monitor keeps of one slot of the roster, from one look to the next. */
type Slot = {
  /**
   * The times a look since the mod was loaded found the slot live after a look that did not, whether the last look found it
   * live, and the time whose `gone` line was reported (US-001/AC-02).
   */
  livened: number;
  live: boolean;
  goneReported: number;
  /** The number of sessions of the `ambiguous` condition that was reported, while it lasts (US-001/AC-04). */
  ambiguousReported: number | undefined;
  /** The looks in a row that found the slot `waiting` for one thing under one session ID (US-001/AC-05). */
  waiting: { sessionId: string; what: string | undefined; looks: number; reported: boolean } | undefined;
  /** The looks in a row that found the slot unrecorded under one session ID (US-001/AC-08). */
  unrecorded: { sessionId: string | undefined; looks: number; reported: boolean } | undefined;
  /** The stall and the stop that were dealt with: reported, or for a stop, found told (US-001/AC-06, AC-07, AC-09). */
  stall: string | undefined;
  stop: string | undefined;
};

/** What the monitor keeps, in the memory of the session's process: a reload of the mod starts it anew. */
export type Monitor = {
  /** When Claude Code loaded the mod. */
  loadedAt: number;
  slots: Map<string, Slot>;
  /** The slots of the line of the first look that judges slots (US-001/AC-03): not made yet, due, or done with. */
  firstLook: "not made" | readonly string[] | "done";
  /** The looks in a row that judged no slot, the reason of the last, and whether their line was reported (REQ-003/AC-02). */
  blind: { looks: number; reason: "listing" | "roster"; reported: boolean };
  /** The slots that a pool tool's call is acting on, with the number of such calls running (the boundary "A pool tool"). */
  acting: Map<string, number>;
  /** For each slot, how many such calls on it have returned, so that a look made across a return leaves the slot out. */
  returned: Map<string, number>;
  /** What has been read of the session's present transcript, once a look has read it. */
  transcript: Transcript | undefined;
};

/**
 * What the monitor has read of one transcript: up to `offset`, the end of the last whole record it read, and whether the
 * bytes from there go on with a record longer than one range, which is passed over.
 */
type Transcript = { path: string; offset: number; passingOver: boolean; received: Received };

/** A line that is due, and what to keep once the report that holds it has been taken. */
export type Line = { text: string; reported: () => void };

/** Which calls were acting on the slots as a look began, to be compared with the moment it judges. */
export type Acting = { acting: ReadonlySet<string>; returned: ReadonlyMap<string, number> };

const MINUTE_MS = 60_000;
/** US-001/AC-06: a slot is stalled after 12 minutes without progress. */
const STALLED_MS = 12 * MINUTE_MS;
/** US-001/AC-07 and REQ-002/AC-01: a slot has stopped 5 minutes after its last turn ended, and a message counts from 5 minutes before. */
const STOPPED_MS = 5 * MINUTE_MS;
/** US-001/AC-05 and AC-08, REQ-003/AC-02: the looks in a row after which the condition is due. */
const WAITING_LOOKS = 2;
const UNRECORDED_LOOKS = 3;
const BLIND_LOOKS = 10;

const FIRST_LINE = "Report of the pool monitor, written by the cc-session-pool plugin. It is not a message from the user. What it found:";
const LAST_LINE = "Nothing was done to any slot. Each of these is reported once.";
/** The most bytes that one read of a file gives a mod (claude-session-pool-monitor, "What a mod can read"). */
const RANGE_BYTES = 4 * 1024 * 1024;
const NEWLINE = 0x0a;
/** The start of a received cross-session message's record, which names the sending session's process ID (REQ-002/AC-02). */
const RECEIVED_FROM = /^<cross-session-message from="uds:[^"]*\/([1-9][0-9]*)\.sock"/;

export const newMonitor = (): Monitor => ({
  loadedAt: Number.POSITIVE_INFINITY,
  slots: new Map(),
  firstLook: "not made",
  blind: { looks: 0, reason: "listing", reported: false },
  acting: new Map(),
  returned: new Map(),
  transcript: undefined,
});

const newSlot = (): Slot => ({ livened: 0, live: false, goneReported: 0, ambiguousReported: undefined, waiting: undefined, unrecorded: undefined, stall: undefined, stop: undefined });

/**
 * The slot `name`, which a pool tool's call acted on: it counts as not seen live, so that it is not reported `gone` before
 * it has been live again, and its runs of looks break, counting their looks anew, while a condition that was dealt with
 * stays dealt with for as long as it lasts (claude-session-pool-monitor::US-001/AC-09). The slot is changed in place, so
 * that a report of it that is waiting to be taken marks the slot that stays.
 */
function leaveOut(monitor: Monitor, name: string): void {
  const slot = monitor.slots.get(name);
  if (slot === undefined) {
    monitor.slots.set(name, newSlot());
    return;
  }
  slot.live = false;
  slot.goneReported = slot.livened;
  if (slot.waiting !== undefined) slot.waiting.looks = 0;
  if (slot.unrecorded !== undefined) slot.unrecorded.looks = 0;
}

/** A pool tool's call that acts on the slots `names` has started: looks leave them out until it has returned. */
export function actingStarts(monitor: Monitor, names: readonly string[]): void {
  for (const name of names) monitor.acting.set(name, (monitor.acting.get(name) ?? 0) + 1);
}

/** That call has returned: the slots count as not seen live, so a slot the call left `gone` is not reported. */
export function actingEnds(monitor: Monitor, names: readonly string[]): void {
  for (const name of names) {
    const left = (monitor.acting.get(name) ?? 1) - 1;
    if (left > 0) monitor.acting.set(name, left);
    else monitor.acting.delete(name);
    monitor.returned.set(name, (monitor.returned.get(name) ?? 0) + 1);
    leaveOut(monitor, name);
  }
}

/** The calls acting on the slots at this moment, as a look begins. */
export const actingNow = (monitor: Monitor): Acting => ({ acting: new Set(monitor.acting.keys()), returned: new Map(monitor.returned) });

/**
 * Judges what one look found (claude-session-pool-monitor::US-001), and answers the lines that are due at that look, the
 * first look's line first, then the slots' in the roster's order. `before` is what was acting as the look began: a slot
 * that a call was acting on at any moment of the look is left out, and its runs of looks start anew.
 */
export async function judgePool($: MonitorEngine, monitor: Monitor, sight: Sight, before: Acting): Promise<Line[]> {
  // A look at which the session is not taken as a dispatcher session is passed over.
  if (sight.seen === "nothing") return [];
  if (sight.seen === "no slot") return blindLine(monitor, sight.reason);
  monitor.blind = { looks: 0, reason: "listing", reported: false };
  const leftOut = (name: string) =>
    before.acting.has(name) || monitor.acting.has(name) || (before.returned.get(name) ?? 0) !== (monitor.returned.get(name) ?? 0);
  for (const name of monitor.slots.keys()) if (!sight.slots.some(({ slot }) => slot.name === name)) monitor.slots.delete(name);
  const lines: Line[] = [];
  const first = firstLookLine(monitor, sight.slots, leftOut);
  if (first !== undefined) lines.push(first);
  const transcript = lazily(() => receivedMessages($, monitor));
  for (const seen of sight.slots) {
    const { name } = seen.slot;
    if (leftOut(name)) {
      leaveOut(monitor, name);
      continue;
    }
    const slot = monitor.slots.get(name) ?? newSlot();
    monitor.slots.set(name, slot);
    lines.push(...(await slotLines(slot, seen, sight.at, monitor.loadedAt, transcript)));
  }
  return lines;
}

/** The text of the report of the lines that are due at one look (claude-session-pool-plugin::REQ-005/AC-04). */
export function monitorReport(lines: readonly Line[]): string {
  return [FIRST_LINE, ...lines.map(({ text }) => text), LAST_LINE].join("\n");
}

/** claude-session-pool-monitor::REQ-003/AC-02: the line once 10 looks in a row have judged no slot. */
function blindLine(monitor: Monitor, reason: "listing" | "roster"): Line[] {
  const { blind } = monitor;
  blind.looks += 1;
  blind.reason = reason;
  if (blind.looks < BLIND_LOOKS || blind.reported) return [];
  const why = reason === "listing" ? "the sessions on this Mac could not be listed" : "the roster could not be read";
  return [{ text: `- The monitor could not see the pool for ${blind.looks} minutes: ${why}.`, reported: () => (blind.reported = true) }];
}

/**
 * claude-session-pool-monitor::US-001/AC-03: the slots `gone` at the first look that judges slots after the mod is loaded,
 * in one line. While the line waits for a report it holds those of them that are still `gone`.
 */
function firstLookLine(monitor: Monitor, slots: readonly SlotSight[], leftOut: (name: string) => boolean): Line | undefined {
  const goneNow = slots.filter(({ slot, resolved }) => resolved.state === "gone" && !leftOut(slot.name));
  const names = goneNow.map(({ slot }) => slot.name);
  if (monitor.firstLook === "not made") monitor.firstLook = names;
  if (monitor.firstLook === "done") return undefined;
  const still = monitor.firstLook.filter((name) => names.includes(name));
  monitor.firstLook = still.length === 0 ? "done" : still;
  if (still.length === 0) return undefined;
  const restorable = goneNow.filter(({ slot, restorable }) => restorable && still.includes(slot.name)).map(({ slot }) => slot.name);
  const ordered = names.filter((name) => still.includes(name));
  const restoreSentence = restorable.length === 0 ? "" : ` The restore tool brings back the unfinished conversations of: ${restorable.join(", ")}.`;
  return {
    text: `- No live session in the pool directory answers to these slots of the roster: ${ordered.join(", ")}.${restoreSentence}`,
    reported: () => (monitor.firstLook = "done"),
  };
}

/** The lines of one slot that this look finds due (claude-session-pool-monitor::US-001/AC-02 to AC-09). */
async function slotLines(slot: Slot, seen: SlotSight, at: number, loadedAt: number, transcript: () => Promise<Received | undefined>): Promise<Line[]> {
  const { name } = seen.slot;
  const { resolved, record } = seen;
  if (resolved.state !== "live") {
    slot.live = false;
    slot.waiting = undefined;
    slot.unrecorded = undefined;
  }
  if (resolved.state === "gone") {
    slot.ambiguousReported = undefined;
    const { livened } = slot;
    if (livened === 0 || slot.goneReported === livened) return [];
    return [{ text: `- ${name}: gone. No live session in the pool directory answers to this name any more.`, reported: () => (slot.goneReported = Math.max(slot.goneReported, livened)) }];
  }
  if (resolved.state === "ambiguous") {
    const { count } = resolved;
    if (slot.ambiguousReported === count) return [];
    return [{ text: `- ${name}: ambiguous. ${count} live sessions in the pool directory answer to this name.`, reported: () => (slot.ambiguousReported = count) }];
  }
  if (!slot.live) slot.livened += 1;
  slot.live = true;
  slot.ambiguousReported = undefined;
  const { session } = resolved;
  // A session ID not in form names no session: no record counts for it, and a `waiting` run needs one session ID.
  const sessionId = session.sessionId !== undefined && SESSION_ID_FORM.test(session.sessionId) ? session.sessionId : undefined;
  const lines: Line[] = [];
  if (session.status === "waiting" && sessionId !== undefined) {
    const { waitingFor } = session;
    const run = slot.waiting?.sessionId === sessionId && slot.waiting.what === waitingFor ? slot.waiting : { sessionId, what: waitingFor, looks: 0, reported: false };
    run.looks += 1;
    slot.waiting = run;
    if (run.looks >= WAITING_LOOKS && !run.reported) {
      const what = waitingFor !== undefined && PART.test(waitingFor) ? `waiting for ${waitingFor}` : "waiting on a prompt";
      lines.push({ text: `- ${name}: ${what}.`, reported: () => (run.reported = true) });
    }
  } else slot.waiting = undefined;
  if (record === undefined) {
    const run = slot.unrecorded !== undefined && slot.unrecorded.sessionId === sessionId ? slot.unrecorded : { sessionId, looks: 0, reported: false };
    run.looks += 1;
    slot.unrecorded = run;
    if (run.looks >= UNRECORDED_LOOKS && !run.reported)
      lines.push({ text: `- ${name}: its session writes no activity record, so whether it makes progress is not known.`, reported: () => (run.reported = true) });
    return lines;
  }
  slot.unrecorded = undefined;
  if (session.status === "busy") {
    const progressAt = Date.parse(record.progressAt);
    const stall = `${record.sessionId} ${record.progressAt}`;
    if (at - progressAt >= STALLED_MS && slot.stall !== stall) {
      const { toolCall } = record;
      const running =
        toolCall === undefined
          ? "No tool call of its own is running."
          : `${PART.test(toolCall.tool) ? `Its tool call ${toolCall.tool}` : "A tool call of its own"} has been running for ${minutes(at - Date.parse(toolCall.startedAt))} minutes.`;
      lines.push({ text: `- ${name}: busy, and it made no progress for ${minutes(at - progressAt)} minutes. ${running}`, reported: () => (slot.stall = stall) });
    }
  }
  if (session.status === "idle" && record.lastTurnEndedAt !== undefined) {
    const endedAt = Date.parse(record.lastTurnEndedAt);
    const stop = `${record.sessionId} ${record.lastTurnEndedAt}`;
    if (endedAt > loadedAt && at - endedAt >= STOPPED_MS && slot.stop !== stop) {
      const told = toldBy(await transcript(), session.pid, endedAt);
      // A slot that has told the dispatcher session is not due, and is not judged again for this stop.
      if (told === "told") slot.stop = stop;
      else {
        const idle = `- ${name}: idle for ${minutes(at - endedAt)} minutes since its last turn ended`;
        const text =
          told === "not told" ? `${idle}, and it sent this session no message since 5 minutes before that.` : `${idle}. Whether it sent this session a message could not be read.`;
        lines.push({ text, reported: () => (slot.stop = stop) });
      }
    }
  }
  return lines;
}

const minutes = (ms: number): number => Math.floor(ms / MINUTE_MS);

/** The cross-session messages the dispatcher session's transcript records, and the time of its earliest record. */
type Received = { earliest: number | undefined; messages: { pid: number; at: number }[] };

/** claude-session-pool-monitor::REQ-002: whether the slot's session told the dispatcher session after its turn ended. */
function toldBy(received: Received | undefined, pid: number, endedAt: number): "told" | "not told" | "not read" {
  const since = endedAt - STOPPED_MS;
  if (received?.messages.some((message) => message.pid === pid && message.at >= since)) return "told";
  // REQ-002/AC-03: a transcript that cannot be read, or holds no record from before that time, does not say.
  if (received === undefined || received.earliest === undefined || received.earliest >= since) return "not read";
  return "not told";
}

/**
 * The dispatcher session's transcript, read for the messages it received: records of a queued cross-session message, by
 * the process ID in the address they came from and their time of arrival. Their text is not read.
 *
 * It is read by ranges of whole records, each range cut after its last newline: a record that a range's end cuts is read
 * whole by the next range, and a last record that has no newline yet, by a later look. A look goes on from where the
 * earlier look of this load of the mod left the transcript, and starts it anew when the session's transcript is another
 * one, as after a `/clear`, or has become shorter than what was read of it. A record longer than one range is passed over
 * (claude-session-pool-monitor, "A record of the dispatcher session's transcript is longer than the read limit").
 */
async function receivedMessages($: MonitorEngine, monitor: Monitor): Promise<Received | undefined> {
  try {
    const { transcriptPath: path } = await $.session.info();
    if (path === "") return undefined;
    const { size } = await $.fs.stat(path);
    let read = monitor.transcript;
    if (read === undefined || read.path !== path || size < read.offset)
      read = monitor.transcript = { path, offset: 0, passingOver: false, received: { earliest: undefined, messages: [] } };
    while (read.offset < size) {
      const from = read.offset;
      const asked = Math.min(RANGE_BYTES, size - from);
      const bytes = bytesOf((await $.fs.read(path, { as: "bytes", offset: from, length: asked })).base64);
      // Fewer bytes than asked: the file has become shorter since it was measured, and a later look goes on from here.
      const shortened = bytes.length < asked;
      let start = 0;
      if (read.passingOver) {
        start = bytes.indexOf(NEWLINE) + 1;
        if (start === 0) {
          read.offset += bytes.length;
          if (shortened) break;
          continue;
        }
        read.passingOver = false;
      }
      const end = bytes.lastIndexOf(NEWLINE) + 1;
      if (end > start) takeRecords(read.received, new TextDecoder().decode(bytes.subarray(start, end)));
      read.offset = from + Math.max(start, end);
      if (end === 0 && bytes.length === RANGE_BYTES) {
        // A whole range from the start of a record holds no newline: the record is longer than one range.
        read.passingOver = true;
        read.offset = from + bytes.length;
      }
      if (shortened || from + asked >= size) break;
      // Else the next range starts at the record that this range's end cut.
    }
    return read.received;
  } catch {
    return undefined;
  }
}

/** The messages and the earliest time of the whole records in `text`, added to `received`. */
function takeRecords(received: Received, text: string): void {
  for (const line of text.split("\n")) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record !== "object" || record === null) continue;
    const { type, operation, timestamp, content } = record as Record<string, unknown>;
    const at = typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
    if (Number.isNaN(at)) continue;
    if (received.earliest === undefined || at < received.earliest) received.earliest = at;
    if (type !== "queue-operation" || operation !== "enqueue" || typeof content !== "string") continue;
    const from = RECEIVED_FROM.exec(content);
    if (from !== null) received.messages.push({ pid: Number(from[1]), at });
  }
}

/** The bytes that a read with `as: "bytes"` gives as base64. */
function bytesOf(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** `make` run once, when it is first asked for. */
function lazily<T>(make: () => Promise<T>): () => Promise<T> {
  let made: Promise<T> | undefined;
  return () => (made ??= make());
}
