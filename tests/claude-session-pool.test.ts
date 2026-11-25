/**
 * The pool's operations, through its public methods.
 *
 * Claude Code's session listing, the Terminal application and process signals are replaced by `FakeMac`; rosters
 * and transcripts are real files in a temporary directory; time is the fake's virtual clock.
 *
 * The plugin's hooks and mod are stood in for by the fake: it runs the real hook program, which writes the hook records,
 * and it models what Claude Code and the mod do about a clear order (see `modWatches` in `support/fake-mac.ts`). The real
 * mod's part of `clear` is covered at the end of this file, where it is handed a fake engine.
 *
 * Not covered here, because it needs the real programs: what `/clear` and `/compact` do inside Claude Code, that
 * Ctrl+C empties its input box, that Terminal puts the earlier window back in front, and that Claude Code's file watch
 * tells the mod of a clear order, which the mod then runs. The Terminal part is covered by `claude-session-pool.live.test.ts` when it
 * is enabled; the Claude Code part was checked by hand with real sessions on Claude Code 2.1.327, also with the screen
 * locked for up to five minutes (a longer lock was not checked). The Claude Code part is to be checked again when Claude
 * Code changes its interface for mods.
 *
 * Two boundaries of the spec cannot be driven at all. A message that reaches a slot between the idle check and the
 * typing: the server does not detect it, so there is nothing to assert. The dispatcher session ending while a
 * `compact` call waits: the wait dies with the server process. Driving either needs a real session and a real race.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileTranscripts } from "../src/adapters/transcripts.ts";
import { runHook } from "../src/hooks.ts";
import { Pool } from "../src/pool.ts";
import { RosterStore } from "../src/roster.ts";
import { WakeState } from "../src/wake.ts";
import { FakeMac } from "./support/fake-mac.ts";
import { AFTER_CLEAR, modSetup, settle } from "./support/mod-engine.ts";
import { OTHER_SESSION, SESSION } from "./support/sessions.ts";
import { cleanUpTemporaryDirectories, temporaryDirectory } from "./support/temporary.ts";

const DISPATCHER_PID = 4242;
const fakes: FakeMac[] = [];

afterEach(() => {
  for (const fake of fakes.splice(0)) fake.stop();
});
afterEach(cleanUpTemporaryDirectories);

/** What of the plugin runs in the worker sessions: nothing, its hooks alone, or its hooks and its mod. */
type Plugin = "absent" | "hooks only" | "hooks and mod";

function setup(options: { plugin?: Plugin } = {}) {
  const home = temporaryDirectory();
  const directory = join(home, "project");
  const elsewhere = join(home, "elsewhere");
  const rosterRoot = join(home, "rosters");
  const transcriptRoot = join(home, "transcripts");
  const stateRoot = join(home, "state");
  for (const path of [directory, elsewhere, transcriptRoot]) mkdirSync(path);
  const mac = new FakeMac();
  fakes.push(mac);
  mac.transcriptRoot = transcriptRoot;
  const wake = new WakeState(stateRoot);
  const plugin = options.plugin ?? "absent";
  if (plugin !== "absent") mac.hooks = (input, sessionPid) => runHook(input, { state: wake, sessionPid, isAlive: (pid) => mac.processes.isAlive(pid), now: Date.now });
  const ordersDirectory = join(stateRoot, "clear-orders");
  if (plugin !== "absent") mac.modWatches = ordersDirectory;
  mac.modRuns = plugin === "hooks and mod";
  /** The names of the clear orders that stand on disk. */
  const standingOrders = () => (existsSync(ordersDirectory) ? readdirSync(ordersDirectory).sort() : []);
  const poolIn = (poolDirectory: string) =>
    new Pool({
      directory: poolDirectory,
      dispatcherPid: DISPATCHER_PID,
      rosterRoot,
      sessions: mac.lister,
      terminal: mac.terminal,
      processes: mac.processes,
      transcripts: new FileTranscripts(transcriptRoot),
      clock: mac.clock,
      wake,
    });
  return { mac, pool: poolIn(directory), poolIn, directory, elsewhere, rosterRoot, home, standingOrders, ordersDirectory, stateRoot };
}

const NO_SLOTS = "The roster has no slots.";

describe("open", () => {
  it("opens a worker session in the pool directory, waits until it is idle and registers the slot", async () => {
    const { mac, pool, directory } = setup();

    const outcome = await pool.open({ name: "w1" });

    const session = mac.session("w1");
    expect(outcome).toEqual({ ok: true, text: `Opened "w1": idle, session ${session.sessionId}.` });
    expect(session.cwd).toBe(directory);
    expect(mac.now).toBeGreaterThanOrEqual(4000);
    expect((await pool.status()).text).toBe(`w1: idle, session ${session.sessionId}`);
  });

  it("starts the session with the model opus in auto mode unless other values are given", async () => {
    const { mac, pool } = setup();

    await pool.open({ name: "w1" });
    await pool.open({ name: "w2", model: "sonnet", permissionMode: "plan" });

    expect([mac.session("w1").model, mac.session("w1").permissionMode]).toEqual(["opus", "auto"]);
    expect([mac.session("w2").model, mac.session("w2").permissionMode]).toEqual(["sonnet", "plan"]);
  });

  it("refuses a name that a live session in another directory already answers to", async () => {
    const { mac, pool, elsewhere } = setup();
    mac.addSession({ name: "w1", cwd: elsewhere });

    const outcome = await pool.open({ name: "w1" });

    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain('already answers to "w1"');
    expect(mac.launches).toEqual([]);
    expect((await pool.status()).text).toBe(NO_SLOTS);
  });

  it("reports what the window shows when the new session is not idle after 60 seconds, and registers nothing", async () => {
    const { mac, pool } = setup();
    mac.startupMs = undefined;

    const outcome = await pool.open({ name: "w1" });

    expect(outcome.ok).toBe(false);
    expect(mac.now).toBe(60_000);
    expect(outcome.text).toContain("> Do you trust the files in this folder?");
    expect(mac.openWindowIds()).toHaveLength(1);
    expect((await pool.status()).text).toBe(NO_SLOTS);
  });

  it("brings a gone slot back to life", async () => {
    const { mac, pool } = setup();
    await pool.open({ name: "w1" });
    mac.endSession(mac.session("w1").pid!);
    expect((await pool.status()).text).toBe("w1: gone");

    const outcome = await pool.open({ name: "w1" });

    expect(outcome.ok).toBe(true);
    expect((await pool.status()).text).toBe(`w1: idle, session ${mac.session("w1").sessionId}`);
  });

  it("keeps a gone slot in the roster and records its new session when that session is not idle in time", async () => {
    const { mac, pool } = setup();
    await pool.open({ name: "w1" });
    mac.windowOf(mac.session("w1")).open = false;
    mac.endSession(mac.session("w1").pid!);
    mac.startupMs = undefined;

    const outcome = await pool.open({ name: "w1" });

    const stuck = mac.session("w1");
    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain('its session was not idle after 60 seconds. Its window was left open. "w1" stays in the roster.');
    expect(outcome.text).not.toContain("was not added to the roster");
    expect((await pool.status()).text).toBe(`w1: busy, session ${stuck.sessionId}`);

    await pool.close({ name: "w1", force: true });

    expect(mac.terminated).toEqual([stuck.pid]);
    expect(mac.closedWindows).toEqual([mac.windowOf(stuck).id]);
  });

  it("still says that a window was opened when the window's contents cannot be read", async () => {
    const { mac, pool } = setup();
    mac.startupMs = undefined;
    mac.contentsFailure = "Terminal got an error: Can’t get window id 100. (-1728)";

    const outcome = await pool.open({ name: "w1" });

    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain('A window was opened for "w1", but its session was not idle after 60 seconds.');
    expect(outcome.text).toContain("> (the window's contents could not be read: Terminal got an error: Can’t get window id 100. (-1728))");
  });

  it("says that a window was opened when the roster cannot be written afterwards", async () => {
    const { mac, pool, rosterRoot } = setup();
    const pools = join(rosterRoot, "pools");
    mkdirSync(pools, { recursive: true });
    mac.at(1000, () => chmodSync(pools, 0o555));
    try {
      const outcome = await pool.open({ name: "w1" });

      expect(outcome.ok).toBe(false);
      expect(outcome.text).toMatch(/^A window was opened for "w1", but the roster could not be updated: EACCES/);
      expect(mac.openWindowIds()).toHaveLength(1);
    } finally {
      chmodSync(pools, 0o755);
    }
  });

  it("returns Terminal's own error and registers nothing when Terminal cannot be scripted", async () => {
    const { mac, pool } = setup();
    mac.terminalFailure = "Not authorized to send Apple events to Terminal. (-1743)";

    const outcome = await pool.open({ name: "w1" });

    expect(outcome).toEqual({ ok: false, text: "Not authorized to send Apple events to Terminal. (-1743)" });
    expect((await pool.status()).text).toBe(NO_SLOTS);
  });

  it("opens one window when two opens of the same name arrive together, and refuses the other call", async () => {
    const { mac, pool } = setup();

    const outcomes = await Promise.all([pool.open({ name: "w1" }), pool.open({ name: "w1" })]);

    expect(outcomes.map((outcome) => outcome.ok).sort()).toEqual([false, true]);
    expect(outcomes.find((outcome) => !outcome.ok)!.text).toBe('Another call is already opening "w1"; nothing was opened.');
    expect(mac.launches).toHaveLength(1);
    expect((await pool.status()).text).toBe(`w1: idle, session ${mac.session("w1").sessionId}`);
  });

  it("says that a window was opened when the sessions cannot be listed afterwards", async () => {
    const { mac, pool } = setup();
    mac.at(1000, () => {
      mac.listingFailure = "`claude agents --json` did not print JSON";
    });

    const outcome = await pool.open({ name: "w1" });

    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain('A window was opened for "w1", but its session was not idle after 60 seconds.');
    expect(outcome.text).toContain("The sessions could not be listed: `claude agents --json` did not print JSON");
    expect(mac.now).toBe(60_000);
  });

  it("keeps both slots when two opens run at the same time", async () => {
    const { mac, pool } = setup();

    const outcomes = await Promise.all([pool.open({ name: "w1" }), pool.open({ name: "w2" })]);

    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true]);
    expect((await pool.status()).text).toBe(
      `w1: idle, session ${mac.session("w1").sessionId}\nw2: idle, session ${mac.session("w2").sessionId}`,
    );
  });
});

