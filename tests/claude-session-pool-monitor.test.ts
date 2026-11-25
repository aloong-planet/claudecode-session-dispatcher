/**
 * The pool monitor (docs/specs/claude-session-pool-monitor.md): what the plugin's mod in a dispatcher session takes at
 * every look, the look record it writes and the reports it makes, through the mod's own `register`, handed a fake of
 * Claude Code's engine (support/dispatcher-mod.ts). Rosters, hook records, activity records, look records and the
 * dispatcher session's transcript are real files in a temporary home directory; a worker session's activity record is
 * written by the mod itself, run in a worker session of its own; the session listing is text shaped like what
 * `claude agents --json` printed on Claude Code 2.1.327, and a received cross-session message is a record shaped like the
 * one measured in a dispatcher session's transcript on 2.1.327.
 *
 * Not covered here: that Claude Code gives a dispatcher session's mod the start-up command's variable, the listing and
 * the real path of the session's directory, tells it of a pool tool's return, and takes its report as a prompt. That
 * needs a real dispatcher session; it was checked by hand on Claude Code 2.1.327 (the delivery notes of the changes that
 * added the look record and the reports).
 *
 * Gaps: two dispatcher sessions in the same directory (claude-session-pool-monitor, "Two dispatcher sessions") need two
 * mods sharing one home directory and one roster, which the fake engine does not set up; each mod keeps its own state,
 * reads its own transcript and reports to its own session.
 */
import { copyFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RosterStore, type Slot } from "../src/roster.ts";
import { DISPATCHER_PID, dispatcher, type Mod } from "./support/dispatcher-mod.ts";
import { AFTER_CLEAR, FROM_SERVER, LOOK_MS, READ_LIMIT, modSetup, settle } from "./support/mod-engine.ts";
import { OTHER_SESSION, SESSION } from "./support/sessions.ts";
import { cleanUpTemporaryDirectories } from "./support/temporary.ts";

afterEach(cleanUpTemporaryDirectories);

const W1 = "0b6f4c1e-3d2a-4f5b-9c8d-7e6f5a4b3c21";
const W2 = "1c7a5d2f-4e3b-4a6c-8d9e-8f7a6b5c4d32";
const W3 = "2d8b6e3a-5f4c-4b7d-9eaf-9a8b7c6d5e43";
const W5A = "3e9c7f4b-6a5d-4c8e-8fb0-ab9c8d7e6f54";
const W5B = "4fad8a5c-7b6e-4d9f-9a01-bcad9e8f7a65";
/** A pool tool, under the name the dispatcher session sees it by. */
const tool = (name: string) => `mcp__plugin_cc-session-pool_pool__${name}`;

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
  it("looks at no pool, and reports nothing, in a session that the start-up command did not start", async () => {
    const { mod, stateDirectory } = await dispatcher(["w1"]);
    mod.variables.dispatcherPid = undefined;

    await mod.look(3);

    expect(mod.runs).toEqual([]);
    expect(mod.reads.filter((path) => path.startsWith(join(stateDirectory, "pools")))).toEqual([]);
    expect(mod.writes.filter((path) => path.includes("/pool-states/"))).toEqual([]);
    expect(mod.prompts).toEqual([]);
  });

  it.each([
    ["the plugin's hooks do not run in it, so it has no hook record", (mod: Mod) => rmSync(join(mod.home, ".claude-session-pool", "hooks"), { recursive: true })],
    ["the hook record of its process names another session ID", (mod: Mod) => mod.wake.writeHookRecord(DISPATCHER_PID, OTHER_SESSION)],
    ["the start-up command's variable names another process than the hook record of its session ID", (mod: Mod) => (mod.variables.dispatcherPid = "4243")],
    ["the variable is not a process ID", (mod: Mod) => (mod.variables.dispatcherPid = "4242 ")],
  ])("writes no look record and makes no report when %s", async (_, change) => {
    const { mod } = await dispatcher(["w1"]);
    mod.listing.text = JSON.stringify([]);
    change(mod);

    await mod.look();

    expect(mod.runs).toEqual([]);
    expect(mod.writes.filter((path) => path.includes("/pool-states/"))).toEqual([]);
    expect(mod.prompts).toEqual([]);
  });

  it("writes the look record when the variable names the process that the hook record of its session ID names", async () => {
    const { mod, lookRecord, real } = await dispatcher(["w1"]);
    mod.listing.text = JSON.stringify([]);

    await mod.look();

    expect(mod.runs).toEqual([["claude", "agents", "--json"]]);
    expect(lookRecord()).toEqual({ version: 1, directory: real, slots: [] });
  });
});

