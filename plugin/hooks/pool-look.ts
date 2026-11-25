// The pool monitor's look record (docs/specs/claude-session-pool-monitor.md, claude-session-pool-monitor::REQ-004): in a
// dispatcher session, what a look takes of every slot of the roster, and the file it writes,
// `~/.claude-session-pool/pool-states/<key>.json`, at every look and when a pool tool that names a slot, or `restore`, has
// returned.
//
// A slot's state comes from `resolveSlot` in pool-rule.ts, the function the server's `status` takes it from. Of a worker
// session the mod reads its activity record alone (claude-session-pool-monitor::REQ-001/AC-01). A look also answers what it
// found of each slot, its sight, which the pool monitor judges for its reports (pool-monitor.ts): the record and the reports
// rest on one listing.
//
// Like the module, this file imports nothing but the plugin's files, and it passes Claude Code's interface for mods only
// to functions declared at its top. The type below states the part of that interface it uses, as Claude Code 2.1.327's
// type definitions for mods state it and as measured on 2.1.327: `$.process.run` runs a command by its argument vector,
// with no shell, and resolves with its exit code and output; `$.fs.stat` with `resolve` gives where a path lands. `$.fs`
// has no rename, so the record is not replaced atomically; a reader treats a record it cannot read whole as absent.

import { isRecordOf, type ActivityRecord } from "./activity.ts";
import {
  LOOK_STATES,
  SESSION_ID_FORM,
  SLOT_NAME,
  isRosterSlot,
  judgeRestore,
  parseLookRecord,
  parseSessionListing,
  poolKey,
  resolveSlot,
  type LookEntry,
  type Resolved,
  type RosterSlot,
  type SessionEntry,
} from "./pool-rule.ts";

export type PoolEngine = {
  env: { get: (name: string) => Promise<string | undefined> };
  fs: {
    read: (path: string) => Promise<string>;
    write: (path: string, text: string) => Promise<unknown>;
    exists: (path: string) => Promise<boolean>;
    /** Rejects when the path is missing; with `resolve`, `realPath` is where it lands. */
    stat: (path: string, options?: { resolve?: boolean }) => Promise<{ realPath?: string }>;
  };
  process: { run: (argv: readonly string[]) => Promise<{ exitCode: number; stdout: string }> };
  /** `root` is the session's project root: the directory it was started in. */
  session: { id: () => Promise<string>; root: () => Promise<string> };
  clock: { now: () => Promise<number> };
};

/**
 * What the mod keeps for the look record: the writes it has queued, so that two never interleave, and the pool directory,
 * which it takes once, when Claude Code loads it, and keeps.
 */
export type PoolLook = { queue: Promise<unknown>; directory: Promise<string | undefined> | undefined };

export const newPoolLook = (): PoolLook => ({ queue: Promise.resolve(), directory: undefined });

/** One slot of the roster as a look found it. */
export type SlotSight = {
  slot: RosterSlot;
  resolved: Resolved;
  /** The activity record of a live slot's session, where one counts (claude-session-pool-monitor::REQ-001/AC-02). */
  record: ActivityRecord | undefined;
  /** Whether `restore` would bring back the slot's conversation, judged with the entries that this look wrote. */
  restorable: boolean;
};
/**
 * What a look found: nothing, in a session that is not a dispatcher session; that it judged no slot, and why
 * (claude-session-pool-monitor::REQ-003/AC-01); or each slot of the roster, in its order, at the time of the look.
 */
export type Sight = { seen: "nothing" } | { seen: "no slot"; reason: "listing" | "roster" } | { seen: "slots"; at: number; slots: SlotSight[] };
const NOTHING: Sight = { seen: "nothing" };

/**
 * Takes the pool directory, as Claude Code loads the mod: the session's project root with its symbolic links resolved.
 * The mod keeps it, as the server keeps its own, whatever the root is later.
 */
export function takePoolDirectory($: PoolEngine, pool: PoolLook): void {
  pool.directory = poolDirectoryOf($);
}

async function poolDirectoryOf($: PoolEngine): Promise<string | undefined> {
  try {
    return await realPathOf($, await $.session.root());
  } catch {
    return undefined;
  }
}

