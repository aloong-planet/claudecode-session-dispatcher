import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Clock, Launch, Processes, SessionEntry, SessionLister, TabRef, Terminal } from "../../src/ports.ts";

export type FakeSession = SessionEntry & { tty?: string; model?: string; permissionMode?: string };

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
  typed: { at: number; windowId: number; tab: number; command: string }[] = [];
  terminated: number[] = [];
  closedWindows: number[] = [];

  /** How long after its window opens a new session is listed as idle. `undefined`: it is listed busy and stays so. */
  startupMs: number | undefined = 4000;
  /** What a typed `/clear` does. */
  clearEffect: "new-session-id" | "nothing" = "new-session-id";
  /** What a typed `/compact` does. */
  compactEffect: "compacts" | "nothing" | "busy-then-idle" | "busy-forever" = "compacts";
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
  /** The largest number of commands that were being typed at the same moment. */
  mostTypingAtOnce = 0;

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
        this.at(this.startupMs, () => this.sessions.push(session));
      }
      return { windowId: window.id, tty: window.tty };
    }),
    findTab: (tty) => soon(() => {
      this.failIfTerminalBroken();
      const window = this.windows.find((candidate) => candidate.open && candidate.tty === tty);
      return window && { windowId: window.id, tab: 1, tabCount: window.tabCount };
    }),
    typeCommand: async (tab, command) => {
      this.failIfTerminalBroken();
      this.typingNow += 1;
      this.mostTypingAtOnce = Math.max(this.mostTypingAtOnce, this.typingNow);
      if (this.typingMs > 0) await this.clock.sleep(this.typingMs);
      this.typingNow -= 1;
      this.typed.push({ at: this.now, windowId: tab.windowId, tab: tab.tab, command });
      this.applyTyped(tab, command);
    },
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

  windowOf(session: FakeSession): FakeWindow {
    const window = this.windows.find((candidate) => candidate.tty === session.tty);
    if (!window) throw new Error(`fake session ${session.name} has no window`);
    return window;
  }

  openWindowIds(): number[] {
    return this.windows.filter((window) => window.open).map((window) => window.id);
  }

  /** Appends a record shaped like the one Claude Code 2.1.318 writes when a compaction finishes. */
  appendCompactionRecord(sessionId: string): void {
    appendFileSync(this.transcriptPath(sessionId), `${JSON.stringify(compactionRecord(sessionId))}\n`);
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

  private applyTyped(tab: TabRef, command: string): void {
    const window = this.windows.find((candidate) => candidate.id === tab.windowId);
    const session = this.sessions.find((candidate) => candidate.tty === window?.tty);
    if (!session) return;
    if (command === "/clear" && this.clearEffect === "new-session-id") {
      this.at(1000, () => {
        session.sessionId = this.newSessionId();
      });
    }
    if (command === "/compact" && this.compactEffect !== "nothing") {
      const sessionId = session.sessionId!;
      this.at(1000, () => {
        session.status = "busy";
      });
      if (this.compactEffect === "busy-forever") return;
      this.at(8000, () => {
        if (this.compactEffect === "compacts") this.appendCompactionRecord(sessionId);
        session.status = "idle";
      });
    }
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

function compactionRecord(sessionId: string): Record<string, unknown> {
  return {
    parentUuid: null,
    logicalParentUuid: "88c6cc0e-f025-4c3a-aa3d-586c335ac6c2",
    isSidechain: false,
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    level: "info",
    compactMetadata: { trigger: "manual", preTokens: 57902, postTokens: 10660, cumulativeDroppedTokens: 47242, durationMs: 8908 },
    uuid: "dec74024-2aa2-441e-8dad-edb5e073e5db",
    timestamp: "2026-11-10T15:23:20.408Z",
    userType: "external",
    entrypoint: "cli",
    cwd: "/Users/someone/project",
    sessionId,
    version: "2.1.318",
  };
}
