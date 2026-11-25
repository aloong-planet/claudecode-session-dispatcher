/**
 * The activity record: the file the plugin's mod keeps of its session's activity (claude-session-pool-plugin::REQ-007/AC-02,
 * REQ-008, "State files"), in the fake engine of `support/mod-engine.ts`, which writes a file in place and makes its
 * directories as Claude Code 2.1.327 does; and the plugin's `SessionStart` hook, which deletes old records, as a real
 * process.
 *
 * Not covered here, because it needs a real Claude Code session: that Claude Code tells the mod of the session's turns and
 * tool calls as the fake does (a turn of the main conversation without `agentId`, a tool call when it starts and its
 * return when `next` resolves), and that `$.fs.write` writes under the home directory. These were measured by hand on
 * Claude Code 2.1.327 (the ticket's delivery note, with a live record) and are to be measured again when Claude Code
 * changes the events it tells a mod of.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AFTER_CLEAR, MEASURED, modSetup } from "./support/mod-engine.ts";
import { OTHER_SESSION, SESSION } from "./support/sessions.ts";
import { runHookProcess } from "./support/plugin-processes.ts";
import { cleanUpTemporaryDirectories, temporaryDirectory } from "./support/temporary.ts";

afterEach(cleanUpTemporaryDirectories);

/** The time the fake engine tells the mod at the start, 2026-11-22 03:00:00 UTC. */
const LOADED_AT = "2026-11-22T03:00:00.000Z";
type Mod = Awaited<ReturnType<typeof modSetup>>;
/** Sets the fake's clock to `seconds` after the time the mod was loaded at. */
const at = (mod: Mod, seconds: number) => void (mod.time.now = Date.parse(LOADED_AT) + seconds * 1000);
/** The ISO form of `seconds` after the time the mod was loaded at. */
const iso = (seconds: number) => new Date(Date.parse(LOADED_AT) + seconds * 1000).toISOString();
const SUBAGENT = "a8c24a82d67a3ee4c";
/** Claude Code gives the mod this token count of the session's context, or none. */
const tokens = (mod: Mod, count: number | undefined) =>
  void (mod.usage.answer = () => Promise.resolve({ ...MEASURED, context: count === undefined ? { window: 1_000_000 } : { ...MEASURED.context, tokens: count } }));