describe("init", () => {
  it("opens every name in turn, continues past one that fails and reports each outcome", async () => {
    const { mac, pool, elsewhere } = setup();
    mac.addSession({ name: "taken", cwd: elsewhere });

    const outcome = await pool.init({ names: ["w1", "taken", "w3"], model: "sonnet", permissionMode: "plan" });

    expect(outcome.ok).toBe(false);
    expect(outcome.text.split("\n").map((line) => line.split(".")[0])).toEqual(["w1: opened", "taken: failed", "w3: opened"]);
    expect([mac.session("w3").model, mac.session("w3").permissionMode]).toEqual(["sonnet", "plan"]);
    expect((await pool.status()).text).toBe(
      `w1: idle, session ${mac.session("w1").sessionId}\nw3: idle, session ${mac.session("w3").sessionId}`,
    );
  });
});

describe("argument validation", () => {
  it.each(["", "two words", "-leading-dash", "semi;colon", "quote'", "x".repeat(65)])(
    "refuses the slot name %j before anything is run",
    async (name) => {
      const { mac, pool } = setup();

      const outcomes = [
        await pool.open({ name }),
        await pool.init({ names: [name] }),
        await pool.adopt({ name }),
        await pool.clear({ name }),
        await pool.compact({ name }),
        await pool.close({ name }),
        await pool.recycle({ name }),
        await pool.release({ name }),
      ];

      expect(outcomes.map((outcome) => outcome.ok)).toEqual(outcomes.map(() => false));
      expect(outcomes[0]!.text).toContain("is not a valid slot name");
      expect([mac.launches, mac.typed, mac.terminated]).toEqual([[], [], []]);
    },
  );

  it.each([
    { model: "opus; rm -rf ~", complaint: "is not a valid model" },
    { model: "", complaint: "is not a valid model" },
    { permissionMode: "bypassPermissions", complaint: "is not an allowed permission mode" },
    { permissionMode: "yolo", complaint: "is not an allowed permission mode" },
  ])("refuses $model$permissionMode before anything is run", async ({ complaint, ...argument }) => {
    const { mac, pool } = setup();
    await pool.open({ name: "w1" });
    const launchesBefore = mac.launches.length;

    const opened = await pool.open({ name: "w2", ...argument });
    const recycled = await pool.recycle({ name: "w1", ...argument });

    expect([opened.ok, recycled.ok]).toEqual([false, false]);
    expect(opened.text).toContain(complaint);
    expect(recycled.text).toContain(complaint);
    expect(mac.launches).toHaveLength(launchesBefore);
    expect(mac.terminated).toEqual([]);
  });

  it("accepts a 64-character name and a model alias with brackets", async () => {
    const { mac, pool } = setup();
    const name = `w${"1".repeat(63)}`;

    const outcome = await pool.open({ name, model: "opus[1m]" });

    expect(outcome.ok).toBe(true);
    expect(mac.session(name).model).toBe("opus[1m]");
  });
});

describe("adopt", () => {
  it("registers a session the owner opened and leaves the session untouched", async () => {
    const { mac, pool, directory } = setup();
    const session = mac.addSession({ name: "w1", cwd: directory });
    const sessionIdBefore = session.sessionId;

    const outcome = await pool.adopt({ name: "w1" });

    expect(outcome).toEqual({ ok: true, text: `Adopted "w1": idle, session ${sessionIdBefore}.` });
    expect((await pool.status()).text).toBe(`w1: idle, session ${sessionIdBefore}`);
    expect([mac.typed, mac.terminated, mac.launches]).toEqual([[], [], []]);
  });

  it.each([
    { reason: "no session answers to the name", arrange: () => undefined, complaint: "No live interactive session" },
    {
      reason: "the session runs in another directory",
      arrange: ({ mac, elsewhere }: ReturnType<typeof setup>) => mac.addSession({ name: "w1", cwd: elsewhere }),
      complaint: "not in this pool's directory",
    },
    {
      reason: "two sessions in the pool directory answer to it",
      arrange: ({ mac, directory }: ReturnType<typeof setup>) => {
        mac.addSession({ name: "w1", cwd: directory });
        mac.addSession({ name: "w1", cwd: directory });
      },
      complaint: "2 sessions",
    },
    {
      reason: "it is the dispatcher session",
      arrange: ({ mac, directory }: ReturnType<typeof setup>) => mac.addSession({ name: "w1", cwd: directory, pid: DISPATCHER_PID }),
      complaint: "dispatcher session itself",
    },
    {
      reason: "it does not run in a Terminal window",
      arrange: ({ mac, directory }: ReturnType<typeof setup>) => mac.addSession({ name: "w1", cwd: directory, tty: "/dev/ttys999" }),
      complaint: "does not run in a Terminal window",
    },
  ])("refuses when $reason", async ({ arrange, complaint }) => {
    const context = setup();
    arrange(context);

    const outcome = await context.pool.adopt({ name: "w1" });

    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain(complaint);
    expect((await context.pool.status()).text).toBe(NO_SLOTS);
  });

  it("registers the slot once when two adopts of the same name arrive together", async () => {
    const { mac, pool, directory } = setup();
    const session = mac.addSession({ name: "w1", cwd: directory });

    const outcomes = await Promise.all([pool.adopt({ name: "w1" }), pool.adopt({ name: "w1" })]);

    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true]);
    expect((await pool.status()).text).toBe(`w1: idle, session ${session.sessionId}`);
  });

  it("recognises a session whose directory is spelled through a symbolic link", async () => {
    const { mac, pool, directory, home } = setup();
    const link = join(home, "link-to-project");
    symlinkSync(directory, link);
    mac.addSession({ name: "w1", cwd: link });

    expect((await pool.adopt({ name: "w1" })).ok).toBe(true);
  });

  it("succeeds without changing anything when the name is already a slot", async () => {
    const { mac, pool, directory } = setup();
    const session = mac.addSession({ name: "w1", cwd: directory });
    await pool.adopt({ name: "w1" });

    const outcome = await pool.adopt({ name: "w1" });

    expect(outcome).toEqual({ ok: true, text: '"w1" is already a slot; nothing changed.' });
    expect((await pool.status()).text).toBe(`w1: idle, session ${session.sessionId}`);
  });
});

describe("status", () => {
  it("lists every slot with its state, its session ID and what a waiting session waits for", async () => {
    const { mac, pool, directory } = setup();
    const idle = mac.addSession({ name: "w1", cwd: directory });
    const busy = mac.addSession({ name: "w2", cwd: directory, status: "busy" });
    const waiting = mac.addSession({ name: "w3", cwd: directory, status: "waiting", waitingFor: "permission prompt" });
    for (const name of ["w1", "w2", "w3"]) await pool.adopt({ name });

    const outcome = await pool.status();

    expect(outcome.text).toBe(
      [
        `w1: idle, session ${idle.sessionId}`,
        `w2: busy, session ${busy.sessionId}`,
        `w3: waiting for permission prompt, session ${waiting.sessionId}`,
      ].join("\n"),
    );
  });

  it("lists a slot whose session has ended as gone and keeps it in the roster", async () => {
    const { mac, pool, directory } = setup();
    const session = mac.addSession({ name: "w1", cwd: directory });
    await pool.adopt({ name: "w1" });
    mac.endSession(session.pid!);

    expect((await pool.status()).text).toBe("w1: gone");
    expect((await pool.status()).text).toBe("w1: gone");
  });

  it("does not take a session in another directory, or a background session, for a gone slot's session", async () => {
    const { mac, pool, directory, elsewhere } = setup();
    const session = mac.addSession({ name: "w1", cwd: directory });
    await pool.adopt({ name: "w1" });
    mac.endSession(session.pid!);
    mac.addSession({ name: "w1", cwd: elsewhere });
    mac.addSession({ name: "w1", cwd: directory, kind: "background" });

    expect((await pool.status()).text).toBe("w1: gone");
    expect((await pool.clear({ name: "w1" })).text).toBe('The slot "w1" is gone; nothing was typed or written.');
    expect(mac.typed).toEqual([]);
  });

  it("lists a slot that two sessions in the pool directory answer to as ambiguous", async () => {
    const { mac, pool, directory } = setup();
    mac.addSession({ name: "w1", cwd: directory });
    await pool.adopt({ name: "w1" });
    mac.addSession({ name: "w1", cwd: directory });

    expect((await pool.status()).text).toBe("w1: ambiguous, 2 sessions answer to this name");
  });
});

