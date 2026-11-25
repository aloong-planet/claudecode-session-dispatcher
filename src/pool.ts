import { realpathSync } from "node:fs";
import { type LiveSession, type LookEntry, type Resolved, type RestoreJudgement, judgeRestore, resolveSlot, sessionNamed } from "../plugin/hooks/pool-rule.ts";
import { LookRecordStore } from "./look-records.ts";
import type { Clock, Processes, SessionEntry, SessionLister, TabRef, Terminal, TranscriptMark, Transcripts } from "./ports.ts";
import { type Outcome, attempt, describeSession, messageOf } from "./report.ts";
import { RosterStore, type Slot } from "./roster.ts";
import { Refusal, checkModel, checkPermissionMode, checkSlotName, checkTimeoutMinutes } from "./validate.ts";
import type { WakeState } from "./wake.ts";

export type PoolDeps = {
  /** The pool directory: where the dispatcher session was started. */
  directory: string;
  /** The process ID of the dispatcher session, which no tool may act on. */
  dispatcherPid: number;
  /** The directory that holds the roster files of every pool. */
  rosterRoot: string;
  sessions: SessionLister;
  terminal: Terminal;
  processes: Processes;
  transcripts: Transcripts;
  clock: Clock;
  /** Where the hook records show in which sessions the plugin's hooks run, and where clear orders are left. */
  wake: WakeState;
};

export const LIMITS = {
  pollMs: 1000,
  compactPollMs: 2000,
  idleBeforeTypingMs: 60_000,
  openReadyMs: 60_000,
  clearConfirmMs: 30_000,
  compactStartMs: 20_000,
  compactRecordAfterIdleMs: 10_000,
  compactDefaultMinutes: 30,
  exitMs: 15_000,
};

const DEFAULT_MODEL = "opus";
const DEFAULT_PERMISSION_MODE = "auto";

/** What a wait saw on one poll: the slot's state, or nothing because the sessions could not be listed. */
type Observed = Resolved | { state: "unknown"; error: string };

type OpenArgs = { name: string; model?: string; permissionMode?: string };
/** The model and the permission mode a session is started with; one that is left out is not passed. */
type StartedWith = { model?: string; permissionMode?: string };
type RestoreArgs = { names?: string[]; model?: string; permissionMode?: string };

/** The slots registered for one directory, and the operations a dispatcher session performs on them. */
export class Pool {
  private readonly deps: PoolDeps;
  private readonly directory: string;
  private readonly roster: RosterStore;
  private readonly lookRecords: LookRecordStore;
  private readonly opening = new Set<string>();
  private queue: Promise<unknown> = Promise.resolve();

  constructor(deps: PoolDeps) {
    this.deps = deps;
    this.directory = canonical(deps.directory);
    this.roster = new RosterStore(deps.rosterRoot, this.directory);
    this.lookRecords = new LookRecordStore(deps.rosterRoot, this.directory);
  }

  open(args: OpenArgs): Promise<Outcome> {
    return attempt(() => this.openSlot(args));
  }

  async init(args: { names: string[]; model?: string; permissionMode?: string }): Promise<Outcome> {
    if (args.names.length === 0) return { ok: false, text: "init needs at least one slot name." };
    const lines: string[] = [];
    let ok = true;
    for (const name of args.names) {
      const outcome = await this.open({ name, model: args.model, permissionMode: args.permissionMode });
      ok &&= outcome.ok;
      lines.push(`${name}: ${outcome.ok ? "opened" : "failed"}. ${outcome.text}`);
    }
    return { ok, text: lines.join("\n") };
  }

  adopt(args: { name: string }): Promise<Outcome> {
    return attempt(() => this.adoptSlot(args.name));
  }

  status(): Promise<Outcome> {
    return attempt(async () => {
      const slots = this.roster.read();
      if (slots.length === 0) return "The roster has no slots.";
      const sessions = await this.deps.sessions.list();
      const looked = this.lookRecords.entries();
      return slots
        .map((slot) => {
          const resolved = this.resolveIn(sessions, slot.name);
          const entry = looked.get(slot.name);
          return `${slot.name}: ${resolved.state === "gone" && entry !== undefined ? describeLastSeen(entry) : this.describeResolved(resolved)}`;
        })
        .join("\n");
    });
  }

