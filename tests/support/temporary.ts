import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directories: string[] = [];

/** A new directory under the system's temporary directory, given with its symbolic links resolved. */
export function temporaryDirectory(): string {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "claude-session-pool-")));
  directories.push(directory);
  return directory;
}

/** Removes the directories `temporaryDirectory` made. A test file that uses a helper of this directory calls it in `afterEach`. */
export function cleanUpTemporaryDirectories(): void {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
}