describe("clear, in a session in which the plugin's mod runs", () => {
  it("writes a clear order instead of typing, and returns once the session ID has changed", async () => {
    const { mac, pool, standingOrders } = setup({ plugin: "hooks and mod" });
    await pool.open({ name: "w1" });
    const { sessionId: oldId, pid } = mac.session("w1");
    const window = mac.windowOf(mac.session("w1"));
    const start = mac.now;

    const outcome = await pool.clear({ name: "w1" });

    const newId = mac.session("w1").sessionId;
    expect(newId).not.toBe(oldId);
    expect(outcome).toEqual({ ok: true, text: `Cleared "w1": session ${oldId} was replaced by session ${newId}. Delivered as a clear order; nothing was typed.` });
    expect(mac.typed).toEqual([]);
    expect(mac.ordersSeen).toEqual([
      { at: start, file: `${oldId}.json`, content: { version: 1, sessionId: oldId, requestedAt: new Date(start).toISOString() } },
    ]);
    expect(standingOrders()).toEqual([]);
    expect(mac.session("w1").pid).toBe(pid);
    expect(window.open).toBe(true);
  });

  it("types the command when the hook record names the session's previous session ID", async () => {
    const { mac, pool } = setup({ plugin: "hooks and mod" });
    await pool.open({ name: "w1" });
    // The session got a new session ID, and the plugin's hook has not yet written it into the hook record.
    mac.session("w1").sessionId = "00000000-0000-4000-8000-0000000000aa";

    const outcome = await pool.clear({ name: "w1" });

    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain('Delivered by typing "/clear"');
    expect(mac.typed.map((entry) => entry.command)).toEqual(["/clear"]);
    expect(mac.ordersSeen).toEqual([]);
  });

  it("waits for a busy slot to become idle before it writes the order", async () => {
    const { mac, pool } = setup({ plugin: "hooks and mod" });
    await pool.open({ name: "w1" });
    const session = mac.session("w1");
    session.status = "busy";
    const start = mac.now;
    mac.at(20_000, () => {
      session.status = "idle";
    });

    const outcome = await pool.clear({ name: "w1" });

    expect(outcome.ok).toBe(true);
    expect(mac.ordersSeen.map((order) => order.at - start)).toEqual([20_000]);
    expect(mac.typed).toEqual([]);
  });

  it.each([
    { status: "busy", waitingFor: undefined, described: "is busy" },
    { status: "waiting", waitingFor: "input needed", described: "is waiting for input needed" },
  ])("refuses and writes nothing when the slot $described for 60 seconds", async ({ status, waitingFor, described }) => {
    const { mac, pool, standingOrders } = setup({ plugin: "hooks and mod" });
    await pool.open({ name: "w1" });
    Object.assign(mac.session("w1"), { status, waitingFor });
    const start = mac.now;

    const outcome = await pool.clear({ name: "w1" });

    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain(`The slot "w1" ${described}`);
    expect(outcome.text).toContain("nothing was typed or written");
    expect(mac.now - start).toBe(60_000);
    expect([mac.ordersSeen, mac.typed, standingOrders()]).toEqual([[], [], []]);
  });

  it("refuses and writes nothing when the slot is gone or ambiguous", async () => {
    const { mac, pool, directory, standingOrders } = setup({ plugin: "hooks and mod" });
    for (const name of ["gone", "twice"]) {
      mac.addSession({ name, cwd: directory });
      await pool.adopt({ name });
    }
    mac.endSession(mac.session("gone").pid!);
    mac.addSession({ name: "twice", cwd: directory });

    const outcomes = await Promise.all(["gone", "twice"].map((name) => pool.clear({ name })));

    expect(outcomes.map((outcome) => outcome.text)).toEqual([
      'The slot "gone" is gone; nothing was typed or written.',
      'The slot "twice" is ambiguous, 2 sessions answer to this name; nothing was typed or written.',
    ]);
    expect([mac.ordersSeen, mac.typed, standingOrders()]).toEqual([[], [], []]);
  });

  it("writes each slot's order for its own session ID when two calls arrive together", async () => {
    const { mac, pool, standingOrders } = setup({ plugin: "hooks and mod" });
    await pool.open({ name: "w1" });
    await pool.open({ name: "w2" });
    const oldIds = [mac.session("w1").sessionId, mac.session("w2").sessionId];

    const outcomes = await Promise.all([pool.clear({ name: "w1" }), pool.clear({ name: "w2" })]);

    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true]);
    expect(mac.ordersSeen.map((order) => order.file).sort()).toEqual(oldIds.map((id) => `${id}.json`).sort());
    expect([mac.session("w1").sessionId, mac.session("w2").sessionId]).not.toContainEqual(oldIds[0]);
    expect(standingOrders()).toEqual([]);
  });

  it("writes no order for a session ID that could name a file elsewhere", async () => {
    const { mac, pool, directory, stateRoot, standingOrders } = setup({ plugin: "hooks and mod" });
    mac.addSession({ name: "w1", cwd: directory, sessionId: "../escaped" });
    await pool.adopt({ name: "w1" });

    const outcome = await pool.clear({ name: "w1" });

    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("is not a session ID, so no clear order was written for it");
    expect([existsSync(join(stateRoot, "escaped.json")), standingOrders(), mac.typed]).toEqual([false, [], []]);
  });

  it.each([
    { what: "Terminal cannot be scripted", spoil: (mac: FakeMac) => void (mac.terminalFailure = "Not authorized to send Apple events to Terminal. (-1743)") },
    { what: "no Terminal tab hosts the slot", spoil: (mac: FakeMac) => void (mac.windowOf(mac.session("w1")).open = false) },
  ])("delivers the order, which does not script Terminal, when $what", async ({ spoil }) => {
    const { mac, pool, standingOrders } = setup({ plugin: "hooks and mod" });
    await pool.open({ name: "w1" });
    const oldId = mac.session("w1").sessionId;
    spoil(mac);

    const outcome = await pool.clear({ name: "w1" });

    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain("Delivered as a clear order; nothing was typed.");
    expect(mac.session("w1").sessionId).not.toBe(oldId);
    expect([mac.typed, standingOrders()]).toEqual([[], []]);
  });
});

describe("clear, when the plugin's hooks run in the session and its mod does not", () => {
  it("reports the order as written and not confirmed 30 seconds after it was written, removes it and types nothing", async () => {
    const { mac, pool, standingOrders } = setup({ plugin: "hooks only" });
    await pool.open({ name: "w1" });
    const oldId = mac.session("w1").sessionId;
    const start = mac.now;

    const outcome = await pool.clear({ name: "w1" });

    expect(outcome).toEqual({
      ok: false,
      text: `A clear order was written for the slot "w1", but its session ID was still ${oldId} after 30 seconds: not confirmed. The order was removed. Nothing was typed.`,
    });
    expect(mac.now - start).toBe(30_000);
    expect(mac.ordersSeen.map((order) => order.at)).toEqual([start]);
    expect([mac.typed, standingOrders()]).toEqual([[], []]);
  });

  it("says that the order could not be removed when it could not", async () => {
    const { mac, pool, ordersDirectory } = setup({ plugin: "hooks only" });
    await pool.open({ name: "w1" });
    mac.at(500, () => chmodSync(ordersDirectory, 0o555));

    try {
      const outcome = await pool.clear({ name: "w1" });

      expect(outcome.ok).toBe(false);
      expect(outcome.text).toMatch(/not confirmed\. The order could not be removed \(.+\); it applies to no session 60 seconds after it was written\. Nothing was typed\.$/);
    } finally {
      chmodSync(ordersDirectory, 0o755);
    }
  });

  it("returns at once when the slot's session disappears after the order was written", async () => {
    const { mac, pool, standingOrders } = setup({ plugin: "hooks only" });
    await pool.open({ name: "w1" });
    const pid = mac.session("w1").pid!;
    const start = mac.now;
    mac.at(500, () => mac.endSession(pid));

    const outcome = await pool.clear({ name: "w1" });

    expect(outcome).toEqual({ ok: false, text: 'A clear order was written for the slot "w1", and the slot is now gone: not confirmed.' });
    expect(mac.now - start).toBe(1000);
    expect(standingOrders()).toEqual([]);
  });

  it("says that the order was written when the sessions cannot be listed until the limit", async () => {
    const { mac, pool, standingOrders } = setup({ plugin: "hooks only" });
    await pool.open({ name: "w1" });
    const start = mac.now;
    mac.at(500, () => {
      mac.listingFailure = "claude: command not found";
    });

    const outcome = await pool.clear({ name: "w1" });

    expect(outcome.ok).toBe(false);
    expect(outcome.text).toBe(
      'A clear order was written for the slot "w1", but the sessions could not be listed (claude: command not found) after 30 seconds: not confirmed. The order was removed. Nothing was typed.',
    );
    expect(mac.now - start).toBe(30_000);
    expect(standingOrders()).toEqual([]);
  });
});

