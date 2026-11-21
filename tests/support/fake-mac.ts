import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Clock, Launch, Processes, SessionEntry, SessionLister, TabRef, Terminal } from "../../src/ports.ts";

export type FakeSession = SessionEntry & {
  tty?: string;
  model?: string;
  permissionMode?: string;
  /** Text that sits in the session's input box, not yet submitted. */
  inputBox?: string;
  /** Where the cursor sits in `inputBox`, counted from its start. Left out: at its end. */
  cursor?: number;
  /** Texts that were submitted during a turn and wait for it to end. */
  queued?: string[];
};

type FakeWindow = { id: number; tty: string; open: boolean; tabCount: number; text: string };

/**
 * A stand-in for the Mac the pool runs on: Claude Code's session listing, the Terminal application, process
 * signals and time. Time is virtual. It moves only when every running operation is waiting on `clock.sleep`.
 */
export class FakeMac {
  now = 0;
  sessions: FakeSession[] = [];
  windows: FakeWindow[] = [];
  launches: Launch[] = [];
  /** Everything typed into a tab. `interrupt` tells whether the input box was discarded first. */
  typed: { at: number; windowId: number; tab: number; command: string; interrupt: boolean }[] = [];
  terminated: number[] = [];
  closedWindows: number[] = [];

  /** How long after its window opens a new session is listed as idle. `undefined`: it is listed busy and stays so. */
  startupMs: number | undefined = 4000;
  /** What a typed `/clear` does. */
  clearEffect: "new-session-id" | "nothing" = "new-session-id";
  /** What a typed `/compact` does. */
  compactEffect: "compacts" | "nothing" | "busy-then-idle" | "busy-forever" = "compacts";
  /** Whether a text typed during a turn is recorded in the transcript as queued. */
  recordsQueue = true;
  /** Whether a session ends when asked to. */
  endsWhenAsked = true;
  /** Where compaction records are appended: `<transcriptRoot>/<project>/<sessionId>.jsonl`. */
  transcriptRoot: string | undefined;
  /** Makes every Terminal call fail with this message. */
  terminalFailure: string | undefined;
  /** Makes opening a window fail with this message, while the rest of Terminal keeps working. */
  openFailure: string | undefined;
  /** Makes reading a window's contents fail with this message. */
  contentsFailure: string | undefined;
  /** Makes closing a window fail with this message, while the rest of Terminal keeps working. */
  closeFailure: string | undefined;
  /** Makes the session listing fail with this message. */
  listingFailure: string | undefined;
  /** How long typing one command takes. */
  typingMs = 0;
  /** How long finding the tab on a terminal device takes. */
  tabLookupMs = 0;
  /** Makes typing fail with this message, while the rest of Terminal keeps working. */
  typingFailure: string | undefined;
  /**
   * The plugin's hook program, as Claude Code runs it in every session: it is given the event and the process ID of
   * the session. Left out: the plugin's hooks do not run.
   */
  hooks: ((input: Record<string, unknown>, sessionPid: number) => { exitCode: number; stderr: string }) | undefined;
  /** Every turn a hook started by waking a session: when, in which session, and what the model was handed. */
  woken: { at: number; pid: number; sessionId: string; text: string }[] = [];
  /** The largest number of commands that were being typed at the same moment. */
  mostTypingAtOnce = 0;
  /**
   * The directory where clear orders appear, which the plugin's mod watches in every session of this Mac. Left out:
   * nothing is watched. Claude Code tells the mod about a file one second after it appears or changes. The mod then
   * runs `/clear` in the session that the file is named after, once that session is idle, when the file's content
   * names the session, is version 1 and is less than 60 seconds old; a busy session is looked at again when its
   * turn ends.
   */
  modWatches: string | undefined;
  /** Whether Claude Code loads the plugin's mod. When it does not, a clear order appears and nothing acts on it. */
  modRuns = true;
  /** Every file that appeared or changed under `modWatches`: when, its name and what it held. */
  ordersSeen: { at: number; file: string; content: unknown }[] = [];

  private seenOrderFiles = new Map<string, string>();
  private stopped = false;
  private typingNow = 0;
  private nextPid = 5000;
  private nextWindowId = 100;
  private nextSessionNumber = 1;
  private timers: { at: number; run: () => void }[] = [];
  private pumping = false;

  readonly clock: Clock = {
    now: () => this.now,
    sleep: (ms) =>
      new Promise((resolve) => {
        this.at(ms, resolve);
      }),
  };

