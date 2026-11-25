import { readFileSync } from "node:fs";
import { run } from "./adapters/exec.ts";
import { SystemProcesses } from "./adapters/processes.ts";
import { runHook } from "./hooks.ts";
import { STATE_DIRECTORY } from "./state-directory.ts";
import { WakeState } from "./wake.ts";

// The entry file of the plugin's hooks. Claude Code writes the event to standard input as one JSON object.
let input: unknown;
try {
  input = JSON.parse(readFileSync(0, "utf8"));
} catch {
  input = undefined;
}

const processes = new SystemProcesses(run);
const { exitCode, stderr } = runHook(input, {
  state: new WakeState(STATE_DIRECTORY),
  // The session is the process that started this one: the plugin declares its hooks without a shell in between.
  sessionPid: process.ppid,
  isAlive: (pid) => processes.isAlive(pid),
  now: Date.now,
});
// Whatever goes to standard error when the exit code is 2 is handed to the model, so nothing else is written there.
if (stderr !== "") process.stderr.write(`${stderr}\n`);
process.exitCode = exitCode;