describe("clear, when a turn starts after the order was written", () => {
  it("does not interrupt the turn, and the mod clears the session when the turn ends", async () => {
    const { mac, pool } = setup({ plugin: "hooks and mod" });
    await pool.open({ name: "w1" });
    const session = mac.session("w1");
    const oldId = session.sessionId;
    const start = mac.now;
    mac.at(500, () => {
      session.status = "busy";
    });
    mac.at(10_000, () => mac.endTurn(session));

    const outcome = await pool.clear({ name: "w1" });

    expect(outcome.ok).toBe(true);
    expect(session.sessionId).not.toBe(oldId);
    expect(mac.now - start).toBeGreaterThanOrEqual(10_000);
    expect(mac.typed).toEqual([]);
  });
});

describe("clear", () => {
  it("types /clear into the slot's tab, and says so, when no hook record shows that the plugin's hooks run in its session", async () => {
    const { mac, pool } = setup();
    await pool.open({ name: "w1" });
    const { sessionId: oldId, pid } = mac.session("w1");
    const window = mac.windowOf(mac.session("w1"));

    const outcome = await pool.clear({ name: "w1" });

    const newId = mac.session("w1").sessionId;
    expect(newId).not.toBe(oldId);
    expect(outcome).toEqual({
      ok: true,
      text: `Cleared "w1": session ${oldId} was replaced by session ${newId}. Delivered by typing "/clear", because no hook record shows that the plugin's hooks run in this session.`,
    });
    expect(mac.typed.map(({ windowId, command }) => ({ windowId, command }))).toEqual([{ windowId: window.id, command: "/clear" }]);
    expect(mac.session("w1").pid).toBe(pid);
    expect(window.open).toBe(true);
  });

  it("reports the command as typed and not confirmed when the session ID is unchanged after 30 seconds", async () => {
    const { mac, pool } = setup();
    await pool.open({ name: "w1" });
    mac.clearEffect = "nothing";
    const start = mac.now;

    const outcome = await pool.clear({ name: "w1" });

    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("not confirmed");
    expect(mac.now - start).toBe(30_000);
    expect(mac.typed).toHaveLength(1);
  });
});

describe("clear, when the slot cannot be observed afterwards", () => {
  it("reports at once that the slot is gone when its session disappears after the command was typed", async () => {
    const { mac, pool } = setup();
    await pool.open({ name: "w1" });
    mac.clearEffect = "nothing";
    const pid = mac.session("w1").pid!;
    const start = mac.now;
    mac.at(500, () => mac.endSession(pid));

    const outcome = await pool.clear({ name: "w1" });

    expect(outcome).toEqual({ ok: false, text: '"/clear" was typed into the slot "w1", and the slot is now gone: not confirmed.' });
    expect(mac.now - start).toBe(1000);
  });

  it("does not take another process that now answers to the name for the cleared session", async () => {
    const { mac, pool, directory } = setup();
    await pool.open({ name: "w1" });
    mac.clearEffect = "nothing";
    const pid = mac.session("w1").pid!;
    mac.at(500, () => {
      mac.endSession(pid);
      mac.addSession({ name: "w1", cwd: directory });
    });

    const outcome = await pool.clear({ name: "w1" });

    const stranger = mac.session("w1");
    expect(outcome).toEqual({
      ok: false,
      text: `"/clear" was typed into the slot "w1", and the slot is now idle, session ${stranger.sessionId}, in another process (pid ${stranger.pid}, not ${pid}): not confirmed.`,
    });
  });

  it("reports at once that the slot is ambiguous when a second session comes to answer to the name", async () => {
    const { mac, pool, directory } = setup();
    await pool.open({ name: "w1" });
    mac.clearEffect = "nothing";
    const start = mac.now;
    mac.at(500, () => mac.addSession({ name: "w1", cwd: directory }));

    const outcome = await pool.clear({ name: "w1" });

    expect(outcome).toEqual({
      ok: false,
      text: '"/clear" was typed into the slot "w1", and the slot is now ambiguous, 2 sessions answer to this name: not confirmed.',
    });
    expect(mac.now - start).toBe(1000);
  });

  it("goes on waiting when the sessions cannot be listed for a while, and succeeds once they can", async () => {
    const { mac, pool } = setup();
    await pool.open({ name: "w1" });
    const oldId = mac.session("w1").sessionId;
    mac.at(500, () => {
      mac.listingFailure = "claude: command not found";
    });
    mac.at(5500, () => {
      mac.listingFailure = undefined;
    });

    const outcome = await pool.clear({ name: "w1" });

    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain(`session ${oldId} was replaced by session ${mac.session("w1").sessionId}`);
  });

  it("says that the command was typed when the sessions cannot be listed until the limit", async () => {
    const { mac, pool } = setup();
    await pool.open({ name: "w1" });
    const start = mac.now;
    mac.at(500, () => {
      mac.listingFailure = "claude: command not found";
    });

    const outcome = await pool.clear({ name: "w1" });

    expect(outcome.ok).toBe(false);
    expect(outcome.text).toBe(
      '"/clear" was typed into the slot "w1", but the sessions could not be listed (claude: command not found) after 30 seconds: not confirmed. The command was not typed again.',
    );
    expect(mac.now - start).toBe(30_000);
  });
});

describe("delivering a typed command", () => {
  it("waits for a busy slot to become idle before typing", async () => {
    const { mac, pool } = setup();
    await pool.open({ name: "w1" });
    const session = mac.session("w1");
    session.status = "busy";
    const start = mac.now;
    mac.at(20_000, () => {
      session.status = "idle";
    });

    const outcome = await pool.clear({ name: "w1" });

    expect(outcome.ok).toBe(true);
    expect(mac.typed[0]!.at - start).toBe(20_000);
  });

  it.each([
    { status: "busy", waitingFor: undefined, described: "is busy" },
    { status: "waiting", waitingFor: "input needed", described: "is waiting for input needed" },
  ])("refuses and types nothing when the slot $described for 60 seconds", async ({ status, waitingFor, described }) => {
    const { mac, pool } = setup();
    await pool.open({ name: "w1" });
    Object.assign(mac.session("w1"), { status, waitingFor });
    const start = mac.now;

    const outcomes = [await pool.clear({ name: "w1" }), await pool.compact({ name: "w1" })];

    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(false);
      expect(outcome.text).toContain(`The slot "w1" ${described}`);
    }
    expect(mac.now - start).toBe(120_000);
    expect(mac.typed).toEqual([]);
  });

  it("refuses and types nothing when the slot is gone, ambiguous or has no Terminal tab", async () => {
    const { mac, pool, directory } = setup();
    for (const name of ["gone", "twice", "tabless"]) {
      mac.addSession({ name, cwd: directory });
      await pool.adopt({ name });
    }
    mac.endSession(mac.session("gone").pid!);
    mac.addSession({ name: "twice", cwd: directory });
    mac.windowOf(mac.session("tabless")).open = false;

    const outcomes = await Promise.all(["gone", "twice", "tabless"].map((name) => pool.clear({ name })));

    expect(outcomes.map((outcome) => outcome.text)).toEqual([
      'The slot "gone" is gone; nothing was typed or written.',
      'The slot "twice" is ambiguous, 2 sessions answer to this name; nothing was typed or written.',
      `No Terminal tab hosts the slot "tabless" (pid ${mac.session("tabless").pid}); nothing was typed.`,
    ]);
    expect(mac.typed).toEqual([]);
  });

  it.each(
    (["clear", "compact"] as const).flatMap((tool) => (["terminalFailure", "typingFailure"] as const).map((failure) => ({ tool, failure }))),
  )("returns Terminal's own error and types nothing when $failure, for $tool", async ({ tool, failure }) => {
    const { mac, pool } = setup();
    await pool.open({ name: "w1" });
    mac[failure] = "Not authorized to send Apple events to Terminal. (-1743)";

    const outcome = await pool[tool]({ name: "w1" });

    expect(outcome).toEqual({ ok: false, text: "Not authorized to send Apple events to Terminal. (-1743)" });
    expect(mac.typed).toEqual([]);
  });

  it("types one command at a time when two calls arrive together", async () => {
    const { mac, pool } = setup();
    await pool.open({ name: "w1" });
    await pool.open({ name: "w2" });
    mac.typingMs = 500;

    const outcomes = await Promise.all([pool.clear({ name: "w1" }), pool.clear({ name: "w2" })]);

    expect(outcomes.map((outcome) => outcome.ok)).toEqual([true, true]);
    expect(mac.mostTypingAtOnce).toBe(1);
  });

  it("types into the tab of the slot it was asked about and into no other", async () => {
    const { mac, pool } = setup();
    await pool.open({ name: "w1" });
    await pool.open({ name: "w2" });
    const idOfW1 = mac.session("w1").sessionId;

    await pool.clear({ name: "w2" });

    expect(mac.typed.map((entry) => entry.windowId)).toEqual([mac.windowOf(mac.session("w2")).id]);
    expect(mac.session("w1").sessionId).toBe(idOfW1);
  });
});

