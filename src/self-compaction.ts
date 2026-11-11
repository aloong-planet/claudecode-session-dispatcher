import type { Clock, Processes, SessionEntry, SessionLister, TabRef, Terminal, TranscriptMark, Transcripts } from "./ports.ts";
import { type Outcome, attempt, describeSession } from "./report.ts";
import { Refusal } from "./validate.ts";
import { PLUGIN_NAME, type WakeState } from "./wake.ts";

export type SelfCompactionDeps = {
  /** The process ID of the attached session: the session that started this server process. */
  sessionPid: number;
  sessions: SessionLister;
  terminal: Terminal;
  processes: Processes;
  transcripts: Transcripts;
  clock: Clock;
  /** Where the plugin's hooks leave their records, and where the wake request for the hook is left. */
  wake: WakeState;
};

export const SELF_LIMITS = {
  pollMs: 1000,
  queuedConfirmMs: 10_000,
  /** How long a wake request stands in the way of another call. */
  wakeRequestMs: 30 * 60_000,
};

const COMMAND = "/compact";

type Attached = SessionEntry & { pid: number };

/**
 * The compaction a session asks for itself: `/compact` typed into its own Terminal tab, and a wake request left for
 * the plugin's hook, which wakes the session when the compaction has finished.
 */
export class SelfCompaction {
  private readonly deps: SelfCompactionDeps;

  constructor(deps: SelfCompactionDeps) {
    this.deps = deps;
  }

  request(): Promise<Outcome> {
    return attempt(() => this.start());
  }

  private async start(): Promise<string> {
    const { sessionPid: pid, wake, clock } = this.deps;
    // The tab is found first, so that reading the session's state is the last program run before the typing: a
    // prompt that came up between the two would receive the typed characters.
    const tab = await this.findTab();
    const session = await this.attached();
    if (!session) throw new Refusal(`This session (pid ${pid}) is not listed as a live interactive session; nothing was typed.`);
    if (session.status !== "busy") {
      throw new Refusal(
        `This session is ${describeSession(session)}, and compact_self types only while the session is busy with the turn that calls it; nothing was typed.`,
      );
    }
    const sessionId = session.sessionId;
    const mark = sessionId === undefined ? undefined : this.deps.transcripts.mark(sessionId);
    if (sessionId === undefined || !mark) {
      throw new Refusal(
        `The transcript of this session (${sessionId ?? "no session ID is listed"}) could not be found or read, so it could not be confirmed that the command is queued; nothing was typed.`,
      );
    }
    if (!tab) throw new Refusal(`This session (pid ${pid}) does not run in a Terminal window; nothing was typed.`);
    if (wake.hookRecord(pid) !== sessionId) {
      throw new Refusal(
        `No hook record shows that the ${PLUGIN_NAME} plugin's hooks run in this session (pid ${pid}, session ${sessionId}), so nothing would wake it after the compaction; nothing was typed.`,
      );
    }
    const standing = wake.wakeRequestedAt(sessionId);
    if (standing !== undefined && clock.now() - standing < SELF_LIMITS.wakeRequestMs) {
      throw new Refusal(
        `This session's conversation has a wake request that an earlier compact_self call left less than ${SELF_LIMITS.wakeRequestMs / 60_000} minutes ago (at ${new Date(standing).toISOString()}); nothing was typed.`,
      );
    }
    // From the check above to here nothing is awaited, so two calls that arrive together cannot both pass it.
    wake.leaveWakeRequest(sessionId, clock.now());
    try {
      // No interrupt before the command: it would end the turn that is making this call.
      await this.deps.terminal.typeText(tab, COMMAND);
    } catch (error) {
      wake.withdrawWakeRequest(sessionId);
      throw error;
    }
    const typed = `"${COMMAND}" was typed into this session's Terminal tab`;
    const queued = await this.queuedAs(mark, clock.now());
    if (queued === undefined) {
      throw new Refusal(
        `unconfirmed: ${typed}, but its transcript did not show it queued ${SELF_LIMITS.queuedConfirmMs / 1000} seconds later. The wake request stays: if the command starts a compaction after all, this session is woken when it finishes.`,
      );
    }
    if (queued !== COMMAND) {
      wake.withdrawWakeRequest(sessionId);
      throw new Refusal(
        `${typed}, but it was queued together with text that was sitting in the input box, as ${JSON.stringify(queued)}. No compaction will run, and the wake request was withdrawn.`,
      );
    }
    return `${typed} and is queued. It runs when this turn ends, so end the turn now. When the compaction has finished, a hook wakes this session.`;
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

  private async attached(): Promise<Attached | undefined> {
    return (await this.deps.sessions.list()).find(
      (session): session is Attached => session.kind === "interactive" && session.pid === this.deps.sessionPid,
    );
  }

  private async findTab(): Promise<TabRef | undefined> {
    const tty = await this.deps.processes.ttyOf(this.deps.sessionPid);
    return tty === undefined ? undefined : this.deps.terminal.findTab(tty);
  }
}
