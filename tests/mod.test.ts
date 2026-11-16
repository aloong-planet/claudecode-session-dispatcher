/**
 * The plugin's mod, through the one thing it exports: `register`, which Claude Code calls with the function that adds
 * hooks. Claude Code's side is a fake engine handed in the way Claude Code hands in its own: it records what the mod
 * asks for (a compaction, a prompt, a timer, a tool of its own) and lets a test decide how each compaction ends and
 * which context figures Claude Code has.
 *
 * Not covered here, because it needs a real Claude Code session: that Claude Code loads the mod from the plugin's
 * hooks file, tells it of these events with these inputs, lets its answer stand in for the server's tool, and starts
 * a turn when it submits a prompt. All of that was measured by hand on Claude Code 2.1.322 and is to be measured
 * again when Claude Code changes its interface for mods. That Claude Code lists the mod's own tool and gives it the
 * figures of the calling request is checked live in `claude-session-pool.live.test.ts`.
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { register } from "../plugin/hooks/register.ts";
import { runHook } from "../src/hooks.ts";
import { WakeState } from "../src/wake.ts";

const TOOL = "mcp__plugin_cc-session-pool_pool__compact_self";
const SENTENCE = "The compaction this session requested with compact_self has finished. This is not an error. Continue the work that was in progress.";
const notCompleted = (reason: string) =>
  `The compaction this session requested with compact_self did not complete: ${reason}. Continue the work that was in progress, and do not call compact_self again in this turn.`;
/** What Claude Code 2.1.322 rejects a mod's compaction with while a turn is in progress. */
const TURN_IN_PROGRESS = "cc-session-pool: $.session.compact: a turn is in flight; the conversation compacts between turns";
/** What Claude Code 2.1.322 rejects a mod's compaction with when the user presses Escape during it. */
const CANCELED = "cc-session-pool: $.session.compact: Compaction canceled.";
const SESSION = "c97a8f9a-26a0-473f-8829-eeb79f7298e0";
const OTHER_SESSION = "78744021-cd3b-490e-b601-5575fbb91cd6";
/** What the server's tool would have returned, had the call reached it. */
const FROM_SERVER = { result: "from the server" };
/** The mod's own tool, under the name a session sees it by. */
const USAGE_TOOL = "mcp__cc-session-pool__context_usage";
/**
 * What Claude Code 2.1.322 gave a mod's `$.session.usage()` in a tool call: the `context` of the second call of the
 * measured run (research: context-usage-as-a-tool.md, "Measured"), with the other figures in the form its types give.
 */
const MEASURED = { startedAt: 1_794_810_000_000, context: { tokens: 58965, window: 1000000, percent: 6 }, rateLimits: [], cost: { usd: 0.04 } };

type Hook = ($: unknown, e: unknown, next: (e: unknown) => Promise<unknown>) => Promise<unknown>;
type Compaction = { finish: (outcome?: { skip?: string }) => Promise<void>; refuse: (message: string) => Promise<void> };

const temporaryDirectories: string[] = [];
afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

/** Lets everything the mod started and is not waiting for run to its next wait. */
const settle = async () => {
  for (let turn = 0; turn < 20; turn += 1) await Promise.resolve();
};

/**
 * A session with the mod registered in it, and the events Claude Code tells a mod of. `told` is whether the mod was told
 * that the session started; `registerFails`, whether Claude Code refuses the mod's tool.
 */