describe("only slots, and never the dispatcher session", () => {
  it.each(["clear", "compact", "close", "recycle"] as const)("%s refuses a session that is not a slot", async (tool) => {
    const { mac, pool, directory } = setup();
    mac.addSession({ name: "stranger", cwd: directory });

    const outcome = await pool[tool]({ name: "stranger" });

    expect(outcome).toEqual({ ok: false, text: '"stranger" is not a slot in this pool\'s roster; nothing was done.' });
    expect([mac.typed, mac.terminated, mac.launches]).toEqual([[], [], []]);
  });

  it.each(["absent", "hooks and mod"] as const)(
    "acts on no session when a slot's name is now answered by the dispatcher session, with the plugin %s",
    async (plugin) => {
      const { mac, pool, directory, standingOrders } = setup({ plugin });
      const worker = mac.addSession({ name: "w1", cwd: directory });
      await pool.adopt({ name: "w1" });
      mac.endSession(worker.pid!);
      mac.addSession({ name: "w1", cwd: directory, pid: DISPATCHER_PID });

      const outcomes = [
        await pool.clear({ name: "w1" }),
        await pool.compact({ name: "w1" }),
        await pool.close({ name: "w1", force: true }),
        await pool.recycle({ name: "w1", force: true }),
      ];

      for (const outcome of outcomes) {
        expect(outcome.ok).toBe(false);
        expect(outcome.text).toContain("dispatcher session itself");
      }
      expect([mac.typed, mac.terminated, mac.launches, mac.ordersSeen, standingOrders()]).toEqual([[], [], [], [], []]);
    },
  );
});

describe("compact", () => {
  async function openWithTranscript(context: ReturnType<typeof setup>, name: string) {
    await context.pool.open({ name });
    const session = context.mac.session(name);
    context.mac.appendTurnRecord(session.sessionId!);
    return session;
  }

  it("returns success only after the transcript records a compaction, and keeps the session ID", async () => {
    const context = setup();
    const { mac, pool } = context;
    const session = await openWithTranscript(context, "w1");
    const sessionId = session.sessionId!;
    const start = mac.now;

    const outcome = await pool.compact({ name: "w1" });

    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain(`session ${sessionId} records a compaction`);
    expect(mac.now - start).toBe(8000);
    expect(mac.typed.map((entry) => entry.command)).toEqual(["/compact"]);
    expect(mac.session("w1").sessionId).toBe(sessionId);
  });

  it("does not count a compaction that was recorded before the command was typed", async () => {
    const context = setup();
    const { mac, pool } = context;
    const session = await openWithTranscript(context, "w1");
    mac.appendCompactionRecord(session.sessionId!);
    mac.compactEffect = "busy-then-idle";

    const outcome = await pool.compact({ name: "w1" });

    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/^unconfirmed: /);
  });

  it.each([
    { effect: "nothing" as const, when: "the session never becomes busy", reason: /had not become busy 20 seconds later/, seconds: 20 },
    { effect: "busy-then-idle" as const, when: "the session is idle again without a recorded compaction", reason: /returned to idle/, seconds: 18 },
  ])("returns unconfirmed after $seconds seconds when $when", async ({ effect, reason, seconds }) => {
    const context = setup();
    const { mac, pool } = context;
    await openWithTranscript(context, "w1");
    mac.compactEffect = effect;
    const start = mac.now;

    const outcome = await pool.compact({ name: "w1" });

    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/^unconfirmed: /);
    expect(outcome.text).toMatch(reason);
    expect(mac.now - start).toBe(seconds * 1000);
  });

  it("returns unconfirmed at once when the slot's session disappears during the wait", async () => {
    const context = setup();
    const { mac, pool } = context;
    const session = await openWithTranscript(context, "w1");
    mac.compactEffect = "busy-forever";
    const start = mac.now;
    mac.at(3000, () => mac.endSession(session.pid!));

    const outcome = await pool.compact({ name: "w1" });

    expect(outcome).toEqual({ ok: false, text: 'unconfirmed: "/compact" was typed into the slot "w1", and the slot is now gone.' });
    expect(mac.now - start).toBe(4000);
  });

  it.each([
    { replacement: "busy", described: "busy" },
    { replacement: "idle", described: "idle" },
  ])("returns unconfirmed at once when another process, $replacement, comes to answer to the name", async ({ replacement, described }) => {
    const context = setup();
    const { mac, pool, directory } = context;
    const session = await openWithTranscript(context, "w1");
    mac.compactEffect = "busy-forever";
    const start = mac.now;
    mac.at(3000, () => {
      mac.endSession(session.pid!);
      mac.addSession({ name: "w1", cwd: directory, status: replacement });
    });

    const outcome = await pool.compact({ name: "w1", timeoutMinutes: 5 });

    const stranger = mac.session("w1");
    expect(outcome).toEqual({
      ok: false,
      text: `unconfirmed: "/compact" was typed into the slot "w1", and the slot is now ${described}, session ${stranger.sessionId}, in another process (pid ${stranger.pid}, not ${session.pid}).`,
    });
    expect(mac.now - start).toBe(4000);
  });

  it("returns unconfirmed at once when a second session comes to answer to the name", async () => {
    const context = setup();
    const { mac, pool, directory } = context;
    await openWithTranscript(context, "w1");
    mac.compactEffect = "busy-forever";
    const start = mac.now;
    mac.at(3000, () => mac.addSession({ name: "w1", cwd: directory }));

    const outcome = await pool.compact({ name: "w1", timeoutMinutes: 5 });

    expect(outcome).toEqual({
      ok: false,
      text: 'unconfirmed: "/compact" was typed into the slot "w1", and the slot is now ambiguous, 2 sessions answer to this name.',
    });
    expect(mac.now - start).toBe(4000);
  });

  it("says that the command was typed when the sessions cannot be listed until the time limit", async () => {
    const context = setup();
    const { mac, pool } = context;
    await openWithTranscript(context, "w1");
    mac.compactEffect = "nothing";
    const start = mac.now;
    mac.at(500, () => {
      mac.listingFailure = "claude: command not found";
    });

    const outcome = await pool.compact({ name: "w1", timeoutMinutes: 5 });

    expect(outcome.ok).toBe(false);
    expect(outcome.text).toBe(
      'unconfirmed: "/compact" was typed into the slot "w1", and its transcript records no compaction after 5 minutes. The command was not typed again. The sessions could not be listed: claude: command not found',
    );
    expect(mac.now - start).toBe(300_000);
  });

  it.each([
    { timeoutMinutes: undefined, minutes: 30 },
    { timeoutMinutes: 5, minutes: 5 },
  ])("returns unconfirmed after $minutes minutes when no compaction is recorded, without typing again", async ({ timeoutMinutes, minutes }) => {
    const context = setup();
    const { mac, pool } = context;
    await openWithTranscript(context, "w1");
    mac.compactEffect = "busy-forever";
    const start = mac.now;

    const outcome = await pool.compact({ name: "w1", timeoutMinutes });

    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(new RegExp(`^unconfirmed: .*no compaction after ${minutes} minutes`));
    expect(mac.now - start).toBe(minutes * 60_000);
    expect(mac.typed).toHaveLength(1);
  });

  it("still types the command and returns unconfirmed at once when the transcript cannot be found", async () => {
    const { mac, pool } = setup();
    await pool.open({ name: "w1" });
    const start = mac.now;

    const outcome = await pool.compact({ name: "w1" });

    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/^unconfirmed: .*transcript of session .* could not be found or read/);
    expect(mac.typed.map((entry) => entry.command)).toEqual(["/compact"]);
    expect(mac.now - start).toBe(0);
  });

  it("refuses a time limit that is not a positive number", async () => {
    const context = setup();
    await openWithTranscript(context, "w1");

    const outcome = await context.pool.compact({ name: "w1", timeoutMinutes: 0 });

    expect(outcome).toEqual({ ok: false, text: "timeoutMinutes must be a positive number, got 0." });
    expect(context.mac.typed).toEqual([]);
  });

  it("does not delay other calls while it waits", async () => {
    const context = setup();
    const { mac, pool } = context;
    await openWithTranscript(context, "w1");
    await pool.open({ name: "w2" });
    mac.compactEffect = "busy-forever";
    let compactSettled = false;

    const compacting = pool.compact({ name: "w1", timeoutMinutes: 5 }).then((outcome) => {
      compactSettled = true;
      return outcome;
    });
    const status = await pool.status();
    const cleared = await pool.clear({ name: "w2" });

    expect(status.ok).toBe(true);
    expect(cleared.ok).toBe(true);
    expect(compactSettled).toBe(false);
    expect((await compacting).ok).toBe(false);
  });
});

