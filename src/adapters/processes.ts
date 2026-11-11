import type { Processes } from "../ports.ts";
import type { Run } from "./exec.ts";

export class SystemProcesses implements Processes {
  private readonly run: Run;

  constructor(run: Run) {
    this.run = run;
  }

  async ttyOf(pid: number): Promise<string | undefined> {
    let name: string;
    try {
      name = (await this.run("ps", ["-o", "tty=", "-p", String(pid)])).trim();
    } catch {
      return undefined;
    }
    return name === "" || name.startsWith("?") ? undefined : `/dev/${name}`;
  }

  terminate(pid: number): void {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }

  isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  }
}