  readonly lister: SessionLister = {
    list: () =>
      soon(() => {
        if (this.listingFailure) throw new Error(this.listingFailure);
        return this.sessions.map(({ kind, cwd, pid, name, sessionId, status, waitingFor }) => ({ kind, cwd, pid, name, sessionId, status, waitingFor }));
      }),
  };

  readonly terminal: Terminal = {
    open: (launch) => soon(() => {
      this.failIfTerminalBroken();
      if (this.openFailure) throw new Error(this.openFailure);
      const window = this.addWindow();
      this.launches.push(launch);
      const session = this.sessionFromLaunch(launch, window.tty);
      if (this.startupMs === undefined) {
        this.sessions.push({ ...session, status: "busy" });
        window.text = "Do you trust the files in this folder?\n❯ 1. Yes, proceed\n  2. No, exit";
      } else {
        this.at(this.startupMs, () => {
          this.sessions.push(session);
          this.sessionStarted(session, "startup");
        });
      }
      return { windowId: window.id, tty: window.tty };
    }),
    findTab: async (tty) => {
      this.failIfTerminalBroken();
      if (this.tabLookupMs > 0) await this.clock.sleep(this.tabLookupMs);
      const window = this.windows.find((candidate) => candidate.open && candidate.tty === tty);
      return window && { windowId: window.id, tab: 1, tabCount: window.tabCount };
    },
    typeCommand: async (tab, command) => {
      this.failIfTerminalBroken();
      if (this.typingFailure) throw new Error(this.typingFailure);
      this.typingNow += 1;
      this.mostTypingAtOnce = Math.max(this.mostTypingAtOnce, this.typingNow);
      if (this.typingMs > 0) await this.clock.sleep(this.typingMs);
      this.typingNow -= 1;
      this.typed.push({ at: this.now, windowId: tab.windowId, tab: tab.tab, command, interrupt: true });
      const session = this.sessionIn(tab);
      if (session) session.inputBox = undefined;
      this.applyTyped(tab, command);
    },
    typeText: (tab, text) => soon(() => {
      this.failIfTerminalBroken();
      if (this.typingFailure) throw new Error(this.typingFailure);
      this.typed.push({ at: this.now, windowId: tab.windowId, tab: tab.tab, command: text, interrupt: false });
      const session = this.sessionIn(tab);
      if (!session) return;
      // Claude Code puts what is typed at the cursor of whatever already sits in the input box, and submits the whole.
      const box = session.inputBox ?? "";
      const cursor = session.cursor ?? box.length;
      const submitted = `${box.slice(0, cursor)}${text}${box.slice(cursor)}`;
      session.inputBox = undefined;
      session.cursor = undefined;
      if (session.status !== "busy") {
        this.applyTyped(tab, submitted);
        return;
      }
      (session.queued ??= []).push(submitted);
      if (this.recordsQueue) this.appendQueueRecord(session.sessionId!, "enqueue", submitted);
    }),
    lastLines: (windowId) =>
      soon(() => {
        if (this.contentsFailure) throw new Error(this.contentsFailure);
        return this.windows.find((window) => window.id === windowId)?.text ?? "";
      }),
    close: (windowId) => soon(() => {
      this.failIfTerminalBroken();
      if (this.closeFailure) throw new Error(this.closeFailure);
      const window = this.windows.find((candidate) => candidate.id === windowId);
      if (window) window.open = false;
      this.closedWindows.push(windowId);
    }),
  };

  readonly processes: Processes = {
    ttyOf: (pid) => soon(() => this.sessions.find((session) => session.pid === pid)?.tty),
    terminate: (pid) => {
      this.terminated.push(pid);
      if (this.endsWhenAsked) this.at(2000, () => this.endSession(pid));
    },
    isAlive: (pid) => this.sessions.some((session) => session.pid === pid),
  };

  /** Drops every pending timer, so that nothing the fake scheduled runs after a test has cleaned up. */
  stop(): void {
    this.stopped = true;
    this.timers = [];
  }

  /** Runs `run` once virtual time has advanced by `delayMs`. */
  at(delayMs: number, run: () => void): void {
    if (this.stopped) return;
    this.timers.push({ at: this.now + delayMs, run });
    this.pump();
  }

  /** A session the owner started by hand in its own Terminal window. */
  addSession(overrides: Partial<FakeSession> & { name: string; cwd: string }): FakeSession {
    const window = overrides.tty === undefined ? this.addWindow() : undefined;
    const session: FakeSession = {
      kind: "interactive",
      pid: this.nextPid++,
      sessionId: this.newSessionId(),
      status: "idle",
      tty: window?.tty,
      ...overrides,
    };
    this.sessions.push(session);
    this.sessionStarted(session, "startup");
    return session;
  }

