#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const appDir = process.cwd();
const fallbackAppDir = join(scriptDir, "..");

function readDotEnvValue(key) {
  const envPaths = [join(appDir, ".env"), join(fallbackAppDir, ".env")];
  for (const envPath of envPaths) {
    if (!existsSync(envPath)) continue;

    const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const equalIndex = trimmed.indexOf("=");
      if (equalIndex === -1) continue;

      const envKey = trimmed.slice(0, equalIndex).trim();
      if (envKey !== key) continue;

      let value = trimmed.slice(equalIndex + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      return value;
    }
  }

  return undefined;
}

function parseMemoryLimitMB(value) {
  if (!value) return null;

  const trimmed = value.trim();
  if (!/^\d+(?:\.\d)?$/.test(trimmed)) return null;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed) || parsed < 64) return null;

  return Math.floor(parsed);
}

function getConfiguredMemoryMB() {
  return (
    parseMemoryLimitMB(process.env.memory) ??
    parseMemoryLimitMB(readDotEnvValue("memory")) ??
    parseMemoryLimitMB(process.env.MAX_OLD_SPACE) ??
    parseMemoryLimitMB(readDotEnvValue("MAX_OLD_SPACE"))
  );
}

function withMaxOldSpaceSize(nodeOptions, memoryMB) {
  const withoutOldSpace = (nodeOptions ?? "")
    .replace(/(?:^|\s)--max-old-space-size=\S+/g, " ")
    .trim();
  return [withoutOldSpace, `--max-old-space-size=${memoryMB}`].filter(Boolean).join(" ");
}

function quoteWindowsArg(value) {
  if (!/[\s"]/u.test(value)) return value;
  return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/\\+$/g, "$&$&")}"`;
}

function runWindowsCmd(commandPath, args) {
  const commandLine = [quoteWindowsArg(commandPath), ...args.map(quoteWindowsArg)].join(" ");
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    args: ["/d", "/s", "/c", commandLine],
  };
}

function resolveCommand(command, args) {
  if (command === "node") {
    return { command: process.execPath, args };
  }

  if (process.platform !== "win32") {
    return { command, args };
  }

  const localCmd = join(appDir, "node_modules", ".bin", `${command}.cmd`);
  if (existsSync(localCmd)) {
    return runWindowsCmd(localCmd, args);
  }

  return runWindowsCmd(command, args);
}

const [command, ...args] = process.argv.slice(2);

if (!command) {
  console.error("Usage: node scripts/with-memory.mjs <command> [...args]");
  process.exit(1);
}

const env = { ...process.env };
const configuredMemoryMB = getConfiguredMemoryMB();
if (configuredMemoryMB !== null) {
  env.NODE_OPTIONS = withMaxOldSpaceSize(env.NODE_OPTIONS, configuredMemoryMB);
}

const resolved = resolveCommand(command, args);

const child = spawn(resolved.command, resolved.args,
{
  cwd: appDir,
  env,
  stdio: "inherit",
});

child.on("error", (error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    try {
      process.kill(process.pid, signal);
    } catch {
      process.exit(1);
    }
    return;
  }

  process.exit(code ?? 0);
});
