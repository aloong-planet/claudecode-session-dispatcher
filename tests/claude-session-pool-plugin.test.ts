/**
 * The plugin as Claude Code and a person run it: the declarations of the server, the hooks and the mod; the server and the
 * hooks as real processes, with `claude`, `ps` and `osascript` replaced by scripts on PATH, so that no Claude Code
 * session is started and Terminal is not touched; and the hook program as a function of the event Claude Code describes
 * to it and of the files under the state directory, which is a temporary directory there; and the mod's looks and reports,
 * in the fake engine of `support/mod-engine.ts`. What the mod does otherwise is covered in
 * `claude-session-pool-compact-self.test.ts` (`compact_self`), `claude-session-pool-context-usage.test.ts` (`context_usage`),
 * `claude-session-pool.test.ts` (`clear`) and `claude-session-pool-subagent-watch.test.ts` (what a look finds of the
 * session's subagents); the hook on `PostCompact`, in `claude-session-pool-compact-self.test.ts`.
 *
 * Not covered here, because it needs real Claude Code sessions: that Claude Code loads the plugin from these
 * declarations, starts its server and its hooks as children of the session with the session's environment
 * variables (which is how the start-up command's mark reaches the server), and wakes the session when the
 * `PostCompact` hook exits with code 2. Nor is what Claude Code does in a session the start-up command starts while
 * the plugin is also installed: that it offers each tool once, under the same names as without the installation,
 * and runs each hook once for an event. Nor is that Claude Code loads the mod the hooks file names, and that with the
 * plugin installed and also given by `--plugin-dir` it loads the mod once and so answers a call to `compact_self` once:
 * only the number of loads was measured, in print mode, where no call was made. All of these were checked by hand on Claude Code 2.1.322, the last three in
 * print mode under a throwaway configuration directory, and are to be checked again when Claude Code changes how it
 * loads plugins or runs hooks.
 */
import { mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { QUIET, hookSetup } from "./support/hook-state.ts";
import { modSetup } from "./support/mod-engine.ts";
import { OTHER_SESSION, SESSION } from "./support/sessions.ts";
import {
  MARK,
  PROJECT_CONFIGURATION,
  USER_CONFIGURATION,
  callText,
  declaredHooks,
  hooksFile,
  manifest,
  pluginDirectory,
  readJson,
  repository,
  runHookProcess,
  standIns,
  startedByStartupCommand,
  withServer,
} from "./support/plugin-processes.ts";
import { cleanUpTemporaryDirectories, temporaryDirectory } from "./support/temporary.ts";

afterEach(cleanUpTemporaryDirectories);

const POOL_TOOLS = ["adopt", "clear", "close", "compact", "init", "open", "recycle", "release", "status"];

describe("the plugin", () => {
  it("is named cc-session-pool and declares the server pool, run by node, with its tools loaded up front and a 24-hour limit on one call", () => {
    expect(manifest.name).toBe("cc-session-pool");
    expect(Object.keys(manifest.mcpServers)).toEqual(["pool"]);
    expect(manifest.mcpServers.pool).toMatchObject({ command: "node", alwaysLoad: true, timeout: 86_400_000 });
  });

  it("is listed in the repository's marketplace, which has the plugin's name, by a relative path that leads to its directory", () => {
    const marketplace = readJson(join(repository, ".claude-plugin", "marketplace.json")) as { name: string; plugins: { name: string; source: string }[] };

    expect(marketplace.name).toBe("cc-session-pool");
    expect(marketplace.plugins.map(({ name, source }) => ({ name, source }))).toEqual([{ name: manifest.name, source: "./plugin" }]);
    expect(realpathSync(join(repository, marketplace.plugins[0]!.source))).toBe(pluginDirectory);
  });

  it("declares its two hooks as node programs without a shell: one for every session start, one that wakes the session after a compaction started by /compact", () => {
    expect(Object.keys(declaredHooks).sort()).toEqual(["PostCompact", "SessionStart"]);
    const [sessionStart, ...moreOnSessionStart] = declaredHooks.SessionStart!;
    const [postCompact, ...moreOnPostCompact] = declaredHooks.PostCompact!;

    expect([moreOnSessionStart, moreOnPostCompact]).toEqual([[], []]);
    expect(sessionStart!.matcher).toBeUndefined();
    expect(sessionStart!.hooks).toEqual([{ type: "command", command: "node", args: [expect.any(String)] }]);
    expect(postCompact!.matcher).toBe("manual");
    expect(postCompact!.hooks).toEqual([{ type: "command", command: "node", args: [expect.any(String)], asyncRewake: true }]);
  });

  it("names one hooks module beside its hooks, the mod: a file in the plugin's directory that exports register and nothing else", async () => {
    expect(hooksFile.modules).toEqual(["./register.ts"]);

    const mod = (await import(join(pluginDirectory, "hooks", hooksFile.modules[0]!))) as Record<string, unknown>;

    expect(Object.keys(mod)).toEqual(["register"]);
    expect(typeof mod.register).toBe("function");
  });

  it("carries a mod that answers the call to compact_self under the name this plugin and its server give the tool", async () => {
    type Hook = ($: unknown, e: unknown, next: () => Promise<unknown>) => Promise<unknown>;
    const { register } = (await import(join(pluginDirectory, "hooks", hooksFile.modules[0]!))) as { register: (on: (event: string, hook: Hook) => void) => void };
    const hooks = new Map<string, Hook>();
    register((event, hook) => void hooks.set(event, hook));
    const engine = { tool: { register: () => Promise.resolve({}) }, session: { id: () => Promise.resolve("s-1") }, clock: { every: () => () => {} } };
    const fromServer = { result: "from the server" };
    const [server] = Object.keys(manifest.mcpServers);
    await hooks.get("session.start")!(engine, { isInteractive: true }, () => Promise.resolve({}));

    const answered = await hooks.get("tool.call")!(engine, { tool: `mcp__plugin_${manifest.name}_${server}__compact_self` }, () => Promise.resolve(fromServer));

    expect(answered).not.toBe(fromServer);
    expect(answered).toEqual({ result: expect.stringMatching(/compacted when this turn ends/) as unknown });
  });

  it("carries a mod that answers the call to its own tool under the name Claude Code gives a tool this plugin registers", async () => {
    type Hook = ($: unknown, e: unknown, next: () => Promise<unknown>) => Promise<unknown>;
    const { register } = (await import(join(pluginDirectory, "hooks", hooksFile.modules[0]!))) as { register: (on: (event: string, hook: Hook) => void) => void };
    const hooks = new Map<string, Hook>();
    register((event, hook) => void hooks.set(event, hook));
    const registered: { name: string }[] = [];
    const engine = {
      tool: { register: (spec: { name: string }) => (registered.push(spec), Promise.resolve({ tool: `mcp__${manifest.name}__${spec.name}` })) },
      session: { usage: () => Promise.resolve({ startedAt: 0, context: { tokens: 37460, window: 1000000, percent: 4 }, rateLimits: [], cost: { usd: 0 } }) },
    };
    const fromServer = { result: "from the server" };
    await hooks.get("session.start")!(engine, { isInteractive: false }, () => Promise.resolve({}));

    const answered = await hooks.get("tool.call")!(engine, { tool: `mcp__${manifest.name}__${registered[0]!.name}` }, () => Promise.resolve(fromServer));

    expect(answered).toEqual({ result: expect.stringMatching(/^Context: 37460 input tokens of a 1000000-token window \(4%\)\./) as unknown });
  });
});

describe("the server, as the plugin declares it", () => {
  it.each([
    { how: "by the start-up command", mark: startedByStartupCommand, tools: [...POOL_TOOLS, "compact_self"].sort() },
    { how: "by anything else", mark: {}, tools: ["compact_self"] },
    { how: "from inside a session that the start-up command started", mark: { [MARK]: String(process.ppid) }, tools: ["compact_self"] },
  ])("runs under node without a build step and offers a session started $how the tools $tools", async ({ mark, tools }) => {
    const { path } = standIns([]);

    const names = await withServer({ cwd: repository, env: { PATH: path, HOME: tmpdir(), ...mark } }, async (client) =>
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
    );

    expect(names).toEqual(tools);
  });

  it.each([
    { where: "the directory Claude Code names as the project directory", useProjectVariable: true },
    { where: "its working directory when Claude Code names none", useProjectVariable: false },
  ])("keeps the roster under the home directory, for $where", async ({ useProjectVariable }) => {
    const home = temporaryDirectory();
    const project = join(home, "project");
    const elsewhere = join(home, "elsewhere");
    for (const directory of [project, elsewhere]) mkdirSync(directory);
    const { path } = standIns([{ kind: "interactive", pid: 1, cwd: project, name: "w1", sessionId: "s-1", status: "idle" }]);
    const env: Record<string, string> = { PATH: path, HOME: home, ...startedByStartupCommand };
    if (useProjectVariable) env.CLAUDE_PROJECT_DIR = project;

    const adopted = await withServer({ cwd: useProjectVariable ? elsewhere : project, env }, (client) => callText(client, "adopt", { name: "w1" }));

    expect(adopted).toEqual({ isError: false, text: 'Adopted "w1": idle, session s-1.' });
    const pools = join(home, ".claude-session-pool", "pools");
    const files = readdirSync(pools);
    expect(files).toHaveLength(1);
    expect(JSON.parse(readFileSync(join(pools, files[0]!), "utf8"))).toEqual({
      version: 1,
      directory: project,
      slots: [{ name: "w1", origin: "adopted" }],
    });
  });

  it("leaves the MCP configuration of the user and of the project as it found it, and runs claude only to list the sessions", async () => {
    const home = temporaryDirectory();
    const project = join(home, "project");
    mkdirSync(project);
    writeFileSync(join(home, ".claude.json"), USER_CONFIGURATION);
    writeFileSync(join(project, ".mcp.json"), PROJECT_CONFIGURATION);
    const { path, claudeRuns } = standIns([{ kind: "interactive", pid: 1, cwd: project, name: "w1", sessionId: "s-1", status: "idle" }]);

    const adopted = await withServer({ cwd: project, env: { PATH: path, HOME: home, ...startedByStartupCommand } }, (client) => callText(client, "adopt", { name: "w1" }));

    expect(adopted.isError).toBe(false);
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(USER_CONFIGURATION);
    expect(readFileSync(join(project, ".mcp.json"), "utf8")).toBe(PROJECT_CONFIGURATION);
    expect(readdirSync(home).sort()).toEqual([".claude-session-pool", ".claude.json", "project"]);
    expect(readdirSync(project)).toEqual([".mcp.json"]);
    expect(new Set(claudeRuns())).toEqual(new Set(["agents --json"]));
  });

  it("takes the process that started it for the dispatcher session", async () => {
    const home = temporaryDirectory();
    const { path } = standIns([{ kind: "interactive", pid: process.pid, cwd: home, name: "boss", sessionId: "s-1", status: "idle" }]);

    const adopted = await withServer({ cwd: home, env: { PATH: path, HOME: home, ...startedByStartupCommand } }, (client) =>
      callText(client, "adopt", { name: "boss" }),
    );

    expect(adopted).toEqual({ isError: true, text: '"boss" is the dispatcher session itself and cannot be a slot.' });
  });
});

describe("the hooks and the server, as the plugin declares them", () => {
  it("the hook on a session start leaves the hook record under the home directory, named after the process that started it, and prints nothing", () => {
    const home = temporaryDirectory();

    const ran = runHookProcess("SessionStart", { session_id: "s-1", source: "startup" }, home);

    expect(ran).toEqual({ status: 0, stdout: "", stderr: "" });
    const records = join(home, ".claude-session-pool", "hooks");
    expect(readdirSync(records)).toEqual([`${process.pid}.json`]);
    expect(readJson(join(records, `${process.pid}.json`))).toEqual({ version: 1, pid: process.pid, sessionId: "s-1" });
  });
});

describe("the hook on SessionStart", () => {
  it("writes the hook record of its session, named after the session's process", () => {
    const { started, files, read } = hookSetup();

    const result = started(SESSION);

    expect(result).toEqual(QUIET);
    expect(files("hooks")).toEqual(["4242.json"]);
    expect(read("hooks", "4242.json")).toEqual({ version: 1, pid: 4242, sessionId: SESSION });
  });

  it("makes the record follow the conversation when the session gets a new session ID", () => {
    const { started, files, read } = hookSetup();
    started(SESSION);

    started(OTHER_SESSION, 4242, "clear");

    expect(files("hooks")).toEqual(["4242.json"]);
    expect(read("hooks", "4242.json")).toEqual({ version: 1, pid: 4242, sessionId: OTHER_SESSION });
  });

  it("deletes the records of processes that no longer run and keeps the others", () => {
    const alive = [4242, 5001, 5002];
    const { started, files } = hookSetup(alive);
    started(SESSION, 5001);
    started(OTHER_SESSION, 5002);
    alive.splice(alive.indexOf(5001), 1);

    started("11111111-2222-4333-8444-555555555555");

    expect(files("hooks")).toEqual(["4242.json", "5002.json"]);
  });
});

describe("the hook on input it has no use for", () => {
  it.each([
    { what: "no session ID", input: { hook_event_name: "PostCompact", trigger: "manual" } },
    { what: "another event", input: { hook_event_name: "Stop", session_id: SESSION } },
    { what: "nothing that parses", input: undefined },
  ])("fails without waking anyone or writing anything, given $what", ({ input }) => {
    const { state, hook, files } = hookSetup();
    state.leaveWakeRequest(SESSION, 0);

    const result = hook(input);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toMatch(/^cc-session-pool: /);
    expect(files("hooks")).toEqual([]);
    expect(files("wake-requests")).toEqual([`${SESSION}.json`]);
  });
});

/** What Claude Code 2.1.327 rejects a compaction with while a turn is in flight. */
const COMPACTS_BETWEEN_TURNS = "cc-session-pool: $.session.compact: a turn is in flight; the conversation compacts between turns";
const SUBAGENT = "a8c24a82d67a3ee4c";
const OTHER_SUBAGENT = "a41633a00e77a2aa3";
type Mod = Awaited<ReturnType<typeof modSetup>>;
const reportsIn = (prompts: string[]) => prompts.filter((text) => text.startsWith("Report of the subagent watch, written by the cc-session-pool plugin."));

describe("the mod's looks", () => {
  it("are made once a minute in an interactive session, while a turn runs as well (claude-session-pool-plugin::REQ-004)", async () => {
    const { intervals, startSubagent, turnStarts, turnEnds, look, prompts } = await modSetup();
    startSubagent(SUBAGENT);

    await turnStarts();
    await look(12);
    const duringTurn = [...prompts];
    await turnEnds();
    await look();

    expect(intervals.map(({ ms }) => ms)).toEqual([60_000]);
    expect(duringTurn).toEqual([]);
    // The looks during the turn were counted: the report after it gives 12 looks in a row without progress.
    expect(prompts).toEqual([expect.stringContaining(`- ${SUBAGENT} (general-purpose, "Run the test suite"): running, and neither its transcript nor its token count changed for 12 minutes.`)]);
  });

  it.each([
    { what: "the session is not interactive", options: { interactive: false } },
    { what: "the mod is not told that the session started", options: { told: false } },
  ])("are not made when $what (claude-session-pool-plugin, \"not interactive\")", async ({ options }) => {
    const { intervals, startSubagent, look, prompts } = await modSetup(options);
    startSubagent(SUBAGENT);

    await look(20);

    expect(intervals).toEqual([]);
    expect(prompts).toEqual([]);
  });

  it("start anew when the mod is loaded again, and a stall reported before is reported once more (claude-session-pool-plugin, \"loaded again\")", async () => {
    const { startSubagent, look, reload, prompts } = await modSetup();
    startSubagent(SUBAGENT);
    await look(12);

    await reload();
    await look(11);
    const beforeTwelfth = reportsIn(prompts).length;
    await look();

    expect(beforeTwelfth).toBe(1);
    expect(reportsIn(prompts)).toHaveLength(2);
    expect(prompts[1]).toContain("changed for 11 minutes.");
  });
});

describe("a report of the mod", () => {
  it("holds every line due at one look in one prompt (claude-session-pool-plugin::REQ-005/AC-01)", async () => {
    const { startSubagent, look, prompts } = await modSetup();
    startSubagent(SUBAGENT);
    startSubagent(OTHER_SUBAGENT, { description: "parent probe" });

    await look(12);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.split("\n").slice(1, -1)).toEqual([
      `- ${SUBAGENT} (general-purpose, "Run the test suite"): running, and neither its transcript nor its token count changed for 11 minutes.`,
      `- ${OTHER_SUBAGENT} (general-purpose, "parent probe"): running, and neither its transcript nor its token count changed for 11 minutes.`,
    ]);
  });

  it.each([
    { what: "a turn is running", hold: (mod: Mod) => mod.turnStarts(), release: (mod: Mod) => mod.turnEnds() },
    {
      what: "a compaction request is held",
      hold: async (mod: Mod) => {
        await mod.calls();
        await mod.turnEnds();
        await mod.compactions[0]!.refuse(COMPACTS_BETWEEN_TURNS);
      },
      release: async (mod: Mod) => {
        await mod.runTimers(2_000);
        await mod.compactions[1]!.finish();
      },
    },
    {
      what: "a compaction the mod asked for is running",
      hold: async (mod: Mod) => {
        await mod.calls();
        await mod.turnEnds();
      },
      release: (mod: Mod) => mod.compactions[0]!.finish(),
    },
  ])("waits while $what, and is made at the first look after (claude-session-pool-plugin::REQ-005/AC-02)", async ({ hold, release }) => {
    const mod = await modSetup();
    mod.startSubagent(SUBAGENT);
    await hold(mod);

    await mod.look(13);
    const held = reportsIn(mod.prompts);
    await release(mod);
    const released = reportsIn(mod.prompts);
    await mod.look();

    expect([held, released]).toEqual([[], []]);
    expect(reportsIn(mod.prompts)).toEqual([expect.stringContaining(`- ${SUBAGENT} `)]);
    expect(reportsIn(mod.prompts)[0]).toContain("changed for 13 minutes.");
  });

  it("is not made of a stall that ended before the turn it waited for did (claude-session-pool-plugin::REQ-005/AC-02)", async () => {
    const { agents, startSubagent, turnStarts, turnEnds, look, prompts } = await modSetup();
    startSubagent(SUBAGENT);
    await turnStarts();
    await look(12);

    agents.listed[0]!.tokenCount += 3_100;
    await look();
    await turnEnds();
    await look();

    expect(prompts).toEqual([]);
  });

  it.each([
    { what: "rejects the prompt", kind: "reject" as const },
    { what: "drops the prompt, as when the owner stopped the session and typed nothing since", kind: "drop" as const },
  ])("is made again at the next look when Claude Code $what, and once only after it is taken (claude-session-pool-plugin::REQ-005/AC-03)", async ({ kind }) => {
    const { promptAnswer, startSubagent, look, prompts } = await modSetup();
    startSubagent(SUBAGENT);
    promptAnswer.kind = kind;
    await look(12);

    promptAnswer.kind = "take";
    await look();
    await look(5);

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain(`- ${SUBAGENT} `);
    expect(prompts[1]).toContain(`- ${SUBAGENT} `);
  });

  it("is not made twice while Claude Code has not answered the first prompt (claude-session-pool-plugin::REQ-006)", async () => {
    const { promptAnswer, startSubagent, look, prompts } = await modSetup();
    startSubagent(SUBAGENT);
    promptAnswer.kind = "hold";

    await look(15);

    expect(prompts).toHaveLength(1);
  });
});