describe("the pool directory (claude-session-pool-monitor, \"The session's directory\")", () => {
  it("is the one the mod took when it was loaded, after the session's directory changes; loaded again, the mod judges no slot there", async () => {
    const { mod, entry, lookRecord, real } = await dispatcher(["w1"]);
    mod.listing.text = JSON.stringify([entry(501, "w1", W1, "idle")]);
    const moved = join(mod.home, "moved");
    mkdirSync(moved);
    mod.root.path = moved;

    await mod.look();
    const kept = lookRecord();
    mod.listing.text = JSON.stringify([]);
    await mod.reload();
    await mod.look(3);

    expect(kept).toMatchObject({ directory: real, slots: [{ name: "w1", sessionId: W1 }] });
    expect(mod.prompts).toEqual([]);
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
  it.each<[string, string, string, unknown, string | undefined]>([
    ...["clear", "open", "recycle"].flatMap((name): [string, string, string, unknown, string | undefined][] => [
      [name, "the main conversation", "its result", FROM_SERVER, undefined],
      [name, "the main conversation", "an error", ERROR_RESULT, undefined],
    ]),
    ["clear", "a subagent", "its result", FROM_SERVER, "agent-1"],
  ])("is written anew as soon as a call to %s from %s that names the slot has returned with %s, and the other entries stay", async (name, _, __, fromCore, agentId) => {
    const { mod, entry, lookRecord, stateDirectory, real } = await dispatcher(["w1", "w2", "w3"]);
    mod.listing.text = JSON.stringify([entry(501, "w1", W1, "busy"), entry(502, "w2", W2, "busy"), entry(503, "w3", W5A, "busy")]);
    await mod.look();
    const lookedAt = new Date(mod.time.now).toISOString();
    // w3 leaves the roster, as after a release, before the next look.
    new RosterStore(stateDirectory, real).write(["w1", "w2"].map((slot): Slot => ({ name: slot, origin: "adopted" })));
    const call = await mod.startsCall(tool(name), agentId, { name: "w1" }, fromCore);
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

  it("is written anew for each slot a call to restore lists, once it has returned, and the other entries stay", async () => {
    const { mod, entry, lookRecord, real } = await dispatcher(["w1", "w2", "w3"]);
    mod.listing.text = JSON.stringify([entry(501, "w1", W1, "busy"), entry(502, "w2", W2, "busy"), entry(503, "w3", W5A, "busy")]);
    await mod.look();
    const lookedAt = new Date(mod.time.now).toISOString();
    const call = await mod.startsCall(tool("restore"), undefined, { names: ["w1", "w3"] });
    mod.listing.text = JSON.stringify([entry(601, "w1", W1, "idle"), entry(502, "w2", W2, "idle"), entry(603, "w3", W5A, "idle")]);
    mod.time.now += 20_000;

    await call.returns();

    const now = new Date(mod.time.now).toISOString();
    expect(lookRecord()).toEqual({
      version: 1,
      directory: real,
      slots: [
        { name: "w1", sessionId: W1, state: "idle", seenAt: now, worked: false },
        { name: "w2", sessionId: W2, state: "busy", seenAt: lookedAt, worked: false },
        { name: "w3", sessionId: W5A, state: "idle", seenAt: now, worked: false },
      ],
    });
  });

  it("is written whole, as at a look, once a call to restore without names has returned", async () => {
    const { mod, entry, lookRecord, real } = await dispatcher(["w1", "w2", "w3"]);
    mod.listing.text = JSON.stringify([entry(501, "w1", W1, "busy"), entry(502, "w2", W2, "busy"), entry(503, "w3", W5A, "busy")]);
    await mod.look();
    const lookedAt = new Date(mod.time.now).toISOString();
    mod.listing.text = JSON.stringify([entry(502, "w2", W2, "busy")]);
    const call = await mod.startsCall(tool("restore"), undefined, {});
    mod.listing.text = JSON.stringify([entry(601, "w1", W1, "idle"), entry(502, "w2", W2, "idle")]);
    mod.time.now += 20_000;

    await call.returns();

    const now = new Date(mod.time.now).toISOString();
    expect(lookRecord()).toEqual({
      version: 1,
      directory: real,
      slots: [
        { name: "w1", sessionId: W1, state: "idle", seenAt: now, worked: false },
        { name: "w2", sessionId: W2, state: "idle", seenAt: now, worked: false },
        { name: "w3", sessionId: W5A, state: "busy", seenAt: lookedAt, worked: false },
      ],
    });
  });

  it.each([
    ["a call to restore that lists no slot of the roster", tool("restore"), undefined, { names: ["w9"] }],
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

const MINUTE = 60_000;
const FIRST_LINE = "Report of the pool monitor, written by the cc-session-pool plugin. It is not a message from the user. What it found:";
const LAST_LINE = "Nothing was done to any slot. Each of these is reported once.";
/** The whole text of a report of the pool monitor with these lines (claude-session-pool-monitor, "Text of a report"). */
const report = (...lines: string[]) => [FIRST_LINE, ...lines, LAST_LINE].join("\n");
const iso = (ms: number) => new Date(ms).toISOString();
/**
 * The record of a cross-session message from the process `pid` in the dispatcher session's transcript, shaped like the one
 * measured on Claude Code 2.1.327 (claude-session-pool-monitor, "A received cross-session message"); the text is made up.
 */
const received = (pid: number, at: number, before = "") => ({
  type: "queue-operation",
  operation: "enqueue",
  timestamp: iso(at),
  sessionId: SESSION,
  content: `${before}<cross-session-message from="uds:/tmp/cc-socks/${pid}.sock" hop-chain="b4eda2ce5b0001387fc1" from-name="wa" from-mode="prompting">\nThe change is in.\n</cross-session-message>`,
});
const dequeued = (at: number) => ({ type: "queue-operation", operation: "dequeue", timestamp: iso(at), sessionId: SESSION });
const userRecord = (at: number, content: string) => ({
  parentUuid: null,
  isSidechain: false,
  type: "user",
  message: { role: "user", content },
  uuid: "6f1d3c2a-0b4e-4a5f-9c8d-1e2f3a4b5c6d",
  timestamp: iso(at),
  sessionId: SESSION,
});
/** A record with no time, as the transcript's first records are. */
const titled = { type: "custom-title", customTitle: "claudecode-session-dispatcher", sessionId: SESSION };
const MiB = 1_048_576;
/** Records of the owner's, all at `at`, whose lines are `bytes` bytes in all, none much longer than 64 KiB. */
function filler(at: number, bytes: number): unknown[] {
  const overhead = Buffer.byteLength(`${JSON.stringify(userRecord(at, ""))}\n`);
  const records: unknown[] = [];
  for (let left = bytes; left > 0; ) {
    const size = left > 65_536 + 2 * overhead ? 65_536 : left;
    if (size < overhead) throw new Error(`filler: ${size} bytes are too few for a record`);
    records.push(userRecord(at, "x".repeat(size - overhead)));
    left -= size;
  }
  return records;
}

type Pool = Awaited<ReturnType<typeof dispatcher>>;
const reportsOf = (pool: Pool) => pool.mod.prompts.filter((prompt) => prompt.startsWith(FIRST_LINE));

describe("a slot whose session is gone (claude-session-pool-monitor::US-001/AC-02)", () => {
  it("is reported once, at the look that finds it gone after one found it live, and anew once it was live again", async () => {
    const pool = await dispatcher(["wa"]);
    await (await pool.worker(W1)).loads();
    const live = JSON.stringify([pool.entry(501, "wa", W1, "idle")]);
    pool.mod.listing.text = live;
    await pool.looks();
    pool.mod.listing.text = "[]";
    await pool.looks(4);
    const once = [...pool.mod.prompts];
    pool.mod.listing.text = live;
    await pool.looks(2);
    const whileLive = pool.mod.prompts.length;
    pool.mod.listing.text = "[]";
    await pool.looks(2);

    const gone = report("- wa: gone. No live session in the pool directory answers to this name any more.");
    expect(once).toEqual([gone]);
    expect(whileLive).toBe(1);
    expect(pool.mod.prompts).toEqual([gone, gone]);
  });
});

describe("the slots gone at the first look after the mod is loaded (claude-session-pool-monitor::US-001/AC-03)", () => {
  it("are named in one line with, apart, those whose conversation restore brings back, and are not reported again", async () => {
    const pool = await dispatcher(["wa", "wb", "wc", "wd", "we"]);
    pool.roster.write([
      { name: "wa", origin: "adopted" },
      { name: "wb", origin: "adopted" },
      { name: "wc", origin: "adopted" },
      { name: "wd", origin: "opened", pid: 704, endedSessionId: W3 },
      { name: "we", origin: "adopted" },
    ]);
    // What the last look before the restart found: wa's conversation had no work, wd's was ended by recycle, and a live
    // session elsewhere holds we's.
    const entry = (name: string, sessionId: string, worked: boolean) => ({ name, sessionId, state: "busy", seenAt: "2026-11-22T02:00:00.000Z", worked });
    mkdirSync(join(pool.stateDirectory, "pool-states"), { recursive: true });
    writeFileSync(pool.lookRecordPath, JSON.stringify({ version: 1, directory: pool.real, slots: [entry("wa", W1, false), entry("wb", W2, true), entry("wd", W3, true), entry("we", W5A, true)] }));
    pool.mod.listing.text = JSON.stringify([{ pid: 900, cwd: "/Users/someone/elsewhere", kind: "interactive", sessionId: W5A, name: "other", status: "idle" }]);

    await pool.looks(4);

    expect(pool.mod.prompts).toEqual([
      report("- No live session in the pool directory answers to these slots of the roster: wa, wb, wc, wd, we. The restore tool brings back the unfinished conversations of: wb."),
    ]);
  });

  it("leave out a slot that a pool tool is acting on at that look (claude-session-pool-monitor, \"A pool tool\")", async () => {
    const pool = await dispatcher(["wa", "wb"]);
    const call = await pool.mod.startsCall(tool("restore"), undefined, { names: ["wa"] });
    await pool.looks();
    await call.returns();

    await pool.looks(3);

    expect(pool.mod.prompts).toEqual([report("- No live session in the pool directory answers to these slots of the roster: wb.")]);
  });

  it("leave out the second sentence when restore brings back none of them", async () => {
    const pool = await dispatcher(["wa"]);

    await pool.looks(3);

    expect(pool.mod.prompts).toEqual([report("- No live session in the pool directory answers to these slots of the roster: wa.")]);
  });

  it("wait, while a turn runs, as the slots of them that are still gone, and are not reported when none is (claude-session-pool-plugin::REQ-005/AC-02)", async () => {
    const pool = await dispatcher(["wa", "wb"]);
    await (await pool.worker(W2)).loads();
    await pool.mod.turnStarts();
    await pool.looks();
    pool.mod.listing.text = JSON.stringify([pool.entry(502, "wb", W2, "idle")]);
    await pool.looks();
    await pool.mod.turnEnds();
    await pool.looks();
    const one = [...pool.mod.prompts];

    const again = await dispatcher(["wa"]);
    await again.mod.turnStarts();
    await again.looks();
    await (await again.worker(W1)).loads();
    again.mod.listing.text = JSON.stringify([again.entry(501, "wa", W1, "idle")]);
    await again.looks();
    await again.mod.turnEnds();
    await again.looks(2);

    expect(one).toEqual([report("- No live session in the pool directory answers to these slots of the roster: wa.")]);
    expect(again.mod.prompts).toEqual([]);
  });
});

describe("an ambiguous slot (claude-session-pool-monitor::US-001/AC-04)", () => {
  it("is reported with the number of sessions that answer to its name, once, anew when the number changes, and not when it ends", async () => {
    const pool = await dispatcher(["wa"]);
    await (await pool.worker(W1)).loads();
    pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "idle"), pool.entry(502, "wa", W2, "idle")]);
    await pool.looks(3);
    pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "idle"), pool.entry(502, "wa", W2, "idle"), pool.entry(503, "wa", W3, "busy")]);
    await pool.looks(3);
    pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "idle")]);
    await pool.looks(3);

    expect(pool.mod.prompts).toEqual([
      report("- wa: ambiguous. 2 live sessions in the pool directory answer to this name."),
      report("- wa: ambiguous. 3 live sessions in the pool directory answer to this name."),
    ]);
  });
});

