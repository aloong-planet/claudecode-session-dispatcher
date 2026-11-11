/**
 * A session's compaction of itself, through the one public method, together with the plugin's hook that wakes the
 * session afterwards.
 *
 * Claude Code's session listing, the Terminal application and process signals are replaced by `FakeMac`; transcripts,
 * hook records and wake requests are real files in a temporary directory; time is the fake's virtual clock. The fake
 * queues a text that is typed during a turn and runs a queued `/compact` when the turn ends, as Claude Code 2.1.322
 * was seen to do. It runs the real hook program at the moments Claude Code runs a plugin's hooks, and starts a turn
 * in a session whose `PostCompact` hook exits with code 2.
 *
 * Not covered here, because it needs the real programs: that Claude Code queues what is typed during a turn, runs
 * a queued `/compact` when the turn ends, runs the hooks and wakes the session. These are checked by hand with a
 * real session. A prompt that comes up between the reading of the session's state and the typing of `/compact`
 * cannot be driven: the server does not detect it. Neither can a call made by a subagent of the session, which the
 * server cannot tell from the session's own, or hooks that are switched off after the hook record was written.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileTranscripts } from "../src/adapters/transcripts.ts";
import { runHook } from "../src/hooks.ts";
import { SelfCompaction } from "../src/self-compaction.ts";
import { WakeState } from "../src/wake.ts";
import { FakeMac, type FakeSession } from "./support/fake-mac.ts";

const temporaryDirectories: string[] = [];
const fakes: FakeMac[] = [];

afterEach(() => {
  for (const fake of fakes.splice(0)) fake.stop();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
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
  const home = realpathSync(mkdtempSync(join(tmpdir(), "claude-session-pool-")));
  temporaryDirectories.push(home);
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
