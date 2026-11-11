import type { Clock, Processes, SessionEntry, SessionLister, TabRef, Terminal, TranscriptMark, Transcripts } from "./ports.ts";
import { type Outcome, attempt, describeSession } from "./report.ts";
import { Refusal } from "./validate.ts";

export type SelfCompactionDeps = {
  /** The process ID of the attached session: the session that started this server process. */
  sessionPid: number;
  sessions: SessionLister;
  terminal: Terminal;
  processes: Processes;
  transcripts: Transcripts;
  clock: Clock;
};

export const SELF_LIMITS = {
  pollMs: 1000,
  compactPollMs: 2000,
  queuedConfirmMs: 10_000,
  compactionMs: 30 * 60_000,
  idleAfterCompactionMs: 60_000,
};

const COMMAND = "/compact";
const FOLLOW_UP = "continue";

type Attached = SessionEntry & { pid: number };

/** The compaction a session asks for itself: `/compact` typed into its own Terminal tab, then `continue`. */
export class SelfCompaction {
  private readonly deps: SelfCompactionDeps;
  private pending = false;

  constructor(deps: SelfCompactionDeps) {
    this.deps = deps;
  }

  request(): Promise<Outcome> {
    return attempt(() => this.start());
  }

  private async start(): Promise<string> {
    if (this.pending) throw new Refusal("An earlier compact_self call of this session is still pending; nothing was typed.");
    this.pending = true;
    let followed = false;
    try {
      const pid = this.deps.sessionPid;
      // The tab is found first, so that reading the session's state is the last step before the typing: a prompt
      // that came up between the two would receive the typed characters.
      const tab = await this.findTab();
      const session = await this.attached();
      if (!session) throw new Refusal(`This session (pid ${pid}) is not listed as a live interactive session; nothing was typed.`);
      if (session.status !== "busy") {
        throw new Refusal(
          `This session is ${describeSession(session)}, and compact_self types only while the session is busy with the turn that calls it; nothing was typed.`,
        );
      }
      const mark = session.sessionId === undefined ? undefined : this.deps.transcripts.mark(session.sessionId);
      if (!mark) {
        throw new Refusal(
          `The transcript of this session (${session.sessionId ?? "no session ID is listed"}) could not be found or read, so its compaction could not be followed; nothing was typed.`,
        );
      }
      if (!tab) throw new Refusal(`This session (pid ${pid}) does not run in a Terminal window; nothing was typed.`);
      // No interrupt before the command: it would end the turn that is making this call.
      await this.deps.terminal.typeText(tab, COMMAND);
      const typedAt = this.deps.clock.now();
      const typed = `"${COMMAND}" was typed into this session's Terminal tab`;
      const queued = await this.queuedAs(mark, typedAt);
      if (queued !== undefined && queued !== COMMAND) {
        throw new Refusal(
          `${typed}, but it was queued together with text that was sitting in the input box, as ${JSON.stringify(queued)}. No compaction will run, and nothing further will be typed.`,
        );
      }
      followed = true;
      void this.followUp(session, mark, typedAt);
      if (queued === undefined) {
        throw new Refusal(
          `unconfirmed: ${typed}, but its transcript did not show it queued ${SELF_LIMITS.queuedConfirmMs / 1000} seconds later. If a compaction is recorded within ${SELF_LIMITS.compactionMs / 60_000} minutes of the typing, "${FOLLOW_UP}" is still typed.`,
        );
      }
      return `${typed} and is queued. It runs when this turn ends, so end the turn now. Once the compaction is recorded, "${FOLLOW_UP}" is typed into this session.`;
    } finally {
      if (!followed) this.pending = false;
    }
  }

  /** How the transcript shows the command queued: on its own, as part of a longer text, or not at all within the limit. */
  private async queuedAs(mark: TranscriptMark, typedAt: number): Promise<string | undefined> {
    const deadline = typedAt + SELF_LIMITS.queuedConfirmMs;
    for (;;) {
      const texts = this.deps.transcripts.queuedSince(mark);
      if (texts.includes(COMMAND)) return COMMAND;
      // The command lands at the cursor, which can sit anywhere in the text that was in the input box.
      const merged = texts.find((text) => text.includes(COMMAND));
      if (merged !== undefined) return merged;
      if (this.deps.clock.now() >= deadline) return undefined;
      await this.deps.clock.sleep(SELF_LIMITS.pollMs);
    }
  }

  /** Waits for the compaction the command starts, then for the session to be idle, and types the follow-up. */
  private async followUp(before: Attached, mark: TranscriptMark, typedAt: number): Promise<void> {
    try {
      if (!(await this.compacted(before, mark, typedAt + SELF_LIMITS.compactionMs))) return;
      if (!(await this.idleAgain(before))) return;
      const tab = await this.findTab();
      if (tab) await this.deps.terminal.typeCommand(tab, FOLLOW_UP);
    } catch {
      // The call that asked for the compaction has returned, so there is no caller to report a failure to.
    } finally {
      this.pending = false;
    }
  }

  private async compacted(before: Attached, mark: TranscriptMark, deadline: number): Promise<boolean> {
    for (;;) {
      await this.deps.clock.sleep(SELF_LIMITS.compactPollMs);
      if (this.deps.transcripts.compactedSince(mark, "requested")) return true;
      const now = await this.observe();
      if (now !== "unknown" && !sameSession(now, before)) return false;
      if (this.deps.clock.now() >= deadline) return false;
    }
  }

  private async idleAgain(before: Attached): Promise<boolean> {
    const deadline = this.deps.clock.now() + SELF_LIMITS.idleAfterCompactionMs;
    for (;;) {
      const now = await this.observe();
      if (now !== "unknown") {
        if (!sameSession(now, before)) return false;
        if (now?.status === "idle") return true;
      }
      if (this.deps.clock.now() >= deadline) return false;
      await this.deps.clock.sleep(SELF_LIMITS.pollMs);
    }
  }

  private async attached(): Promise<Attached | undefined> {
    return (await this.deps.sessions.list()).find(
      (session): session is Attached => session.kind === "interactive" && session.pid === this.deps.sessionPid,
    );
  }

  /** The attached session during a wait. A listing that fails is "unknown", so that the wait can go on. */
  private async observe(): Promise<Attached | undefined | "unknown"> {
    try {
      return await this.attached();
    } catch {
      return "unknown";
    }
  }

  private async findTab(): Promise<TabRef | undefined> {
    const tty = await this.deps.processes.ttyOf(this.deps.sessionPid);
    return tty === undefined ? undefined : this.deps.terminal.findTab(tty);
  }
}

/** Whether the session is still listed and still holds the conversation the command was typed into. */
function sameSession(now: Attached | undefined, before: Attached): boolean {
  return now !== undefined && now.sessionId === before.sessionId;
}
