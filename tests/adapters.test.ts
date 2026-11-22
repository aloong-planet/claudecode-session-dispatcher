/**
 * The adapters to the programs the server relies on. Only the step that runs a program is replaced; the outputs
 * fed in are shaped like what `claude agents --json`, `ps` and Terminal printed on 2026-11-10 (Claude Code 2.1.318).
 *
 * Not covered here: what Terminal does with the scripts it is sent. That needs the real application; see
 * `claude-session-pool.live.test.ts`.
 */
import { spawn, execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCli } from "../src/adapters/claude-cli.ts";
import type { Run } from "../src/adapters/exec.ts";
import { SystemProcesses } from "../src/adapters/processes.ts";
import { TerminalApp, shellCommandFor } from "../src/adapters/terminal-app.ts";
import { FileTranscripts } from "../src/adapters/transcripts.ts";

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "claude-session-pool-")));
  temporaryDirectories.push(directory);
  return directory;
}

const printing = (output: string): Run => () => Promise.resolve(output);
const failing = (message: string): Run => () => Promise.reject(new Error(message));

describe("the session listing", () => {
  const listing = JSON.stringify([
    {
      pid: 7321,
      cwd: "/Users/someone/playground/multi-agent",
      kind: "interactive",
      startedAt: 1792596900169,
      sessionId: "78744021-cd3b-490e-b601-5575fbb91cd6",
      name: "multi-agent-play",
      status: "idle",
    },
    {
      pid: 18703,
      cwd: "/Users/someone/git/codex-agents",
      kind: "interactive",
      startedAt: 1794050612904,
      sessionId: "c97a8f9a-26a0-473f-8829-eeb79f7298e0",
      name: "codex-agents-e6",
      status: "waiting",
      waitingFor: "input needed",
    },
    {
      id: "a3bbcb84",
      cwd: "/Users/someone/tmp/debug",
      kind: "background",
      startedAt: 1792336355650,
      sessionId: "a3bbcb84-eb88-4385-b5d7-bff695f6913b",
      name: "限额磁盘镜像复现",
      state: "done",
    },
  ]);

  it("reads interactive and background entries, with and without a process", async () => {
    const sessions = await new ClaudeCli(printing(listing)).list();

    expect(sessions).toEqual([
      {
        kind: "interactive",
        cwd: "/Users/someone/playground/multi-agent",
        pid: 7321,
        name: "multi-agent-play",
        sessionId: "78744021-cd3b-490e-b601-5575fbb91cd6",
        status: "idle",
        waitingFor: undefined,
      },
      {
        kind: "interactive",
        cwd: "/Users/someone/git/codex-agents",
        pid: 18703,
        name: "codex-agents-e6",
        sessionId: "c97a8f9a-26a0-473f-8829-eeb79f7298e0",
        status: "waiting",
        waitingFor: "input needed",
      },
      {
        kind: "background",
        cwd: "/Users/someone/tmp/debug",
        pid: undefined,
        name: "限额磁盘镜像复现",
        sessionId: "a3bbcb84-eb88-4385-b5d7-bff695f6913b",
        status: undefined,
        waitingFor: undefined,
      },
    ]);
  });

  it("fails with a reason when the command prints something that is not a session list", async () => {
    await expect(new ClaudeCli(printing("error: unknown option '--json'")).list()).rejects.toThrow("did not print JSON");
    await expect(new ClaudeCli(printing('{"sessions": []}')).list()).rejects.toThrow("did not print a list");
  });
});

