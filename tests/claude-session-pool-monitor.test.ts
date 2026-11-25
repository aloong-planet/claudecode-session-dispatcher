/**
 * The pool monitor (docs/specs/claude-session-pool-monitor.md): what the plugin's mod in a dispatcher session takes at
 * every look and the look record it writes, through the mod's own `register`, handed a fake of Claude Code's engine.
 * Rosters, hook records, activity records and look records are real files in a temporary home directory; the session
 * listing is text shaped like what `claude agents --json` printed on Claude Code 2.1.327.
 *
 * Not covered here: that Claude Code gives a dispatcher session's mod the start-up command's variable, the listing and
 * the real path of the session's directory, and tells it of a pool tool's return. That needs a real dispatcher session;
 * it was checked by hand on Claude Code 2.1.327 (the delivery note of the change that added the look record).
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCli } from "../src/adapters/claude-cli.ts";
import { Pool } from "../src/pool.ts";
import { RosterStore, type Slot } from "../src/roster.ts";
import { FakeMac } from "./support/fake-mac.ts";
import { FROM_SERVER, LOOK_MS, modSetup } from "./support/mod-engine.ts";
import { OTHER_SESSION, SESSION } from "./support/sessions.ts";
import { cleanUpTemporaryDirectories } from "./support/temporary.ts";

afterEach(cleanUpTemporaryDirectories);

type Mod = Awaited<ReturnType<typeof modSetup>>;

const DISPATCHER_PID = 4242;
const W1 = "0b6f4c1e-3d2a-4f5b-9c8d-7e6f5a4b3c21";
const W2 = "1c7a5d2f-4e3b-4a6c-8d9e-8f7a6b5c4d32";
const W3 = "2d8b6e3a-5f4c-4b7d-9eaf-9a8b7c6d5e43";
const W5A = "3e9c7f4b-6a5d-4c8e-8fb0-ab9c8d7e6f54";
const W5B = "4fad8a5c-7b6e-4d9f-9a01-bcad9e8f7a65";
/** A pool tool, under the name the dispatcher session sees it by. */
const tool = (name: string) => `mcp__plugin_cc-session-pool_pool__${name}`;