describe("a waiting slot (claude-session-pool-monitor::US-001/AC-05)", () => {
  /** A dispatcher whose slot wa has a worker session that writes its record, listed as `status` with these fields. */
  async function listed(fields: Record<string, unknown>, sessionId = W1) {
    const pool = await dispatcher(["wa"]);
    await (await pool.worker(sessionId)).loads();
    const list = (more: Record<string, unknown>, id = sessionId) => (pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", id, "waiting", more)]));
    list(fields);
    return { pool, list };
  }

  it("is reported at the second look in a row that finds it waiting for the same thing, once, and not when the wait ends", async () => {
    const { pool } = await listed({ waitingFor: "permission prompt" });
    await pool.looks();
    const first = pool.mod.prompts.length;
    await pool.looks(6);
    pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "idle")]);
    await pool.looks(2);

    expect(first).toBe(0);
    expect(pool.mod.prompts).toEqual([report("- wa: waiting for permission prompt.")]);
  });

  it("is not reported while what it waits for has changed at the second look, until that has lasted two looks", async () => {
    const { pool, list } = await listed({ waitingFor: "permission prompt" });
    await pool.looks();
    list({ waitingFor: "user input" });
    await pool.looks();
    const second = pool.mod.prompts.length;
    await pool.looks();

    expect(second).toBe(0);
    expect(pool.mod.prompts).toEqual([report("- wa: waiting for user input.")]);
  });

  it("is reported anew when what it waits for changes, and when its session ID does (claude-session-pool-monitor::US-001/AC-09)", async () => {
    const { pool, list } = await listed({ waitingFor: "permission prompt" });
    await pool.looks(2);
    list({ waitingFor: "user input" });
    await pool.looks(2);
    await (await pool.worker(W2)).loads();
    list({ waitingFor: "user input" }, W2);
    await pool.looks(3);

    expect(pool.mod.prompts).toEqual([report("- wa: waiting for permission prompt."), report("- wa: waiting for user input."), report("- wa: waiting for user input.")]);
  });

  it.each([
    ["holds a line break", "permission\nprompt", "- wa: waiting on a prompt."],
    ["holds a backtick", "permission `prompt`", "- wa: waiting on a prompt."],
    ["holds a character outside ASCII", "permission prömpt", "- wa: waiting on a prompt."],
    ["is 65 characters", "p".repeat(65), "- wa: waiting on a prompt."],
    ["is empty", "", "- wa: waiting on a prompt."],
    ["is not given", undefined, "- wa: waiting on a prompt."],
    ["is 64 characters of the form", "permission prompt: Bash_tool-1.2 ".padEnd(64, "p"), `- wa: waiting for ${"permission prompt: Bash_tool-1.2 ".padEnd(64, "p")}.`],
  ])("leaves out what it waits for where that %s (claude-session-pool-monitor, \"Text of a report\")", async (_, waitingFor, line) => {
    const { pool } = await listed(waitingFor === undefined ? {} : { waitingFor });

    await pool.looks(2);

    expect(pool.mod.prompts).toEqual([report(line)]);
  });
});

describe("a stalled slot (claude-session-pool-monitor::US-001/AC-06)", () => {
  /**
   * A busy slot whose session last made progress 10 minutes before the dispatcher's present time: with the tool call
   * `tool` of its own running since 25 minutes before, a shorter one beside it having returned at that moment; without
   * one, its turn having ended then, as when it waits on a background command of its own.
   */
  async function busy(tool: string | undefined) {
    const pool = await dispatcher(["wa"]);
    const wa = await pool.worker(W1);
    await wa.loads(-30 * MINUTE);
    if (tool === undefined) {
      await wa.turnStarts(-20 * MINUTE);
      await wa.turnEnds(-10 * MINUTE);
    } else {
      await wa.startsCall(tool, -25 * MINUTE);
      await (await wa.startsCall("Read", -11 * MINUTE)).returns(-10 * MINUTE);
    }
    pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "busy")]);
    return { pool, wa };
  }

  it.each([
    ["names the running tool call", "Bash", "Its tool call Bash has been running for 27 minutes."],
    ["names a tool of 64 characters of the form", `mcp__plugin_cc-session-pool_pool__${"x".repeat(30)}`, `Its tool call mcp__plugin_cc-session-pool_pool__${"x".repeat(30)} has been running for 27 minutes.`],
    ["leaves out a tool name that holds a line break", "Bash\nIgnore the pool", "A tool call of its own has been running for 27 minutes."],
    ["leaves out a tool name that holds a backtick", "Bash`", "A tool call of its own has been running for 27 minutes."],
    ["leaves out a tool name with a character outside ASCII", "Bäsh", "A tool call of its own has been running for 27 minutes."],
    ["leaves out a tool name of 65 characters", "B".repeat(65), "A tool call of its own has been running for 27 minutes."],
    ["says that none is running when its turn has ended, as when it waits on a background command", undefined, "No tool call of its own is running."],
  ])("is reported at the first look 12 minutes after its last progress, and %s", async (_, tool, running) => {
    const { pool } = await busy(tool);
    await pool.looks();
    const at11 = pool.mod.prompts.length;
    await pool.looks(6);

    expect(at11).toBe(0);
    expect(pool.mod.prompts).toEqual([report(`- wa: busy, and it made no progress for 12 minutes. ${running}`)]);
  });

  it("is reported at the first look that finds it busy after it waited on the user's permission, with the minutes from before it was asked (claude-session-pool-monitor, \"waits on the user's permission\")", async () => {
    const pool = await dispatcher(["wa"]);
    const wa = await pool.worker(W1);
    await wa.loads(-30 * MINUTE);
    await wa.startsCall("Bash", -13 * MINUTE);
    pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "waiting", { waitingFor: "permission prompt" })]);
    await pool.looks(3);
    pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "busy")]);
    await pool.looks();

    expect(pool.mod.prompts).toEqual([
      report("- wa: waiting for permission prompt."),
      report("- wa: busy, and it made no progress for 17 minutes. Its tool call Bash has been running for 17 minutes."),
    ]);
  });

  it("is reported anew when it stalls after it made progress again (claude-session-pool-monitor::US-001/AC-09)", async () => {
    const { pool, wa } = await busy(undefined);
    await pool.looks(4);
    await wa.turnStarts();
    await pool.looks(11);
    const before = pool.mod.prompts.length;
    await pool.looks();

    expect(before).toBe(1);
    expect(pool.mod.prompts).toEqual([
      report("- wa: busy, and it made no progress for 12 minutes. No tool call of its own is running."),
      report("- wa: busy, and it made no progress for 12 minutes. No tool call of its own is running."),
    ]);
  });
});

