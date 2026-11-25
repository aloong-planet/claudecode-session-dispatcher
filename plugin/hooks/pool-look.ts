// The pool monitor's look record (docs/specs/claude-session-pool-monitor.md, claude-session-pool-monitor::REQ-004): in a
// dispatcher session, what a look takes of every slot of the roster, and the file it writes,
// `~/.claude-session-pool/pool-states/<key>.json`, at every look and when a pool tool that names a slot has returned.
//
// A slot's state comes from `resolveSlot` in pool-rule.ts, the function the server's `status` takes it from. Of a worker
// session the mod reads its activity record alone (claude-session-pool-monitor::REQ-001/AC-01), and of it only `worked`.
//
// Like the module, this file imports nothing but the plugin's files, and it passes Claude Code's interface for mods only
// to functions declared at its top. The type below states the part of that interface it uses, as Claude Code 2.1.327's
// type definitions for mods state it and as measured on 2.1.327: `$.process.run` runs a command by its argument vector,
// with no shell, and resolves with its exit code and output; `$.fs.stat` with `resolve` gives where a path lands. `$.fs`
// has no rename, so the record is not replaced atomically; a reader treats a record it cannot read whole as absent.

import { isRecordOf } from "./activity.ts";
import {
  LOOK_STATES,
  SESSION_ID_FORM,
  SLOT_NAME,
  isRosterSlot,
  parseLookRecord,
  parseSessionListing,
  poolKey,
  resolveSlot,
  type LookEntry,
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

/** What the mod keeps for the look record: the writes it has queued, so that two never interleave. */
export type PoolLook = { queue: Promise<void> };

export const newPoolLook = (): PoolLook => ({ queue: Promise.resolve() });

/** The pool tools whose return has the mod write the slot's entry anew (claude-session-pool-monitor::REQ-004/AC-03). */
export const POOL_TOOLS: readonly string[] = ["clear", "open", "recycle"].map((tool) => `mcp__plugin_cc-session-pool_pool__${tool}`);

const STATE_DIRECTORY = ".claude-session-pool";
/** The start-up command's mark, which the server reads too (docs/specs/claude-session-pool.md, "Which session is the dispatcher session"). */
const PROCESS_ID = /^[1-9][0-9]*$/;
/** claude-session-pool-monitor::REQ-001/AC-02: an activity record counts when written less than 3 minutes before the look. */
const RECORD_COUNTS_MS = 180_000;

/** A dispatcher session's pool: the user's home directory, the pool directory and the paths of its roster and look record. */
type Pool = { home: string; directory: string; rosterPath: string; recordPath: string };

/**
 * Writes the look record once the writes queued before have finished: at a look, every slot's entry
 * (claude-session-pool-monitor::REQ-004/AC-01); with `only`, that slot's entry alone, after a pool tool that named it has
 * returned (claude-session-pool-monitor::REQ-004/AC-03). Nothing is written in a session that is not a dispatcher session.
 */
export function recordPool($: PoolEngine, pool: PoolLook, only?: string): Promise<void> {
  pool.queue = pool.queue.then(() => writeLookRecord($, only));
  return pool.queue;
}

async function writeLookRecord($: PoolEngine, only: string | undefined): Promise<void> {
  try {
    const pool = await dispatcherPool($);
    if (pool === undefined) return;
    const roster = await rosterNames($, pool);
    // A roster that cannot be read judges no slot (claude-session-pool-monitor::REQ-003/AC-01).
    if (roster === undefined || (only !== undefined && !roster.includes(only))) return;
    const standing = await standingEntries($, pool);
    const entries: LookEntry[] = [];
    if (roster.length > 0) {
      const sessions = await listedSessions($);
      // A listing that fails judges no slot (claude-session-pool-monitor::REQ-003/AC-01).
      if (sessions === undefined) return;
      const realPaths = await realPathsOf($, sessions, roster);
      const now = await $.clock.now();
      for (const name of roster) {
        const previous = standing.find((entry) => entry.name === name);
        const entry = only === undefined || only === name ? await entryOf($, pool, sessions, realPaths, name, previous, now) : previous;
        if (entry !== undefined) entries.push(entry);
      }
    }
    await $.fs.write(pool.recordPath, `${JSON.stringify({ version: 1, directory: pool.directory, slots: entries })}\n`);
  } catch {
    // Nothing is written; the next look writes the record again.
  }
}

/**
 * The pool, when the session is a dispatcher session ("Which session the monitor runs in"): the start-up command's mark
 * names the process ID that the hook record of the session's present session ID names. The pool directory is the
 * session's project root with its symbolic links resolved, and the key is that of the server's roster file.
 */
async function dispatcherPool($: PoolEngine): Promise<Pool | undefined> {
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
  const root = await $.session.root();
  const directory = await realPathOf($, root);
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
 * The names of the roster's slots, in its order; none for a missing file. Undefined for a roster that cannot be read
 * (docs/specs/claude-session-pool.md, "The roster file cannot be parsed"), and for one with a name that is not a slot
 * name (claude-session-pool-monitor, "A slot's name in the roster does not match").
 */
async function rosterNames($: PoolEngine, pool: Pool): Promise<string[] | undefined> {
  try {
    if (!(await $.fs.exists(pool.rosterPath))) return [];
    const data: unknown = JSON.parse(await $.fs.read(pool.rosterPath));
    if (typeof data !== "object" || data === null) return undefined;
    const { version, directory, slots } = data as Record<string, unknown>;
    if (version !== 1 || directory !== pool.directory || !Array.isArray(slots) || !slots.every(isRosterSlot)) return undefined;
    const names = slots.map(({ name }) => name);
    return names.every((name) => SLOT_NAME.test(name)) ? names : undefined;
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
async function entryOf(
  $: PoolEngine,
  pool: Pool,
  sessions: readonly SessionEntry[],
  realPaths: Map<string, string>,
  name: string,
  previous: LookEntry | undefined,
  now: number,
): Promise<LookEntry | undefined> {
  const resolved = resolveSlot(sessions, name, pool.directory, (path) => realPaths.get(path) ?? path);
  if (resolved.state !== "live") return previous;
  const { sessionId, status } = resolved.session;
  if (sessionId === undefined || !SESSION_ID_FORM.test(sessionId) || status === undefined || !LOOK_STATES.includes(status)) return previous;
  // claude-session-pool-monitor::REQ-004/AC-02: once an entry says so, it goes on saying so under that session ID.
  const worked = (previous?.sessionId === sessionId && previous.worked) || (await recordSaysWorked($, pool, sessionId, now));
  return { name, sessionId, state: status as LookEntry["state"], seenAt: new Date(now).toISOString(), worked };
}

/** Whether the slot's activity record counts (claude-session-pool-monitor::REQ-001/AC-02) and says that a turn has started. */
async function recordSaysWorked($: PoolEngine, pool: Pool, sessionId: string, now: number): Promise<boolean> {
  try {
    const record: unknown = JSON.parse(await $.fs.read(`${pool.home}/${STATE_DIRECTORY}/activity/${sessionId}.json`));
    if (!isRecordOf(record, sessionId)) return false;
    const { writtenAt, worked } = record as { writtenAt: string; worked: boolean };
    return now - Date.parse(writtenAt) < RECORD_COUNTS_MS && worked;
  } catch {
    return false;
  }
}