describe("close", () => {
  it("ends an idle slot's session, closes the window the server opened and removes the slot", async () => {
    const { mac, pool } = setup();
    await pool.open({ name: "w1" });
    const { pid } = mac.session("w1");
    const window = mac.windowOf(mac.session("w1"));

    const outcome = await pool.close({ name: "w1" });

    expect(outcome).toEqual({ ok: true, text: `Closed "w1": its session (pid ${pid}) ended. Its Terminal window was closed.` });
    expect(mac.terminated).toEqual([pid]);
    expect(mac.closedWindows).toEqual([window.id]);
    expect((await pool.status()).text).toBe(NO_SLOTS);
  });

  it("ends an adopted slot's session and leaves the owner's window open", async () => {
    const { mac, pool, directory } = setup();
    const session = mac.addSession({ name: "w1", cwd: directory });
    await pool.adopt({ name: "w1" });

    const outcome = await pool.close({ name: "w1" });

    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain("Its Terminal window was left open, because the roster does not record this session as one the server opened.");
    expect(mac.terminated).toEqual([session.pid]);
    expect(mac.closedWindows).toEqual([]);
    expect((await pool.status()).text).toBe(NO_SLOTS);
  });

  it("leaves the owner's window open when the owner started the slot's session after the one the server opened ended", async () => {
    const { mac, pool, directory } = setup();
    await pool.open({ name: "w1" });
    const serverWindow = mac.windowOf(mac.session("w1"));
    serverWindow.open = false;
    mac.endSession(mac.session("w1").pid!);
    const byHand = mac.addSession({ name: "w1", cwd: directory });
    const ownersWindow = mac.windowOf(byHand);

    const outcome = await pool.close({ name: "w1" });

    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain("Its Terminal window was left open, because the roster does not record this session as one the server opened.");
    expect(mac.terminated).toEqual([byHand.pid]);
    expect(mac.closedWindows).toEqual([]);
    expect(ownersWindow.open).toBe(true);
  });

  it("says that the session ended when the roster cannot be written afterwards", async () => {
    const { mac, pool, rosterRoot } = setup();
    await pool.open({ name: "w1" });
    const { pid } = mac.session("w1");
    const pools = join(rosterRoot, "pools");
    mac.at(500, () => chmodSync(pools, 0o555));
    try {
      const outcome = await pool.close({ name: "w1" });

      expect(outcome.ok).toBe(false);
      expect(outcome.text).toMatch(
        new RegExp(`^Closed "w1": its session \\(pid ${pid}\\) ended\\. The roster could not be updated, so the slot is still listed: EACCES`),
      );
    } finally {
      chmodSync(pools, 0o755);
    }
    expect((await pool.status()).text).toBe("w1: gone");
  });

  it("leaves the window open for an opened slot whose roster entry records no process", async () => {
    const { mac, poolIn, rosterRoot } = setup();
    const session = mac.addSession({ name: "w1", cwd: "/pools/fixture/project" });
    mkdirSync(join(rosterRoot, "pools"), { recursive: true });
    writeFileSync(
      join(rosterRoot, "pools", "cd19260131af8dd8.json"),
      '{"version":1,"directory":"/pools/fixture/project","slots":[{"name":"w1","origin":"opened"}]}',
    );

    const outcome = await poolIn("/pools/fixture/project").close({ name: "w1" });

    expect(outcome.ok).toBe(true);
    expect(mac.terminated).toEqual([session.pid]);
    expect(mac.closedWindows).toEqual([]);
  });

  it("says so when Terminal has no window for the session it opened", async () => {
    const { mac, pool } = setup();
    await pool.open({ name: "w1" });
    mac.windowOf(mac.session("w1")).open = false;

    const outcome = await pool.close({ name: "w1" });

    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain("No Terminal window was found for it.");
    expect((await pool.status()).text).toBe(NO_SLOTS);
  });

  it("reports a window that could not be closed, with the session ended and the slot removed", async () => {
    const { mac, pool } = setup();
    await pool.open({ name: "w1" });
    const { pid } = mac.session("w1");
    mac.closeFailure = "Terminal did not close window 100 within 10 seconds.";

    const outcome = await pool.close({ name: "w1" });

    expect(outcome).toEqual({
      ok: false,
      text: `Closed "w1": its session (pid ${pid}) ended. Its Terminal window could not be closed: Terminal did not close window 100 within 10 seconds.`,
    });
    expect((await pool.status()).text).toBe(NO_SLOTS);
  });

  it("leaves a window open when it holds other tabs", async () => {
    const { mac, pool } = setup();
    await pool.open({ name: "w1" });
    mac.windowOf(mac.session("w1")).tabCount = 2;

    const outcome = await pool.close({ name: "w1" });

    expect(outcome.ok).toBe(true);
    expect(outcome.text).toContain("Its tab was left open, because its window has other tabs");
    expect(mac.closedWindows).toEqual([]);
  });

  it.each([
    { status: "busy", waitingFor: undefined, described: "busy" },
    { status: "waiting", waitingFor: "permission prompt", described: "waiting for permission prompt" },
  ])("refuses a slot that is $described unless force is given, as recycle does", async ({ status, waitingFor, described }) => {
    const { mac, pool } = setup();
    await pool.open({ name: "w1" });
    const session = mac.session("w1");
    Object.assign(session, { status, waitingFor });

    const refused = [await pool.close({ name: "w1" }), await pool.recycle({ name: "w1" })];

    for (const outcome of refused) {
      expect(outcome.ok).toBe(false);
      expect(outcome.text).toContain(`The slot "w1" is ${described}; it was not closed.`);
    }
    expect(mac.terminated).toEqual([]);
    expect(mac.launches).toHaveLength(1);

    const forced = await pool.close({ name: "w1", force: true });

    expect(forced.ok).toBe(true);
    expect(mac.terminated).toEqual([session.pid]);
  });

  it("removes a gone slot from the roster", async () => {
    const { mac, pool, directory } = setup();
    const session = mac.addSession({ name: "w1", cwd: directory });
    await pool.adopt({ name: "w1" });
    mac.endSession(session.pid!);

    const outcome = await pool.close({ name: "w1" });

    expect(outcome).toEqual({ ok: true, text: 'No live session answered to "w1"; it was removed from the roster.' });
    expect((await pool.status()).text).toBe(NO_SLOTS);
  });

  it.each([false, true])("keeps the slot and closes no window when the process has not exited after 15 seconds (force: %s)", async (force) => {
    const { mac, pool } = setup();
    await pool.open({ name: "w1" });
    mac.endsWhenAsked = false;
    const start = mac.now;

    const outcome = await pool.close({ name: "w1", force });

    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("had not exited 15 seconds after it was asked to end");
    expect(mac.now - start).toBe(15_000);
    expect(mac.closedWindows).toEqual([]);
    expect((await pool.status()).text).toBe(`w1: idle, session ${mac.session("w1").sessionId}`);
  });

  it("refuses an ambiguous slot even with force, as recycle does", async () => {
    const { mac, pool, directory } = setup();
    mac.addSession({ name: "w1", cwd: directory });
    await pool.adopt({ name: "w1" });
    mac.addSession({ name: "w1", cwd: directory });

    const outcomes = [await pool.close({ name: "w1", force: true }), await pool.recycle({ name: "w1", force: true })];

    expect(outcomes.map((outcome) => outcome.text)).toEqual([
      '2 sessions answer to the slot "w1"; none was ended.',
      '2 sessions answer to the slot "w1"; none was ended.',
    ]);
    expect([mac.terminated, mac.launches]).toEqual([[], []]);
  });
});

