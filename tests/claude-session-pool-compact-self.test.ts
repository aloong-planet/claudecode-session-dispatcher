/**
 * A session's compaction of itself, in the two ways `compact_self` is handled. Where the plugin's mod runs, the mod
 * answers the call, through the one thing it exports: `register`, which Claude Code calls with the function that adds
 * hooks; Claude Code's side is the fake engine of `support/mod-engine.ts`, in which a test decides how each compaction
 * ends. Elsewhere the server handles the call, through its one public method, and the plugin's hook on `PostCompact`
 * wakes the session afterwards; the hook is also tested as a function of the event Claude Code describes to it, and as
 * the process the plugin declares.
 *
 * On the server's side, Claude Code's session listing, the Terminal application and process signals are replaced by
 * `FakeMac`; transcripts, hook records and wake requests are real files in a temporary directory; time is the fake's
 * virtual clock. The fake queues a text that is typed during a turn and runs a queued `/compact` when the turn ends,
 * as Claude Code 2.1.322 was seen to do. It runs the real hook program at the moments Claude Code runs a plugin's hooks,
 * and starts a turn in a session whose `PostCompact` hook exits with code 2.
 *
 * Not covered here, because it needs the real programs: that Claude Code queues what is typed during a turn, runs
 * a queued `/compact` when the turn ends, runs the hooks and wakes the session. These are checked by hand with a
 * real session. A prompt that comes up between the reading of the session's state and the typing of `/compact`
 * cannot be driven: the server does not detect it. Neither can a call made by a subagent of the session, which the
 * server cannot tell from the session's own, or hooks that are switched off after the hook record was written.
 * Nor is that Claude Code runs the hook for these events with this input, and that it wakes an idle session when the
 * hook exits with code 2; both were measured by hand on Claude Code 2.1.322 and are to be measured again when Claude
 * Code changes how it runs hooks. Nor is that Claude Code loads the mod from the plugin's hooks file, tells it of
 * these events with these inputs, lets its answer stand in for the server's tool, and starts a turn when it submits a
 * prompt (measured by hand on Claude Code 2.1.322); that is to be measured again when Claude Code changes its interface
 * for mods.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileTranscripts } from "../src/adapters/transcripts.ts";
import { runHook } from "../src/hooks.ts";
import { SelfCompaction } from "../src/self-compaction.ts";
import { WakeState } from "../src/wake.ts";
import { FakeMac, type FakeSession } from "./support/fake-mac.ts";
import { QUIET, hookSetup } from "./support/hook-state.ts";
import { FROM_SERVER, TOOL, modSetup, type Compaction } from "./support/mod-engine.ts";
import { callText, readJson, runHookProcess, standIns, withServer } from "./support/plugin-processes.ts";
import { OTHER_SESSION, SESSION } from "./support/sessions.ts";
import { cleanUpTemporaryDirectories, temporaryDirectory } from "./support/temporary.ts";

afterEach(cleanUpTemporaryDirectories);

const fakes: FakeMac[] = [];

afterEach(() => {
  for (const fake of fakes.splice(0)) fake.stop();
});

const QUEUED =
  '"/compact" was typed into this session\'s Terminal tab and is queued. It runs when this turn ends, so end the turn now. When the compaction has finished, a hook wakes this session.';
const SENTENCE = "The compaction this session requested with compact_self has finished. This is not an error. Continue the work that was in progress.";
const MINUTE = 60_000;
/** The fake's clock starts at the epoch. */
const at = (ms: number) => new Date(ms).toISOString();

type Options = {
  session?: Partial<FakeSession>;
  transcript?: boolean;
  attachedTo?: number;
  /** Whether the plugin's hooks run in the sessions of this Mac. */
  hooksRun?: boolean;
};