  clear(args: { name: string }): Promise<Outcome> {
    return attempt(() => this.clearSlot(args.name));
  }

  compact(args: { name: string; timeoutMinutes?: number }): Promise<Outcome> {
    return attempt(() => this.compactSlot(args.name, args.timeoutMinutes ?? LIMITS.compactDefaultMinutes));
  }

  close(args: { name: string; force?: boolean }): Promise<Outcome> {
    return attempt(() => this.closeSlot(args.name, args.force ?? false, false));
  }

  recycle(args: OpenArgs & { force?: boolean }): Promise<Outcome> {
    return attempt(async () => {
      checkSlotName(args.name);
      checkModel(args.model ?? DEFAULT_MODEL);
      checkPermissionMode(args.permissionMode ?? DEFAULT_PERMISSION_MODE);
      const closed = await this.closeSlot(args.name, args.force ?? false, true);
      try {
        return `${closed}\n${await this.openSlot(args, true)}`;
      } catch (error) {
        const state = this.describeObserved(await this.observe(args.name));
        throw new Refusal(
          `${closed}\nNo new session was confirmed: ${messageOf(error)}\nThe slot "${args.name}" stays in the roster and is now ${state}.`,
        );
      }
    });
  }

  /** claude-session-pool::US-008. */
  async restore(args: RestoreArgs): Promise<Outcome> {
    // Each name in turn, with the reason it is only named and not acted on where there is one.
    let turns: { name: string; named?: string }[];
    try {
      if (args.names !== undefined && args.names.length === 0) throw new Refusal("names lists no slot; nothing was restored.");
      if (args.model !== undefined) checkModel(args.model);
      if (args.permissionMode !== undefined) checkPermissionMode(args.permissionMode);
      turns = args.names === undefined ? await this.restoreCandidates() : args.names.map((name) => ({ name }));
    } catch (error) {
      return { ok: false, text: messageOf(error) };
    }
    if (turns.length === 0) return { ok: true, text: "No slot of the roster is gone; nothing was restored." };
    const lines: string[] = [];
    let ok = true;
    for (const { name, named } of turns) {
      if (named !== undefined) {
        lines.push(`${name}: not restored. ${named}`);
        continue;
      }
      const outcome = await attempt(() => this.restoreSlot(name, args));
      ok &&= outcome.ok;
      lines.push(`${name}: ${outcome.ok ? "restored" : "not restored"}. ${outcome.text}`);
    }
    return { ok, text: lines.join("\n") };
  }

  /**
   * The `gone` slots of the roster, in its order, for a `restore` without names (claude-session-pool::US-008/AC-03). A
   * slot whose entry gives no conversation with work in it is only named, with the reason.
   */
  private async restoreCandidates(): Promise<{ name: string; named?: string }[]> {
    const slots = this.roster.read();
    const sessions = await this.deps.sessions.list();
    const look = this.lookRecords.read();
    return slots.flatMap((slot) => {
      const judgement = judgeRestore(slot, sessions, this.directory, canonical, look);
      if (judgement.verdict === "not gone") return [];
      const unfinished = judgement.verdict !== "no entry" && judgement.verdict !== "no work" && judgement.verdict !== "ended by recycle";
      return [unfinished ? { name: slot.name } : { name: slot.name, named: this.describeRefusal(slot.name, judgement) }];
    });
  }