const POOL_TOOL = "mcp__plugin_cc-session-pool_pool__";
/** The pool tools whose return has the mod write the entries of the slots they name anew (claude-session-pool-monitor::REQ-004/AC-03). */
const POOL_TOOLS: readonly string[] = ["clear", "open", "recycle", "restore"].map((tool) => `${POOL_TOOL}${tool}`);
/** The pool tools that act on the slots they name, which looks leave out of the reports while the call runs (claude-session-pool-monitor, "A pool tool"). */
const ACTING_TOOLS: readonly string[] = ["init", "open", "recycle", "close", "clear", "compact", "restore"].map((tool) => `${POOL_TOOL}${tool}`);

/**
 * The slots that the call `call` acts on while it runs (claude-session-pool-monitor, "A pool tool of the dispatcher session
 * is acting on the slot"): those it names, under `names` for `init` and `restore`, under `name` for the others. A `restore`
 * without names names none.
 */
export function slotsActedOn(call: { tool: string; name?: unknown; names?: unknown }): readonly string[] {
  if (!ACTING_TOOLS.includes(call.tool)) return [];
  if (call.tool === `${POOL_TOOL}init` || call.tool === `${POOL_TOOL}restore`)
    return Array.isArray(call.names) ? call.names.filter((name): name is string => typeof name === "string") : [];
  return typeof call.name === "string" ? [call.name] : [];
}

/**
 * Which entries the return of the call `call` has the mod write anew (claude-session-pool-monitor::REQ-004/AC-03): those
 * of the slots it names, every one for a `restore` without names, or none (undefined). The call's arguments are fields
 * beside `tool`, as measured on Claude Code 2.1.327.
 */
export function entriesWrittenAfter(call: { tool: string; name?: unknown; names?: unknown }): readonly string[] | "every slot" | undefined {
  if (!POOL_TOOLS.includes(call.tool)) return undefined;
  if (call.tool === `${POOL_TOOL}restore`) {
    if (call.names === undefined) return "every slot";
    return Array.isArray(call.names) ? call.names.filter((name): name is string => typeof name === "string") : undefined;
  }
  return typeof call.name === "string" ? [call.name] : undefined;
}

const STATE_DIRECTORY = ".claude-session-pool";
/** The start-up command's mark, which the server reads too (docs/specs/claude-session-pool.md, "Which session is the dispatcher session"). */
const PROCESS_ID = /^[1-9][0-9]*$/;
/** claude-session-pool-monitor::REQ-001/AC-02: an activity record counts when written less than 3 minutes before the look. */
const RECORD_COUNTS_MS = 180_000;

/** A dispatcher session's pool: the user's home directory, the pool directory and the paths of its roster and look record. */
type Pool = { home: string; directory: string; rosterPath: string; recordPath: string };

/**
 * A look at the pool, once the writes queued before have finished: writes every slot's entry of the look record
 * (claude-session-pool-monitor::REQ-004/AC-01) and answers what the look found. Nothing is written, and nothing is found,
 * in a session that is not a dispatcher session.
 */
export function lookAtPool($: PoolEngine, pool: PoolLook): Promise<Sight> {
  const looked = pool.queue.then(() => look($, pool, undefined));
  pool.queue = looked;
  return looked;
}

/**
 * Writes the entries of the slots `only` anew, once the writes queued before have finished, after a pool tool that named
 * them has returned (claude-session-pool-monitor::REQ-004/AC-03); without `only`, the whole record, as a look does.
 */
export function recordPool($: PoolEngine, pool: PoolLook, only?: readonly string[]): Promise<unknown> {
  pool.queue = pool.queue.then(() => look($, pool, only));
  return pool.queue;
}

