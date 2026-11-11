import { homedir } from "node:os";
import { join } from "node:path";

/** The directory under the user's home in which the server and the plugin's hooks keep their files. */
export const STATE_DIRECTORY = join(homedir(), ".claude-session-pool");