  private async restoreSlot(name: string, args: RestoreArgs): Promise<string> {
    checkSlotName(name);
    const slot = this.requireSlot(name);
    if (this.opening.has(name)) throw new Refusal(`Another call is already opening "${name}"; nothing was opened.`);
    this.opening.add(name);
    try {
      const judgement = judgeRestore(slot, await this.deps.sessions.list(), this.directory, canonical, this.lookRecords.read());
      if (judgement.verdict !== "restore") throw new Refusal(this.describeRefusal(name, judgement));
      const { entry } = judgement;
      if (!this.deps.transcripts.mark(entry.sessionId)) {
        throw new Refusal(`The transcript of session ${entry.sessionId}, which the look record names for "${name}", cannot be found; nothing was opened.`);
      }
      const startedWith: StartedWith = { model: args.model ?? slot.model, permissionMode: args.permissionMode ?? slot.permissionMode };
      try {
        if (startedWith.model !== undefined) checkModel(startedWith.model);
        if (startedWith.permissionMode !== undefined) checkPermissionMode(startedWith.permissionMode);
      } catch (error) {
        throw new Refusal(
          `The roster records for "${name}" a value that may not be passed: ${messageOf(error)} Nothing was opened; pass model and permissionMode to start it with others.`,
        );
      }
      const argv = ["claude", "-n", name, "--resume", entry.sessionId];
      if (startedWith.model !== undefined) argv.push("--model", startedWith.model);
      if (startedWith.permissionMode !== undefined) argv.push("--permission-mode", startedWith.permissionMode);
      const session = await this.launch(name, argv, startedWith, true, false, entry.sessionId);
      const passed = [
        startedWith.model === undefined ? "no --model" : `--model ${startedWith.model}`,
        startedWith.permissionMode === undefined ? "no --permission-mode" : `--permission-mode ${startedWith.permissionMode}`,
      ];
      const own = startedWith.model === undefined || startedWith.permissionMode === undefined ? " Claude Code chose what was not passed." : "";
      return `Session ${session.sessionId} is idle in a new window; the look record last saw it ${entry.state} at ${entry.seenAt}. Passed ${passed.join(" and ")}.${own}`;
    } finally {
      this.opening.delete(name);
    }
  }

  /** Why `restore` does not act on the slot `name` (claude-session-pool::US-008/AC-04). */
  private describeRefusal(name: string, judgement: Exclude<RestoreJudgement, { verdict: "restore" }>): string {
    const anew = `open starts a new session under the name.`;
    switch (judgement.verdict) {
      case "not gone":
        return `The slot "${name}" is ${this.describeResolved(judgement.resolved)}, not gone; nothing was opened.`;
      case "name taken":
        return nameTaken(name, judgement.session);
      case "no look record":
        return `The pool has no look record (${this.lookRecords.path}), so nothing says which conversation "${name}" had; nothing was opened.`;
      case "no entry":
        return `The look record has no entry for "${name}"; nothing was opened.`;
      case "no work":
        return `The look record says that the conversation of "${name}" (session ${judgement.entry.sessionId}) had no work in it; nothing was opened. ${anew}`;
      case "ended by recycle":
        return `Session ${judgement.entry.sessionId}, which the look record names for "${name}", is the one recycle ended for it; nothing was opened. ${anew}`;
      case "conversation held": {
        const { pid, name: holder, cwd } = judgement.session;
        const called = holder === undefined ? "with no name" : `named "${holder}"`;
        return `Session ${judgement.entry.sessionId}, which the look record names for "${name}", is already held by a live session (pid ${pid}, ${called}, in ${cwd}); nothing was opened.`;
      }
    }
  }

  release(args: { name: string }): Promise<Outcome> {
    return attempt(async () => {
      checkSlotName(args.name);
      this.requireSlot(args.name);
      await this.removeSlot(args.name);
      return `Released "${args.name}": it was removed from the roster. Its session was not touched.`;
    });
  }