async function setup({ interactive = true, told = true, registerFails = false } = {}) {
  const hooks = new Map<string, Hook>();
  register((event: string, hook: unknown) => void hooks.set(event, hook as Hook));
  /** `idFails`: Claude Code does not give the mod the session's ID. */
  const session = { id: SESSION, idFails: false };
  // The user's home directory, where the server keeps its wake requests; `wake` is how the server leaves one.
  const home = realpathSync(mkdtempSync(join(tmpdir(), "claude-session-pool-")));
  temporaryDirectories.push(home);
  const wake = new WakeState(join(home, ".claude-session-pool"));
  const compactions: Compaction[] = [];
  const prompts: string[] = [];
  const timers: { ms: number; run: () => void }[] = [];
  /** The tools the mod registered, as it described them. */
  const tools: unknown[] = [];
  /** What Claude Code answers the mod's request for the session's figures with. */
  const usage = { answer: (): Promise<unknown> => Promise.resolve(MEASURED) };
  const engine = {
    env: { get: (name: string) => Promise.resolve(name === "HOME" ? home : undefined) },
    fs: { read: (path: string) => Promise.resolve().then(() => readFileSync(path, "utf8")) },
    tool: {
      register: (spec: { name: string }) =>
        registerFails
          ? Promise.reject(new Error("cc-session-pool: $.tool.register: the tool could not be registered"))
          : (tools.push(spec), Promise.resolve({ tool: `mcp__cc-session-pool__${spec.name}` })),
    },
    session: {
      usage: () => usage.answer(),
      id: () => (session.idFails ? Promise.reject(new Error("no session")) : Promise.resolve(session.id)),
      compact: () =>
        new Promise<{ skip?: string }>((resolve, reject) => {
          compactions.push({
            finish: async (outcome = {}) => (resolve(outcome), await settle()),
            refuse: async (message) => (reject(new Error(message)), await settle()),
          });
        }),
    },
    prompt: { submit: ({ text }: { text: string }) => (prompts.push(text), Promise.resolve({ text })) },
    clock: { after: (ms: number, run: () => void) => void timers.push({ ms, run }) },
  };
  const tell = (event: string, input: unknown, fromCore: unknown = {}) => hooks.get(event)!(engine, input, () => Promise.resolve(fromCore));
  if (told) await tell("session.start", { cwd: "/somewhere", surface: interactive ? "terminal" : null, isInteractive: interactive });

  return {
    session,
    home,
    wake,
    compactions,
    prompts,
    timers,
    tools,
    usage,
    /** A call to a tool; resolves to what the model receives for it. */
    calls: (tool = TOOL, agentId?: string) => tell("tool.call", { tool, tool_use_id: "toolu_01", ...(agentId === undefined ? {} : { agentId }) }, FROM_SERVER),
    turnStarts: () => tell("turn.start", { text: "", turnId: "t" }),
    /** A turn of the session ends; then whatever the mod set a timer of no delay for runs. */
    turnEnds: async (reason = "answer") => {
      await tell("turn.complete", { reason, turnId: "t", answer: "" }, { text: "" });
      await runTimers(0);
    },
    /** Runs the timers set with this delay, in the order they were set. */
    runTimers,
  };

  async function runTimers(ms: number) {
    const due = timers.filter((timer) => timer.ms === ms);
    for (const timer of due) timers.splice(timers.indexOf(timer), 1);
    for (const timer of due) timer.run();
    await settle();
  }
}

describe("a call to compact_self in a session the mod runs in", () => {
  it("is answered by the mod in the server's place, with what happens next", async () => {
    const { calls, compactions, prompts } = await setup();

    const answered = (await calls()) as { result?: string; deny?: string };

    expect(answered).not.toEqual(FROM_SERVER);
    expect(answered.deny).toBeUndefined();
    expect(answered.result).toMatch(/compacted when this turn ends/);
    expect(answered.result).toMatch(/woken/);
    expect(compactions).toHaveLength(0);
    expect(prompts).toEqual([]);
  });

  it("is refused when a subagent makes it, and leaves no request", async () => {
    const { calls, turnEnds, compactions } = await setup();

    const answered = (await calls(TOOL, "agent-7")) as { result?: string; deny?: string };
    await turnEnds();

    expect(answered.result).toBeUndefined();
    expect(answered.deny).toMatch(/only the session itself can call compact_self/i);
    expect(compactions).toHaveLength(0);
  });

  it("is answered the same a second time while the request stands, and the conversation is compacted once", async () => {
    const { calls, turnEnds, compactions } = await setup();

    const first = await calls();
    const second = await calls();
    await turnEnds();

    expect(second).toEqual(first);
    expect(compactions).toHaveLength(1);
  });
});

describe("a call the mod does not answer", () => {
  it("reaches the server when Claude Code does not give the mod the session's ID, and leaves no request", async () => {
    const { session, calls, turnEnds, compactions, prompts } = await setup();
    session.idFails = true;

    const answered = await calls();
    session.idFails = false;
    await turnEnds();

    expect(answered).toBe(FROM_SERVER);
    expect(compactions).toHaveLength(0);
    expect(prompts).toEqual([]);
  });

  it.each([
    { what: "a call to another tool of the server", tool: "mcp__plugin_cc-session-pool_pool__status" },
    { what: "a call to a tool named compact_self of another server", tool: "mcp__other__compact_self" },
    { what: "a call to a tool named context_usage of another server", tool: "mcp__other__context_usage" },
    { what: "a call in a session that is not interactive", tool: TOOL, interactive: false },
    { what: "a call in a session the mod was not told the start of", tool: TOOL, told: false },
  ])("reaches the server: $what", async ({ tool, interactive, told }) => {
    const { calls, turnEnds, compactions } = await setup({ interactive, told });

    const answered = await calls(tool);
    await turnEnds();

    expect(answered).toBe(FROM_SERVER);
    expect(compactions).toHaveLength(0);
  });
});

