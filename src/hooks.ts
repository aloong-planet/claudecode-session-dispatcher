import { PLUGIN_NAME, WAKE_SENTENCE, type WakeState } from "./wake.ts";

export type HookDeps = {
  state: WakeState;
  /** The process ID of the session the hook runs in: the process that started the hook. */
  sessionPid: number;
  isAlive: (pid: number) => boolean;
  /** The time, in milliseconds since the epoch. */
  now: () => number;
};

/** What a hook process ends with: its exit code, and what it writes to its standard error stream. */
export type HookResult = { exitCode: number; stderr: string };

const QUIET: HookResult = { exitCode: 0, stderr: "" };
/** claude-session-pool-plugin::REQ-008/AC-04: an activity record written more than this long before is deleted. */
const ACTIVITY_RECORD_LIFETIME_MS = 24 * 60 * 60 * 1000;

/**
 * The plugin's hook, for the event Claude Code describes in `input`: the JSON object it writes to the hook's
 * standard input.
 *
 * On `SessionStart` it records that the plugin's hooks run in this session and deletes old activity records. On `PostCompact` it wakes the session
 * when `compact_self` left a wake request for the conversation: Claude Code starts a turn in an idle session when a
 * hook declared with `asyncRewake` exits with code 2, and hands the model what the hook wrote to standard error.
 */
export function runHook(input: unknown, deps: HookDeps): HookResult {
  const { hook_event_name: event, session_id: sessionId, trigger } = (typeof input === "object" && input !== null ? input : {}) as Record<string, unknown>;
  if (typeof sessionId !== "string") return failure("the hook was given no session ID");
  if (event === "SessionStart") {
    deps.state.writeHookRecord(deps.sessionPid, sessionId);
    deps.state.dropHookRecordsOfEndedProcesses(deps.isAlive);
    deps.state.dropActivityRecordsWrittenBefore(deps.now() - ACTIVITY_RECORD_LIFETIME_MS);
    return QUIET;
  }
  if (event === "PostCompact") {
    // A compaction that Claude Code started on its own is not the one `compact_self` asked for.
    if (trigger !== "manual" || deps.state.wakeRequestedAt(sessionId) === undefined) return QUIET;
    deps.state.withdrawWakeRequest(sessionId);
    return { exitCode: 2, stderr: WAKE_SENTENCE };
  }
  return failure(`the plugin has no hook for the event ${JSON.stringify(event)}`);
}

function failure(reason: string): HookResult {
  return { exitCode: 1, stderr: `${PLUGIN_NAME}: ${reason}.` };
}
