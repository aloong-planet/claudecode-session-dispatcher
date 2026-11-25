// The activity record of the plugin's mod (docs/specs/claude-session-pool-plugin.md, claude-session-pool-plugin::REQ-008):
// what the mod keeps of its session's activity between the moments it writes it, and the record it writes, the file
// `~/.claude-session-pool/activity/<sessionId>.json`, when Claude Code loads it and at every look.
//
// Like the module, this file imports nothing, and it passes Claude Code's interface for mods only to functions declared
// at its top. The type below states the part of that interface it uses, as measured on Claude Code 2.1.327: `$.fs.write`
// makes the directories a path needs and writes the file in place. `$.fs` has no rename, so the record is not replaced
// atomically; a reader treats a record it cannot read whole as absent.

export type ActivityEngine = {
  env: { get: (name: string) => Promise<string | undefined> };
  fs: { read: (path: string) => Promise<string>; write: (path: string, text: string) => Promise<unknown> };
  session: { id: () => Promise<string>; usage: () => Promise<{ context: { tokens?: number } }> };
  clock: { now: () => Promise<number> };
};

/** A tool call of the main conversation that has started and not returned; `startedAt` is unset until the clock answers. */
type Call = { tool: string; startedAt: number | undefined };

/** What the mod keeps of the session's activity, in the memory of the session's process: a reload of the mod starts it anew. */
export type Activity = {
  /** When the mod last found progress in the session; the time it was loaded until it finds some. */
  progressAt: number;
  /** The session IDs of the conversations in which a turn of the main conversation has started, as far as the mod knows. */
  worked: Set<string>;
  /** When the last turn of the main conversation ended in each conversation, by its session ID. */
  lastTurnEnded: Map<string, number>;
  /** The session IDs whose standing record the mod has read since it was loaded. */
  read: Set<string>;
  /** The tool calls of the main conversation that are running, in the order they started. */
  calls: Set<Call>;
  /** The token count of the session's context that the last look found; undefined where it found none. */
  tokens: number | undefined;
};

const DIRECTORY = ".claude-session-pool/activity";
const SESSION_ID = /^[A-Za-z0-9-]+$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export const newActivity = (): Activity => ({ progressAt: 0, worked: new Set(), lastTurnEnded: new Map(), read: new Set(), calls: new Set(), tokens: undefined });

/** The path of the record of `sessionId`, where the session ID can name a file and the home directory is known. */
async function recordPath($: ActivityEngine, sessionId: string): Promise<string | undefined> {
  if (!SESSION_ID.test(sessionId)) return undefined;
  const home = await $.env.get("HOME");
  return home === undefined || home === "" ? undefined : `${home}/${DIRECTORY}/${sessionId}.json`;
}

const isTime = (value: unknown): boolean => typeof value === "string" && TIME.test(value) && !Number.isNaN(Date.parse(value));

/** Whether `value` is an activity record of `sessionId` in the form the spec states ("State files"). */
export function isRecordOf(value: unknown, sessionId: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const { toolCall } = record;
  return (
    record.version === 1 &&
    record.sessionId === sessionId &&
    isTime(record.writtenAt) &&
    typeof record.turnRunning === "boolean" &&
    typeof record.worked === "boolean" &&
    isTime(record.progressAt) &&
    (record.lastTurnEndedAt === undefined || isTime(record.lastTurnEndedAt)) &&
    (toolCall === undefined ||
      (typeof toolCall === "object" &&
        toolCall !== null &&
        typeof (toolCall as Record<string, unknown>).tool === "string" &&
        isTime((toolCall as Record<string, unknown>).startedAt)))
  );
}

/** When Claude Code loads the mod: the time of loading stands as the time of progress until the mod finds some. */
export async function loadActivity($: ActivityEngine, activity: Activity): Promise<void> {
  await progressed($, activity);
}

/**
 * Before the mod first writes the record of a session ID, once it is loaded (claude-session-pool-plugin::REQ-008/AC-03): a
 * turn that the standing record of that session ID says has started is taken from it, at load as when the session goes
 * to another conversation, as by `/resume`.
 */
