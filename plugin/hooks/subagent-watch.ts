// The subagent watch of the plugin's mod (docs/specs/claude-session-pool-subagent-watch.md): what a look does with the
// session's subagents, and the text of the report it makes of the stalled ones. The mod's module calls it at every
// look and decides whether the report can be made then.
//
// Like the module, this file imports nothing, and it passes Claude Code's interface for mods only to functions declared
// at its top. The type below states the part of that interface it uses, as measured on Claude Code 2.1.327.

/** A subagent as Claude Code lists it to a mod, with the fields the watch reads. */
type Listed = { id: string; type: string; description: string; status: string; kind: string; teammateId?: string; tokenCount: number };
export type WatchEngine = {
  /** The session's subagents and teammates, those that a subagent started among them. */
  agent: { list: () => Promise<Listed[]> };
  /** `transcriptPath` is empty in a session that keeps no transcript on this machine. */
  session: { info: () => Promise<{ transcriptPath: string }> };
  /** Lists a directory; rejects when it cannot. */
  fs: { list: (path: string) => Promise<{ name: string; size: number }[]> };
};

/** What the watch keeps of a subagent from one look to the next: a record lasts from the look that last found progress. */
type Seen = {
  /** How many looks in a row found it running a turn and found no progress in it. */
  quiet: number;
  /** The size of its transcript at the last look; undefined where it could not be read. */
  size: number | undefined;
  tokens: number;
  /** Whether this stall was reported. */
  reported: boolean;
};
/** The subagents that the last look found running a turn, by ID. */
export type Watch = Map<string, Seen>;
/** A line that is due for a report, with the record it reports. */
export type Due = { line: string; seen: Seen };

/** claude-session-pool-subagent-watch::US-001/AC-02: a stall is 11 looks in a row with no progress, after one that found the subagent running. */
const STALLED_AFTER = 11;
const FIRST_LINE =
  "Report of the subagent watch, written by the cc-session-pool plugin. It is not a message from the user. Subagents of this session that need attention:";
const LAST_LINE = "Nothing was done to any subagent. Each of these is reported once.";
const PART = /^[A-Za-z0-9 ._:-]{1,64}$/;
const ID = /^[A-Za-z0-9-]+$/;

/**
 * One look: takes the subagents that Claude Code lists as running a turn, teammates left out, counts the looks without
 * progress of each, and answers the lines that are due. A subagent that this look does not find running a turn is
 * forgotten, so its count starts anew; a list that Claude Code does not give finds none.
 */
export async function lookAtSubagents($: WatchEngine, watch: Watch): Promise<Due[]> {
  let running: Listed[];
  try {
    running = (await $.agent.list()).filter((agent) => agent.status === "running" && agent.kind === "local_agent" && agent.teammateId === undefined);
  } catch {
    running = [];
  }
  for (const id of watch.keys()) if (!running.some((agent) => agent.id === id)) watch.delete(id);
  if (running.length === 0) return [];
  const sizes = await transcriptSizes($);
  const due: Due[] = [];
  for (const agent of running) {
    const size = sizes.get(`agent-${agent.id}.jsonl`);
    const before = watch.get(agent.id);
    // claude-session-pool-plugin::REQ-007/AC-01: a size that cannot be read leaves the token count alone to count.
    const progress = before === undefined || before.tokens !== agent.tokenCount || (before.size !== undefined && size !== undefined && before.size !== size);
    const seen: Seen = progress ? { quiet: 0, size, tokens: agent.tokenCount, reported: false } : { ...before, quiet: before.quiet + 1, size };
    watch.set(agent.id, seen);
    if (seen.quiet >= STALLED_AFTER && !seen.reported) due.push({ line: stalledLine(agent, seen.quiet), seen });
  }
  return due;
}

/** The sizes of the subagents' transcripts by file name; none where Claude Code gives no transcript or the directory cannot be listed. */
async function transcriptSizes($: WatchEngine): Promise<Map<string, number>> {
  try {
    const { transcriptPath } = await $.session.info();
    if (!transcriptPath.endsWith(".jsonl")) return new Map();
    const entries = await $.fs.list(`${transcriptPath.slice(0, -".jsonl".length)}/subagents`);
    return new Map(entries.map(({ name, size }) => [name, size]));
  } catch {
    return new Map();
  }
}

function stalledLine(agent: Listed, quiet: number): string {
  const id = ID.test(agent.id) ? agent.id : "a subagent";
  const about = [PART.test(agent.type) ? agent.type : undefined, PART.test(agent.description) ? `"${agent.description}"` : undefined].filter((part) => part !== undefined);
  const named = about.length === 0 ? id : `${id} (${about.join(", ")})`;
  return `- ${named}: running, and neither its transcript nor its token count changed for ${quiet} minutes.`;
}

/** The text of the report of the lines that are due at one look. */
export function reportText(due: Due[]): string {
  return [FIRST_LINE, ...due.map(({ line }) => line), LAST_LINE].join("\n");
}