/** A dispatcher session with the mod loaded, its pool directory reached through a symbolic link, and a roster of `names`. */
async function dispatcher(names: string[]) {
  const mod = await modSetup();
  const real = join(mod.home, "pools-real");
  mkdirSync(real);
  symlinkSync(real, join(mod.home, "pool-link"));
  mod.root.path = join(mod.home, "pool-link");
  mod.variables.dispatcherPid = String(DISPATCHER_PID);
  mod.wake.writeHookRecord(DISPATCHER_PID, SESSION);
  const stateDirectory = join(mod.home, ".claude-session-pool");
  // The server's own roster store, so that the key and the directory are the server's.
  new RosterStore(stateDirectory, join(mod.home, "pools-real")).write(names.map((name): Slot => ({ name, origin: "adopted" })));
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
  /** The look record's text, at the path of the roster's key; it throws where there is no file. */
  const lookRecordText = (): string => {
    const key = new RosterStore(stateDirectory, real).path.replace(/^.*\/pools\//, "");
    return readFileSync(join(stateDirectory, "pool-states", key), "utf8");
  };
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
  return { mod, real, stateDirectory, entry, lookRecord, lookRecordText, status };
}

/**
 * The activity record of the worker session `sessionId`, as the mod in that session writes it `writtenAgoMs` before the
 * dispatcher's present time, after a turn has started in it when `worked`; `named` is the session ID the record names.
 */
async function workerRecord(dispatcherMod: Mod, sessionId: string, { worked, writtenAgoMs = 0, named = sessionId }: { worked: boolean; writtenAgoMs?: number; named?: string }) {
  const worker = await modSetup({ told: false });
  worker.session.id = named;
  worker.time.now = dispatcherMod.time.now - writtenAgoMs;
  await worker.start();
  if (worked) await worker.turnStarts();
  await worker.look();
  const directory = join(dispatcherMod.home, ".claude-session-pool", "activity");
  mkdirSync(directory, { recursive: true });
  copyFileSync(join(worker.home, ".claude-session-pool", "activity", `${named}.json`), join(directory, `${sessionId}.json`));
}

describe("what a look takes", () => {
  it("records each live slot's state as status states it, and no entry for a gone or an ambiguous slot", async () => {
    const { mod, real, entry, lookRecord, status } = await dispatcher(["w1", "w2", "w3", "w4", "w5"]);
    mod.listing.text = JSON.stringify([
      entry(501, "w1", W1, "idle"),
      entry(502, "w2", W2, "busy"),
      entry(503, "w3", W3, "waiting", { waitingFor: "permission prompt" }),
      entry(505, "w5", W5A, "idle"),
      entry(506, "w5", W5B, "busy"),
      { id: "a3bbcb84", cwd: real, kind: "background", startedAt: 1792336355650, sessionId: "a3bbcb84-eb88-4385-b5d7-bff695f6913b", name: "w4", state: "done" },
    ]);

    await mod.look();

    const seenAt = new Date(mod.time.now).toISOString();
    expect(lookRecord()).toEqual({
      version: 1,
      directory: real,
      slots: [
        { name: "w1", sessionId: W1, state: "idle", seenAt, worked: false },
        { name: "w2", sessionId: W2, state: "busy", seenAt, worked: false },
        { name: "w3", sessionId: W3, state: "waiting", seenAt, worked: false },
      ],
    });
    expect(await status()).toBe(
      [
        `w1: idle, session ${W1}`,
        `w2: busy, session ${W2}`,
        `w3: waiting for permission prompt, session ${W3}`,
        "w4: gone",
        "w5: ambiguous, 2 sessions answer to this name",
      ].join("\n"),
    );
  });

  it("is what status states for a slot once its session has ended", async () => {
    const { mod, entry, status } = await dispatcher(["w1"]);
    mod.listing.text = JSON.stringify([entry(501, "w1", W1, "busy")]);
    await workerRecord(mod, W1, { worked: true });
    await mod.look();
    const seenAt = new Date(mod.time.now).toISOString();

    mod.listing.text = JSON.stringify([]);
    mod.time.now += LOOK_MS;
    await mod.look();

    expect(await status()).toBe(`w1: gone, last seen busy at ${seenAt}, session ${W1}, whose conversation had work in it`);
  });
});

describe("which session the monitor runs in", () => {
  it("looks at no pool in a session that the start-up command did not start", async () => {
    const { mod, stateDirectory } = await dispatcher(["w1"]);
    mod.variables.dispatcherPid = undefined;

    await mod.look(3);

    expect(mod.runs).toEqual([]);
    expect(mod.reads.filter((path) => path.startsWith(join(stateDirectory, "pools")))).toEqual([]);
    expect(mod.writes.filter((path) => path.includes("/pool-states/"))).toEqual([]);
  });

  it.each([
    ["the plugin's hooks do not run in it, so it has no hook record", (mod: Mod) => rmSync(join(mod.home, ".claude-session-pool", "hooks"), { recursive: true })],
    ["the hook record of its process names another session ID", (mod: Mod) => mod.wake.writeHookRecord(DISPATCHER_PID, OTHER_SESSION)],
    ["the start-up command's variable names another process than the hook record of its session ID", (mod: Mod) => (mod.variables.dispatcherPid = "4243")],
    ["the variable is not a process ID", (mod: Mod) => (mod.variables.dispatcherPid = "4242 ")],
  ])("writes no look record when %s", async (_, change) => {
    const { mod } = await dispatcher(["w1"]);
    mod.listing.text = JSON.stringify([]);
    change(mod);

    await mod.look();

    expect(mod.runs).toEqual([]);
    expect(mod.writes.filter((path) => path.includes("/pool-states/"))).toEqual([]);
  });

  it("writes the look record when the variable names the process that the hook record of its session ID names", async () => {
    const { mod, lookRecord, real } = await dispatcher(["w1"]);
    mod.listing.text = JSON.stringify([]);

    await mod.look();

    expect(mod.runs).toEqual([["claude", "agents", "--json"]]);
    expect(lookRecord()).toEqual({ version: 1, directory: real, slots: [] });
  });
});

describe("the activity records a look reads", () => {
  it("reads of a worker session nothing but the activity record of the session ID the listing gives", async () => {
    const { mod, entry, stateDirectory } = await dispatcher(["w1", "w2"]);
    mod.listing.text = JSON.stringify([entry(501, "w1", W1, "busy"), entry(502, "w2", W2, "idle")]);
    await workerRecord(mod, W1, { worked: true });
    await workerRecord(mod, W2, { worked: false });

    await mod.look(2);

    const own = [join(stateDirectory, "hooks"), join(stateDirectory, "pools"), join(stateDirectory, "pool-states"), join(stateDirectory, "activity", `${SESSION}.json`)];
    const others = mod.reads.filter((path) => !own.some((mine) => path.startsWith(mine)));
    const records = [W1, W2].map((id) => join(stateDirectory, "activity", `${id}.json`));
    expect(new Set(others)).toEqual(new Set(records));
  });

  it.each([
    ["counts when written 2 minutes and 59 seconds before the look", { writtenAgoMs: 179_000 }, true],
    ["does not count when written 3 minutes before the look", { writtenAgoMs: 180_000 }, false],
    ["does not count when it names another session ID than the listing gives", { named: OTHER_SESSION }, false],
  ])("an activity record that says a turn has started %s", async (_, written, worked) => {
    const { mod, entry, lookRecord } = await dispatcher(["w1"]);
    mod.listing.text = JSON.stringify([entry(501, "w1", W1, "busy")]);
    await workerRecord(mod, W1, { worked: true, ...written });

    await mod.look();

    expect(lookRecord()).toMatchObject({ slots: [{ name: "w1", sessionId: W1, worked }] });
  });
});

describe("a look that judges no slot", () => {
  const rosterPath = (stateDirectory: string, real: string) => new RosterStore(stateDirectory, real).path;
  it.each([
    ["the listing exits with an error", (mod: Mod) => (mod.listing.exitCode = 1)],
    ["the listing prints no JSON", (mod: Mod) => (mod.listing.text = "Error: not logged in")],
    ["the listing command cannot be started", (mod: Mod) => (mod.listing.fails = true)],
    ["the roster is not valid JSON", (_: Mod, path: string) => writeFileSync(path, "{")],
    [
      "a name in the roster is not a slot name",
      (_: Mod, path: string, real: string) => writeFileSync(path, JSON.stringify({ version: 1, directory: real, slots: [{ name: "w1", origin: "adopted" }, { name: "-w2", origin: "adopted" }] })),
    ],
  ])("leaves the look record as it was when %s", async (_, change) => {
    const { mod, entry, stateDirectory, real, lookRecordText } = await dispatcher(["w1"]);
    mod.listing.text = JSON.stringify([entry(501, "w1", W1, "idle")]);
    await mod.look();
    const before = lookRecordText();
    mod.listing.text = JSON.stringify([entry(501, "w1", W1, "busy")]);
    mod.time.now += LOOK_MS;
    change(mod, rosterPath(stateDirectory, real), real);

    await mod.look();

    expect(lookRecordText()).toBe(before);
  });
});

describe("the entries of the look record", () => {
  it("keeps a slot's entry while it is gone or ambiguous, and removes it once the name has left the roster", async () => {
    const { mod, entry, lookRecord, stateDirectory, real } = await dispatcher(["w1", "w2"]);
    const w2 = entry(502, "w2", W2, "idle");
    mod.listing.text = JSON.stringify([entry(501, "w1", W1, "busy"), w2]);
    await mod.look();
    const seen = { name: "w1", sessionId: W1, state: "busy", seenAt: new Date(mod.time.now).toISOString(), worked: false };
    const later = () => ({ name: "w2", sessionId: W2, state: "idle", seenAt: new Date(mod.time.now).toISOString(), worked: false });

    mod.time.now += LOOK_MS;
    mod.listing.text = JSON.stringify([w2]);
    await mod.look();
    expect(lookRecord()).toMatchObject({ slots: [seen, later()] });

    mod.time.now += LOOK_MS;
    mod.listing.text = JSON.stringify([entry(503, "w1", W3, "idle"), entry(504, "w1", W5A, "idle"), w2]);
    await mod.look();
    expect(lookRecord()).toMatchObject({ slots: [seen, later()] });

    mod.time.now += LOOK_MS;
    new RosterStore(stateDirectory, real).write([{ name: "w2", origin: "adopted" }]);
    await mod.look();
    expect(lookRecord()).toEqual({ version: 1, directory: real, slots: [later()] });
  });

  it("writes a record with no slots for a pool with no roster, without listing the sessions", async () => {
    const { mod, lookRecord, stateDirectory, real } = await dispatcher([]);
    rmSync(new RosterStore(stateDirectory, real).path);

    await mod.look();

    expect(lookRecord()).toEqual({ version: 1, directory: real, slots: [] });
    expect(mod.runs).toEqual([]);
  });

  it("goes on saying that the conversation had work in it under that session ID, and says none for a new one", async () => {
    const { mod, entry, lookRecord, stateDirectory } = await dispatcher(["w1"]);
    mod.listing.text = JSON.stringify([entry(501, "w1", W1, "busy")]);
    await workerRecord(mod, W1, { worked: true });
    await mod.look();
    expect(lookRecord()).toMatchObject({ slots: [{ sessionId: W1, worked: true }] });

    mod.time.now += 10 * LOOK_MS;
    await mod.look();
    rmSync(join(stateDirectory, "activity", `${W1}.json`));
    mod.time.now += LOOK_MS;
    await mod.look();
    expect(lookRecord()).toMatchObject({ slots: [{ sessionId: W1, worked: true }] });

    // A clear gives the slot's session a new session ID; the session's record of the old one still stands.
    await workerRecord(mod, W1, { worked: true, writtenAgoMs: 0 });
    mod.listing.text = JSON.stringify([entry(501, "w1", W2, "idle")]);
    mod.time.now += LOOK_MS;
    await mod.look();
    expect(lookRecord()).toMatchObject({ slots: [{ sessionId: W2, state: "idle", worked: false }] });
  });

  it.each([
    ["no session ID", { sessionId: undefined }],
    ["a session ID not in the form of one", { sessionId: "not-a-session-id" }],
    ["a state the look record does not hold", { status: "starting" }],
  ])("leaves the entry of a live slot as it was when the listing gives it %s, and judges the other slots", async (_, fields) => {
    const { mod, entry, lookRecord, real } = await dispatcher(["w1", "w2"]);
    mod.listing.text = JSON.stringify([entry(501, "w1", W1, "idle"), entry(502, "w2", W2, "idle")]);
    await mod.look();
    const lookedAt = new Date(mod.time.now).toISOString();
    mod.time.now += LOOK_MS;
    mod.listing.text = JSON.stringify([{ ...entry(501, "w1", W1, "busy"), ...fields }, entry(502, "w2", W2, "busy")]);

    await mod.look();

    expect(lookRecord()).toEqual({
      version: 1,
      directory: real,
      slots: [
        { name: "w1", sessionId: W1, state: "idle", seenAt: lookedAt, worked: false },
        { name: "w2", sessionId: W2, state: "busy", seenAt: new Date(mod.time.now).toISOString(), worked: false },
      ],
    });
  });

  it.each([
    ["is not JSON", "{\"version\":1,"],
    [
      "has an entry whose name is not a slot name",
      (real: string) => {
        const entry = { sessionId: W2, state: "idle", seenAt: "2026-11-22T02:00:00.000Z", worked: true };
        return JSON.stringify({ version: 1, directory: real, slots: [{ name: "w2", ...entry }, { name: "-w9", ...entry }] });
      },
    ],
  ])("writes a new record from the look when the standing one %s, without the entries of gone slots", async (_, standing) => {
    const { mod, entry, lookRecord, stateDirectory, real } = await dispatcher(["w1", "w2"]);
    const key = new RosterStore(stateDirectory, real).path.replace(/^.*\/pools\//, "");
    mkdirSync(join(stateDirectory, "pool-states"));
    writeFileSync(join(stateDirectory, "pool-states", key), typeof standing === "string" ? standing : standing(real));
    mod.listing.text = JSON.stringify([entry(501, "w1", W1, "idle")]);

    await mod.look();

    expect(lookRecord()).toEqual({ version: 1, directory: real, slots: [{ name: "w1", sessionId: W1, state: "idle", seenAt: new Date(mod.time.now).toISOString(), worked: false }] });
  });
});

describe("the entry of a slot a pool tool acted on", () => {
  const ERROR_RESULT = { result: "w1 was not cleared", text: "w1 was not cleared", isError: true };
  it.each(
    ["clear", "open", "recycle"].flatMap((name) => [
      [name, "its result", FROM_SERVER],
      [name, "an error", ERROR_RESULT],
    ]),
  )("is written anew as soon as a call to %s that names the slot has returned with %s, and the other entries stay", async (name, _, fromCore) => {
    const { mod, entry, lookRecord, stateDirectory, real } = await dispatcher(["w1", "w2", "w3"]);
    mod.listing.text = JSON.stringify([entry(501, "w1", W1, "busy"), entry(502, "w2", W2, "busy"), entry(503, "w3", W5A, "busy")]);
    await mod.look();
    const lookedAt = new Date(mod.time.now).toISOString();
    // w3 leaves the roster, as after a release, before the next look.
    new RosterStore(stateDirectory, real).write(["w1", "w2"].map((slot): Slot => ({ name: slot, origin: "adopted" })));
    const call = await mod.startsCall(tool(name), undefined, { name: "w1" }, fromCore);
    mod.listing.text = JSON.stringify([entry(601, "w1", W3, "idle"), entry(502, "w2", W2, "idle")]);
    mod.time.now += 20_000;

    await call.returns();

    expect(lookRecord()).toEqual({
      version: 1,
      directory: real,
      slots: [
        { name: "w1", sessionId: W3, state: "idle", seenAt: new Date(mod.time.now).toISOString(), worked: false },
        { name: "w2", sessionId: W2, state: "busy", seenAt: lookedAt, worked: false },
        { name: "w3", sessionId: W5A, state: "busy", seenAt: lookedAt, worked: false },
      ],
    });
  });

  it("is added for a slot that had none when a call to open that names it has returned", async () => {
    const { mod, entry, lookRecord, real } = await dispatcher(["w1", "w2"]);
    mod.listing.text = JSON.stringify([entry(501, "w1", W1, "busy")]);
    await mod.look();
    const lookedAt = new Date(mod.time.now).toISOString();
    const call = await mod.startsCall(tool("open"), undefined, { name: "w2" });
    mod.listing.text = JSON.stringify([entry(501, "w1", W1, "idle"), entry(602, "w2", W2, "idle")]);
    mod.time.now += 20_000;

    await call.returns();

    expect(lookRecord()).toEqual({
      version: 1,
      directory: real,
      slots: [
        { name: "w1", sessionId: W1, state: "busy", seenAt: lookedAt, worked: false },
        { name: "w2", sessionId: W2, state: "idle", seenAt: new Date(mod.time.now).toISOString(), worked: false },
      ],
    });
  });

  it.each([
    ["a subagent's call to clear", tool("clear"), "agent-1", { name: "w1" }],
    ["a call to clear that names no slot of the roster", tool("clear"), undefined, { name: "w9" }],
    ["a call to open whose slot is not live and has no entry", tool("open"), undefined, { name: "w2" }],
    ["a call to status", tool("status"), undefined, {}],
  ])("leaves the record as it was after %s", async (_, called, agentId, args) => {
    const { mod, entry, lookRecordText } = await dispatcher(["w1", "w2"]);
    mod.listing.text = JSON.stringify([entry(501, "w1", W1, "busy")]);
    await mod.look();
    const before = lookRecordText();
    const call = await mod.startsCall(called, agentId, args);
    mod.listing.text = JSON.stringify([entry(601, "w1", W3, "idle")]);

    await call.returns();

    expect(lookRecordText()).toBe(before);
  });
});

describe("worker sessions are only read", () => {
  it("runs no command but the listing, writes nothing but the look record and its own activity record, and starts no turn", async () => {
    const { mod, entry, stateDirectory, real } = await dispatcher(["w1", "w2"]);
    mod.listing.text = JSON.stringify([entry(501, "w1", W1, "busy"), entry(502, "w2", W2, "waiting", { waitingFor: "permission prompt" })]);
    await workerRecord(mod, W1, { worked: true });
    const writesBefore = mod.writes.length;

    await mod.look(3);
    const call = await mod.startsCall(tool("clear"), undefined, { name: "w1" });
    await call.returns();

    expect(mod.runs.length).toBeGreaterThan(0);
    expect(new Set(mod.runs.map((argv) => argv.join(" ")))).toEqual(new Set(["claude agents --json"]));
    const key = new RosterStore(stateDirectory, real).path.replace(/^.*\/pools\//, "");
    expect(new Set(mod.writes.slice(writesBefore))).toEqual(new Set([join(stateDirectory, "pool-states", key), join(stateDirectory, "activity", `${SESSION}.json`)]));
    expect(mod.engineCalls.filter((call) => call === "prompt.submit" || call === "command.run")).toEqual([]);
  });
});