async function look($: PoolEngine, poolLook: PoolLook, only: readonly string[] | undefined): Promise<Sight> {
  try {
    const pool = await dispatcherPool($, poolLook);
    if (pool === undefined) return NOTHING;
    const roster = await rosterSlots($, pool);
    // A roster that cannot be read judges no slot (claude-session-pool-monitor::REQ-003/AC-01).
    if (roster === undefined) return { seen: "no slot", reason: "roster" };
    const names = roster.map(({ name }) => name);
    const named = only?.filter((name, at) => names.includes(name) && only.indexOf(name) === at);
    if (named !== undefined && named.length === 0) return NOTHING;
    const standing = await standingEntries($, pool);
    let sessions: SessionEntry[] = [];
    let realPaths = new Map<string, string>();
    if (roster.length > 0) {
      const listed = await listedSessions($);
      // A listing that fails judges no slot (claude-session-pool-monitor::REQ-003/AC-01).
      if (listed === undefined) return { seen: "no slot", reason: "listing" };
      sessions = listed;
      realPaths = await realPathsOf($, sessions, names);
    }
    const canonical = (path: string) => realPaths.get(path) ?? path;
    const now = await $.clock.now();
    const found = new Map<string, { resolved: Resolved; record: ActivityRecord | undefined }>();
    for (const { name } of roster.filter(({ name }) => named === undefined || named.includes(name))) {
      const resolved = resolveSlot(sessions, name, pool.directory, canonical);
      found.set(name, { resolved, record: await countingRecord($, pool, resolved, now) });
    }
    const entryAfter = (name: string) => {
      const { resolved, record } = found.get(name)!;
      return entryOf(name, resolved, record, standing.find((entry) => entry.name === name), now);
    };
    let entries: LookEntry[] = [];
    if (named === undefined) {
      for (const name of names) {
        const entry = entryAfter(name);
        if (entry !== undefined) entries.push(entry);
      }
    } else {
      // claude-session-pool-monitor::REQ-004/AC-03: the other entries stay as they were, a name's that has left the
      // roster since the last look among them.
      entries = [...standing];
      for (const name of named) {
        const entry = entryAfter(name);
        const at = entries.findIndex((candidate) => candidate.name === name);
        if (entry !== undefined && at === -1) entries.push(entry);
        else if (entry !== undefined) entries[at] = entry;
      }
    }
    try {
      await $.fs.write(pool.recordPath, `${JSON.stringify({ version: 1, directory: pool.directory, slots: entries })}\n`);
    } catch {
      // Nothing is written; the next look writes the record again. What the look found stands.
    }
    if (named !== undefined) return NOTHING;
    const slots = roster.map((slot): SlotSight => {
      const { resolved, record } = found.get(slot.name)!;
      return { slot, resolved, record, restorable: judgeRestore(slot, sessions, pool.directory, canonical, entries).verdict === "restore" };
    });
    return { seen: "slots", at: now, slots };
  } catch {
    // Nothing is written, and nothing found; the next look looks again.
    return NOTHING;
  }
}

/**
 * The pool, when the session is a dispatcher session ("Which session the monitor runs in"): the start-up command's mark
 * names the process ID that the hook record of the session's present session ID names. The pool directory is the one the
 * mod took when it was loaded, and the key is that of the server's roster file.
 */
async function dispatcherPool($: PoolEngine, poolLook: PoolLook): Promise<Pool | undefined> {
  const mark = await $.env.get("CLAUDE_SESSION_POOL_DISPATCHER_PID");
  const home = await $.env.get("HOME");
  if (mark === undefined || !PROCESS_ID.test(mark) || home === undefined || home === "") return undefined;
  let hookRecord: unknown;
  try {
    hookRecord = JSON.parse(await $.fs.read(`${home}/${STATE_DIRECTORY}/hooks/${mark}.json`));
  } catch {
    // No hook record: the plugin's hooks do not run in the session.
    return undefined;
  }
  if (typeof hookRecord !== "object" || hookRecord === null) return undefined;
  const { version, pid, sessionId } = hookRecord as Record<string, unknown>;
  if (version !== 1 || pid !== Number(mark) || sessionId !== (await $.session.id())) return undefined;
  poolLook.directory ??= poolDirectoryOf($);
  const directory = await poolLook.directory;
  if (directory === undefined) return undefined;
  const key = poolKey(directory);
  return { home, directory, rosterPath: `${home}/${STATE_DIRECTORY}/pools/${key}.json`, recordPath: `${home}/${STATE_DIRECTORY}/pool-states/${key}.json` };
}