describe("the activity record", () => {
  it("stands once the session has started, written when the mod was loaded (claude-session-pool-plugin::REQ-008/AC-01)", async () => {
    const { activity } = await modSetup();

    expect(activity()).toEqual({ version: 1, sessionId: SESSION, writtenAt: LOADED_AT, turnRunning: false, worked: false, progressAt: LOADED_AT });
  });

  it("is written again at every look, with the time of that look (claude-session-pool-plugin::REQ-008/AC-01)", async () => {
    const mod = await modSetup();
    at(mod, 60);
    await mod.look();
    const first = mod.activity();
    at(mod, 120);
    await mod.look();

    expect([first, mod.activity()]).toEqual([
      { version: 1, sessionId: SESSION, writtenAt: iso(60), turnRunning: false, worked: false, progressAt: LOADED_AT },
      { version: 1, sessionId: SESSION, writtenAt: iso(120), turnRunning: false, worked: false, progressAt: LOADED_AT },
    ]);
  });

  it("is written for the new session ID once the ID has changed, as by /clear, and the old one is left as it was (claude-session-pool-plugin::REQ-008/AC-01)", async () => {
    const mod = await modSetup();
    mod.session.id = AFTER_CLEAR;
    at(mod, 60);

    await mod.look();

    expect(mod.activity(SESSION)).toEqual({ version: 1, sessionId: SESSION, writtenAt: LOADED_AT, turnRunning: false, worked: false, progressAt: LOADED_AT });
    expect(mod.activity(AFTER_CLEAR)).toEqual({ version: 1, sessionId: AFTER_CLEAR, writtenAt: iso(60), turnRunning: false, worked: false, progressAt: LOADED_AT });
  });

  it.each([
    { what: "the session is not interactive", options: { interactive: false } },
    { what: "the mod is not told that the session started", options: { told: false } },
  ])("is not written when $what (claude-session-pool-plugin::REQ-008/AC-01)", async ({ options }) => {
    const mod = await modSetup(options);

    await mod.turnStarts();
    await (await mod.startsCall("Bash")).returns();
    await mod.turnEnds();
    await mod.look(3);

    expect(existsSync(join(mod.home, ".claude-session-pool", "activity"))).toBe(false);
    expect(mod.writes).toEqual([]);
  });

  it.each([
    { what: "an underscore, which names no file", id: "c97a8f9a_26a0-473f-8829-eeb79f7298e0", files: 0 },
    { what: "a slash, which names no file", id: "../c97a8f9a-26a0-473f-8829-eeb79f7298e0", files: 0 },
    { what: "letters, digits and hyphens alone, which names its file", id: "C97A8F9A-26a0-473f-8829-eeb79f7298e0", files: 1 },
  ])("for a session ID with $what (claude-session-pool-plugin, \"State files\")", async ({ id, files }) => {
    const mod = await modSetup({ told: false });
    mod.session.id = id;

    await mod.reload();
    await mod.look(2);

    expect(mod.writes).toEqual(Array(files * 3).fill(join(mod.home, ".claude-session-pool", "activity", `${id}.json`)));
  });

  it("states the turn, the longest running tool call and the time of progress after each step of a turn (claude-session-pool-plugin::REQ-008/AC-02, \"State files\")", async () => {
    const mod = await modSetup();
    const records: unknown[] = [];
    const lookAt = async (seconds: number) => {
      at(mod, seconds);
      await mod.look();
      records.push(mod.activity());
    };

    at(mod, 10);
    await mod.turnStarts();
    await lookAt(15);
    at(mod, 20);
    const bash = await mod.startsCall("Bash");
    await lookAt(25);
    at(mod, 30);
    const read = await mod.startsCall("Read");
    await lookAt(35);
    at(mod, 40);
    await bash.returns();
    await lookAt(45);
    at(mod, 50);
    await read.returns();
    await lookAt(55);
    at(mod, 60);
    await mod.turnEnds();
    await lookAt(65);

    const record = { version: 1, sessionId: SESSION, worked: true };
    expect(records).toEqual([
      { ...record, writtenAt: iso(15), turnRunning: true, progressAt: iso(10) },
      { ...record, writtenAt: iso(25), turnRunning: true, progressAt: iso(20), toolCall: { tool: "Bash", startedAt: iso(20) } },
      { ...record, writtenAt: iso(35), turnRunning: true, progressAt: iso(30), toolCall: { tool: "Bash", startedAt: iso(20) } },
      { ...record, writtenAt: iso(45), turnRunning: true, progressAt: iso(40), toolCall: { tool: "Read", startedAt: iso(30) } },
      { ...record, writtenAt: iso(55), turnRunning: true, progressAt: iso(50) },
      { ...record, writtenAt: iso(65), turnRunning: false, progressAt: iso(60), lastTurnEndedAt: iso(60) },
    ]);
  });

  it("states for the conversation after a /clear only the turns of that conversation (claude-session-pool-plugin::REQ-008/AC-02)", async () => {
    const mod = await modSetup();
    at(mod, 10);
    await mod.turnStarts();
    at(mod, 20);
    await mod.turnEnds();
    at(mod, 25);
    await mod.look();
    const before = mod.activity(SESSION);

    mod.session.id = AFTER_CLEAR;
    at(mod, 35);
    await mod.look();
    const cleared = mod.activity(AFTER_CLEAR);
    at(mod, 40);
    await mod.turnStarts();
    at(mod, 45);
    await mod.look();
    const working = mod.activity(AFTER_CLEAR);
    at(mod, 50);
    await mod.turnEnds();
    at(mod, 55);
    await mod.look();

    const record = { version: 1, sessionId: AFTER_CLEAR };
    expect([cleared, working, mod.activity(AFTER_CLEAR)]).toEqual([
      { ...record, writtenAt: iso(35), turnRunning: false, worked: false, progressAt: iso(20) },
      { ...record, writtenAt: iso(45), turnRunning: true, worked: true, progressAt: iso(40) },
      { ...record, writtenAt: iso(55), turnRunning: false, worked: true, progressAt: iso(50), lastTurnEndedAt: iso(50) },
    ]);
    expect(mod.activity(SESSION)).toEqual(before);
    expect(before).toEqual({ version: 1, sessionId: SESSION, writtenAt: iso(25), turnRunning: false, worked: true, progressAt: iso(20), lastTurnEndedAt: iso(20) });
  });
});

