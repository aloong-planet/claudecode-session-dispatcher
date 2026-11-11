import { execFile } from "node:child_process";

/** Runs a program and returns what it printed. Rejects when the program fails. */
export type Run = (command: string, args: string[]) => Promise<string>;

export const run: Run = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8", timeout: 60_000, maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(stderr.trim() || error.message));
      else resolve(stdout);
    });
  });
