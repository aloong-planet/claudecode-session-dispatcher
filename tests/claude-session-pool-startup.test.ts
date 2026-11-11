/**
 * The two things a person runs: the server's entry file under `node`, and the start-up command. Both run as real
 * processes. `claude`, `ps` and `osascript` are replaced by scripts on PATH, so no Claude Code session is started
 * and Terminal is not touched.
 *
 * Not covered here, because it needs real Claude Code sessions: that Claude Code starts the server with the
 * environment variables of its session, which is how the start-up command's mark reaches the server, and that a
 * session the start-up command starts while a registration of the same name exists is offered each tool once. Both
 * were checked by hand with real sessions on Claude Code 2.1.322, the second with a registration at local scope,
 * and are to be checked again when Claude Code changes how it starts servers or how it treats two entries of one
 * name.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

const repository = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = join(repository, "src", "server.ts");

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "claude-session-pool-")));
  temporaryDirectories.push(directory);
  return directory;
}

const POOL_TOOLS = ["adopt", "clear", "close", "compact", "init", "open", "recycle", "release", "status"];
/** The variable in which the start-up command leaves the process ID of the session it starts. */
const MARK = "CLAUDE_SESSION_POOL_DISPATCHER_PID";
/** These tests start the server themselves, so this process stands where the attached session would. */
const startedByStartupCommand = { [MARK]: String(process.pid) };

/** A user-level registration of this server and a project's MCP configuration, as files that nothing here may touch. */
const USER_CONFIGURATION = `${JSON.stringify({ mcpServers: { "claude-session-pool": { command: "node", args: [entry], alwaysLoad: true, timeout: 86_400_000 } } })}\n`;
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

async function withServer<T>(options: { cwd: string; env: Record<string, string> }, use: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry], stderr: "pipe", ...options }));
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

describe("the entry file", () => {
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

  it("compacts the session that started it: follows that session's transcript under the home directory and types into its tab", async () => {
    const home = temporaryDirectory();
    const project = join(home, ".claude", "projects", "-Users-someone-project");
    mkdirSync(project, { recursive: true });
    const transcript = join(project, "s-1.jsonl");
    writeFileSync(transcript, `${JSON.stringify({ type: "tools-used", tools: ["Read"], sessionId: "s-1" })}\n`);
    const typed = join(home, "typed.log");
    // Stands in for Terminal and for Claude Code at once: what is typed is logged, and recorded as queued.
    const queued = JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: "2026-11-11T06:41:11.708Z", sessionId: "s-1", content: "/compact" });
    const osascript = [
      "shift $(( $# - 3 ))",
      `if [ "$3" = /compact ]; then echo "$1 $2 $3" >> '${typed}'; echo '${queued}' >> '${transcript}'; fi`,
      "echo '101 1 1'",
    ].join("\n");
    const { path } = standIns([{ kind: "interactive", pid: process.pid, cwd: home, name: "me", sessionId: "s-1", status: "busy" }], { osascript });

    const result = await withServer({ cwd: home, env: { PATH: path, HOME: home } }, (client) => callText(client, "compact_self", {}));

    expect(result.isError).toBe(false);
    expect(result.text).toContain("is queued");
    expect(readFileSync(typed, "utf8")).toBe("101 1 /compact\n");
  });
});

describe("the start-up command", () => {
  const SESSION = "c97a8f9a-26a0-473f-8829-eeb79f7298e0";
  const configuration = {
    mcpServers: { "claude-session-pool": { command: "node", args: [entry], alwaysLoad: true, timeout: 86_400_000 } },
  };

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

  it("passes its arguments to claude, followed by a configuration that attaches this server with its tools loaded up front", () => {
    const { status, started } = start(["--resume", "abc", "say hello"]);

    expect(status).toBe(0);
    expect(started!.args.slice(0, 4)).toEqual(["--resume", "abc", "say hello", "--mcp-config"]);
    expect(JSON.parse(started!.args[4]!)).toEqual(configuration);
    expect(started!.args).toHaveLength(5);
  });

  it("starts a new session under the directory's name, as one argument, and marks it with the process ID that claude runs under", () => {
    const cwd = join(temporaryDirectory(), "my pool");
    mkdirSync(cwd);

    const { status, started } = start(["--model", "opus"], { cwd, sessions: [] });

    expect(status).toBe(0);
    expect(started!.args).toEqual(["--model", "opus", "--name=my pool-dispatcher", "--mcp-config", JSON.stringify(configuration)]);
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

  it("changes no MCP configuration, and runs claude only to list the sessions and to start the session", () => {
    const home = temporaryDirectory();
    const cwd = join(home, "pool");
    mkdirSync(cwd);
    writeFileSync(join(home, ".claude.json"), USER_CONFIGURATION);
    writeFileSync(join(cwd, ".mcp.json"), PROJECT_CONFIGURATION);

    const { status, claudeRuns } = start([], { cwd, home, sessions: [] });

    expect(status).toBe(0);
    expect(claudeRuns).toEqual(["agents --json", `--name=pool-dispatcher --mcp-config ${JSON.stringify(configuration)}`]);
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
    expect(started!.args).toEqual(["--resume", SESSION, "--mcp-config", JSON.stringify(configuration)]);
  });

  it("resumes a session whose transcript it cannot find without a name, and prints one line that says so", () => {
    const { status, stderr, started } = start(["--resume", SESSION]);

    expect(status).toBe(0);
    expect(stderr).toBe(`claude-dispatcher: the transcript of session ${SESSION} could not be found or read, so no name was added.\n`);
    expect(started!.args).toEqual(["--resume", SESSION, "--mcp-config", JSON.stringify(configuration)]);
  });

  it("finds the entry file when it is started through a symbolic link", () => {
    const link = join(temporaryDirectory(), "dispatcher-link");
    symlinkSync(join(repository, "bin", "claude-dispatcher"), link);

    const { started } = start(["-n", "boss"], { command: link });

    expect(JSON.parse(started!.args.at(-1)!)).toEqual(configuration);
    expect(existsSync(entry)).toBe(true);
  });

  it("starts from a checkout whose path holds characters that have a meaning in a URL", () => {
    const checkout = join(temporaryDirectory(), "c# tools?50%41", "repo");
    mkdirSync(checkout, { recursive: true });
    for (const part of ["bin", "src"]) cpSync(join(repository, part), join(checkout, part), { recursive: true });
    const server = { command: "node", args: [join(checkout, "src", "server.ts")], alwaysLoad: true, timeout: 86_400_000 };

    const { status, stderr, started } = start(["-n", "boss"], { command: join(checkout, "bin", "claude-dispatcher") });

    expect(stderr).toBe("");
    expect(status).toBe(0);
    expect(started!.args).toEqual(["-n", "boss", "--mcp-config", JSON.stringify({ mcpServers: { "claude-session-pool": server } })]);
  });
});
