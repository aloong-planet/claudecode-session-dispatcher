/**
 * A fake of the engine Claude Code hands the plugin's mod, handed in the way Claude Code hands in its own: it records what
 * the mod asks for (a compaction, a prompt, a timer, a tool of its own, a command, every call it makes) and lets a test
 * decide how each compaction ends, whether a prompt is taken, which context figures Claude Code has and which subagents
 * it lists. `modSetup` registers the mod's own `register` in it.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { register } from "../../plugin/hooks/register.ts";
import { WakeState } from "../../src/wake.ts";
import { SESSION } from "./sessions.ts";
import { temporaryDirectory } from "./temporary.ts";

export const TOOL = "mcp__plugin_cc-session-pool_pool__compact_self";
/** What Claude Code 2.1.325 rejects a mod's tool with in a session started with no built-in tools. */
export const REGISTRATION_REFUSED = 'cc-session-pool: $.tool.register: "context_usage" refused: this session has no built-in tools (--tools ""), so it takes none from plugins';
/** The most bytes that one `$.fs.read` answers with on Claude Code 2.1.327. */
export const READ_LIMIT = 4 * 1024 * 1024;
/** The session ID that a `/clear` in the session gives it. */
export const AFTER_CLEAR = "5b1f9a3e-7a49-4c0e-92a7-0f6f4f7c1a11";
/** What Claude Code 2.1.327 rejects a mod's `$.command.run` with when it is called while a `classic.FileChanged` event is dispatched. */
const FROM_FILE_CHANGED =
  "cc-session-pool: $.command.run: called from a classic.FileChanged hook, it would wait on the turn this hook is holding; run it from a later event (turn.complete) (host check)";
/** What the server's tool would have returned, had the call reached it. */
export const FROM_SERVER = { result: "from the server" };
/** The mod's own tool, under the name a session sees it by. */
export const USAGE_TOOL = "mcp__cc-session-pool__context_usage";
/**
 * What Claude Code 2.1.322 gave a mod's `$.session.usage()` in a tool call: the `context` of the second call of the
 * measured run (research: context-usage-as-a-tool.md, "Measured"), with the other figures in the form its types give.
 */
export const MEASURED = { startedAt: 1_794_810_000_000, context: { tokens: 58965, window: 1000000, percent: 6 }, rateLimits: [], cost: { usd: 0.04 } };

/** The options of `$.fs.read`. */
type ReadOptions = { as?: "text" | "bytes"; offset?: number; length?: number };

/**
 * A file read as Claude Code 2.1.327 reads it for a mod (research: monitor-reports-2026-11-26, out/fsread-text.jsonl and
 * out/fsread-bytes.jsonl): the range `offset`/`length` of its bytes, as text or as base64. An answer over 4 MiB is refused,
 * and a text range that cuts a character gives U+FFFD at that edge.
 */
export function readFile(path: string, { as = "text", offset, length }: ReadOptions = {}): string | { base64: string } {
  if (length !== undefined && (!Number.isInteger(length) || length < 0 || length > READ_LIMIT))
    throw new Error(`cc-session-pool: fs.read: takes length, a whole number of bytes from 0 to ${READ_LIMIT} (got ${length}) (host check)`);
  const bytes = readFileSync(path);
  const start = offset ?? 0;
  if (length === undefined && bytes.length - start > READ_LIMIT)
    throw new Error(
      `cc-session-pool: $.fs.read: ${path} refused: ${offset === undefined ? "the file is" : `what follows offset ${offset} is`} over the ${READ_LIMIT}-byte limit${offset === undefined ? "" : "; pass length"}`,
    );
  const range = bytes.subarray(start, length === undefined ? undefined : start + length);
  return as === "bytes" ? { base64: range.toString("base64") } : new TextDecoder().decode(range);
}