describe("progress in the session", () => {
  type Step = (mod: Mod, earlier: unknown) => Promise<unknown> | void;
  it.each<{ what: string; earlier?: Step; move: Step; progressAt: string }>([
    { what: "a turn of the main conversation starts", move: (mod) => mod.turnStarts(), progressAt: iso(30) },
    { what: "a turn of the main conversation ends", earlier: (mod) => mod.turnStarts(), move: (mod) => mod.turnEnds(), progressAt: iso(30) },
    { what: "a tool call of the main conversation starts", move: (mod) => mod.startsCall("Bash"), progressAt: iso(30) },
    {
      what: "a tool call of the main conversation returns",
      earlier: (mod) => mod.startsCall("Bash"),
      move: (_mod, call) => (call as { returns: () => Promise<unknown> }).returns(),
      progressAt: iso(30),
    },
    { what: "a look finds a token count of the context that differs from the one the look before found", move: (mod) => tokens(mod, 61_101), progressAt: iso(40) },
    { what: "a look finds progress in a subagent", move: (mod) => void (mod.agents.listed[0]!.tokenCount += 1_000), progressAt: iso(40) },
    { what: "a look finds nothing new, nor did the first look, which found the token count and the subagent", move: () => {}, progressAt: LOADED_AT },
    { what: "a look finds no token count", move: (mod) => tokens(mod, undefined), progressAt: LOADED_AT },
    { what: "a tool call of a subagent starts and returns", move: async (mod) => (await mod.startsCall("Bash", SUBAGENT)).returns(), progressAt: LOADED_AT },
    {
      what: "a turn of a subagent starts and ends",
      move: async (mod) => {
        await mod.turnStarts(SUBAGENT);
        await mod.turnEnds("answer", SUBAGENT);
      },
      progressAt: LOADED_AT,
    },
    { what: "a look first finds a subagent", move: (mod) => void mod.startSubagent("a41633a00e77a2aa3"), progressAt: LOADED_AT },
  ])("is found when $what, at that time, and nothing else moves it (claude-session-pool-plugin::REQ-007/AC-02)", async ({ earlier, move, progressAt }) => {
    const mod = await modSetup();
    mod.startSubagent(SUBAGENT);
    at(mod, 10);
    await mod.look();
    at(mod, 20);
    const made = await earlier?.(mod, undefined);

    at(mod, 30);
    await move(mod, made);
    at(mod, 40);
    await mod.look();

    expect(mod.activity()).toMatchObject({ progressAt });
  });
});

describe("a turn that has started in the conversation", () => {
  const recordPath = (mod: Mod) => join(mod.home, ".claude-session-pool", "activity", `${SESSION}.json`);
  /** Replaces the standing record with what the mod wrote, changed by `change`. */
  const rewritten = (change: (record: Record<string, unknown>) => unknown) => (mod: Mod) =>
    writeFileSync(recordPath(mod), JSON.stringify(change({ ...(mod.activity() as Record<string, unknown>) })));
  it.each([
    { what: "the standing record of the session ID says so", standing: () => {}, worked: true },
    { what: "the standing record of the session ID says none has", standing: rewritten((record) => ({ ...record, worked: false })), worked: false },
    { what: "the standing record is of another session ID", standing: rewritten((record) => ({ ...record, sessionId: OTHER_SESSION })), worked: false },
    { what: "the standing record is not in the stated form", standing: rewritten((record) => ({ ...record, version: 2 })), worked: false },
    { what: "the standing record is not JSON", standing: (mod: Mod) => writeFileSync(recordPath(mod), '{"version":1,"sessionId":"c97a8f9a'), worked: false },
    { what: "no record stands", standing: (mod: Mod) => rmSync(recordPath(mod)), worked: false },
  ])("is kept when the mod is loaded again where $what (claude-session-pool-plugin::REQ-008/AC-03)", async ({ standing, worked }) => {
    const mod = await modSetup();
    await mod.turnStarts();
    await mod.turnEnds();
    await mod.look();
    standing(mod);

    await mod.reload();

    expect(mod.activity()).toMatchObject({ sessionId: SESSION, worked });
  });
});

describe("the hook on SessionStart, as the plugin declares it", () => {
  it("deletes the activity records written more than 24 hours before and leaves the rest and the other state directories alone (claude-session-pool-plugin::REQ-008/AC-04)", () => {
    const home = temporaryDirectory();
    const root = join(home, ".claude-session-pool");
    const hoursAgo = (hours: number) => new Date(Date.now() - hours * 60 * 60 * 1000);
    /** Writes `name` under `directory` of the state directory, last modified `hours` before now. */
    const written = (directory: string, name: string, hours: number) => {
      mkdirSync(join(root, directory), { recursive: true });
      writeFileSync(join(root, directory, name), "{}");
      utimesSync(join(root, directory, name), hoursAgo(hours), hoursAgo(hours));
    };
    written("activity", `${SESSION}.json`, 25);
    written("activity", `${OTHER_SESSION}.json`, 23);
    for (const directory of ["hooks", "wake-requests", "clear-orders", "pools"]) written(directory, `${SESSION}.json`, 25);

    const ran = runHookProcess("SessionStart", { session_id: AFTER_CLEAR, source: "startup" }, home);

    expect(ran).toEqual({ status: 0, stdout: "", stderr: "" });
    expect(readdirSync(join(root, "activity"))).toEqual([`${OTHER_SESSION}.json`]);
    for (const directory of ["wake-requests", "clear-orders", "pools"]) expect(readdirSync(join(root, directory))).toEqual([`${SESSION}.json`]);
    expect(readdirSync(join(root, "hooks")).sort()).toEqual([`${SESSION}.json`, `${process.pid}.json`].sort());
  });
});