describe("recycle", () => {
  it("replaces the slot's session with a new process and a new conversation under the same name", async () => {
    const { mac, pool } = setup();
    await pool.open({ name: "w1" });
    const old = { ...mac.session("w1") };
    const oldWindow = mac.windowOf(mac.session("w1"));

    const outcome = await pool.recycle({ name: "w1", model: "sonnet", permissionMode: "plan" });

    const fresh = mac.session("w1");
    expect(outcome.ok).toBe(true);
    expect(mac.terminated).toEqual([old.pid]);
    expect(mac.closedWindows).toEqual([oldWindow.id]);
    expect(fresh.pid).not.toBe(old.pid);
    expect(fresh.sessionId).not.toBe(old.sessionId);
    expect([fresh.model, fresh.permissionMode]).toEqual(["sonnet", "plan"]);
    expect((await pool.status()).text).toBe(`w1: idle, session ${fresh.sessionId}`);
  });

  it("makes an adopted slot one whose window the server opened", async () => {
    const { mac, pool, directory } = setup();
    mac.addSession({ name: "w1", cwd: directory });
    await pool.adopt({ name: "w1" });
    await pool.recycle({ name: "w1" });
    const window = mac.windowOf(mac.session("w1"));

    await pool.close({ name: "w1" });

    expect(mac.closedWindows).toEqual([window.id]);
  });

  it("opens nothing when the close step refuses", async () => {
    const { mac, pool } = setup();
    await pool.open({ name: "w1" });
    mac.session("w1").status = "busy";

    const outcome = await pool.recycle({ name: "w1" });

    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain("it was not closed");
    expect(mac.launches).toHaveLength(1);
    expect(mac.terminated).toEqual([]);
  });

  it("keeps the slot, now gone, when the session ended and no new window could be opened", async () => {
    const { mac, pool } = setup();
    await pool.open({ name: "w1" });
    const oldPid = mac.session("w1").pid;
    mac.openFailure = "Terminal got an error: AppleEvent timed out. (-1712)";

    const outcome = await pool.recycle({ name: "w1" });

    expect(outcome.ok).toBe(false);
    expect(outcome.text.split("\n")[0]).toBe(`Closed "w1": its session (pid ${oldPid}) ended. Its Terminal window was closed.`);
    expect(outcome.text).toContain("No new session was confirmed: Terminal got an error: AppleEvent timed out. (-1712)");
    expect(outcome.text).toContain('The slot "w1" stays in the roster and is now gone.');
    expect((await pool.status()).text).toBe("w1: gone");
  });

  it("reports the slot's real state when the new session starts but is not idle in time, and still owns its window", async () => {
    const { mac, pool, directory } = setup();
    const adopted = mac.addSession({ name: "w1", cwd: directory });
    await pool.adopt({ name: "w1" });
    mac.startupMs = undefined;

    const outcome = await pool.recycle({ name: "w1" });

    const stuck = mac.session("w1");
    expect(outcome.ok).toBe(false);
    expect(outcome.text.split("\n")[0]).toMatch(new RegExp(`^Closed "w1": its session \\(pid ${adopted.pid}\\) ended\\.`));
    expect(outcome.text).toContain('A window was opened for "w1", but its session was not idle after 60 seconds. Its window was left open.');
    expect(outcome.text).not.toContain("was not added to the roster");
    expect(outcome.text).toContain(`The slot "w1" stays in the roster and is now busy, session ${stuck.sessionId}.`);
    expect((await pool.status()).text).toBe(`w1: busy, session ${stuck.sessionId}`);

    await pool.close({ name: "w1", force: true });

    expect(mac.closedWindows).toEqual([mac.windowOf(stuck).id]);
  });

  it("keeps the slot, gone, when the window opened but no session appeared in time", async () => {
    const { mac, pool } = setup();
    await pool.open({ name: "w1" });
    mac.startupMs = 120_000;

    const outcome = await pool.recycle({ name: "w1" });

    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain('The slot "w1" stays in the roster and is now gone.');
    expect((await pool.status()).text).toBe("w1: gone");

    await mac.clock.sleep(70_000);
    const late = mac.session("w1");
    expect((await pool.status()).text).toBe(`w1: idle, session ${late.sessionId}`);

    const closed = await pool.close({ name: "w1" });

    expect(closed.text).toContain("because the roster does not record this session as one the server opened");
    expect(mac.terminated.at(-1)).toBe(late.pid);
    expect(mac.windowOf(late).open).toBe(true);
  });
});

describe("release", () => {
  it("removes a live slot from the roster and leaves its session untouched", async () => {
    const { mac, pool, directory } = setup();
    const session = mac.addSession({ name: "w1", cwd: directory });
    await pool.adopt({ name: "w1" });

    const outcome = await pool.release({ name: "w1" });

    expect(outcome).toEqual({ ok: true, text: 'Released "w1": it was removed from the roster. Its session was not touched.' });
    expect((await pool.status()).text).toBe(NO_SLOTS);
    expect(mac.session("w1").sessionId).toBe(session.sessionId);
    expect([mac.typed, mac.terminated, mac.closedWindows]).toEqual([[], [], []]);
  });

  it.each(["busy", "waiting", "ambiguous"])("removes a slot that is %s and touches nothing", async (state) => {
    const { mac, pool, directory } = setup();
    mac.addSession({ name: "w1", cwd: directory });
    await pool.adopt({ name: "w1" });
    if (state === "ambiguous") mac.addSession({ name: "w1", cwd: directory });
    else mac.session("w1").status = state;

    const outcome = await pool.release({ name: "w1" });

    expect(outcome.ok).toBe(true);
    expect((await pool.status()).text).toBe(NO_SLOTS);
    expect(mac.sessions.filter((session) => session.name === "w1")).toHaveLength(state === "ambiguous" ? 2 : 1);
    expect([mac.typed, mac.terminated, mac.closedWindows]).toEqual([[], [], []]);
  });

  it("removes a gone slot, and refuses a name that is not a slot", async () => {
    const { mac, pool, directory } = setup();
    const session = mac.addSession({ name: "w1", cwd: directory });
    await pool.adopt({ name: "w1" });
    mac.endSession(session.pid!);

    expect((await pool.release({ name: "w1" })).ok).toBe(true);
    expect(await pool.release({ name: "w1" })).toEqual({ ok: false, text: '"w1" is not a slot in this pool\'s roster; nothing was done.' });
  });
});

describe("the roster", () => {
  it("is shared by a later server process started in the same directory", async () => {
    const { mac, pool, poolIn, directory } = setup();
    await pool.open({ name: "w1" });

    const later = poolIn(directory);

    expect((await later.status()).text).toBe(`w1: idle, session ${mac.session("w1").sessionId}`);
  });

  it("is seen afresh by two server processes that are alive on the same directory", async () => {
    const { mac, pool, poolIn, directory } = setup();
    const second = poolIn(directory);
    expect((await second.status()).text).toBe(NO_SLOTS);

    await pool.open({ name: "w1" });
    expect((await second.status()).text).toBe(`w1: idle, session ${mac.session("w1").sessionId}`);

    await second.open({ name: "w2" });
    expect((await pool.status()).text).toBe(
      `w1: idle, session ${mac.session("w1").sessionId}\nw2: idle, session ${mac.session("w2").sessionId}`,
    );
  });

  it("is the same for a pool started through a symbolic link to the directory", async () => {
    const { mac, pool, poolIn, directory, home } = setup();
    const link = join(home, "link-to-project");
    symlinkSync(directory, link);

    await poolIn(link).open({ name: "w1" });

    expect(mac.session("w1").cwd).toBe(directory);
    expect((await pool.status()).text).toBe(`w1: idle, session ${mac.session("w1").sessionId}`);
  });

  it("is one file per pool, named by a hash of the directory, holding the version, the directory and the slots", async () => {
    const { mac, poolIn, rosterRoot } = setup();
    const pool = poolIn("/pools/fixture/project");
    const adopted = mac.addSession({ name: "by-hand", cwd: "/pools/fixture/project" });

    await pool.open({ name: "w1" });
    await pool.adopt({ name: "by-hand" });

    // sha256("/pools/fixture/project") starts with cd19260131af8dd8; computed with `printf %s … | shasum -a 256`.
    const file = join(rosterRoot, "pools", "cd19260131af8dd8.json");
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({
      version: 1,
      directory: "/pools/fixture/project",
      slots: [
        { name: "w1", origin: "opened", pid: mac.session("w1").pid },
        { name: "by-hand", origin: "adopted" },
      ],
    });
    expect(adopted.pid).not.toBe(mac.session("w1").pid);
  });

  it("reads a roster file written by hand in the documented form", async () => {
    const { mac, poolIn, rosterRoot } = setup();
    const session = mac.addSession({ name: "w1", cwd: "/pools/fixture/project" });
    mkdirSync(join(rosterRoot, "pools"), { recursive: true });
    writeFileSync(
      join(rosterRoot, "pools", "cd19260131af8dd8.json"),
      '{"version":1,"directory":"/pools/fixture/project","slots":[{"name":"w1","origin":"opened","pid":4711},{"name":"w2","origin":"adopted"}]}',
    );

    const status = await poolIn("/pools/fixture/project").status();

    expect(status.text).toBe(`w1: idle, session ${session.sessionId}\nw2: gone`);
  });

  it("is separate for each pool directory, and each pool opens sessions in its own directory", async () => {
    const { mac, pool, poolIn, directory, elsewhere } = setup();
    const other = poolIn(elsewhere);

    await pool.open({ name: "w1" });
    await other.open({ name: "w2" });

    expect((await pool.status()).text).toBe(`w1: idle, session ${mac.session("w1").sessionId}`);
    expect((await other.status()).text).toBe(`w2: idle, session ${mac.session("w2").sessionId}`);
    expect([mac.session("w1").cwd, mac.session("w2").cwd]).toEqual([directory, elsewhere]);
  });

  it.each([
    { damage: "is not valid JSON", content: "{ not json" },
    { damage: "has an unknown version", content: (directory: string) => JSON.stringify({ version: 2, directory, slots: [] }) },
    { damage: "belongs to another directory", content: JSON.stringify({ version: 1, directory: "/somewhere/else", slots: [] }) },
    {
      damage: "holds a slot in an unexpected form",
      content: (directory: string) => JSON.stringify({ version: 1, directory, slots: [{ name: "w1", origin: "opened", pid: "4711" }] }),
    },
  ])("makes every tool refuse and stays unchanged when its file $damage", async ({ content }) => {
    const { mac, pool, directory, rosterRoot } = setup();
    mac.addSession({ name: "w1", cwd: directory });
    const path = new RosterStore(rosterRoot, directory).path;
    const text = typeof content === "string" ? content : content(directory);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);

    const outcomes = [
      await pool.init({ names: ["w2"] }),
      await pool.open({ name: "w2" }),
      await pool.adopt({ name: "w1" }),
      await pool.status(),
      await pool.clear({ name: "w1" }),
      await pool.compact({ name: "w1" }),
      await pool.close({ name: "w1" }),
      await pool.recycle({ name: "w1" }),
      await pool.release({ name: "w1" }),
    ];

    for (const outcome of outcomes) {
      expect(outcome.ok).toBe(false);
      expect(outcome.text).toContain(`The roster file ${path} cannot be used`);
    }
    expect(readFileSync(path, "utf8")).toBe(text);
    expect([mac.launches, mac.typed, mac.terminated]).toEqual([[], [], []]);
  });
});