  private async openSlot(
    { name, model = DEFAULT_MODEL, permissionMode = DEFAULT_PERMISSION_MODE }: OpenArgs,
    recycling = false,
  ): Promise<string> {
    checkSlotName(name);
    checkModel(model);
    checkPermissionMode(permissionMode);
    // A name that is already a slot stays in the roster whatever happens next.
    const keepsSlot = recycling || this.roster.read().some((slot) => slot.name === name);
    if (this.opening.has(name)) throw new Refusal(`Another call is already opening "${name}"; nothing was opened.`);
    this.opening.add(name);
    try {
      const taken = sessionNamed(await this.deps.sessions.list(), name);
      if (taken) throw new Refusal(nameTaken(name, taken));
      const argv = ["claude", "-n", name, "--model", model, "--permission-mode", permissionMode];
      const session = await this.launch(name, argv, { model, permissionMode }, keepsSlot, recycling);
      return `Opened "${name}": idle, session ${session.sessionId}.`;
    } finally {
      this.opening.delete(name);
    }
  }

  /**
   * Opens a new window that runs `argv` in the pool directory for the slot `name`, waits until its session is idle and
   * records it in the roster with what it was started with; `keepsSlot` tells whether the slot stays in the roster when
   * the session is not idle in time. With `resumes`, only a session with that session ID is the one started
   * (claude-session-pool::US-008/AC-01): one with another session ID answering to the name is neither waited for nor
   * recorded.
   */
  private async launch(
    name: string,
    argv: string[],
    startedWith: StartedWith,
    keepsSlot: boolean,
    recycling: boolean,
    resumes?: string,
  ): Promise<LiveSession> {
    const { windowId } = await this.exclusive(() => this.deps.terminal.open({ directory: this.directory, argv }));
    const deadline = this.deps.clock.now() + LIMITS.openReadyMs;
    const started = (session: LiveSession) => resumes === undefined || session.sessionId === resumes;
    let seen: Observed;
    for (;;) {
      seen = await this.observe(name);
      if (seen.state === "live" && seen.session.status === "idle" && started(seen.session)) {
        await this.recordOpened(name, seen.session.pid, startedWith);
        return seen.session;
      }
      if (this.deps.clock.now() >= deadline) break;
      await this.deps.clock.sleep(LIMITS.pollMs);
    }
    const other = seen.state === "live" && !started(seen.session) ? seen.session : undefined;
    // A slot that stays in the roster must record the session just opened for it, or forget the one it recorded.
    if (keepsSlot) await this.recordOpened(name, seen.state === "live" && !other ? seen.session.pid : undefined, startedWith);
    const visible = await this.deps.terminal
      .lastLines(windowId)
      .catch((error: unknown) => `(the window's contents could not be read: ${messageOf(error)})`);
    const kept = recycling
      ? "Its window was left open."
      : keepsSlot
        ? `Its window was left open. "${name}" stays in the roster.`
        : `Its window was left open and "${name}" was not added to the roster.`;
    const listing = seen.state === "unknown" ? ` The sessions could not be listed: ${seen.error}` : "";
    const notResumed = other
      ? ` ${other.sessionId === undefined ? "A session with no session ID" : `Session ${other.sessionId}`} answers to "${name}", not session ${resumes}, which the look record names; the conversation was not resumed.`
      : "";
    throw new Refusal(
      `A window was opened for "${name}", but its session was not idle after ${LIMITS.openReadyMs / 1000} seconds. ${kept}${notResumed}${listing} The window shows:\n${quoted(visible)}`,
    );
  }

  private async adoptSlot(name: string): Promise<string> {
    checkSlotName(name);
    if (this.roster.read().some((slot) => slot.name === name)) return `"${name}" is already a slot; nothing changed.`;
    const named = (await this.deps.sessions.list()).filter(
      (session): session is LiveSession => session.kind === "interactive" && session.pid !== undefined && session.name === name,
    );
    const here = named.filter((session) => canonical(session.cwd) === this.directory);
    if (here.length === 0) {
      throw new Refusal(
        named[0]
          ? `The session named "${name}" runs in ${named[0].cwd}, not in this pool's directory ${this.directory}; it was not adopted.`
          : `No live interactive session answers to "${name}"; nothing was adopted.`,
      );
    }
    if (here.length > 1) {
      throw new Refusal(`${here.length} sessions in this pool's directory answer to "${name}"; none was adopted.`);
    }
    const session = here[0]!;
    if (session.pid === this.deps.dispatcherPid) {
      throw new Refusal(`"${name}" is the dispatcher session itself and cannot be a slot.`);
    }
    if (!(await this.findTab(session.pid))) {
      throw new Refusal(`The session "${name}" (pid ${session.pid}) does not run in a Terminal window; it was not adopted.`);
    }
    await this.updateRoster((slots) => (slots.some((slot) => slot.name === name) ? slots : [...slots, { name, origin: "adopted" }]));
    return `Adopted "${name}": ${describeSession(session)}, session ${session.sessionId}.`;
  }

