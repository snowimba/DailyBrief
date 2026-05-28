import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

import { bjIso } from "../utils";

interface RunOptions {
  cwd: string;
  timeoutMs: number;
  logName?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const MAX_CAPTURE = 200_000;

function appendBounded(current: string, chunk: Buffer): string {
  const next = current + chunk.toString("utf8");
  return next.length > MAX_CAPTURE ? next.slice(next.length - MAX_CAPTURE) : next;
}

export async function runCommand(
  command: string,
  args: string[],
  options: RunOptions,
): Promise<CommandResult> {
  await fs.mkdir("logs", { recursive: true });
  const logPath = options.logName ? path.join("logs", options.logName) : null;
  if (logPath) {
    await fs.writeFile(
      logPath,
      [`$ ${command} ${args.join(" ")}`, `[started] ${bjIso()}`, ""].join("\n"),
      "utf8",
    );
  }
  const child = spawn(command, args, {
    cwd: options.cwd,
    shell: process.platform === "win32",
    env: { ...process.env, ...options.env },
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = appendBounded(stdout, chunk);
    if (logPath) void fs.appendFile(logPath, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = appendBounded(stderr, chunk);
    if (logPath) void fs.appendFile(logPath, chunk);
  });

  const timeout = setTimeout(() => {
    if (logPath) {
      void fs.appendFile(
        logPath,
        `\n[timeout] ${bjIso()} after ${options.timeoutMs}ms\n`,
      );
    }
    child.kill("SIGTERM");
  }, options.timeoutMs);

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (signal) resolve(124);
      else resolve(code ?? 1);
    });
  }).finally(() => clearTimeout(timeout));

  if (options.logName) {
    await fs.appendFile(
      path.join("logs", options.logName),
      `\n[exit] ${bjIso()} code=${exitCode}\n`,
      "utf8",
    );
  }

  if (exitCode !== 0) {
    const tail = `${stdout}\n${stderr}`.slice(-4000);
    throw new Error(
      `Command failed (${exitCode}): ${command} ${args.join(" ")}\n${tail}`,
    );
  }

  return { stdout, stderr, exitCode };
}
