import type { Launch, TabRef, Terminal } from "../ports.ts";
import type { Run } from "./exec.ts";

const OPEN = `on run argv
  with timeout of 30 seconds
    tell application "Terminal"
      set previousId to missing value
      try
        set previousId to id of front window
      end try
      set newTab to do script (item 1 of argv)
      set newId to id of (first window whose tabs contains newTab)
      if previousId is not missing value then
        try
          set index of window id previousId to 1
        end try
      end if
      return (newId as text) & " " & (tty of newTab)
    end tell
  end timeout
end run`;

const FIND_TAB = `on run argv
  with timeout of 30 seconds
    tell application "Terminal"
      set windowIds to id of every window
      repeat with windowId in windowIds
        try
          set w to window id (windowId as integer)
          set tabTotal to count of tabs of w
          repeat with i from 1 to tabTotal
            -- A tab whose processes have all ended still answers the device it had, which may since host another tab.
            if (tty of tab i of w) is (item 1 of argv) then
              if (count of processes of tab i of w) > 0 then return ((windowId as integer) as text) & " " & i & " " & tabTotal
            end if
          end repeat
        end try
      end repeat
      return ""
    end tell
  end timeout
end run`;

const typing = (text: string) => `on run argv
  with timeout of 30 seconds
    tell application "Terminal"
      do script ${text} in tab ((item 2 of argv) as integer) of window id ((item 1 of argv) as integer)
    end tell
  end timeout
end run`;

const TYPE_COMMAND = typing("((ASCII character 3) & (item 3 of argv))");
const TYPE_TEXT = typing("(item 3 of argv)");

const CONTENTS = `on run argv
  with timeout of 30 seconds
    tell application "Terminal"
      return contents of tab 1 of window id ((item 1 of argv) as integer)
    end tell
  end timeout
end run`;

const CLOSE = `on run argv
  with timeout of 30 seconds
    tell application "Terminal"
      set target to ((item 1 of argv) as integer)
      if not (exists window id target) then return "closed"
      close window id target
      repeat 40 times
        if not (exists window id target) then return "closed"
        if (count of tabs of window id target) is 0 then return "closed"
        if not (visible of window id target) then return "closed"
        delay 0.25
      end repeat
      return "open"
    end tell
  end timeout
end run`;

const LAST_LINES = 15;

/** The macOS Terminal application, driven through its scripting interface with `osascript`. */
export class TerminalApp implements Terminal {
  private readonly run: Run;

  constructor(run: Run) {
    this.run = run;
  }

  async open(launch: Launch): Promise<{ windowId: number; tty: string }> {
    const reply = (await this.script(OPEN, shellCommandFor(launch))).trim();
    const [windowId, tty] = reply.split(" ");
    if (!windowId || !/^\d+$/.test(windowId) || !tty) throw new Error(`Terminal gave an unexpected reply when opening a window: ${reply}`);
    return { windowId: Number(windowId), tty };
  }

  async findTab(tty: string): Promise<TabRef | undefined> {
    const reply = (await this.script(FIND_TAB, tty)).trim();
    if (reply === "") return undefined;
    const [windowId, tab, tabCount] = reply.split(" ").map(Number);
    if (!windowId || !tab || !tabCount) throw new Error(`Terminal gave an unexpected reply when looking for ${tty}: ${reply}`);
    return { windowId, tab, tabCount };
  }

  async typeCommand(tab: TabRef, command: string): Promise<void> {
    await this.script(TYPE_COMMAND, String(tab.windowId), String(tab.tab), command);
  }

  async typeText(tab: TabRef, text: string): Promise<void> {
    await this.script(TYPE_TEXT, String(tab.windowId), String(tab.tab), text);
  }

  async lastLines(windowId: number): Promise<string> {
    const contents = await this.script(CONTENTS, String(windowId));
    return contents
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line !== "")
      .slice(-LAST_LINES)
      .join("\n");
  }

  async close(windowId: number): Promise<void> {
    const reply = (await this.script(CLOSE, String(windowId))).trim();
    if (reply !== "closed") throw new Error(`Terminal did not close window ${windowId} within 10 seconds.`);
  }

  private script(source: string, ...args: string[]): Promise<string> {
    return this.run("osascript", ["-e", source, ...args]);
  }
}

/** The shell command a new window runs: change to the directory, then replace the shell with the program. */
export function shellCommandFor(launch: Launch): string {
  return `cd ${shellQuote(launch.directory)} && exec ${launch.argv.map(shellQuote).join(" ")}`;
}

function shellQuote(word: string): string {
  return `'${word.replaceAll("'", `'\\''`)}'`;
}
