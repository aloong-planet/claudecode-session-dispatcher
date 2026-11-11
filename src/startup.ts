import { homedir } from "node:os";
import { basename, join } from "node:path";
import { ClaudeCli } from "./adapters/claude-cli.ts";
import { run } from "./adapters/exec.ts";
import { FileTranscripts, type NameState } from "./adapters/transcripts.ts";
import type { SessionLister } from "./ports.ts";
import { messageOf } from "./report.ts";
import { Refusal } from "./validate.ts";

export type StartupDeps = {
  /** The directory the start-up command is run in. */
  directory: string;
  /** The absolute path of the server's entry file. */
  entry: string;
  sessions: SessionLister;
  /** Whether the transcript of a session shows a name that was given to it. */
  nameState: (sessionId: string) => NameState;
  /** Prints one line for the person who ran the command. */
  notice: (line: string) => void;
};

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Options with which the command adds no name. */
const LEAVES_THE_NAME_ALONE = new Set([
  // A name is given.
  ...["-n", "--name"],
  // A session is resumed whose transcript the command cannot look up from the arguments, or a resumed session is copied.
  ...["-c", "--continue", "--from-pr", "--teleport", "--fork-session"],
  // No new interactive session starts in this terminal.
  ...["-p", "--print", "--bg", "--background", "--cloud", "--environment", "--desktop", "-h", "--help", "-v", "--version"],
]);

/**
 * The arguments the start-up command adds after the ones it was given: a name where the dispatcher session would
 * otherwise get a generated one, then the MCP configuration that attaches this server.
 */
export async function startupArguments(given: string[], deps: StartupDeps): Promise<string[]> {
  const server = { command: "node", args: [deps.entry], alwaysLoad: true, timeout: 86_400_000 };
  const configuration = ["--mcp-config", JSON.stringify({ mcpServers: { "claude-session-pool": server } })];
  // One word, so that a name that starts with a hyphen is not read as an option.
  return callsForDefaultName(given, deps) ? [`--name=${await defaultName(deps)}`, ...configuration] : configuration;
}

function callsForDefaultName(given: string[], deps: StartupDeps): boolean {
  if (given.some((argument) => LEAVES_THE_NAME_ALONE.has(optionIn(argument)))) return false;
  const resume = resumeOption(given);
  if (!resume) return true;
  if (resume.value === undefined || !SESSION_ID.test(resume.value)) return false;
  const state = deps.nameState(resume.value);
  if (state === "unknown") {
    deps.notice(`claude-dispatcher: the transcript of session ${resume.value} could not be found or read, so no name was added.`);
  }
  return state === "unnamed";
}

/** The option an argument gives, without a value that is attached to it with `=`. */
function optionIn(argument: string): string {
  const attached = argument.startsWith("--") ? argument.indexOf("=") : -1;
  return attached === -1 ? argument : argument.slice(0, attached);
}

/** The resume option among the arguments, with the value it was given, if any. */
function resumeOption(given: string[]): { value?: string } | undefined {
  for (const [index, argument] of given.entries()) {
    if (argument.startsWith("--resume=")) return { value: argument.slice("--resume=".length) };
    if (argument === "--resume" || argument === "-r") {
      const next = given[index + 1];
      return next === undefined || next.startsWith("-") ? {} : { value: next };
    }
  }
  return undefined;
}

async function defaultName(deps: StartupDeps): Promise<string> {
  const directoryName = basename(deps.directory);
  if (directoryName === "") {
    throw new Refusal(`The directory ${deps.directory} has no name, so no session name was built from it. Nothing was started. Pass -n <name>.`);
  }
  // The name travels to `claude` on a line of its own, so a line break in it would turn into further arguments.
  if (/\p{Cc}/u.test(directoryName)) {
    throw new Refusal("The name of this directory contains a control character, so no session name was built from it. Nothing was started. Pass -n <name>.");
  }
  const name = `${directoryName}-dispatcher`;
  let sessions;
  try {
    sessions = await deps.sessions.list();
  } catch (error) {
    throw new Refusal(
      `The sessions on this Mac could not be listed (${messageOf(error)}), so it could not be checked whether a live session already answers to "${name}". Nothing was started. Pass -n <name> to choose the name yourself.`,
    );
  }
  const taken = sessions.find((session) => session.pid !== undefined && session.name === name);
  if (taken) {
    throw new Refusal(
      `A live session already answers to "${name}" (pid ${taken.pid}, in ${taken.cwd}). Nothing was started. Pass -n <name> to start under another name.`,
    );
  }
  return name;
}

/** Prints the added arguments, one to a line, for the start-up command to read; on a refusal prints the reason and fails. */
export async function main(given: string[]): Promise<void> {
  try {
    const transcripts = new FileTranscripts(join(homedir(), ".claude", "projects"));
    const added = await startupArguments(given, {
      directory: process.cwd(),
      entry: join(import.meta.dirname, "server.ts"),
      sessions: new ClaudeCli(run),
      nameState: (sessionId) => transcripts.nameState(sessionId),
      notice: (line) => console.error(line),
    });
    process.stdout.write(added.map((argument) => `${argument}\n`).join(""));
  } catch (error) {
    console.error(`claude-dispatcher: ${messageOf(error)}`);
    process.exitCode = 1;
  }
}
