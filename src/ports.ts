/** One entry of Claude Code's session listing (`claude agents --json`). */
export type SessionEntry = {
  kind: string;
  cwd: string;
  pid?: number;
  name?: string;
  sessionId?: string;
  status?: string;
  waitingFor?: string;
};

export interface SessionLister {
  list(): Promise<SessionEntry[]>;
}

/** One entry of Claude Code's listing of installed plugins (`claude plugin list --json`). */
export type InstalledPlugin = {
  /** `<plugin>@<marketplace>`. */
  id: string;
  /** Whether the plugin is enabled in the directory the listing was run in; as printed, so not always a boolean. */
  enabled: unknown;
  /** The directory a plugin used in place is read from. */
  readFromFolder?: string;
};

export interface PluginLister {
  /** The installed plugins, as seen from the directory the listing runs in. Rejects when they cannot be listed. */
  installed(): Promise<InstalledPlugin[]>;
}

/** What a newly opened Terminal window runs: change to `directory`, then become `argv`. */
export type Launch = {
  directory: string;
  argv: string[];
};

export type TabRef = {
  windowId: number;
  /** 1-based index of the tab within its window. */
  tab: number;
  /** How many tabs the window has. */
  tabCount: number;
};

export interface Terminal {
  /** Opens a new window, starts `launch` in it, and puts the previously frontmost window back in front. */
  open(launch: Launch): Promise<{ windowId: number; tty: string }>;
  /** The tab whose terminal device is `tty`, if Terminal has one. */
  findTab(tty: string): Promise<TabRef | undefined>;
  /** Discards whatever sits in the program's input box, then types `command` followed by Return. */
  typeCommand(tab: TabRef, command: string): Promise<void>;
  /** Types `text` followed by Return and leaves the program's input box as it is. */
  typeText(tab: TabRef, text: string): Promise<void>;
  /** The last non-empty lines visible in the window's first tab. */
  lastLines(windowId: number): Promise<string>;
  close(windowId: number): Promise<void>;
}

export interface Processes {
  /** The controlling terminal device of a process, such as `/dev/ttys007`. */
  ttyOf(pid: number): Promise<string | undefined>;
  /** Asks the process to end. */
  terminate(pid: number): void;
  isAlive(pid: number): boolean;
}

/** A position in a session's transcript, taken before a command is typed. */
export type TranscriptMark = {
  path: string;
  offset: number;
};

export interface Transcripts {
  /** The current end of the session's transcript, or undefined when it cannot be found or read. */
  mark(sessionId: string): TranscriptMark | undefined;
  /** Whether a finished compaction was recorded after `mark`. */
  compactedSince(mark: TranscriptMark): boolean;
  /** The texts that were queued for the session after `mark`, oldest first. */
  queuedSince(mark: TranscriptMark): string[];
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}
