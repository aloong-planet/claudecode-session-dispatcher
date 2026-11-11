/**
 * The two things a person runs: the server's entry file under `node`, and the start-up command. Both run as real
 * processes. `claude`, `ps` and `osascript` are replaced by scripts on PATH, so no Claude Code session is started
 * and Terminal is not touched.
 */
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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

const TOOLS = ["adopt", "clear", "close", "compact", "init", "open", "recycle", "release", "status"];

/** A directory of stand-ins for the programs the server runs, to put first on PATH. */
function standIns(sessions: unknown[]) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "claude-session-pool-")));
  temporaryDirectories.push(directory);
  const listing = join(directory, "sessions.json");
  writeFileSync(listing, JSON.stringify(sessions));
  const scripts = { claude: `cat '${listing}'`, ps: "echo ttys001", osascript: "echo '101 1 1'" };
  for (const [name, body] of Object.entries(scripts)) {
    writeFileSync(join(directory, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(directory, name), 0o755);
  }
  return { directory, path: `${directory}:${dirname(process.execPath)}:/usr/bin:/bin` };
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
  it("runs under node without a build step and offers the nine tools over standard input and output", async () => {
    const { path } = standIns([]);

    const names = await withServer({ cwd: repository, env: { PATH: path, HOME: tmpdir() } }, async (client) =>
      (await client.listTools()).tools.map((tool) => tool.name).sort(),
    );

    expect(names).toEqual(TOOLS);
  });

  it.each([
    { where: "the directory Claude Code names as the project directory", useProjectVariable: true },
    { where: "its working directory when Claude Code names none", useProjectVariable: false },
  ])("keeps the roster under the home directory, for $where", async ({ useProjectVariable }) => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "claude-session-pool-")));
    temporaryDirectories.push(home);
    const project = join(home, "project");
    const elsewhere = join(home, "elsewhere");
    for (const directory of [project, elsewhere]) mkdirSync(directory);
    const { path } = standIns([{ kind: "interactive", pid: 1, cwd: project, name: "w1", sessionId: "s-1", status: "idle" }]);
    const env: Record<string, string> = { PATH: path, HOME: home };
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

  it("takes the process that started it for the dispatcher session", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "claude-session-pool-")));
    temporaryDirectories.push(home);
    const { path } = standIns([{ kind: "interactive", pid: process.pid, cwd: home, name: "boss", sessionId: "s-1", status: "idle" }]);

    const adopted = await withServer({ cwd: home, env: { PATH: path, HOME: home } }, (client) => callText(client, "adopt", { name: "boss" }));

    expect(adopted).toEqual({ isError: true, text: '"boss" is the dispatcher session itself and cannot be a slot.' });
  });
});

describe("the start-up command", () => {
  function fakeClaudeOnPath() {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "claude-session-pool-")));
    temporaryDirectories.push(directory);
    const script = join(directory, "claude");
    writeFileSync(script, `#!/bin/sh\nexec "${process.execPath}" -e 'console.log(JSON.stringify(process.argv.slice(1)))' -- "$@"\n`);
    chmodSync(script, 0o755);
    return { directory, env: { ...process.env, PATH: `${directory}:${dirname(process.execPath)}:/usr/bin:/bin` } };
  }

  it("passes its arguments to claude, followed by a configuration that attaches this server with its tools loaded up front", () => {
    const { env } = fakeClaudeOnPath();

    const output = execFileSync(join(repository, "bin", "claude-dispatcher"), ["--resume", "abc", "say hello"], { encoding: "utf8", env });

    const args = JSON.parse(output) as string[];
    expect(args.slice(0, 4)).toEqual(["--resume", "abc", "say hello", "--mcp-config"]);
    expect(JSON.parse(args[4]!)).toEqual({
      mcpServers: { "claude-session-pool": { command: "node", args: [entry], alwaysLoad: true, timeout: 86_400_000 } },
    });
    expect(args).toHaveLength(5);
  });

  it("finds the entry file when it is started through a symbolic link", () => {
    const { directory, env } = fakeClaudeOnPath();
    const link = join(directory, "dispatcher-link");
    symlinkSync(join(repository, "bin", "claude-dispatcher"), link);

    const args = JSON.parse(execFileSync(link, [], { encoding: "utf8", env })) as string[];

    const config = JSON.parse(args[1]!) as { mcpServers: Record<string, { args: string[] }> };
    expect(config.mcpServers["claude-session-pool"]?.args).toEqual([entry]);
  });
});