  private async clearSlot(name: string): Promise<string> {
    const before = await this.awaitIdle(name, "nothing was typed or written");
    // A hook record for the session's present session ID shows that the plugin's hooks run in it. The plugin loads its mod
    // with its hooks, but nothing shows that the mod runs: an order that nothing acts on is reported as not confirmed.
    if (before.sessionId !== undefined && this.deps.wake.hookRecord(before.pid) === before.sessionId) {
      return this.clearByOrder(name, before, before.sessionId);
    }
    await this.typeIntoIdle(name, before, "/clear");
    const typed = `"/clear" was typed into the slot "${name}"`;
    const replacedBy = await this.confirmClear(name, before, typed, () => "The command was not typed again.");
    return `${replacedBy} Delivered by typing "/clear", because no hook record shows that the plugin's hooks run in this session.`;
  }

  /** Leaves a clear order for the mod in the idle session `before`, and waits for the session ID to change. */
  private async clearByOrder(name: string, before: LiveSession, sessionId: string): Promise<string> {
    await this.exclusive(() => this.deps.wake.writeClearOrder(sessionId, this.deps.clock.now()));
    let removal: string | undefined;
    const removeOrder = () =>
      (removal ??= ((): string => {
        try {
          this.deps.wake.removeClearOrder(sessionId);
          return "The order was removed.";
        } catch (error) {
          return `The order could not be removed (${messageOf(error)}); it applies to no session 60 seconds after it was written.`;
        }
      })());
    try {
      const replacedBy = await this.confirmClear(name, before, `A clear order was written for the slot "${name}"`, () => `${removeOrder()} Nothing was typed.`);
      return `${replacedBy} Delivered as a clear order; nothing was typed.`;
    } finally {
      removeOrder();
    }
  }

  /** Polls until the session ID of the slot `before` has changed, or says why that is not confirmed. */
  private async confirmClear(name: string, before: LiveSession, delivered: string, afterwards: () => string): Promise<string> {
    const deadline = this.deps.clock.now() + LIMITS.clearConfirmMs;
    for (;;) {
      await this.deps.clock.sleep(LIMITS.pollMs);
      const seen = await this.observe(name);
      if (seen.state === "live" && seen.session.pid === before.pid && seen.session.sessionId !== before.sessionId) {
        return `Cleared "${name}": session ${before.sessionId} was replaced by session ${seen.session.sessionId}.`;
      }
      if (this.sessionReplaced(seen, before)) {
        throw new Refusal(`${delivered}, and the slot is now ${this.describeReplaced(seen, before)}: not confirmed.`);
      }
      if (this.deps.clock.now() >= deadline) {
        const observed =
          seen.state === "unknown" ? `the sessions could not be listed (${seen.error})` : `its session ID was still ${before.sessionId}`;
        throw new Refusal(`${delivered}, but ${observed} after ${LIMITS.clearConfirmMs / 1000} seconds: not confirmed. ${afterwards()}`);
      }
    }
  }

