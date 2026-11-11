/**
 * The plugin's hook program, as a function of the event Claude Code describes to it and of the files under the
 * state directory, which is a temporary directory here. Hook records and wake requests are made the way the product
 * makes them: by the hook on `SessionStart` and by `WakeState`, which `compact_self` uses.
 *
 * The program as a process, and the declarations that make Claude Code run it, are covered in
 * `claude-session-pool-startup.test.ts`.
 *
 * Not covered here, because it needs a real Claude Code session: that Claude Code runs the hook for these events
 * with this input, and that it wakes an idle session when the hook exits with code 2. Both were measured by hand on
 * Claude Code 2.1.322 and are to be measured again when Claude Code changes how it runs hooks.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runHook } from "../src/hooks.ts";
import { WakeState } from "../src/wake.ts";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const SENTENCE = "The compaction this session requested with compact_self has finished. This is not an error. Continue the work that was in progress.";
const SESSION = "c97a8f9a-26a0-473f-8829-eeb79f7298e0";
const OTHER_SESSION = "78744021-cd3b-490e-b601-5575fbb91cd6";
const QUIET = { exitCode: 0, stderr: "" };

/** A state directory, and the hook as it runs in the session process `pid` while the processes in `alive` run. */
function setup(alive: number[] = [4242]) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "claude-session-pool-")));
  temporaryDirectories.push(home);
  const root = join(home, "state");
  const state = new WakeState(root);
  const hook = (input: unknown, pid = 4242) => runHook(input, { state, sessionPid: pid, isAlive: (candidate) => alive.includes(candidate) });
  const started = (sessionId: string, pid = 4242, source = "startup") => hook({ hook_event_name: "SessionStart", session_id: sessionId, source }, pid);
  const compacted = (sessionId: string, trigger = "manual") => hook({ hook_event_name: "PostCompact", session_id: sessionId, trigger, compact_summary: "…" });
  const files = (kind: "hooks" | "wake-requests") => (existsSync(join(root, kind)) ? readdirSync(join(root, kind)).sort() : []);
  const read = (kind: "hooks" | "wake-requests", name: string) => JSON.parse(readFileSync(join(root, kind, name), "utf8")) as unknown;
  return { root, state, hook, started, compacted, files, read };
}

describe("the hook on SessionStart", () => {
  it("writes the hook record of its session, named after the session's process", () => {
    const { started, files, read } = setup();

    const result = started(SESSION);

    expect(result).toEqual(QUIET);
    expect(files("hooks")).toEqual(["4242.json"]);
    expect(read("hooks", "4242.json")).toEqual({ version: 1, pid: 4242, sessionId: SESSION });
  });

  it("makes the record follow the conversation when the session gets a new session ID", () => {
    const { started, files, read } = setup();
    started(SESSION);

    started(OTHER_SESSION, 4242, "clear");

    expect(files("hooks")).toEqual(["4242.json"]);
    expect(read("hooks", "4242.json")).toEqual({ version: 1, pid: 4242, sessionId: OTHER_SESSION });
  });

  it("deletes the records of processes that no longer run and keeps the others", () => {
    const alive = [4242, 5001, 5002];
    const { started, files } = setup(alive);
    started(SESSION, 5001);
    started(OTHER_SESSION, 5002);
    alive.splice(alive.indexOf(5001), 1);

    started("11111111-2222-4333-8444-555555555555");

    expect(files("hooks")).toEqual(["4242.json", "5002.json"]);
  });
});

describe("the hook on PostCompact", () => {
  it("wakes a session whose conversation has a wake request: hands over the sentence, exits with code 2 and uses the request up", () => {
    const { state, compacted, files } = setup();
    state.leaveWakeRequest(SESSION, Date.UTC(2026, 10, 12, 3, 4, 5));

    const first = compacted(SESSION);
    const second = compacted(SESSION);

    expect(first).toEqual({ exitCode: 2, stderr: SENTENCE });
    expect(files("wake-requests")).toEqual([]);
    expect(second).toEqual(QUIET);
  });

  it("wakes no session whose conversation has no wake request", () => {
    const { compacted, files } = setup();

    expect(compacted(SESSION)).toEqual(QUIET);
    expect(files("wake-requests")).toEqual([]);
  });

  it("wakes no session after a compaction Claude Code started on its own, and leaves the request for the next one", () => {
    const { state, compacted, files } = setup();
    state.leaveWakeRequest(SESSION, 0);

    const afterAuto = compacted(SESSION, "auto");
    const afterManual = compacted(SESSION, "manual");

    expect(afterAuto).toEqual(QUIET);
    expect(afterManual).toEqual({ exitCode: 2, stderr: SENTENCE });
    expect(files("wake-requests")).toEqual([]);
  });

  it("leaves the wake request of another conversation alone", () => {
    const { state, compacted, files } = setup();
    state.leaveWakeRequest(OTHER_SESSION, 0);

    expect(compacted(SESSION)).toEqual(QUIET);
    expect(files("wake-requests")).toEqual([`${OTHER_SESSION}.json`]);
  });

  it.each([
    { what: "is not valid JSON", content: '{"version": 1, "sessionId"' },
    { what: "carries another version", content: JSON.stringify({ version: 2, sessionId: SESSION, requestedAt: "2026-11-12T03:04:05.000Z" }) },
  ])("treats a wake request that $what as absent", ({ content }) => {
    const { root, compacted, files } = setup();
    mkdirSync(join(root, "wake-requests"), { recursive: true });
    writeFileSync(join(root, "wake-requests", `${SESSION}.json`), content);

    expect(compacted(SESSION)).toEqual(QUIET);
    expect(files("wake-requests")).toEqual([`${SESSION}.json`]);
  });

  it("reads no file outside the wake requests for a session ID that is not one", () => {
    const { root, state, compacted, files } = setup();
    state.leaveWakeRequest(SESSION, 0);
    // A file that would pass for the wake request of "../decoy", one directory up from where wake requests are kept.
    writeFileSync(join(root, "decoy.json"), JSON.stringify({ version: 1, sessionId: "../decoy", requestedAt: "2026-11-12T03:04:05.000Z" }));

    expect(compacted("../decoy")).toEqual(QUIET);
    expect(existsSync(join(root, "decoy.json"))).toBe(true);
    expect(files("wake-requests")).toEqual([`${SESSION}.json`]);
  });
});

describe("the hook on input it has no use for", () => {
  it.each([
    { what: "no session ID", input: { hook_event_name: "PostCompact", trigger: "manual" } },
    { what: "another event", input: { hook_event_name: "Stop", session_id: SESSION } },
    { what: "nothing that parses", input: undefined },
  ])("fails without waking anyone or writing anything, given $what", ({ input }) => {
    const { state, hook, files } = setup();
    state.leaveWakeRequest(SESSION, 0);

    const result = hook(input);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^cc-session-pool: /);
    expect(files("hooks")).toEqual([]);
    expect(files("wake-requests")).toEqual([`${SESSION}.json`]);
  });
});
