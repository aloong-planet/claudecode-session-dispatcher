// The plugin's mod: the hooks module that Claude Code loads into a session's own process.
//
// In an interactive session it answers a call to the server's tool compact_self in the server's place, has Claude
// Code compact the conversation once the turn has ended, and then starts a turn itself. It types nothing and leaves
// no wake request, so the plugin's PostCompact hook stays quiet after such a compaction, unless an earlier call that
// the server handled left one in the conversation: then the hook wakes the session, and the mod does not. In a
// session this module is not loaded in, the call reaches the server, which types /compact and leaves the waking to
// that hook.
//
// It also runs /clear for the server's `clear` tool. The server leaves a clear order, a file named after the session's
// session ID, in a directory that the mod has Claude Code watch; when Claude Code tells the mod of a change there, and
// when a turn ends, the mod looks for the order of the session's present session ID and, if it stands and is less than a
// minute old, has Claude Code run /clear once no turn is running. Nothing is typed into the window and Terminal is not
// scripted; whether this works while the screen is locked has not been measured. A session that this module is not
// loaded in has no such order acted on: the server sees no change of the session ID, and reports that the clear is not
// confirmed.
//
// In every session, interactive or not, it also offers a tool of its own, context_usage, which answers the session
// with the size of its own context as Claude Code's status line has it. A session this module is not loaded in has no
// such tool, nor has one in which Claude Code refuses it, such as a session with no built-in tools: there the mod
// writes Claude Code's reason into Claude Code's debug log alone.
//
// The module imports nothing: Claude Code gives a mod neither Node's modules nor the repository's packages. The types
// below state the part of Claude Code's interface for mods that it uses, as measured on Claude Code 2.1.322; what the
// clear order uses (the watch paths of classic.SessionStart, classic.FileChanged and $.command.run) was measured on 2.1.327.

/** The context window's figures as the status line has them; `tokens` and `percent` are absent until the window's first response. */
type ContextFigures = { tokens?: number; window: number; percent?: number };
type Engine = {
  env: { get: (name: string) => Promise<string | undefined> };
  /** Reads a file's text; rejects when it cannot. */
  fs: { read: (path: string) => Promise<string> };
  /** Runs a slash command as if the user typed it, once the session is idle. Rejects when Claude Code does not take it. */
  command: { run: (args: { command: string }) => Promise<unknown> };
  /** Declares a tool of the mod's own, which the model calls as `mcp__<plugin>__<name>`. */
  tool: { register: (spec: { name: string; description: string; inputSchema: Record<string, unknown>; isDeferred: boolean }) => Promise<unknown> };
  session: {
    usage: () => Promise<{ context: ContextFigures }>;
    id: () => Promise<string>;
    /** Rejects while a turn is in progress, and when the user cancels the compaction. */
    compact: (args: Record<string, never>) => Promise<{ skip?: string }>;
  };
  /** Starts a turn with `text` once the session is idle. */
  prompt: { submit: (args: { text: string }) => Promise<unknown> };
  clock: { now: () => Promise<number>; after: (ms: number, run: () => void) => unknown };
  /** Appends a line to the transcript, or with `{ to: "debug" }` to Claude Code's debug log alone (measured on 2.1.325). */
  ui: { log: (text: string, options?: { to?: "transcript" | "debug" }) => void };
};
type Hook<Input, Answer = unknown> = ($: Engine, e: Input, next: (e: Input) => Promise<Answer>) => Promise<unknown>;
/** Why a turn ended: with the model's answer, by the user's interrupt, on a refusal by the model, or on an API error. */
type TurnEnd = { agentId?: string; reason: "answer" | "aborted" | "refusal" | "error" };
type On = {
  (event: "session.start", hook: Hook<{ isInteractive: boolean }>): void;
  (event: "tool.call", hook: Hook<{ tool: string; agentId?: string }>): void;
  (event: "turn.start", hook: Hook<{ agentId?: string }>): void;
  (event: "turn.complete", hook: Hook<TurnEnd>): void;
  /** Claude Code's `SessionStart` hooks, which may name paths to watch; `next` resolves to what the hooks before this one returned. */
  (event: "classic.SessionStart", hook: Hook<{ source?: string }, { watchPaths?: string[] } | undefined>): void;
  /** Claude Code tells of a file that was added, changed or removed under a path that a `SessionStart` hook named. */
  (event: "classic.FileChanged", hook: Hook<{ file_path: string; event: string }>): void;
};

/** The server's tool, under the name a session sees it by. */
const TOOL = "mcp__plugin_cc-session-pool_pool__compact_self";
/** The same sentence as the plugin's hook hands over; `tests/claude-session-pool-compact-self.test.ts` holds both to it. */
const WAKE_SENTENCE = "The compaction this session requested with compact_self has finished. This is not an error. Continue the work that was in progress.";
const ANSWER =
  "The conversation of this session is compacted when this turn ends, with nothing typed into its window, so end the turn now. When the compaction has finished, this session is woken.";