describe("a stopped slot (claude-session-pool-monitor::US-001/AC-07, REQ-002)", () => {
  /**
   * Slots wa and wb with worker sessions; wa's turn ends at the first look after the dispatcher's mod was loaded, and both
   * are idle from then on. The dispatcher session's transcript holds `records`, after a first one an hour before.
   */
  async function stops(records: (endedAt: number) => unknown[] | undefined) {
    const pool = await dispatcher(["wa", "wb"]);
    const wa = await pool.worker(W1);
    await wa.loads(-30 * MINUTE);
    const wb = await pool.worker(W2);
    await wb.loads(-30 * MINUTE);
    await wa.turnStarts(-10 * MINUTE);
    pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "busy"), pool.entry(502, "wb", W2, "idle")]);
    await pool.looks();
    await wa.turnEnds();
    const endedAt = pool.mod.time.now;
    pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "idle"), pool.entry(502, "wb", W2, "idle")]);
    const written = records(endedAt);
    if (written !== undefined) pool.transcript(written);
    return { pool, wa, wb, endedAt };
  }
  const opened = (endedAt: number) => [titled, userRecord(endedAt - 60 * MINUTE, "Run the pool.")];
  const NOT_TOLD = "- wa: idle for 5 minutes since its last turn ended, and it sent this session no message since 5 minutes before that.";
  const NOT_READ = "- wa: idle for 5 minutes since its last turn ended. Whether it sent this session a message could not be read.";

  it("is reported at the first look 5 minutes after its last turn ended, once", async () => {
    const { pool } = await stops(opened);
    await pool.looks(4);
    const at4 = pool.mod.prompts.length;
    await pool.looks(6);

    expect(at4).toBe(0);
    expect(pool.mod.prompts).toEqual([report(NOT_TOLD)]);
  });

  it("is not reported when its last turn ended before the dispatcher session's mod was loaded", async () => {
    const pool = await dispatcher(["wa"]);
    const wa = await pool.worker(W1);
    await wa.loads(-30 * MINUTE);
    await wa.turnStarts(-20 * MINUTE);
    await wa.turnEnds(-10 * MINUTE);
    pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "idle")]);
    pool.transcript([titled, userRecord(pool.mod.time.now - 60 * MINUTE, "Run the pool.")]);

    await pool.looks(10);

    expect(pool.mod.prompts).toEqual([]);
  });

  it("is reported anew when it stops after another turn (claude-session-pool-monitor::US-001/AC-09)", async () => {
    const { pool, wa } = await stops(opened);
    await pool.looks(5);
    await wa.turnStarts();
    await wa.turnEnds();
    await pool.looks(5);

    expect(pool.mod.prompts).toEqual([report(NOT_TOLD), report(NOT_TOLD)]);
  });

  it.each([
    ["4 minutes before its turn ended", -4 * MINUTE, []],
    ["2 minutes after its turn ended", 2 * MINUTE, []],
    ["6 minutes before its turn ended", -6 * MINUTE, [report(NOT_TOLD)]],
  ])("counts as having told the dispatcher session by a message that arrived %s (claude-session-pool-monitor::REQ-002/AC-01)", async (_, offset, prompts) => {
    const { pool } = await stops((endedAt) => [...opened(endedAt), received(501, endedAt + offset), dequeued(endedAt + offset + 24)]);

    await pool.looks(6);

    expect(pool.mod.prompts).toEqual(prompts);
  });

  it.each([
    ["a message from another slot's session", (endedAt: number) => [received(502, endedAt - MINUTE)]],
    ["a user's record that quotes the slot's address", (endedAt: number) => [userRecord(endedAt - MINUTE, '<cross-session-message from="uds:/tmp/cc-socks/501.sock">')]],
    ["a queued message whose text quotes the slot's address after other text", (endedAt: number) => [received(501, endedAt - MINUTE, "Forwarded: ")]],
    [
      "a record of another kind whose content begins with the slot's address",
      (endedAt: number) => [{ ...userRecord(endedAt - MINUTE, ""), type: "system", subtype: "local_command", content: received(501, 0).content }],
    ],
  ])("does not count as having told it by %s (claude-session-pool-monitor::REQ-002/AC-02)", async (_, records) => {
    const { pool } = await stops((endedAt) => [...opened(endedAt), ...records(endedAt)]);

    await pool.looks(6);

    expect(pool.mod.prompts).toEqual([report(NOT_TOLD)]);
  });

  it("is not judged again for that stop once it has told the dispatcher session, whatever its transcript later holds", async () => {
    const { pool, endedAt } = await stops((at) => [...opened(at), received(501, at - MINUTE)]);
    await pool.looks(6);
    // A /clear of the dispatcher session gives it a transcript that begins after the end of the slot's turn.
    pool.transcript([titled, userRecord(endedAt + 7 * MINUTE, "Go on.")]);
    await pool.looks(3);

    expect(pool.mod.prompts).toEqual([]);
  });

  it.each([
    ["has no transcript", () => undefined],
    ["has a transcript whose first record is from after 5 minutes before the end of the turn, as after a /clear", (endedAt: number) => [titled, userRecord(endedAt - 4 * MINUTE, "Go on.")]],
    ["has a transcript that is not JSON lines", () => ['{"type": "user", "timestamp": "2026-11-22T01:00:00.000Z"']],
  ])("is reported with what could not be read when the dispatcher session %s (claude-session-pool-monitor::REQ-002/AC-03)", async (_, records) => {
    const { pool } = await stops(records);

    await pool.looks(6);

    expect(pool.mod.prompts).toEqual([report(NOT_READ)]);
  });

  it("counts as having told it by a message in a transcript that holds no record from before that time, as after a /clear (claude-session-pool-monitor::REQ-002/AC-03)", async () => {
    const { pool } = await stops((endedAt) => [titled, userRecord(endedAt - 2 * MINUTE, "Go on."), received(501, endedAt + MINUTE)]);

    await pool.looks(6);

    expect(pool.mod.prompts).toEqual([]);
  });

  it.each([
    ["counts as having told it by a message near the end", (endedAt: number) => [received(501, endedAt - MINUTE)], []],
    ["is reported as having sent no message when none is from it", () => [], [report(NOT_TOLD)]],
  ])("in a transcript over the read limit %s (claude-session-pool-monitor::REQ-002/AC-01, AC-02)", async (_, near, prompts) => {
    const { pool } = await stops((endedAt) => [...opened(endedAt), ...filler(endedAt - 50 * MINUTE, READ_LIMIT + MiB), ...near(endedAt)]);

    await pool.looks(6);

    expect(pool.mod.prompts).toEqual(prompts);
  });

  it("counts as having told it by a message whose record, and a character in it, a range of the read limit cuts (claude-session-pool-monitor::REQ-002/AC-01)", async () => {
    const message = (endedAt: number) => {
      const record = received(501, endedAt - MINUTE);
      return { ...record, content: record.content.replace("The change is in.", "中".repeat(64)) };
    };
    // The bytes before the record, so that the range's last byte is the first of the 中 that comes eleventh in the record.
    const before = (endedAt: number) => {
      const line = JSON.stringify(message(endedAt));
      return READ_LIMIT - 1 - Buffer.byteLength(line.slice(0, line.indexOf("中"))) - 10 * Buffer.byteLength("中");
    };
    const { pool, endedAt } = await stops((at) => [titled, ...filler(at - 60 * MINUTE, before(at) - Buffer.byteLength(`${JSON.stringify(titled)}\n`)), message(at)]);
    const bytes = readFileSync(pool.mod.conversation.transcriptPath);
    expect([bytes[READ_LIMIT - 1], bytes[READ_LIMIT]]).toEqual([...Buffer.from("中").subarray(0, 2)]);
    expect(before(endedAt)).toBeGreaterThan(0);

    await pool.looks(6);

    expect(pool.mod.prompts).toEqual([]);
  });

  it("counts as having told it by a message after a record longer than the read limit, which is passed over (claude-session-pool-monitor, \"A record of the dispatcher session's transcript is longer than the read limit\")", async () => {
    const { pool } = await stops((endedAt) => [
      ...opened(endedAt),
      userRecord(endedAt - 30 * MINUTE, "x".repeat(2 * READ_LIMIT + MiB)),
      userRecord(endedAt - 20 * MINUTE, "Go on."),
      received(501, endedAt - MINUTE),
    ]);

    await pool.looks(6);

    expect(pool.mod.prompts).toEqual([]);
  });

  it("reads at each look only what was added to the transcript since an earlier look read it, while its line stays due", async () => {
    const { pool } = await stops((endedAt) => [...opened(endedAt), ...filler(endedAt - 50 * MINUTE, READ_LIMIT + MiB)]);
    await pool.mod.turnStarts();
    await pool.looks(5);
    const read = statSync(pool.mod.conversation.transcriptPath).size;
    const rangesBefore = pool.mod.readRanges.length;
    pool.transcript([userRecord(pool.mod.time.now, "Go on.")], { append: true });

    await pool.looks(2);

    const later = pool.mod.readRanges.slice(rangesBefore).filter(({ path }) => path === pool.mod.conversation.transcriptPath);
    expect(later.length).toBeGreaterThan(0);
    expect(later.map(({ offset }) => offset)).toEqual(later.map(() => read));
    expect(pool.mod.prompts).toEqual([]);
  });

  it("counts as having told it by a message whose record was still being written at an earlier look, read whole at the next (claude-session-pool-monitor, \"The last record of the dispatcher session's transcript has no newline yet\")", async () => {
    const { pool, endedAt } = await stops(opened);
    const line = JSON.stringify(received(501, endedAt + 4 * MINUTE));
    await pool.mod.turnStarts();
    await pool.looks(4);
    pool.transcript([], { append: true, unfinished: line.slice(0, 120) });
    await pool.looks();
    pool.transcript([], { append: true, unfinished: `${line.slice(120)}\n` });
    await pool.mod.turnEnds();

    await pool.looks(2);

    expect(pool.mod.prompts).toEqual([]);
  });

  it("is reported at a look at which its transcript became shorter between its measure and its read, and a later look reads on from what that look took (claude-session-pool-monitor::REQ-002/AC-01)", async () => {
    const { pool, wb, endedAt } = await stops(opened);
    await pool.looks(4);
    // wb's stop is judged at a later look, by wb's message in the record that the file loses part of at wa's look.
    await wb.turnStarts();
    await wb.turnEnds();
    const line = JSON.stringify(received(502, endedAt + 4 * MINUTE + 30_000));
    const read = statSync(pool.mod.conversation.transcriptPath).size;
    pool.transcript([line], { append: true });
    pool.mod.conversation.cutAfterStat = read + 120;
    await pool.looks();
    // Taken before the file has its record back: a look that does not end at the short read has made no report by then.
    const atShortRead = [...pool.mod.prompts];
    pool.transcript([], { append: true, unfinished: `${line.slice(120)}\n` });

    await pool.looks(5);

    expect(atShortRead).toEqual([report(NOT_TOLD)]);
    expect(pool.mod.prompts).toEqual([report(NOT_TOLD)]);
  });

  it.each([
    ["a /clear has given the session a new transcript", (pool: Pool) => void (pool.mod.conversation.transcriptPath = join(pool.mod.home, ".claude", "projects", "-somewhere", `${AFTER_CLEAR}.jsonl`))],
    ["its transcript has become shorter than what was read of it", () => {}],
  ])("counts as having told it by a message at the start of the transcript, once %s", async (_, change) => {
    const { pool, wa } = await stops((endedAt) => [...opened(endedAt), ...filler(endedAt - 50 * MINUTE, 200_000)]);
    await pool.looks(6);
    change(pool);
    await wa.turnStarts();
    await wa.turnEnds();
    const endedAgain = pool.mod.time.now;
    const after = [titled, userRecord(endedAgain - 2 * MINUTE, "Go on."), received(501, endedAgain + MINUTE)];
    // A new transcript is longer than what was read of the old one, so that only reading it from its start finds the message.
    pool.transcript(pool.mod.conversation.transcriptPath.includes(AFTER_CLEAR) ? [...after, ...filler(endedAgain, 300_000)] : after);

    await pool.looks(6);

    expect(pool.mod.prompts).toEqual([report(NOT_TOLD)]);
  });
});