async function readStanding($: ActivityEngine, activity: Activity, sessionId: string, path: string): Promise<void> {
  if (activity.read.has(sessionId)) return;
  activity.read.add(sessionId);
  try {
    const standing: unknown = JSON.parse(await $.fs.read(path));
    if (isRecordOf(standing, sessionId) && (standing as { worked: boolean }).worked) activity.worked.add(sessionId);
  } catch {
    // No record that can be read: none stands.
  }
}

/** The mod found progress in the session now (claude-session-pool-plugin::REQ-007/AC-02). */
export async function progressed($: ActivityEngine, activity: Activity): Promise<void> {
  try {
    activity.progressAt = Math.max(activity.progressAt, await $.clock.now());
  } catch {
    // Without the time the progress is not recorded.
  }
}

/** A turn of the main conversation started: progress, and a turn has started in the conversation it runs in. */
export async function turnStarted($: ActivityEngine, activity: Activity): Promise<void> {
  await progressed($, activity);
  try {
    activity.worked.add(await $.session.id());
  } catch {
    // Without the session ID the mod cannot tell which conversation the turn is of.
  }
}

/** A turn of the main conversation ended: progress, and the end of the last turn of its conversation. */
export async function turnEnded($: ActivityEngine, activity: Activity): Promise<void> {
  try {
    const at = await $.clock.now();
    activity.progressAt = Math.max(activity.progressAt, at);
    activity.lastTurnEnded.set(await $.session.id(), at);
  } catch {
    // Without the time or the session ID the end is not recorded.
  }
}

/** A tool call of the main conversation started: progress, and the call runs from now until `callReturned`. */
export function callStarted($: ActivityEngine, activity: Activity, tool: string): Call {
  const call: Call = { tool, startedAt: undefined };
  activity.calls.add(call);
  void (async () => {
    try {
      call.startedAt = await $.clock.now();
      activity.progressAt = Math.max(activity.progressAt, call.startedAt);
    } catch {
      // Without the time the call is not recorded as running.
    }
  })();
  return call;
}

export function callReturned($: ActivityEngine, activity: Activity, call: Call): void {
  activity.calls.delete(call);
  void progressed($, activity);
}

/**
 * What a look does with the record: notes the progress it found, in a subagent or in a token count of the session's
 * context that differs from the one the look before found, and writes the record. A look that finds no token count, as
 * before the session's first model response, compares none, nor does the look after it.
 */
export async function lookAtActivity($: ActivityEngine, activity: Activity, { turnRunning, subagentProgressed }: { turnRunning: boolean; subagentProgressed: boolean }): Promise<void> {
  let tokens: number | undefined;
  try {
    tokens = (await $.session.usage()).context.tokens;
  } catch {
    tokens = undefined;
  }
  const tokensChanged = tokens !== undefined && activity.tokens !== undefined && tokens !== activity.tokens;
  activity.tokens = tokens;
  if (subagentProgressed || tokensChanged) await progressed($, activity);
  await writeActivity($, activity, turnRunning);
}

/** Writes the record for the session's present session ID (claude-session-pool-plugin::REQ-008/AC-01), in place. */
export async function writeActivity($: ActivityEngine, activity: Activity, turnRunning: boolean): Promise<void> {
  try {
    const sessionId = await $.session.id();
    const path = await recordPath($, sessionId);
    if (path === undefined) return;
    await readStanding($, activity, sessionId, path);
    const writtenAt = await $.clock.now();
    const running = [...activity.calls].filter((call): call is Call & { startedAt: number } => call.startedAt !== undefined);
    const longest = running.reduce<(typeof running)[number] | undefined>((first, call) => (first === undefined || call.startedAt < first.startedAt ? call : first), undefined);
    const ended = activity.lastTurnEnded.get(sessionId);
    const record = {
      version: 1,
      sessionId,
      writtenAt: iso(writtenAt),
      turnRunning,
      worked: activity.worked.has(sessionId),
      progressAt: iso(activity.progressAt),
      ...(ended === undefined ? {} : { lastTurnEndedAt: iso(ended) }),
      ...(longest === undefined ? {} : { toolCall: { tool: longest.tool, startedAt: iso(longest.startedAt) } }),
    };
    await $.fs.write(path, `${JSON.stringify(record)}\n`);
  } catch {
    // The record is written again at the next look.
  }
}

const iso = (ms: number): string => new Date(ms).toISOString();
