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
import { SelfCompaction } from "./self-compaction.ts";

/** The environment variable in which the start-up command leaves the process ID of the session it starts. */
const DISPATCHER_MARK = "CLAUDE_SESSION_POOL_DISPATCHER_PID";

// The attached session is the process that started this one.
const sessionPid = process.ppid;
const adapters = {
  sessions: new ClaudeCli(run),
  terminal: new TerminalApp(run),
  processes: new SystemProcesses(run),
  transcripts: new FileTranscripts(join(homedir(), ".claude", "projects")),
  clock: {
    now: () => Date.now(),
    sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  },
};

// A session started from inside a dispatcher session inherits the mark, but its process ID differs from it.
const startedByStartupCommand = process.env[DISPATCHER_MARK] === String(sessionPid);

await createServer({
  selfCompaction: new SelfCompaction({ sessionPid, ...adapters }),
  pool: startedByStartupCommand
    ? new Pool({
        directory: process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
        dispatcherPid: sessionPid,
        rosterRoot: join(homedir(), ".claude-session-pool"),
        ...adapters,
      })
    : undefined,
}).connect(new StdioServerTransport());