describe("an unrecorded slot (claude-session-pool-monitor::US-001/AC-08)", () => {
  const UNRECORDED = "- wa: its session writes no activity record, so whether it makes progress is not known.";
  it.each([
    ["has no activity record", async () => {}],
    ["has the record of another session ID", async (pool: Pool) => void (await (await pool.worker(W1, OTHER_SESSION)).loads())],
  ])("is reported at the third look in a row at which its session %s, once", async (_, record) => {
    const pool = await dispatcher(["wa"]);
    await record(pool);
    pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "idle")]);
    await pool.looks(2);
    const at2 = pool.mod.prompts.length;
    await pool.looks(5);

    expect(at2).toBe(0);
    expect(pool.mod.prompts).toEqual([report("- wa: its session writes no activity record, so whether it makes progress is not known.")]);
  });

  it("is not reported as stalled while its record, which names progress long before, is no longer written", async () => {
    const pool = await dispatcher(["wa"]);
    const wa = await pool.worker(W1);
    await wa.loads(-40 * MINUTE);
    await wa.writes(-2 * MINUTE);
    wa.writing = false;
    pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "busy")]);

    await pool.looks(5);

    expect(pool.mod.prompts).toEqual([report("- wa: its session writes no activity record, so whether it makes progress is not known.")]);
  });

  it("is reported again once the listing gives its slot a new session ID, as after a clear, that writes no record either (claude-session-pool-monitor::US-001/AC-09)", async () => {
    const pool = await dispatcher(["wa"]);
    pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "idle")]);
    await pool.looks(3);
    pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W2, "idle")]);
    await pool.looks(2);
    const at2 = pool.mod.prompts.length;
    await pool.looks();

    expect(at2).toBe(1);
    expect(pool.mod.prompts).toEqual([UNRECORDED, UNRECORDED].map((line) => report(line)));
  });

  it("is a live slot whose listing gives no session ID in form: judged as unrecorded and gone, and not as waiting, which needs one session ID (claude-session-pool-monitor, \"no session ID in the form\", US-001/AC-05)", async () => {
    const pool = await dispatcher(["wa", "wb"]);
    await (await pool.worker(W2)).loads(-30 * MINUTE);
    pool.mod.listing.text = JSON.stringify([
      pool.entry(501, "wa", "not-a-session-id", "waiting", { waitingFor: "permission prompt" }),
      pool.entry(502, "wb", W2, "starting"),
    ]);
    await pool.looks(5);
    pool.mod.listing.text = "[]";
    await pool.looks();

    expect(pool.mod.prompts).toEqual([
      report("- wa: its session writes no activity record, so whether it makes progress is not known."),
      report("- wa: gone. No live session in the pool directory answers to this name any more.", "- wb: gone. No live session in the pool directory answers to this name any more."),
    ]);
  });
});