describe("the end of the turn in which compact_self was called", () => {
  it("compacts nothing before the turn has ended", async () => {
    const { calls, runTimers, compactions } = await setup();

    await calls();
    await runTimers(0);

    expect(compactions).toHaveLength(0);
  });

  it("compacts the conversation, and when that has finished starts one turn with the sentence the hook hands over", async () => {
    const { calls, turnStarts, turnEnds, compactions, prompts, timers } = await setup();
    await turnStarts();
    await calls();

    await turnEnds();
    expect(compactions).toHaveLength(1);
    expect(prompts).toEqual([]);

    await compactions[0]!.finish();
    expect(prompts).toEqual([SENTENCE]);

    // The turn the sentence started ends: the request was used up.
    await turnStarts();
    await turnEnds();
    expect(compactions).toHaveLength(1);
    expect(prompts).toEqual([SENTENCE]);
    expect(timers).toEqual([]);
  });

  it.each([
    { what: "the owner interrupted it", reason: "aborted" },
    { what: "it ended on an API error", reason: "error" },
    { what: "the model refused", reason: "refusal" },
  ])("drops the request when $what: nothing is compacted then or after a later turn, and no turn is started", async ({ reason }) => {
    const { calls, turnStarts, turnEnds, compactions, prompts } = await setup();
    await turnStarts();
    await calls();

    await turnEnds(reason);
    await turnStarts();
    await turnEnds();

    expect(compactions).toHaveLength(0);
    expect(prompts).toEqual([]);
  });

  it("compacts the conversation a call was made in after a clear, when a request of the cleared conversation still stood", async () => {
    const { session, calls, turnEnds, compactions, prompts } = await setup();
    await calls();
    session.id = OTHER_SESSION;
    await calls();

    await turnEnds();
    expect(compactions).toHaveLength(1);

    await compactions[0]!.finish();
    expect(prompts).toEqual([SENTENCE]);
  });

  it("drops the request when the conversation was cleared before the compaction ran", async () => {
    const { session, calls, turnEnds, compactions, prompts } = await setup();
    await calls();
    session.id = OTHER_SESSION;

    await turnEnds();
    await turnEnds();

    expect(compactions).toHaveLength(0);
    expect(prompts).toEqual([]);
  });
});

describe("a conversation with a wake request that the server left", () => {
  /** The plugin's hook on PostCompact, which Claude Code runs as the mod's compaction finishes, before the mod hears that it has. */
  const hookAfterCompaction = (wake: WakeState) =>
    runHook({ hook_event_name: "PostCompact", session_id: SESSION, trigger: "manual", compact_summary: "…" }, { state: wake, sessionPid: 4242, isAlive: () => true });

  it("is woken by the plugin's hook after the mod's compaction, and not by the mod as well", async () => {
    const { wake, calls, turnEnds, compactions, prompts } = await setup();
    wake.leaveWakeRequest(SESSION, Date.UTC(2026, 10, 12, 3, 4, 5));
    await calls();
    await turnEnds();

    const hook = hookAfterCompaction(wake);
    await compactions[0]!.finish();

    expect(hook).toEqual({ exitCode: 2, stderr: SENTENCE });
    expect(prompts).toEqual([]);
  });

  it("is woken by the mod alone when it has no request: the hook stays quiet", async () => {
    const { wake, calls, turnEnds, compactions, prompts } = await setup();
    await calls();
    await turnEnds();

    const hook = hookAfterCompaction(wake);
    await compactions[0]!.finish();

    expect(hook).toEqual({ exitCode: 0, stderr: "" });
    expect(prompts).toEqual([SENTENCE]);
  });

  it("is still told by the mod when the compaction does not complete, because no hook runs then", async () => {
    const { wake, calls, turnEnds, compactions, prompts } = await setup();
    wake.leaveWakeRequest(SESSION, 0);
    await calls();
    await turnEnds();

    await compactions[0]!.finish({ skip: "PreCompact [guard] blocked it" });

    expect(prompts).toEqual([notCompleted("PreCompact [guard] blocked it")]);
  });

  it.each([
    { what: "the request belongs to another conversation", leave: (wake: WakeState) => wake.leaveWakeRequest(OTHER_SESSION, 0) },
  ])("is woken by the mod when $what", async ({ leave }) => {
    const { wake, calls, turnEnds, compactions, prompts } = await setup();
    leave(wake);
    await calls();
    await turnEnds();

    await compactions[0]!.finish();

    expect(prompts).toEqual([SENTENCE]);
  });

  it.each([
    { what: "is not valid JSON", content: '{"version": 1, "sessionId"' },
    { what: "carries another version", content: JSON.stringify({ version: 2, sessionId: SESSION, requestedAt: "2026-11-12T03:04:05.000Z" }) },
    { what: "names another conversation", content: JSON.stringify({ version: 1, sessionId: OTHER_SESSION, requestedAt: "2026-11-12T03:04:05.000Z" }) },
  ])("is woken by the mod when the request file $what, which the hook treats as absent", async ({ content }) => {
    const { home, calls, turnEnds, compactions, prompts } = await setup();
    mkdirSync(join(home, ".claude-session-pool", "wake-requests"), { recursive: true });
    writeFileSync(join(home, ".claude-session-pool", "wake-requests", `${SESSION}.json`), content);
    await calls();
    await turnEnds();

    await compactions[0]!.finish();

    expect(prompts).toEqual([SENTENCE]);
  });
});