type Hook = ($: unknown, e: unknown, next: (e: unknown) => Promise<unknown>) => Promise<unknown>;
/** A subagent as Claude Code 2.1.327 lists it to a mod (`$.agent.list()`), with the fields the mod reads. */
export type ListedAgent = {
  id: string;
  type: string;
  description: string;
  status: "pending" | "running" | "waiting" | "idle" | "completed" | "failed" | "killed";
  taskStatus: "pending" | "running" | "completed" | "failed" | "killed" | "paused";
  kind: "local_agent" | "in_process_teammate";
  teammateId?: string;
  parentId?: string;
  tokenCount: number;
};
/** How often the mod looks, in milliseconds. */
export const LOOK_MS = 60_000;
export type Compaction = { finish: (outcome?: { skip?: string }) => Promise<void>; refuse: (message: string) => Promise<void> };

/** Lets everything the mod started and is not waiting for run to its next wait. */
export const settle = async () => {
  for (let turn = 0; turn < 100; turn += 1) await Promise.resolve();
};

/**
 * A session with the mod registered in it, and the events Claude Code tells a mod of. `told` is whether the mod was told
 * that the session started; `registerFails`, whether Claude Code refuses the mod's tool; `homeKnown`, whether the
 * mod can learn the user's home directory.
 */