describe("a slot's run of looks (claude-session-pool-monitor, \"in a row\")", () => {
  it.each([
    ["a look that judges no slot", (mod: Mod): void => void (mod.listing.exitCode = 1), (mod: Mod): void => void (mod.listing.exitCode = 0)],
    [
      "a look at which the session is not taken as a dispatcher session",
      (mod: Mod): void => void (mod.variables.dispatcherPid = undefined),
      (mod: Mod): void => void (mod.variables.dispatcherPid = String(DISPATCHER_PID)),
    ],
  ])("passes over %s", async (_, blind, restore) => {
    const pool = await dispatcher(["wa", "wb"]);
    await (await pool.worker(W1)).loads();
    pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "waiting", { waitingFor: "permission prompt" }), pool.entry(502, "wb", W2, "idle")]);
    await pool.looks();
    blind(pool.mod);
    await pool.looks();
    restore(pool.mod);
    await pool.looks(2);

    // wa's second look in a row and wb's third each come after the look passed over.
    expect(pool.mod.prompts).toEqual([
      report("- wa: waiting for permission prompt."),
      report("- wb: its session writes no activity record, so whether it makes progress is not known."),
    ]);
  });
});

describe("a pool that cannot be seen (claude-session-pool-monitor::REQ-003/AC-02)", () => {
  it("is reported once, at the 10th look in a row that judges no slot, with the minutes and the reason of the last", async () => {
    const pool = await dispatcher(["wa"]);
    pool.mod.listing.exitCode = 1;
    await pool.looks(9);
    const at9 = pool.mod.prompts.length;
    await pool.looks();
    const listing = [...pool.mod.prompts];
    await pool.looks(10);

    const roster = await dispatcher(["wa"]);
    roster.mod.listing.exitCode = 1;
    await roster.looks(9);
    writeFileSync(roster.roster.path, "{");
    await roster.looks();

    expect(at9).toBe(0);
    expect(listing).toEqual([report("- The monitor could not see the pool for 10 minutes: the sessions on this Mac could not be listed.")]);
    expect(pool.mod.prompts).toEqual(listing);
    expect(roster.mod.prompts).toEqual([report("- The monitor could not see the pool for 10 minutes: the roster could not be read.")]);
  });

  it("is reported again when, after a look that judges slots, 10 more looks in a row judge no slot", async () => {
    const pool = await dispatcher(["wa"]);
    await (await pool.worker(W1)).loads();
    pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "idle")]);
    pool.mod.listing.exitCode = 1;
    await pool.looks(10);
    pool.mod.listing.exitCode = 0;
    await pool.looks();
    pool.mod.listing.exitCode = 1;

    await pool.looks(10);

    const line = report("- The monitor could not see the pool for 10 minutes: the sessions on this Mac could not be listed.");
    expect(pool.mod.prompts).toEqual([line, line]);
  });

  it("counts anew after a look that judges slots, passes over looks at which the session is not taken as a dispatcher session, and says nothing when it sees the pool again", async () => {
    const pool = await dispatcher(["wa"]);
    await (await pool.worker(W1)).loads();
    pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "idle")]);
    await pool.looks();
    pool.mod.listing.exitCode = 1;
    await pool.looks(5);
    pool.mod.listing.exitCode = 0;
    await pool.looks();
    pool.mod.listing.exitCode = 1;
    await pool.looks(5);
    pool.mod.variables.dispatcherPid = undefined;
    await pool.looks(3);
    pool.mod.variables.dispatcherPid = String(DISPATCHER_PID);
    await pool.looks(4);
    const at9 = pool.mod.prompts.length;
    await pool.looks();
    pool.mod.listing.exitCode = 0;
    await pool.looks(3);

    expect(at9).toBe(0);
    expect(pool.mod.prompts).toEqual([report("- The monitor could not see the pool for 10 minutes: the sessions on this Mac could not be listed.")]);
  });
});

/**
 * Conditions of slot wa that are due at the look after `condition` has run, with a pool tool that acts on wa and the line
 * of the condition.
 */
const CONDITIONS: [string, string, (pool: Pool) => Promise<void>, string][] = [
  [
    "ambiguous",
    "close",
    (pool) => {
      pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "idle"), pool.entry(502, "wa", W2, "idle")]);
      return Promise.resolve();
    },
    "- wa: ambiguous. 2 live sessions in the pool directory answer to this name.",
  ],
  [
    "stalled",
    "compact",
    async (pool) => {
      const wa = await pool.worker(W1);
      await wa.loads(-30 * MINUTE);
      await wa.turnStarts(-20 * MINUTE);
      await wa.turnEnds(-12 * MINUTE);
      pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "busy")]);
    },
    "- wa: busy, and it made no progress for 13 minutes. No tool call of its own is running.",
  ],
  [
    "stopped",
    "restore",
    async (pool) => {
      const wa = await pool.worker(W1);
      await wa.loads(-30 * MINUTE);
      await wa.turnStarts(-10 * MINUTE);
      pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "busy")]);
      await pool.looks();
      await wa.turnEnds();
      pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "idle")]);
      pool.transcript([titled, userRecord(pool.mod.time.now - 60 * MINUTE, "Run the pool.")]);
      await pool.looks(4);
    },
    "- wa: idle for 5 minutes since its last turn ended, and it sent this session no message since 5 minutes before that.",
  ],
  [
    "waiting",
    "clear",
    async (pool) => {
      await (await pool.worker(W1)).loads();
      pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "waiting", { waitingFor: "permission prompt" })]);
      await pool.looks();
    },
    "- wa: waiting for permission prompt.",
  ],
  [
    "unrecorded",
    "open",
    async (pool) => {
      pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "idle")]);
      await pool.looks(2);
    },
    "- wa: its session writes no activity record, so whether it makes progress is not known.",
  ],
];
/** A pool tool's answer to a call that left the slot as it was. */
const LEFT_AS_IT_IS = { result: "wa was left as it is", text: "wa was left as it is", isError: true };
const actsOnWa = (name: string) => (name === "restore" ? { names: ["wa"] } : { name: "wa" });

