/**
 * What Claude Code and a person run, as the plugin declares it: the server and the hooks as real processes, and the
 * declarations themselves. `claude`, `ps` and `osascript` are replaced by scripts on PATH, so no Claude Code session is
 * started and Terminal is not touched.
 */
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { temporaryDirectory } from "./temporary.ts";

// The start-up command resolves symbolic links on its way to the repository, so the path is compared resolved.
export const repository = realpathSync(dirname(dirname(dirname(fileURLToPath(import.meta.url)))));
export const pluginDirectory = join(repository, "plugin");

type Program = { type?: string; command: string; args: string[] };
type HookGroup = { matcher?: string; hooks: (Program & { asyncRewake?: boolean })[] };

export const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
export const manifest = readJson(join(pluginDirectory, ".claude-plugin", "plugin.json")) as {
  name: string;
  mcpServers: Record<string, Program & { alwaysLoad?: boolean; timeout?: number }>;
};
export const hooksFile = readJson(join(pluginDirectory, "hooks", "hooks.json")) as { modules: string[]; hooks: Record<string, HookGroup[]> };
export const declaredHooks = hooksFile.hooks;

/** The arguments Claude Code runs a declared program with: it puts the plugin's directory where the declaration names it. */
const argumentsOf = (program: Program) => program.args.map((argument) => argument.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginDirectory));

/** The variable in which the start-up command leaves the process ID of the session it starts. */
export const MARK = "CLAUDE_SESSION_POOL_DISPATCHER_PID";
/** These tests start the server and the hooks themselves, so this process stands where the attached session would. */
export const startedByStartupCommand = { [MARK]: String(process.pid) };

/** A user-level MCP registration and a project's MCP configuration, as files that nothing here may touch. */
export const USER_CONFIGURATION = `${JSON.stringify({ mcpServers: { "claude-session-pool": { command: "node", args: [join(repository, "src", "server.ts")] } } })}\n`;
export const PROJECT_CONFIGURATION = '{"mcpServers":{}}\n';

/** The arguments of every run of the stand-in `claude` that logs to `log`, one run to a line. */
export function runsLogged(log: string): string[] {
  return existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n") : [];
}

/** A directory of stand-ins for the programs the server runs, to put first on PATH. The stand-in `claude` logs its runs. */
export function standIns(sessions: unknown[], scripts: { osascript?: string } = {}) {
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
export async function withServer<T>(options: { cwd: string; env: Record<string, string> }, use: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: argumentsOf(manifest.mcpServers.pool!), stderr: "pipe", ...options }));
  try {
    return await use(client);
  } finally {
    await client.close();
  }
}

export async function callText(client: Client, name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  return { isError: result.isError === true, text: (result.content as { text: string }[]).map((part) => part.text).join("\n") };
}

/** Runs the hook the plugin declares for `event`, as Claude Code does: with the event on standard input, as a child of the session. */
export function runHookProcess(event: "SessionStart" | "PostCompact", input: Record<string, unknown>, home: string) {
  const ran = spawnSync(process.execPath, argumentsOf(declaredHooks[event]![0]!.hooks[0]!), {
    encoding: "utf8",
    input: JSON.stringify({ hook_event_name: event, ...input }),
    env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: home },
  });
  return { status: ran.status, stdout: ran.stdout, stderr: ran.stderr };
}
