/**
 * What Claude Code and a person run: the server, the hooks and the mod as the plugin declares them, and the start-up
 * command. All but the mod run as real processes; what the mod does is covered in `mod.test.ts`. `claude`, `ps` and `osascript` are replaced by scripts on PATH, so no Claude
 * Code session is started and Terminal is not touched.
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
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

// The start-up command resolves symbolic links on its way to the repository, so the path is compared resolved.
const repository = realpathSync(dirname(dirname(fileURLToPath(import.meta.url))));
const pluginDirectory = join(repository, "plugin");

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "claude-session-pool-")));
  temporaryDirectories.push(directory);
  return directory;
}

type Program = { type?: string; command: string; args: string[] };
type HookGroup = { matcher?: string; hooks: (Program & { asyncRewake?: boolean })[] };

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
const manifest = readJson(join(pluginDirectory, ".claude-plugin", "plugin.json")) as {
  name: string;
  mcpServers: Record<string, Program & { alwaysLoad?: boolean; timeout?: number }>;
};
const hooksFile = readJson(join(pluginDirectory, "hooks", "hooks.json")) as { modules: string[]; hooks: Record<string, HookGroup[]> };
const declaredHooks = hooksFile.hooks;

/** The arguments Claude Code runs a declared program with: it puts the plugin's directory where the declaration names it. */
const argumentsOf = (program: Program) => program.args.map((argument) => argument.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginDirectory));

const POOL_TOOLS = ["adopt", "clear", "close", "compact", "init", "open", "recycle", "release", "status"];
const SENTENCE = "The compaction this session requested with compact_self has finished. This is not an error. Continue the work that was in progress.";
/** The variable in which the start-up command leaves the process ID of the session it starts. */
const MARK = "CLAUDE_SESSION_POOL_DISPATCHER_PID";
/** These tests start the server and the hooks themselves, so this process stands where the attached session would. */
const startedByStartupCommand = { [MARK]: String(process.pid) };

/** A user-level MCP registration and a project's MCP configuration, as files that nothing here may touch. */
const USER_CONFIGURATION = `${JSON.stringify({ mcpServers: { "claude-session-pool": { command: "node", args: [join(repository, "src", "server.ts")] } } })}\n`;
const PROJECT_CONFIGURATION = '{"mcpServers":{}}\n';

/** The arguments of every run of the stand-in `claude` that logs to `log`, one run to a line. */
function runsLogged(log: string): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : [];
}

/** A directory of stand-ins for the programs the server runs, to put first on PATH. The stand-in `claude` logs its runs. */
function standIns(sessions: unknown[], scripts: { osascript?: string } = {}) {
  const directory = temporaryDirectory();
  const listing = join(directory, "sessions.json");
  const log = join(directory, "claude-runs.log");
  writeFileSync(listing, JSON.stringify(sessions));
  const bodies = { claude: `printf '%s\\n' "$*" >> '${log}'\ncat '${listing}'`, ps: "echo ttys001", osascript: "echo '101 1 1'", ...scripts };
  for (const [name, body] of Object.entries(bodies)) {
    writeFileSync(join(directory, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(directory, name), 0o755);
  }
  return { directory, path: `${directory}:${dirname(process.execPath)}:/usr/bin:/bin`, claudeRuns: () => runsLogged(log) };
}

/** Starts the server as the plugin declares it. The declaration's `node` is the one that runs these tests. */
async function withServer<T>(options: { cwd: string; env: Record<string, string> }, use: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: argumentsOf(manifest.mcpServers.pool!), stderr: "pipe", ...options }));
  try {
    return await use(client);
  } finally {
    await client.close();
  }
}

async function callText(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, text: (result.content as { text: string }[]).map((part) => part.text).join("\n") };
}