describe("a compaction Claude Code refuses because a turn is in progress", () => {
  /** A call, the end of its turn, and a new turn that got in before the compaction. */
  async function refusedOnce() {
    const session = await setup();
    await session.turnStarts();
    await session.calls();
    await session.turnEnds();
    await session.turnStarts();
    await session.compactions[0]!.refuse(TURN_IN_PROGRESS);
    return session;
  }

  it("is asked for again 2 seconds later, and the session is woken once it goes through", async () => {
    const { compactions, prompts, timers, runTimers } = await refusedOnce();
    expect(timers.map(({ ms }) => ms)).toEqual([2000]);
    expect(prompts).toEqual([]);

    await runTimers(2000);
    expect(compactions).toHaveLength(2);

    await compactions[1]!.finish();
    expect(prompts).toEqual([SENTENCE]);
    expect(timers).toEqual([]);
  });

  it("is asked for again 5 times at most; then the request stands until the session's next turn has ended", async () => {
    const { compactions, prompts, timers, runTimers, turnEnds } = await refusedOnce();
    for (let again = 1; again <= 5; again += 1) {
      await runTimers(2000);
      expect(compactions).toHaveLength(1 + again);
      await compactions[again]!.refuse(TURN_IN_PROGRESS);
    }
    expect(timers).toEqual([]);
    expect(prompts).toEqual([]);

    await turnEnds();
    expect(compactions).toHaveLength(7);

    await compactions[6]!.finish();
    expect(prompts).toEqual([SENTENCE]);
  });

  it("is asked for once more, not twice, when the turn that got in ends while an attempt is still to come", async () => {
    const { compactions, runTimers, turnEnds } = await refusedOnce();

    await turnEnds();
    await runTimers(2000);

    expect(compactions).toHaveLength(2);
  });

  it("is taken as such whatever Claude Code's message says, while a turn the mod was told of is in progress", async () => {
    const { calls, turnStarts, turnEnds, compactions, prompts, timers } = await setup();
    await turnStarts();
    await calls();
    await turnEnds();
    await turnStarts();

    await compactions[0]!.refuse("cc-session-pool: $.session.compact: the session is busy");

    expect(timers.map(({ ms }) => ms)).toEqual([2000]);
    expect(prompts).toEqual([]);
  });

  it("is given up when the turn that got in ends because the owner interrupted it", async () => {
    const { compactions, prompts, runTimers, turnStarts, turnEnds } = await refusedOnce();

    await turnEnds("aborted");
    await runTimers(2000);
    await turnStarts();
    await turnEnds();

    expect(compactions).toHaveLength(1);
    expect(prompts).toEqual([]);
  });

  it("is recognised by Claude Code's message alone, when the mod has not yet been told that the turn started", async () => {
    const { calls, turnEnds, compactions, prompts, timers } = await setup();
    await calls();
    await turnEnds();

    await compactions[0]!.refuse(TURN_IN_PROGRESS);

    expect(timers.map(({ ms }) => ms)).toEqual([2000]);
    expect(prompts).toEqual([]);
  });
});