const SUBAGENT_REFUSAL = "Only the session itself can call compact_self; a subagent cannot. Nothing was done.";
/** The mod's own tool, as it registers it. */
const USAGE_SPEC = {
  name: "context_usage",
  description:
    "Reports the size of this session's own context: the input tokens of its latest model request, the context window of its model, and the share of the window they fill. Takes no arguments.",
  inputSchema: { type: "object", properties: {} },
  isDeferred: false,
};
/** The mod's own tool, under the name a session sees it by: Claude Code puts the plugin's name in front of it. */
const USAGE_TOOL = "mcp__cc-session-pool__context_usage";
const USAGE_EXPLANATION =
  "These are the input tokens of this session's latest model request, uncached, cache-written and cache-read together, as Claude Code's status line gives them (context_window.total_input_tokens).";
const USAGE_SUBAGENT_REFUSAL = "Only the session itself can call context_usage; a subagent cannot.";
const REGISTRATION_REFUSED = "context_usage is not offered in this session: Claude Code refused to register it:";
const SIZE_NOT_KNOWN =
  "The size of this session's context is not known: Claude Code does not have all of its figures. It has none before the first model response after the session starts or its conversation is compacted.";
/** The server's wake requests, under the user's home directory, in the form `src/wake.ts` writes them. */
const WAKE_REQUESTS = ".claude-session-pool/wake-requests";
/** The server's clear orders, in the same place and the same form. */
const CLEAR_ORDERS = ".claude-session-pool/clear-orders";
/** How long after the server wrote it a clear order is acted on; the server stops waiting for it after 30 seconds. */
const ORDER_LIFETIME_MS = 60_000;
const SESSION_ID = /^[A-Za-z0-9-]+$/;
const RETRY_MS = 2_000;
const MAX_RETRIES = 5;

/** A compaction the session asked for and that has not run yet, with the conversation it was asked for. */
type Request = { sessionId: string };

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** What Claude Code reported, without the prefix it puts in front of a mod's failed call and without a closing full stop. */
const reasonOf = (reported: string): string => reported.replace(/^.*\$\.session\.compact: /, "").replace(/\.+$/, "");

/** What the mod keeps for the session it runs in, in the memory of the session's process. */
type State = {
  isInteractive: boolean;
  isTurnRunning: boolean;
  request: Request | undefined;
  /** Counts the turn ends at which a compaction was due, so that an attempt left over from an earlier one stops. */
  due: number;
  /** The session ID that the mod asked Claude Code to clear the session of, so that its order is acted on once. */
  clearing: string | undefined;
};

// Claude Code lets a mod pass `$` only to functions declared at the top of the module, so these two are not closures
// of `register` and take the session's state as an argument.

async function wake($: Engine, text: string): Promise<void> {
  try {
    await $.prompt.submit({ text });
  } catch {
    // The prompt was not taken. There is no other way to start a turn, so the session stays idle.
  }
}

/**
 * Whether the conversation has a wake request that the plugin's hook will act on after the next compaction: a file
 * the hook reads as one (`WakeState.wakeRequestedAt`). One that cannot be read counts as absent, as it does for the hook.
 */
async function hasWakeRequest($: Engine, sessionId: string): Promise<boolean> {
  if (!SESSION_ID.test(sessionId)) return false;
  try {
    const home = await $.env.get("HOME");
    if (home === undefined || home === "") return false;
    const record: unknown = JSON.parse(await $.fs.read(`${home}/${WAKE_REQUESTS}/${sessionId}.json`));
    if (typeof record !== "object" || record === null || Array.isArray(record)) return false;
    const { version, sessionId: named, requestedAt } = record as Record<string, unknown>;
    return version === 1 && named === sessionId && typeof requestedAt === "string" && !Number.isNaN(Date.parse(requestedAt));
  } catch {
    return false;
  }
}

/**
 * The session ID that a standing clear order names, if one does for the session's present session ID: a file the server
 * leaves (`WakeState.writeClearOrder`), named after the ID, that holds that ID and is less than a minute old. One that
 * cannot be read counts as absent.
 */