describe("progress in a subagent", () => {
  it.each([
    { what: "its transcript alone grows", reportedAt: [17], at6: (mod: Mod) => mod.writeTranscript(SUBAGENT, 291_002) },
    { what: "its token count alone changes", reportedAt: [17], at6: (mod: Mod) => void (mod.agents.listed[0]!.tokenCount = 48_524) },
    {
      what: "its transcript cannot be read and its token count changes",
      reportedAt: [17],
      before: (mod: Mod) => rmSync(join(mod.subagentDirectory, `agent-${SUBAGENT}.jsonl`)),
      at6: (mod: Mod) => void (mod.agents.listed[0]!.tokenCount = 48_524),
    },
    { what: "its transcript cannot be read and its token count stays", reportedAt: [12], before: (mod: Mod) => rmSync(join(mod.subagentDirectory, `agent-${SUBAGENT}.jsonl`)), at6: () => {} },
  ])(
    "is found when $what, and the count starts anew from that look (claude-session-pool-plugin::REQ-007/AC-01, claude-session-pool-subagent-watch::US-001/AC-02)",
    async ({ reportedAt, before, at6 }: { reportedAt: number[]; before?: (mod: Mod) => void; at6: (mod: Mod) => void }) => {
      const mod = await modSetup();
      mod.startSubagent(SUBAGENT);
      before?.(mod);

      const reported: number[] = [];
      for (let made = 1; made <= 20; made += 1) {
        if (made === 6) at6(mod);
        await mod.look();
        if (mod.prompts.length > reported.length) reported.push(made);
      }

      expect(reported).toEqual(reportedAt);
    },
  );
});
