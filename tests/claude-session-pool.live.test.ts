/**
 * The Terminal adapter against the real Terminal application. It opens real windows, so it runs only when
 * CLAUDE_SESSION_POOL_LIVE=1 is set, on a Mac with Terminal running. A window runs `support/keylogger.ts`, or a
 * program that ends at once, instead of Claude Code, so no session is started.
 *
 * It checks which Terminal window is in front, so it fails if a person switches Terminal windows while it runs.
 * A new window takes the keyboard for a moment: keystrokes a person types just then land in it, and the test
 * then fails on the keys it received. The second test moves the window whose program ended to just behind the
 * front window, which leaves the front window as it was.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { run } from "../src/adapters/exec.ts";
import { SystemProcesses } from "../src/adapters/processes.ts";
import { TerminalApp } from "../src/adapters/terminal-app.ts";

const keylogger = join(dirname(fileURLToPath(import.meta.url)), "support", "keylogger.ts");

async function eventually<T>(read: () => T | undefined, what: string): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const frontWindowId = async () => Number((await run("osascript", ["-e", 'tell application "Terminal" to id of front window'])).trim());

describe.skipIf(process.env.CLAUDE_SESSION_POOL_LIVE !== "1")("Terminal, live", () => {
  it("opens a window in a directory, keeps the earlier window in front, types a command after an interrupt and a text without one, and closes the window", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "claude-session-pool-")));
    const directory = join(home, `a "live" dir`);
    mkdirSync(directory);
    const log = join(home, "keys.log");
    const lines = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
    const terminal = new TerminalApp(run);
    const frontBefore = await frontWindowId();
    let windowId: number | undefined;
    try {
      const opened = await terminal.open({ directory, argv: [process.execPath, keylogger, log] });
      windowId = opened.windowId;
      expect(await frontWindowId()).toBe(frontBefore);
      expect(windowId).not.toBe(frontBefore);

      const ready = await eventually(() => lines()[0], "the program to start");
      expect(ready).toBe(`ready ${directory}`);

      const tab = await terminal.findTab(opened.tty);
      expect(tab).toEqual({ windowId, tab: 1, tabCount: 1 });

      await terminal.typeCommand(tab!, "/clear");
      expect(await frontWindowId()).toBe(frontBefore);
      const typed = await eventually(() => {
        const received = lines().slice(1).join("");
        return /0[da]$/.test(received) ? received : undefined;
      }, "the typed command");
      expect(typed.slice(0, -2)).toBe(`03${Buffer.from("/clear").toString("hex")}`);

      const chunksBefore = lines().length;
      await terminal.typeText(tab!, "/compact");
      const text = await eventually(() => {
        const received = lines().slice(chunksBefore).join("");
        return /0[da]$/.test(received) ? received : undefined;
      }, "the typed text");
      expect(text.slice(0, -2)).toBe(Buffer.from("/compact").toString("hex"));

      expect(await terminal.lastLines(windowId)).toContain("keylogger ready");

      await terminal.typeCommand(tab!, "quit");
      await eventually(() => (lines().join("").includes(Buffer.from("quit").toString("hex")) ? true : undefined), "the program to end");
      await new Promise((resolve) => setTimeout(resolve, 500));
      await terminal.close(windowId);
      expect(await terminal.findTab(opened.tty)).toBeUndefined();
      windowId = undefined;
    } finally {
      if (windowId !== undefined) await terminal.close(windowId).catch(() => undefined);
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);

  // docs/specs/claude-session-pool.md, "Which window hosts a session"
  it("passes over a window whose program ended when a later window got its terminal device", async () => {
    const home = realpathSync(mkdtempSync(join(tmpdir(), "claude-session-pool-")));
    const log = join(home, "keys.log");
    const lines = () => (existsSync(log) ? readFileSync(log, "utf8").split("\n").filter(Boolean) : []);
    const terminal = new TerminalApp(run);
    const processes = new SystemProcesses(run);
    const opened: { windowId: number; tty: string }[] = [];
    let keyloggerPid: number | undefined;
    try {
      const ended = await terminal.open({ directory: home, argv: ["/usr/bin/true"] });
      opened.push(ended);
      await eventuallyAsync(async () => ((await processes.onTty(ended.tty)).length === 0 ? true : undefined), "the first window's program to end");

      const live = await terminal.open({ directory: home, argv: [process.execPath, keylogger, log] });
      opened.push(live);
      await eventually(() => lines()[0], "the program to start");
      keyloggerPid = (await processes.onTty(live.tty)).find((left) => left.command !== "login")?.pid;
      expect(live.tty).toBe(ended.tty);
      // The window whose program ended is put ahead of the live one in Terminal's order of windows, behind the front one.
      await run("osascript", ["-e", `tell application "Terminal" to set index of window id ${ended.windowId} to 2`]);
      const order = (await run("osascript", ["-e", 'tell application "Terminal" to id of every window'])).split(", ").map(Number);
      expect(order.indexOf(ended.windowId)).toBeLessThan(order.indexOf(live.windowId));

      expect(await terminal.findTab(live.tty)).toEqual({ windowId: live.windowId, tab: 1, tabCount: 1 });
    } finally {
      if (keyloggerPid !== undefined) processes.terminate(keyloggerPid);
      // The live window first: the other one's device is the same, so it is empty once the live window's is.
      for (const { windowId, tty } of opened.reverse()) {
        await eventuallyAsync(async () => ((await processes.onTty(tty)).length === 0 ? true : undefined), `no process on ${tty}`);
        await terminal.close(windowId);
      }
      rmSync(home, { recursive: true, force: true });
    }
  }, 60_000);
});

async function eventuallyAsync<T>(read: () => Promise<T | undefined>, what: string): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timed out waiting for ${what}`);
}