/** A session in the middle of a turn, in its own Terminal window, with a transcript, next to a session it must not touch. */
function setup(options: Options = {}) {
  const home = temporaryDirectory();
  const directory = join(home, "project");
  const transcriptRoot = join(home, "transcripts");
  const stateRoot = join(home, "state");
  for (const path of [directory, transcriptRoot]) mkdirSync(path);
  const mac = new FakeMac();
  fakes.push(mac);
  mac.transcriptRoot = transcriptRoot;
  const wake = new WakeState(stateRoot);
  if (options.hooksRun !== false) mac.hooks = (input, sessionPid) => runHook(input, { state: wake, sessionPid, isAlive: (pid) => mac.processes.isAlive(pid) });
  const session = mac.addSession({ name: "worker", cwd: directory, status: "busy", ...options.session });
  if (options.transcript !== false) mac.appendTurnRecord(session.sessionId!);
  mac.addSession({ name: "bystander", cwd: directory });
  const self = new SelfCompaction({
    sessionPid: options.attachedTo ?? session.pid!,
    sessions: mac.lister,
    terminal: mac.terminal,
    processes: mac.processes,
    transcripts: new FileTranscripts(transcriptRoot),
    clock: mac.clock,
    wake,
  });
  const typedCommands = () => mac.typed.map((entry) => entry.command);
  const requestsDirectory = join(stateRoot, "wake-requests");
  /** The names of the wake requests on disk. */
  const wakeRequests = () => (existsSync(requestsDirectory) ? readdirSync(requestsDirectory) : []);
  const wakeRequestPath = (sessionId = session.sessionId!) => join(requestsDirectory, `${sessionId}.json`);
  const wakeRequest = (sessionId = session.sessionId!) =>
    existsSync(wakeRequestPath(sessionId)) ? (JSON.parse(readFileSync(wakeRequestPath(sessionId), "utf8")) as unknown) : undefined;
  const tabOf = (target: FakeSession) => ({ windowId: mac.windowOf(target).id, tab: 1, tabCount: 1 });
  return { mac, self, session, typedCommands, wakeRequests, wakeRequest, wakeRequestPath, tabOf };
}

const notCompleted = (reason: string) =>
  `The compaction this session requested with compact_self did not complete: ${reason}. Continue the work that was in progress, and do not call compact_self again in this turn.`;
/** What Claude Code 2.1.322 rejects a mod's compaction with while a turn is in progress. */
const TURN_IN_PROGRESS = "cc-session-pool: $.session.compact: a turn is in flight; the conversation compacts between turns";
/** What Claude Code 2.1.322 rejects a mod's compaction with when the user presses Escape during it. */
const CANCELED = "cc-session-pool: $.session.compact: Compaction canceled.";

describe("a call to compact_self in a session the mod runs in", () => {
  it("is answered by the mod in the server's place, with what happens next", async () => {
    const { calls, compactions, prompts } = await modSetup();

    const answered = (await calls()) as { result?: string; deny?: string };

    expect(answered).not.toEqual(FROM_SERVER);
    expect(answered.deny).toBeUndefined();
    expect(answered.result).toMatch(/compacted when this turn ends/);
    expect(answered.result).toMatch(/woken/);
    expect(compactions).toHaveLength(0);
    expect(prompts).toEqual([]);
  });

  it("is refused when a subagent makes it, and leaves no request", async () => {
    const { calls, turnEnds, compactions } = await modSetup();

    const answered = (await calls(TOOL, "agent-7")) as { result?: string; deny?: string };
    await turnEnds();

    expect(answered.result).toBeUndefined();
    expect(answered.deny).toMatch(/only the session itself can call compact_self/i);
    expect(compactions).toHaveLength(0);
  });

  it("is answered the same a second time while the request stands, and the conversation is compacted once", async () => {
    const { calls, turnEnds, compactions } = await modSetup();

    const first = await calls();
    const second = await calls();
    await turnEnds();

    expect(second).toEqual(first);
    expect(compactions).toHaveLength(1);
  });
});

describe("a call the mod does not answer", () => {
  it("reaches the server when Claude Code does not give the mod the session's ID, and leaves no request", async () => {
    const { session, calls, turnEnds, compactions, prompts } = await modSetup();
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
    const { calls, turnEnds, compactions } = await modSetup({ interactive, told });

    const answered = await calls(tool);
    await turnEnds();

    expect(answered).toBe(FROM_SERVER);
    expect(compactions).toHaveLength(0);
  });
});

