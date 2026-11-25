/**
 * A dispatcher session with the plugin's mod loaded in the fake engine (mod-engine.ts), and worker sessions whose own mod
 * writes their activity records: the rosters, hook records, activity records and look records are real files in the
 * dispatcher's temporary home directory, and the session listing is text shaped like what `claude agents --json` printed on
 * Claude Code 2.1.327.
 */
import { copyFileSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ClaudeCli } from "../../src/adapters/claude-cli.ts";
import { Pool } from "../../src/pool.ts";
import { RosterStore, type Slot } from "../../src/roster.ts";
import { FakeMac } from "./fake-mac.ts";
import { LOOK_MS, modSetup } from "./mod-engine.ts";
import { SESSION } from "./sessions.ts";

export type Mod = Awaited<ReturnType<typeof modSetup>>;

/** The process ID of the dispatcher session, which the start-up command's mark and its hook record name. */
export const DISPATCHER_PID = 4242;

/**
 * A dispatcher session with the mod loaded, its pool directory reached through a symbolic link, and a roster of `names`.
 * The mod is loaded once the session's directory is set, as Claude Code loads it in a session started there.
 */
export async function dispatcher(names: string[]) {
  const mod = await modSetup({ told: false });
  const real = join(mod.home, "pools-real");
  mkdirSync(real);
  symlinkSync(real, join(mod.home, "pool-link"));
  mod.root.path = join(mod.home, "pool-link");
  mod.variables.dispatcherPid = String(DISPATCHER_PID);
  mod.wake.writeHookRecord(DISPATCHER_PID, SESSION);
  const stateDirectory = join(mod.home, ".claude-session-pool");
  // The server's own roster store, so that the key and the directory are the server's.
  const roster = new RosterStore(stateDirectory, real);
  roster.write(names.map((name): Slot => ({ name, origin: "adopted" })));
  await mod.start();
  /** Entries of the listing for the pool directory, shaped as Claude Code 2.1.327 prints them. */
  const entry = (pid: number, name: string, sessionId: string, status: string, extra: Record<string, unknown> = {}) => ({
    pid,
    cwd: real,
    kind: "interactive",
    startedAt: 1794367631161,
    sessionId,
    name,
    status,
    ...extra,
  });
  const lookRecordPath = join(stateDirectory, "pool-states", roster.path.replace(/^.*\/pools\//, ""));
  /** The look record's text, at the path of the roster's key; it throws where there is no file. */
  const lookRecordText = (): string => readFileSync(lookRecordPath, "utf8");
  const lookRecord = (): unknown => JSON.parse(lookRecordText());
  /** The server's status of the pool, run in the dispatcher session's pool directory with the listing the mod is given. */
  const status = async (): Promise<string> => {
    const mac = new FakeMac();
    try {
      const pool = new Pool({
        directory: join(mod.home, "pool-link"),
        dispatcherPid: DISPATCHER_PID,
        rosterRoot: stateDirectory,
        sessions: new ClaudeCli(() => Promise.resolve(mod.listing.text)),
        terminal: mac.terminal,
        processes: mac.processes,
        transcripts: { mark: () => undefined, compactedSince: () => false, queuedSince: () => [] },
        clock: mac.clock,
        wake: mod.wake,
      });
      return (await pool.status()).text;
    } finally {
      mac.stop();
    }
  };
  const workers: Worker[] = [];
  /**
   * A worker session with the mod, not loaded yet, whose activity record the dispatcher's mod finds as that of `sessionId`;
   * `named` is the session ID the record names, the worker's own.
   */
  const worker = async (sessionId: string, named = sessionId) => {
    const made = await workerSession(mod, sessionId, named);
    workers.push(made);
    return made;
  };
  /** `count` minutes pass, a look each: before each look, the worker sessions that still write their records write them. */
  const looks = async (count = 1) => {
    for (let made = 0; made < count; made += 1) {
      mod.time.now += LOOK_MS;
      for (const each of workers) if (each.writing) await each.writes();
      await mod.look();
    }
  };
  /** The dispatcher session's transcript, written with `records`, one line each: a string as it is, anything else as JSON. */
  const transcript = (records: unknown[]) => {
    const path = join(mod.home, ".claude", "projects", "-somewhere", `${SESSION}.jsonl`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, records.map((record) => `${typeof record === "string" ? record : JSON.stringify(record)}\n`).join(""));
  };
  return { mod, real, stateDirectory, roster, entry, lookRecord, lookRecordText, lookRecordPath, status, worker, looks, transcript };
}

type Worker = Awaited<ReturnType<typeof workerSession>>;

/**
 * A worker session with the mod under the session ID `named`. Each step takes the time it happens at as an offset from the
 * dispatcher's present time; `writes` has the worker's mod write its record then, and puts it where the dispatcher's mod
 * reads the record of `sessionId`. `writing` is whether the dispatcher's looks have it write before each one.
 */
export async function workerSession(dispatcherMod: Mod, sessionId: string, named = sessionId) {
  const worker = await modSetup({ told: false });
  worker.session.id = named;
  const at = (offsetMs: number) => (worker.time.now = dispatcherMod.time.now + offsetMs);
  const made = {
    writing: true,
    loads: async (offsetMs = 0) => (at(offsetMs), await worker.start()),
    turnStarts: async (offsetMs = 0) => (at(offsetMs), await worker.turnStarts()),
    turnEnds: async (offsetMs = 0) => (at(offsetMs), await worker.turnEnds()),
    /** A tool call of the worker's main conversation starts; `returns` lets it return. */
    startsCall: async (tool: string, offsetMs = 0) => {
      at(offsetMs);
      const call = await worker.startsCall(tool);
      return { returns: async (returnsAtMs = 0) => (at(returnsAtMs), await call.returns()) };
    },
    writes: async (offsetMs = 0) => {
      at(offsetMs);
      await worker.look();
      const directory = join(dispatcherMod.home, ".claude-session-pool", "activity");
      mkdirSync(directory, { recursive: true });
      copyFileSync(join(worker.home, ".claude-session-pool", "activity", `${named}.json`), join(directory, `${sessionId}.json`));
    },
  };
  return made;
}
