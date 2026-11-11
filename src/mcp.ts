import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Outcome, Pool } from "./pool.ts";

const name = z
  .string()
  .describe("The slot's name, for example w1: 1 to 64 letters, digits, '.', '_' or '-', starting with a letter or digit.");
const model = z.string().optional().describe("Model for the new session. Default: opus.");
const permissionMode = z
  .string()
  .optional()
  .describe("Permission mode for the new session: auto, acceptEdits, default, plan or dontAsk. Default: auto.");
const force = z.boolean().optional().describe("Close the session even when it is busy or waiting. Default: false.");

const INSTRUCTIONS =
  "Manages the pool of worker sessions of the dispatcher session this server is attached to: interactive Claude Code " +
  "sessions in Terminal windows, started in the dispatcher session's directory. A tool acts only on slots in the pool's " +
  "roster. A refusal or an unconfirmed step is returned as an error whose text gives the reason.";

/** The MCP server that offers a pool's operations as tools. */
export function createServer(pool: Pool): McpServer {
  const server = new McpServer({ name: "claude-session-pool", version: "0.1.0" }, { instructions: INSTRUCTIONS });

  server.registerTool(
    "init",
    {
      description: "Open several worker sessions, one per name, each in its own Terminal window. Continues past a name that fails and reports every outcome.",
      inputSchema: { names: z.array(z.string()).describe("Slot names to open, in order."), model, permissionMode },
    },
    async (args) => reply(await pool.init(args)),
  );
  server.registerTool(
    "open",
    {
      description: "Open one worker session in a new Terminal window under this name, wait until it is idle and add it to the roster.",
      inputSchema: { name, model, permissionMode },
    },
    async (args) => reply(await pool.open(args)),
  );
  server.registerTool(
    "adopt",
    {
      description: "Add a session the owner opened by hand, in this directory and in a Terminal window, to the roster.",
      inputSchema: { name },
    },
    async (args) => reply(await pool.adopt(args)),
  );
  server.registerTool(
    "status",
    { description: "List every slot with its state: idle, busy, waiting (and for what), gone or ambiguous.", inputSchema: {} },
    async () => reply(await pool.status()),
  );
  server.registerTool(
    "clear",
    {
      description: "Reset a slot's conversation by typing /clear into its Terminal tab. Returns once the slot's session ID has changed.",
      inputSchema: { name },
    },
    async (args) => reply(await pool.clear(args)),
  );
  server.registerTool(
    "compact",
    {
      description: "Compact a slot's conversation by typing /compact into its Terminal tab. Returns once its transcript records the compaction, or 'unconfirmed' with the reason.",
      inputSchema: { name, timeoutMinutes: z.number().optional().describe("How long to wait for the compaction. Default: 30.") },
    },
    async (args) => reply(await pool.compact(args)),
  );
  server.registerTool(
    "close",
    {
      description:
        "End a slot's session and remove the slot from the roster. Closes the Terminal window only when this server opened it for the session being ended and it has no other tab; otherwise leaves it open and says so.",
      inputSchema: { name, force },
    },
    async (args) => reply(await pool.close(args)),
  );
  server.registerTool(
    "recycle",
    {
      description: "Close a slot's session and open a new one under the same name: a new process and an empty conversation.",
      inputSchema: { name, force, model, permissionMode },
    },
    async (args) => reply(await pool.recycle(args)),
  );
  server.registerTool(
    "release",
    {
      description: "Remove a slot from the roster without touching its session, for example to undo an adopt.",
      inputSchema: { name },
    },
    async (args) => reply(await pool.release(args)),
  );

  return server;
}

function reply(outcome: Outcome) {
  return { content: [{ type: "text" as const, text: outcome.text }], isError: !outcome.ok };
}
