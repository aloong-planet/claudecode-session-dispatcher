import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Pool } from "./pool.ts";
import type { Outcome } from "./report.ts";
import type { SelfCompaction } from "./self-compaction.ts";

const name = z
  .string()
  .describe("The slot's name, for example w1: 1 to 64 letters, digits, '.', '_' or '-', starting with a letter or digit.");
const model = z.string().optional().describe("Model for the new session. Default: opus.");
const permissionMode = z
  .string()
  .optional()
  .describe("Permission mode for the new session: auto, acceptEdits, default, plan or dontAsk. Default: auto.");
const force = z.boolean().optional().describe("Close the session even when it is busy or waiting. Default: false.");

const REPORTING = "A refusal or an unconfirmed step is returned as an error whose text gives the reason.";

const POOL_INSTRUCTIONS =
  "Manages the pool of worker sessions of the dispatcher session this server is attached to: interactive Claude Code " +
  "sessions in Terminal windows, started in the dispatcher session's directory. A pool tool acts only on slots in the " +
  "pool's roster. compact_self compacts the conversation of this session itself. " +
  REPORTING;

const SELF_INSTRUCTIONS =
  "Offers one tool, compact_self, with which the session this server is attached to compacts its own conversation. It " +
  "reaches no other session. " +
  REPORTING;

/** What a server offers: the self-compaction of the attached session, and a pool's operations when that session is a dispatcher session. */
export type Offer = { selfCompaction: SelfCompaction; pool?: Pool };

/** The MCP server that offers these operations as tools. */
export function createServer({ selfCompaction, pool }: Offer): McpServer {
  const server = new McpServer(
    { name: "claude-session-pool", version: "0.1.0" },
    { instructions: pool ? POOL_INSTRUCTIONS : SELF_INSTRUCTIONS },
  );

  server.registerTool(
    "compact_self",
    {
      description:
        "Compact this session's own conversation once the current turn ends, so call this as the last step of a turn and then end the turn. When the compaction has finished, this session is woken and carries on from its summary. The result says how the compaction was arranged. Takes no arguments and reaches no other session.",
      inputSchema: {},
    },
    async () => reply(await selfCompaction.request()),
  );
  if (pool) registerPoolTools(server, pool);

  return server;
}

function registerPoolTools(server: McpServer, pool: Pool): void {
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
      description:
        "Reset a slot's conversation with /clear. Where the plugin's hooks run in the slot's session, leaves an order that the plugin's mod runs and types nothing; otherwise types /clear into its Terminal tab. Returns once the slot's session ID has changed, and says which way it was delivered.",
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
    "restore",
    {
      description:
        "Bring back the conversations of slots whose sessions are gone: each in a new Terminal window under the slot's name, resuming the conversation the pool's look record names, when that conversation had work in it. Without names, acts on every such slot and names the other gone slots as not restored. A restored session starts idle and is sent nothing.",
      inputSchema: {
        names: z.array(z.string()).optional().describe("Slot names to restore, in order. Default: every gone slot whose conversation had work in it."),
        model: z.string().optional().describe("Model for the restored sessions. Default: the one the roster records for the slot, else none is passed."),
        permissionMode: z
          .string()
          .optional()
          .describe("Permission mode for the restored sessions: auto, acceptEdits, default, plan or dontAsk. Default: the one the roster records for the slot, else none is passed."),
      },
    },
    async (args) => reply(await pool.restore(args)),
  );
  server.registerTool(
    "release",
    {
      description: "Remove a slot from the roster without touching its session, for example to undo an adopt.",
      inputSchema: { name },
    },
    async (args) => reply(await pool.release(args)),
  );
}

function reply(outcome: Outcome) {
  return { content: [{ type: "text" as const, text: outcome.text }], isError: !outcome.ok };
}
