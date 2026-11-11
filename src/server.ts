import { homedir } from "node:os";
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ClaudeCli } from "./adapters/claude-cli.ts";
import { run } from "./adapters/exec.ts";
import { SystemProcesses } from "./adapters/processes.ts";
import { TerminalApp } from "./adapters/terminal-app.ts";
import { FileTranscripts } from "./adapters/transcripts.ts";
import { createServer } from "./mcp.ts";
import { Pool } from "./pool.ts";

const pool = new Pool({
  directory: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
  dispatcherPid: process.ppid,
  rosterRoot: join(homedir(), ".claude-session-pool"),
  sessions: new ClaudeCli(run),
  terminal: new TerminalApp(run),
  processes: new SystemProcesses(run),
  transcripts: new FileTranscripts(join(homedir(), ".claude", "projects")),
  clock: {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  },
});

await createServer(pool).connect(new StdioServerTransport());