  private async compactSlot(name: string, timeoutMinutes: number): Promise<string> {
    checkTimeoutMinutes(timeoutMinutes);
    let mark: TranscriptMark | undefined;
    const before = await this.typeInto(name, "/compact", (session) => {
      mark = session.sessionId === undefined ? undefined : this.deps.transcripts.mark(session.sessionId);
    });
    const typed = `"/compact" was typed into the slot "${name}"`;
    if (!mark) {
      throw new Refusal(
        `unconfirmed: ${typed}, but the transcript of session ${before.sessionId} could not be found or read, so the compaction cannot be confirmed.`,
      );
    }
    const typedAt = this.deps.clock.now();
    const deadline = typedAt + timeoutMinutes * 60_000;
    let sawBusy = false;
    let idleSince: number | undefined;
    for (;;) {
      await this.deps.clock.sleep(LIMITS.compactPollMs);
      if (this.deps.transcripts.compactedSince(mark)) {
        return `Compacted "${name}": the transcript of session ${before.sessionId} records a compaction that finished after the command was typed.`;
      }
      const now = this.deps.clock.now();
      const seen = await this.observe(name);
      if (this.sessionReplaced(seen, before)) {
        throw new Refusal(`unconfirmed: ${typed}, and the slot is now ${this.describeReplaced(seen, before)}.`);
      }
      if (seen.state !== "live") {
        // The state is not known on this poll, so neither early-return rule applies; only the time limit does.
      } else if (seen.session.status !== "idle") {
        sawBusy = true;
        idleSince = undefined;
      } else if (sawBusy) {
        idleSince ??= now;
        if (now - idleSince >= LIMITS.compactRecordAfterIdleMs) {
          throw new Refusal(
            `unconfirmed: ${typed}; the session became busy and returned to idle, and its transcript records no compaction ${LIMITS.compactRecordAfterIdleMs / 1000} seconds later.`,
          );
        }
      } else if (now - typedAt >= LIMITS.compactStartMs) {
        throw new Refusal(
          `unconfirmed: ${typed}, but the session had not become busy ${LIMITS.compactStartMs / 1000} seconds later, so the command seems to have had no effect.`,
        );
      }
      if (now >= deadline) {
        const listing = seen.state === "unknown" ? ` The sessions could not be listed: ${seen.error}` : "";
        throw new Refusal(
          `unconfirmed: ${typed}, and its transcript records no compaction after ${timeoutMinutes} minutes. The command was not typed again.${listing}`,
        );
      }
    }
  }

  private async closeSlot(name: string, force: boolean, keepSlot: boolean): Promise<string> {
    checkSlotName(name);
    const slot = this.requireSlot(name);
    const resolved = await this.resolve(name);
    if (resolved.state === "ambiguous") {
      throw new Refusal(`${resolved.count} sessions answer to the slot "${name}"; none was ended.`);
    }
    if (resolved.state === "gone") {
      if (!keepSlot) await this.removeSlot(name);
      return `No live session answered to "${name}"${keepSlot ? "." : "; it was removed from the roster."}`;
    }
    const session = resolved.session;
    this.refuseDispatcher(session, name, "it was not closed");
    if (session.status !== "idle" && !force) {
      throw new Refusal(`The slot "${name}" is ${describeSession(session)}; it was not closed. Pass force to close it anyway.`);
    }
    // The server closes only a window it opened itself: the one that hosts the session it opened for this slot.
    const serverOpened = slot.origin === "opened" && slot.pid === session.pid;
    const tab = serverOpened ? await this.findTab(session.pid) : undefined;
    this.deps.processes.terminate(session.pid);
    const deadline = this.deps.clock.now() + LIMITS.exitMs;
    while (this.deps.processes.isAlive(session.pid)) {
      if (this.deps.clock.now() >= deadline) {
        throw new Refusal(
          `The session of the slot "${name}" (pid ${session.pid}) had not exited ${LIMITS.exitMs / 1000} seconds after it was asked to end. The slot stays in the roster and no window was closed.`,
        );
      }
      await this.deps.clock.sleep(LIMITS.pollMs);
    }
    const ended = `Closed "${name}": its session (pid ${session.pid}) ended.`;
    // recycle: until a new session is recorded for the slot, the roster says which conversation was ended, so that
    // `restore` does not resume it (docs/specs/claude-session-pool.md, "Roster file").
    if (keepSlot && session.sessionId !== undefined) {
      const endedSessionId = session.sessionId;
      try {
        await this.updateRoster((slots) => slots.map((candidate) => (candidate.name === name ? { ...candidate, endedSessionId } : candidate)));
      } catch (error) {
        throw new Refusal(`${ended} The roster could not be updated, so no new session was opened: ${messageOf(error)}`);
      }
    }
    if (!keepSlot) {
      try {
        await this.removeSlot(name);
      } catch (error) {
        throw new Refusal(`${ended} The roster could not be updated, so the slot is still listed: ${messageOf(error)}`);
      }
    }
    if (!serverOpened) {
      return `${ended} Its Terminal window was left open, because the roster does not record this session as one the server opened.`;
    }
    if (!tab) return `${ended} No Terminal window was found for it.`;
    if (tab.tabCount > 1) return `${ended} Its tab was left open, because its window has other tabs and Terminal cannot close a single tab.`;
    try {
      await this.exclusive(() => this.deps.terminal.close(tab.windowId));
    } catch (error) {
      throw new Refusal(`${ended} Its Terminal window could not be closed: ${messageOf(error)}`);
    }
    return `${ended} Its Terminal window was closed.`;
  }

