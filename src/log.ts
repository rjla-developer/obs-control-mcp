import type { SecretRegistry } from "./redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string): void;
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

/**
 * The only logger in the project. It writes to stderr (stdout belongs to the
 * MCP protocol) and every line goes through the secret registry first, so a
 * password can never be logged even if some message happens to contain it.
 */
export function createLogger(
  secrets: SecretRegistry,
  level: LogLevel = "info",
  write: (line: string) => void = (line) => process.stderr.write(line),
): Logger {
  const emit = (l: LogLevel, msg: string): void => {
    if (ORDER[l] < ORDER[level]) return;
    write(`${new Date().toISOString()} obs-control-mcp ${l}: ${secrets.scrub(msg)}\n`);
  };
  return {
    debug: (m) => emit("debug", m),
    info: (m) => emit("info", m),
    warn: (m) => emit("warn", m),
    error: (m) => emit("error", m),
  };
}