  session(name: string): FakeSession {
    const found = this.sessions.filter((session) => session.name === name);
    if (found.length !== 1) throw new Error(`expected exactly one fake session named ${name}, found ${found.length}`);
    return found[0]!;
  }

  endSession(pid: number): void {
    this.sessions = this.sessions.filter((session) => session.pid !== pid);
  }

  /** Ends the turn a session is in. A `/compact` that was queued during the turn then runs, as it does in Claude Code. */
  endTurn(session: FakeSession): void {
    const queued = session.queued ?? [];
    session.queued = [];
    session.status = "idle";
    if (queued.includes("/compact")) this.compact(session, 0);
    this.modActsOnOrder(session);
  }

  /** A compaction that Claude Code starts on its own, finished at once. */
  compactOnItsOwn(session: FakeSession): void {
    this.appendCompactionRecord(session.sessionId!, "auto");
    this.compactionFinished(session, "auto");
  }

  windowOf(session: FakeSession): FakeWindow {
    const window = this.windows.find((candidate) => candidate.tty === session.tty);
    if (!window) throw new Error(`fake session ${session.name} has no window`);
    return window;
  }

  openWindowIds(): number[] {
    return this.windows.filter((window) => window.open).map((window) => window.id);
  }

  /** Appends a record shaped like the one Claude Code 2.1.318 writes when a compaction finishes. */
  appendCompactionRecord(sessionId: string, trigger: "manual" | "auto" = "manual"): void {
    appendFileSync(this.transcriptPath(sessionId), `${JSON.stringify(compactionRecord(sessionId, trigger))}\n`);
  }

  /** Appends a record shaped like the one Claude Code 2.1.322 writes when a text is put on, or taken off, a session's queue. */
  appendQueueRecord(sessionId: string, operation: "enqueue" | "dequeue", content?: string): void {
    const record = { type: "queue-operation", operation, timestamp: "2026-11-11T06:41:11.708Z", sessionId, content };
    appendFileSync(this.transcriptPath(sessionId), `${JSON.stringify(record)}\n`);
  }

  /** Appends an ordinary record, as every turn does. */
  appendTurnRecord(sessionId: string): void {
    const record = { type: "tools-used", tools: ["SendMessage", "Read"], sessionId };
    appendFileSync(this.transcriptPath(sessionId), `${JSON.stringify(record)}\n`);
  }

  private transcriptPath(sessionId: string): string {
    if (!this.transcriptRoot) throw new Error("the fake has no transcript root");
    const directory = join(this.transcriptRoot, "-Users-someone-project");
    mkdirSync(directory, { recursive: true });
    return join(directory, `${sessionId}.jsonl`);
  }

  private sessionIn(tab: TabRef): FakeSession | undefined {
    const window = this.windows.find((candidate) => candidate.id === tab.windowId);
    return this.sessions.find((candidate) => candidate.tty === window?.tty);
  }

  private applyTyped(tab: TabRef, command: string): void {
    const session = this.sessionIn(tab);
    if (!session) return;
    if (command === "/clear" && this.clearEffect === "new-session-id") {
      this.at(1000, () => {
        session.sessionId = this.newSessionId();
        this.sessionStarted(session, "clear");
      });
    }
    if (command === "/compact") this.compact(session, 1000);
  }

  /** What `/compact` does to a session, starting `startsInMs` after the command reaches it. */
  private compact(session: FakeSession, startsInMs: number): void {
    if (this.compactEffect === "nothing") return;
    const sessionId = session.sessionId!;
    this.at(startsInMs, () => {
      session.status = "busy";
    });
    if (this.compactEffect === "busy-forever") return;
    this.at(startsInMs + 7000, () => {
      if (this.compactEffect === "compacts") this.appendCompactionRecord(sessionId);
      session.status = "idle";
      if (this.compactEffect === "compacts") this.compactionFinished(session, "manual");
    });
  }

  /** Claude Code's file watch on `modWatches`: what is new or changed since the last look is told to the mod a second later. */
  private watchOrders(): void {
    if (!this.modWatches) return;
    let names: string[];
    try {
      names = readdirSync(this.modWatches).filter((name) => name.endsWith(".json"));
    } catch {
      names = [];
    }
    for (const file of [...this.seenOrderFiles.keys()]) if (!names.includes(file)) this.seenOrderFiles.delete(file);
    for (const file of names) {
      const text = readFileSync(join(this.modWatches, file), "utf8");
      if (this.seenOrderFiles.get(file) === text) continue;
      this.seenOrderFiles.set(file, text);
      this.ordersSeen.push({ at: this.now, file, content: JSON.parse(text) as unknown });
      this.at(1000, () => {
        for (const session of [...this.sessions]) this.modActsOnOrder(session);
      });
    }
  }