describe("the end of the turn in which compact_self was called", () => {
  it("compacts nothing before the turn has ended", async () => {
    const { calls, runTimers, compactions } = await modSetup();

    await calls();
    await runTimers(0);

    expect(compactions).toHaveLength(0);
  });

  it("compacts the conversation, and when that has finished starts one turn with the sentence the hook hands over", async () => {
    const { calls, turnStarts, turnEnds, compactions, prompts, timers } = await modSetup();
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
    const { calls, turnStarts, turnEnds, compactions, prompts } = await modSetup();
    await turnStarts();
    await calls();

    await turnEnds(reason);
    await turnStarts();
    await turnEnds();

    expect(compactions).toHaveLength(0);
    expect(prompts).toEqual([]);
  });

  it("compacts the conversation a call was made in after a clear, when a request of the cleared conversation still stood", async () => {
    const { session, calls, turnEnds, compactions, prompts } = await modSetup();
    await calls();
    session.id = OTHER_SESSION;
    await calls();

    await turnEnds();
    expect(compactions).toHaveLength(1);

    await compactions[0]!.finish();
    expect(prompts).toEqual([SENTENCE]);
  });

  it("drops the request when the conversation was cleared before the compaction ran", async () => {
    const { session, calls, turnEnds, compactions, prompts } = await modSetup();
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
    const { wake, calls, turnEnds, compactions, prompts } = await modSetup();
    wake.leaveWakeRequest(SESSION, Date.UTC(2026, 10, 12, 3, 4, 5));
    await calls();
    await turnEnds();

    const hook = hookAfterCompaction(wake);
    await compactions[0]!.finish();

    expect(hook).toEqual({ exitCode: 2, stderr: SENTENCE });
    expect(prompts).toEqual([]);
  });

  it("is woken by the mod alone when it has no request: the hook stays quiet", async () => {
    const { wake, calls, turnEnds, compactions, prompts } = await modSetup();
    await calls();
    await turnEnds();

    const hook = hookAfterCompaction(wake);
    await compactions[0]!.finish();

    expect(hook).toEqual({ exitCode: 0, stderr: "" });
    expect(prompts).toEqual([SENTENCE]);
  });

  it("is still told by the mod when the compaction does not complete, because no hook runs then", async () => {
    const { wake, calls, turnEnds, compactions, prompts } = await modSetup();
    wake.leaveWakeRequest(SESSION, 0);
    await calls();
    await turnEnds();

    await compactions[0]!.finish({ skip: "PreCompact [guard] blocked it" });

    expect(prompts).toEqual([notCompleted("PreCompact [guard] blocked it")]);
  });

  it.each([
    { what: "the request belongs to another conversation", leave: (wake: WakeState) => wake.leaveWakeRequest(OTHER_SESSION, 0) },
  ])("is woken by the mod when $what", async ({ leave }) => {
    const { wake, calls, turnEnds, compactions, prompts } = await modSetup();
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
    const { home, calls, turnEnds, compactions, prompts } = await modSetup();
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
    const session = await modSetup();
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
    const { calls, turnStarts, turnEnds, compactions, prompts, timers } = await modSetup();
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
    const { calls, turnEnds, compactions, prompts, timers } = await modSetup();
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
    const { calls, turnStarts, turnEnds, compactions, prompts, timers } = await modSetup();
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
    const { calls, turnStarts, turnEnds, compactions, prompts, timers } = await modSetup();
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

describe("compact_self", () => {
  it("types /compact into the session's own tab without an interrupt, reports it queued and leaves a wake request for the conversation", async () => {
    const { mac, self, session, wakeRequests, wakeRequest } = setup();

    const outcome = await self.request();

    expect(outcome).toEqual({ ok: true, text: QUEUED });
    expect(mac.typed).toEqual([{ at: 0, windowId: mac.windowOf(session).id, tab: 1, command: "/compact", interrupt: false }]);
    expect(wakeRequests()).toEqual([`${session.sessionId}.json`]);
    expect(wakeRequest()).toEqual({ version: 1, sessionId: session.sessionId, requestedAt: "1970-01-01T00:00:00.000Z" });
  });

  it("leaves the wake request before it types", async () => {
    const { mac, self, wakeRequests } = setup();
    const typeText = mac.terminal.typeText.bind(mac.terminal);
    let requestsWhenTyping: string[] | undefined;
    mac.terminal.typeText = (tab, text) => {
      requestsWhenTyping = wakeRequests();
      return typeText(tab, text);
    };

    await self.request();

    expect(requestsWhenTyping).toHaveLength(1);
  });

  it("is followed by the hook: once the turn has ended and the compaction has finished, the session is woken with the sentence, nothing more is typed, and the request is used up", async () => {
    const { mac, self, session, typedCommands, wakeRequests } = setup();
    mac.at(3000, () => mac.endTurn(session));

    await self.request();
    await mac.clock.sleep(2 * MINUTE);

    // The turn ends at 3 seconds and the fake's compaction takes 7.
    expect(mac.woken).toEqual([{ at: 10_000, pid: session.pid, sessionId: session.sessionId, text: SENTENCE }]);
    expect(typedCommands()).toEqual(["/compact"]);
    expect(wakeRequests()).toEqual([]);
  });

  it.each([
    { where: "after the text in the input box", session: { inputBox: "half typed" }, queuedAs: '"half typed/compact"' },
    // A real session queued exactly this text when the cursor sat before the last word.
    { where: "at the cursor, inside the text in the input box", session: { inputBox: "fix the typo", cursor: 8 }, queuedAs: '"fix the /compacttypo"' },
  ])("reports the text the command was queued with when it landed $where, withdraws the wake request, and accepts a later call", async ({ session, queuedAs }) => {
    const { self, typedCommands, wakeRequests } = setup({ session });

    const outcome = await self.request();
    const requestsAfterwards = wakeRequests();
    const again = await self.request();

    expect(outcome).toEqual({
      ok: false,
      text: `"/compact" was typed into this session's Terminal tab, but it was queued together with text that was sitting in the input box, as ${queuedAs}. No compaction will run, and the wake request was withdrawn.`,
    });
    expect(requestsAfterwards).toEqual([]);
    expect(again).toEqual({ ok: true, text: QUEUED });
    expect(typedCommands()).toEqual(["/compact", "/compact"]);
  });

  it("is not woken by a later compaction after a command that was queued with other text", async () => {
    const { mac, self, session, tabOf } = setup({ session: { inputBox: "half typed" } });

    await self.request();
    mac.endTurn(session);
    // The owner types the command by hand afterwards.
    await mac.terminal.typeCommand(tabOf(session), "/compact");
    await mac.clock.sleep(2 * MINUTE);

    expect(session.status).toBe("idle");
    expect(mac.woken).toEqual([]);
  });

  it("reports the command queued when its record reaches the transcript after the first reading", async () => {
    const { mac, self, session } = setup();
    mac.recordsQueue = false;
    mac.at(1500, () => mac.appendQueueRecord(session.sessionId!, "enqueue", "/compact"));

    const outcome = await self.request();

    expect(outcome).toEqual({ ok: true, text: QUEUED });
    expect(mac.now).toBeLessThan(10_000);
  });

  it("reports unconfirmed when nothing is shown queued after 10 seconds, keeps the wake request, and the session is still woken after a compaction", async () => {
    const { mac, self, session, wakeRequests } = setup();
    mac.recordsQueue = false;
    mac.at(5000, () => mac.endTurn(session));

    const outcome = await self.request();
    const returnedAt = mac.now;
    const requestsAtReturn = wakeRequests();
    await mac.clock.sleep(2 * MINUTE);

    expect(outcome).toEqual({
      ok: false,
      text: 'unconfirmed: "/compact" was typed into this session\'s Terminal tab, but its transcript did not show it queued 10 seconds later. The wake request stays: if the command starts a compaction after all, this session is woken when it finishes.',
    });
    expect(returnedAt).toBe(10_000);
    expect(requestsAtReturn).toEqual([`${session.sessionId}.json`]);
    // The turn ends at 5 seconds and the fake's compaction takes 7.
    expect(mac.woken).toEqual([{ at: 12_000, pid: session.pid, sessionId: session.sessionId, text: SENTENCE }]);
  });

  const OTHER_CONVERSATION = "00000000-0000-4000-8000-999999999999";

  it.each<{ what: string; options?: Options; arrange?: (mac: FakeMac, session: FakeSession) => void; reason: string }>([
    { what: "the session is not in the listing", options: { attachedTo: 99_999 }, reason: "(pid 99999) is not listed as a live interactive session" },
    { what: "the session is a background session", options: { session: { kind: "background" } }, reason: "is not listed as a live interactive session" },
    { what: "the session is idle", options: { session: { status: "idle" } }, reason: "This session is idle, and compact_self types only while the session is busy" },
    {
      what: "a prompt is on screen",
      options: { session: { status: "waiting", waitingFor: "permission to use Bash" } },
      reason: "This session is waiting for permission to use Bash, and compact_self types only while the session is busy",
    },
    { what: "the transcript is missing", options: { transcript: false }, reason: "could not be found or read, so it could not be confirmed that the command is queued" },
    { what: "no Terminal tab hosts the session", options: { session: { tty: "/dev/ttys999" } }, reason: "does not run in a Terminal window" },
    { what: "the plugin's hooks do not run in the session", options: { hooksRun: false }, reason: "No hook record shows that the cc-session-pool plugin's hooks run in this session" },
    {
      // The moment after `/clear`, before the hook has run for the new conversation.
      what: "the hook record still names the conversation the session held before",
      arrange: (mac, session) => {
        session.sessionId = OTHER_CONVERSATION;
        mac.appendTurnRecord(OTHER_CONVERSATION);
      },
      reason: `No hook record shows that the cc-session-pool plugin's hooks run in this session (pid 5000, session ${OTHER_CONVERSATION})`,
    },
  ])("refuses, types nothing and leaves no wake request when $what", async ({ options, arrange, reason }) => {
    const { mac, self, session, wakeRequests } = setup(options);
    arrange?.(mac, session);

    const outcome = await self.request();

    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain(reason);
    expect(outcome.text).toMatch(/nothing was typed\.$/);
    expect(mac.typed).toEqual([]);
    expect(wakeRequests()).toEqual([]);
  });

  it("refuses and types nothing when a prompt comes up while the tab is being looked up", async () => {
    const { mac, self, session, wakeRequests } = setup();
    mac.tabLookupMs = 500;
    mac.at(200, () => {
      session.status = "waiting";
      session.waitingFor = "permission to use Bash";
    });

    const outcome = await self.request();

    expect(outcome).toEqual({
      ok: false,
      text: "This session is waiting for permission to use Bash, and compact_self types only while the session is busy with the turn that calls it; nothing was typed.",
    });
    expect(mac.typed).toEqual([]);
    expect(wakeRequests()).toEqual([]);
  });

  it("refuses a call while the conversation has a wake request left less than 30 minutes ago, types the command once and leaves that request as it is", async () => {
    const { mac, self, typedCommands, wakeRequest } = setup();

    await self.request();
    await mac.clock.sleep(30 * MINUTE - 1000);
    const second = await self.request();

    expect(second).toEqual({
      ok: false,
      text: "This session's conversation has a wake request that an earlier compact_self call left less than 30 minutes ago (at 1970-01-01T00:00:00.000Z); nothing was typed.",
    });
    expect(typedCommands()).toEqual(["/compact"]);
    expect(wakeRequest()).toMatchObject({ requestedAt: at(0) });
  });

  it("refuses the second of two calls that arrive together", async () => {
    const { self, typedCommands } = setup();

    const [first, second] = await Promise.all([self.request(), self.request()]);

    expect([first.ok, second.ok]).toEqual([true, false]);
    expect(second.text).toContain("has a wake request that an earlier compact_self call left less than 30 minutes ago");
    expect(typedCommands()).toEqual(["/compact"]);
  });

  it("accepts a call once the wake request is 30 minutes old, and replaces the request", async () => {
    const { mac, self, typedCommands, wakeRequest } = setup();

    await self.request();
    await mac.clock.sleep(30 * MINUTE);
    const later = await self.request();

    expect(later).toEqual({ ok: true, text: QUEUED });
    expect(typedCommands()).toEqual(["/compact", "/compact"]);
    expect(wakeRequest()).toMatchObject({ requestedAt: at(30 * MINUTE) });
  });

  it("is woken however much later the turn ends: a wake request does not lapse", async () => {
    const { mac, self, session } = setup();

    await self.request();
    await mac.clock.sleep(45 * MINUTE);
    mac.endTurn(session);
    await mac.clock.sleep(MINUTE);

    expect(mac.woken).toEqual([{ at: 45 * MINUTE + 7000, pid: session.pid, sessionId: session.sessionId, text: SENTENCE }]);
  });

  it("is not woken after a compaction Claude Code starts on its own, and is woken after the one the command starts", async () => {
    const { mac, self, session } = setup();
    mac.at(2000, () => mac.compactOnItsOwn(session));
    mac.at(5000, () => mac.endTurn(session));

    await self.request();
    await mac.clock.sleep(2 * MINUTE);

    // The turn ends at 5 seconds and the fake's compaction takes 7.
    expect(mac.woken).toEqual([{ at: 12_000, pid: session.pid, sessionId: session.sessionId, text: SENTENCE }]);
  });

  it.each([
    { what: "Terminal cannot be scripted at all", failure: "terminalFailure" as const },
    { what: "Terminal fails when the command is typed", failure: "typingFailure" as const },
  ])("returns Terminal's error when $what, leaves no wake request behind, and accepts a later call", async ({ failure }) => {
    const { mac, self, typedCommands, wakeRequests } = setup();
    mac[failure] = "Not authorised to send Apple events to Terminal.";

    const refused = await self.request();
    const requestsAfterwards = wakeRequests();
    mac[failure] = undefined;
    const later = await self.request();

    expect(refused).toEqual({ ok: false, text: "Not authorised to send Apple events to Terminal." });
    expect(requestsAfterwards).toEqual([]);
    expect(later).toEqual({ ok: true, text: QUEUED });
    expect(typedCommands()).toEqual(["/compact"]);
  });

  it("writes over a wake request that another version left", async () => {
    const { self, session, wakeRequest, wakeRequestPath } = setup();
    mkdirSync(join(wakeRequestPath(), ".."), { recursive: true });
    writeFileSync(wakeRequestPath(), JSON.stringify({ version: 2, conversation: session.sessionId, leftAt: 1_800_000_000 }));

    const outcome = await self.request();

    expect(outcome).toEqual({ ok: true, text: QUEUED });
    expect(wakeRequest()).toEqual({ version: 1, sessionId: session.sessionId, requestedAt: at(0) });
  });
});

describe("the hook on PostCompact", () => {
  it("wakes a session whose conversation has a wake request: hands over the sentence, exits with code 2 and uses the request up", () => {
    const { state, compacted, files } = hookSetup();
    state.leaveWakeRequest(SESSION, Date.UTC(2026, 10, 12, 3, 4, 5));

    const first = compacted(SESSION);
    const second = compacted(SESSION);

    expect(first).toEqual({ exitCode: 2, stderr: SENTENCE });
    expect(files("wake-requests")).toEqual([]);
    expect(second).toEqual(QUIET);
  });

  it("wakes no session whose conversation has no wake request", () => {
    const { compacted, files } = hookSetup();

    expect(compacted(SESSION)).toEqual(QUIET);
    expect(files("wake-requests")).toEqual([]);
  });

  it("wakes no session after a compaction Claude Code started on its own, and leaves the request for the next one", () => {
    const { state, compacted, files } = hookSetup();
    state.leaveWakeRequest(SESSION, 0);

    const afterAuto = compacted(SESSION, "auto");
    const afterManual = compacted(SESSION, "manual");

    expect(afterAuto).toEqual(QUIET);
    expect(afterManual).toEqual({ exitCode: 2, stderr: SENTENCE });
    expect(files("wake-requests")).toEqual([]);
  });

  it("leaves the wake request of another conversation alone", () => {
    const { state, compacted, files } = hookSetup();
    state.leaveWakeRequest(OTHER_SESSION, 0);

    expect(compacted(SESSION)).toEqual(QUIET);
    expect(files("wake-requests")).toEqual([`${OTHER_SESSION}.json`]);
  });

  it.each([
    { what: "is not valid JSON", content: '{"version": 1, "sessionId"' },
    { what: "carries another version", content: JSON.stringify({ version: 2, sessionId: SESSION, requestedAt: "2026-11-12T03:04:05.000Z" }) },
  ])("treats a wake request that $what as absent", ({ content }) => {
    const { root, compacted, files } = hookSetup();
    mkdirSync(join(root, "wake-requests"), { recursive: true });
    writeFileSync(join(root, "wake-requests", `${SESSION}.json`), content);

    expect(compacted(SESSION)).toEqual(QUIET);
    expect(files("wake-requests")).toEqual([`${SESSION}.json`]);
  });

  it("reads no file outside the wake requests for a session ID that is not one", () => {
    const { root, state, compacted, files } = hookSetup();
    state.leaveWakeRequest(SESSION, 0);
    // A file that would pass for the wake request of "../decoy", one directory up from where wake requests are kept.
    writeFileSync(join(root, "decoy.json"), JSON.stringify({ version: 1, sessionId: "../decoy", requestedAt: "2026-11-12T03:04:05.000Z" }));

    expect(compacted("../decoy")).toEqual(QUIET);
    expect(existsSync(join(root, "decoy.json"))).toBe(true);
    expect(files("wake-requests")).toEqual([`${SESSION}.json`]);
  });
});

describe("the hooks and the server, as the plugin declares them", () => {
  /**
   * A home directory with the transcript of the session s-1, which this process stands for and which is in the
   * middle of a turn, and a stand-in for Terminal and Claude Code at once: what is typed is logged, and recorded in
   * the transcript as queued.
   */
  function session() {
    const home = temporaryDirectory();
    const project = join(home, ".claude", "projects", "-Users-someone-project");
    mkdirSync(project, { recursive: true });
    const transcript = join(project, "s-1.jsonl");
    writeFileSync(transcript, `${JSON.stringify({ type: "tools-used", tools: ["Read"], sessionId: "s-1" })}\n`);
    const typed = join(home, "typed.log");
    const queued = JSON.stringify({ type: "queue-operation", operation: "enqueue", timestamp: "2026-11-11T06:41:11.708Z", sessionId: "s-1", content: "/compact" });
    const osascript = [
      "shift $(( $# - 3 ))",
      `if [ "$3" = /compact ]; then echo "$1 $2 $3" >> '${typed}'; echo '${queued}' >> '${transcript}'; fi`,
      "echo '101 1 1'",
    ].join("\n");
    const { path } = standIns([{ kind: "interactive", pid: process.pid, cwd: home, name: "me", sessionId: "s-1", status: "busy" }], { osascript });
    const state = join(home, ".claude-session-pool");
    const compactSelf = () => withServer({ cwd: home, env: { PATH: path, HOME: home } }, (client) => callText(client, "compact_self", {}));
    return { home, typed, state, compactSelf };
  }

  it("compact_self types into the tab of the session whose hooks ran and leaves a wake request; the hook after the compaction then hands over the sentence alone, exits with code 2, and does so once", async () => {
    const { home, typed, state, compactSelf } = session();
    runHookProcess("SessionStart", { session_id: "s-1", source: "startup" }, home);

    const result = await compactSelf();

    expect(result.isError).toBe(false);
    expect(result.text).toContain("is queued");
    expect(readFileSync(typed, "utf8")).toBe("101 1 /compact\n");
    expect(readdirSync(join(state, "wake-requests"))).toEqual(["s-1.json"]);
    expect(readJson(join(state, "wake-requests", "s-1.json"))).toEqual({
      version: 1,
      sessionId: "s-1",
      requestedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/) as unknown,
    });

    const woken = runHookProcess("PostCompact", { session_id: "s-1", trigger: "manual", compact_summary: "…" }, home);
    const again = runHookProcess("PostCompact", { session_id: "s-1", trigger: "manual", compact_summary: "…" }, home);

    expect(woken).toEqual({ status: 2, stdout: "", stderr: `${SENTENCE}\n` });
    expect(readdirSync(join(state, "wake-requests"))).toEqual([]);
    expect(again).toEqual({ status: 0, stdout: "", stderr: "" });
  });

  it("compact_self refuses and types nothing in a session whose hooks did not run", async () => {
    const { typed, state, compactSelf } = session();

    const result = await compactSelf();

    expect(result.isError).toBe(true);
    expect(result.text).toContain("No hook record shows that the cc-session-pool plugin's hooks run in this session");
    expect(existsSync(typed)).toBe(false);
    expect(existsSync(join(state, "wake-requests"))).toBe(false);
  });
});