describe("a compaction that does not complete for another reason", () => {
  it.each([
    { what: "Claude Code refuses it", end: (compaction: Compaction) => compaction.refuse("cc-session-pool: $.session.compact: Not enough messages to compact."), reason: "Not enough messages to compact" },
    { what: "it fails with a message of another form", end: (compaction: Compaction) => compaction.refuse("request timed out"), reason: "request timed out" },
    { what: "a hook vetoes it", end: (compaction: Compaction) => compaction.finish({ skip: "PreCompact [guard] blocked it" }), reason: "PreCompact [guard] blocked it" },
  ])("starts a turn that tells the model so, and is not asked for again: $what", async ({ end, reason }) => {
    const { calls, turnStarts, turnEnds, compactions, prompts, timers } = await setup();
    await turnStarts();
    await calls();
    await turnEnds();

    await end(compactions[0]!);
    expect(prompts).toEqual([notCompleted(reason)]);
    expect(timers).toEqual([]);

    await turnStarts();
    await turnEnds();
    expect(compactions).toHaveLength(1);
    expect(prompts).toHaveLength(1);
  });

  it("starts no turn and is not asked for again when the owner cancelled it", async () => {
    const { calls, turnStarts, turnEnds, compactions, prompts, timers } = await setup();
    await turnStarts();
    await calls();
    await turnEnds();

    await compactions[0]!.refuse(CANCELED);
    await turnStarts();
    await turnEnds();

    expect(prompts).toEqual([]);
    expect(timers).toEqual([]);
    expect(compactions).toHaveLength(1);
  });
});

describe("the tool context_usage", () => {
  it.each([
    { what: "an interactive session", interactive: true },
    { what: "a session that is not interactive", interactive: false },
  ])("is offered from the start of $what, with its definition in the tool list and no arguments", async ({ interactive }) => {
    const { tools } = await setup({ interactive });

    expect(tools).toEqual([
      { name: "context_usage", description: expect.stringMatching(/context/) as unknown, inputSchema: { type: "object", properties: {} }, isDeferred: false },
    ]);
  });

  it("is missing when Claude Code refuses to register it, and the mod still answers compact_self", async () => {
    const { calls, tools } = await setup({ registerFails: true });

    const answered = (await calls()) as { result?: string; deny?: string };

    expect(tools).toEqual([]);
    expect(answered).not.toEqual(FROM_SERVER);
    expect(answered.result).toMatch(/compacted when this turn ends/);
  });

  it.each([
    { what: "an interactive session", interactive: true },
    { what: "a session that is not interactive", interactive: false },
  ])("answers a call in $what with the three figures Claude Code has at that moment", async ({ interactive }) => {
    const { calls } = await setup({ interactive });

    const answered = await calls(USAGE_TOOL);

    expect(answered).toEqual({
      result:
        "Context: 58965 input tokens of a 1000000-token window (6%). These are the input tokens of this session's latest model request, uncached, cache-written and cache-read together, as Claude Code's status line gives them (context_window.total_input_tokens).",
    });
  });

  it.each([
    { what: "has no input figure and no share, as before the first response of a fresh or just-compacted window", context: { window: 1000000 } },
    { what: "has an input figure but no share", context: { tokens: 58965, window: 1000000 } },
  ])("answers with an error and no figure when Claude Code $what", async ({ context }) => {
    const { calls, usage } = await setup();
    usage.answer = () => Promise.resolve({ ...MEASURED, context });

    const answered = (await calls(USAGE_TOOL)) as { result?: string; deny?: string };

    expect(answered.result).toBeUndefined();
    expect(answered.deny).toMatch(/size of this session's context is not known/i);
    expect(answered.deny).not.toMatch(/\d/);
  });

  it("answers with an error that gives Claude Code's reason, and no figure, when Claude Code fails to report the figures", async () => {
    const { calls, usage } = await setup();
    // In the form Claude Code 2.1.322 rejects a mod's other calls with (see TURN_IN_PROGRESS).
    const reason = "cc-session-pool: $.session.usage: the session is not bound";
    usage.answer = () => Promise.reject(new Error(reason));

    const answered = (await calls(USAGE_TOOL)) as { result?: string; deny?: string };

    expect(answered.result).toBeUndefined();
    expect(answered.deny).toContain(reason);
  });

  it("is refused, with no figure, when a subagent makes the call", async () => {
    const { calls } = await setup();

    const answered = (await calls(USAGE_TOOL, "agent-7")) as { result?: string; deny?: string };

    expect(answered.result).toBeUndefined();
    expect(answered.deny).toMatch(/only the session itself can call context_usage/i);
    expect(answered.deny).not.toMatch(/\d/);
  });
});