describe("the plugin listing", () => {
  // Shaped like what `claude plugin list --json` printed on 2026-11-13 (Claude Code 2.1.322) for a user-level
  // installation from the repository's marketplace, beside a plugin copied into the cache and one installed for a project.
  const listing = JSON.stringify([
    {
      id: "chrome-devtools-mcp@chrome-devtools-plugins",
      version: "1.6.0",
      scope: "user",
      enabled: true,
      installPath: "/Users/someone/.claude/plugins/cache/chrome-devtools-plugins/chrome-devtools-mcp/1.6.0",
      installedAt: "2026-07-20T03:17:25.888Z",
      lastUpdated: "2026-07-20T03:17:25.888Z",
      projectEnabled: false,
    },
    {
      id: "cc-session-pool@cc-session-pool",
      version: "0.1.0",
      scope: "user",
      enabled: false,
      installPath: "/Users/someone/.claude/plugins/cache/cc-session-pool/cc-session-pool/0.1.0",
      readFromFolder: "/Users/someone/playground/claudecode-session-dispatcher/plugin",
      folderVersion: "0.1.0",
      installedAt: "2026-11-13T06:33:00.023Z",
      lastUpdated: "2026-11-13T06:33:00.023Z",
      mcpServers: { pool: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/../src/server.ts"], timeout: 86_400_000, alwaysLoad: true } },
      projectEnabled: false,
    },
    {
      id: "half-written@somewhere",
      scope: "user",
      enabled: "unknown",
    },
    {
      id: "superpowers@superpowers-marketplace",
      version: "7.0.1",
      scope: "project",
      enabled: false,
      installPath: "/Users/someone/.claude/plugins/cache/superpowers-marketplace/superpowers/7.0.1",
      projectPath: "/Users/someone/playground/skill-context-efficiency",
      projectEnabled: false,
    },
  ]);

  it("reads each installation's ID, whether it is enabled as printed, and the directory a plugin used in place is read from", async () => {
    expect(await new ClaudeCli(printing(listing)).installed()).toEqual([
      { id: "chrome-devtools-mcp@chrome-devtools-plugins", enabled: true, readFromFolder: undefined },
      { id: "cc-session-pool@cc-session-pool", enabled: false, readFromFolder: "/Users/someone/playground/claudecode-session-dispatcher/plugin" },
      { id: "half-written@somewhere", enabled: "unknown", readFromFolder: undefined },
      { id: "superpowers@superpowers-marketplace", enabled: false, readFromFolder: undefined },
    ]);
  });

  it.each([
    { what: "something that is not JSON", output: "error: unknown command 'plugin'", reason: "did not print JSON" },
    { what: "JSON that is not a list", output: '{"plugins": []}', reason: "did not print a list of plugins" },
  ])("fails with a reason when the command prints $what", async ({ output, reason }) => {
    await expect(new ClaudeCli(printing(output)).installed()).rejects.toThrow(reason);
  });
});

describe("processes", () => {
  it.each([
    { output: "ttys007\n", tty: "/dev/ttys007" },
    { output: "??\n", tty: undefined },
    { output: "", tty: undefined },
  ])("reads the controlling terminal $tty from ps output $output", async ({ output, tty }) => {
    expect(await new SystemProcesses(printing(output)).ttyOf(123)).toBe(tty);
  });

  it("reports no terminal for a process that ps cannot find", async () => {
    expect(await new SystemProcesses(failing("ps exited with code 1")).ttyOf(123)).toBeUndefined();
  });

  it("ends a real process and sees that it is gone", async () => {
    const processes = new SystemProcesses(failing("unused"));
    const child = spawn("sleep", ["30"]);
    const exited = new Promise((resolve) => child.on("exit", resolve));
    expect(processes.isAlive(child.pid!)).toBe(true);

    processes.terminate(child.pid!);
    await exited;

    expect(processes.isAlive(child.pid!)).toBe(false);
    expect(() => processes.terminate(child.pid!)).not.toThrow();
  });
});

describe("the command a new window runs", () => {
  it("changes to a directory whose path holds spaces and quotes, and passes each argument as one word", () => {
    const directory = join(temporaryDirectory(), `it's a "pool" dir`);
    mkdirSync(directory);
    const command = shellCommandFor({ directory, argv: ["sh", "-c", 'pwd; printf "%s|" "$@"', "sh", "two words", "it's", "$HOME"] });

    const output = execFileSync("sh", ["-c", command], { encoding: "utf8" });

    expect(output).toBe(`${directory}\ntwo words|it's|$HOME|`);
  });
});

describe("Terminal", () => {
  function recording(output: string) {
    const calls: { command: string; args: string[] }[] = [];
    const run: Run = (command, args) => {
      calls.push({ command, args });
      return Promise.resolve(output);
    };
    return { calls, terminal: new TerminalApp(run) };
  }

  it("hands the launch command to osascript as an argument and reads back the new window and its device", async () => {
    const { calls, terminal } = recording("165153 /dev/ttys007\n");
    const launch = { directory: "/Users/someone/project", argv: ["claude", "-n", "w1"] };

    const opened = await terminal.open(launch);

    expect(opened).toEqual({ windowId: 165153, tty: "/dev/ttys007" });
    expect(calls[0]!.command).toBe("osascript");
    expect(calls[0]!.args.at(-1)).toBe("cd '/Users/someone/project' && exec 'claude' '-n' 'w1'");
  });

  it("finds the tab that owns a device, and reports none when Terminal has no such tab", async () => {
    expect(await recording("148580 2 3\n").terminal.findTab("/dev/ttys023")).toEqual({ windowId: 148580, tab: 2, tabCount: 3 });
    expect(await recording("\n").terminal.findTab("/dev/ttys999")).toBeUndefined();
  });

  it.each(["typeCommand", "typeText"] as const)("%s passes the window, the tab and the text to type as separate arguments", async (method) => {
    const { calls, terminal } = recording("tab 1 of window id 165153\n");

    await terminal[method]({ windowId: 165153, tab: 1, tabCount: 1 }, "/clear");

    expect(calls[0]!.args.slice(-3)).toEqual(["165153", "1", "/clear"]);
  });

  it("returns the last non-empty lines of what a window shows", async () => {
    const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}   `);
    const { terminal } = recording(`${lines.join("\n")}\n\n\n`);

    const visible = await terminal.lastLines(165153);

    expect(visible.split("\n")).toEqual(Array.from({ length: 15 }, (_, index) => `line ${index + 6}`));
  });

  it("fails when Terminal reports that the window is still open", async () => {
    await expect(recording("open\n").terminal.close(165153)).rejects.toThrow("did not close window 165153");
    await expect(recording("closed\n").terminal.close(165153)).resolves.toBeUndefined();
  });

  it("fails with the reply when Terminal answers an open with something unexpected", async () => {
    await expect(recording("missing value\n").terminal.open({ directory: "/", argv: ["true"] })).rejects.toThrow(
      "unexpected reply when opening a window: missing value",
    );
  });
});

describe("transcripts", () => {
  const sessionId = "ef825680-688a-42f1-9f56-63504892ad97";
  const turn = { type: "tools-used", tools: ["ToolSearch", "SendMessage", "Read"], sessionId };
  const compaction = {
    parentUuid: null,
    logicalParentUuid: "88c6cc0e-f025-4c3a-aa3d-586c335ac6c2",
    isSidechain: false,
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    level: "info",
    compactMetadata: { trigger: "manual", preTokens: 57902, postTokens: 10660, cumulativeDroppedTokens: 47242, durationMs: 8908 },
    uuid: "dec74024-2aa2-441e-8dad-edb5e073e5db",
    timestamp: "2026-11-10T15:23:20.408Z",
    sessionId,
    version: "2.1.318",
  };
  const summary = {
    parentUuid: "dec74024-2aa2-441e-8dad-edb5e073e5db",
    type: "user",
    message: { role: "user", content: "This session is being continued from a previous conversation. It mentions compact_boundary in passing." },
    isCompactSummary: true,
    sessionId,
  };

  function transcript() {
    const root = temporaryDirectory();
    const project = join(root, "-Users-someone-project");
    mkdirSync(project);
    mkdirSync(join(root, "-Users-someone-other"));
    writeFileSync(join(root, "a-stray-file"), "");
    const path = join(project, `${sessionId}.jsonl`);
    writeFileSync(path, `${JSON.stringify(turn)}\n`);
    return { path, transcripts: new FileTranscripts(root) };
  }

  it("finds a session's transcript in whichever project directory holds it", () => {
    const { path, transcripts } = transcript();

    expect(transcripts.mark(sessionId)?.path).toBe(path);
    expect(transcripts.mark("00000000-0000-4000-8000-000000000000")).toBeUndefined();
    expect(transcripts.mark("../escape")).toBeUndefined();
    expect(new FileTranscripts(join(tmpdir(), "no-such-root-for-claude-session-pool")).mark(sessionId)).toBeUndefined();
  });

  it("sees only a compaction that was recorded after the mark", () => {
    const { path, transcripts } = transcript();
    appendFileSync(path, `${JSON.stringify(compaction)}\n`);
    const mark = transcripts.mark(sessionId)!;
    expect(transcripts.compactedSince(mark)).toBe(false);

    appendFileSync(path, `${JSON.stringify(turn)}\n${JSON.stringify(summary)}\n`);
    expect(transcripts.compactedSince(mark)).toBe(false);

    appendFileSync(path, `${JSON.stringify(compaction)}\n${JSON.stringify(summary)}\n`);
    expect(transcripts.compactedSince(mark)).toBe(true);
  });

  it("does not count a compaction record that is still being written", () => {
    const { path, transcripts } = transcript();
    const mark = transcripts.mark(sessionId)!;
    const line = JSON.stringify(compaction);

    appendFileSync(path, line.slice(0, 120));
    expect(transcripts.compactedSince(mark)).toBe(false);

    appendFileSync(path, `${line.slice(120)}\n`);
    expect(transcripts.compactedSince(mark)).toBe(true);
  });

  it("reports no compaction when the transcript has disappeared", () => {
    const { path, transcripts } = transcript();
    const mark = transcripts.mark(sessionId)!;
    rmSync(path);

    expect(transcripts.compactedSince(mark)).toBe(false);
  });

  // Shaped like the records Claude Code 2.1.322 wrote on 2026-11-11 when text was typed into a session during a turn.
  const queued = (content: string) => ({ type: "queue-operation", operation: "enqueue", timestamp: "2026-11-11T06:41:11.708Z", sessionId, content });
  const absorbed = (content: string) => ({
    type: "queue-operation",
    operation: "remove",
    timestamp: "2026-11-11T06:41:34.602Z",
    sessionId,
    content,
    reason: "absorbed_mid_turn",
    commandUuid: "2f09f33c-434f-4560-ba8f-00ae5f9c8e33",
    deliveryId: "3fd41113-4aa3-45c0-93d2-ac28f9a12d37",
  });
  const dequeued = { type: "queue-operation", operation: "dequeue", timestamp: "2026-11-11T06:41:35.002Z", sessionId };

  it("reads the texts queued after the mark, in order, and nothing that was only taken off the queue", () => {
    const { path, transcripts } = transcript();
    appendFileSync(path, `${JSON.stringify(queued("before the mark"))}\n`);
    const mark = transcripts.mark(sessionId)!;
    expect(transcripts.queuedSince(mark)).toEqual([]);

    appendFileSync(path, [queued("half typed/compact"), absorbed("half typed/compact"), turn, queued("/compact"), dequeued].map((record) => JSON.stringify(record)).join("\n") + "\n");

    expect(transcripts.queuedSince(mark)).toEqual(["half typed/compact", "/compact"]);
  });

  it("does not read a queued text whose record is still being written", () => {
    const { path, transcripts } = transcript();
    const mark = transcripts.mark(sessionId)!;
    const line = JSON.stringify(queued("/compact"));

    appendFileSync(path, line.slice(0, 60));
    expect(transcripts.queuedSince(mark)).toEqual([]);

    appendFileSync(path, `${line.slice(60)}\n`);
    expect(transcripts.queuedSince(mark)).toEqual(["/compact"]);
  });

  // Shaped like the records Claude Code 2.1.322 wrote on 2026-11-11 for a session started with `-n` and later renamed.
  const named = (customTitle: string) => [
    { type: "custom-title", customTitle, sessionId },
    { type: "agent-name", agentName: customTitle, sessionId },
  ];
  const mentioning = {
    type: "user",
    message: { role: "user", content: 'The record {"type":"custom-title","customTitle":"x"} is how a name is kept.' },
    sessionId,
  };

  it.each([
    { what: "a name given at the start and replaced later", records: [...named("probe-keep-1"), turn, ...named("probe-keep-1b")], state: "named" },
    { what: "no name record", records: [turn, summary], state: "unnamed" },
    { what: "a message that only quotes a name record", records: [mentioning], state: "unnamed" },
    { what: "a name record that is empty", records: [{ type: "custom-title", customTitle: "", sessionId }], state: "unnamed" },
  ])("tells whether a session was given a name: $what is $state", ({ records, state }) => {
    const { path, transcripts } = transcript();
    appendFileSync(path, records.map((record) => JSON.stringify(record)).join("\n") + "\n");

    expect(transcripts.nameState(sessionId)).toBe(state);
  });

  it("cannot tell whether a session was given a name when its transcript is not found", () => {
    const { transcripts } = transcript();

    expect(transcripts.nameState("00000000-0000-4000-8000-000000000000")).toBe("unknown");
    expect(transcripts.nameState("../escape")).toBe("unknown");
    expect(new FileTranscripts(join(tmpdir(), "no-such-root-for-claude-session-pool")).nameState(sessionId)).toBe("unknown");
  });
});