  /** Types a command into an idle slot's Terminal tab and returns the session as it was just before. */
  private async typeInto(name: string, command: string, beforeTyping?: (session: LiveSession) => void): Promise<LiveSession> {
    const session = await this.awaitIdle(name, "nothing was typed");
    await this.typeIntoIdle(name, session, command, beforeTyping);
    return session;
  }

  /** Waits up to 60 seconds for the slot's session to be idle, and returns it; `nothing` says what was not done when that fails. */
  private async awaitIdle(name: string, nothing: string): Promise<LiveSession> {
    checkSlotName(name);
    this.requireSlot(name);
    const deadline = this.deps.clock.now() + LIMITS.idleBeforeTypingMs;
    for (;;) {
      const resolved = await this.resolve(name);
      if (resolved.state !== "live") {
        throw new Refusal(`The slot "${name}" is ${this.describeResolved(resolved)}; ${nothing}.`);
      }
      this.refuseDispatcher(resolved.session, name, nothing);
      if (resolved.session.status === "idle") return resolved.session;
      if (this.deps.clock.now() >= deadline) {
        throw new Refusal(
          `The slot "${name}" is ${describeSession(resolved.session)} and did not become idle within ${LIMITS.idleBeforeTypingMs / 1000} seconds; ${nothing}.`,
        );
      }
      await this.deps.clock.sleep(LIMITS.pollMs);
    }
  }

  private async typeIntoIdle(name: string, session: LiveSession, command: string, beforeTyping?: (session: LiveSession) => void): Promise<void> {
    const tab = await this.findTab(session.pid);
    if (!tab) {
      throw new Refusal(`No Terminal tab hosts the slot "${name}" (pid ${session.pid}); nothing was typed.`);
    }
    beforeTyping?.(session);
    await this.exclusive(() => this.deps.terminal.typeCommand(tab, command));
  }

  private refuseDispatcher(session: LiveSession, name: string, consequence: string): void {
    if (session.pid === this.deps.dispatcherPid) {
      throw new Refusal(`The slot "${name}" is answered by the dispatcher session itself; ${consequence}.`);
    }
  }

  private requireSlot(name: string): Slot {
    const slot = this.roster.read().find((candidate) => candidate.name === name);
    if (!slot) throw new Refusal(`"${name}" is not a slot in this pool's roster; nothing was done.`);
    return slot;
  }

  /** Records the session opened for a slot. A failure here follows an opened window, so the error says so. */
  private async recordOpened(name: string, pid: number | undefined, startedWith: StartedWith): Promise<void> {
    try {
      await this.registerOpened(name, pid, startedWith);
    } catch (error) {
      throw new Refusal(`A window was opened for "${name}", but the roster could not be updated: ${messageOf(error)}`);
    }
  }