describe("a slot a pool tool is acting on (claude-session-pool-monitor, \"A pool tool\")", () => {
  /** wa waits on a prompt and its session writes its record: due at the second look, unless left out. */
  async function waiting() {
    const pool = await dispatcher(["wa"]);
    await (await pool.worker(W1)).loads();
    pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "waiting", { waitingFor: "permission prompt" })]);
    return pool;
  }

  it.each([
    ["init", "the main conversation", undefined, { names: ["wa"] }],
    ["open", "the main conversation", undefined, { name: "wa" }],
    ["recycle", "the main conversation", undefined, { name: "wa" }],
    ["close", "the main conversation", undefined, { name: "wa" }],
    ["clear", "the main conversation", undefined, { name: "wa" }],
    ["compact", "the main conversation", undefined, { name: "wa" }],
    ["restore", "the main conversation", undefined, { names: ["wa"] }],
    ["clear", "a subagent", "agent-1", { name: "wa" }],
  ])("is in no line while a call to %s from %s that names it runs, and its entry is still written", async (name, _, agentId, args) => {
    const pool = await waiting();
    await pool.mod.startsCall(tool(name), agentId, args);

    await pool.looks(4);

    expect(pool.mod.prompts).toEqual([]);
    expect(pool.lookRecord()).toMatchObject({ slots: [{ name: "wa", state: "waiting", seenAt: iso(pool.mod.time.now) }] });
  });

  it("is not left out for a call to restore without names", async () => {
    const pool = await waiting();
    await pool.mod.startsCall(tool("restore"), undefined, {});

    await pool.looks(2);

    expect(pool.mod.prompts).toEqual([report("- wa: waiting for permission prompt.")]);
  });

  it.each([
    ["close that returned and left no session", FROM_SERVER],
    ["recycle whose open step failed", { result: "wa was closed, but its new session did not start", text: "wa was closed, but its new session did not start", isError: true }],
  ])("is not reported gone after a call to %s", async (name, fromCore) => {
    const pool = await dispatcher(["wa"]);
    await (await pool.worker(W1)).loads();
    pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "idle")]);
    await pool.looks();
    const call = await pool.mod.startsCall(tool(name.split(" ")[0]!), undefined, { name: "wa" }, fromCore);
    pool.mod.listing.text = "[]";
    await pool.looks();
    await call.returns();

    await pool.looks(3);

    expect(pool.mod.prompts).toEqual([]);
  });

  it.each<[string, (pool: Pool) => Promise<void>, number, string]>([
    ["waiting", async (pool) => void (await (await pool.worker(W1)).loads()), 2, "- wa: waiting for permission prompt."],
    ["unrecorded", () => Promise.resolve(), 3, "- wa: its session writes no activity record, so whether it makes progress is not known."],
  ])("starts the slot's run of looks %s anew once a call that acted on it has returned", async (state, record, due, line) => {
    const pool = await dispatcher(["wa"]);
    await record(pool);
    pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, state === "waiting" ? "waiting" : "idle", { waitingFor: "permission prompt" })]);
    await pool.looks(due - 1);
    await (await pool.mod.startsCall(tool("compact"), undefined, { name: "wa" })).returns();
    await pool.looks(due - 1);
    const after = pool.mod.prompts.length;
    await pool.looks();

    expect(after).toBe(0);
    expect(pool.mod.prompts).toEqual([report(line)]);
  });

  it.each([
    ["started before the look", true],
    ["started while the look waited for the listing", false],
  ])("is not reported gone after a call to close %s, which returned before the look judged the slot", async (_, startsBefore) => {
    const pool = await dispatcher(["wa"]);
    await (await pool.worker(W1)).loads();
    pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "idle")]);
    await pool.looks();
    const early = startsBefore ? await pool.mod.startsCall(tool("close"), undefined, { name: "wa" }) : undefined;
    pool.mod.listing.held = true;
    await pool.looks();
    const call = early ?? (await pool.mod.startsCall(tool("close"), undefined, { name: "wa" }));
    pool.mod.listing.text = "[]";
    await call.returns();
    pool.mod.listing.held = false;
    pool.mod.listing.release();
    await settle();

    await pool.looks(3);

    expect(pool.mod.prompts).toEqual([]);
  });

  it.each(CONDITIONS)("is not reported again as %s, while that lasts, once a call to %s that named it has run across a look and returned (claude-session-pool-monitor::US-001/AC-09)", async (_, name, condition, line) => {
    const pool = await dispatcher(["wa"]);
    await condition(pool);
    await pool.looks();
    const call = await pool.mod.startsCall(tool(name), undefined, actsOnWa(name), LEFT_AS_IT_IS);
    await pool.looks();
    await call.returns();

    await pool.looks(3);

    expect(pool.mod.prompts).toEqual([report(line)]);
  });

  it.each(CONDITIONS)("is not reported again as %s, while that lasts, once a call to %s that named it has run while its report waited to be taken (claude-session-pool-monitor::US-001/AC-09)", async (_, name, condition, line) => {
    const pool = await dispatcher(["wa"]);
    await condition(pool);
    pool.mod.promptAnswer.kind = "hold";
    await pool.looks();
    await (await pool.mod.startsCall(tool(name), undefined, actsOnWa(name), LEFT_AS_IT_IS)).returns();
    pool.mod.promptAnswer.kind = "take";
    await pool.mod.promptAnswer.takeHeld();

    await pool.looks(3);

    expect(pool.mod.prompts).toEqual([report(line)]);
  });

  it("is reported gone again once it has been live again, after a call that named it ran while its gone line waited to be taken (claude-session-pool-monitor::US-001/AC-02)", async () => {
    const GONE = "- wa: gone. No live session in the pool directory answers to this name any more.";
    const pool = await dispatcher(["wa"]);
    await (await pool.worker(W1)).loads();
    const live = () => void (pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "idle")]));
    const gone = () => void (pool.mod.listing.text = "[]");
    live();
    await pool.looks();
    gone();
    pool.mod.promptAnswer.kind = "hold";
    await pool.looks();
    await (await pool.mod.startsCall(tool("close"), undefined, { name: "wa" })).returns();
    pool.mod.promptAnswer.kind = "take";
    await pool.mod.promptAnswer.takeHeld();
    await pool.looks();
    live();
    await pool.looks();
    gone();

    await pool.looks(2);

    expect(pool.mod.prompts).toEqual([report(GONE), report(GONE)]);
  });
});