  /** What the mod in `session` does about the clear order named after the session's present session ID. */
  private modActsOnOrder(session: FakeSession): void {
    if (!this.modWatches || !this.modRuns || session.sessionId === undefined || !this.sessions.includes(session)) return;
    let order: Record<string, unknown>;
    try {
      order = JSON.parse(readFileSync(join(this.modWatches, `${session.sessionId}.json`), "utf8")) as Record<string, unknown>;
    } catch {
      return;
    }
    const requestedAt = typeof order.requestedAt === "string" ? Date.parse(order.requestedAt) : Number.NaN;
    const age = this.now - requestedAt;
    if (order.version !== 1 || order.sessionId !== session.sessionId || !(age >= 0 && age < 60_000)) return;
    if (session.status !== "idle") return;
    session.sessionId = this.newSessionId();
    this.sessionStarted(session, "clear");
  }

  /** Claude Code runs the plugin's `SessionStart` hook whenever a session starts on a conversation. */
  private sessionStarted(session: FakeSession, source: "startup" | "clear" | "compact"): void {
    this.hooks?.({ hook_event_name: "SessionStart", session_id: session.sessionId, source }, session.pid!);
  }

  /**
   * Claude Code runs the plugin's hooks when a compaction has finished. A `PostCompact` hook that exits with code 2
   * makes the idle session start a turn, as one declared with `asyncRewake` was seen to do on Claude Code 2.1.322.
   */
  private compactionFinished(session: FakeSession, trigger: "manual" | "auto"): void {
    if (!this.hooks || !this.sessions.includes(session)) return;
    this.sessionStarted(session, "compact");
    const result = this.hooks({ hook_event_name: "PostCompact", session_id: session.sessionId, trigger }, session.pid!);
    if (result.exitCode !== 2) return;
    this.woken.push({ at: this.now, pid: session.pid!, sessionId: session.sessionId!, text: result.stderr });
    session.status = "busy";
  }

  private sessionFromLaunch(launch: Launch, tty: string): FakeSession {
    const option = (flag: string) => {
      const index = launch.argv.indexOf(flag);
      return index === -1 ? undefined : launch.argv[index + 1];
    };
    return {
      kind: "interactive",
      pid: this.nextPid++,
      cwd: launch.directory,
      name: option("-n"),
      sessionId: this.newSessionId(),
      status: "idle",
      tty,
      model: option("--model"),
      permissionMode: option("--permission-mode"),
    };
  }

  private addWindow(): FakeWindow {
    const id = this.nextWindowId++;
    const window = { id, tty: `/dev/ttys${id}`, open: true, tabCount: 1, text: "" };
    this.windows.push(window);
    return window;
  }

  private newSessionId(): string {
    return `00000000-0000-4000-8000-${String(this.nextSessionNumber++).padStart(12, "0")}`;
  }

  private failIfTerminalBroken(): void {
    if (this.terminalFailure) throw new Error(this.terminalFailure);
  }

  /** Advances virtual time to the next timer once nothing else can run. */
  private pump(): void {
    if (this.pumping) return;
    this.pumping = true;
    setImmediate(() => {
      this.pumping = false;
      this.watchOrders();
      if (this.timers.length === 0) return;
      const next = Math.min(...this.timers.map((timer) => timer.at));
      this.now = next;
      const due = this.timers.filter((timer) => timer.at === next);
      this.timers = this.timers.filter((timer) => timer.at !== next);
      for (const timer of due) timer.run();
      this.pump();
    });
  }
}

/** A promise for what `compute` returns, rejected when it throws: what an adapter that runs a program gives back. */
function soon<T>(compute: () => T): Promise<T> {
  return new Promise((resolve) => {
    resolve(compute());
  });
}

function compactionRecord(sessionId: string, trigger: "manual" | "auto"): Record<string, unknown> {
  return {
    parentUuid: null,
    logicalParentUuid: "88c6cc0e-f025-4c3a-aa3d-586c335ac6c2",
    isSidechain: false,
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    level: "info",
    compactMetadata: { trigger, preTokens: 57902, postTokens: 10660, cumulativeDroppedTokens: 47242, durationMs: 8908 },
    uuid: "dec74024-2aa2-441e-8dad-edb5e073e5db",
    timestamp: "2026-11-10T15:23:20.408Z",
    userType: "external",
    entrypoint: "cli",
    cwd: "/Users/someone/project",
    sessionId,
    version: "2.1.318",
  };
}