/** A path with its symbolic links resolved, or the path itself where it cannot be resolved, as the server has it. */
async function realPathOf($: PoolEngine, path: string): Promise<string> {
  try {
    return (await $.fs.stat(path, { resolve: true })).realPath ?? path;
  } catch {
    return path;
  }
}

/**
 * The roster's slots, in its order; none for a missing file. Undefined for a roster that cannot be read
 * (docs/specs/claude-session-pool.md, "The roster file cannot be parsed"), and for one with a name that is not a slot
 * name (claude-session-pool-monitor, "A slot's name in the roster does not match").
 */
async function rosterSlots($: PoolEngine, pool: Pool): Promise<RosterSlot[] | undefined> {
  try {
    if (!(await $.fs.exists(pool.rosterPath))) return [];
    const data: unknown = JSON.parse(await $.fs.read(pool.rosterPath));
    if (typeof data !== "object" || data === null) return undefined;
    const { version, directory, slots } = data as Record<string, unknown>;
    if (version !== 1 || directory !== pool.directory || !Array.isArray(slots) || !slots.every(isRosterSlot)) return undefined;
    return slots.every(({ name }) => SLOT_NAME.test(name)) ? slots : undefined;
  } catch {
    return undefined;
  }
}

/** The entries of the standing look record; none where there is none, or one that cannot be read or is not in form. */
async function standingEntries($: PoolEngine, pool: Pool): Promise<LookEntry[]> {
  try {
    return parseLookRecord(await $.fs.read(pool.recordPath), pool.directory) ?? [];
  } catch {
    return [];
  }
}

/** The session listing; undefined where the command fails or does not print a list of sessions. */
async function listedSessions($: PoolEngine): Promise<SessionEntry[] | undefined> {
  try {
    const { exitCode, stdout } = await $.process.run(["claude", "agents", "--json"]);
    return exitCode === 0 ? parseSessionListing(stdout) : undefined;
  } catch {
    return undefined;
  }
}

/** The real paths of the directories of the listed sessions that could be a slot's session, by the path listed. */
async function realPathsOf($: PoolEngine, sessions: readonly SessionEntry[], roster: readonly string[]): Promise<Map<string, string>> {
  const realPaths = new Map<string, string>();
  for (const { kind, name, cwd } of sessions)
    if (kind === "interactive" && name !== undefined && roster.includes(name) && !realPaths.has(cwd)) realPaths.set(cwd, await realPathOf($, cwd));
  return realPaths;
}

/**
 * The slot's entry after this look: for a live slot, what the look found; for one that is not live, or whose listing
 * entry has no session ID in form or a state the record does not hold, the entry as it was.
 */
function entryOf(name: string, resolved: Resolved, record: ActivityRecord | undefined, previous: LookEntry | undefined, now: number): LookEntry | undefined {
  if (resolved.state !== "live") return previous;
  const { sessionId, status } = resolved.session;
  if (sessionId === undefined || !SESSION_ID_FORM.test(sessionId) || status === undefined || !LOOK_STATES.includes(status)) return previous;
  // claude-session-pool-monitor::REQ-004/AC-02: once an entry says so, it goes on saying so under that session ID.
  const worked = (previous?.sessionId === sessionId && previous.worked) || record?.worked === true;
  return { name, sessionId, state: status as LookEntry["state"], seenAt: new Date(now).toISOString(), worked };
}

/**
 * The activity record of a live slot's session, where one counts (claude-session-pool-monitor::REQ-001/AC-02): it names
 * the session ID the listing gives and was written less than 3 minutes before the look. None counts for a session ID not
 * in form, whose record the mod does not look for.
 */
async function countingRecord($: PoolEngine, pool: Pool, resolved: Resolved, now: number): Promise<ActivityRecord | undefined> {
  if (resolved.state !== "live") return undefined;
  const { sessionId } = resolved.session;
  if (sessionId === undefined || !SESSION_ID_FORM.test(sessionId)) return undefined;
  try {
    const record: unknown = JSON.parse(await $.fs.read(`${pool.home}/${STATE_DIRECTORY}/activity/${sessionId}.json`));
    return isRecordOf(record, sessionId) && now - Date.parse(record.writtenAt) < RECORD_COUNTS_MS ? record : undefined;
  } catch {
    return undefined;
  }
}