describe("a report of the pool monitor (claude-session-pool-plugin::REQ-005, claude-session-pool-monitor, \"The mod is loaded\")", () => {
  it("holds the lines due at one look, in the roster's order, and is made at the first look at which no turn runs", async () => {
    const pool = await dispatcher(["wa", "wb"]);
    await (await pool.worker(W1)).loads();
    await (await pool.worker(W2)).loads();
    pool.mod.listing.text = JSON.stringify([pool.entry(501, "wa", W1, "idle"), pool.entry(502, "wb", W2, "idle")]);
    await pool.looks();
    await pool.mod.turnStarts();
    pool.mod.listing.text = "[]";
    await pool.looks(3);
    const during = pool.mod.prompts.length;
    await pool.mod.turnEnds();
    await pool.looks();

    expect(during).toBe(0);
    expect(pool.mod.prompts).toEqual([
      report("- wa: gone. No live session in the pool directory answers to this name any more.", "- wb: gone. No live session in the pool directory answers to this name any more."),
    ]);
  });

  it("is made again at the next look when Claude Code drops it", async () => {
    const pool = await dispatcher(["wa"]);
    pool.mod.promptAnswer.kind = "drop";
    await pool.looks();
    pool.mod.promptAnswer.kind = "take";
    await pool.looks(3);

    const line = report("- No live session in the pool directory answers to these slots of the roster: wa.");
    expect(pool.mod.prompts).toEqual([line, line]);
  });

  it("is made again, after the mod is loaded again, of an ambiguous, a stalled and an unrecorded slot it reported before", async () => {
    const pool = await dispatcher(["wa", "wb", "wc"]);
    const wc = await pool.worker(W5A);
    await wc.loads(-30 * MINUTE);
    await wc.turnStarts(-20 * MINUTE);
    await wc.turnEnds(-13 * MINUTE);
    pool.mod.listing.text = JSON.stringify([
      pool.entry(501, "wa", W1, "idle"),
      pool.entry(502, "wa", W2, "idle"),
      pool.entry(503, "wb", W3, "idle"),
      pool.entry(504, "wc", W5A, "busy"),
    ]);
    await pool.looks(3);
    await pool.mod.reload();
    await pool.looks(3);

    const ambiguous = "- wa: ambiguous. 2 live sessions in the pool directory answer to this name.";
    const stalled = (minutes: number) => `- wc: busy, and it made no progress for ${minutes} minutes. No tool call of its own is running.`;
    const unrecorded = report("- wb: its session writes no activity record, so whether it makes progress is not known.");
    expect(pool.mod.prompts).toEqual([report(ambiguous, stalled(14)), unrecorded, report(ambiguous, stalled(17)), unrecorded]);
  });
});

describe("worker sessions are only read (claude-session-pool-monitor::CON-001, REQ-001/AC-01)", () => {
  it("over a run that meets every condition: runs the listing alone, reads only its state directory and its own transcript, writes only the look record and its own activity record, and only prompts its own session", async () => {
    const pool = await dispatcher(["wa", "wb", "wc", "wd", "we", "wf", "wg"]);
    // wg is gone at the first look, and the last look before the mod was loaded found work in its conversation.
    mkdirSync(join(pool.stateDirectory, "pool-states"), { recursive: true });
    const wgEntry = { name: "wg", sessionId: "6d4e3f2a-1b0c-4d9e-9f8a-7b6c5d4e3f2a", state: "busy", seenAt: "2026-11-22T02:00:00.000Z", worked: true };
    writeFileSync(pool.lookRecordPath, JSON.stringify({ version: 1, directory: pool.real, slots: [wgEntry] }));
    const [wa, wc, wd, we] = [await pool.worker(W1), await pool.worker(W3), await pool.worker(W5A), await pool.worker(W5B)];
    for (const each of [wa, wc, wd, we]) await each.loads(-30 * MINUTE);
    await we.turnStarts(-20 * MINUTE);
    await we.turnEnds(MINUTE);
    pool.transcript([titled, userRecord(pool.mod.time.now - 60 * MINUTE, "Run the pool."), received(506, pool.mod.time.now - 30 * MINUTE)]);
    const listing = (more: object[]) =>
      (pool.mod.listing.text = JSON.stringify([
        pool.entry(502, "wb", W2, "idle"),
        pool.entry(512, "wb", OTHER_SESSION, "idle"),
        pool.entry(503, "wc", W3, "waiting", { waitingFor: "permission prompt" }),
        pool.entry(504, "wd", W5A, "busy"),
        pool.entry(505, "we", W5B, "idle"),
        pool.entry(506, "wf", "5c3d2e1f-0a9b-4c8d-8e7f-6a5b4c3d2e1f", "idle"),
        ...more,
      ]));
    listing([pool.entry(501, "wa", W1, "idle")]);
    const writesBefore = pool.mod.writes.length;
    const readsBefore = pool.mod.reads.length;
    await pool.looks(3);
    listing([]);
    await pool.looks(10);
    pool.mod.listing.exitCode = 1;
    await pool.looks(10);
    await (await pool.mod.startsCall(tool("clear"), undefined, { name: "wb" })).returns();

    const lines = reportsOf(pool).flatMap((text) => text.split("\n").slice(1, -1));
    expect(lines).toEqual(
      expect.arrayContaining([
        "- No live session in the pool directory answers to these slots of the roster: wg. The restore tool brings back the unfinished conversations of: wg.",
        "- wb: ambiguous. 2 live sessions in the pool directory answer to this name.",
        "- wc: waiting for permission prompt.",
        "- wf: its session writes no activity record, so whether it makes progress is not known.",
        "- wa: gone. No live session in the pool directory answers to this name any more.",
        "- wd: busy, and it made no progress for 31 minutes. No tool call of its own is running.",
        "- we: idle for 5 minutes since its last turn ended, and it sent this session no message since 5 minutes before that.",
        "- The monitor could not see the pool for 10 minutes: the sessions on this Mac could not be listed.",
      ]),
    );
    expect(new Set(pool.mod.runs.map((argv) => argv.join(" ")))).toEqual(new Set(["claude agents --json"]));
    const transcriptPath = join(pool.mod.home, ".claude", "projects", "-somewhere", `${SESSION}.jsonl`);
    const read = pool.mod.reads.slice(readsBefore);
    expect(read).toContain(transcriptPath);
    expect(read.filter((path) => path !== transcriptPath && !path.startsWith(`${pool.stateDirectory}/`))).toEqual([]);
    // Of the worker sessions, the activity records of the session IDs the listing gives, and nothing else.
    const workerFiles = read.filter((path) => path.startsWith(join(pool.stateDirectory, "activity")) && path !== join(pool.stateDirectory, "activity", `${SESSION}.json`));
    expect(new Set(workerFiles)).toEqual(new Set([W1, W3, W5A, W5B, "5c3d2e1f-0a9b-4c8d-8e7f-6a5b4c3d2e1f"].map((id) => join(pool.stateDirectory, "activity", `${id}.json`))));
    expect(new Set(pool.mod.writes.slice(writesBefore))).toEqual(new Set([pool.lookRecordPath, join(pool.stateDirectory, "activity", `${SESSION}.json`)]));
    expect(pool.mod.engineCalls).not.toContain("command.run");
    expect(pool.mod.prompts).toEqual(reportsOf(pool));
  });
});