/** Runs the hook the plugin declares for `event`, as Claude Code does: with the event on standard input, as a child of the session. */
function runHook(event: "SessionStart" | "PostCompact", input: Record<string, unknown>, home: string) {
  const ran = spawnSync(process.execPath, argumentsOf(declaredHooks[event]![0]!.hooks[0]!), {
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: event, ...input }),
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home },
  });
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}

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
    const engine = { session: { id: () => Promise.resolve("s-1") } };
    const fromServer = { result: "from the server" };
    const [server] = Object.keys(manifest.mcpServers);
    await hooks.get("session.start")!(engine, { isInteractive: true }, () => Promise.resolve({}));

    const answered = await hooks.get("tool.call")!(engine, { tool: `mcp__plugin_${manifest.name}_${server}__compact_self` }, () => Promise.resolve(fromServer));

    expect(answered).not.toBe(fromServer);
    expect(answered).toEqual({ result: expect.stringMatching(/compacted when this turn ends/) as unknown });
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
  /**
   * A home directory with the transcript of the session s-1, which this process stands for and which is in the
   * middle of a turn, and a stand-in for Terminal and Claude Code at once: what is typed is logged, and recorded in
   * the transcript as queued.
   */
  function session() {
    const home = temporaryDirectory();
    const project = join(home, ".claude", "projects", "-Users-someone-project");
    mkdirSync(project, { recursive: true });
    const transcript = join(project, "s-1.jsonl");
    writeFileSync(transcript, `${JSON.stringify({ type: "tools-used", tools: ["Read"], sessionId: "s-1" })}\n`);
    const typed = join(home, "typed.log");
    const queued = JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: "2026-11-11T06:41:11.708Z", sessionId: "s-1", content: "/compact" });
    const osascript = [
      "shift $(( $# - 3 ))",
      `if [ "$3" = /compact ]; then echo "$1 $2 $3" >> '${typed}'; echo '${queued}' >> '${transcript}'; fi`,
      "echo '101 1 1'",
    ].join("\n");
    const { path } = standIns([{ kind: "interactive", pid: process.pid, cwd: home, name: "me", sessionId: "s-1", status: "busy" }], { osascript });
    const state = join(home, ".claude-session-pool");
    const compactSelf = () => withServer({ cwd: home, env: { PATH: path, HOME: home } }, (client) => callText(client, "compact_self", {}));
    return { home, typed, state, compactSelf };
  }

  it("the hook on a session start leaves the hook record under the home directory, named after the process that started it, and prints nothing", () => {
    const home = temporaryDirectory();

    const ran = runHook("SessionStart", { session_id: "s-1", source: "startup" }, home);

    expect(ran).toEqual({ status: 0, stdout: "", stderr: "" });
    const records = join(home, ".claude-session-pool", "hooks");
    expect(readdirSync(records)).toEqual([`${process.pid}.json`]);
    expect(readJson(join(records, `${process.pid}.json`))).toEqual({ version: 1, pid: process.pid, sessionId: "s-1" });
  });

  it("compact_self types into the tab of the session whose hooks ran and leaves a wake request; the hook after the compaction then hands over the sentence alone, exits with code 2, and does so once", async () => {
    const { home, typed, state, compactSelf } = session();
    runHook("SessionStart", { session_id: "s-1", source: "startup" }, home);

    const result = await compactSelf();

    expect(result.isError).toBe(false);
    expect(result.text).toContain("is queued");
    expect(readFileSync(typed, "utf8")).toBe("101 1 /compact\n");
    expect(readdirSync(join(state, "wake-requests"))).toEqual(["s-1.json"]);
    expect(readJson(join(state, "wake-requests", "s-1.json"))).toEqual({
      version: 1,
      sessionId: "s-1",
      requestedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) as unknown,
    });

    const woken = runHook("PostCompact", { session_id: "s-1", trigger: "manual", compact_summary: "…" }, home);
    const again = runHook("PostCompact", { session_id: "s-1", trigger: "manual", compact_summary: "…" }, home);

    expect(woken).toEqual({ status: 2, stdout: "", stderr: `${SENTENCE}\n` });
    expect(readdirSync(join(state, "wake-requests"))).toEqual([]);
    expect(again).toEqual({ status: 0, stdout: "", stderr: "" });
  });

  it("compact_self refuses and types nothing in a session whose hooks did not run", async () => {
    const { typed, state, compactSelf } = session();

    const result = await compactSelf();

    expect(result.isError).toBe(true);
    expect(result.text).toContain("No hook record shows that the cc-session-pool plugin's hooks run in this session");
    expect(existsSync(typed)).toBe(false);
    expect(existsSync(join(state, "wake-requests"))).toBe(false);
  });
});

