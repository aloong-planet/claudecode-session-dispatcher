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

  async onTty(tty: string): Promise<{ pid: number; command: string }[]> {
    // `ps -t` fails once the device is released, so every process is listed and the device's are picked out.
    const name = tty.replace(/^\/dev\//, "");
    const listing = await this.run("ps", ["-A", "-o", "tty=,pid=,comm="]);
    const found: { pid: number; command: string }[] = [];
    for (const line of listing.split("\n")) {
      const match = /^(\S+)\s+(\d+)\s(.*)$/.exec(line);
      if (match?.[1] === name) found.push({ pid: Number(match[2]), command: match[3]!.trim() });
    }
    return found;
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
