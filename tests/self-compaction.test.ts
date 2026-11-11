/**
 * A session's compaction of itself, through the one public method.
 *
 * Claude Code's session listing, the Terminal application and process signals are replaced by `FakeMac`; transcripts
 * are real files in a temporary directory; time is the fake's virtual clock. The fake queues a text that is typed
 * during a turn and runs a queued `/compact` when the turn ends, as Claude Code 2.1.322 was seen to do.
 *
 * Not covered here, because it needs the real programs: that Claude Code queues what is typed during a turn, runs
 * a queued `/compact` when the turn ends and takes `continue` as a message. These are checked by hand with a real
 * session. A message that reaches the session between the idle check and the typing of `continue` cannot be driven:
 * the server does not detect it. The same holds for a prompt that comes up between the reading of the session's
 * state and the typing of `/compact`.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileTranscripts } from "../src/adapters/transcripts.ts";
import { SelfCompaction } from "../src/self-compaction.ts";
import { FakeMac, type FakeSession } from "./support/fake-mac.ts";

const temporaryDirectories: string[] = [];
const fakes: FakeMac[] = [];

afterEach(() => {
  for (const fake of fakes.splice(0)) fake.stop();
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

const QUEUED =
  '"/compact" was typed into this session\'s Terminal tab and is queued. It runs when this turn ends, so end the turn now. Once the compaction is recorded, "continue" is typed into this session.';
const MINUTE = 60_000;

/** A session in the middle of a turn, in its own Terminal window, with a transcript, next to a session it must not touch. */
function setup(options: { session?: Partial<FakeSession>; transcript?: boolean; attachedTo?: number } = {}) {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "claude-session-pool-")));
  temporaryDirectories.push(home);
  const directory = join(home, "project");
  const transcriptRoot = join(home, "transcripts");
  for (const path of [directory, transcriptRoot]) mkdirSync(path);
  const mac = new FakeMac();
  fakes.push(mac);
  mac.transcriptRoot = transcriptRoot;
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
  });
  const typedCommands = () => mac.typed.map((entry) => entry.command);
  return { mac, self, session, typedCommands };
}