export async function modSetup({ interactive = true, told = true, registerFails = false, homeKnown = true } = {}) {
  /**
   * The environment variable the start-up command leaves in a dispatcher session's environment
   * (`CLAUDE_SESSION_POOL_DISPATCHER_PID`); unset in any other session.
   */
  const variables = { dispatcherPid: undefined as string | undefined };
  const hooks = new Map<string, Hook>();
  register((event: string, hook: unknown) => void hooks.set(event, hook as Hook));
  /** `idFails`: Claude Code does not give the mod the session's ID. */
  const session = { id: SESSION, idFails: false };
  // The user's home directory, where the server keeps its wake requests; `wake` is how the server leaves one.
  const home = temporaryDirectory();
  const wake = new WakeState(join(home, ".claude-session-pool"));
  const compactions: Compaction[] = [];
  const prompts: string[] = [];
  /**
   * How Claude Code answers the mod's next prompts: `take` resolves with the prompt, `drop` resolves with a reason (as when
   * the owner stopped the session and typed nothing since), `reject` rejects, `hold` does not answer until `takeHeld`
   * takes every prompt held so far, as Claude Code does once the session is idle.
   */
  const heldPrompts: (() => void)[] = [];
  const promptAnswer = {
    kind: "take" as "take" | "drop" | "reject" | "hold",
    takeHeld: async () => {
      for (const take of heldPrompts.splice(0)) take();
      await settle();
    },
  };
  const timers: { ms: number; run: () => void }[] = [];
  /** The intervals the mod set (`$.clock.every`) and has not cancelled, and that a reload of the mod has not stopped. */
  const intervals: { ms: number; run: () => void }[] = [];
  /** Every call the mod made to the engine, as `<noun>.<method>`. */
  const engineCalls: string[] = [];
  // Beside the session's transcript, the directory of its subagents' transcripts, laid out as Claude Code 2.1.327 does.
  /** The transcript of the session's present conversation, as `$.session.info()` gives it; a `/clear` names a new one. */
  const conversation = { transcriptPath: join(home, ".claude", "projects", "-somewhere", `${SESSION}.jsonl`) };
  const subagentDirectory = join(home, ".claude", "projects", "-somewhere", SESSION, "subagents");
  /** The subagents Claude Code lists to the mod; `fails`: it rejects the call. */
  const agents = { listed: [] as ListedAgent[], fails: false };
  /** The tools the mod registered, as it described them. */
  const tools: unknown[] = [];
  /** What Claude Code answers the mod's request for the session's figures with. */
  const usage = { answer: (): Promise<unknown> => Promise.resolve(MEASURED) };
  /** The lines the mod logged, with where it sent each. */
  const logs: { text: string; options?: unknown }[] = [];
  /** The time Claude Code tells the mod, in milliseconds since the epoch. */
  const time = { now: Date.UTC(2026, 10, 22, 3, 0, 0) };
  /** The slash commands the mod asked Claude Code to run. `fails`: Claude Code rejects them. `held`: they are queued and have not run. */
  const commands: string[] = [];
  const clears = { fails: false, held: false, release: () => {} };
  /** Whether a `classic.FileChanged` event is being dispatched: Claude Code rejects `$.command.run` while it is. */
  const dispatching = { fileChanged: false };
  /** The paths the mod read, with the range of each read (`offset` and `length` as the mod passed them), and those it wrote. */
  const reads: string[] = [];
  const readRanges: { path: string; offset?: number; length?: number }[] = [];
  const writes: string[] = [];
  /** The session's project root (`$.session.root()`): the directory it was started in. */
  const root = { path: join(home, "project") };
  mkdirSync(root.path);
  /**
   * What the commands the mod runs print: `claude agents --json` prints `listing.text` and exits with `listing.exitCode`;
   * `fails`: the command cannot be started. `held`: the listing has run, and what it printed is not given to the mod until
   * `release` is called. `runs` holds the argument vector of every command the mod ran.
   */
  const listing = { text: "[]", exitCode: 0, fails: false, held: false, release: () => {} };
  const runs: string[][] = [];
  const engine = {
    ui: { log: (text: string, options?: unknown) => void logs.push({ text, options }) },
    env: {
      get: (name: string) =>
        Promise.resolve(name === "HOME" && homeKnown ? home : name === "CLAUDE_SESSION_POOL_DISPATCHER_PID" ? variables.dispatcherPid : undefined),
    },
    fs: {
      read: (path: string, options: ReadOptions = {}) =>
        Promise.resolve().then(() => {
          reads.push(path);
          readRanges.push({ path, offset: options.offset, length: options.length });
          return readFile(path, options);
        }),
      // As Claude Code 2.1.327 does: makes the directories the path needs and writes the file in place.
      write: (path: string, text: string) =>
        Promise.resolve().then(() => {
          writes.push(path);
          mkdirSync(dirname(path), { recursive: true });
          writeFileSync(path, text);
        }),
      exists: (path: string) => Promise.resolve().then(() => existsSync(path)),
      // As Claude Code 2.1.327 does: rejects when the path is missing; with `resolve`, also where it lands.
      stat: (path: string, options?: { resolve?: boolean }) =>
        Promise.resolve().then(() => {
          const stat = statSync(path);
          return { kind: stat.isDirectory() ? "dir" : "file", size: stat.size, mtimeMs: stat.mtimeMs, ...(options?.resolve ? { realPath: realpathSync(path) } : {}) };
        }),
      list: (path: string) =>
        Promise.resolve().then(() =>
          readdirSync(path, { withFileTypes: true }).map((entry) => ({
            name: entry.name,
            kind: entry.isFile() ? "file" : entry.isDirectory() ? "dir" : "other",
            size: entry.isFile() ? statSync(join(path, entry.name)).size : 0,
          })),
        ),
    },
    agent: { list: () => (agents.fails ? Promise.reject(new Error("cc-session-pool: $.agent.list: failed")) : Promise.resolve(structuredClone(agents.listed))) },
    tool: {
      register: (spec: { name: string }) =>
        registerFails
          ? Promise.reject(new Error(REGISTRATION_REFUSED))
          : (tools.push(spec), Promise.resolve({ tool: `mcp__cc-session-pool__${spec.name}` })),
    },
    session: {
      usage: () => usage.answer(),
      id: () => (session.idFails ? Promise.reject(new Error("no session")) : Promise.resolve(session.id)),
      info: () => Promise.resolve({ transcriptPath: conversation.transcriptPath }),
      root: () => Promise.resolve(root.path),
      compact: () =>
        new Promise<{ skip?: string }>((resolve, reject) => {
          compactions.push({
            finish: async (outcome = {}) => (resolve(outcome), await settle()),
            refuse: async (message) => (reject(new Error(message)), await settle()),
          });
        }),
    },
    prompt: {
      submit: ({ text }: { text: string }) => {
        prompts.push(text);
        if (promptAnswer.kind === "drop") return Promise.resolve({ drop: "the session was stopped and nobody has sent input since" });
        if (promptAnswer.kind === "reject") return Promise.reject(new Error("cc-session-pool: $.prompt.submit: the session is stopping"));
        const taken = { text, origin: { kind: "plugin", name: "cc-session-pool" } };
        if (promptAnswer.kind === "hold") return new Promise((resolve) => void heldPrompts.push(() => resolve(taken)));
        return Promise.resolve(taken);
      },
    },
    clock: {
      now: () => Promise.resolve(time.now),
      after: (ms: number, run: () => void) => void timers.push({ ms, run }),
      every: (ms: number, run: () => void) => {
        const interval = { ms, run };
        intervals.push(interval);
        return () => void (intervals.includes(interval) && intervals.splice(intervals.indexOf(interval), 1));
      },
    },
    process: {
      run: (argv: readonly string[]) => {
        runs.push([...argv]);
        if (listing.fails) return Promise.reject(new Error("cc-session-pool: $.process.run: claude: command not found"));
        const known = argv.join(" ") === "claude agents --json";
        const ran = { exitCode: known ? listing.exitCode : 127, stdout: known ? listing.text : "", stderr: "" };
        if (known && listing.held) return new Promise((resolve) => (listing.release = () => resolve(ran)));
        return Promise.resolve(ran);
      },
    },
    command: {
      run: ({ command }: { command: string }) => {
        commands.push(command);
        if (clears.fails) return Promise.reject(new Error("cc-session-pool: $.command.run: the session is stopping"));
        if (dispatching.fileChanged) return Promise.reject(new Error(FROM_FILE_CHANGED));
        const ran = () => {
          // A /clear gives the session a new session ID.
          if (command === "clear") session.id = AFTER_CLEAR;
          return { text: "" };
        };
        return clears.held ? new Promise((resolve) => (clears.release = () => resolve(ran()))) : Promise.resolve(ran());
      },
    },
  };
  for (const [noun, methods] of Object.entries(engine) as [string, Record<string, (...args: never[]) => unknown>][])
    for (const [method, call] of Object.entries(methods)) methods[method] = (...args: never[]) => (engineCalls.push(`${noun}.${method}`), call(...args));
  const tell = (event: string, input: unknown, fromCore: unknown = {}, below?: Promise<unknown>) =>
    hooks.get(event)!(engine, input, () => (below === undefined ? Promise.resolve(fromCore) : below.then(() => fromCore)));
  const start = async () => {
    await tell("session.start", { cwd: "/somewhere", surface: interactive ? "terminal" : null, isInteractive: interactive });
    await settle();
  };
  if (told) await start();
  let callsMade = 0;

  return {
    session,
    home,
    wake,
    variables,
    root,
    listing,
    runs,
    /** Claude Code tells the mod that the session started, for a setup made with `told: false`. */
    start,
    time,
    commands,
    clears,
    reads,
    readRanges,
    writes,
    conversation,
    /** The session's activity record for the session ID `sessionId`, parsed; undefined where there is no file. */
    activity: (sessionId = SESSION): unknown => {
      try {
        return JSON.parse(readFileSync(join(home, ".claude-session-pool", "activity", `${sessionId}.json`), "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      }
    },
    /** Claude Code tells the mod that a session started, by way of the classic `SessionStart` hook; resolves to what the mod answers. */
    classicStart: (source: string, fromCore?: unknown) => tell("classic.SessionStart", { hook_event_name: "SessionStart", source }, fromCore),
    /**
     * Claude Code tells the mod that a file under a path it asked to watch was added, changed or removed. The event is
     * dispatched until the hook has returned and a moment after; `holdBelow` makes a hook under the mod's keep it so until
     * the returned `release` is called. Then whatever the mod set a timer of no delay for runs. `fromCore` is what the
     * hooks under the mod's answer; `answered` is what the mod answers (once `end` has run, when the event is held).
     */
    fileChanged: async (
      file = `${home}/.claude-session-pool/clear-orders/${SESSION}.json`,
      event = "add",
      { holdBelow = false, fromCore = {} }: { holdBelow?: boolean; fromCore?: unknown } = {},
    ) => {
      let release = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      dispatching.fileChanged = true;
      const dispatch = tell("classic.FileChanged", { hook_event_name: "FileChanged", file_path: file, event }, fromCore, holdBelow ? gate : undefined);
      await settle();
      if (holdBelow) await runTimers(0);
      const end = async () => {
        release();
        const answered = await dispatch;
        await settle();
        dispatching.fileChanged = false;
        await runTimers(0);
        return answered;
      };
      return { end, answered: holdBelow ? undefined : await end() };
    },
    compactions,
    prompts,
    promptAnswer,
    timers,
    intervals,
    engineCalls,
    agents,
    /**
     * Claude Code starts a subagent in the background, or one is started by a subagent: it is listed, running unless
     * `fields` say otherwise, and its transcript lies beside its meta file, as Claude Code 2.1.327 lays them out.
     */
    startSubagent: (id: string, fields: Partial<ListedAgent> = {}, size = 284_744) => {
      const agent: ListedAgent = { id, type: "general-purpose", description: "Run the test suite", status: "running", taskStatus: "running", kind: "local_agent", tokenCount: 45_424, ...fields };
      agents.listed.push(agent);
      writeTranscript(id, size);
      writeFileSync(join(subagentDirectory, `agent-${id}.meta.json`), JSON.stringify({ agentType: agent.type, description: agent.description }));
      return agent;
    },
    /** A subagent's transcript grows (or shrinks) to `size` bytes. */
    writeTranscript,
    subagentDirectory,
    /** The mod's timer fires: it makes `count` looks, each one let run to its next wait. */
    look: async (count = 1) => {
      for (let made = 0; made < count; made += 1) {
        for (const interval of intervals.filter(({ ms }) => ms === LOOK_MS)) interval.run();
        await settle();
      }
    },
    /** Claude Code loads the mod again, as when a file of the plugin is saved: the earlier timers stop and the mod is started anew. */
    reload: async () => {
      intervals.length = 0;
      register((event: string, hook: unknown) => void hooks.set(event, hook as Hook));
      await start();
    },
    tools,
    usage,
    logs,
    /** A call to a tool; resolves to what the model receives for it. */
    calls: (tool = TOOL, agentId?: string) => tell("tool.call", { tool, tool_use_id: "toolu_01", ...(agentId === undefined ? {} : { agentId }) }, FROM_SERVER),
    /**
     * A call to a tool that Claude Code runs and that has not returned yet, as a Bash command that takes a while: the mod is
     * told of it, with its arguments beside `tool` as Claude Code 2.1.327 tells them, and has passed it on. `returns` lets
     * the tool return and resolves to what the model receives. `fromCore` is what Claude Code's `next(e)` resolves to,
     * the tool's result or, for a tool that reported an error, a result with `isError`.
     */
    startsCall: async (tool: string, agentId?: string, args: Record<string, unknown> = {}, fromCore: unknown = FROM_SERVER) => {
      callsMade += 1;
      let release = () => {};
      const ran = new Promise<void>((resolve) => (release = resolve));
      const answered = tell("tool.call", { ...args, tool, tool_use_id: `toolu_${callsMade}`, ...(agentId === undefined ? {} : { agentId }) }, fromCore, ran);
      await settle();
      return {
        returns: async () => {
          release();
          const result = await answered;
          await settle();
          return result;
        },
      };
    },
    /** A turn starts: of the main conversation, or of the subagent `agentId`. */
    turnStarts: async (agentId?: string) => {
      await tell("turn.start", { text: "", turnId: "t", ...(agentId === undefined ? {} : { agentId }) });
      await settle();
    },
    /** A turn ends (of the main conversation, or of the subagent `agentId`); then whatever the mod set a timer of no delay for runs. */
    turnEnds: async (reason = "answer", agentId?: string) => {
      await tell("turn.complete", { reason, turnId: "t", answer: "", ...(agentId === undefined ? {} : { agentId }) }, { text: "" });
      await runTimers(0);
    },
    /** Runs the timers set with this delay, in the order they were set. */
    runTimers,
  };

  function writeTranscript(id: string, size: number) {
    mkdirSync(subagentDirectory, { recursive: true });
    writeFileSync(join(subagentDirectory, `agent-${id}.jsonl`), "x".repeat(size));
  }

  async function runTimers(ms: number) {
    const due = timers.filter((timer) => timer.ms === ms);
    for (const timer of due) timers.splice(timers.indexOf(timer), 1);
    for (const timer of due) timer.run();
    await settle();
  }
}