// The mod's part of `clear`: the real mod, handed the fake engine of `support/mod-engine.ts`. The cases above stand the mod in with `FakeMac`.
describe("the directory of the clear orders", () => {
  const ORDERS = (home: string) => `${home}/.claude-session-pool/clear-orders`;

  it.each(["startup", "clear", "resume", "compact"])("is watched from every session start, on top of the paths others ask for: a start from %s", async (source) => {
    const { home, classicStart } = await modSetup();

    const answered = await classicStart(source, { watchPaths: ["/elsewhere"], additionalContext: ["kept"] });

    expect(answered).toEqual({ watchPaths: ["/elsewhere", ORDERS(home)], additionalContext: ["kept"] });
  });

  it("is the only path the mod asks to be watched when no other hook names one", async () => {
    const { home, classicStart } = await modSetup();

    expect(await classicStart("startup", undefined)).toEqual({ watchPaths: [ORDERS(home)] });
  });

  it("is not watched, and the result of the other hooks stands, when the mod cannot learn the user's home directory", async () => {
    const { classicStart } = await modSetup({ homeKnown: false });

    expect(await classicStart("startup", { watchPaths: ["/elsewhere"] })).toEqual({ watchPaths: ["/elsewhere"] });
  });
});

describe("a clear order that the server left for the session", () => {
  /** An order file as the server writes it, left `agoMs` before the time the mod has. */
  const leave = ({ wake, time }: { wake: WakeState; time: { now: number } }, agoMs = 1000) => wake.writeClearOrder(SESSION, time.now - agoMs);

  it("makes the mod run /clear once, when Claude Code tells it of a change under the directory of the orders", async () => {
    const context = await modSetup();
    leave(context);

    await context.fileChanged();

    expect(context.commands).toEqual(["clear"]);
    expect(context.session.id).toBe(AFTER_CLEAR);
  });

  it("is passed on to the hooks under the mod's own, which keep their answer", async () => {
    const context = await modSetup();
    leave(context);

    const { answered } = await context.fileChanged(undefined, undefined, { fromCore: { answeredBy: "a hook under the mod's" } });

    expect(answered).toEqual({ answeredBy: "a hook under the mod's" });
    expect(context.commands).toEqual(["clear"]);
  });

  it.each(["answer", "aborted", "error", "refusal"])(
    "makes the mod wait until the turn that is running has ended, however it ended: %s",
    async (reason) => {
      const context = await modSetup();
      await context.turnStarts();
      leave(context);

      await context.fileChanged();
      expect(context.commands).toEqual([]);
      await context.turnEnds(reason);

      expect(context.commands).toEqual(["clear"]);
      expect(context.session.id).toBe(AFTER_CLEAR);
    },
  );

  it("does not make the mod run /clear when the order was removed while the turn was running", async () => {
    const context = await modSetup();
    await context.turnStarts();
    leave(context);
    await context.fileChanged();

    context.wake.removeClearOrder(SESSION);
    await context.turnEnds();

    expect(context.commands).toEqual([]);
  });

  it.each([
    { what: "the file is named for another session and so is its content", prepare: (c: Context) => c.wake.writeClearOrder(OTHER_SESSION, c.time.now) },
    {
      what: "the file is named for this session and its content names another",
      prepare: (c: Context) => put(c, JSON.stringify({ version: 1, sessionId: OTHER_SESSION, requestedAt: new Date(c.time.now).toISOString() })),
    },
    { what: "it was written 60 seconds ago", prepare: (c: Context) => c.wake.writeClearOrder(SESSION, c.time.now - 60_000) },
    { what: "it is dated in the future", prepare: (c: Context) => c.wake.writeClearOrder(SESSION, c.time.now + 1) },
    { what: "it is not valid JSON", prepare: (c: Context) => put(c, '{"version": 1, "sessionId"') },
    {
      what: "it carries another version",
      prepare: (c: Context) => put(c, JSON.stringify({ version: 2, sessionId: SESSION, requestedAt: new Date(c.time.now).toISOString() })),
    },
    { what: "its time is not a date", prepare: (c: Context) => put(c, JSON.stringify({ version: 1, sessionId: SESSION, requestedAt: "yesterday" })) },
    {
      what: "its time is a list that holds a date",
      prepare: (c: Context) => put(c, JSON.stringify({ version: 1, sessionId: SESSION, requestedAt: [new Date(c.time.now).toISOString()] })),
    },
    { what: "it is a list", prepare: (c: Context) => put(c, "[]") },
  ])("does not make the mod run /clear when $what", async ({ prepare }) => {
    const context = await modSetup();
    prepare(context);

    await context.fileChanged();
    await context.turnEnds();

    expect(context.commands).toEqual([]);
  });

  it("makes the mod run /clear when the order was written just under 60 seconds ago", async () => {
    const context = await modSetup();
    leave(context, 59_999);

    await context.fileChanged();

    expect(context.commands).toEqual(["clear"]);
  });

  it("makes the mod run /clear once when Claude Code tells it of several changes while the command is queued", async () => {
    const context = await modSetup();
    context.clears.held = true;
    leave(context);

    await Promise.all([context.fileChanged(), context.fileChanged(), context.fileChanged()]);
    await context.turnEnds();
    context.clears.release();
    await settle();

    expect(context.commands).toEqual(["clear"]);
  });

  it("does not apply to the session after the clear: no second /clear for the same order", async () => {
    const context = await modSetup();
    leave(context);

    await context.fileChanged();
    await context.fileChanged();
    await context.turnEnds();

    expect(context.commands).toEqual(["clear"]);
  });

  it("is not read from a path built of a session ID that could name a file elsewhere", async () => {
    const context = await modSetup();
    context.session.id = "../escaped";

    await context.fileChanged();
    await context.turnEnds();

    // The one read is the mod's own activity record, at load, under the session ID the session had then.
    expect(context.reads).toEqual([join(context.home, ".claude-session-pool", "activity", `${SESSION}.json`)]);
    expect(context.commands).toEqual([]);
  });

  it("is passed over when Claude Code does not give the mod the session's ID", async () => {
    const context = await modSetup();
    leave(context);
    context.session.idFails = true;

    await context.fileChanged();

    expect(context.commands).toEqual([]);
  });

  it("is tried again every 2 seconds when Claude Code rejects the command, and given up after five more tries", async () => {
    const context = await modSetup();
    context.clears.fails = true;
    leave(context);

    await context.fileChanged();
    for (let again = 0; again < 5; again += 1) {
      expect(context.timers.map((timer) => timer.ms)).toEqual([2000]);
      await context.runTimers(2000);
    }

    expect(context.commands).toEqual(Array<string>(6).fill("clear"));
    expect(context.timers).toEqual([]);
  });

  it("makes the mod run /clear on a later try when the rejection was for a moment only", async () => {
    const context = await modSetup();
    context.clears.fails = true;
    leave(context);
    await context.fileChanged();

    context.clears.fails = false;
    await context.runTimers(2000);

    expect(context.commands).toEqual(["clear", "clear"]);
    expect(context.session.id).toBe(AFTER_CLEAR);
  });

  it("makes the mod run /clear on a later try when a hook under its own holds the event that told it", async () => {
    const context = await modSetup();
    leave(context);

    const held = await context.fileChanged(undefined, undefined, { holdBelow: true });
    expect(context.commands).toEqual(["clear"]);
    expect(context.session.id).toBe(SESSION);
    await held.end();
    await context.runTimers(2000);

    expect(context.commands).toEqual(["clear", "clear"]);
    expect(context.session.id).toBe(AFTER_CLEAR);
  });

  it("does not try again when the order was removed after Claude Code rejected the command", async () => {
    const context = await modSetup();
    context.clears.fails = true;
    leave(context);
    await context.fileChanged();

    context.wake.removeClearOrder(SESSION);
    await context.runTimers(2000);

    expect(context.commands).toEqual(["clear"]);
  });
});

type Context = Awaited<ReturnType<typeof modSetup>>;

/** Writes `text` as the order file of the session, as a process of the same user could. */
function put(context: Context, text: string): void {
  mkdirSync(join(context.home, ".claude-session-pool", "clear-orders"), { recursive: true });
  writeFileSync(join(context.home, ".claude-session-pool", "clear-orders", `${SESSION}.json`), text);
}