describe("compact_self", () => {
  it("types /compact into the session's own tab without an interrupt and reports it queued", async () => {
    const { mac, self, session } = setup();

    const outcome = await self.request();

    expect(outcome).toEqual({ ok: true, text: QUEUED });
    expect(mac.typed).toEqual([{ at: 0, windowId: mac.windowOf(session).id, tab: 1, command: "/compact", interrupt: false }]);
  });

  it("types continue, discarding the input box, once the compaction is recorded and the session is idle", async () => {
    const { mac, self, session } = setup();
    mac.at(3000, () => mac.endTurn(session));

    await self.request();
    await mac.clock.sleep(2 * MINUTE);

    const windowId = mac.windowOf(session).id;
    expect(mac.typed.map(({ windowId, command, interrupt }) => ({ windowId, command, interrupt }))).toEqual([
      { windowId, command: "/compact", interrupt: false },
      { windowId, command: "continue", interrupt: true },
    ]);
    // The turn ends at 3 seconds and the fake's compaction takes 7.
    expect(mac.typed[1]!.at).toBeGreaterThanOrEqual(10_000);
  });

  it.each([
    { where: "after the text in the input box", session: { inputBox: "half typed" }, queuedAs: '"half typed/compact"' },
    // A real session queued exactly this text when the cursor sat before the last word.
    { where: "at the cursor, inside the text in the input box", session: { inputBox: "fix the typo", cursor: 8 }, queuedAs: '"fix the /compacttypo"' },
  ])("reports the text the command was queued with when it landed $where, and is not pending afterwards", async ({ session, queuedAs }) => {
    const { self, typedCommands } = setup({ session });

    const outcome = await self.request();
    const again = await self.request();

    expect(outcome).toEqual({
      ok: false,
      text: `"/compact" was typed into this session's Terminal tab, but it was queued together with text that was sitting in the input box, as ${queuedAs}. No compaction will run, and nothing further will be typed.`,
    });
    expect(again).toEqual({ ok: true, text: QUEUED });
    expect(typedCommands()).toEqual(["/compact", "/compact"]);
  });

  it("types nothing after a command that was queued with other text, even when a compaction is recorded later", async () => {
    const { mac, self, session, typedCommands } = setup({ session: { inputBox: "half typed" } });

    await self.request();
    mac.endTurn(session);
    mac.appendCompactionRecord(session.sessionId!);
    await mac.clock.sleep(2 * MINUTE);

    expect(typedCommands()).toEqual(["/compact"]);
  });

  it("reports the command queued when its record reaches the transcript after the first reading", async () => {
    const { mac, self, session } = setup();
    mac.recordsQueue = false;
    mac.at(1500, () => mac.appendQueueRecord(session.sessionId!, "enqueue", "/compact"));

    const outcome = await self.request();

    expect(outcome).toEqual({ ok: true, text: QUEUED });
    expect(mac.now).toBeLessThan(10_000);
  });

  it("reports unconfirmed when nothing is shown queued after 10 seconds, and still types continue after a compaction", async () => {
    const { mac, self, session, typedCommands } = setup();
    mac.recordsQueue = false;
    mac.at(3000, () => mac.endTurn(session));

    const outcome = await self.request();

    expect(outcome.ok).toBe(false);
    expect(outcome.text).toMatch(/^unconfirmed: "\/compact" was typed into this session's Terminal tab, but its transcript did not show it queued 10 seconds later\./);
    expect(mac.now).toBe(10_000);
    await mac.clock.sleep(2 * MINUTE);
    expect(typedCommands()).toEqual(["/compact", "continue"]);
  });

  it.each([
    { what: "the session is not in the listing", options: { attachedTo: 99_999 }, reason: "(pid 99999) is not listed as a live interactive session" },
    { what: "the session is a background session", options: { session: { kind: "background" } }, reason: "is not listed as a live interactive session" },
    { what: "the session is idle", options: { session: { status: "idle" } }, reason: "This session is idle, and compact_self types only while the session is busy" },
    {
      what: "a prompt is on screen",
      options: { session: { status: "waiting", waitingFor: "permission to use Bash" } },
      reason: "This session is waiting for permission to use Bash, and compact_self types only while the session is busy",
    },
    { what: "the transcript is missing", options: { transcript: false }, reason: "could not be found or read, so its compaction could not be followed" },
    { what: "no Terminal tab hosts the session", options: { session: { tty: "/dev/ttys999" } }, reason: "does not run in a Terminal window" },
  ])("refuses and types nothing when $what", async ({ options, reason }) => {
    const { mac, self } = setup(options);

    const outcome = await self.request();

    expect(outcome.ok).toBe(false);
    expect(outcome.text).toContain(reason);
    expect(outcome.text).toMatch(/nothing was typed\.$/);
    expect(mac.typed).toEqual([]);
  });

  it("refuses and types nothing when a prompt comes up while the tab is being looked up", async () => {
    const { mac, self, session } = setup();
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
  });

  it("refuses a second call while the first is pending, and types the command once", async () => {
    const { self, typedCommands } = setup();

    await self.request();
    const second = await self.request();

    expect(second).toEqual({ ok: false, text: "An earlier compact_self call of this session is still pending; nothing was typed." });
    expect(typedCommands()).toEqual(["/compact"]);
  });

  it("gives up 30 minutes after the typing when no compaction is recorded", async () => {
    const { mac, self, typedCommands } = setup();

    await self.request();
    await mac.clock.sleep(30 * MINUTE - 1000);
    const stillPending = await self.request();
    await mac.clock.sleep(2000);
    const afterwards = await self.request();

    expect(stillPending.text).toContain("still pending");
    expect(afterwards).toEqual({ ok: true, text: QUEUED });
    expect(typedCommands()).toEqual(["/compact", "/compact"]);
  });

  it.each([
    {
      what: "the session is still not idle 60 seconds after the compaction was recorded",
      then: (mac: FakeMac, session: FakeSession) => {
        mac.at(5000, () => mac.appendCompactionRecord(session.sessionId!));
        mac.at(70_000, () => (session.status = "idle"));
      },
    },
    {
      what: "the session has ended",
      then: (mac: FakeMac, session: FakeSession) => {
        const sessionId = session.sessionId!;
        mac.at(5000, () => mac.endSession(session.pid!));
        mac.at(7000, () => mac.appendCompactionRecord(sessionId));
      },
    },
    {
      what: "the session's ID has changed",
      then: (mac: FakeMac, session: FakeSession) => {
        const sessionId = session.sessionId!;
        mac.at(5000, () => {
          session.sessionId = "00000000-0000-4000-8000-999999999999";
          session.status = "idle";
        });
        mac.at(7000, () => mac.appendCompactionRecord(sessionId));
      },
    },
    {
      what: "the session's ID changes after the compaction was recorded, before the session is seen idle",
      then: (mac: FakeMac, session: FakeSession) => {
        mac.at(5000, () => mac.appendCompactionRecord(session.sessionId!));
        mac.at(6500, () => {
          session.sessionId = "00000000-0000-4000-8000-999999999999";
          session.status = "idle";
        });
      },
    },
  ])("types no continue, and stops being pending, when $what", async ({ then }) => {
    const { mac, self, session, typedCommands } = setup();
    then(mac, session);

    await self.request();
    await mac.clock.sleep(3 * MINUTE);
    const afterwards = await self.request();

    expect(typedCommands()).not.toContain("continue");
    expect(afterwards.text).not.toContain("still pending");
  });

  it("waits for the compaction the command starts when Claude Code compacts on its own first", async () => {
    const { mac, self, session, typedCommands } = setup();
    mac.at(2000, () => mac.appendCompactionRecord(session.sessionId!, "auto"));
    mac.at(5000, () => mac.endTurn(session));

    await self.request();
    await mac.clock.sleep(2 * MINUTE);

    expect(typedCommands()).toEqual(["/compact", "continue"]);
    // The turn ends at 5 seconds and the fake's compaction takes 7.
    expect(mac.typed[1]!.at).toBeGreaterThanOrEqual(12_000);
  });

  it("types continue once the session is idle, seconds after the compaction was recorded and through a listing that fails in between", async () => {
    const { mac, self, session, typedCommands } = setup();
    mac.at(5000, () => mac.appendCompactionRecord(session.sessionId!));
    mac.at(8000, () => (mac.listingFailure = "claude agents exited with code 1"));
    mac.at(12_000, () => (mac.listingFailure = undefined));
    mac.at(20_000, () => (session.status = "idle"));

    await self.request();
    await mac.clock.sleep(2 * MINUTE);

    expect(typedCommands()).toEqual(["/compact", "continue"]);
    expect(mac.typed[1]!.at).toBeGreaterThanOrEqual(20_000);
  });

  it("returns Terminal's error when Terminal cannot be scripted, and accepts a later call", async () => {
    const { mac, self, typedCommands } = setup();
    mac.terminalFailure = "Not authorised to send Apple events to Terminal.";

    const refused = await self.request();
    mac.terminalFailure = undefined;
    const later = await self.request();

    expect(refused).toEqual({ ok: false, text: "Not authorised to send Apple events to Terminal." });
    expect(later).toEqual({ ok: true, text: QUEUED });
    expect(typedCommands()).toEqual(["/compact"]);
  });

  it("keeps waiting while the sessions cannot be listed", async () => {
    const { mac, self, session, typedCommands } = setup();
    mac.at(3000, () => mac.endTurn(session));
    mac.at(4000, () => (mac.listingFailure = "claude agents exited with code 1"));
    mac.at(9000, () => (mac.listingFailure = undefined));

    await self.request();
    await mac.clock.sleep(2 * MINUTE);

    expect(typedCommands()).toEqual(["/compact", "continue"]);
  });
});