  /** Whether the session a command was typed into is no longer the one, and the only one, that answers to the name. */
  private sessionReplaced(seen: Observed, before: LiveSession): boolean {
    return seen.state === "gone" || seen.state === "ambiguous" || (seen.state === "live" && seen.session.pid !== before.pid);
  }

  private describeReplaced(seen: Observed, before: LiveSession): string {
    const state = this.describeObserved(seen);
    return seen.state === "live" && seen.session.pid !== before.pid
      ? `${state}, in another process (pid ${seen.session.pid}, not ${before.pid})`
      : state;
  }

  /**
   * Records a new session the server opened for the slot; what an earlier session of the slot left in the roster goes.
   * Where no session alone answers to the name (`pid` undefined), no new session is recorded, so the conversation
   * `recycle` ended stays recorded (docs/specs/claude-session-pool.md, "Roster file").
   */
  private registerOpened(name: string, pid: number | undefined, { model, permissionMode }: StartedWith): Promise<void> {
    return this.updateRoster((slots) => {
      const slot: Slot = { name, origin: "opened" };
      if (pid !== undefined) slot.pid = pid;
      else {
        const endedSessionId = slots.find((candidate) => candidate.name === name)?.endedSessionId;
        if (endedSessionId !== undefined) slot.endedSessionId = endedSessionId;
      }
      if (model !== undefined) slot.model = model;
      if (permissionMode !== undefined) slot.permissionMode = permissionMode;
      return [...slots.filter((candidate) => candidate.name !== name), slot];
    });
  }

  private removeSlot(name: string): Promise<void> {
    return this.updateRoster((slots) => slots.filter((slot) => slot.name !== name));
  }

  private updateRoster(change: (slots: Slot[]) => Slot[]): Promise<void> {
    return this.exclusive(() => {
      this.roster.write(change(this.roster.read()));
    });
  }

  private async findTab(pid: number): Promise<TabRef | undefined> {
    const tty = await this.deps.processes.ttyOf(pid);
    return tty === undefined ? undefined : this.deps.terminal.findTab(tty);
  }

  private async resolve(name: string): Promise<Resolved> {
    return this.resolveIn(await this.deps.sessions.list(), name);
  }

  /** The slot's state during a wait. A listing that fails is reported as "unknown", so that the wait can go on. */
  private async observe(name: string): Promise<Observed> {
    try {
      return await this.resolve(name);
    } catch (error) {
      return { state: "unknown", error: messageOf(error) };
    }
  }

  private describeObserved(observed: Observed): string {
    return observed.state === "unknown" ? `in an unknown state (${observed.error})` : this.describeResolved(observed);
  }

  private resolveIn(sessions: SessionEntry[], name: string): Resolved {
    return resolveSlot(sessions, name, this.directory, canonical);
  }

  private describeResolved(resolved: Resolved): string {
    if (resolved.state === "gone") return "gone";
    if (resolved.state === "ambiguous") return `ambiguous, ${resolved.count} sessions answer to this name`;
    return `${describeSession(resolved.session)}, session ${resolved.session.sessionId}`;
  }

  /** Runs one step at a time, so that two calls never interleave keystrokes or lose a roster update. */
  private exclusive<T>(step: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(step, step);
    this.queue = result.catch(() => undefined);
    return result;
  }
}

/** The refusal of a name that a live session already answers to (claude-session-pool::US-001/AC-05). */
function nameTaken(name: string, session: LiveSession): string {
  return `A live session already answers to "${name}" (pid ${session.pid}, in ${session.cwd}); nothing was opened.`;
}

/** A `gone` slot with an entry in the look record (claude-session-pool::US-005/AC-04): what the last look that found it live found. */
function describeLastSeen(entry: LookEntry): string {
  return `gone, last seen ${entry.state} at ${entry.seenAt}, session ${entry.sessionId}, whose conversation had ${entry.worked ? "work" : "no work"} in it`;
}

function quoted(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

/** A directory path with symbolic links resolved, so that two spellings of one directory compare equal. */
function canonical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