describe("the start-up command", () => {
  const SESSION = "c97a8f9a-26a0-473f-8829-eeb79f7298e0";
  const plugin = ["--plugin-dir", pluginDirectory];

  /**
   * Runs the command with a stand-in `claude` on PATH. Asked for the session listing, the stand-in prints `sessions`,
   * or fails when there are none to print; started as a session, it prints its arguments, the mark it was started
   * with and its own process ID. It logs every run.
   */
  function start(given: string[], options: { sessions?: unknown[]; cwd?: string; home?: string; command?: string } = {}) {
    const directory = temporaryDirectory();
    const listing = join(directory, "sessions.json");
    const log = join(directory, "claude-runs.log");
    if (options.sessions) writeFileSync(listing, JSON.stringify(options.sessions));
    const report = `console.log(JSON.stringify({ args: process.argv.slice(1), mark: process.env.${MARK}, pid: process.pid }))`;
    const script = [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> '${log}'`,
      `if [ "\${1:-}" = agents ]; then [ -f '${listing}' ] || { echo 'the session registry is locked' >&2; exit 1; }; cat '${listing}'; exit 0; fi`,
      `exec "${process.execPath}" -e '${report}' -- "$@"`,
    ].join("\n");
    writeFileSync(join(directory, "claude"), `${script}\n`);
    chmodSync(join(directory, "claude"), 0o755);
    const ran = spawnSync(options.command ?? join(repository, "bin", "claude-dispatcher"), given, {
      encoding: "utf8",
      cwd: options.cwd ?? directory,
      env: { PATH: `${directory}:${dirname(process.execPath)}:/usr/bin:/bin`, HOME: options.home ?? directory },
    });
    const started = ran.stdout === "" ? undefined : (JSON.parse(ran.stdout) as { args: string[]; mark?: string; pid: number });
    return { status: ran.status, stderr: ran.stderr, started, directory, claudeRuns: runsLogged(log) };
  }

  /** A transcript under `home`, where Claude Code keeps them, holding `records`. */
  function transcriptIn(home: string, records: unknown[]) {
    const project = join(home, ".claude", "projects", "-Users-someone-git-codex-agents");
    mkdirSync(project, { recursive: true });
    writeFileSync(join(project, `${SESSION}.jsonl`), records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  }

  /** A copy of the command and of the program it runs, in a checkout at `checkout`. */
  function checkoutAt(checkout: string): string {
    mkdirSync(checkout, { recursive: true });
    for (const part of ["bin", "src"]) cpSync(join(repository, part), join(checkout, part), { recursive: true });
    return join(checkout, "bin", "claude-dispatcher");
  }

  it("passes its arguments to claude, followed by the plugin's directory in this repository, to load for that session", () => {
    const { status, started } = start(["--resume", "abc", "say hello"]);

    expect(status).toBe(0);
    expect(started!.args).toEqual(["--resume", "abc", "say hello", ...plugin]);
    expect(existsSync(join(started!.args.at(-1)!, ".claude-plugin", "plugin.json"))).toBe(true);
  });

  it("starts a new session under the directory's name, as one argument, and marks it with the process ID that claude runs under", () => {
    const cwd = join(temporaryDirectory(), "my pool");
    mkdirSync(cwd);

    const { status, started } = start(["--model", "opus"], { cwd, sessions: [] });

    expect(status).toBe(0);
    expect(started!.args).toEqual(["--model", "opus", "--name=my pool-dispatcher", ...plugin]);
    expect(started!.mark).toBe(String(started!.pid));
  });

  it.each([
    { what: "a live session already answers to the default name", sessions: [{ kind: "interactive", pid: 18_703, cwd: "/Users/someone/other", name: "pool-dispatcher" }], reason: 'A live session already answers to "pool-dispatcher" (pid 18703, in /Users/someone/other).' },
    { what: "the sessions cannot be listed", sessions: undefined, reason: "The sessions on this Mac could not be listed (the session registry is locked)" },
  ])("starts nothing and says why when $what", ({ sessions, reason }) => {
    const cwd = join(temporaryDirectory(), "pool");
    mkdirSync(cwd);

    const { status, stderr, started } = start([], { cwd, sessions });

    expect(status).toBe(1);
    expect(started).toBeUndefined();
    expect(stderr).toContain(`claude-dispatcher: ${reason}`);
    expect(stderr).toContain("Pass -n <name>");
  });

  it("changes no configuration of the user or of the project, and runs claude only to list the sessions and to start the session", () => {
    const home = temporaryDirectory();
    const cwd = join(home, "pool");
    mkdirSync(cwd);
    writeFileSync(join(home, ".claude.json"), USER_CONFIGURATION);
    writeFileSync(join(cwd, ".mcp.json"), PROJECT_CONFIGURATION);

    const { status, claudeRuns } = start([], { cwd, home, sessions: [] });

    expect(status).toBe(0);
    expect(claudeRuns).toEqual(["agents --json", `--name=pool-dispatcher --plugin-dir ${pluginDirectory}`]);
    expect(readFileSync(join(home, ".claude.json"), "utf8")).toBe(USER_CONFIGURATION);
    expect(readFileSync(join(cwd, ".mcp.json"), "utf8")).toBe(PROJECT_CONFIGURATION);
    expect(readdirSync(home).sort()).toEqual([".claude.json", "pool"]);
    expect(readdirSync(cwd)).toEqual([".mcp.json"]);
  });

  it("resumes a session whose transcript under the home directory shows a name, without adding one", () => {
    const home = temporaryDirectory();
    transcriptIn(home, [
      { type: "custom-title", customTitle: "codex-agents-f9", sessionId: SESSION },
      { type: "agent-name", agentName: "codex-agents-f9", sessionId: SESSION },
    ]);
    const cwd = join(home, "codex-agents");
    mkdirSync(cwd);

    const { status, stderr, started } = start(["--resume", SESSION], { cwd, home, sessions: [] });

    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(started!.args).toEqual(["--resume", SESSION, ...plugin]);
  });

  it("resumes a session whose transcript it cannot find without a name, and prints one line that says so", () => {
    const { status, stderr, started } = start(["--resume", SESSION]);

    expect(status).toBe(0);
    expect(stderr).toBe(`claude-dispatcher: the transcript of session ${SESSION} could not be found or read, so no name was added.\n`);
    expect(started!.args).toEqual(["--resume", SESSION, ...plugin]);
  });

  it("finds the plugin's directory when it is started through a symbolic link", () => {
    const link = join(temporaryDirectory(), "dispatcher-link");
    symlinkSync(join(repository, "bin", "claude-dispatcher"), link);

    const { started } = start(["-n", "boss"], { command: link });

    expect(started!.args).toEqual(["-n", "boss", ...plugin]);
  });

  it("starts from a checkout whose path holds spaces and characters that have a meaning in a URL, and passes the plugin's directory as one argument", () => {
    const checkout = join(temporaryDirectory(), "c# tools?50%41", "repo");

    const { status, stderr, started } = start(["-n", "boss"], { command: checkoutAt(checkout) });

    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(started!.args).toEqual(["-n", "boss", "--plugin-dir", join(checkout, "plugin")]);
  });

  it("starts nothing from a checkout whose path holds a line break, which would reach claude as further arguments", () => {
    const checkout = join(temporaryDirectory(), "tools\n--dangerously-skip-permissions", "repo");

    const { status, stderr, started, claudeRuns } = start(["-n", "boss"], { command: checkoutAt(checkout) });

    expect(status).toBe(1);
    expect(started).toBeUndefined();
    expect(claudeRuns).toEqual([]);
    expect(stderr).toContain("contains a control character, so it could not be passed to claude. Nothing was started.");
  });
});