async function orderedSessionId($: Engine): Promise<string | undefined> {
  try {
    const sessionId = await $.session.id();
    const home = await $.env.get("HOME");
    if (!SESSION_ID.test(sessionId) || home === undefined || home === "") return undefined;
    const record: unknown = JSON.parse(await $.fs.read(`${home}/${CLEAR_ORDERS}/${sessionId}.json`));
    if (typeof record !== "object" || record === null || Array.isArray(record)) return undefined;
    const { version, sessionId: named, requestedAt } = record as Record<string, unknown>;
    if (version !== 1 || named !== sessionId || typeof requestedAt !== "string") return undefined;
    const age = (await $.clock.now()) - Date.parse(requestedAt);
    return age >= 0 && age < ORDER_LIFETIME_MS ? sessionId : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Has Claude Code run /clear when a clear order stands for the session and no turn is running; a turn that ends brings it
 * up again. Claude Code rejects the command while it is asked for from the event hook that is still running, which another
 * plugin's slower hook under this one can keep so, so the call is made from a timer and tried again a little later.
 */
async function clearIfOrdered($: Engine, state: State, attempt: number): Promise<void> {
  if (state.isTurnRunning) return;
  const sessionId = await orderedSessionId($);
  if (sessionId === undefined || sessionId === state.clearing || state.isTurnRunning) return;
  state.clearing = sessionId;
  try {
    await $.command.run({ command: "clear" });
  } catch {
    // Claude Code did not take the command, and queued nothing. The order is looked at again while it stands.
    state.clearing = undefined;
    if (attempt < MAX_RETRIES) $.clock.after(RETRY_MS, () => void clearIfOrdered($, state, attempt + 1));
  }
}

async function compact($: Engine, state: State, asked: Request, turnEnd: number, attempt: number): Promise<void> {
  if (state.request !== asked || state.due !== turnEnd) return;
  let reported: string;
  try {
    if ((await $.session.id()) !== asked.sessionId) {
      // The conversation was cleared: the request was for the one before it.
      state.request = undefined;
      return;
    }
    // Read before the compaction: the hook deletes the request as the compaction finishes.
    const hookWakes = await hasWakeRequest($, asked.sessionId);
    const { skip } = await $.session.compact({});
    state.request = undefined;
    if (skip !== undefined) await wake($, notCompleted(skip));
    else if (!hookWakes) await wake($, WAKE_SENTENCE);
    return;
  } catch (error) {
    reported = messageOf(error);
  }
  if (state.request !== asked) return;
  if (/Compaction canceled\.$/.test(reported)) {
    // The owner pressed Escape during the compaction, and takes over from here.
    state.request = undefined;
    return;
  }
  if (state.isTurnRunning || /compacts between turns/.test(reported)) {
    // A turn got in first. After the last attempt the request stands, and the end of that turn brings it up again.
    if (attempt < MAX_RETRIES) $.clock.after(RETRY_MS, () => void compact($, state, asked, turnEnd, attempt + 1));
    return;
  }
  state.request = undefined;
  await wake($, notCompleted(reported));
}

/** The answer to a call to the mod's own tool: the figures Claude Code has at that moment. */
async function contextUsage($: Engine): Promise<{ result: string } | { deny: string }> {
  let context: ContextFigures;
  try {
    ({ context } = await $.session.usage());
  } catch (error) {
    return { deny: `The size of this session's context could not be read: ${messageOf(error)}` };
  }
  const { tokens, window, percent } = context;
  if (tokens === undefined || percent === undefined) return { deny: SIZE_NOT_KNOWN };
  return { result: `Context: ${tokens} input tokens of a ${window}-token window (${percent}%). ${USAGE_EXPLANATION}` };
}

export const register = (on: On): void => {
  const state: State = { isInteractive: false, isTurnRunning: false, request: undefined, due: 0, clearing: undefined };

  on("classic.SessionStart", async ($, e, next) => {
    const answered = await next(e);
    const home = await $.env.get("HOME");
    if (home === undefined || home === "") return answered;
    return { ...answered, watchPaths: [...(answered?.watchPaths ?? []), `${home}/${CLEAR_ORDERS}`] };
  });

  on("classic.FileChanged", async ($, e, next) => {
    $.clock.after(0, () => void clearIfOrdered($, state, 0));
    return next(e);
  });

  on("session.start", async ($, e, next) => {
    state.isInteractive = e.isInteractive;
    try {
      await $.tool.register(USAGE_SPEC);
    } catch (error) {
      // The session goes without context_usage; the start of the session and compact_self go on as without it.
      $.ui.log(`${REGISTRATION_REFUSED} ${messageOf(error)}`, { to: "debug" });
    }
    return next(e);
  });

  on("tool.call", async ($, e, next) => {
    if (e.tool === USAGE_TOOL) return e.agentId === undefined ? contextUsage($) : { deny: USAGE_SUBAGENT_REFUSAL };
    if (e.tool !== TOOL || !state.isInteractive) return next(e);
    if (e.agentId !== undefined) return { deny: SUBAGENT_REFUSAL };
    let sessionId: string;
    try {
      sessionId = await $.session.id();
    } catch {
      // Without the conversation's ID the mod could not tell a cleared conversation later: the server handles the call.
      return next(e);
    }
    // A request that stands is for this conversation again, or for one that was cleared since; either way this one takes its place.
    state.request = { sessionId };
    return { result: ANSWER };
  });

  on("turn.start", ($, e, next) => {
    if (e.agentId === undefined) state.isTurnRunning = true;
    return next(e);
  });

  on("turn.complete", async ($, e, next) => {
    const answered = await next(e);
    if (e.agentId !== undefined) return answered;
    state.isTurnRunning = false;
    $.clock.after(0, () => void clearIfOrdered($, state, 0));
    const asked = state.request;
    if (asked === undefined) return answered;
    state.due += 1;
    const turnEnd = state.due;
    // The compaction is asked for from a timer, once this hook has returned, as in every run measured.
    if (e.reason === "answer") $.clock.after(0, () => void compact($, state, asked, turnEnd, 0));
    else state.request = undefined;
    return answered;
  });
};

function notCompleted(reported: string): string {
  return `The compaction this session requested with compact_self did not complete: ${reasonOf(reported)}. Continue the work that was in progress, and do not call compact_self again in this turn.`;
}
