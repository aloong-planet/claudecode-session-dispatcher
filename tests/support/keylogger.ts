// Stands in for Claude Code inside a real Terminal window: it reads the keyboard in raw mode, as Claude Code does,
// and appends every chunk it receives, in hexadecimal, to the file named by its first argument.
// It ends when a chunk contains the word "quit".
import { appendFileSync } from "node:fs";

const log = process.argv[2]!;
process.stdin.setRawMode(true);
process.stdin.resume();
console.log("keylogger ready");
appendFileSync(log, `ready ${process.cwd()}\n`);
process.stdin.on("data", (chunk: Buffer) => {
  appendFileSync(log, `${chunk.toString("hex")}\n`);
  if (chunk.includes("quit")) process.exit(0);
});
